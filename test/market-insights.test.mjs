import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  analyzeMarketCorpus,
  extractJobMarketFeatures,
  normalizeMarketInsightReport,
  recordMarketHistorySnapshot,
  shouldAutoRefreshMarketInsight,
} from '../src/market-insights.mjs'

test('extractJobMarketFeatures merges canonical aliases and avoids short-token false positives', () => {
  const infraJob = {
    id: 'j-1',
    title: 'Senior AI Infra Engineer (Agent Sandbox)',
    location: '上海 / Remote',
    jd: 'Build K8s multi-tenant GPU scheduling and MicroVM sandbox runtimes in Golang and Rust. Experience with vLLM, KV-Cache, and OpenTelemetry preferred.',
    verifiedAt: '2026-11-22T02:00:00.000Z',
  }
  const feats = extractJobMarketFeatures(infraJob)
  assert.equal(feats.hasJd, true)
  assert.equal(feats.isSenior, true)
  assert.ok(feats.skillIds.has('kubernetes'))
  assert.ok(feats.skillIds.has('sandbox_microvm'))
  assert.ok(feats.skillIds.has('golang'))
  assert.ok(feats.skillIds.has('rust'))
  assert.ok(feats.skillIds.has('vllm_sglang'))
  assert.ok(feats.skillIds.has('inference_opt'))
  assert.ok(feats.skillIds.has('observability'))
  assert.ok(feats.locations.has('shanghai'))
  assert.ok(feats.locations.has('remote'))

  const benignJob = {
    id: 'j-2',
    title: 'Operations Coordinator',
    location: '北京',
    jd: 'Manage cargo logistics, category planning, algorithmically simple spreadsheets, and ongoing good vendor communication.',
    verifiedAt: '2026-11-22T02:00:00.000Z',
  }
  const benignFeats = extractJobMarketFeatures(benignJob)
  assert.equal(benignFeats.skillIds.has('golang'), false, 'must not match Go inside cargo/category/good/ongoing')
  assert.equal(benignFeats.skillIds.has('agent'), false)
  assert.equal(benignFeats.isSenior, false)
})

