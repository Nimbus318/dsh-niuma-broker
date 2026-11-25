import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
