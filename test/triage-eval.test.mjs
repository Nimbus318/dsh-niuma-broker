import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  compareRunsPaired,
  computeKendallTauB,
  computeNdcgAtK,
  computePrecisionAtK,
  computeRankStability,
  computeRecallAtK,
  computeTierStats,
  rankRubricOptionA,
  rankRubricOptionB,
} from '../scripts/eval/metrics.mjs'
import {
  checkReportComparability,
  compareReports,
  evaluateDataset,
  formatEvalMarkdown,
} from '../scripts/eval/run-eval.mjs'
import {
  samplePrivateDataset,
  selectDefaultApprovedMaster,
} from '../scripts/eval/sample-private-dataset.mjs'
import { CareerStore } from '../src/career.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve('.')
const BENCHMARK_PATH = join(ROOT, 'test', 'fixtures', 'triage-benchmark', 'synthetic-benchmark.json')

function makeJob(id, {
  sourceId = 'greenhouse:scale-board',
  provider = 'greenhouse',
  externalId = null,
  company = 'ScaleBoard',
  title = 'AI Infra Engineer',
  location = '上海',
  jd = '负责大规模分布式推理引擎与 GPU 调度系统开发，优化 vLLM 与 CUDA 服务性能。',
  jdPreview = false,
  verifiedAt = '2026-11-24T00:00:00.000Z',
} = {}) {
  return {
    id,
    sourceId,
    provider,
    externalId: externalId || id.split(':').pop(),
    company,
    title,
    location,
    jd,
    ...(jdPreview ? { jdPreview: true } : {}),
    verifiedAt,
  }
}

test('eval metrics compute exact Recall@K, NDCG@K (0/1/3/7), Precision@K, null unjudged, and Kendall tau-b', () => {
  const labels = { a: 3, b: 2, c: 1, d: 0, e: 3, f: null }
  const ranked = ['a', 'c', 'b', 'd', 'e']

  const rec3 = computeRecallAtK(ranked, labels, 3)
  assert.equal(rec3.hits, 2)
  assert.equal(rec3.totalRelevant, 3)
  assert.equal(Number(rec3.recall.toFixed(4)), Number((2 / 3).toFixed(4)))

  // Unjudged labels map (e.g. all null) must yield null, never 0
  const unjudgedPrecision = computePrecisionAtK(ranked, { a: null, b: null }, 4)
  assert.equal(unjudgedPrecision.precision, null)
  assert.equal(unjudgedPrecision.precisionAmongJudged, null)

  const ndcg3 = computeNdcgAtK(ranked, labels, 3)
  const expectedDcg = 7 / Math.log2(2) + 1 / Math.log2(3) + 3 / Math.log2(4)
  const expectedIdcg = 7 / Math.log2(2) + 7 / Math.log2(3) + 3 / Math.log2(4)
  assert.ok(Math.abs(ndcg3.ndcg - expectedDcg / expectedIdcg) < 1e-9)

  const p4 = computePrecisionAtK(ranked, labels, 4)
  assert.equal(p4.hits, 2)
  assert.equal(p4.precision, 0.5)

  const base12 = Array.from({ length: 12 }, (_, i) => `j${i}`)
  const shifted12 = [...base12.slice(1), base12[0]]
  const tauShift = computeKendallTauB(base12, shifted12)
  assert.equal(tauShift.concordant, 55)
  assert.equal(tauShift.discordant, 11)
  assert.ok(Math.abs(tauShift.tauB - (2 / 3)) < 1e-9)

  const stability = computeRankStability(
    [base12, shifted12],
    [
      Object.fromEntries(base12.map((id, i) => [id, i < 4 ? 'top' : 'good'])),
      Object.fromEntries(shifted12.map((id, i) => [id, i < 4 ? 'top' : 'good'])),
    ],
  )
  assert.equal(stability.pairCount, 1)
  assert.equal(stability.maxTop3Displacements, 1)

  const paired = compareRunsPaired(
    { recallAt30: 0.6, recallAt60: 0.7, ndcgAt10: 0.72, totalTokens: 1000 },
    { recallAt30: 0.8, recallAt60: 0.9, ndcgAt10: 0.8, totalTokens: 1200 },
  )
  assert.ok(Math.abs(paired.deltaRecallAt60 - 0.2) < 1e-9)
  assert.equal(paired.deltaTotalTokens, 200)
})

