import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearDraft,
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  getComposerState,
  getDraft,
  getResumeChatState,
  hasRunningComposer,
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

test('resume chat stream survives tab switch/detach, buffers resume updates, and resets on source forget', async () => {
  resetDraftStoreForTests()
  const storage = installMockSessionStorage()
  try {
    const callbacksRef = { current: { onStageProposal: () => 'staged' } }
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
      requestBody: { message: '润色经历' },
      userMsg: { id: 'u1', role: 'user', content: '润色经历' },
      assistantMsg: { id: 'a1', role: 'assistant', content: '', streaming: true, status: '正在思考…' },
      trimmedInput: '润色经历',
      callbacksRef,
      labels: { sourceChatLabel: '对话改稿' },
    })

    await Promise.resolve()
    assert.equal(getResumeChatState().streaming, true)

    // User switches away from Resume tab -> component unmounts and detaches callbacksRef without aborting stream
    callbacksRef.current = null

    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', delta: '已优化表述' })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# Updated Resume', changes: [{ kind: 'edit', summary: '精简首段' }] })}\n`))
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
    streamController.close()

    await runPromise

    const stateAfterReturn = getResumeChatState()
    assert.equal(stateAfterReturn.streaming, false)
    assert.equal(stateAfterReturn.messages.at(-1)?.content, '已优化表述')
    assert.equal(stateAfterReturn.pendingEffects.length, 1)
    assert.equal(stateAfterReturn.pendingEffects[0].type, 'resume-update')
    assert.equal(consumeResumeChatPendingEffects().length, 1)
    assert.equal(consumeResumeChatPendingEffects().length, 0)

    // Forgetting source aborts and resets state cleanly
    resetResumeChatStore()
    assert.equal(getResumeChatState().messages.length, 0)
    assert.equal(storage.backing.has('niuma.resumeChat.v1'), false)

    // Stop streaming safely handles idle state
    stopResumeChatStream()
    assert.equal(getResumeChatState().streaming, false)
  } finally {
    resetDraftStoreForTests()
    storage.restore()
  }
})