test('analyzeMarketCorpus computes 3-way coverage (covered / in_work_only / gap) and real trend deltas', () => {
  const nowMs = Date.parse('2026-11-22T10:00:00.000Z')
  const jobs = [
    {
      id: 'o1', company: '字节跳动', sourceId: 'feishu:bytedance', title: '资深 AI Infra 工程师', location: '上海',
      jd: '负责 Kubernetes 集群调度、vLLM 推理加速与 KV-Cache 优化，熟练掌握 Go 与 Python，具备 MicroVM 沙箱经验优先。',
      firstSeenAt: '2026-11-21T08:00:00.000Z', match: { score: 82, tier: 'top' }, matches: ['AI Infra'],
    },
    {
      id: 'o2', company: '小红书', sourceId: 'xiaohongshu:social', title: 'Agent 平台架构师', location: '上海',
      jd: '搭建多租户 Agent 编排平台与 MCP 工具调用体系，熟悉 Kubernetes、Go 与 Firecracker 弹性沙箱。',
      firstSeenAt: '2026-11-20T08:00:00.000Z', match: { score: 78, tier: 'top' }, matches: ['Agent'],
    },
    {
      id: 'o3', company: '字节跳动', sourceId: 'feishu:bytedance', title: '大模型推理引擎专家', location: '北京',
      jd: '深入优化 SGLang / vLLM 与 Prefill Decode 分离架构，熟悉 CUDA 算子与 Kubernetes 部署。',
      firstSeenAt: '2026-11-19T08:00:00.000Z', match: { score: 74, tier: 'good' }, matches: ['推理'],
    },
    {
      id: 'o4', company: '美团', sourceId: 'meituan:social', title: 'AI 算力调度工程师', location: '北京',
      jd: '负责千卡 GPU 算力调度、Kubernetes Volcano 调度器与 Go 后端服务，熟悉 MCP 与 Agent 平台。',
      firstSeenAt: '2026-11-18T08:00:00.000Z', match: { score: 66, tier: 'good' }, matches: ['算力调度'],
    },
  ]

  const priorHistory = [
    {
      dateKey: '2026-11-15',
      at: '2026-11-15T10:00:00.000Z',
      scope: 'target',
      activeCount: 4,
      jdCount: 4,
      new7d: 2,
      topSkills: [
        { id: 'kubernetes', count: 3, pct: 75 },
        { id: 'sandbox_microvm', count: 1, pct: 25 },
      ],
    },
  ]

  const result = analyzeMarketCorpus({
    opportunities: jobs,
    allRawOpportunities: jobs,
    resumeText: '8年基础架构经验，精通 Kubernetes 云原生集群与 Go 高并发分布式系统架构。',
    evidence: [
      {
        id: 'ev-1',
        status: 'pending',
        title: '落地基于 Firecracker MicroVM 的弹性代码沙箱',
        text: '独立设计并上线了 Firecracker 弹性沙箱与 MCP 工具调用隔离层，冷启动降至 120ms。',
        occurredAt: '2026-11-21T06:00:00.000Z',
      },
    ],
    goal: '上海 AI Infra 与 Agent 平台资深工程师',
    searchTerms: ['AI Infra', 'Agent'],
    history: priorHistory,
    scope: 'target',
    locale: 'zh',
    nowMs,
  })

  assert.equal(result.activeCount, 4)
  assert.equal(result.jdCount, 4)
  assert.equal(result.trendReady, true)

  const byId = new Map(result.topSkills.map(s => [s.id, s]))
  assert.equal(byId.get('kubernetes')?.coverage, 'covered')
  assert.equal(byId.get('golang')?.coverage, 'covered')
  assert.equal(byId.get('sandbox_microvm')?.coverage, 'in_work_only')
  assert.equal(byId.get('sandbox_microvm')?.matchedEvidence[0]?.id, 'ev-1')
  assert.equal(byId.get('sandbox_microvm')?.deltaPct, 25) // 50% - 25%
  assert.equal(byId.get('sandbox_microvm')?.trend, 'rising')
  assert.equal(byId.get('vllm_sglang')?.coverage, 'gap')
  assert.ok(result.coverageSummary.hiddenGemSkills.some(s => s.id === 'sandbox_microvm'))
  assert.equal(result.radarAxes.length, 5)
  assert.ok(byId.get('kubernetes')?.companyCount >= 3)
  assert.ok(byId.get('kubernetes')?.companyPct >= 75)
  assert.ok(result.companyTrackMatrix.companies.length >= 2)
  assert.ok(result.companyTrackMatrix.tracks.length >= 2)
  assert.ok(result.activitySeries.length >= 1)
  assert.equal(result.seniorCount + result.regularCount, result.activeCount)

  // Recording history snapshots deduplicates same-day updates and retains per-scope history
  const h1 = recordMarketHistorySnapshot(priorHistory, result, '2026-11-22T09:00:00.000Z')
  const h2 = recordMarketHistorySnapshot(h1, result, '2026-11-22T15:00:00.000Z')
  assert.equal(h2.length, 2)
  assert.equal(h2.at(-1).dateKey, '2026-11-22')
})

test('shouldAutoRefreshMarketInsight respects consent, weekly cadence, significant shifts, and cooldowns', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z')
  const analysis = { activeCount: 50, jdCount: 45, fingerprint: 'fp-new' }

  assert.equal(shouldAutoRefreshMarketInsight({ analysis, sendToModel: false, mode: 'search', nowMs: now }).should, false)
  assert.equal(shouldAutoRefreshMarketInsight({ analysis, sendToModel: true, mode: 'off', nowMs: now }).should, false)
  assert.equal(shouldAutoRefreshMarketInsight({ analysis, sendToModel: true, mode: 'observe', nowMs: now }).should, false)
  assert.equal(shouldAutoRefreshMarketInsight({ analysis, sendToModel: true, mode: 'search', boardsOn: false, nowMs: now }).should, false)
  assert.equal(shouldAutoRefreshMarketInsight({ analysis: { activeCount: 2, jdCount: 2 }, sendToModel: true, mode: 'search', nowMs: now }).should, false)
  assert.equal(shouldAutoRefreshMarketInsight({ analysis, sendToModel: true, mode: 'search', nowMs: now }).reason, 'initial')

  // Fresh report (2 hours ago, same fingerprint, small delta) -> skip
  const fresh = { generatedAt: '2026-11-22T10:00:00.000Z', fingerprint: 'fp-new', sample: { activeCount: 48 } }
  assert.equal(shouldAutoRefreshMarketInsight({ existingReport: fresh, analysis, sendToModel: true, mode: 'search', nowMs: now }).should, false)

  // Significant market jump (+12 jobs) after 7 hours -> refresh
  const shifted = { generatedAt: '2026-11-22T05:00:00.000Z', fingerprint: 'fp-new', sample: { activeCount: 38 } }
  assert.equal(shouldAutoRefreshMarketInsight({ existingReport: shifted, analysis, sendToModel: true, mode: 'search', nowMs: now }).reason, 'significant_market_shift')

  // Profile fingerprint changed after 13 hours -> refresh
  const profileOld = { generatedAt: '2026-11-21T22:00:00.000Z', fingerprint: 'fp-old', sample: { activeCount: 50 } }
  assert.equal(shouldAutoRefreshMarketInsight({ existingReport: profileOld, analysis, sendToModel: true, mode: 'search', nowMs: now }).reason, 'profile_updated')

  // 8 days old -> weekly cadence refresh
  const weekOld = { generatedAt: '2026-11-14T10:00:00.000Z', fingerprint: 'fp-new', sample: { activeCount: 50 } }
  assert.equal(shouldAutoRefreshMarketInsight({ existingReport: weekOld, analysis, sendToModel: true, mode: 'search', nowMs: now }).reason, 'weekly_cadence')
})