test('rubric Option A vs Option B diverge predictably on (3,2,2) vs (2,3,3)', () => {
  const items = [
    { id: 'adj_strong_resume', rubric: { D: 2, E: 3, L: 3 }, recallRank: 1 },
    { id: 'exact_duty_transferable', rubric: { D: 3, E: 2, L: 2 }, recallRank: 2 },
    { id: 'mismatch_good_city', rubric: { D: 0, E: 3, L: 3 }, recallRank: 0 },
  ]
  const outA = rankRubricOptionA(items)
  assert.equal(outA[0].id, 'exact_duty_transferable')
  assert.equal(outA[0].tier, 'top')
  assert.equal(outA[1].tier, 'good')
  assert.equal(outA[2].tier, 'skip')

  const outB = rankRubricOptionB(items)
  assert.equal(outB[0].id, 'adj_strong_resume')
  assert.equal(outB[0].tier, 'top')
  assert.equal(outB[1].tier, 'top')
})

test('synthetic benchmark enforces zero leaks, <=30/round cap, sendToModel=false silence, mock est tokens, and adversarial baseline diagnostics', async () => {
  const dataset = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8'))
  const run1 = await evaluateDataset(dataset, { seed: 42, limit: 30, rounds: 2 })
  const run2 = await evaluateDataset(dataset, { seed: 42, limit: 30, rounds: 2 })

  assert.equal(run1.stage1Summary.totalHardLeaks, 0)
  assert.equal(run1.stage1Summary.sendToModelFalseCalls, 0)
  assert.ok(run1.stage1Summary.maxPerRoundSelectedCount <= 30)
  assert.equal(run1.personas.length, 3)

  // Mock usage stream events must populate non-zero mock-estimated tokens
  assert.equal(run1.stage2Summary.tokenMode, 'mock_estimated')
  assert.ok(run1.stage2Summary.totalTokens > 0)

  // Deterministic repeatability on identical run
  assert.deepEqual(run1.stage1Summary, { ...run2.stage1Summary, totalLatencyMs: run1.stage1Summary.totalLatencyMs })
  assert.deepEqual(run1.stage2Summary, run2.stage2Summary)

  // Independent hard-exclusion leak test catches leaked explicit_exclude ID if selector misses one
  const aiPersona = run1.personas.find(p => p.personaId === 'synthetic_ai_infra')
  assert.equal(aiPersona.stage1.labelScope, 'full_pool')
  assert.equal(aiPersona.stage1.missingJdCount, 1)
  assert.equal(aiPersona.stage1.irrelevantCount, 2)
  assert.equal(aiPersona.stage2.adversarialDiagnostics.emptyQuoteAcceptedAsTopOrGoodCount, 0)
  assert.equal(aiPersona.stage2.adversarialDiagnostics.missingScoreAcceptedAsLlmCount, 0)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.unverifiedQuoteMarkedCount >= 2)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.noiseInTopCount >= 1)
})

