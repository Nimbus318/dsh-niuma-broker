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
  return {
    backing,
    restore() {
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
    assert.equal(storage.backing.has('niuma.draft.v1:resume-agent:text'), false)
    assert.equal(storage.backing.has('niuma.draft.v1:debrief:job-1:text'), false)
    assert.equal(storage.backing.has('niuma.draft.v1:add-job'), false)
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
    assert.equal(storage.backing.has('niuma.resumeChat.v2:res-A'), false)

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