test('normalizeMarketInsightReport safely handles partial or noisy model payloads', () => {
  const report = normalizeMarketInsightReport({
    headline: 'Agent 沙箱与推理降本成为 AI Infra 招聘核心增量',
    hotTrends: [{ title: '弹性沙箱', heat: 'surging', signal: '多家头部公司密集招 MicroVM 沙箱工程师。', skills: ['Sandbox', 'K8s'] }],
    requirementProfile: { baseline: ['Kubernetes', 'Go'], differentiators: ['KV-Cache'], emerging: ['MCP'] },
    personalAlignment: {
      verdict: '云原生底座扎实，补齐推理引擎经验即可冲击专家岗。',
      hiddenGems: [{ point: '工作已做沙箱隔离', detail: '建议将冷启动优化数据写入主干简历。', evidenceTitle: '弹性沙箱' }],
      gaps: [{ skill: 'vLLM', priority: 'high', why: '高频核心需求', howInCurrentJob: '用开源小集群做一次吞吐压测' }],
    },
    actionPlan: [{ title: '补齐沙箱成果到简历', horizon: 'this_week', kind: 'resume', detail: '补充压测数据与租户隔离设计。' }],
  }, 'zh')

  assert.equal(report.hotTrends.length, 1)
  assert.equal(report.hotTrends[0].heat, 'surging')
  assert.equal(report.personalAlignment.hiddenGems.length, 1)
  assert.equal(report.personalAlignment.gaps[0].priority, 'high')
  assert.equal(report.actionPlan[0].horizon, 'this_week')
})