test('F01: two-round replay hits 60/65 relevant jobs (<=30/round), inactive-board & explicit empty boards isolation, hydration fixtures, and Round 1->2 carryover', async () => {
  // 1) 65 relevant jobs across 2 rounds -> Round 1 picks 30, Round 2 picks 30 -> 60/65
  const jobs65 = Array.from({ length: 65 }, (_, i) =>
    makeJob(`greenhouse:scale-board:job-${i}`, {
      verifiedAt: `2026-11-24T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
  const mock65 = Object.fromEntries(jobs65.map(j => [j.id, {
    score: 90,
    tier: 'top',
    primaryRoleFit: 'match',
    roleQuote: '负责大规模分布式推理引擎与 GPU 调度系统开发',
    uncertain: false,
    reason: '匹配',
  }]))
  const report65 = await evaluateDataset({
    id: 'scale_65',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'scale-board' }],
    opportunities: jobs65,
    labels: Object.fromEntries(jobs65.map(j => [j.id, 3])),
    mockLlmResponses: mock65,
  }, { limit: 60, rounds: 2 })

  const p65 = report65.personas[0]
  assert.equal(p65.stage1.round1SelectedCount, 30)
  assert.equal(p65.stage1.round2SelectedCount, 30)
  assert.equal(p65.stage1.twoRoundSelectedCount, 60)
  assert.equal(p65.stage1.selectionRecallAt60, 60 / 65)
  assert.equal(p65.stage1.recallAt60Pool, 60 / 65)
  assert.equal(p65.stage2.evaluatedCount, 60)
  assert.equal(p65.stage2.readyConsumedCount, 60)

  // 1b) Stage-1-only 65-job replay (without mockLlmResponses) also spans two <=30 rounds
  const stage1Only65 = await evaluateDataset({
    id: 'stage1_only_65',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'scale-board' }],
    opportunities: jobs65,
    labels: Object.fromEntries(jobs65.map(j => [j.id, 3])),
  }, { limit: 60, rounds: 2 })
  assert.equal(stage1Only65.personas[0].stage1.round1SelectedCount, 30)
  assert.equal(stage1Only65.personas[0].stage1.round2SelectedCount, 30)
  assert.equal(stage1Only65.personas[0].stage1.selectionRecallAt60, 60 / 65)
  assert.equal(stage1Only65.personas[0].stage2, null)

  // 1c) Non-circular independent hard-exclusion audit catches leaked item if selector misses an independent expectation
  const leakedIntern = makeJob('ashby:kv:intern-leak', {
    sourceId: 'ashby:kv',
    provider: 'ashby',
    title: 'Go Systems Summer Intern',
    jd: 'Summer internship writing Go storage benchmarks and tests.',
  })
  const leakCheckReport = await evaluateDataset({
    id: 'independent_leak_check',
    goal: 'Remote Go Engineer, no interns', // plural phrase not matched by singular avoid hint in selector
    searchTerms: ['Go'],
    boards: [{ provider: 'ashby', slug: 'kv' }],
    opportunities: [leakedIntern],
    labels: {},
    expectedHardExclusions: { [leakedIntern.id]: 'explicit_exclude' },
  }, { limit: 30, rounds: 1 })
  assert.equal(leakCheckReport.personas[0].stage1.expectedExplicitExcludeLeakCount, 1)
  assert.equal(leakCheckReport.stage1Summary.totalHardLeaks, 1)

  // 2) 60 inactive-board high-score jobs + 1 active relevant job -> Pool excludes inactive boards (Recall@60 = 1.0, not 0)
  const inactiveJobs = Array.from({ length: 60 }, (_, i) =>
    makeJob(`greenhouse:disabled-board:high-${i}`, {
      sourceId: 'greenhouse:disabled-board',
      verifiedAt: `2026-11-24T01:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
  const activeJob = makeJob('greenhouse:active-board:only-active', {
    sourceId: 'greenhouse:active-board',
    title: 'Linux 系统运维开发',
    jd: '负责服务端自动化部署与性能调优，维护分布式微服务稳定运行，配合基础设施团队迭代监控告警策略。',
    verifiedAt: '2026-11-24T00:00:00.000Z',
  })
  const reportInactive = await evaluateDataset({
    id: 'inactive_filter_check',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'active-board' }],
    opportunities: [...inactiveJobs, activeJob],
    labels: { [activeJob.id]: 3 },
  })
  assert.equal(reportInactive.personas[0].stage1.inactiveBoardCount, 60)
  assert.equal(reportInactive.personas[0].stage1.openPoolCount, 1)
  assert.equal(reportInactive.personas[0].stage1.recallAt60Pool, 1)
  assert.equal(reportInactive.personas[0].stage1.selectionRecallAt30, 1)

  // 3) Explicit empty boards `[]` must select 0 jobs (never fall back to all boards)
  const reportEmptyBoards = await evaluateDataset({
    id: 'empty_boards_check',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra'],
    boards: [],
    opportunities: [activeJob],
    labels: {},
  })
  assert.equal(reportEmptyBoards.personas[0].stage1.openPoolCount, 0)
  assert.equal(reportEmptyBoards.personas[0].stage1.round1SelectedCount, 0)

  // 4) Carryover across Round 1 -> Round 2: hydrated succeeds, failed hydration stays unhydrated & suppressed in R2, failed LLM retries in R2
  const r1HydratedOk = makeJob('greenhouse:b:hyd-ok', { sourceId: 'greenhouse:b', externalId: 'hyd-ok', jd: '待补全', jdPreview: true })
  const r1HydrationFail = makeJob('greenhouse:b:hyd-fail', { sourceId: 'greenhouse:b', externalId: 'hyd-fail', jd: '待补全', jdPreview: true })
  const r1FailOnce = makeJob('greenhouse:b:retry-me', { sourceId: 'greenhouse:b', externalId: 'retry-me' })
  const r1Ok = makeJob('greenhouse:b:ok-r1', { sourceId: 'greenhouse:b', externalId: 'ok-r1' })
  const carryoverReport = await evaluateDataset({
    id: 'carryover_check',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'b' }],
    opportunities: [r1Ok, r1FailOnce, r1HydratedOk, r1HydrationFail],
    hydrationFixtures: {
      [r1HydratedOk.id]: { jd: '负责大规模分布式推理引擎与 GPU 调度系统研发及线上调优工作。' },
      [r1HydrationFail.id]: { error: true },
    },
    round1FailIds: [r1FailOnce.id],
    labels: { [r1Ok.id]: 3, [r1FailOnce.id]: 3, [r1HydratedOk.id]: 2 },
    mockLlmResponses: {
      [r1Ok.id]: { score: 92, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模分布式推理引擎与 GPU 调度系统开发', uncertain: false, reason: 'ok' },
      [r1FailOnce.id]: { score: 91, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模分布式推理引擎与 GPU 调度系统开发', uncertain: false, reason: 'retried ok' },
      [r1HydratedOk.id]: { score: 78, tier: 'good', primaryRoleFit: 'adjacent', roleQuote: '负责大规模分布式推理引擎与 GPU 调度系统研发及线上调优工作', uncertain: false, reason: 'hydrated ok' },
    },
  }, { limit: 30, rounds: 2 })

  const cp = carryoverReport.personas[0]
  assert.equal(cp.stage1.hydratedCount, 1)
  assert.equal(cp.stage1.unhydratedCount, 1)
  assert.equal(cp.stage1.unhydratedFailedCount, 1)
  assert.equal(cp.stage1.retriedFromRound1Count, 1)
  // Round 2 only retries r1FailOnce (does not re-select r1Ok, r1HydratedOk, or missing_jd r1HydrationFail)
  assert.deepEqual(cp.stage1.rounds[1].selectedIds, [r1FailOnce.id])
  assert.equal(cp.stage2.readyConsumedCount, 3)
  assert.equal(cp.stage2.evaluatedCount, 3)

  // 5) Fixed gold denominator before selection & --rounds 1 discipline (unselected hydratable preview stays in denominator)
  const fixedJob1 = makeJob('greenhouse:fix:1', { sourceId: 'greenhouse:fix', externalId: '1', verifiedAt: '2026-11-24T03:00:00.000Z' })
  const fixedJob2 = makeJob('greenhouse:fix:2', { sourceId: 'greenhouse:fix', externalId: '2', verifiedAt: '2026-11-24T02:00:00.000Z' })
  const fixedPreview3 = makeJob('greenhouse:fix:3', { sourceId: 'greenhouse:fix', externalId: '3', jd: '待补全', jdPreview: true, verifiedAt: '2026-11-24T01:00:00.000Z' })
  const fixedDenomReport = await evaluateDataset({
    id: 'fixed_denominator_check',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'fix' }],
    opportunities: [fixedJob1, fixedJob2, fixedPreview3],
    hydrationFixtures: {
      [fixedPreview3.id]: { jd: '负责大规模分布式推理引擎与 GPU 调度系统开发优化。' },
    },
    labels: { [fixedJob1.id]: 3, [fixedJob2.id]: 3, [fixedPreview3.id]: 3 },
  }, { limit: 1, rounds: 2 })
  assert.equal(fixedDenomReport.personas[0].stage1.twoRoundSelectedCount, 2)
  assert.equal(fixedDenomReport.personas[0].stage1.labelScope, 'full_pool')
  assert.equal(Number(fixedDenomReport.personas[0].stage1.selectionRecallAt60.toFixed(4)), Number((2 / 3).toFixed(4)))

  const singleRoundReport = await evaluateDataset({
    id: 'single_round_only',
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra'],
    boards: [{ provider: 'greenhouse', slug: 'fix' }],
    opportunities: [fixedJob1],
    labels: { [fixedJob1.id]: 3 },
  }, { limit: 30, rounds: 1 })
  assert.equal(singleRoundReport.personas[0].stage1.selectionRecallAt30, 1)
  assert.equal(singleRoundReport.personas[0].stage1.selectionRecallAt60, null)
  assert.equal(singleRoundReport.personas[0].stage1.judgedHitsTwoRounds, null)
})

