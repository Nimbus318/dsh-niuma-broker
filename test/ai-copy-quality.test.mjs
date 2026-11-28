import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host.mjs'
import { buildMarketInsightSystem, normalizeMarketInsightReport } from '../src/market-insights.mjs'
import { buildRubricSystemPrompt } from '../src/triage-rubric.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'

test('AI prompt contracts enforce anti-repetition, silent omission, and no scripted monologues', () => {
  const marketZh = buildMarketInsightSystem('zh')
  assert.match(marketZh, /静默省略缺失数据/)
  assert.match(marketZh, /只有当 recentWorkEvidence 也为空.*才让 hiddenGems 返回 \[\]/)
  assert.match(marketZh, /严禁在 verdict 或任何字段写出/)
  assert.match(marketZh, /严禁把简历里的完整项目和数字明细照抄复读/)
  assert.doesNotMatch(marketZh, /诚实说明并给出通用起点建议/)
  const marketJsonMatch = marketZh.match(/输出紧凑 JSON：\s*(\{[\s\S]*\})\s*$/u)
  assert.ok(marketJsonMatch, 'market prompt should contain a valid JSON schema example')
  assert.doesNotThrow(() => JSON.parse(marketJsonMatch[1]))

  const rubricZh = buildRubricSystemPrompt('zh')
  assert.match(rubricZh, /≤45字/)
  assert.match(rubricZh, /禁止复读简历数字/)
  assert.match(rubricZh, /≤35字/)
  const rubricJsonMatch = rubricZh.match(/(\{"items":\[[\s\S]*\]\})\s*$/u)
  assert.ok(rubricJsonMatch, 'rubric prompt should contain a valid JSON schema example')
  assert.doesNotThrow(() => JSON.parse(rubricJsonMatch[1]))
})

test('normalizeMarketInsightReport clamps oversized sections tightly without dropping valid entries', () => {
  const longText = '超长段落'.repeat(120)
  const report = normalizeMarketInsightReport({
    headline: longText,
    marketSummary: longText,
    hotTrends: Array.from({ length: 6 }, (_, i) => ({
      title: `方向${i}-${longText}`,
      heat: 'surging',
      signal: longText,
      skills: ['K8s', 'Go'],
    })),
    personalAlignment: {
      verdict: longText,
      strengths: Array.from({ length: 5 }, (_, i) => ({ point: `优势${i}-${longText}`, detail: longText })),
      hiddenGems: Array.from({ length: 5 }, (_, i) => ({ point: `隐形${i}-${longText}`, detail: longText })),
      gaps: Array.from({ length: 5 }, (_, i) => ({
        skill: `缺口${i}-${longText}`,
        priority: 'high',
        why: longText,
        howInCurrentJob: longText,
      })),
    },
    actionPlan: Array.from({ length: 6 }, (_, i) => ({
      title: `动作${i}-${longText}`,
      horizon: 'this_week',
      kind: 'work',
      detail: longText,
    })),
  }, 'zh')

  assert.ok(report.headline.length <= 100)
  assert.ok(report.marketSummary.length <= 260)
  assert.equal(report.hotTrends.length, 4)
  assert.ok(report.hotTrends[0].title.length <= 70)
  assert.ok(report.hotTrends[0].signal.length <= 180)
  assert.ok(report.personalAlignment.verdict.length <= 200)
  assert.equal(report.personalAlignment.strengths.length, 3)
  assert.equal(report.personalAlignment.hiddenGems.length, 3)
  assert.equal(report.personalAlignment.gaps.length, 3)
  assert.equal(report.actionPlan.length, 4)
})