test('host exposes live marketRadar, generates market-insight report, and purges provenance on forget(erase)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-market-insights-'))
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => ({ session: { id: 's1' }, events: [] }),
    },
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'fast', name: 'Fast' }] }],
      async *stream() {
        const payload = {
          headline: 'AI Infra 市场向 Agent 沙箱与推理优化集中',
          marketSummary: '样本中 Kubernetes 与 Go 为底座，MicroVM 与 vLLM 为显著加分项。',
          hotTrends: [
            { title: 'Agent 安全沙箱', heat: 'surging', signal: '头部团队普遍要求容器/微虚机隔离。', skills: ['Sandbox', 'K8s'] },
          ],
          requirementProfile: { baseline: ['Kubernetes', 'Go'], differentiators: ['vLLM'], emerging: ['MCP'] },
          personalAlignment: {
            verdict: '基础架构功底扎实，日常工作中的沙箱经历值得立刻补进简历。',
            strengths: [{ point: 'K8s 与 Go 底座扎实', detail: '命中绝大多数核心岗的基础门槛。' }],
            hiddenGems: [{ point: 'Firecracker 沙箱实践', detail: '日常已落地但尚未写入简历。', evidenceTitle: '上线弹性沙箱' }],
            gaps: [{ skill: 'vLLM 推理优化', priority: 'high', why: '高频拉分要求', howInCurrentJob: '在内部工具链接入本地 vLLM 并做吞吐基准测试' }],
          },
          actionPlan: [
            { title: '把沙箱经历写入主干简历', horizon: 'this_week', kind: 'resume', detail: '补充隔离架构与冷启动指标。', filterTerm: 'Sandbox' },
          ],
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(payload) } }
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

  const req = (url, body) => harness.call(body ? 'POST' : 'GET', url, body)
  const act = body => req('/api/career-agent/action', body)
  const getState = async () => (await req('/api/career-agent/state')).data

  await act({
    action: 'configure',
    config: {
      mode: 'search',
      model: 'mock:fast',
      sendToModel: true,
      goal: 'AI Infra 与 Agent 平台资深工程师',
      searchTerms: ['AI Infra', 'Agent'],
      sources: [{ id: 'manual', projects: ['*'] }],
    },
  })

  const imported = await act({
    action: 'resume-import',
    title: '主干简历',
    text: '# 林予安\n资深基础设施工程师，精通 Kubernetes 与 Go 分布式系统架构。',
  })
  await act({ action: 'resume-review', id: imported.data.result.id, decision: 'approve' })

  const ingested = await act({
    action: 'ingest',
    event: {
      id: 'ev-work-sandbox',
      sourceId: 'manual',
      projectId: 'personal',
      kind: 'manual',
      occurredAt: '2026-11-21T08:00:00.000Z',
      evidence: [
        {
          title: '上线弹性沙箱',
          text: '独立上线了基于 Firecracker MicroVM 的弹性代码沙箱，冷启动耗时 120ms。',
          role: '核心负责人',
          impact: '冷启动耗时 120ms',
        },
      ],
    },
  })
  const evId = ingested.data.result.evidence[0].id
  await act({ action: 'review', id: evId, decision: 'approve', shareable: true })

  for (const job of [
    { company: '字节跳动', title: '资深 AI Infra 工程师', location: '上海', jd: '负责 Kubernetes、Go、vLLM 推理与 MicroVM 沙箱平台建设。' },
    { company: '小红书', title: 'Agent 平台工程师', location: '上海', jd: '负责 Agent 编排、MCP 工具调用、Kubernetes 与 Firecracker 安全沙箱。' },
    { company: '美团', title: '大模型推理引擎专家', location: '北京', jd: '负责 vLLM / SGLang 推理优化、KV-Cache 与 Go 网关研发。' },
    { company: '腾讯', title: '云原生算力调度工程师', location: '深圳', jd: '负责 GPU 算力调度、Kubernetes、Docker 与多租户配额治理。' },
  ]) {
    await act({ action: 'job-add', job })
  }

  const before = await getState()
  assert.ok(before.marketRadar)
  assert.equal(before.marketRadar.target.activeCount, 4)
  assert.ok(before.marketRadar.target.coverageSummary.hiddenGemSkills.some(s => s.id === 'sandbox_microvm'))

  const gen = await act({ action: 'market-insight', scope: 'target', force: true })
  assert.equal(gen.status, 200)
  assert.equal(gen.data.result.report.headline, 'AI Infra 市场向 Agent 沙箱与推理优化集中')

  const after = await getState()
  assert.ok(after.marketRadar.reports.target?.report?.headline)
  assert.ok(after.marketRadar.target.history.length >= 1)

  // Erasing the manual source removes the cached market insight whose provenance depended on it
  const forgot = await act({ action: 'forget', source: 'manual', erase: true })
  assert.equal(forgot.status, 200)
  const afterForget = await getState()
  assert.equal(afterForget.marketRadar.reports.target, null)
})