test('F02: sampler retains minimal full pool & approved default master v2 (not v1), and eval treats unjudged/sparse/missing-JD distinctly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-f02-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const careerFile = join(dir, 'career.json')
  const watchdogFile = join(dir, 'watchdog.json')

  const store = new CareerStore({ file: careerFile })
  const v1 = await store.importResume({ title: 'Master Resume', text: '# Master Resume v1 (stale)' })
  await store.reviewResume(v1.id, { action: 'approve' })
  const v2 = await store.reviseResume(v1.id, { text: '# Master Resume v2 (approved default)', summary: 'v2' })
  await store.reviewResume(v2.id, { action: 'approve' })
  await store.setDefaultMasterTrack(v1.trackId)
  // Add an unapproved pending v3 draft that must NOT be selected
  await store.reviseResume(v2.id, { text: '# Master Resume v3 (pending draft)', summary: 'v3 draft' })

  const summary = await store.summary()
  const chosen = selectDefaultApprovedMaster(summary.resumes, summary.defaultMasterTrackId)
  assert.equal(chosen.id, v2.id)

  // 80 jobs, 1 relevant among 80, sample only 8
  const opps80 = Array.from({ length: 80 }, (_, i) =>
    makeJob(`greenhouse:pool80:job-${i}`, {
      sourceId: 'greenhouse:pool80',
      title: i === 79 ? 'Senior AI Infra GPU Engine' : `Operations Associate ${i}`,
      jd: i === 79
        ? '负责分布式 GPU 推理平台与 CUDA 服务研发优化。'
        : `日常运维客服支持与文档整理第 ${i} 岗位职责说明，协调办公流程与日程排期。`,
      verifiedAt: `2026-11-24T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
  await writeFile(watchdogFile, JSON.stringify({
    config: { goal: '上海 AI Infra', searchTerms: ['AI Infra', 'GPU'], boards: [{ provider: 'greenhouse', slug: 'pool80' }] },
    opportunities: opps80,
    receipts: [],
  }), 'utf8')

  const sampled = await samplePrivateDataset({ watchdogPath: watchdogFile, careerPath: careerFile, count: 8, seed: 42 })
  const sp = sampled.personas[0]
  assert.equal(sp.opportunities.length, 80)
  assert.equal(sp.sampleIds.length, 8)
  assert.match(sp.resumeText, /Master Resume v2/)
  assert.equal(sp.resumeMeta.id, v2.id)

  // All null unjudged -> every label-based metric is null (n/a)
  const unjudgedReport = await evaluateDataset(sampled)
  assert.equal(unjudgedReport.personas[0].stage1.labelScope, 'unjudged')
  assert.equal(unjudgedReport.personas[0].stage1.recallAt60Pool, null)
  assert.equal(unjudgedReport.personas[0].stage1.ndcgAt10, null)
  assert.equal(unjudgedReport.personas[0].stage1.precisionAt10, null)

  // Sparse sample (only 8 judged of 80): MUST NOT report fake 100% absolute recall
  const sparseLabels = Object.fromEntries(sp.sampleIds.map(id => [id, id.endsWith('job-79') ? 3 : 0]))
  sparseLabels['greenhouse:pool80:job-79'] = 3
  const sparseReport = await evaluateDataset({
    ...sampled,
    personas: [{ ...sp, labels: sparseLabels }],
  })
  const sr = sparseReport.personas[0].stage1
  assert.equal(sr.labelScope, 'sparse_sample')
  assert.equal(sr.recallComparable, false)
  assert.equal(sr.recallAt30Pool, null)
  assert.equal(sr.recallAt60Pool, null)
  assert.equal(sr.selectionRecallAt30, null)
  assert.equal(sr.judgedRelevantTotal, 1)
  assert.ok(sr.labelCoverage > 0 && sr.labelCoverage < 0.2)
})

test('F03: comparability guard blocks Paired Delta on dataset, seed, budget, persona, or Stage1-vs-Stage2 mismatches', async () => {
  const dataset = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8'))
  const baseRun = await evaluateDataset(dataset, { seed: 42, limit: 30, rounds: 2 })
  const sameRun = await evaluateDataset(dataset, { seed: 42, limit: 30, rounds: 2 })
  const diffSeedRun = await evaluateDataset(dataset, { seed: 99, limit: 30, rounds: 2 })
  const diffBudgetRun = await evaluateDataset(dataset, { seed: 42, limit: 15, rounds: 1 })

  const stage1OnlyDataset = {
    ...dataset,
    personas: dataset.personas.map(({ mockLlmResponses: _m, adversarialMockResponses: _a, ...rest }) => rest),
  }
  const stage1OnlyRun = await evaluateDataset(stage1OnlyDataset, { seed: 42, limit: 30, rounds: 2 })

  assert.equal(checkReportComparability(baseRun, sameRun).comparable, true)
  assert.equal(compareReports(baseRun, sameRun).comparable, true)

  for (const incompatible of [diffSeedRun, diffBudgetRun, stage1OnlyRun]) {
    const cmp = compareReports(baseRun, incompatible)
    assert.equal(cmp.comparable, false)
    assert.equal(cmp.stage1Delta, null)
    assert.equal(cmp.stage2Delta, null)
    const md = formatEvalMarkdown(incompatible, baseRun)
    assert.match(md, /Not comparable/)
    assert.doesNotMatch(md, /deltaNdcg@10/)
  }

  // Removing Stage 2 from only one persona (while another persona keeps Stage 2) MUST still fail comparability
  const partialStage2Removed = structuredClone(sameRun)
  partialStage2Removed.personas = partialStage2Removed.personas.map(p => (
    p.personaId === 'synthetic_ai_infra' ? { ...p, stage2: null } : p
  ))
  const partialCmp = compareReports(baseRun, partialStage2Removed)
  assert.equal(partialCmp.comparable, false)
  assert.equal(partialCmp.stage2Delta, null)
  const partialMd = formatEvalMarkdown(partialStage2Removed, baseRun)
  assert.match(partialMd, /Not comparable/)
  assert.doesNotMatch(partialMd, /-1544/)

  // Changing evaluated set in Stage 2 blocks Stage 2 paired delta without fabricating token deltas
  const diffStage2Set = structuredClone(sameRun)
  diffStage2Set.personas = diffStage2Set.personas.map(p => (
    p.personaId === 'synthetic_ai_infra'
      ? { ...p, stage2: { ...p.stage2, evaluatedHash: 'different_hash' } }
      : p
  ))
  const diffSetCmp = compareReports(baseRun, diffStage2Set)
  assert.equal(diffSetCmp.comparable, true)
  assert.equal(diffSetCmp.stage2Delta.comparable, false)
  assert.equal(diffSetCmp.stage1Delta.deltaRecallAt60.pairs, 3)
  assert.equal(diffSetCmp.stage1Delta.deltaNdcgAt10.pairs, 3)
})

test('F04: CLI guards anchor repo ignored directories, reject subdir/symlink escapes, and write private files with 0600 mode', async t => {
  await assert.rejects(
    () => execFileAsync('node', ['scripts/eval/run-eval.mjs'], { cwd: ROOT }),
    err => err.code === 2,
  )
  await assert.rejects(
    () => execFileAsync('node', ['scripts/eval/sample-private-dataset.mjs'], { cwd: ROOT }),
    err => err.code === 2,
  )

  const workDir = await mkdtemp(join(tmpdir(), 'eval-f04-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))
  const watchdogPath = join(workDir, 'watchdog.json')
  await writeFile(watchdogPath, JSON.stringify({
    config: { goal: '上海 GPU', searchTerms: ['GPU'] },
    opportunities: [makeJob('gh:a:1', { sourceId: 'gh:a' })],
  }), 'utf8')

  // Subdir relative path trap (`cd test && --out scripts/eval/local-data/trap.json` would resolve inside `test/`!)
  const trapSubdirTarget = join(ROOT, 'test', 'scripts', 'eval', 'local-data', 'trap.json')
  t.after(() => rm(join(ROOT, 'test', 'scripts'), { recursive: true, force: true }))
  await assert.rejects(
    () => execFileAsync(
      'node',
      ['../scripts/eval/sample-private-dataset.mjs', '--watchdog', watchdogPath, '--out', 'scripts/eval/local-data/trap.json'],
      { cwd: join(ROOT, 'test') },
    ),
    err => /Refusing to write outside/i.test(err.stderr || err.message),
  )
  void trapSubdirTarget

  // Symlink escape inside repo local-data pointing outside repo must be rejected
  const uniqueTag = `test-tmp-${Date.now()}`
  const symlinkPath = join(ROOT, 'scripts', 'eval', 'local-data', uniqueTag)
  const danglingFileSymlink = join(ROOT, 'scripts', 'eval', 'local-data', `dangling-${Date.now()}.json`)
  const danglingReportSymlink = join(ROOT, 'scripts', 'eval', 'reports', `dangling-report-${Date.now()}.json`)
  t.after(async () => {
    await rm(symlinkPath, { force: true })
    await rm(danglingFileSymlink, { force: true })
    await rm(danglingReportSymlink, { force: true })
  })
  await execFileAsync('mkdir', ['-p', join(ROOT, 'scripts', 'eval', 'local-data'), join(ROOT, 'scripts', 'eval', 'reports')])
  await symlink(workDir, symlinkPath)
  await assert.rejects(
    () => execFileAsync(
      'node',
      ['scripts/eval/sample-private-dataset.mjs', '--watchdog', watchdogPath, '--out', `scripts/eval/local-data/${uniqueTag}/escape.json`],
      { cwd: ROOT },
    ),
    err => /Refusing to write outside/i.test(err.stderr || err.message),
  )

  // Dangling file symlinks (target outside repo does not exist yet) must also be rejected without creating targets
  const nonexistentOutsideGold = join(workDir, 'dangling-gold-target.json')
  const nonexistentOutsideReport = join(workDir, 'dangling-report-target.json')
  await symlink(nonexistentOutsideGold, danglingFileSymlink)
  await symlink(nonexistentOutsideReport, danglingReportSymlink)
  await assert.rejects(
    () => execFileAsync(
      'node',
      ['scripts/eval/sample-private-dataset.mjs', '--watchdog', watchdogPath, '--out', danglingFileSymlink],
      { cwd: ROOT },
    ),
    err => /Refusing to write/i.test(err.stderr || err.message),
  )
  await assert.rejects(
    () => execFileAsync(
      'node',
      ['scripts/eval/run-eval.mjs', '--dataset', BENCHMARK_PATH, '--out', danglingReportSymlink],
      { cwd: ROOT },
    ),
    err => /Refusing to write/i.test(err.stderr || err.message),
  )
  await assert.rejects(() => stat(nonexistentOutsideGold), err => err.code === 'ENOENT')
  await assert.rejects(() => stat(nonexistentOutsideReport), err => err.code === 'ENOENT')

  // Legitimate repo gitignored outputs write cleanly with 0600 file permissions
  const validGoldOut = join(ROOT, 'scripts', 'eval', 'local-data', `gold-${Date.now()}.json`)
  const validReportOut = join(ROOT, 'scripts', 'eval', 'reports', `report-${Date.now()}.json`)
  t.after(async () => {
    await rm(validGoldOut, { force: true })
    await rm(validReportOut, { force: true })
  })

  await execFileAsync(
    'node',
    ['scripts/eval/sample-private-dataset.mjs', '--watchdog', watchdogPath, '--out', validGoldOut],
    { cwd: ROOT },
  )
  const goldStat = await stat(validGoldOut)
  assert.equal(goldStat.mode & 0o777, 0o600)

  // Report --out outside scripts/eval/reports/ must fail without --allow-any-out
  await assert.rejects(
    () => execFileAsync(
      'node',
      ['scripts/eval/run-eval.mjs', '--dataset', BENCHMARK_PATH, '--out', join(workDir, 'outside.json')],
      { cwd: ROOT },
    ),
    err => /Refusing to write outside/i.test(err.stderr || err.message),
  )

  const { stdout } = await execFileAsync(
    'node',
    ['scripts/eval/run-eval.mjs', '--dataset', BENCHMARK_PATH, '--out', validReportOut, '--json'],
    { cwd: ROOT },
  )
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.stage1Summary.totalHardLeaks, 0)
  assert.equal(parsed.stage1Summary.sendToModelFalseCalls, 0)
  const repStat = await stat(validReportOut)
  assert.equal(repStat.mode & 0o777, 0o600)
})
