import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearDraft,
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  getComposerState,
  getDraft,
  getResumeChatState,
  hasAnyResumeChatStreaming,
  hasRunningComposer,
  invalidateDraftsBySource,
  migrateResumeChatScope,
  registerResumeChatCallbacks,
  resetDraftStoreForTests,
  resetResumeChatStore,
  runComposerTask,
  setDraft,
  sourceMatchesForgotten,
  startResumeChatStream,
  stopResumeChatStream,
  updateComposerStore,
} from '../client/draft-store.js'
import { activateProfileScope, resetProfileStorageForTests } from '../client/profile-storage.js'

function installMockSessionStorage() {
  const backing = new Map()
  const mockStorage = {
    get length() { return backing.size },
    key: idx => Array.from(backing.keys())[idx] ?? null,
    getItem: key => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, val) => { backing.set(key, String(val)) },
    removeItem: key => { backing.delete(key) },
    clear: () => { backing.clear() },
  }
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, configurable: true })
  activateProfileScope('draft-test-profile')
  return {
    backing,
    restore() {
      resetProfileStorageForTests()
      if (prevDescriptor) Object.defineProperty(globalThis, 'sessionStorage', prevDescriptor)
      else delete globalThis.sessionStorage
    },
  }
}

test('draft store persists across scopes, cleans up empty drafts, and isolates keys', () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    setDraft('resume-agent:text', '把第一段项目改得更突出指标')
    setDraft('debrief:job-1:text', '一面技术深挖复盘草稿')
    setDraft('study:job-1:vLLM', 'PagedAttention 如何避免碎片？')
    setDraft('add-job', { company: 'Acme', title: 'Infra', location: '', url: '', jd: '' })

    assert.equal(getDraft('resume-agent:text'), '把第一段项目改得更突出指标')
    assert.equal(getDraft('debrief:job-1:text'), '一面技术深挖复盘草稿')
    assert.equal(getDraft('study:job-1:vLLM'), 'PagedAttention 如何避免碎片？')
    assert.equal(getDraft('study:job-1:CUDA', ''), '')
    assert.deepEqual(getDraft('add-job'), { company: 'Acme', title: 'Infra', location: '', url: '', jd: '' })

    // Verify backing sessionStorage persists after memory reset (simulates page reload)
    resetDraftStoreForTests()
    assert.equal(getDraft('resume-agent:text'), '把第一段项目改得更突出指标')
    assert.equal(getDraft('debrief:job-1:text'), '一面技术深挖复盘草稿')

    // Clearing or setting empty value removes key from storage
    setDraft('resume-agent:text', '')
    clearDraft('debrief:job-1:text')
    setDraft('add-job', { company: '', title: '', location: '', url: '', jd: '' })
    assert.equal(storage.backing.has('niuma.p.draft-test-profile.draft.v1:resume-agent:text'), false)
    assert.equal(storage.backing.has('niuma.p.draft-test-profile.draft.v1:debrief:job-1:text'), false)
    assert.equal(storage.backing.has('niuma.p.draft-test-profile.draft.v1:add-job'), false)
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('composer store preserves drafts, tracks running tasks across unmounts, and retains pending AI filters', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    updateComposerStore('jobs', { text: '筛出上海的 AI Infra 岗', selectedJobIds: ['job-1', 'job-2'] })
    updateComposerStore('job:job-99', { text: '准备约一面' })

    assert.equal(getComposerState('jobs').text, '筛出上海的 AI Infra 岗')
    assert.deepEqual(getComposerState('jobs').selectedJobIds, ['job-1', 'job-2'])
    assert.equal(getComposerState('job:job-99').text, '准备约一面')

    const pending = Promise.withResolvers()
    const taskPromise = runComposerTask('jobs', {
      label: '分析中…',
      nextText: '筛出上海的 AI Infra 岗',
      runnerFn: () => pending.promise,
    })

    assert.equal(getComposerState('jobs').submitting, true)
    assert.equal(hasRunningComposer('jobs'), true)
    assert.equal(hasRunningComposer('job:job-99'), false)

    // Simulate task finishing while user is away on another tab
    pending.resolve({
      ok: true,
      result: {
        ephemeral: true,
        kind: 'filter',
        summary: '已筛选 1 个匹配岗位',
        data: { label: '上海 · AI Infra', opportunityIds: ['job-1'], reasons: { 'job-1': '匹配' } },
      },
    })
    await taskPromise

    assert.equal(getComposerState('jobs').submitting, false)
    assert.equal(hasRunningComposer('jobs'), false)
    assert.equal(getComposerState('jobs').text, '')
    assert.equal(getComposerState('jobs').assistantReply?.kind, 'filter')
    assert.equal(getComposerState('jobs').history.length, 2)

    const consumed = consumeComposerPendingFilter('jobs')
    assert.equal(consumed?.clear, false)
    assert.deepEqual(consumed?.value?.ids, ['job-1'])
    assert.equal(consumeComposerPendingFilter('jobs'), null)
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('resume chat stream survives tab switch/detach, isolates across resumes/versions, and resets on source forget', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const callbacksRef = { current: { resumeId: 'res-A', onStageProposal: () => 'staged' } }
    const encoder = new TextEncoder()
    let streamController = null

    const fakeFetch = async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          streamController = controller
        },
      }),
    })

    const runPromise = startResumeChatStream({
      fetchImpl: fakeFetch,
      resumeId: 'res-A',
      baseVersion: 'vA1',
      requestId: 'req-A1',
      requestBody: { message: '润色经历' },
      userMsg: { id: 'u1', role: 'user', content: '润色经历' },
      assistantMsg: { id: 'a1', role: 'assistant', content: '', beforeMarkdown: '# Orig A', streaming: true, status: '正在思考…' },
      trimmedInput: '润色经历',
      callbacksRef,
      labels: { sourceChatLabel: '对话改稿' },
    })

    await Promise.resolve()
    assert.equal(getResumeChatState('res-A').streaming, true)
    assert.equal(hasAnyResumeChatStreaming(), true)

    // User switches away from Resume tab -> component unmounts and detaches callbacksRef without aborting stream
    callbacksRef.current = null

    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', delta: '已优化表述' })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# Updated Resume', changes: [{ kind: 'edit', summary: '精简首段' }] })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
    streamController.close()

    await runPromise

    const stateAfterReturn = getResumeChatState('res-A')
    assert.equal(stateAfterReturn.streaming, false)
    assert.equal(hasAnyResumeChatStreaming(), false)
    assert.equal(stateAfterReturn.messages.at(-1)?.content, '已优化表述')
    assert.equal(stateAfterReturn.pendingEffects.length, 1)
    assert.equal(stateAfterReturn.pendingEffects[0].type, 'resume-update')
    assert.equal(stateAfterReturn.pendingEffects[0].resumeId, 'res-A')
    assert.equal(stateAfterReturn.pendingEffects[0].baseVersion, 'vA1')
    assert.equal(stateAfterReturn.pendingEffects[0].requestId, 'req-A1')
    assert.equal(consumeResumeChatPendingEffects('res-A').length, 1)
    assert.equal(consumeResumeChatPendingEffects('res-A').length, 0)

    // Forgetting source aborts and resets all scoped stores cleanly
    resetResumeChatStore()
    assert.equal(getResumeChatState('res-A').messages.length, 0)
    assert.equal(storage.backing.has('niuma.p.draft-test-profile.resumeChat.v2:res-A'), false)

    // Stop streaming safely handles idle state
    stopResumeChatStream('res-A')
    assert.equal(getResumeChatState('res-A').streaming, false)
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('F04 regression: Resume A stream never invokes Resume B callbacks or leaks edits when switching A -> Jobs -> B', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const appliedToA = []
    const appliedToB = []
    const stylesToB = []
    const encoder = new TextEncoder()
    let streamController = null

    const fakeFetch = async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) { streamController = controller },
      }),
    })

    // Register A, start stream on A
    const unregisterA = registerResumeChatCallbacks('res-A', {
      baseVersion: 'vA1',
      onStageProposal: (md, meta) => { appliedToA.push({ md, meta }); return 'staged' },
      onApplyStyleDirective: dir => appliedToA.push({ dir }),
    })

    const streamPromise = startResumeChatStream({
      fetchImpl: fakeFetch,
      resumeId: 'res-A',
      baseVersion: 'vA1',
      requestId: 'req-switch-1',
      requestBody: { message: 'Rewrite summary on A' },
      userMsg: { id: 'uA', role: 'user', content: 'Rewrite summary on A' },
      assistantMsg: { id: 'aA', role: 'assistant', content: '', beforeMarkdown: '# Resume A v1', streaming: true },
      trimmedInput: 'Rewrite summary on A',
    })

    await Promise.resolve()
    assert.equal(getResumeChatState('res-A').streaming, true)

    // Switch to Jobs (unmounts A) and open Resume B (mounts B) before A's model finishes
    unregisterA()
    const unregisterB = registerResumeChatCallbacks('res-B', {
      baseVersion: 'vB1',
      onStageProposal: (md, meta) => { appliedToB.push({ md, meta }); return 'staged' },
      onApplyMarkdown: (md, meta) => { appliedToB.push({ md, meta }) },
      onApplyStyleDirective: dir => { stylesToB.push(dir) },
    })

    // Model finishes A's request while user is actively viewing Resume B
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# Edited Resume A', changes: [{ kind: 'edit', summary: 'Refine bullet' }] })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'appearance-update', template: 'slate', summary: 'Use Slate' })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
    streamController.close()
    await streamPromise

    // Resume B MUST receive 0 mutations, 0 style directives, 0 messages, 0 pendingEffects
    assert.equal(appliedToB.length, 0)
    assert.equal(stylesToB.length, 0)
    assert.equal(getResumeChatState('res-B').messages.length, 0)
    assert.equal(getResumeChatState('res-B').pendingEffects.length, 0)
    assert.deepEqual(consumeResumeChatPendingEffects('res-B'), [])

    // A's updates remain strictly buffered for A with requestId + baseVersion metadata
    assert.equal(appliedToA.length, 0)
    const pendingA = consumeResumeChatPendingEffects('res-A')
    assert.equal(pendingA.length, 2)
    assert.equal(pendingA[0].type, 'resume-update')
    assert.equal(pendingA[0].resumeId, 'res-A')
    assert.equal(pendingA[0].baseVersion, 'vA1')
    assert.equal(pendingA[0].requestId, 'req-switch-1')
    assert.equal(pendingA[0].markdown, '# Edited Resume A')
    assert.equal(pendingA[1].type, 'appearance-update')
    assert.equal(pendingA[1].resumeId, 'res-A')

    // Auto-saving own draft on res-A to child res-A-2 hands off thread one-time without leaving a permanent alias on res-A
    setDraft('resume-agent:res-A:text', 'follow up note')
    migrateResumeChatScope('res-A', 'res-A-2')
    assert.equal(getResumeChatState('res-A-2').messages.length, 2)
    assert.equal(getResumeChatState('res-A').messages.length, 0)
    assert.equal(getDraft('resume-agent:res-A-2:text'), 'follow up note')
    assert.equal(getDraft('resume-agent:res-A:text'), '')
    assert.equal(getResumeChatState('res-B').messages.length, 0)

    unregisterB()
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('F04 regression Round 2: auto-saved child A2 stream never shows on or gets consumed by parent A when switching A2 -> A / Jobs -> A -> A2', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const encoder = new TextEncoder()
    let streamController = null
    const appliedToA = []

    // 1. Auto-save approved resume A -> A2 once
    setDraft('resume-agent:res-A:text', 'old A draft')
    migrateResumeChatScope('res-A', 'res-A-2')

    // 2. Start stream on child A2
    const unregisterA2 = registerResumeChatCallbacks('res-A-2', {
      baseVersion: 'vA2',
      onStageProposal: () => 'staged',
    })
    const fakeFetch = async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) { streamController = controller },
      }),
    })
    const p = startResumeChatStream({
      fetchImpl: fakeFetch,
      resumeId: 'res-A-2',
      baseVersion: 'vA2',
      requestId: 'req-A2-1',
      requestBody: { message: 'Improve A2' },
      userMsg: { id: 'uA2', role: 'user', content: 'Improve A2' },
      assistantMsg: { id: 'aA2', role: 'assistant', content: '', beforeMarkdown: '# A2 base', streaming: true },
      trimmedInput: 'Improve A2',
    })
    await Promise.resolve()

    // 3. Switch to Jobs and finish stream while detached
    unregisterA2()
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# A2 Updated', changes: [{ kind: 'edit', summary: 'Polish A2' }] })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'appearance-update', template: 'slate', summary: 'Slate' })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
    streamController.close()
    await p

    // 4. Open parent version A FIRST -> must see clean A (0 messages, 0 effects consumed, 0 mutations)
    const unregisterA = registerResumeChatCallbacks('res-A', {
      baseVersion: 'vA1',
      onStageProposal: (md, meta) => { appliedToA.push({ md, meta }); return 'staged' },
    })
    assert.equal(getResumeChatState('res-A').messages.length, 0)
    assert.deepEqual(consumeResumeChatPendingEffects('res-A'), [])
    assert.equal(appliedToA.length, 0)
    unregisterA()

    // 5. Return to child A2 -> both effects MUST still be intact for A2
    assert.equal(getResumeChatState('res-A-2').messages.length, 2)
    const effectsA2 = consumeResumeChatPendingEffects('res-A-2')
    assert.equal(effectsA2.length, 2)
    assert.equal(effectsA2[0].resumeId, 'res-A-2')
    assert.equal(effectsA2[0].markdown, '# A2 Updated')
    assert.equal(effectsA2[1].resumeId, 'res-A-2')

    // 6. Live in-flight stream active during auto-save handoff A3 -> A4 redirects only that live stream
    let liveController = null
    const livePromise = startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({ start(c) { liveController = c } }),
      }),
      resumeId: 'res-A3',
      baseVersion: 'vA3',
      requestId: 'req-live-1',
      requestBody: { message: 'Live' },
      userMsg: { id: 'uA3', role: 'user', content: 'Live' },
      assistantMsg: { id: 'aA3', role: 'assistant', content: '', beforeMarkdown: '# A3', streaming: true },
      trimmedInput: 'Live',
    })
    await Promise.resolve()
    migrateResumeChatScope('res-A3', 'res-A4')
    liveController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# A4 Live Updated' })}\n`))
    liveController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
    liveController.close()
    await livePromise

    assert.equal(getResumeChatState('res-A3').messages.length, 0)
    assert.deepEqual(consumeResumeChatPendingEffects('res-A3'), [])
    const effectsA4 = consumeResumeChatPendingEffects('res-A4')
    assert.equal(effectsA4.length, 1)
    assert.equal(effectsA4[0].resumeId, 'res-A4')
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('F08 regression: source-derived prefill drafts (including edited prefills & post-reload storage) erase on forget-source while manual drafts stay', () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const manualKey = 'resume-agent:res-manual:text'
    const transcriptKey = 'resume-agent:res-transcript:text'
    const recordingKey = 'resume-agent:res-rec:text'

    // 1. Ordinary user-typed draft has no source provenance and survives source erasure
    setDraft(manualKey, '这是我自己手打的普通简历修改想法')
    // 2. Interview transcript prefill (tagged transcript) + edited prefill still retain transcript provenance
    setDraft(transcriptKey, '面试复盘：重点追问了分布式事务与推理延迟。', { sourceIds: ['transcript'] })
    setDraft(transcriptKey, '请帮忙优化：面试复盘：重点追问了分布式事务与推理延迟！')
    // 3. Recording debrief prefill tagged with both recording source and transcript, migrated across autosave scope
    setDraft(recordingKey, '录音转写复盘要点：Kernel 性能压测细节', { sourceIds: ['transcript', 'recording:plaud'] })
    migrateResumeChatScope('res-rec', 'res-rec-v2')
    assert.equal(getDraft('resume-agent:res-rec-v2:text'), '录音转写复盘要点：Kernel 性能压测细节')

    // Forgetting recording:plaud erases only recording prefill, keeps transcript-only & manual
    invalidateDraftsBySource('recording:plaud')
    assert.equal(getDraft('resume-agent:res-rec-v2:text'), '')
    assert.equal(getDraft(transcriptKey), '请帮忙优化：面试复盘：重点追问了分布式事务与推理延迟！')
    assert.equal(getDraft(manualKey), '这是我自己手打的普通简历修改想法')

    // Simulate page reload / cold memory restore where only sessionStorage holds draft + source provenance,
    // then clear 'transcript' source: edited transcript prefill MUST disappear, manual draft MUST stay
    resetDraftStoreForTests()
    invalidateDraftsBySource('transcript')
    assert.equal(getDraft(transcriptKey), '')
    assert.equal(getDraft(manualKey), '这是我自己手打的普通简历修改想法')

    // Clearing a prefilled draft removes provenance, so retyping manual content afterwards survives forget
    setDraft(transcriptKey, '二次预填复盘内容', { sourceIds: ['transcript'] })
    clearDraft(transcriptKey)
    setDraft(transcriptKey, '清空后全新手写的内容')
    invalidateDraftsBySource('transcript')
    assert.equal(getDraft(transcriptKey), '清空后全新手写的内容')

    // Recording-sourced prefill also erases when broad 'transcript' is forgotten
    assert.equal(sourceMatchesForgotten(['recording:plaud'], 'transcript'), true)
    assert.equal(sourceMatchesForgotten(['github'], 'transcript'), false)
    assert.equal(sourceMatchesForgotten([], 'transcript'), false)
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('F08 regression Round 2: failed send/retry (in-page and detached) preserves sourceIds for forget erasure without clobbering new manual input or restoring aborted forget', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const encoder = new TextEncoder()
    const key = 'resume-agent:res-f08:text'

    // 1. In-page failure restores text AND sourceIds, then cold-reopen forget('transcript') erases it
    const restoredCalls = []
    const unreg = registerResumeChatCallbacks('res-f08', { baseVersion: 'v1' })
    await startResumeChatStream({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
      resumeId: 'res-f08',
      baseVersion: 'v1',
      requestId: 'req-fail-inpage',
      requestBody: { message: 'fail' },
      userMsg: { id: 'u1', role: 'user', content: '面试复盘：并发优化' },
      assistantMsg: { id: 'a1', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '面试复盘：并发优化',
      inputSourceIds: ['transcript'],
      retryOptions: { display: '面试复盘：并发优化', sourceIds: ['transcript'] },
      onRestoreInput: (restored, restoredSources) => {
        restoredCalls.push({ restored, restoredSources })
        if (!getDraft(key, '')) setDraft(key, restored, { sourceIds: restoredSources })
      },
    })
    assert.deepEqual(restoredCalls, [{ restored: '面试复盘：并发优化', restoredSources: ['transcript'] }])
    assert.deepEqual(getResumeChatState('res-f08').messages.at(-1).retryInput.options.sourceIds, ['transcript'])
    resetDraftStoreForTests()
    assert.equal(invalidateDraftsBySource('transcript'), 1)
    assert.equal(getDraft(key, ''), '')
    unreg()

    // 2. Detached (tab-switched to Jobs) HTTP 500 + NDJSON error restore draft with sourceIds, retry keeps sourceIds
    resetResumeChatStore()
    await startResumeChatStream({
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) }),
      resumeId: 'res-f08',
      baseVersion: 'v1',
      requestId: 'req-fail-detached-http',
      requestBody: { message: 'fail2' },
      userMsg: { id: 'u2', role: 'user', content: '录音要点：vLLM PagedAttention' },
      assistantMsg: { id: 'a2', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '录音要点：vLLM PagedAttention',
      inputSourceIds: ['transcript', 'recording:plaud'],
      retryOptions: {},
    })
    assert.equal(getDraft(key, ''), '录音要点：vLLM PagedAttention')
    assert.deepEqual(getResumeChatState('res-f08').messages.at(-1).retryInput.options.sourceIds, ['transcript', 'recording:plaud'])

    // Simulate retrying from retryInput after clearing draft first, hitting NDJSON error while detached -> sourceIds still preserved
    const retryPayload = getResumeChatState('res-f08').messages.at(-1).retryInput
    setDraft(key, '')
    await startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message: 'model overload' })}\n`))
            c.close()
          },
        }),
      }),
      resumeId: 'res-f08',
      baseVersion: 'v1',
      requestId: 'req-fail-detached-ndjson',
      requestBody: { message: retryPayload.rawInput },
      userMsg: { id: 'u3', role: 'user', content: retryPayload.rawInput },
      assistantMsg: { id: 'a3', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: retryPayload.rawInput,
      retryOptions: retryPayload.options,
    })
    assert.equal(getDraft(key, ''), '录音要点：vLLM PagedAttention')
    resetDraftStoreForTests()
    invalidateDraftsBySource('transcript')
    assert.equal(getDraft(key, ''), '')

    // 3. New manual input typed while transcript request is in flight stays intact and untouched by forget('transcript')
    let rejectFlight = null
    const flightPromise = startResumeChatStream({
      fetchImpl: () => new Promise((_, reject) => { rejectFlight = reject }),
      resumeId: 'res-f08',
      baseVersion: 'v1',
      requestId: 'req-fail-new-manual',
      requestBody: { message: 'old' },
      userMsg: { id: 'u4', role: 'user', content: '旧复盘' },
      assistantMsg: { id: 'a4', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '旧复盘',
      inputSourceIds: ['transcript'],
    })
    setDraft(key, '用户发送后重新手写的纯个人补充')
    rejectFlight(new Error('network drop'))
    await flightPromise
    assert.equal(getDraft(key, ''), '用户发送后重新手写的纯个人补充')
    invalidateDraftsBySource('transcript')
    assert.equal(getDraft(key, ''), '用户发送后重新手写的纯个人补充')

    // 4. Forgetting source mid-flight prevents racing failure from restoring old transcript draft
    resetResumeChatStore()
    setDraft(key, '')
    let rejectRacing = null
    const racingPromise = startResumeChatStream({
      fetchImpl: () => new Promise((_, reject) => { rejectRacing = reject }),
      resumeId: 'res-f08',
      baseVersion: 'v1',
      requestId: 'req-racing-forget',
      requestBody: { message: 'racing' },
      userMsg: { id: 'u5', role: 'user', content: '进行中的复盘' },
      assistantMsg: { id: 'a5', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '进行中的复盘',
      inputSourceIds: ['transcript'],
    })
    invalidateDraftsBySource('transcript')
    rejectRacing(new Error('late socket error'))
    await racingPromise
    assert.equal(getDraft(key, ''), '')
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})

test('TurnTrace reducer & privacy: sequences NDJSON trace, strips raw thinking before sessionStorage, and tracks stopped/interrupted outcomes', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const encoder = new TextEncoder()
    const events1 = [
      { v: 1, turnId: 'other-turn', seq: 1, type: 'text', delta: 'SHOULD_IGNORE' },
      { v: 1, turnId: 'turn-1', seq: 1, type: 'context', items: [{ kind: 'resume', label: '主稿', chars: 1200 }, { kind: 'evidence', count: 3, supplied: true }] },
      { v: 1, turnId: 'turn-1', seq: 2, type: 'attempt', attemptId: 'a1', route: 'mock:pro', modelName: 'Pro', effort: 'high', reason: 'primary' },
      { v: 1, turnId: 'turn-1', seq: 3, type: 'thinking', attemptId: 'a1', delta: 'SECRET_REASONING_CHAIN' },
      { v: 1, turnId: 'turn-1', seq: 4, type: 'tool-preparing', attemptId: 'a1', index: 0, name: 'update_resume' },
      { v: 1, turnId: 'turn-1', seq: 4, type: 'tool-preparing', attemptId: 'a1', index: 0, name: 'update_resume' },
      { v: 1, turnId: 'turn-1', seq: 5, type: 'tool-start', attemptId: 'a1', callId: 'c1', name: 'update_resume' },
      { v: 1, turnId: 'turn-1', seq: 6, type: 'resume-update', markdown: '# Updated', changes: [{ kind: 'edit', summary: '精简首段' }], citedEvidenceCount: 1 },
      { v: 1, turnId: 'turn-1', seq: 7, type: 'tool-end', attemptId: 'a1', callId: 'c1', name: 'update_resume', ok: true, summary: '已更新' },
      { v: 1, turnId: 'turn-1', seq: 8, type: 'text', delta: '完成修改。' },
      { v: 1, turnId: 'turn-1', seq: 9, type: 'done', outcome: 'ok', elapsedMs: 1450, route: 'mock:pro', modelName: 'Pro', effort: 'high' },
    ]
    await startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const ev of events1) controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`))
            controller.close()
          },
        }),
      }),
      resumeId: 'res-trace',
      baseVersion: 'v1',
      requestId: 'turn-1',
      requestBody: { turnId: 'turn-1', message: '改写简历' },
      userMsg: { id: 'u1', role: 'user', content: '改写简历' },
      assistantMsg: { id: 'a1', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '改写简历',
    })

    const memMsg = getResumeChatState('res-trace').messages.at(-1)
    assert.equal(memMsg.content, '完成修改。')
    assert.equal(memMsg.thinking, undefined)
    assert.equal(memMsg.trace.thinkingText, 'SECRET_REASONING_CHAIN')
    assert.equal(memMsg.trace.outcome, 'ok')
    assert.equal(memMsg.trace.elapsedMs, 1450)
    assert.equal(memMsg.trace.modelName, 'Pro')
    assert.equal(memMsg.trace.effort, 'high')
    assert.equal(memMsg.trace.citedEvidenceCount, 1)
    assert.equal(memMsg.trace.steps.length, 1)
    assert.equal(memMsg.trace.steps[0].id, 'c1')
    assert.equal(memMsg.trace.steps[0].state, 'done')

    // sessionStorage must strip raw thinking & thinkingText while keeping trace summary metadata
    const persistedRaw = storage.backing.get('niuma.p.draft-test-profile.resumeChat.v2:res-trace')
    assert.ok(persistedRaw)
    assert.equal(persistedRaw.includes('SECRET_REASONING_CHAIN'), false)
    const persisted = JSON.parse(persistedRaw)
    const savedMsg = persisted.at(-1)
    assert.equal('thinking' in savedMsg, false)
    assert.equal('thinkingText' in savedMsg.trace, false)
    assert.equal(savedMsg.trace.modelName, 'Pro')
    assert.equal(savedMsg.trace.citedEvidenceCount, 1)

    // EOF without done -> outcome = 'interrupted'
    await startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-2', seq: 1, type: 'text', delta: '半截回复' })}\n`))
            controller.close()
          },
        }),
      }),
      resumeId: 'res-trace',
      baseVersion: 'v1',
      requestId: 'turn-2',
      requestBody: { turnId: 'turn-2', message: '继续' },
      userMsg: { id: 'u2', role: 'user', content: '继续' },
      assistantMsg: { id: 'a2', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '继续',
    })
    const interruptedMsg = getResumeChatState('res-trace').messages.at(-1)
    assert.equal(interruptedMsg.trace.outcome, 'interrupted')
    assert.equal(interruptedMsg.retryInput?.rawInput, '继续')

    // Client stop (AbortError) -> outcome = 'stopped'
    const stopPromise = startResumeChatStream({
      fetchImpl: (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
      resumeId: 'res-trace',
      baseVersion: 'v1',
      requestId: 'turn-3',
      requestBody: { turnId: 'turn-3', message: '取消我' },
      userMsg: { id: 'u3', role: 'user', content: '取消我' },
      assistantMsg: { id: 'a3', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '取消我',
    })
    stopResumeChatStream('res-trace')
    await stopPromise
    const stoppedMsg = getResumeChatState('res-trace').messages.at(-1)
    assert.equal(stoppedMsg.trace.outcome, 'stopped')
    assert.equal(stoppedMsg.retryInput?.rawInput, '取消我')

    // Source forget wipes all messages & storage immediately
    resetResumeChatStore()
    assert.equal(getResumeChatState('res-trace').messages.length, 0)
    assert.equal(storage.backing.has('niuma.p.draft-test-profile.resumeChat.v2:res-trace'), false)

    // Regression: repeated tool-preparing (same index) & duplicate tool-start/tool-end callIds collapse cleanly
    await startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (let i = 0; i < 4; i++) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: i + 1, type: 'tool-preparing', attemptId: 'a1', index: 0, name: 'update_resume' })}\n`))
            }
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 5, type: 'tool-start', attemptId: 'a1', callId: 'call-1', name: 'update_resume' })}\n`))
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 6, type: 'tool-start', attemptId: 'a1', callId: 'call-1', name: 'update_resume' })}\n`))
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 7, type: 'tool-end', attemptId: 'a1', callId: 'unknown-call', name: 'update_resume', ok: true })}\n`))
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 8, type: 'resume-update', markdown: '# CallId Fixed', changes: [{ kind: 'edit', summary: '合并重复 delta' }] })}\n`))
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 9, type: 'tool-end', attemptId: 'a1', callId: 'call-1', name: 'update_resume', ok: true, summary: '完成' })}\n`))
            controller.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-callid-dedupe', seq: 10, type: 'done', outcome: 'ok', elapsedMs: 500 })}\n`))
            controller.close()
          },
        }),
      }),
      resumeId: 'res-legacy-dedupe',
      baseVersion: 'v1',
      requestId: 'turn-callid-dedupe',
      requestBody: { turnId: 'turn-callid-dedupe', message: '改写' },
      userMsg: { id: 'u-leg', role: 'user', content: '改写' },
      assistantMsg: { id: 'a-leg', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '改写',
    })
    const dedupedMsg = getResumeChatState('res-legacy-dedupe').messages.at(-1)
    assert.equal(dedupedMsg.trace.steps.length, 1, 'duplicate tool-preparing/callId deltas must stay 1 step')
    assert.equal(dedupedMsg.trace.steps[0].id, 'call-1')
    assert.equal(dedupedMsg.trace.steps[0].state, 'done')

    // Regression: upgrade scrubbing strips raw thinking from both opened and unopened sessionStorage threads on cold reload
    storage.backing.set('niuma.p.draft-test-profile.resumeChat.v2:res-unopened-legacy', JSON.stringify([
      { id: 'u-old', role: 'user', content: '旧问题' },
      { id: 'a-old', role: 'assistant', content: '旧回答', thinking: '原始旧推理', thinkingStartedAt: 1000, thinkingMs: 850, trace: { outcome: 'ok', elapsedMs: 850, thinkingText: 'leak', thinkingStartedAt: 1000, attemptStartedAt: 990, steps: [] } },
    ]))
    resetDraftStoreForTests()
    getResumeChatState('res-other')
    const scrubbedRaw = storage.backing.get('niuma.p.draft-test-profile.resumeChat.v2:res-unopened-legacy')
    assert.ok(scrubbedRaw && !scrubbedRaw.includes('原始旧推理') && !scrubbedRaw.includes('thinkingStartedAt') && !scrubbedRaw.includes('attemptStartedAt') && !scrubbedRaw.includes('thinkingText'))
    assert.equal(JSON.parse(scrubbedRaw)[1].trace.thinkingMs, 850)

    // Regression: same-profile 409 PROFILE_MISMATCH or REVISION_CHANGED must clear streaming instead of wedging chat
    await startResumeChatStream({
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: 'PROFILE_MISMATCH', error: '工作区状态已更新，请重试。' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
      resumeId: 'res-409-unwedge',
      baseVersion: 'v1',
      requestId: 'turn-409',
      requestBody: { turnId: 'turn-409', message: '重试测试' },
      userMsg: { id: 'u-409', role: 'user', content: '重试测试' },
      assistantMsg: { id: 'a-409', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: '重试测试',
    })
    const conflictState = getResumeChatState('res-409-unwedge')
    assert.equal(conflictState.streaming, false, 'same-profile 409 must not leave thread wedged in streaming')
    assert.equal(conflictState.messages.at(-1).streaming, false)
    assert.equal(conflictState.messages.at(-1).trace.outcome, 'error')

    // Timing continuity: thinkingStartedAt inherits attemptStartedAt & tool-start preserves prep startedAt
    let streamCtrl = null
    const timingPromise = startResumeChatStream({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) { streamCtrl = controller },
        }),
      }),
      resumeId: 'res-timing',
      baseVersion: 'v1',
      requestId: 'turn-timing',
      requestBody: { turnId: 'turn-timing', message: 'timing' },
      userMsg: { id: 'u-t', role: 'user', content: 'timing' },
      assistantMsg: { id: 'a-t', role: 'assistant', content: '', beforeMarkdown: '# Base', streaming: true },
      trimmedInput: 'timing',
    })
    await Promise.resolve()
    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 1, type: 'attempt', attemptId: 'a1', reason: 'primary', modelName: 'DeepSeek', effort: 'high' })}\n`))
    await new Promise(r => setTimeout(r, 25))
    const attemptAt = getResumeChatState('res-timing').messages.at(-1).trace.attemptStartedAt
    assert.ok(attemptAt > 0)
    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 2, type: 'thinking', attemptId: 'a1', delta: '思考' })}\n`))
    await Promise.resolve()
    const thinkStart = getResumeChatState('res-timing').messages.at(-1).trace.thinkingStartedAt
    assert.equal(thinkStart, attemptAt, 'thinking timer must continue seamlessly from attemptStartedAt without jumping backwards')

    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 3, type: 'tool-preparing', attemptId: 'a1', index: 0, name: 'update_resume' })}\n`))
    await new Promise(r => setTimeout(r, 15))
    const prepStart = getResumeChatState('res-timing').messages.at(-1).trace.steps[0].startedAt
    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 4, type: 'tool-start', attemptId: 'a1', callId: 'c-time', name: 'update_resume' })}\n`))
    await Promise.resolve()
    assert.equal(getResumeChatState('res-timing').messages.at(-1).trace.steps[0].startedAt, prepStart, 'tool-start must preserve prep startedAt')
    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 5, type: 'tool-end', attemptId: 'a1', callId: 'c-time', name: 'update_resume', ok: true, summary: '完成' })}\n`))
    streamCtrl.enqueue(encoder.encode(`${JSON.stringify({ v: 1, turnId: 'turn-timing', seq: 6, type: 'done', outcome: 'ok', elapsedMs: 900 })}\n`))
    streamCtrl.close()
    await timingPromise
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})