test('radarAxes dynamically adapts to non-engineering professions (Product, Design, Growth, Data)', () => {
  const pmJobs = [
    {
      id: 'pm-1', company: '小红书', sourceId: 'xiaohongshu:social', title: '资深商业化产品经理', location: '上海',
      jd: '负责商业化产品规划与定价策略，熟悉 SQL 数据分析与 A/B 测试，推进跨部门协作与用户增长转化漏斗优化。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
    {
      id: 'pm-2', company: '字节跳动', sourceId: 'bytedance', title: '高级交互设计师 (Design System)', location: '北京',
      jd: '精通 Figma 交互设计与设计系统搭建，开展用户调研与竞品分析，推动产品体验升级与品牌视觉规范落地。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
    {
      id: 'pm-3', company: '美团', sourceId: 'meituan:social', title: '用户增长运营专家', location: '上海',
      jd: '主导用户增长、留存与私域运营，搭建经营分析 BI 看板与 A/B 实验体系，具备内容运营与 GTM 品牌营销经验。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
    {
      id: 'pm-4', company: '腾讯', sourceId: 'tencent:social', title: 'B端 SaaS 产品负责人', location: '深圳',
      jd: '负责企业级 SaaS 产品路线图与商业闭环，协同大客户拓展与售前解决方案团队推进 OKR 里程碑交付。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
  ]

  const result = analyzeMarketCorpus({
    opportunities: pmJobs,
    allRawOpportunities: pmJobs,
    resumeText: '6 年商业化产品经理经验，擅长 PRD 规划、SQL 数据分析与 A/B 测试、用户调研及跨部门协作。',
    scope: 'all',
    locale: 'zh',
  })

  const axisIds = new Set(result.radarAxes.map(a => a.id))
  assert.ok(axisIds.has('product_strategy'), 'PM cohort should include product_strategy domain')
  assert.ok(axisIds.has('data_bi') || axisIds.has('growth_ops') || axisIds.has('design_ux'), 'PM cohort should include non-engineering domains')
  assert.equal(axisIds.has('infra_sys'), false, 'PM cohort must NOT hardcode infra_sys')
  assert.equal(axisIds.has('ai_model'), false, 'PM cohort must NOT hardcode ai_model')
  assert.ok(result.roleClusters.some(c => c.id === 'product_solutions'))
  assert.ok(result.roleClusters.some(c => c.id === 'design_creative'))
  assert.ok(result.roleClusters.some(c => c.id === 'growth_marketing'))
})

test('rule engine avoids generic solutions/sibling-language false positives and feeds preferences/debriefs to AI', async () => {
  const { buildMarketInsightInput } = await import('../src/market-insights.mjs')
  const jobs = [
    {
      id: 's1', company: '字节跳动', sourceId: 'feishu:bytedance', title: '资深 AI Infra 工程师', location: '上海',
      jd: '负责大模型平台核心技术方案设计与高可用解决方案落地；熟练掌握 Go / Python / Java / C++ 至少一种语言，具备 vLLM 与 MCP 经验优先。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
    {
      id: 's2', company: '小红书', sourceId: 'xhs', title: 'Agent 平台工程师', location: '上海',
      jd: '负责技术方案设计，熟练使用 Python / Go / Java，具备 MCP 工具调用与 vLLM 推理服务经验。',
      firstSeenAt: '2026-11-21T08:00:00.000Z',
    },
  ]

  const res = analyzeMarketCorpus({
    opportunities: jobs,
    allRawOpportunities: jobs,
    resumeText: '8年基础架构经验，精通 Go 与 Python 分布式系统开发。',
    scope: 'all',
    locale: 'zh',
  })

  // Generic "技术方案设计 / 解决方案" in SWE JDs must NOT match Pre-Sales Solutions Architect!
  assert.equal(res.topSkills.some(s => s.id === 'solutions_presales'), false)
  // Candidate already covers 2 mainstream languages (Go + Python), so domain gaps (MCP / vLLM) must rank ahead of sibling Java/C++!
  assert.ok(res.coverageSummary.topGapSkills.length >= 2)
  assert.notEqual(res.coverageSummary.topGapSkills[0].id, 'java')
  assert.notEqual(res.coverageSummary.topGapSkills[0].id, 'cpp')

  const input = buildMarketInsightInput({
    analysis: res,
    opportunities: jobs,
    receipts: [{ opportunityId: 's1', type: 'application_submitted' }],
    jobFeedback: { s2: { status: 'dismissed', reason: 'not_fit' } },
    interviewNotes: [{ opportunityId: 's1', round: '一面', questions: ['KV-Cache 显存如何治理？'], feedback: ['架构扎实'] }],
  })
  assert.equal(input.jobPreferences.focusedRoles.length, 1)
  assert.equal(input.jobPreferences.dismissedRoles.length, 1)
  assert.equal(input.recentInterviewFeedback.length, 1)
  assert.equal(input.recentInterviewFeedback[0].questions[0], 'KV-Cache 显存如何治理？')
})

test('privacy: market-insight (board patrol & manual) and suggest-directions exclude private/pending evidence, and forget(erase) purges discoveryDirections across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-privacy-rc010-'))
  const privateTitle = 'SYNTH-PRIVATE-ONLY-TITLE'
  const privateBody = 'Synthetic private library topic mentioning Kubernetes and Firecracker.'
  const pendingTitle = 'SYNTH-PENDING-WORK-TITLE'
  const pendingBody = 'Synthetic unreviewed topic mentioning vLLM and Go.'
  const shareableTitle = 'SYNTH-SHAREABLE-WIN-TITLE'
  const shareableBody = 'Synthetic shareable topic mentioning Rust distributed runtime.'

  const origFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (!String(url).includes('boards-api.greenhouse.io/v1/boards/acme-synth/jobs')) {
      throw new Error(`Unexpected fetch: ${url}`)
    }
    return Response.json({
      jobs: Array.from({ length: 4 }, (_, i) => ({
        id: 5000 + i,
        title: `Staff Go Infra Engineer ${i}`,
        location: { name: 'Remote' },
        absolute_url: `https://job-boards.greenhouse.io/acme-synth/jobs/${5000 + i}`,
        updated_at: new Date().toISOString(),
        content: '<p>Build resilient distributed control planes in Go, Rust, Kubernetes, Firecracker, and vLLM.</p>',
      })),
    })
  }
  t.after(() => { globalThis.fetch = origFetch })

  const egress = []
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('no session') },
    },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      resolveModelInfo: async () => ({ provider: 'mock', id: 'fast', name: 'Fast' }),
      prepareCall: async () => ({
        stream: async function* (request) {
          const raw = JSON.stringify(request)
          const kind = raw.includes('recentWorkEvidence')
            ? 'market'
            : String(request.system || '').includes('目标公司探索方向')
              ? 'company-directions'
              : 'other'
          egress.push({
            kind,
            hasPrivateTitle: raw.includes(privateTitle),
            hasPrivateBody: raw.includes(privateBody),
            hasPendingTitle: raw.includes(pendingTitle),
            hasPendingBody: raw.includes(pendingBody),
            hasShareableTitle: raw.includes(shareableTitle),
            hasShareableBody: raw.includes(shareableBody),
          })
          const text = kind === 'market'
            ? JSON.stringify({ headline: 'synth market', hotTrends: [{ title: 'go infra', heat: 'surging', signal: 'K8s' }], personalAlignment: { verdict: 'ok' } })
            : kind === 'company-directions'
              ? JSON.stringify({ directions: [{ label: 'Infra', query: 'Infra Engineer', basis: privateTitle }], keywords: ['gpu'] })
              : JSON.stringify({ items: [] })
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }

  await apply(ctx)
  t.after(async () => {
    await dispose?.()
    await rm(dir, { recursive: true, force: true })
  })

  const req = (url, body, method = 'POST') => harness.call(method, url, body)
  const act = body => req('/api/career-agent/action', body)

  await act({ action: 'configure', config: { mode: 'off', sendToModel: false, watchSessions: false, autoJobIntel: false, model: 'mock:fast', tabModel: 'mock:fast', locale: 'zh' } })
  const imp = await act({ action: 'resume-import', title: 'Synthetic Master', text: '# Synth Dev\n\n## Experience\n- Built Go services.' })
  await act({ action: 'resume-review', id: imp.data.result.id, decision: 'approve' })

  const ing = await act({
    action: 'ingest',
    event: {
      id: 'synth-privacy-ev',
      sourceId: 'manual',
      projectId: 'personal',
      kind: 'manual',
      occurredAt: new Date().toISOString(),
      evidence: [
        { title: privateTitle, text: privateBody },
        { title: pendingTitle, text: pendingBody },
        { title: shareableTitle, text: shareableBody },
      ],
    },
  })
  const [privEv, , shareEv] = ing.data.result.evidence
  await act({ action: 'review', id: privEv.id, decision: 'approve', shareable: false })
  await act({ action: 'review', id: shareEv.id, decision: 'approve', shareable: true })

  // 1. Active suggest-directions with sendToModel=false still runs with selected model,
  //    never sends private/pending evidence, and caches the mock response containing privateTitle.
  const dirRes = await req('/api/career-agent/suggest-directions', { force: false, goal: 'AI Infra', explicitInteractive: true })
  assert.equal(dirRes.status, 200)
  const dirCall = egress.find(e => e.kind === 'company-directions')
  assert.ok(dirCall, 'explicit interactive suggest-directions must call selected model')
  assert.equal(dirCall.hasPrivateTitle, false, 'suggest-directions must exclude private evidence title')
  assert.equal(dirCall.hasPendingTitle, false, 'suggest-directions must exclude pending evidence title')
  assert.equal(dirCall.hasShareableTitle, true, 'suggest-directions may include approved shareable evidence')

  // 2. Enable board patrol only (mode='search', watchSessions=false, autoJobIntel=false) and trigger "立即拉取" (run scope:'boards')
  await act({
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      watchSessions: false,
      autoJobIntel: false,
      boards: [{ provider: 'greenhouse', slug: 'acme-synth', company: 'Acme QA' }],
    },
  })
  const runRes = await act({ action: 'run', scope: 'boards' })
  assert.equal(runRes.status, 200)
  for (let i = 0; i < 40 && !egress.some(e => e.kind === 'market'); i += 1) {
    await new Promise(r => setTimeout(r, 25))
  }
  const boardMarketCall = egress.find(e => e.kind === 'market')
  assert.ok(boardMarketCall, 'board patrol triggered market insight')
  assert.equal(boardMarketCall.hasPrivateTitle, false, 'market insight must exclude private title')
  assert.equal(boardMarketCall.hasPrivateBody, false, 'market insight must exclude private body')
  assert.equal(boardMarketCall.hasPendingTitle, false, 'market insight must exclude pending title')
  assert.equal(boardMarketCall.hasPendingBody, false, 'market insight must exclude pending body')
  assert.equal(boardMarketCall.hasShareableTitle, true, 'market insight may include approved shareable evidence')

  // 3. Erase 'manual' source -> discoveryDirections and marketInsights must be purged both immediately and after cold restart!
  const forgot = await act({ action: 'forget', source: 'manual', erase: true })
  assert.equal(forgot.status, 200)
  const afterErase = (await req('/api/career-agent/state', null, 'GET')).data
  assert.equal(afterErase.evidence.length, 0)
  assert.equal(afterErase.discoveryDirections, null)
  assert.equal(JSON.stringify(afterErase.discoveryDirections ?? {}).includes(privateTitle), false)
  assert.equal(afterErase.marketRadar.reports.target, null)

  await dispose?.()
  await apply(ctx)
  const afterRestart = (await req('/api/career-agent/state', null, 'GET')).data
  assert.equal(afterRestart.evidence.length, 0)
  assert.equal(afterRestart.discoveryDirections, null)
  assert.equal(JSON.stringify(afterRestart.discoveryDirections ?? {}).includes(privateTitle), false)
  assert.equal(afterRestart.marketRadar.reports.target, null)
})

