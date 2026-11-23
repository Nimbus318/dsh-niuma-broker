import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'

import { apply } from '../src/host.mjs'
import {
  attachStagedReviewProvenance, buildUnifiedPlaybackSteps, computeReviewableLineChanges,
  rebaseReviewDecisions, resolveAcceptedReviewEvidenceIds, suggestEvidencePlacement,
} from '../src/resume-diff.mjs'
import { organizeResumeVersions } from '../src/resume-versions.mjs'

async function createHost({ dir, llm, sessionQuery, captureTimer = false }) {
  const harness = createFetchHarness()
  let dispose
  const listeners = new Map()
  let timerCallback = null
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  if (captureTimer) {
    globalThis.setInterval = (fn) => {
      timerCallback = fn
      return { unref() {} }
    }
    globalThis.clearInterval = () => {}
  }
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: sessionQuery ?? {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    get() {},
    on(eventName, fn) {
      const list = listeners.get(eventName) ?? []
      list.push(fn)
      listeners.set(eventName, list)
    },
    emit() {},
    provide(key, value) { if (key === 'careerBroker') this.broker = value },
    effect(fn) { dispose = fn() },
  }
  try {
    await apply(ctx)
  } finally {
    if (captureTimer) {
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
    }
  }

  const request = (method, url, body = null, extraHeaders = {}) => harness.call(method, url, body, extraHeaders)

  return {
    request,
    state: async () => (await request('GET', '/api/career-agent/state')).json,
    action: (actionName, more = {}, hdrs = {}) => request('POST', '/api/career-agent/action', { action: actionName, ...more }, hdrs),
    emitSessionEvent: (session, event) => {
      for (const fn of listeners.get('session/event') ?? []) fn(session, event)
    },
    fireBackgroundTimer: async () => {
      if (timerCallback) timerCallback()
      await new Promise(resolve => setTimeout(resolve, 120))
    },
    close: () => dispose?.(),
  }
}

