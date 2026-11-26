import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CareerStore } from '../src/career.mjs'
import { apply } from '../src/host.mjs'
import {
  buildEvalBasisMeta,
  createHostTriageController,
  sortOpportunitiesForView,
} from '../src/host-triage.mjs'
import {
  buildPatrolSearchProfile,
  scoreOpportunityHeuristic,
} from '../src/job-triage.mjs'
import { tierForScore } from '../src/triage-heuristic.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'

test('triage-heuristic preserves tier thresholds and deterministic scoring via job-triage wrapper', () => {
  assert.equal(tierForScore(78), 'top')
  assert.equal(tierForScore(77), 'good')
  assert.equal(tierForScore(64), 'good')
  assert.equal(tierForScore(63), 'stretch')
  assert.equal(tierForScore(46), 'stretch')
  assert.equal(tierForScore(45), 'skip')

  const profile = buildPatrolSearchProfile({
    goal: '后端工程师，上海，不要外包',
    searchTerms: ['Go', '分布式'],
    resumeText: '5年 Go 分布式微服务研发经验',
  })
  const fit = scoreOpportunityHeuristic({
    id: 'h-1',
    title: 'Go 后端工程师',
    company: 'Alpha',
    location: '上海',
    jd: '负责 Go 分布式存储系统核心研发。',
  }, profile, 'zh')
  assert.equal(fit.mode, 'heuristic')
  assert.ok(fit.score >= 70)
  assert.ok(['top', 'good'].includes(fit.tier))

  const excluded = scoreOpportunityHeuristic({
    id: 'h-2',
    title: '驻场外包 Go 开发工程师',
    company: 'Beta',
    location: '上海',
    jd: '本岗位为外包岗位。',
  }, profile, 'zh')
  assert.equal(excluded.tier, 'skip')
  assert.ok(excluded.score < 46)
})

test('buildEvalBasisMeta handles goal-only and default resume track metadata', () => {
  assert.deepEqual(buildEvalBasisMeta({ resumes: [] }, null, 'zh'), { kind: 'goal' })

  const core = {
    defaultMasterTrackId: 'track-main',
    resumes: [
      { id: 'r1', kind: 'general', trackId: 'track-main', trackTitle: '通用AI研发', status: 'approved', versionTag: 'v3', updatedAt: '2026-11-20T00:00:00Z' },
    ],
  }
  const basis = buildEvalBasisMeta(core, core.resumes[0], 'zh')
  assert.equal(basis.kind, 'resume')
  assert.equal(basis.id, 'r1')
  assert.equal(basis.title, '通用AI研发')
  assert.equal(basis.isDefault, true)
})

test('sortOpportunitiesForView orders zones (rubric_v2 tiers -> pending BM25F -> missing_jd) deterministically', () => {
  const profile = buildPatrolSearchProfile({
    goal: 'Technical Artist',
    searchTerms: ['Technical Artist', 'Shader', 'UE5'],
    resumeText: 'Technical Artist specializing in UE5 shaders and HLSL pipelines.',
  })
  const mappedJobs = [
    {
      id: 'missing-1',
      title: 'Technical Artist',
      company: 'Studio D',
      location: 'Shanghai',
      jd: '',
      receiptCount: 0,
      stage: 'new',
      match: { zone: 'missing_jd', tier: 'stretch', score: 50 },
    },
    {
      id: 'pending-low',
      title: 'Account Executive',
      company: 'Studio C',
      location: 'Shanghai',
      jd: 'Own outbound B2B enterprise sales pipeline and quarterly revenue quotas.',
      verifiedAt: '2026-11-20T00:00:00Z',
      receiptCount: 0,
      stage: 'new',
      match: { zone: 'pending_local', tier: 'skip', score: 20 },
    },
    {
      id: 'pending-high',
      title: 'Rendering Technical Artist',
      company: 'Studio B',
      location: 'Shanghai',
      jd: 'Build UE5 shader libraries, HLSL materials, and lookdev pipelines with graphics engineers.',
      verifiedAt: '2026-11-19T00:00:00Z',
      receiptCount: 0,
      stage: 'new',
      match: { zone: 'pending_local', tier: 'good', score: 70 },
    },
    {
      id: 'eval-top',
      title: 'Senior Technical Artist',
      company: 'Studio A',
      location: 'Shanghai',
      jd: 'Lead UE5 shader and rendering pipeline architecture.',
      verifiedAt: '2026-11-18T00:00:00Z',
      receiptCount: 0,
      stage: 'new',
      match: { zone: 'rubric_v2', tier: 'top', score: 92 },
    },
  ]

  const sorted = sortOpportunitiesForView({
    mappedJobs,
    patrolProfile: profile,
    feedbackMap: {},
    isTrackedJob: job => job.receiptCount > 0,
    isOpenListing: () => true,
    stageRank: () => 1,
  })
  assert.deepEqual(sorted.map(j => j.id), ['eval-top', 'pending-high', 'pending-low', 'missing-1'])
})