test('privacy: auto market insight never sends unapproved autosaved draft (still analyzes JDs), and only runs when board patrol is enabled', async t => {
  const { buildAutoIntelTogglePatch, buildBoardsTogglePatch } = await import('../src/automation-toggles.mjs')
  const draftMarker = 'SYNTH-UNAPPROVED-AUTOSAVE-3041'
  const origFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (!String(url).includes('boards-api.greenhouse.io/v1/boards/acme-draft-check/jobs')) {
      throw new Error(`Unexpected fetch: ${url}`)
    }
    return Response.json({
      jobs: Array.from({ length: 4 }, (_, i) => ({
        id: 9100 + i,
        title: `Platform Infra Engineer ${i}`,
        location: { name: 'Remote' },
        absolute_url: `https://job-boards.greenhouse.io/acme-draft-check/jobs/${9100 + i}`,
        updated_at: new Date().toISOString(),
        content: '<p>Platform infrastructure, Kubernetes scheduling, observability, distributed systems, and cloud reliability.</p>',
      })),
    })
  }
  t.after(() => { globalThis.fetch = origFetch })

  const runScenario = async ({ enableBoard }) => {
    const dir = await mkdtemp(join(tmpdir(), `career-patrol-gate-${enableBoard ? 'board' : 'autojd'}-`))
    const captured = []
    const harness = createFetchHarness()
    let dispose
    const ctx = {
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: {
        listSessions: async () => [],
        readTitleSnapshots: async () => [],
        readSession: async () => { throw new Error('no session') },
      },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'audit', name: 'Audit' }],
        resolveModelInfo: async () => ({ provider: 'mock', id: 'audit', name: 'Audit' }),
        prepareCall: async () => ({
          stream: async function* (request) {
            const raw = JSON.stringify(request)
            const input = JSON.parse(request.messages[0].content[0].text)
            const kind = raw.includes('recentWorkEvidence') ? 'market' : 'other'
            captured.push({
              kind,
              hasDraftMarker: raw.includes(draftMarker),
              candidateResume: kind === 'market' ? input.candidateResume : undefined,
              jdCount: kind === 'market' ? input.stats?.jdCount : undefined,
            })
            const text = kind === 'market'
              ? JSON.stringify({ headline: 'synth market', hotTrends: [{ title: 'infra', heat: 'surging', signal: 'K8s' }], personalAlignment: { verdict: 'jd-only ok' } })
              : JSON.stringify({ items: [] })
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      },
      get: () => undefined,
      on() {},
      emit() {},
      provide() {},
      effect(fn) { dispose = fn() },
    }
    await apply(ctx)
    t.after(async () => {
      await dispose?.()
      await rm(dir, { recursive: true, force: true })
    })
    const req = (url, body, method = 'POST') => harness.call(method, url, body)
    const act = body => req('/api/career-agent/action', body)
    const getState = async () => (await req('/api/career-agent/state', null, 'GET')).data

    await act({ action: 'configure', config: { mode: 'off', sendToModel: false, watchSessions: false, autoJobIntel: false, model: 'mock:audit', tabModel: 'mock:audit', locale: 'zh' } })
    const imp = await act({ action: 'resume-import', title: 'Draft Only', text: '# Draft Candidate\n\n## Experience\n- Initial' })
    const rev = await act({ action: 'resume-revise', id: imp.data.result.id, autoSaved: true, text: `# Draft Candidate\n\n## Experience\n- ${draftMarker}` })
    assert.equal(rev.data.result.status, 'pending')
    assert.equal(rev.data.result.autoSaved, true)

    await act({ action: 'configure', config: { boards: [{ provider: 'greenhouse', slug: 'acme-draft-check', company: 'Acme Draft' }] } })
    const st0 = await getState()
    const togglePatch = enableBoard ? buildBoardsTogglePatch(st0, true) : buildAutoIntelTogglePatch(st0, true)
    await act({ action: 'configure', config: togglePatch })

    const pulled = await act({ action: 'run', scope: 'boards' })
    assert.equal(pulled.status, 200)
    if (enableBoard) {
      for (let i = 0; i < 60 && !captured.some(c => c.kind === 'market'); i += 1) {
        await new Promise(r => setTimeout(r, 20))
      }
    } else {
      await new Promise(r => setTimeout(r, 150))
    }
    return { pulled: pulled.data.result, captured, act, getState }
  }

  // Case 1: Board patrol ON, no approved master resume -> auto market insight runs on JDs with empty candidateResume (no draft leak!)
  const case1 = await runScenario({ enableBoard: true })
  assert.equal(case1.pulled.insightStatus, 'updating')
  const autoMarket = case1.captured.find(c => c.kind === 'market')
  assert.ok(autoMarket, 'auto market insight should still analyze JDs when board patrol is enabled without an approved resume')
  assert.equal(autoMarket.hasDraftMarker, false, 'autosaved pending draft must never leak into market insight')
  assert.equal(autoMarket.candidateResume, '', 'candidateResume must be empty when no approved master resume exists')
  assert.equal(autoMarket.jdCount, 4)

  // Case 2: Board patrol OFF, only autoJobIntel ON -> clicking "立即拉取" must NOT start auto market insight; manual generation still works!
  const case2 = await runScenario({ enableBoard: false })
  assert.equal(case2.pulled.insightStatus, 'disabled')
  assert.equal(case2.captured.some(c => c.kind === 'market'), false, 'auto market insight must NOT trigger when board patrol is off (autoJobIntel only)')
  assert.equal(case2.captured.length, 0, 'no background model calls should fire when board patrol is off')

  // Active/manual report generation still works even when board patrol is off (and still never leaks pending draft)
  const manual = await case2.act({ action: 'market-insight', scope: 'target', force: true })
  assert.equal(manual.status, 200)
  const manualMarket = case2.captured.find(c => c.kind === 'market')
  assert.ok(manualMarket, 'manual market-insight generation must still work when board patrol is off')
  assert.equal(manualMarket.hasDraftMarker, false, 'manual market insight must also exclude unapproved draft')
  assert.equal(manualMarket.candidateResume, '')
})

test('extractJobMarketFeatures refreshes cached skills on equal-length JD updates with same id and verifiedAt', () => {
  const first = extractJobMarketFeatures({
    id: 'same-job-1',
    title: 'Backend Engineer',
    location: '上海',
    jd: 'Responsible for distributed backend services written in Python and SQL.',
    verifiedAt: null,
  })
  assert.equal(first.skillIds.has('python'), true)
  assert.equal(first.skillIds.has('golang'), false)

  const updated = extractJobMarketFeatures({
    id: 'same-job-1',
    title: 'Backend Engineer',
    location: '上海',
    jd: 'Responsible for distributed backend services written in Golang and SQL.',
    verifiedAt: null,
  })
  assert.equal(updated.skillIds.has('golang'), true)
  assert.equal(updated.skillIds.has('python'), false)
})