test('job-intel and jd-probe capture crisp system prompts, allow empty highlights on weak matches, and clamp output ceilings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-copy-quality-'))
  const harness = createFetchHarness()
  let dispose
  const capturedSystems = []
  let nextReply = {}

  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => ({ session: { id: 's1' }, events: [] }),
    },
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'fast', name: 'Fast' }] }],
      async *stream(req) {
        capturedSystems.push(req.system)
        yield { type: 'text-delta', index: 0, text: JSON.stringify(nextReply) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }

  await apply(ctx)
  t.after(async () => {
    await dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const act = body => harness.call('POST', '/api/career-agent/action', body)

  await act({
    action: 'configure',
    config: { mode: 'search', model: 'mock:fast', sendToModel: true, goal: '资深 AI 基础设施工程师' },
  })
  const imported = await act({
    action: 'resume-import',
    title: '主干简历',
    text: '# 林予安\n主导 2,400+ GPU 调度架构，利用率从 41% 提升至 69%。',
  })
  await act({ action: 'resume-review', id: imported.data.result.id, decision: 'approve' })

  const weakJob = await act({
    action: 'job-add',
    job: { company: '示例云', title: '售后远程支持工程师', jd: '负责驻场交付与夜间响应客户工单。' },
  })
  const jobId = weakJob.data.result.id

  // Weak match returns highlights: [] and stays concise
  nextReply = {
    verdict: '偏售后驻场与工单响应，与平台研发方向不一致，不建议优先投入。',
    highlights: [],
    riskNotes: [
      { term: '夜间响应', meaning: '大概率包含非工作时间 On-Call', question: '夜间值班频率如何安排？' },
    ],
    diligence: ['岗位归属售后支持还是研发团队？'],
  }
  const weakIntel = await act({ action: 'job-intel', id: jobId, force: true })
  assert.equal(weakIntel.status, 200)
  assert.deepEqual(weakIntel.data.result.highlights, [])
  assert.equal(weakIntel.data.result.riskNotes.length, 1)
  assert.match(capturedSystems[0], /弱匹配或无独特对口点，highlights 直接返回 \[\]/)
  assert.match(capturedSystems[0], /严禁在任何字段写「当前没有某某记录/)

  // Oversized model output gets clamped to crisp bounds
  const mega = '冗余说明'.repeat(100)
  nextReply = {
    verdict: mega,
    highlights: [mega, mega, mega],
    riskNotes: Array.from({ length: 5 }, (_, i) => ({ term: `风险词${i}`, meaning: mega, question: mega })),
    diligence: [mega, mega, mega, mega],
  }
  const clampedIntel = await act({ action: 'job-intel', id: jobId, force: true })
  assert.ok(clampedIntel.data.result.verdict.length <= 220)
  assert.equal(clampedIntel.data.result.highlights.length, 2)
  assert.ok(clampedIntel.data.result.highlights.every(item => item.length <= 120))
  assert.equal(clampedIntel.data.result.riskNotes.length, 3)
  assert.ok(clampedIntel.data.result.riskNotes.every(r => r.meaning.length <= 140 && r.question.length <= 120))
  assert.equal(clampedIntel.data.result.diligence.length, 2)
  assert.ok(clampedIntel.data.result.diligence.every(item => item.length <= 120))

  // jd-probe enforces anti-script prompt & tight clamps
  nextReply = {
    summary: mega,
    whyItMatters: mega,
    bridgeToYou: mega,
    interviewQuestions: [mega, mega, mega],
    studyTip: mega,
  }
  const probe = await act({ action: 'jd-probe', id: jobId, term: 'Volcano' })
  assert.equal(probe.status, 200)
  assert.match(capturedSystems.at(-1), /严禁代写“面试可诚实表述：『……』”这类背诵台词/)
  assert.ok(probe.data.result.summary.length <= 200)
  assert.ok(probe.data.result.whyItMatters.length <= 160)
  assert.ok(probe.data.result.bridgeToYou.length <= 240)
  assert.equal(probe.data.result.interviewQuestions.length, 2)
  assert.ok(probe.data.result.interviewQuestions.every(q => q.length <= 120))
  assert.ok(probe.data.result.studyTip.length <= 160)
})
