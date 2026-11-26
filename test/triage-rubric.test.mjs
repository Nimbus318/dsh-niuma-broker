import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host.mjs'
import {
  RESUME_SNAPSHOT_MAX_CHARS,
  RUBRIC_PROTOCOL_VERSION,
  buildRubricSystemPrompt,
  classifyRubricTierOptionA,
  classifyRubricTierOptionB,
  compareRubricOptionA,
  isCompleteRubricV2Match,
  isValidRubricV2Structure,
  rankRubricOptionA,
  rankRubricOptionB,
  segmentTextForRubric,
  validateRubricItem,
} from '../src/triage-rubric.mjs'
import {
  buildPatrolSearchProfile,
  classifyMatchZone,
  cleanTriageNarrative,
  isValidEvaluatedLlmMatch,
  selectTriageCandidates,
  triageBatchWithLlm,
} from '../src/job-triage.mjs'
import { evaluateDataset } from '../scripts/eval/run-eval.mjs'
import { computeRankStability } from '../scripts/eval/metrics.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'

test('segmentTextForRubric produces deterministic J/R IDs, preserves offsets, and caps resume at 2,200 chars', () => {
  const jd = '职责一：负责大规模 vLLM 推理引擎性能调优。\n职责二：主导 CUDA Kernel 与量化部署；配合集群运维定位线上延迟抖动。'
  const segA = segmentTextForRubric(jd, 'J')
  const segB = segmentTextForRubric(jd, 'J')
  assert.deepEqual(segA.segments, segB.segments)
  assert.ok(segA.segments.length >= 3)
  assert.equal(segA.segments[0].id, 'J1')
  for (const seg of segA.segments) {
    assert.equal(jd.slice(seg.start, seg.end).trim(), seg.text)
  }

  const longResume = `${'A'.repeat(2190)}\n第二段超出两千两百字的部分应当被截断。`
  const rSeg = segmentTextForRubric(longResume.slice(0, RESUME_SNAPSHOT_MAX_CHARS), 'R')
  assert.ok(rSeg.text.length <= RESUME_SNAPSHOT_MAX_CHARS)
  assert.equal(rSeg.segments[0].id, 'R1')
})

test('Option A handles L=null vs L=unknown cleanly and preserves fixed lexicographical ordering', () => {
  assert.equal(classifyRubricTierOptionA({ D: 3, E: 3, L: null }), 'top')
  assert.equal(classifyRubricTierOptionA({ D: 3, E: 2, L: 2 }), 'top')
  assert.equal(classifyRubricTierOptionA({ D: 3, E: 2, L: 'unknown' }), 'stretch')
  assert.equal(classifyRubricTierOptionA({ D: 3, E: 1, L: 3 }), 'stretch')
  assert.equal(classifyRubricTierOptionA({ D: 2, E: 3, L: 3 }), 'good')
  assert.equal(classifyRubricTierOptionA({ D: 0, E: 3, L: 3 }), 'skip')
  assert.equal(classifyRubricTierOptionA({ D: 3, E: 3, L: 0 }), 'skip')

  assert.equal(classifyRubricTierOptionB({ D: 2, E: 3, L: 3 }), 'top')
  assert.equal(classifyRubricTierOptionB({ D: 2, E: 2, L: 'unknown' }), 'stretch')

  // L rank inside same (D=3, E=2): 3 > 2 > null > 1 > unknown > 0 (unknown lands in stretch below top/good)
  const ranked = rankRubricOptionA([
    { id: 'l-null', rubric: { D: 3, E: 2, L: null }, recallRank: 0 },
    { id: 'l-2', rubric: { D: 3, E: 2, L: 2 }, recallRank: 5 },
    { id: 'l-3', rubric: { D: 3, E: 2, L: 3 }, recallRank: 9 },
    { id: 'l-1', rubric: { D: 3, E: 2, L: 1 }, recallRank: 1 },
    { id: 'l-unk', rubric: { D: 3, E: 2, L: 'unknown' }, recallRank: 2 },
  ])
  assert.deepEqual(ranked.map(r => [r.id, r.tier]), [
    ['l-3', 'top'],
    ['l-2', 'top'],
    ['l-null', 'top'],
    ['l-1', 'good'],
    ['l-unk', 'stretch'],
  ])
})