test('createHostTriageController guards empty targets, confirmation tokens, and lifecycle state', async () => {
  const control = {
    config: { sendToModel: false, boards: [], searchTerms: [], goal: '' },
    opportunities: [],
    jobMatches: {},
    jobFeedback: {},
    receipts: [],
  }
  const triage = createHostTriageController({
    ctx: { llm: null },
    store: { summary: async () => ({ mode: 'search', resumes: [], evidence: [], sources: [] }), exportResume: async () => '' },
    getControl: () => control,
    isClosed: () => false,
    getRevision: () => 0,
    activeLocale: () => 'zh',
    defaultModelRoute: async () => '',
    llmCallConfig: cfg => cfg,
    ensureOpportunityJd: async () => ({}),
    canFetchOpportunityDetail: () => false,
    exclusive: fn => fn(),
    commit: async () => {},
    publish: () => {},
    resumeFor: () => null,
    indexByOpportunity: () => new Map(),
    boardSourceId: b => String(b?.id || ''),
  })

  assert.equal(triage.isRunning(), false)
  await triage.whenIdle()
  triage.clearPreviews()
  triage.resetCooldown()
  triage.abort()

  const emptyPreview = await triage.handleTriagePreviewAction({ targetJobIds: [] }, 'zh')
  assert.equal(emptyPreview.count, 0)
  assert.equal(emptyPreview.confirmToken, '')

  await assert.rejects(() => Promise.resolve().then(() => triage.handleTriagePreviewAction({ id: '   ' }, 'zh')), TypeError)

  const emptyRun = await triage.handleTriageJobsAction({ targetJobIds: [] }, 'zh')
  assert.equal(emptyRun.skipped, true)
  assert.equal(emptyRun.emptyTarget, true)

  const unconfirmedRun = await triage.handleTriageJobsAction({ confirmed: true, confirmToken: 'missing-token' }, 'zh')
  assert.equal(unconfirmedRun.skipped, true)
  assert.equal(unconfirmedRun.requiresConfirmation, true)
  assert.equal(unconfirmedRun.staleConfirmation, true)
})