test('Blocker 1: jobs board fetch (scope=boards) never reads work sessions, cursors, or calls distill LLM; library distill (scope=sessions) distills authorized session without fetching boards', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-blocker1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const marker = 'SYNTHETIC_WORK_MARKER_GRAY_ROLLOUT_8842'
  let sessionListCalls = 0
  let sessionReadCalls = 0
  let boardFetchCalls = 0
  const distillCalls = []

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('boards-api.greenhouse.io/v1/boards/acme-synth/jobs')) {
      boardFetchCalls += 1
      return new Response(JSON.stringify({
        jobs: [
          {
            id: 1001,
            title: 'Staff Distributed Systems Engineer',
            location: { name: 'Remote' },
            absolute_url: 'https://job-boards.greenhouse.io/acme-synth/jobs/1001',
            updated_at: '2026-11-21T10:00:00Z',
            content: '<p>Build resilient distributed control planes in Go and Kubernetes.</p>',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, opts)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const sessionQuery = {
    async listSessions() {
      sessionListCalls += 1
      return [{ header: { id: 'sess-synth-1', origin: null } }]
    },
    async readTitleSnapshots() { return [] },
    async readSession(id) {
      sessionReadCalls += 1
      return {
        session: { id, origin: null },
        events: [
          {
            seq: 1,
            type: 'user/message',
            time: Date.now() - 60_000,
            data: {
              source: { kind: 'user' },
              content: [{ type: 'text', text: `今天完成了核心网关重构并${marker}，把 P99 延迟从 220ms 降到 68ms，已经上线灰度组。` }],
            },
          },
          {
            seq: 2,
            type: 'turn/end',
            time: Date.now() - 50_000,
            data: {},
          },
        ],
      }
    },
  }

  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ system = '', messages = [] }) {
      const joined = `${system}\n${JSON.stringify(messages)}`
      if (joined.includes(marker)) {
        distillCalls.push(joined)
        let firstKey = 'sess-synth-1:1'
        try {
          const parsed = JSON.parse(messages[0]?.content?.[0]?.text || messages[0]?.content || '[]')
          if (Array.isArray(parsed) && parsed[0]?.key) firstKey = parsed[0].key
        } catch {}
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            records: [{
              key: firstKey,
              quote: `核心网关重构并${marker}`,
              kind: 'achievement',
              title: '核心网关灰度发布与延迟优化',
              text: `完成核心网关重构并${marker}，P99 延迟从 220ms 降至 68ms`,
              role: '核心负责人',
              impact: 'P99 延迟降低 69%',
            }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // Return empty JSON for non-distill background calls (e.g. triage/insight)
      yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const host = await createHost({ dir, llm, sessionQuery })
  t.after(() => host.close())

  // Authorize all sessions, enable work distillation + model + search mode + board, set interval far in future so timer cannot race
  await host.action('session-scope', {
    projects: ['*'],
    mode: 'search',
    watchSessions: true,
    sendToModel: true,
    model: 'fixture:mock',
  })
  await host.action('configure', {
    config: {
      mode: 'search',
      watchSessions: true,
      sendToModel: true,
      model: 'fixture:mock',
      intervalMinutes: 1440,
      boards: [{ provider: 'greenhouse', slug: 'acme-synth', company: 'Acme Synth' }],
    },
  })

  const baselineState = await host.state()
  assert.equal(baselineState.evidence.length, 0)
  assert.equal(baselineState.opportunities.length, 0)

  // 1) NEGATIVE CASE: Jobs page manual fetch (`scope: 'boards'`)
  const boardRun = await host.action('run', { scope: 'boards' })
  assert.equal(boardRun.status, 200)
  assert.equal(boardRun.json.ok, true)
  assert.equal(boardRun.json.result.scope, 'boards')
  assert.ok(boardFetchCalls >= 1, 'board fetch should have executed')
  assert.equal(sessionListCalls, 0, 'scope=boards MUST NOT list sessions')
  assert.equal(sessionReadCalls, 0, 'scope=boards MUST NOT read sessions')
  assert.equal(distillCalls.length, 0, 'scope=boards MUST NOT send session text to distill LLM')

  const afterBoards = await host.state()
  assert.equal(afterBoards.opportunities.length, 1, 'jobs should be fetched into opportunities')
  assert.equal(afterBoards.opportunities[0].title, 'Staff Distributed Systems Engineer')
  assert.equal(afterBoards.evidence.length, 0, 'evidence baseline must remain untouched')

  const watchdogAfterBoards = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.deepEqual(watchdogAfterBoards.cursors, {}, 'session cursors on disk must stay empty after scope=boards')

  // 2) POSITIVE CASE: Library manual distill (`scope: 'sessions'`)
  const boardFetchBaseline = boardFetchCalls
  const sessionRun = await host.action('run', { scope: 'sessions' })
  assert.equal(sessionRun.status, 200)
  assert.equal(sessionRun.json.ok, true)
  assert.equal(sessionRun.json.result.scope, 'sessions')
  assert.equal(boardFetchCalls, boardFetchBaseline, 'scope=sessions MUST NOT refetch job boards')
  assert.ok(sessionListCalls >= 1, 'scope=sessions should list sessions')
  assert.ok(sessionReadCalls >= 1, 'scope=sessions should read authorized session')
  assert.equal(distillCalls.length, 1, 'scope=sessions should call distill LLM for authorized session')

  const afterSessions = await host.state()
  assert.equal(afterSessions.evidence.length, 1, 'authorized session should produce 1 evidence proposal')
  assert.ok(afterSessions.evidence[0].text.includes(marker))

  const watchdogAfterSessions = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.ok(watchdogAfterSessions.cursors['sess-synth-1'], 'session cursor should advance after scope=sessions')
})

test('Blocker 2: unapproved evidence preview stays out of manual edits, auto-save, Cmd+S, restart & export; explicit accept persists content + evidenceIds together', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-blocker2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const llm = { listProviders: () => [{ id: 'fixture' }], async *stream() { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const host = await createHost({ dir, llm })
  t.after(() => host.close())

  // 1) Prepare approved synthetic resume with "修复按钮" and approved shareable evidence "发版给灰度组"
  const baseResumeMd = '# 测试候选人\n\n## 项目经历\n- 修复按钮'
  const imported = await host.action('resume-import', { title: '通用简历', text: baseResumeMd })
  const baseId = imported.json.result.id
  await host.action('resume-review', { id: baseId, decision: 'approve' })

  const evReply = await host.action('ingest', {
    event: {
      id: 'ev-gray-release-1',
      sourceId: 'manual',
      projectId: 'personal',
      kind: 'manual',
      occurredAt: new Date().toISOString(),
      evidence: [{ title: '灰度发版', text: '发版给灰度组', impact: '' }],
    },
  })
  const evId = evReply.json.result.evidence[0].id
  await host.action('evidence-update', { id: evId, changes: { status: 'approved', shareable: true } })

  // 2) Stage evidence preview (unapproved)
  const placement = suggestEvidencePlacement(baseResumeMd, { id: evId, title: '灰度发版', text: '发版给灰度组' }, 'zh')
  const items = computeReviewableLineChanges(baseResumeMd, placement.proposedText, [], { locale: 'zh' })
    .map(row => ({ ...row, evidenceIds: [evId] }))
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'insert')
  assert.ok(placement.proposedText.includes('发版给灰度组'))

  // Verify playback steps carry source label and point strictly to inserted line
  const playbackSteps = buildUnifiedPlaybackSteps(baseResumeMd, items, { source: '手动记录' })
  assert.equal(playbackSteps.length, 1)
  assert.equal(playbackSteps[0].source, '手动记录')
  assert.equal(playbackSteps[0].kind, 'insert')

  // 3) NEGATIVE CASE: User manually edits editorText ("修复按钮" -> "修复按钮并验证") while proposal stays unapproved.
  // Because editorText NEVER loaded stagedPreviewText, onChange produces ONLY the manual edit:
  const manualDraftText = '# 测试候选人\n\n## 项目经历\n- 修复按钮并验证'
  // Preview dynamically rebases on top of manualDraftText (preview contains BOTH, editor/draft contains ONLY manual edit)
  const dynamicPreview = rebaseReviewDecisions(manualDraftText, baseResumeMd, items, [])
  assert.ok(dynamicPreview.includes('修复按钮并验证'))
  assert.ok(dynamicPreview.includes('发版给灰度组'))

  // Simulate auto-save on manual edit (must NOT contain unapproved line or evidenceId)
  const autoSaved = await host.action('resume-revise', {
    id: baseId,
    text: manualDraftText,
    autoSaved: true,
    inPlace: false,
  })
  const draftId = autoSaved.json.result.id
  assert.equal(autoSaved.json.result.text.includes('修复按钮并验证'), true)
  assert.equal(autoSaved.json.result.text.includes('发版给灰度组'), false)
  assert.deepEqual(autoSaved.json.result.evidenceIds ?? [], [])

  // Simulate Cmd+S (approve manual draft) + export
  const cmdS = await host.action('resume-revise', {
    id: draftId,
    text: manualDraftText,
    approve: true,
    inPlace: true,
  })
  assert.equal(cmdS.json.result.status, 'approved')
  const exportedBeforeAccept = await host.action('export', { id: cmdS.json.result.id })
  assert.ok(exportedBeforeAccept.json.result.text.includes('修复按钮并验证'))
  assert.ok(!exportedBeforeAccept.json.result.text.includes('发版给灰度组'))

  // Restart host and read back from disk: manual edit persists, unapproved line absent
  host.close()
  const restarted1 = await createHost({ dir, llm })
  t.after(() => restarted1.close())
  const stAfterRestart1 = await restarted1.state()
  const persistedManual = stAfterRestart1.resumes.find(r => r.id === cmdS.json.result.id)
  assert.ok(persistedManual.text.includes('修复按钮并验证'))
  assert.ok(!persistedManual.text.includes('发版给灰度组'))
  assert.deepEqual(persistedManual.evidenceIds ?? [], [])

  // 4) POSITIVE CASE: Explicit accept rebases onto current manual draft and persists content + evidenceIds together
  const acceptedText = rebaseReviewDecisions(persistedManual.text, baseResumeMd, items, [])
  assert.ok(acceptedText.includes('修复按钮并验证'))
  assert.ok(acceptedText.includes('发版给灰度组'))

  const acceptedSave = await restarted1.action('resume-revise', {
    id: persistedManual.id,
    text: acceptedText,
    autoSaved: true,
    variant: 'conversation',
    evidenceIds: [evId],
    approve: true,
  })
  const acceptedId = acceptedSave.json.result.id
  assert.ok(acceptedSave.json.result.text.includes('修复按钮并验证'))
  assert.ok(acceptedSave.json.result.text.includes('发版给灰度组'))
  assert.ok((acceptedSave.json.result.evidenceIds ?? []).includes(evId), 'explicit accept MUST bind evidenceIds')

  // Verify persistence across restart + export
  restarted1.close()
  const restarted2 = await createHost({ dir, llm })
  t.after(() => restarted2.close())
  const stAfterRestart2 = await restarted2.state()
  const acceptedPersisted = stAfterRestart2.resumes.find(r => r.id === acceptedId)
  assert.ok(acceptedPersisted.text.includes('修复按钮并验证'))
  assert.ok(acceptedPersisted.text.includes('发版给灰度组'))
  assert.ok((acceptedPersisted.evidenceIds ?? []).includes(evId))

  const exportedAfterAccept = await restarted2.action('export', { id: acceptedId })
  assert.ok(exportedAfterAccept.json.result.text.includes('修复按钮并验证'))
  assert.ok(exportedAfterAccept.json.result.text.includes('发版给灰度组'))

  // 5) Bonus verification: JD-attached revision forks to job-specific version instead of polluting master track
  const jobReply = await restarted2.action('job-add', { job: { company: 'Acme', title: 'Platform Lead', jd: 'Distributed systems' } })
  const jobId = jobReply.json.result.id
  const jdRev = await restarted2.action('resume-revise', {
    id: acceptedId,
    text: `${acceptedText}\n- 聚焦分布式平台架构`,
    opportunityId: jobId,
    title: 'Acme · Platform Lead',
    variant: 'conversation',
  })
  assert.equal(jdRev.json.ok, true)
  assert.equal(jdRev.json.result.kind, 'revised')
  assert.equal(jdRev.json.result.opportunityId, jobId)
  assert.equal(jdRev.json.result.general, false)

  // Verify organizeResumeVersions detects masterHasContentDiff accurately
  const stWithBranch = await restarted2.state()
  const sameBodyMaster = await restarted2.action('resume-revise', {
    id: acceptedId,
    text: acceptedText,
    approve: true,
  })
  assert.ok(sameBodyMaster.json.result.id)
  const treeNoDiff = organizeResumeVersions((await restarted2.state()).resumes, { opportunities: stWithBranch.opportunities })
  assert.equal(treeNoDiff.branches[0].latest.masterBehind, true)
  assert.equal(treeNoDiff.branches[0].latest.masterHasContentDiff, false, 'identical master body should report no content diff')
})

test('Blocker 3: one-off company job fetch never silently subscribes; paused mode stays off across save-only and save-and-fetch until explicitly resumed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-blocker3-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('boards-api.greenhouse.io/v1/boards/unsub-co/jobs')) {
      return new Response(JSON.stringify({
        jobs: [
          {
            id: 2026,
            title: 'AI Infrastructure Engineer',
            location: { name: 'Shanghai' },
            absolute_url: 'https://job-boards.greenhouse.io/unsub-co/jobs/2026',
            updated_at: '2026-11-21T12:00:00Z',
            content: '<p>Inference serving, CUDA, distributed clusters.</p>',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, opts)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const llm = { listProviders: () => [{ id: 'fixture' }], async *stream() { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const host = await createHost({ dir, llm })
  t.after(() => host.close())

  // Baseline: paused (mode: 'off'), 0 subscribed boards, nextRun: null
  await host.action('configure', { config: { mode: 'off', boards: [] } })
  const base = await host.state()
  assert.equal(base.mode, 'off')
  assert.equal(base.config.boards.length, 0)
  assert.equal(base.watch.nextRun, null)

  // 1) NEGATIVE CASE: One-off company job fetch from Discover Companies
  const fetchRes = await host.action('company-search-jobs', {
    company: 'Unsub Co',
    provider: 'greenhouse',
    slug: 'unsub-co',
    careersUrl: 'https://job-boards.greenhouse.io/unsub-co',
  })
  assert.equal(fetchRes.status, 200)
  assert.equal(fetchRes.json.result.imported, 1)

  const afterOneOff = await host.state()
  assert.equal(afterOneOff.opportunities.length, 1, 'fetched jobs must appear in job list')
  assert.equal(afterOneOff.opportunities[0].title, 'AI Infrastructure Engineer')
  assert.equal(afterOneOff.config.boards.length, 0, 'one-off fetch MUST NOT silently subscribe board')
  assert.equal(afterOneOff.mode, 'off', 'one-off fetch MUST keep mode paused')
  assert.equal(afterOneOff.watch.nextRun, null, 'one-off fetch MUST keep schedule paused')

  // Verify across restart: jobs remain visible, boards still 0, mode still off
  host.close()
  const host2 = await createHost({ dir, llm })
  t.after(() => host2.close())
  const afterRestart = await host2.state()
  assert.equal(afterRestart.opportunities.length, 1, 'one-off jobs persist across restart')
  assert.equal(afterRestart.config.boards.length, 0, 'still 0 subscribed boards after restart')
  assert.equal(afterRestart.mode, 'off')
  assert.equal(afterRestart.watch.nextRun, null)

  // 2) POSITIVE CASE: Explicit subscribe & save-only while paused keeps mode=off and persists board
  const subBoard = { provider: 'greenhouse', slug: 'unsub-co', company: 'Unsub Co' }
  await host2.action('configure', { config: { boards: [subBoard] } })
  const afterSaveOnly = await host2.state()
  assert.equal(afterSaveOnly.config.boards.length, 1, 'explicit subscribe + save persists subscription')
  assert.equal(afterSaveOnly.mode, 'off', 'save-only while paused MUST NOT switch mode to search')
  assert.equal(afterSaveOnly.watch.nextRun, null, 'save-only while paused MUST keep nextRun null')

  // One-off save-and-fetch while paused (`run` with `scope: 'boards'`) keeps mode=off and nextRun=null
  const pausedPull = await host2.action('run', { scope: 'boards' })
  assert.equal(pausedPull.status, 200)
  const afterPausedPull = await host2.state()
  assert.equal(afterPausedPull.mode, 'off', 'one-off pull while paused MUST NOT resume scheduled mode')
  assert.equal(afterPausedPull.watch.nextRun, null, 'one-off pull while paused MUST keep nextRun null')
  assert.equal(afterPausedPull.opportunities.length, 1)

  // Restart & read back: subscription persists and still paused
  host2.close()
  const host3 = await createHost({ dir, llm })
  t.after(() => host3.close())
  const afterRestart2 = await host3.state()
  assert.equal(afterRestart2.config.boards.length, 1)
  assert.equal(afterRestart2.config.boards[0].slug, 'unsub-co')
  assert.equal(afterRestart2.mode, 'off')
  assert.equal(afterRestart2.watch.nextRun, null)

  // Explicit resume activates search mode and schedule
  await host3.action('configure', { config: { mode: 'search' } })
  const afterResume = await host3.state()
  assert.equal(afterResume.mode, 'search')
  assert.ok(afterResume.watch.nextRun, 'explicit resume enables schedule')
})

test('0.30.1 Blocker 1 (observe): board-only Save and Save-and-Fetch preserve queued work-session wakeAt/nextRun and never trigger premature dialogue extraction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-0301-board-observe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const marker1 = 'SYNTHETIC_WORK_SESSION_ONE_9011'
  const marker2 = 'SYNTHETIC_WORK_SESSION_TWO_9022'
  let sessionsAvailable = ['sess-obs-1']
  let sessionListCalls = 0
  let sessionReadCalls = 0
  let boardFetchCalls = 0
  const distillCalls = []

  const origNow = Date.now
  const t0 = origNow() + 1000
  let fakeNow = t0
  Date.now = () => fakeNow
  t.after(() => { Date.now = origNow })

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.includes('boards-api.greenhouse.io/v1/boards/qa-board-')) {
      boardFetchCalls += 1
      const slug = u.includes('qa-board-two') ? 'qa-board-two' : 'qa-board-one'
      return new Response(JSON.stringify({
        jobs: [{
          id: slug === 'qa-board-two' ? 9202 : 9201,
          title: slug === 'qa-board-two' ? 'Platform Reliability Engineer' : 'Infrastructure QA Engineer',
          location: { name: 'Remote' },
          absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/9201`,
          updated_at: '2026-11-22T05:00:00Z',
          content: '<p>Build reliable distributed test automation.</p>',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, opts)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const sessionQuery = {
    async listSessions() {
      sessionListCalls += 1
      return sessionsAvailable.map(id => ({ header: { id, origin: null } }))
    },
    async readTitleSnapshots() { return [] },
    async readSession(id) {
      sessionReadCalls += 1
      const marker = id === 'sess-obs-2' ? marker2 : marker1
      return {
        session: { id, origin: null },
        events: [
          {
            seq: 1,
            type: 'user/message',
            time: fakeNow - 60_000,
            data: {
              source: { kind: 'user' },
              content: [{ type: 'text', text: `今天完成了上线灰度前置校验 ${marker}，已稳定运行。` }],
            },
          },
          { seq: 2, type: 'turn/end', time: fakeNow - 30_000, data: {} },
        ],
      }
    },
  }

  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ system = '', messages = [] }) {
      const joined = `${system}\n${JSON.stringify(messages)}`
      const seenMarker = joined.includes(marker2) ? marker2 : (joined.includes(marker1) ? marker1 : '')
      if (seenMarker) {
        distillCalls.push(seenMarker)
        let firstKey = 'sess-obs-1:1'
        try {
          const parsed = JSON.parse(messages[0]?.content?.[0]?.text || messages[0]?.content || '[]')
          if (Array.isArray(parsed) && parsed[0]?.key) firstKey = parsed[0].key
        } catch {}
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            records: [{
              key: firstKey,
              quote: `上线灰度前置校验 ${seenMarker}`,
              kind: 'achievement',
              title: '上线灰度前置校验',
              text: `完成上线灰度前置校验 ${seenMarker}`,
              role: '核心负责人',
              impact: '保障灰度发布稳定性',
            }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const host = await createHost({ dir, llm, sessionQuery, captureTimer: true })
  t.after(() => host.close())

  // Set up observe mode (work distillation ON, board patrol OFF), authorize sessions, and run initial baseline
  await host.action('session-scope', {
    projects: ['*'],
    mode: 'observe',
    watchSessions: true,
    sendToModel: true,
    model: 'fixture:mock',
  })
  await host.action('configure', {
    config: {
      mode: 'observe',
      watchSessions: true,
      sendToModel: true,
      model: 'fixture:mock',
      intervalMinutes: 360,
      boards: [{ provider: 'greenhouse', slug: 'qa-board-one', company: 'QA Board One' }],
    },
  })
  // Trigger initial background observe tick (sets nextRun 6h ahead without fetching boards)
  await host.fireBackgroundTimer()

  // Verify baseline after initial run: 1 evidence distilled, nextRun 6h ahead, board patrol NOT run in observe
  const afterInitial = await host.state()
  assert.equal(afterInitial.mode, 'observe')
  assert.equal(afterInitial.evidence.length, 1)
  assert.equal(boardFetchCalls, 0)
  assert.equal(afterInitial.watch.nextRun, new Date(fakeNow + 360 * 60_000).toISOString())

  // New authorized session arrives 2 minutes later -> queues deferred wakeAt (+15 min)
  fakeNow = t0 + 2 * 60_000
  sessionsAvailable = ['sess-obs-1', 'sess-obs-2']
  host.emitSessionEvent({ id: 'sess-obs-2', header: { id: 'sess-obs-2', origin: null } }, { type: 'turn/end', seq: 2 })

  const beforeBoardDrawer = await host.state()
  assert.equal(beforeBoardDrawer.watch.queued, true, 'new session turn/end must queue deferred wakeAt')
  const expectedWakeIso = beforeBoardDrawer.watch.nextRun
  assert.equal(expectedWakeIso, new Date(fakeNow + 15 * 60_000).toISOString())

  const baseListCalls = sessionListCalls
  const baseReadCalls = sessionReadCalls
  const baseDistillCount = distillCalls.length
  const baseBoardCalls = boardFetchCalls

  // 1) Board-only "仅保存" 4 minutes in (13 min BEFORE scheduled wakeAt)
  fakeNow = t0 + 4 * 60_000
  const saveOnly = await host.action('configure', {
    config: {
      boards: [
        { provider: 'greenhouse', slug: 'qa-board-one', company: 'QA Board One' },
        { provider: 'greenhouse', slug: 'qa-board-two', company: 'QA Board Two' },
      ],
    },
  })
  assert.equal(saveOnly.status, 200)

  const afterBoardSave = await host.state()
  assert.equal(afterBoardSave.mode, 'observe', 'board-only Save must keep observe mode')
  assert.equal(afterBoardSave.config.boards.length, 2, 'board-only Save must persist boards')
  assert.equal(afterBoardSave.watch.queued, true, 'board-only Save MUST NOT clear wakeAt')
  assert.equal(afterBoardSave.watch.nextRun, expectedWakeIso, 'board-only Save MUST preserve scheduled wakeAt/nextRun')

  // Background 5-second timer fires right after board-only Save: MUST NOT trigger work-dialogue extraction!
  await host.fireBackgroundTimer()
  assert.equal(sessionListCalls, baseListCalls, 'board-only Save must not trigger session listing')
  assert.equal(sessionReadCalls, baseReadCalls, 'board-only Save must not trigger session reads')
  assert.equal(distillCalls.length, baseDistillCount, 'board-only Save must not trigger distill LLM')
  assert.equal(boardFetchCalls, baseBoardCalls, 'board-only Save must not fetch boards')
  const watchdogAfterSave = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.equal(watchdogAfterSave.cursors['sess-obs-2'], undefined, 'second session cursor must stay untouched')

  // 2) Board "保存并拉取": configure({ boards }) + explicit run({ scope: 'boards' })
  fakeNow = t0 + 5 * 60_000
  await host.action('configure', {
    config: {
      boards: [
        { provider: 'greenhouse', slug: 'qa-board-one', company: 'QA Board One' },
        { provider: 'greenhouse', slug: 'qa-board-two', company: 'QA Board Two' },
      ],
    },
  })
  const saveAndPull = await host.action('run', { scope: 'boards' })
  assert.equal(saveAndPull.status, 200)
  assert.equal(saveAndPull.json.result.scope, 'boards')
  assert.ok(boardFetchCalls >= baseBoardCalls + 2, 'Save-and-Fetch must fetch subscribed boards')

  const afterSaveAndPull = await host.state()
  assert.equal(afterSaveAndPull.mode, 'observe')
  assert.equal(afterSaveAndPull.opportunities.length, 2, 'Save-and-Fetch must import board jobs')
  assert.equal(afterSaveAndPull.watch.queued, true, 'Save-and-Fetch MUST keep queued work wakeAt')
  assert.equal(afterSaveAndPull.watch.nextRun, expectedWakeIso, 'Save-and-Fetch MUST keep scheduled work wakeAt')

  await host.fireBackgroundTimer()
  assert.equal(sessionListCalls, baseListCalls, 'Save-and-Fetch must not trigger session listing')
  assert.equal(sessionReadCalls, baseReadCalls, 'Save-and-Fetch must not trigger session reads')
  assert.equal(distillCalls.length, baseDistillCount, 'Save-and-Fetch must not trigger distill LLM')
  const watchdogAfterPull = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.equal(watchdogAfterPull.cursors['sess-obs-2'], undefined, 'second session cursor must remain untouched after board pull')

  // 3) Positive check: once clock reaches scheduled wakeAt, background tick DOES distill sess-obs-2 normally
  fakeNow = t0 + 18 * 60_000
  await host.fireBackgroundTimer()
  assert.equal(distillCalls.length, baseDistillCount + 1, 'queued session must still distill once wakeAt arrives')
  assert.equal(distillCalls.at(-1), marker2)
  const afterDue = await host.state()
  assert.equal(afterDue.evidence.length, 2)
})

test('0.30.1 Blocker 2: sequential evidence previews from distinct sources preserve per-item provenance and isolate revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-0301-seq-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const llm = { listProviders: () => [{ id: 'fixture' }], async *stream() { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const host = await createHost({ dir, llm })
  t.after(() => host.close())

  const baseResumeMd = '# 林予安\n\n## 项目经历\n- 修复按钮'
  const baseId = (await host.action('resume-import', { title: '林予安通用简历', text: baseResumeMd })).json.result.id
  await host.action('resume-review', { id: baseId, decision: 'approve' })

  // Authorize two distinct sources: dsh-session (Source A) and github (Source B)
  await host.action('configure', {
    config: {
      mode: 'observe',
      sources: [
        { id: 'dsh-session', projects: ['proj-a'] },
        { id: 'github', projects: ['repo-b'] },
      ],
    },
  })
  const { CareerStore } = await import('../src/career.mjs')
  const store = new CareerStore({ file: join(dir, 'career-broker', 'career.json') })
  const ingA = await store.ingestEvents([{
    id: 'ev-seq-a',
    sourceId: 'dsh-session',
    projectId: 'proj-a',
    kind: 'work-evidence',
    occurredAt: new Date().toISOString(),
    evidence: [{ title: '回归脚本', text: '搭建回归脚本自动校验核心发版链路' }],
  }])
  const ingB = await store.ingestEvents([{
    id: 'ev-seq-b',
    sourceId: 'github',
    projectId: 'repo-b',
    kind: 'work-evidence',
    occurredAt: new Date().toISOString(),
    evidence: [{ title: '压测工具', text: '开发压测工具验证高并发网关吞吐' }],
  }])
  const evA = ingA.evidence[0]
  const evB = ingB.evidence[0]
  await store.reviewEvidence(evA.id, { action: 'approve', shareable: true })
  await store.reviewEvidence(evB.id, { action: 'approve', shareable: true })

  // Step 1: Preview Evidence A (Source A) on top of baseResumeMd
  const placeA = suggestEvidencePlacement(baseResumeMd, evA, 'zh')
  const reasonA = `拟写入「${placeA.sectionLabel}」· 回归脚本`
  const rawItems1 = computeReviewableLineChanges(baseResumeMd, placeA.proposedText, [{ kind: 'add', summary: reasonA }], { locale: 'zh' })
  const itemsAfterA = attachStagedReviewProvenance(rawItems1, {
    fallbackEvidenceIds: [evA.id],
    sourceLabel: 'DSH 对话',
    sourceKind: 'evidence',
    newItemReason: reasonA,
  })
  assert.equal(itemsAfterA.length, 1)
  assert.deepEqual(itemsAfterA[0].evidenceIds, [evA.id])
  assert.equal(itemsAfterA[0].sourceLabel, 'DSH 对话')

  // Simulate manual edit while Preview A is still unapplied
  const manualEditedDraft = '# 林予安\n\n## 项目经历\n- 修复按钮并验证'
  const previewAfterManualAndA = rebaseReviewDecisions(manualEditedDraft, baseResumeMd, itemsAfterA, [])
  assert.ok(previewAfterManualAndA.includes('修复按钮并验证'))
  assert.ok(previewAfterManualAndA.includes('回归脚本'))

  // Step 2: Reopen tray & preview Evidence B (Source B) sequentially on top of staged preview
  const placeB = suggestEvidencePlacement(previewAfterManualAndA, evB, 'zh')
  const reasonB = `拟写入「${placeB.sectionLabel}」· 压测工具`
  const rawItems2 = computeReviewableLineChanges(manualEditedDraft, placeB.proposedText, [{ kind: 'add', summary: reasonB }], { locale: 'zh' })
  const itemsAfterAB = attachStagedReviewProvenance(rawItems2, {
    previousItems: itemsAfterA,
    fallbackEvidenceIds: [evB.id],
    sourceLabel: 'GitHub',
    sourceKind: 'evidence',
    newItemReason: reasonB,
  })
  assert.equal(itemsAfterAB.length, 2, 'manual edit must stay in baseText, leaving strictly 2 staged evidence items')
  const rowA = itemsAfterAB.find(row => row.text.includes('回归脚本'))
  const rowB = itemsAfterAB.find(row => row.text.includes('压测工具'))
  assert.ok(rowA && rowB)
  assert.deepEqual(rowA.evidenceIds, [evA.id], 'first preview item MUST keep Source A evidenceId (never overwritten by B)')
  assert.deepEqual(rowB.evidenceIds, [evB.id], 'second preview item MUST bind Source B evidenceId')
  assert.equal(rowA.sourceLabel, 'DSH 对话')
  assert.equal(rowB.sourceLabel, 'GitHub')
  assert.equal(rowA.reason, reasonA)
  assert.equal(rowB.reason, reasonB)

  // Playback steps must carry each item's distinct source label
  const steps = buildUnifiedPlaybackSteps(manualEditedDraft, itemsAfterAB, { source: 'DSH 对话 · GitHub' })
  assert.equal(steps.length, 2)
  assert.equal(steps[0].source, 'DSH 对话')
  assert.equal(steps[1].source, 'GitHub')

  const allProposalIds = [...new Set(itemsAfterAB.flatMap(r => r.evidenceIds))]

  // Step 3: Select row A and REJECT row B -> must bind ONLY evA
  const textOnlyA = rebaseReviewDecisions(manualEditedDraft, manualEditedDraft, itemsAfterAB, [rowB.id])
  const idsOnlyA = resolveAcceptedReviewEvidenceIds(itemsAfterAB, [rowB.id], allProposalIds)
  assert.ok(textOnlyA.includes('回归脚本'))
  assert.equal(textOnlyA.includes('压测工具'), false)
  assert.deepEqual(idsOnlyA, [evA.id])

  const revOnlyA = await host.action('resume-revise', {
    id: baseId, text: textOnlyA, evidenceIds: idsOnlyA, autoSaved: true, variant: 'conversation', approve: true,
  })
  const revOnlyAId = revOnlyA.json.result.id
  assert.deepEqual(revOnlyA.json.result.evidenceIds, [evA.id])

  // Step 4: Select row B and REJECT row A -> must bind ONLY evB
  const textOnlyB = rebaseReviewDecisions(manualEditedDraft, manualEditedDraft, itemsAfterAB, [rowA.id])
  const idsOnlyB = resolveAcceptedReviewEvidenceIds(itemsAfterAB, [rowA.id], allProposalIds)
  assert.ok(textOnlyB.includes('压测工具'))
  assert.equal(textOnlyB.includes('回归脚本'), false)
  assert.deepEqual(idsOnlyB, [evB.id])

  const revOnlyB = await host.action('resume-revise', {
    id: baseId, text: textOnlyB, evidenceIds: idsOnlyB, autoSaved: true, variant: 'conversation', approve: true,
  })
  const revOnlyBId = revOnlyB.json.result.id
  assert.deepEqual(revOnlyB.json.result.evidenceIds, [evB.id])

  // Step 5: Forget Source A (dsh-session) + restart -> revOnlyA revoked/blocked, revOnlyB & base MUST stay exportable!
  await host.action('forget', { source: 'dsh-session', erase: true })
  host.close()

  const host2 = await createHost({ dir, llm })
  t.after(() => host2.close())
  assert.equal((await host2.action('export', { id: revOnlyAId })).status, 400, 'resume bound to Source A must be blocked after forgetting A')
  const exportB = await host2.action('export', { id: revOnlyBId })
  assert.equal(exportB.status, 200, 'resume bound ONLY to Source B must stay exportable after forgetting A')
  assert.ok(exportB.json.result.text.includes('压测工具'))
  assert.equal(exportB.json.result.text.includes('回归脚本'), false)
  assert.equal((await host2.action('export', { id: baseId })).status, 200)

  // Step 6: Forget Source B (github) + restart -> revOnlyB is now revoked/blocked too
  await host2.action('forget', { source: 'github', erase: true })
  host2.close()

  const host3 = await createHost({ dir, llm })
  t.after(() => host3.close())
  assert.equal((await host3.action('export', { id: revOnlyBId })).status, 400, 'resume bound to Source B must be blocked after forgetting B')
  assert.equal((await host3.action('export', { id: baseId })).status, 200)
})