test('validateRubricItem and triageBatchWithLlm handle long-JD tail citations, cross-job ID rejection, and E>=2 missing R downgrade', async () => {
  const tailSentence = '核心工作：主导分布式 KV Cache 显存调度与 TensorRT-LLM 推理引擎性能重构。'
  const fullLongJd = `${'公司概况与福利说明。'.repeat(120)}\n${tailSentence}`
  const jobTail = {
    id: 'job-tail',
    company: 'InferLab',
    title: '推理引擎研发工程师',
    location: '上海',
    jd: fullLongJd,
  }
  const jobOther = {
    id: 'job-other',
    company: 'OtherCo',
    title: '后端开发工程师',
    location: '上海',
    jd: '负责订单系统微服务开发。\n负责 MySQL 分库分表调优。',
  }
  const resumeText = '五年 C++ 与 CUDA 推理引擎开发经验。\n主导过 vLLM 连续批处理吞吐翻倍项目。'
  const profile = buildPatrolSearchProfile({
    goal: '推理引擎研发工程师 上海',
    searchTerms: ['推理引擎', 'CUDA', 'vLLM'],
    resumeText,
  })

  // 1. Wide context budget sends FULL JD -> tail J-ID validates and persists cleanly
  const wideOut = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'wide' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          const tailItem = payload.jobs.find(j => j.id === 'job-tail')
          const lastMatch = [...String(tailItem.jdSegments).matchAll(/\[(J\d+(?:_\d+)?)\]/g)].at(-1)
          const tailId = lastMatch?.[1] || 'J1_1'
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                {
                  id: 'job-tail',
                  D: 3,
                  E: 3,
                  L: null,
                  jdIds: [tailId],
                  resumeIds: ['R1', 'R2'],
                  uncertain: false,
                  reason: '尾部核心职责直接命中推理引擎重构',
                },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:wide', sendToModel: true },
    jobs: [jobTail],
    profile,
    resumeText,
    locale: 'zh',
  })
  assert.equal(wideOut[0].mode, 'llm')
  assert.equal(wideOut[0].protocolVersion, RUBRIC_PROTOCOL_VERSION)
  assert.equal(wideOut[0].tier, 'top')
  assert.ok(wideOut[0].rubric.jdEvidence[0].text.includes('TensorRT-LLM'))
  assert.equal(isCompleteRubricV2Match(wideOut[0], jobTail), true)

  // 2. Tight context budget excerpts long JD -> forged tail J-ID (J99 omitted from excerpt) is rejected
  const tightLlm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 3000 }, defaultMaxTokens: 900 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'tight' },
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: [
              {
                id: 'job-tail',
                D: 3,
                E: 2,
                L: null,
                jdIds: ['J99'],
                resumeIds: ['R1'],
                uncertain: false,
                reason: '试图引用未送模的尾部段号',
              },
            ],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const tightOut = await triageBatchWithLlm({
    llm: tightLlm,
    config: { model: 'mock:tight', sendToModel: true },
    jobs: [jobTail],
    profile,
    resumeText,
    locale: 'zh',
  })
  assert.equal(tightOut[0].mode, 'heuristic')
  assert.equal(tightOut[0].uncertaintyCode, 'invalid_jd_id')

  // 3. Cross-job J citation rejection in 2-job batch + E>=2 missing R downgrade
  const seenBatchPayloads = []
  const multiOut = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'batch' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          seenBatchPayloads.push(payload)
          const tailSegId = String(payload.jobs[0]?.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1'
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                {
                  id: 'job-other',
                  D: 3,
                  E: 2,
                  L: null,
                  // Job B attempts to cite Job A's actual valid ID (even when both have segment #1)!
                  jdIds: [tailSegId],
                  resumeIds: ['R1'],
                  uncertain: false,
                  reason: '跨岗复用另一个岗位的段号测试',
                },
                {
                  id: 'job-tail',
                  D: 3,
                  E: 3,
                  L: null,
                  jdIds: [tailSegId],
                  resumeIds: [], // Missing R citation for E=3!
                  uncertain: false,
                  reason: '缺少 R 段号的高履历宣称应被降为待核实',
                },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:batch', sendToModel: true },
    jobs: [{ ...jobTail, jd: '主导 GPU 分布式推理架构升级。' }, jobOther],
    profile,
    resumeText,
    locale: 'zh',
  })
  const sentTailSeg = String(seenBatchPayloads[0]?.jobs[0]?.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1]
  const sentOtherSeg = String(seenBatchPayloads[0]?.jobs[1]?.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1]
  assert.notEqual(sentTailSeg, sentOtherSeg, 'Two jobs in the same batch must have disjoint J-ID namespaces')
  const rejectedOther = multiOut.find(r => r.opportunityId === 'job-other')
  const downgradedTail = multiOut.find(r => r.opportunityId === 'job-tail')
  assert.equal(rejectedOther.mode, 'heuristic')
  assert.equal(rejectedOther.uncertaintyCode, 'invalid_jd_id')
  assert.equal(downgradedTail.mode, 'llm')
  assert.equal(downgradedTail.rubric.D, 3)
  assert.equal(downgradedTail.rubric.E, 'unknown')
  assert.equal(downgradedTail.rubric.incomplete, true)
  assert.equal(downgradedTail.tier, 'stretch')
  assert.equal(downgradedTail.uncertaintyCode, 'unverified_resume_evidence')
  assert.equal(isCompleteRubricV2Match(downgradedTail), false)
})

test('isValidEvaluatedLlmMatch rejects fake or unverified rubric objects cleanly', () => {
  const job = { id: 'j1', title: 'AI Infra', jd: 'Build GPU distributed serving clusters.' }
  const fakeRubric = {
    opportunityId: 'j1',
    mode: 'llm',
    tier: 'top',
    roleQuote: 'Build GPU distributed serving clusters.',
    rubric: { D: 3, E: 3, L: null }, // Missing protocolVersion & jdEvidence
  }
  assert.equal(isValidEvaluatedLlmMatch(fakeRubric, job), false)
  assert.equal(classifyMatchZone(fakeRubric, job), 'pending_local')

  const tamperedEvidence = {
    opportunityId: 'j1',
    mode: 'llm',
    protocolVersion: RUBRIC_PROTOCOL_VERSION,
    tier: 'top',
    rubric: {
      version: RUBRIC_PROTOCOL_VERSION,
      D: 3,
      E: 2,
      L: null,
      incomplete: false,
      jdEvidence: [{ id: 'J1', text: 'Completely fabricated sentence absent from JD' }],
      resumeEvidence: [{ id: 'R1', text: 'Built serving clusters' }],
    },
  }
  assert.equal(isValidEvaluatedLlmMatch(tamperedEvidence, job), false)
  assert.equal(isValidRubricV2Structure(tamperedEvidence, job), false)
})