test('triage preview and confirmed execution read live control across async resume export awaits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-host-triage-live-ctrl-'))
  const origExportResume = CareerStore.prototype.exportResume
  let dispose
  let pendingGate = null
  let pendingEntered = null

  t.after(async () => {
    CareerStore.prototype.exportResume = origExportResume
    pendingGate?.resolve()
    try {
      if (typeof dispose === 'function') await dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  let llmCalls = 0
  const harness = createFetchHarness()
  const action = async payload => {
    const res = await harness.call('POST', '/api/career-agent/action', payload)
    assert.equal(res.status, 200)
    return res.json.result
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
          model: { provider: 'mock', id: 'fast-v2' },
          async *stream() {
            yield { type: 'text-delta', text: '{"items":[]}' }
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
    text: '# Candidate\n\n## Experience\n- Built AI Infra GPU serving and scheduling clusters.',
  })
  await action({ action: 'resume-review', id: imp.id, decision: 'approve' })
  await action({
    action: 'configure',
    config: { mode: 'search', sendToModel: false, model: 'mock:fast-v1', goal: 'AI Infra', searchTerms: ['AI Infra'] },
  })
  const added = await action({
    action: 'job-add',
    job: {
      company: 'LiveControlCo',
      title: 'AI Infra Engineer',
      location: 'Shanghai',
      url: 'https://example.com/jobs/101',
      jd: 'Initial JD: build GPU inference serving platform.',
    },
  })
  assert.ok(added?.id)

  const armExportPause = () => {
    pendingEntered = Promise.withResolvers()
    pendingGate = Promise.withResolvers()
    const gate = pendingGate
    const entered = pendingEntered
    CareerStore.prototype.exportResume = async function wrappedExport(id) {
      CareerStore.prototype.exportResume = origExportResume
      entered.resolve()
      await gate.promise
      return origExportResume.call(this, id)
    }
    return { gate, entered }
  }

  // (a) Model switch while preview waits on store.exportResume discloses the live switched model
  const previewPause = armExportPause()
  const previewReq = action({ action: 'triage-preview', id: added.id })
  await previewPause.entered.promise
  await action({ action: 'configure', config: { model: 'mock:fast-v2' } })
  previewPause.gate.resolve()
  const previewRes = await previewReq
  assert.equal(previewRes.model, 'mock:fast-v2')
  assert.equal(previewRes.count, 1)
  assert.ok(previewRes.confirmToken)

  // (b) JD update via job-add while confirmed execution waits on store.exportResume invalidates disclosed fingerprint
  const runPause = armExportPause()
  const confirmReq = action({ action: 'triage-jobs', confirmed: true, confirmToken: previewRes.confirmToken })
  await runPause.entered.promise
  await action({
    action: 'job-add',
    job: {
      company: 'LiveControlCo',
      title: 'AI Infra Engineer',
      location: 'Shanghai',
      url: 'https://example.com/jobs/101',
      jd: 'Updated JD: own kernel-level CUDA graph scheduling and multi-node NCCL optimization.',
    },
  })
  runPause.gate.resolve()
  const confirmRes = await confirmReq
  assert.equal(confirmRes.skipped, true)
  assert.equal(confirmRes.emptyTarget, true)
  assert.equal(confirmRes.llmScoredCount, 0)
  assert.equal(llmCalls, 0)

  const state = (await harness.call('GET', '/api/career-agent/state')).json
  const updatedOpp = state.opportunities.find(o => o.id === added.id)
  assert.ok(updatedOpp.jd.includes('Updated JD'))
  assert.equal(updatedOpp.match.zone, 'pending_local')
})

test('host dispose completes promptly without waiting on hung listModels and leaves no late writes or calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-host-triage-dispose-fast-'))
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  let gate = Promise.withResolvers()
  let listModelsEntered = Promise.withResolvers()
  let dispose
  let disposed = false

  t.after(async () => {
    try {
      if (typeof dispose === 'function' && !disposed) {
        disposed = true
        await dispose()
      }
    } finally {
      gate.resolve()
      await rm(dir, { recursive: true, force: true })
    }
  })

  let llmCalls = 0
  const harness = createFetchHarness()
  const action = async payload => {
    const res = await harness.call('POST', '/api/career-agent/action', payload)
    assert.equal(res.status, 200)
    return res.json.result
  }

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => null,
      listModels: async () => {
        listModelsEntered.resolve()
        await gate.promise
        return [{ id: 'fast', context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }]
      },
      prepareCall: async () => {
        llmCalls += 1
        return {
          model: { provider: 'mock', id: 'fast' },
          async *stream() {
            yield { type: 'text-delta', text: '{"items":[]}' }
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

  await action({
    action: 'configure',
    config: { mode: 'search', sendToModel: true, model: 'mock:fast', goal: 'AI Infra', searchTerms: ['AI Infra'] },
  })
  const added = await action({
    action: 'job-add',
    job: {
      company: 'MockAcme',
      title: 'AI Infra Engineer',
      location: 'Shanghai',
      url: 'https://example.com/jobs/901',
      jd: 'Responsible for distributed training infrastructure and Kubernetes scheduling.',
    },
  })
  assert.ok(added?.id)

  const triageReq = action({
    action: 'triage-jobs',
    id: added.id,
  })
  await listModelsEntered.promise

  const disposeStart = Date.now()
  disposed = true
  await Promise.race([
    dispose(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispose exceeded 150ms budget while listModels hung')), 150)),
  ])
  assert.ok(Date.now() - disposeStart < 150)

  gate.resolve()
  const triageRes = await triageReq
  assert.equal(triageRes.triagedCount, 0)
  assert.equal(llmCalls, 0)
  await new Promise(r => setTimeout(r, 30))

  const disk = JSON.parse(await readFile(controlPath, 'utf8'))
  assert.equal(Object.keys(disk.jobMatches ?? {}).length, 0)
})

test('sortOpportunitiesForView sinks evaluated skip roles below positive legacy_v1 and pending_local roles', () => {
  const profile = buildPatrolSearchProfile({
    goal: 'AI Infra 平台研发工程师',
    searchTerms: ['AI Infra', 'Kubernetes', 'GPU'],
    resumeText: '6 年分布式系统与 GPU 推理平台研发经验。',
  })
  const mappedJobs = [
    {
      id: 'v2-skip-pm',
      title: 'AI 产品经理',
      company: 'DeepSeek',
      location: '北京',
      jd: '负责 AI 产品规划与生态增长。',
      verifiedAt: '2026-11-26T07:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'rubric_v2', tier: 'skip', score: 25, rubric: { D: 0, E: 1, L: 'unknown' } },
    },
    {
      id: 'legacy-top',
      title: 'GPU 调度研发工程师',
      company: 'MiniMax',
      location: '北京',
      jd: '负责 Kubernetes 与大规模 GPU 调度平台研发。',
      verifiedAt: '2026-11-25T07:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'legacy_v1', tier: 'top', score: 92 },
    },
    {
      id: 'legacy-good',
      title: 'AI 平台开发工程师',
      company: '米哈游',
      location: '上海',
      jd: '负责训练与推理平台工程建设。',
      verifiedAt: '2026-11-25T06:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'legacy_v1', tier: 'good', score: 78 },
    },
    {
      id: 'pending-ready',
      title: '大模型推理引擎工程师',
      company: '月之暗面',
      location: '北京',
      jd: '负责 KV Cache 调度与 Kubernetes GPU 推理性能优化。',
      verifiedAt: '2026-11-25T05:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'pending_local', tier: 'good', score: 70 },
    },
    {
      id: 'v2-top',
      title: 'Agent 弹性计算研发工程师',
      company: 'DeepSeek',
      location: '北京',
      jd: '负责 Agent 沙箱与管控面研发。',
      verifiedAt: '2026-11-26T06:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'rubric_v2', tier: 'top', score: 95, rubric: { D: 3, E: 3, L: 3 } },
    },
    {
      id: 'legacy-skip',
      title: '行政专员',
      company: 'OtherCo',
      location: '北京',
      jd: '负责日常行政办公与采购。',
      verifiedAt: '2026-11-25T04:00:00Z',
      receiptCount: 0,
      stage: 'discovered',
      match: { zone: 'legacy_v1', tier: 'skip', score: 15 },
    },
  ]

  const sorted = sortOpportunitiesForView({
    mappedJobs,
    patrolProfile: profile,
    feedbackMap: {},
    isTrackedJob: job => job.receiptCount > 0,
    isOpenListing: () => true,
    stageRank: () => 1,
  })
  assert.deepEqual(
    sorted.map(j => j.id),
    ['v2-top', 'legacy-top', 'legacy-good', 'pending-ready', 'v2-skip-pm', 'legacy-skip'],
  )
})


test('mergeBoards drops zero-overlap patrol noise, closes >=14d unseen unprotected domestic jobs, protects user/positive jobs, and reopens re-sighted jobs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-host-merge-noise-'))
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const origFetch = globalThis.fetch
  let resightClosed = false
  globalThis.fetch = async url => {
    if (String(url).includes('zhaopin.jd.com/web/job/job_list')) {
      const list = [
        { reqNumber: 'NEWZERO', positionNameOpen: '买手', workCity: '北京', workContent: '负责服饰选品采购', qualification: '1年以上零售经验' },
        { reqNumber: 'NEWHIT', positionNameOpen: 'GPU调度平台工程师', workCity: '北京', workContent: '负责 GPU调度 与容器集群建设', qualification: '熟悉 Kubernetes' },
      ]
      if (resightClosed) {
        list.push({ reqNumber: 'OLDCLOSED', positionNameOpen: 'Kubernetes 调度研发', workCity: '上海', workContent: '负责 Kubernetes 资源调度', qualification: '3年以上' })
      }
      return Response.json(list)
    }
    return new Response('unexpected url: ' + url, { status: 404 })
  }
  t.after(() => { globalThis.fetch = origFetch })

  const h0 = createFetchHarness()
  let dispose0
  await apply({
    profileContext: { dir },
    connection: h0.connection,
    llm: null,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose0 = fn() },
  })
  await h0.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: false,
      goal: '上海 / 北京 AI 基础设施工程师',
      searchTerms: ['GPU调度', 'Kubernetes'],
      boards: [{ provider: 'jd', slug: 'social', company: '京东', label: '京东' }],
    },
  })
  await dispose0()

  const staleIso = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString()
  const recentIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const ctrl = JSON.parse(await readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(
    { id: 'jd:social:OLDUNSEEN', sourceId: 'jd:social', provider: 'jd', externalId: 'OLDUNSEEN', company: '京东', title: '旧硬件工程师', location: '北京', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责硬件设计', firstSeenAt: staleIso, verifiedAt: staleIso },
    { id: 'jd:social:RECENT', sourceId: 'jd:social', provider: 'jd', externalId: 'RECENT', company: '京东', title: '近期后端工程师', location: '北京', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责后端服务', firstSeenAt: recentIso, verifiedAt: recentIso },
    { id: 'jd:social:PROTRCT', sourceId: 'jd:social', provider: 'jd', externalId: 'PROTRCT', company: '京东', title: '受保护回执岗', location: '北京', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责系统研发', firstSeenAt: staleIso, verifiedAt: staleIso },
    { id: 'jd:social:PROTFB', sourceId: 'jd:social', provider: 'jd', externalId: 'PROTFB', company: '京东', title: '受保护反馈岗', location: '北京', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责系统研发', firstSeenAt: staleIso, verifiedAt: staleIso },
    { id: 'jd:social:PROTLLM', sourceId: 'jd:social', provider: 'jd', externalId: 'PROTLLM', company: '京东', title: '受保护正向LLM岗', location: '北京', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责GPU调度', firstSeenAt: staleIso, verifiedAt: staleIso },
    { id: 'jd:social:OLDCLOSED', sourceId: 'jd:social', provider: 'jd', externalId: 'OLDCLOSED', company: '京东', title: 'Kubernetes 调度研发', location: '上海', url: 'https://zhaopin.jd.com/web/job/job_info_list/3', jd: '负责 Kubernetes 资源调度', firstSeenAt: staleIso, verifiedAt: staleIso, closedAt: staleIso },
  )
  ;(ctrl.receipts ||= []).push({ id: 'rcpt-1', opportunityId: 'jd:social:PROTRCT', type: 'opened', source: 'user', occurredAt: staleIso })
  ;(ctrl.jobFeedback ||= {})['jd:social:PROTFB'] = { status: 'saved', updatedAt: staleIso }
  ;(ctrl.jobMatches ||= {})['jd:social:PROTLLM'] = { opportunityId: 'jd:social:PROTLLM', mode: 'llm', zone: 'rubric_v2', tier: 'good', score: 80, rubric: { D: 3, E: 2, L: 3 } }
  await writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const h1 = createFetchHarness()
  let dispose1
  t.after(async () => { if (typeof dispose1 === 'function') await dispose1() })
  await apply({
    profileContext: { dir },
    connection: h1.connection,
    llm: null,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose1 = fn() },
  })

  const scan1 = await h1.call('POST', '/api/career-agent/action', { action: 'run', scope: 'boards' })
  assert.equal(scan1.status, 200)
  const after1 = JSON.parse(await readFile(controlPath, 'utf8'))
  const byId1 = new Map(after1.opportunities.map(o => [o.id, o]))

  assert.equal(byId1.has('jd:social:NEWZERO'), false, 'Zero-overlap incoming noise must be dropped before insertion')
  assert.equal(byId1.has('jd:social:NEWHIT'), true, 'Relevant incoming posting must be admitted')
  assert.ok(byId1.get('jd:social:OLDUNSEEN').closedAt, '>=14d unseen unprotected domestic job must be closed')
  assert.equal(byId1.get('jd:social:RECENT').closedAt, undefined, 'Recently seen domestic job must stay open')
  assert.equal(byId1.get('jd:social:PROTRCT').closedAt, undefined, 'Receipt-linked job must stay protected')
  assert.equal(byId1.get('jd:social:PROTFB').closedAt, undefined, 'Feedback-linked job must stay protected')
  assert.equal(byId1.get('jd:social:PROTLLM').closedAt, undefined, 'Positive LLM job must stay protected')
  assert.ok(byId1.get('jd:social:OLDCLOSED').closedAt, 'Still-unseen closed job stays closed')

  // When an old closed domestic job re-appears in a live scan, closedAt clears cleanly
  resightClosed = true
  const scan2 = await h1.call('POST', '/api/career-agent/action', { action: 'run', scope: 'boards' })
  assert.equal(scan2.status, 200)
  const after2 = JSON.parse(await readFile(controlPath, 'utf8'))
  const reopened = after2.opportunities.find(o => o.id === 'jd:social:OLDCLOSED')
  assert.equal(reopened.closedAt, undefined, 'Re-sighted previously closed domestic job must reopen automatically')
})


test('mergeBoards preserves nonempty jdPreview, skips partial international feeds from 14d TTL, and discards in-flight patrol after config change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-host-p1-patrol-'))
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const origFetch = globalThis.fetch
  let gate = Promise.withResolvers()
  let requestEntered = Promise.withResolvers()
  let mockPhase = 'preview-and-partial'
  globalThis.fetch = async url => {
    const u = String(url)
    if (u.includes('ats.openout.mihoyo.com/ats-portal/v1/job/list')) {
      return Response.json({
        code: 0,
        data: {
          list: [{ id: '9001', title: '特别项目专员', addressDetailList: [{ addressDetail: '上海' }], jobSummary: '负责日常沟通协调' }],
        },
      })
    }
    if (u.includes('ats.openout.mihoyo.com/ats-portal/v1/job/info')) {
      return Response.json({ code: 500 }, { status: 500 })
    }
    if (u.includes('boards-api.greenhouse.io/v1/boards/anthropic/jobs')) {
      return Response.json({
        jobs: [
          { id: 1001, title: 'GPU Kernel Engineer', location: { name: 'San Francisco' }, content: '<p>CUDA GPU调度</p>' },
          { id: 1002, title: 'Intern Engineer', location: { name: 'San Francisco' }, content: '<p>Summer internship</p>' },
        ],
      })
    }
    if (u.includes('zhaopin.jd.com/web/job/job_list')) {
      if (mockPhase === 'race') {
        requestEntered.resolve()
        await gate.promise
        return Response.json([
          { reqNumber: 'K8SJ', positionNameOpen: 'Kubernetes 工程师', workCity: '北京', workContent: 'K8s 集群开发', qualification: '3年' },
          { reqNumber: 'PYJ', positionNameOpen: 'Python 后端工程师', workCity: '北京', workContent: 'Python 微服务开发', qualification: '3年' },
        ])
      }
      return Response.json([])
    }
    return new Response('unexpected url: ' + u, { status: 404 })
  }
  t.after(() => { globalThis.fetch = origFetch })

  const h0 = createFetchHarness()
  let dispose0
  await apply({
    profileContext: { dir },
    connection: h0.connection,
    llm: null,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose0 = fn() },
  })
  await h0.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: false,
      goal: '上海 AI Infra 工程师',
      searchTerms: ['GPU调度'],
      boards: [
        { provider: 'mihoyo', slug: 'social', company: '米哈游', label: '米哈游' },
        { provider: 'greenhouse', slug: 'anthropic', company: 'Anthropic', label: 'Anthropic' },
      ],
    },
  })
  await dispose0()

  const staleIso = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString()
  const ctrl = JSON.parse(await readFile(controlPath, 'utf8'))
  ctrl.config.boards = [
    { provider: 'mihoyo', slug: 'social', company: '米哈游', label: '米哈游' },
    { provider: 'greenhouse', slug: 'anthropic__experienced', company: 'Anthropic', label: 'Anthropic' },
  ]

  const origFetch2 = globalThis.fetch
  const oversizedBuf = new Uint8Array(8 * 1024 * 1024 + 32)
  globalThis.fetch = async url => {
    const u = String(url)
    if (u.includes('boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true')) {
      return new Response(oversizedBuf, { headers: { 'content-type': 'application/json' } })
    }
    return origFetch2(url)
  }

  ctrl.opportunities.push({
    id: 'greenhouse:anthropic__experienced:99999', sourceId: 'greenhouse:anthropic__experienced', provider: 'greenhouse', externalId: '99999',
    company: 'Anthropic', title: 'GPU Infra Engineer', location: 'San Francisco', url: 'https://job-boards.greenhouse.io/anthropic/jobs/99999',
    jd: 'CUDA & GPU', firstSeenAt: staleIso, verifiedAt: staleIso,
  })
  await writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const h1 = createFetchHarness()
  let dispose1
  t.after(async () => { try { await dispose1?.() } finally {} })
  await apply({
    profileContext: { dir },
    connection: h1.connection,
    llm: null,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose1 = fn() },
  })

  const scan1 = await h1.call('POST', '/api/career-agent/action', { action: 'run', scope: 'boards' })
  assert.equal(scan1.status, 200)
  const after1 = JSON.parse(await readFile(controlPath, 'utf8'))
  const mihoyoPreview = after1.opportunities.find(o => o.id === 'mihoyo:social:9001')
  const staleIntl = after1.opportunities.find(o => o.id === 'greenhouse:anthropic__experienced:99999')
  assert.ok(mihoyoPreview, 'Non-empty jdPreview excerpt with 0 BM25F overlap must NOT be dropped before hydration')
  assert.equal(mihoyoPreview.jdPreview, true)
  assert.equal(staleIntl.closedAt, undefined, 'Partial international board (non-CN_PROVIDERS) must NOT be closed by domestic 14d TTL')

  // In-flight patrol invalidated cleanly when searchTerms/goal change mid-flight
  await h1.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { goal: '北京 Kubernetes', searchTerms: ['Kubernetes'], boards: [{ provider: 'jd', slug: 'social', company: '京东', label: '京东' }] },
  })
  mockPhase = 'race'
  const patrolReq = h1.call('POST', '/api/career-agent/action', { action: 'run', scope: 'boards' })
  await requestEntered.promise
  await h1.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { goal: '北京 Python 后端', searchTerms: ['Python'], boards: [{ provider: 'jd', slug: 'social', company: '京东', label: '京东' }] },
  })
  gate.resolve()
  await patrolReq
  const afterRace = JSON.parse(await readFile(controlPath, 'utf8'))
  assert.equal(afterRace.opportunities.some(o => o.externalId === 'K8SJ'), false, 'Superseded in-flight patrol must not admit old-query results')
  assert.equal(afterRace.opportunities.some(o => o.externalId === 'PYJ'), false, 'Superseded in-flight patrol must not commit stale merge')
})
