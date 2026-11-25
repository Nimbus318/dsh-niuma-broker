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
  migrateResumeChatScope,
  registerResumeChatCallbacks,
  resetDraftStoreForTests,
  resetResumeChatStore,
  runComposerTask,
  setDraft,
  startResumeChatStream,
  stopResumeChatStream,
  updateComposerStore,
} from '../client/draft-store.js'

function installMockSessionStorage() {
  const backing = new Map()
  const mockStorage = {
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

    // Auto-saving own draft on res-A to child res-A-2 migrates A's thread without touching B
    setDraft('resume-agent:res-A:text', 'follow up note')
    migrateResumeChatScope('res-A', 'res-A-2')
    assert.equal(getResumeChatState('res-A-2').messages.length, 2)
    assert.equal(getResumeChatState('res-A'), getResumeChatState('res-A-2'))
    assert.equal(getDraft('resume-agent:res-A-2:text'), 'follow up note')
    assert.equal(getResumeChatState('res-B').messages.length, 0)

    unregisterB()
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})