test('25-job scope: filtered empty/over-25 caps, pending-first before legacy_v1 upgrade, failed upgrade preserves legacy_v1, and native token receipt on invalid JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-pr4-host-'))
  let dispose
  t.after(async () => {
    try {
      if (typeof dispose === 'function') await dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  let failInvalidJson = false
  let llmCalls = 0
  const seenBatchIds = []
  const harness = createFetchHarness()
  const action = async payload => {
    const r = await harness.call('POST', '/api/career-agent/action', payload)
    assert.equal(r.status, 200)
    return r.json.result
  }

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => {
        llmCalls += 1
        return {
          model: { provider: 'mock', id: 'rubric' },
          async *stream(req) {
            const payload = JSON.parse(req.messages[0].content[0].text)
            seenBatchIds.push(...payload.jobs.map(j => j.id))
            yield {
              type: 'usage',
              usage: {
                inputTokens: 420,
                cacheReadTokens: 180,
                cacheWriteTokens: 40,
                outputTokens: 110,
                reasoningTokens: 25,
                totalTokens: 750,
              },
            }
            if (failInvalidJson) {
              yield { type: 'text-delta', text: 'not valid json response' }
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                items: payload.jobs.map(j => ({
                  id: j.id,
                  D: 3,
                  E: 2,
                  L: null,
                  jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                  resumeIds: ['R1'],
                  uncertain: false,
                  reason: '主职责与简历经验契合',
                })),
              }),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })

  const imp = await action({
    action: 'resume-import',
    title: 'Master',
    text: '# Candidate\n\n## Core\n- Built high-throughput GPU inference engines.',
  })
  await action({ action: 'resume-review', id: imp.id, decision: 'approve' })
  await action({
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: false,
      model: 'mock:rubric',
      goal: 'AI Infra 推理引擎',
      searchTerms: ['AI Infra', 'GPU'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme', label: 'Acme' }],
    },
  })
  const sInit = await harness.call('GET', '/api/career-agent/state')
  const fp = sInit.json.triageSummary.fingerprint
  await dispose()

  // Seed 28 pending jobs + 3 legacy_v1 jobs directly before restarting host
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))

  for (let i = 0; i < 28; i += 1) {
    ctrl.opportunities.push({
      id: `greenhouse:acme:pending-${i}`,
      externalId: `pending-${i}`,
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'Acme',
      title: 'AI Infra 推理工程师',
      location: '上海',
      jd: `负责 GPU 分布式推理系统核心开发 ${i}。`,
      verifiedAt: `2026-11-25T01:${String(i).padStart(2, '0')}:00.000Z`,
    })
  }
  for (let i = 0; i < 3; i += 1) {
    const id = `greenhouse:acme:legacy-${i}`
    const jd = `负责旧版 AI Infra 调度与容器编排建设 ${i}。`
    ctrl.opportunities.push({
      id,
      externalId: `legacy-${i}`,
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'Acme',
      title: 'AI Infra 工程师',
      location: '上海',
      jd,
      verifiedAt: `2026-11-24T01:${String(i).padStart(2, '0')}:00.000Z`,
    })
    ctrl.jobMatches ??= {}
    ctrl.jobMatches[id] = {
      opportunityId: id,
      score: 88,
      tier: 'top',
      primaryRoleFit: 'match',
      roleQuote: `负责旧版 AI Infra 调度与容器编排建设 ${i}`,
      reason: '旧版直出评分',
      mode: 'llm',
      fingerprint: fp,
      updatedAt: '2026-11-24T01:00:00.000Z',
    }
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const h2 = createFetchHarness()
  await apply({
    profileContext: { dir },
    connection: h2.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => {
        llmCalls += 1
        return {
          model: { provider: 'mock', id: 'rubric' },
          async *stream(req) {
            const payload = JSON.parse(req.messages[0].content[0].text)
            seenBatchIds.push(...payload.jobs.map(j => j.id))
            yield {
              type: 'usage',
              usage: {
                inputTokens: 420,
                cacheReadTokens: 180,
                cacheWriteTokens: 40,
                outputTokens: 110,
                reasoningTokens: 25,
                totalTokens: 750,
              },
            }
            if (failInvalidJson) {
              yield { type: 'text-delta', text: 'not valid json response' }
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                items: payload.jobs.map(j => ({
                  id: j.id,
                  D: 3,
                  E: 2,
                  L: null,
                  jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                  resumeIds: ['R1'],
                  uncertain: false,
                  reason: '主职责与简历经验契合',
                })),
              }),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  const act2 = async payload => {
    const r = await h2.call('POST', '/api/career-agent/action', payload)
    assert.equal(r.status, 200)
    return r.json.result
  }

  // (a) Boot summary separates legacyCount=3 while rubricV2/topCount=0 (no legacy inflation)
  const st0 = (await h2.call('GET', '/api/career-agent/state')).json
  assert.equal(st0.triageSummary.legacyCount, 3)
  assert.equal(st0.triageSummary.rubricV2Count, 0)
  assert.equal(st0.triageSummary.topCount, 0)
  assert.equal(llmCalls, 0)

  // (b) Explicit empty filtered scope returns 0 with 0 calls
  const emptyFiltered = await act2({ action: 'triage-preview', filterScope: 'filtered', targetJobIds: [] })
  assert.equal(emptyFiltered.count, 0)
  assert.equal(emptyFiltered.emptyTarget, true)
  assert.equal(llmCalls, 0)

  // (c) Over-25 filtered target list is capped at 25 and prioritizes pending BEFORE legacy
  const all31Ids = [
    ...Array.from({ length: 3 }, (_, i) => `greenhouse:acme:legacy-${i}`),
    ...Array.from({ length: 28 }, (_, i) => `greenhouse:acme:pending-${i}`),
  ]
  const preview25 = await act2({
    action: 'triage-preview',
    filterScope: 'filtered',
    limit: 25,
    upgradeLegacy: true,
    targetJobIds: all31Ids,
  })
  assert.equal(preview25.count, 25)
  assert.ok(preview25.targetJobIds.every(id => id.includes(':pending-')), 'Pending jobs must fill the 25 budget before legacy_v1 upgrades')

  // Run batch #1 -> 25 rubric-v2 persisted, receipt records DSH native uncached/cacheRead/output tokens
  const run1 = await act2({ action: 'triage-jobs', confirmed: true, confirmToken: preview25.confirmToken })
  assert.equal(run1.llmScoredCount, 25)
  assert.ok(run1.receipt)
  assert.equal(run1.receipt.counts.written, 25)
  assert.equal(run1.receipt.usage.reported, true)
  assert.ok(run1.receipt.usage.inputTokens > 0)
  assert.ok(run1.receipt.usage.cacheReadTokens > 0)

  // (d) Failed invalid-JSON upgrade on remaining 3 pending + 3 legacy_v1 preserves legacy_v1 cards & still reports token usage
  failInvalidJson = true
  const previewRem = await act2({ action: 'triage-preview', limit: 25, upgradeLegacy: true })
  assert.equal(previewRem.count, 6) // remaining 3 pending + 3 legacy
  const failedRun = await act2({ action: 'triage-jobs', confirmed: true, confirmToken: previewRem.confirmToken })
  assert.equal(failedRun.llmScoredCount, 0)
  assert.equal(failedRun.receipt.counts.written, 0)
  assert.equal(failedRun.receipt.counts.failed, 6)
  assert.equal(failedRun.receipt.usage.reported, true)
  assert.equal(failedRun.receipt.usage.inputTokens, 840)
  assert.equal(failedRun.receipt.usage.cacheReadTokens, 360)
  assert.equal(failedRun.receipt.usage.cacheWriteTokens, 80)
  assert.equal(failedRun.receipt.usage.outputTokens, 220)

  const stAfterFail = (await h2.call('GET', '/api/career-agent/state')).json
  assert.equal(stAfterFail.triageSummary.legacyCount, 3, 'Failed upgrade must preserve existing valid legacy_v1 cards')
  assert.equal(stAfterFail.triageSummary.rubricV2Count, 25)
})

test('Option A vs B rubric comparison & shuffled stability pass benchmark gate', () => {
  const items = [
    { id: 'r-exact-1', rubric: { D: 3, E: 3, L: 3 }, recallRank: 0 },
    { id: 'r-exact-2', rubric: { D: 3, E: 2, L: null }, recallRank: 1 },
    { id: 'r-adj-rich', rubric: { D: 2, E: 3, L: 3 }, recallRank: 2 },
    { id: 'r-low-e', rubric: { D: 3, E: 1, L: 3 }, recallRank: 3 },
    { id: 'r-skip', rubric: { D: 0, E: 2, L: 2 }, recallRank: 4 },
  ]
  const optA = rankRubricOptionA(items)
  const optB = rankRubricOptionB(items)
  assert.deepEqual(optA.map(x => [x.id, x.tier]), [
    ['r-exact-1', 'top'],
    ['r-exact-2', 'top'],
    ['r-adj-rich', 'good'],
    ['r-low-e', 'stretch'],
    ['r-skip', 'skip'],
  ])
  assert.equal(optB.find(x => x.id === 'r-adj-rich').tier, 'top')

  const shuffled1 = rankRubricOptionA([items[4], items[2], items[0], items[3], items[1]])
  const shuffled2 = rankRubricOptionA([items[1], items[3], items[4], items[0], items[2]])
  const stab = computeRankStability(
    [optA.map(x => x.id), shuffled1.map(x => x.id), shuffled2.map(x => x.id)],
    [
      Object.fromEntries(optA.map(x => [x.id, x.tier])),
      Object.fromEntries(shuffled1.map(x => [x.id, x.tier])),
      Object.fromEntries(shuffled2.map(x => [x.id, x.tier])),
    ],
  )
  assert.ok(stab.tauBMin >= 0.65)
  assert.equal(stab.maxBoundaryFlipRate, 0)
})

test('PR4 adversarial regressions: auth downgrade guard, scoped filter empty guard, excerpt omission clean readback, resume <=2200 isolation, legacy_v1 preservation on missing E, and partial/aborted usage receipts', async t => {
  const { estimateTriageBatchTokens } = await import('../src/job-triage.mjs')

  // 1. Validate whole jdIds array BEFORE capping display length at 4
  const segs = segmentTextForRubric('职责一。\n职责二。\n职责三。\n职责四。\n职责五。', 'J1_')
  const tailInvalidCheck = validateRubricItem(
    { D: 3, E: 1, L: null, jdIds: ['J1_1', 'J1_2', 'J1_3', 'J1_4', 'J1_999'], resumeIds: [] },
    { jobSegments: segs, resumeSegments: segmentTextForRubric('', 'R'), hasResume: false },
  )
  assert.equal(tailInvalidCheck.valid, false)
  assert.equal(tailInvalidCheck.errorCode, 'invalid_jd_id', 'Invalid 5th ID must still reject whole item')

  // 2. Both direct E=unknown and downgraded E>=2 without R produce identical incomplete completeness state
  const rSegs = segmentTextForRubric('Built GPU clusters.', 'R')
  const directUnknown = validateRubricItem(
    { D: 3, E: 'unknown', L: null, jdIds: ['J1_1'], resumeIds: [] },
    { jobSegments: segs, resumeSegments: rSegs, hasResume: true },
  )
  const downgradedMissingR = validateRubricItem(
    { D: 3, E: 2, L: null, jdIds: ['J1_1'], resumeIds: [] },
    { jobSegments: segs, resumeSegments: rSegs, hasResume: true },
  )
  assert.equal(directUnknown.incomplete, true)
  assert.equal(downgradedMissingR.incomplete, true)
  assert.equal(directUnknown.tier, downgradedMissingR.tier)
  assert.equal(
    isCompleteRubricV2Match({
      mode: 'llm', protocolVersion: RUBRIC_PROTOCOL_VERSION,
      rubric: { D: 3, E: directUnknown.E, L: null, incomplete: directUnknown.incomplete, jdEvidence: directUnknown.jdEvidence, resumeEvidence: [] },
    }),
    false,
  )

  // 3. Excerpted long JD with omitted middle never places ellipsis inside seg.text (passes write + readback) & never leaks >2200-char resume terms
  const omittedMid = Array.from({ length: 120 }, (_, i) => `第${i + 1}段日常例行工作与会议协调事务。`).join('\n\n')
  const excerptedJob = {
    id: 'ex-1',
    title: 'AI Infra 引擎工程师',
    company: 'TestCo',
    location: '上海',
    jd: `核心职责：负责千卡 GPU vLLM 推理引擎性能调优。\n\n${omittedMid}\n\n补充条款：本岗位入职与直签主体签署合同。`,
  }
  const secretOver2200 = 'UNIQUE_OVER_2200_TOKEN_ZEBRA99'
  const longResume = `${'Senior distributed GPU inference platform engineering.\n'.repeat(45)}\n${secretOver2200}`
  assert.ok(longResume.indexOf(secretOver2200) > 2200)
  const profileLong = buildPatrolSearchProfile({ goal: 'AI Infra 上海', searchTerms: ['AI Infra'], resumeText: longResume.slice(0, 4000) })

  const zeroEst = estimateTriageBatchTokens({
    jobs: [excerptedJob],
    profile: profileLong,
    resumeText: longResume,
    budget: { contextWindow: 2048, maxOutputTokens: 1024 },
  })
  assert.equal(zeroEst.estimatedInputTokens, 0, 'When 0 batches fit in 2048 window, input estimate must be 0')
  assert.equal(zeroEst.minTokens, 0)
  assert.equal(zeroEst.maxTokens, 0)
  assert.equal(zeroEst.sendableCount, 0)

  const seenBodies = []
  const excerptOut = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 4096 }, defaultMaxTokens: 1024 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'win4k' },
        async *stream(req) {
          const body = JSON.parse(req.messages[0].content[0].text)
          seenBodies.push(body)
          const allSegs = [...String(body.jobs[0].jdSegments || '').matchAll(/^\[(J\d+(?:_\d+)?)\]/gm)].map(m => m[1])
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [{ id: 'ex-1', D: 3, E: 2, L: null, jdIds: [allSegs[0], allSegs.at(-1)].filter(Boolean), resumeIds: ['R1'], reason: '对齐核心推理引擎职责' }],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:win4k', sendToModel: true },
    jobs: [excerptedJob],
    profile: profileLong,
    resumeText: longResume,
  })
  assert.equal(JSON.stringify(seenBodies[0]).includes(secretOver2200), false, 'Resume text past 2200 chars must never leak into model payload')
  assert.equal(excerptOut[0].mode, 'llm')
  assert.equal(excerptOut[0].rubric.jdTruncated, true)
  assert.equal(excerptOut[0].rubric.jdEvidence.some(ev => ev.text.includes('…')), false)
  assert.equal(isValidRubricV2Structure(excerptOut[0], excerptedJob), true, 'Excerpted citation must also validate cleanly against full JD on readback')

  // 3b. Single-paragraph Chinese long JD delimited solely by 。 preserves original punctuation on excerpting (4K/8K)
  const singleParaSentences = Array.from({ length: 120 }, (_, i) => `职责句段${i + 1}：负责千卡 GPU 算力调度与服务编排。`).join('')
  const singleParaJob = {
    id: 'single-para-1',
    title: 'AI Infra 系统工程师',
    company: 'TestCo',
    location: '上海',
    jd: singleParaSentences,
  }
  const singleParaOut = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 4096 }, defaultMaxTokens: 1024 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'win4k' },
        async *stream(req) {
          const body = JSON.parse(req.messages[0].content[0].text)
          const firstSeg = String(body.jobs[0].jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1]
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [{ id: 'single-para-1', D: 3, E: 2, L: null, jdIds: [firstSeg], resumeIds: ['R1'], reason: '单段长JD对齐' }],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:win4k', sendToModel: true },
    jobs: [singleParaJob],
    profile: buildPatrolSearchProfile({ goal: 'AI Infra', searchTerms: ['GPU'], resumeText: 'Senior distributed GPU system engineering.' }),
    resumeText: 'Senior distributed GPU system engineering.',
  })
  assert.equal(singleParaOut[0].mode, 'llm')
  assert.equal(singleParaOut[0].rubric.jdTruncated, true)
  assert.equal(isValidRubricV2Structure(singleParaOut[0], singleParaJob), true, 'Single-paragraph excerpted citation must keep verbatim punctuation for readback')

  // 4. Partial/aborted SDK usage retention & strict totalTokens (never invent total=17 when total & cache fields are missing)
  const abortCtrl = new AbortController()
  const partialMetrics = {}
  await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } } // No totalTokens / cache fields
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [{ id: 'b1', D: 2, E: 2, L: null, jdIds: ['J1_1'], resumeIds: ['R1'], reason: 'ok' }],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs: [
      { id: 'b1', company: 'C1', title: 'Eng1', location: '上海', jd: '负责服务端开发。' },
      { id: 'b2', company: 'C2', title: 'Eng2', location: '上海', jd: '负责存储系统开发。' },
    ],
    profile: buildPatrolSearchProfile({ goal: 'Eng', searchTerms: ['服务'], resumeText: '系统开发' }),
    resumeText: '系统开发',
    maxBatchSize: 1,
    metricsOut: partialMetrics,
    signal: abortCtrl.signal,
  })
  assert.equal(partialMetrics.usageReported, true)
  assert.equal(partialMetrics.usageComplete, false)
  assert.equal(partialMetrics.reportedUncachedInputTokens, 24)
  assert.equal(partialMetrics.reportedOutputTokens, 10)
  assert.equal(partialMetrics.reportedTotalTokens, null, 'Never fabricate totalTokens when totalTokens and cache fields are unreported')

  const abortedMetrics = {}
  const ac2 = new AbortController()
  await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 14, totalTokens: 54 } }
          ac2.abort()
          yield { type: 'text-delta', text: '{' }
        },
      }),
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs: [{ id: 'ab1', company: 'C', title: 'Eng', location: '上海', jd: '负责系统研发。' }],
    profile: buildPatrolSearchProfile({ goal: 'Eng', searchTerms: ['系统'], resumeText: '系统研发' }),
    resumeText: '系统研发',
    metricsOut: abortedMetrics,
    signal: ac2.signal,
  })
  assert.equal(abortedMetrics.usageReported, true, 'Aborted physical call after emitting usage chunk must retain reported tokens')
  assert.equal(abortedMetrics.reportedUncachedInputTokens, 40)
  assert.equal(abortedMetrics.reportedOutputTokens, 14)

  // 5. Host guards: revoked sendToModel (autoConfirmed rejected), missing targetJobIds under filterScope=filtered,
  //    preserved legacy_v1 on E=2 missing R / direct E=unknown, and UI checks preview.sendToModel + showDismissed
  const indexSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  assert.match(indexSrc, /const isNarrowed = showDismissed \|\| stageFilter !== 'all'/)
  assert.match(indexSrc, /!isFilteredMissingJd\(j\)[\s\S]{0,220}slice\(0, 500\)/)
  assert.match(indexSrc, /act\.background\('triage-preview'[\s\S]{0,900}confirmed:\s*true,\s*confirmToken:/)
  assert.match(indexSrc, /wasAutoSend \|\| previewSendToModel \? \{ autoConfirmed: true \} : \{\}/)

  const dir = await mkdtemp(join(tmpdir(), 'career-pr4-adv-host-'))
  let disposeHost
  t.after(async () => {
    try { await disposeHost?.() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  let mockMode = 'missing_r' // 'missing_r' -> E=2 without R
  let hostLlmCalls = 0
  const harness = createFetchHarness()
  const hostAction = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          hostLlmCalls += 1
          const body = JSON.parse(req.messages[0].content[0].text)
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: body.jobs.map(j => ({
                id: j.id,
                D: 3,
                E: mockMode === 'direct_unknown' ? 'unknown' : 2,
                L: null,
                jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                resumeIds: [], // Missing R citation!
                reason: '缺 R 测试',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { disposeHost = fn() },
  })
  const imp = await hostAction({ action: 'resume-import', title: 'Master', text: '# Candidate\n\n- Built GPU clusters.' })
  await hostAction({ action: 'resume-review', id: imp.id, decision: 'approve' })
  await hostAction({
    action: 'configure',
    config: { mode: 'search', sendToModel: true, model: 'mock:fast', goal: 'GPU Infra', searchTerms: ['GPU'], boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme', label: 'Acme' }] },
  })
  const stInit = (await harness.call('GET', '/api/career-agent/state')).json
  await disposeHost()

  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  const legId = 'greenhouse:acme:leg-1'
  ctrl.opportunities.push({
    id: legId, provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'Acme',
    title: 'GPU 工程师', location: '上海', jd: '负责千卡 GPU 分布式集群研发。', verifiedAt: '2026-11-25T01:00:00.000Z',
  })
  ctrl.jobMatches = {
    [legId]: {
      opportunityId: legId, score: 88, tier: 'top', roleQuote: '负责千卡 GPU 分布式集群研发',
      reason: '旧卡有效', mode: 'llm', fingerprint: stInit.triageSummary.fingerprint,
    },
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          hostLlmCalls += 1
          const body = JSON.parse(req.messages[0].content[0].text)
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: body.jobs.map(j => ({
                id: j.id,
                D: 3,
                E: mockMode === 'direct_unknown' ? 'unknown' : 2,
                L: null,
                jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                resumeIds: [],
                reason: '缺 R 测试',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { disposeHost = fn() },
  })

  // Missing targetJobIds on filterScope=filtered must return emptyTarget with 0 calls
  const filteredNoIdsPrev = await hostAction({ action: 'triage-preview', filterScope: 'filtered', upgradeLegacy: true })
  assert.equal(filteredNoIdsPrev.count, 0)
  assert.equal(filteredNoIdsPrev.emptyTarget, true)
  const filteredNoIdsRun = await hostAction({ action: 'triage-jobs', filterScope: 'filtered', upgradeLegacy: true })
  assert.equal(filteredNoIdsRun.emptyTarget, true)
  assert.equal(hostLlmCalls, 0)

  // Stale autoConfirmed rejected when another tab turns OFF sendToModel between preview and dispatch
  const prevOn = await hostAction({ action: 'triage-preview', filterScope: 'filtered', upgradeLegacy: true, targetJobIds: [legId] })
  assert.equal(prevOn.sendToModel, true)
  await hostAction({ action: 'configure', config: { sendToModel: false } })
  const staleAutoRes = await hostAction({ action: 'triage-jobs', confirmed: true, autoConfirmed: true, confirmToken: prevOn.confirmToken })
  assert.equal(staleAutoRes.requiresConfirmation, true)
  assert.equal(staleAutoRes.staleConfirmation, true)
  assert.equal(hostLlmCalls, 0, 'Revoked sendToModel must stop autoConfirmed dispatch with 0 LLM calls')

  // Upgrading valid legacy_v1 when model returns E=2 without R OR direct E='unknown' must preserve legacy_v1 and report written=0
  for (const mode of ['missing_r', 'direct_unknown']) {
    mockMode = mode
    const prevUp = await hostAction({ action: 'triage-preview', filterScope: 'filtered', upgradeLegacy: true, targetJobIds: [legId] })
    assert.equal(prevUp.sendToModel, false)
    const runUp = await hostAction({ action: 'triage-jobs', confirmed: true, confirmToken: prevUp.confirmToken })
    assert.equal(runUp.llmScoredCount, 0)
    assert.equal(runUp.receipt.counts.written, 0)
    assert.equal(runUp.receipt.counts.failed, 1)
    const stCheck = (await harness.call('GET', '/api/career-agent/state')).json
    assert.equal(stCheck.triageSummary.legacyCount, 1, `${mode} must preserve existing valid legacy_v1 card`)
    assert.equal(stCheck.triageSummary.evaluatedCount, 1)
    assert.equal(stCheck.triageSummary.rubricV2Count, 0)
  }
})

test('cleanTriageNarrative & prompt strip inline [J*]/[R*] IDs and truncate cleanly at sentence boundaries', () => {
  const prompt = buildRubricSystemPrompt('zh')
  assert.match(prompt, /禁止出现\[J\*\]或\[R\*\]编号/)

  const cleaned = cleanTriageNarrative('[J13_1][J13_12][J13_32]的 Agent 沙箱、管控面与隔离优化直接对口，[R12][R16][R17]有大规模集群及沙箱落地经验。', 160)
  assert.equal(cleaned, 'Agent 沙箱、管控面与隔离优化直接对口，有大规模集群及沙箱落地经验。')
  assert.doesNotMatch(cleaned, /\[(?:J|R)\d+(?:_\d+)?\]/)

  const longText = '实际主责为异构算力容器平台研发，候选项的 GPU 调度与 Kubernetes 经历高度契合。同时还需要重点确认分布式训练框架源码级调优以及大规模集群稳定性设计。'
  const sentenceBounded = cleanTriageNarrative(longText, 60)
  assert.equal(sentenceBounded, '实际主责为异构算力容器平台研发，候选项的 GPU 调度与 Kubernetes 经历高度契合。')

  const clauseBounded = cleanTriageNarrative('主责覆盖 GPU 调度、Kubernetes 编排、训推混部优化，同时负责多云统一资源抽象与大规模训练任务编排设计讨论。', 44)
  assert.ok(clauseBounded.endsWith('…'))
  assert.ok(clauseBounded.length <= 44)
})

test('receiptEstimateLabel exists in both zh and en locales and caution prompt forbids generic advice', async () => {
  const prompt = buildRubricSystemPrompt('zh')
  assert.match(prompt, /严禁写泛泛面试建议/)
  const zh = JSON.parse(await readFile(new URL('../locale/messages/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(await readFile(new URL('../locale/messages/en.json', import.meta.url), 'utf8'))
  assert.equal(zh.jobs.receiptEstimateLabel, '预计输入')
  assert.equal(en.jobs.receiptEstimateLabel, 'Estimated input')
})

test('toggling sendToModel OFF during in-flight triage-preview voids token and client auto-consume passes autoConfirmed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-preview-race-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let disposeHost
  let llmCalls = 0
  let gatedOnce = false
  let resolveBudgetGate
  let signalBudgetStarted
  const budgetStarted = new Promise(resolve => { signalBudgetStarted = resolve })

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      async resolveModelInfo() {
        if (!gatedOnce) {
          gatedOnce = true
          signalBudgetStarted?.()
          await new Promise(resolve => { resolveBudgetGate = resolve })
        }
        return { context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }
      },
      async prepareCall() {
        llmCalls += 1
        throw new Error('Must not call prepareCall when sendToModel was disabled mid-preview')
      },
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { disposeHost = fn() },
  })
  t.after(async () => { if (typeof disposeHost === 'function') await disposeHost() })

  const hostAction = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }

  const imp = await hostAction({ action: 'resume-import', title: 'Master', text: '# Candidate\n\n- Built GPU clusters.' })
  await hostAction({ action: 'resume-review', id: imp.id, decision: 'approve' })
  await hostAction({
    action: 'configure',
    config: { mode: 'search', sendToModel: true, model: 'mock:fast', goal: 'GPU Infra', searchTerms: ['GPU'], boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme', label: 'Acme' }] },
  })
  const added = await hostAction({
    action: 'job-add',
    job: { company: 'Acme', title: 'GPU Infra 工程师', jd: '负责千卡 GPU 分布式算力调度与容器平台研发。' },
  })

  const previewPromise = hostAction({
    action: 'triage-preview',
    filterScope: 'filtered',
    upgradeLegacy: true,
    targetJobIds: [added.id],
  })
  await budgetStarted
  await hostAction({ action: 'configure', config: { sendToModel: false } })
  resolveBudgetGate()

  const previewRes = await previewPromise
  assert.equal(previewRes.confirmToken, '')
  assert.equal(previewRes.staleConfirmation, true)
  assert.equal(previewRes.requiresConfirmation, true)
  assert.equal(previewRes.sendToModel, false)
  assert.equal(llmCalls, 0)

  const indexSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  assert.match(indexSrc, /\.\.\.\(wasAutoSend \|\| previewSendToModel \? \{ autoConfirmed: true \} : \{\}\)/)

  // Concurrent configure({ sendToModel: false }) (not awaited first) must block both new preview and autoConfirmed dispatch
  await hostAction({ action: 'configure', config: { sendToModel: true } })
  const firstPrev = await hostAction({
    action: 'triage-preview',
    filterScope: 'filtered',
    upgradeLegacy: true,
    targetJobIds: [added.id],
  })
  assert.ok(firstPrev.confirmToken)
  const pendingOff = hostAction({ action: 'configure', config: { sendToModel: false } })
  const racedDispatch = hostAction({
    action: 'triage-jobs',
    confirmed: true,
    confirmToken: firstPrev.confirmToken,
    autoConfirmed: true,
  })
  const [, racedRes] = await Promise.all([pendingOff, racedDispatch])
  assert.equal(racedRes.requiresConfirmation, true)
  assert.equal(racedRes.staleConfirmation, true)
  assert.equal(llmCalls, 0)
})


test('DEFAULT_TRIAGE_BATCH_LIMIT (20 = 4x5) and 5-cell progress indicator stay unified across host, client, and locales', async () => {
  const { DEFAULT_TRIAGE_BATCH_LIMIT, TRIAGE_PROGRESS_CELLS } = await import('../src/job-view-scope.mjs')
  assert.equal(DEFAULT_TRIAGE_BATCH_LIMIT, 20)
  assert.equal(TRIAGE_PROGRESS_CELLS, 5)

  const [hostSrc, hostTriageSrc, clientSrc, zhMsg, enMsg] = await Promise.all([
    readFile(new URL('../src/host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/host-triage.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../client/index.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../locale/messages/zh.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../locale/messages/en.json', import.meta.url), 'utf8').then(JSON.parse),
  ])

  assert.match(hostSrc, /runJobTriage\(\{\s*force:\s*false,\s*limit:\s*DEFAULT_TRIAGE_BATCH_LIMIT/)
  assert.match(hostTriageSrc, /previewJobTriage\(\{\s*id,\s*limit\s*=\s*DEFAULT_TRIAGE_BATCH_LIMIT/)
  assert.match(hostTriageSrc, /runJobTriage\(\{\s*force\s*=\s*false,\s*limit\s*=\s*DEFAULT_TRIAGE_BATCH_LIMIT/)
  assert.match(clientSrc, /limit:\s*DEFAULT_TRIAGE_BATCH_LIMIT,\s*upgradeLegacy:\s*true/)
  assert.match(clientSrc, /ca-triage-cells[\s\S]{0,260}TRIAGE_PROGRESS_CELLS/)
  assert.match(zhMsg.jobs.retriageTooltip, /\{limit\}/)
  assert.match(zhMsg.jobs.retriageTooltipScored, /\{limit\}/)
  assert.match(enMsg.jobs.retriageTooltip, /\{limit\}/)
  assert.match(enMsg.jobs.retriageTooltipScored, /\{limit\}/)
  assert.match(zhMsg.jobs.retriageCandidates, /\{limit\}/)
  assert.match(enMsg.jobs.retriageCandidates, /\{limit\}/)
})


test('P1 regression: filtered/omitted batch triage respects 20-job cap end-to-end across preview and execute', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-pr4-cap20-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const harness = createFetchHarness()
  const sentBatches = []
  let dispose
  t.after(async () => { try { await dispose?.() } finally {} })
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          const body = JSON.parse(req.messages[0].content[0].text)
          sentBatches.push(body.jobs.map(j => j.id))
          yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: body.jobs.map(j => ({
                id: j.id,
                D: 3,
                E: 0,
                L: null,
                jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                resumeIds: [],
                uncertain: false,
                reason: '岗位职责与方向契合。',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  const act = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  await act({ action: 'configure', config: { mode: 'search', sendToModel: true, model: 'mock:fast', goal: 'AI Infra', searchTerms: ['GPU调度'] } })

  const addedIds = []
  for (let i = 0; i < 36; i += 1) {
    const added = await act({
      action: 'job-add',
      job: {
        company: `Co${i}`, title: `GPU调度工程师 ${i}`, location: '上海',
        url: `https://example.com/jobs/cap20-${i}`,
        jd: `岗位职责 ${i}：负责 GPU调度与 Kubernetes 资源编排基础设施建设。`,
      },
    })
    addedIds.push(added.id)
  }

  // (a) Filtered preview with limit: 20 and 36 eligible targetJobIds MUST cap at 20, and confirm runs all 20
  const filteredPrev = await act({
    action: 'triage-preview',
    filterScope: 'filtered',
    limit: 20,
    upgradeLegacy: true,
    targetJobIds: addedIds,
  })
  assert.equal(filteredPrev.count, 20)
  assert.equal(filteredPrev.targetJobIds.length, 20)
  const filteredRun = await act({ action: 'triage-jobs', confirmed: true, confirmToken: filteredPrev.confirmToken, autoConfirmed: true })
  assert.equal(filteredRun.llmScoredCount, 20)
  assert.equal(sentBatches.flat().length, 20)

  // (b) Unfiltered API call omitting limit must also cap remaining 16 (and if >20 remain, cap at 20 not 30)
  const extraIds = []
  for (let i = 36; i < 65; i += 1) {
    const added = await act({
      action: 'job-add',
      job: {
        company: `Co${i}`, title: `GPU调度工程师 ${i}`, location: '北京',
        url: `https://example.com/jobs/cap20-${i}`,
        jd: `岗位职责 ${i}：负责 GPU调度与容器引擎内核研发。`,
      },
    })
    extraIds.push(added.id)
  }
  sentBatches.length = 0
  const omittedPrev = await act({ action: 'triage-preview', upgradeLegacy: true })
  assert.equal(omittedPrev.count, 20)
  const omittedRun = await act({ action: 'triage-jobs', confirmed: true, confirmToken: omittedPrev.confirmToken, autoConfirmed: true })
  assert.equal(omittedRun.llmScoredCount, 20)
  assert.equal(sentBatches.flat().length, 20)
})
