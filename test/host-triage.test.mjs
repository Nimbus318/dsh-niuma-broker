import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('host dispose awaits in-flight triage settle without hanging or post-dispose writes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-host-triage-dispose-'))
  let gate = Promise.withResolvers()
  const origFetch = globalThis.fetch
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
      globalThis.fetch = origFetch
      await rm(dir, { recursive: true, force: true })
    }
  })
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://boards-api.greenhouse.io/v1/boards/acme/jobs/')) {
      await gate.promise
      return new Response(JSON.stringify({ content: 'Distributed training infrastructure and Kubernetes scheduling.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return origFetch(url)
  }

  const fs = await import('node:fs/promises')
  const harness = createFetchHarness()
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: { listProviders: () => [], resolveModelInfo: async () => null, prepareCall: async () => { throw new Error('unused') } },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { mode: 'search', sendToModel: false, goal: 'AI Infra' },
  })
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push({
    id: 'oneoff:dispose-901',
    externalId: '901',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'MockAcme',
    title: 'AI Infra Engineer',
    location: 'Shanghai',
    jd: '',
    oneOff: true,
  })
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  // Preview starts hydration; direct force run also triggers ensureOpportunityJd under mock:fast when sendToModel is off? Turn sendToModel on for direct run.
  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { mode: 'search', sendToModel: true },
  })
  const triageReq = harness.call('POST', '/api/career-agent/action', {
    action: 'triage-jobs',
    force: true,
    limit: 5,
  })
  await new Promise(r => setTimeout(r, 30))

  await Promise.race([
    (async () => {
      disposed = true
      await dispose()
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('dispose hung waiting on triage.whenIdle()')), 1000)),
  ])
  const triageRes = await triageReq
  assert.equal(triageRes.status, 200)
  assert.equal(triageRes.json.result.triagedCount, 0)
  gate.resolve()
})
