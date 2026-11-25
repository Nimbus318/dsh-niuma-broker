const DRAFT_PREFIX = 'niuma.draft.v1:'
const CHAT_STORAGE_KEY = 'niuma.resumeChat.v1'
const CHAT_STORAGE_PREFIX = 'niuma.resumeChat.v2:'
const DEFAULT_CHAT_SCOPE = 'default'

const draftMemory = new Map()
const draftListeners = new Map()

function getStorage() {
  try {
    return globalThis?.sessionStorage ?? null
  } catch {
    return null
  }
}

function isEmptyDraftValue(value) {
  if (value == null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') {
    const vals = Object.values(value)
    return vals.length === 0 || vals.every(v => v == null || v === '')
  }
  return false
}

function notifyDraft(key) {
  const set = draftListeners.get(key)
  if (!set) return
  for (const fn of set) {
    try { fn() } catch {}
  }
}

export function subscribeDraft(key, fn) {
  if (!key) return () => {}
  let set = draftListeners.get(key)
  if (!set) {
    set = new Set()
    draftListeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) draftListeners.delete(key)
  }
}

export function getDraft(key, fallback = '') {
  if (!key) return fallback
  if (draftMemory.has(key)) return draftMemory.get(key)
  const storage = getStorage()
  if (storage) {
    try {
      const raw = storage.getItem(DRAFT_PREFIX + key)
      if (raw != null) {
        const parsed = JSON.parse(raw)
        draftMemory.set(key, parsed)
        return parsed
      }
    } catch {}
  }
  return fallback
}

export function setDraft(key, value) {
  if (!key) return
  if (isEmptyDraftValue(value)) {
    draftMemory.delete(key)
    const storage = getStorage()
    if (storage) {
      try { storage.removeItem(DRAFT_PREFIX + key) } catch {}
    }
    notifyDraft(key)
    return
  }
  draftMemory.set(key, value)
  const storage = getStorage()
  if (storage) {
    try { storage.setItem(DRAFT_PREFIX + key, JSON.stringify(value)) } catch {}
  }
  notifyDraft(key)
}

export function clearDraft(key) {
  setDraft(key, null)
}

// ---------- Scoped Composer Store (survives tab switches + drawer close/reopen) ----------

const composerMap = new Map()
const composerListeners = new Map()
const composerRunningListeners = new Set()
const composerInFlight = new Set()

function createComposerEntry(scopeKey) {
  const savedText = scopeKey ? getDraft(`composer:${scopeKey}:text`, '') : ''
  const savedJobs = scopeKey ? getDraft(`composer:${scopeKey}:jobs`, []) : []
  return {
    text: typeof savedText === 'string' ? savedText : '',
    selectedJobIds: Array.isArray(savedJobs) ? savedJobs : [],
    assistantReply: null,
    inquiryOpen: false,
    matrixOpen: false,
    history: [],
    priorId: '',
    activeId: '',
    submitting: false,
    submitStartedAt: 0,
    submitLabel: '',
    sendError: '',
    seedNote: '',
    pendingFilter: null,
  }
}

export function getComposerState(scopeKey) {
  const key = scopeKey || 'jobs'
  let entry = composerMap.get(key)
  if (!entry) {
    entry = createComposerEntry(key)
    composerMap.set(key, entry)
  }
  return entry
}

export function subscribeComposer(scopeKey, fn) {
  const key = scopeKey || 'jobs'
  let set = composerListeners.get(key)
  if (!set) {
    set = new Set()
    composerListeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) composerListeners.delete(key)
  }
}

export function subscribeRunningComposers(fn) {
  composerRunningListeners.add(fn)
  return () => { composerRunningListeners.delete(fn) }
}

export function hasRunningComposer(scopeKey = '') {
  if (!scopeKey) {
    for (const entry of composerMap.values()) {
      if (entry?.submitting) return true
    }
    return false
  }
  if (scopeKey === 'jobs') {
    for (const [k, entry] of composerMap.entries()) {
      if (entry?.submitting && (k === 'jobs' || k.startsWith('job:'))) return true
    }
    return false
  }
  return Boolean(composerMap.get(scopeKey)?.submitting)
}

export function updateComposerStore(scopeKey, patchOrFn) {
  const key = scopeKey || 'jobs'
  const prev = getComposerState(key)
  const patch = typeof patchOrFn === 'function' ? patchOrFn(prev) : (patchOrFn ?? {})
  if (!patch || typeof patch !== 'object') return prev
  const next = { ...prev, ...patch }
  composerMap.set(key, next)
  if (next.text !== prev.text) setDraft(`composer:${key}:text`, next.text)
  if (next.selectedJobIds !== prev.selectedJobIds) setDraft(`composer:${key}:jobs`, next.selectedJobIds)
  const listeners = composerListeners.get(key)
  if (listeners) {
    for (const fn of listeners) {
      try { fn() } catch {}
    }
  }
  if (next.submitting !== prev.submitting) {
    for (const fn of composerRunningListeners) {
      try { fn() } catch {}
    }
  }
  return next
}

export function consumeComposerPendingFilter(scopeKey) {
  const key = scopeKey || 'jobs'
  const cur = getComposerState(key)
  if (!cur.pendingFilter) return null
  const pending = cur.pendingFilter
  updateComposerStore(key, { pendingFilter: null })
  return pending
}

export async function runComposerTask(scopeKey, {
  label = '',
  nextText = '',
  overrideText,
  fallbackError = '',
  compareTitleFallback = '',
  aiFilterFallback = '',
  runnerFn,
}) {
  const key = scopeKey || 'jobs'
  if (composerInFlight.has(key) || getComposerState(key).submitting) return null
  composerInFlight.add(key)
  updateComposerStore(key, {
    inquiryOpen: false,
    submitStartedAt: Date.now(),
    submitLabel: label,
    submitting: true,
    sendError: '',
    seedNote: '',
  })
  try {
    let reply
    try {
      reply = await runnerFn()
    } catch (err) {
      reply = { ok: false, error: err?.message || '' }
    }
    if (!reply?.ok) {
      updateComposerStore(key, {
        sendError: reply?.error || fallbackError,
      })
      return reply
    }
    const res = reply.result
    const patch = {
      ...(typeof overrideText !== 'string' ? { text: '' } : {}),
      priorId: '',
    }
    if (res?.ephemeral && ['filter', 'compare', 'answer'].includes(res.kind)) {
      patch.assistantReply = res
      if (Array.isArray(res.data?.followUp?.fields) && res.data.followUp.fields.length > 0) {
        patch.inquiryOpen = true
      }
      const assistantDigest = res.kind === 'answer'
        ? (res.data?.answer || res.summary || '')
        : res.kind === 'compare'
          ? `${res.data?.title || compareTitleFallback}: ${res.data?.recommendation || res.summary || ''}`
          : (res.summary || res.data?.label || '')
      updateComposerStore(key, cur => ({
        ...patch,
        history: [
          ...cur.history.slice(-6),
          { role: 'user', text: String(nextText || '').slice(0, 750) },
          { role: 'assistant', text: String(assistantDigest || '').slice(0, 750) },
        ],
        ...(res.kind === 'filter' ? {
          pendingFilter: res.data?.clear
            ? { clear: true, value: null, nonce: Date.now() }
            : {
                clear: false,
                value: {
                  label: res.data?.label || aiFilterFallback,
                  ids: Array.isArray(res.data?.opportunityIds) ? res.data.opportunityIds : [],
                  reasons: res.data?.reasons || {},
                  stage: res.data?.stage || undefined,
                },
                nonce: Date.now(),
              },
        } : {}),
      }))
    } else {
      updateComposerStore(key, {
        ...patch,
        activeId: res?.id ?? '',
      })
    }
    return reply
  } finally {
    composerInFlight.delete(key)
    updateComposerStore(key, { submitting: false })
  }
}

// ---------- Resume Chat Scoped Stream Store (isolated per resumeId + version + requestId) ----------

function normalizeScopeId(scopeId) {
  return typeof scopeId === 'string' && scopeId.trim() ? scopeId.trim() : DEFAULT_CHAT_SCOPE
}

const resumeChatMap = new Map()
const resumeChatListeners = new Map()
const resumeChatStreamingListeners = new Set()
const activeChatControllers = new Map()
const activeResumeCallbacks = new Map()
const activeStreamBindings = new Map()

function loadSavedChat(scopeId) {
  const storage = getStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(CHAT_STORAGE_PREFIX + scopeId)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(m => m && m.id && m.role).slice(-16) : []
  } catch {
    return []
  }
}

function saveSettledChat(scopeId, messages) {
  const storage = getStorage()
  if (!storage) return
  try {
    const settled = (Array.isArray(messages) ? messages : []).filter(m => !m.streaming).slice(-16)
    if (settled.length) storage.setItem(CHAT_STORAGE_PREFIX + scopeId, JSON.stringify(settled))
    else storage.removeItem(CHAT_STORAGE_PREFIX + scopeId)
  } catch {}
}

function clearAllSavedChats() {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(CHAT_STORAGE_KEY)
    const toRemove = []
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i)
      if (k && k.startsWith(CHAT_STORAGE_PREFIX)) toRemove.push(k)
    }
    for (const k of toRemove) storage.removeItem(k)
  } catch {}
}

function ensureResumeChatState(scopeId = DEFAULT_CHAT_SCOPE) {
  const key = normalizeScopeId(scopeId)
  let entry = resumeChatMap.get(key)
  if (!entry) {
    const saved = loadSavedChat(key)
    entry = {
      scopeId: key,
      messages: saved,
      expanded: saved.length > 0,
      fullPane: false,
      streaming: false,
      pendingEffects: [],
    }
    resumeChatMap.set(key, entry)
  }
  return entry
}

function notifyResumeChatScope(scopeId, streamingChanged = false) {
  const listeners = resumeChatListeners.get(scopeId)
  if (listeners) {
    for (const fn of listeners) {
      try { fn() } catch {}
    }
  }
  if (streamingChanged) {
    for (const fn of resumeChatStreamingListeners) {
      try { fn() } catch {}
    }
  }
}

export function getResumeChatState(scopeId = DEFAULT_CHAT_SCOPE) {
  return ensureResumeChatState(scopeId)
}

export function hasAnyResumeChatStreaming() {
  for (const entry of resumeChatMap.values()) {
    if (entry?.streaming) return true
  }
  return false
}

export function subscribeResumeChatStreaming(fn) {
  resumeChatStreamingListeners.add(fn)
  return () => { resumeChatStreamingListeners.delete(fn) }
}

export function registerResumeChatCallbacks(scopeId, callbacks) {
  const key = normalizeScopeId(scopeId)
  if (!callbacks) {
    activeResumeCallbacks.delete(key)
    return () => {}
  }
  const entry = { ...callbacks, resumeId: key }
  activeResumeCallbacks.set(key, entry)
  return () => {
    if (activeResumeCallbacks.get(key) === entry) {
      activeResumeCallbacks.delete(key)
    }
  }
}

export function subscribeResumeChat(scopeIdOrFn, maybeFn) {
  const key = typeof scopeIdOrFn === 'function' ? DEFAULT_CHAT_SCOPE : normalizeScopeId(scopeIdOrFn)
  const fn = typeof scopeIdOrFn === 'function' ? scopeIdOrFn : maybeFn
  if (typeof fn !== 'function') return () => {}
  let set = resumeChatListeners.get(key)
  if (!set) {
    set = new Set()
    resumeChatListeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) resumeChatListeners.delete(key)
  }
}

export function setResumeChatState(scopeIdOrUpdater, maybeUpdater) {
  const isDefault = typeof scopeIdOrUpdater === 'function' || (typeof scopeIdOrUpdater === 'object' && scopeIdOrUpdater !== null)
  const key = isDefault ? DEFAULT_CHAT_SCOPE : normalizeScopeId(scopeIdOrUpdater)
  const updater = isDefault ? scopeIdOrUpdater : maybeUpdater
  const prev = ensureResumeChatState(key)
  const patch = typeof updater === 'function' ? updater(prev) : (updater ?? {})
  if (!patch || typeof patch !== 'object') return prev
  const next = { ...prev, ...patch, scopeId: key }
  resumeChatMap.set(key, next)
  if (next.messages !== prev.messages) saveSettledChat(key, next.messages)
  notifyResumeChatScope(key, next.streaming !== prev.streaming)
  return next
}

export function migrateResumeChatScope(fromScopeId, toScopeId) {
  const from = normalizeScopeId(fromScopeId)
  const to = normalizeScopeId(toScopeId)
  if (!from || !to || from === to || from === DEFAULT_CHAT_SCOPE) return
  const fromState = ensureResumeChatState(from)

  // Redirect only currently live in-flight stream(s) on `from`; never alias future reads or callbacks.
  const bindings = activeStreamBindings.get(from)
  if (bindings) {
    for (const binding of [...bindings]) {
      binding.redirectTo(to)
    }
  }

  const controller = activeChatControllers.get(from)
  if (controller) {
    activeChatControllers.delete(from)
    activeChatControllers.set(to, controller)
  }

  const hadData = fromState.messages.length > 0 || fromState.pendingEffects.length > 0 || fromState.streaming
  if (hadData) {
    const toState = ensureResumeChatState(to)
    const mergedMessages = [
      ...toState.messages,
      ...fromState.messages.map(m => ({ ...m, resumeId: to })),
    ].slice(-32)
    const mergedEffects = [
      ...toState.pendingEffects,
      ...fromState.pendingEffects.map(eff => ({
        ...eff,
        resumeId: to,
        metaPayload: eff.metaPayload ? { ...eff.metaPayload, targetResumeId: to } : eff.metaPayload,
        directive: eff.directive ? { ...eff.directive, targetResumeId: to } : eff.directive,
      })),
    ]
    const nextTo = {
      ...toState,
      scopeId: to,
      messages: mergedMessages,
      expanded: toState.expanded || fromState.expanded,
      fullPane: toState.fullPane || fromState.fullPane,
      streaming: toState.streaming || fromState.streaming,
      pendingEffects: mergedEffects,
    }
    resumeChatMap.set(to, nextTo)
    saveSettledChat(to, nextTo.messages)
    resumeChatMap.set(from, {
      scopeId: from,
      messages: [],
      expanded: false,
      fullPane: false,
      streaming: false,
      pendingEffects: [],
    })
    saveSettledChat(from, [])
    notifyResumeChatScope(from, fromState.streaming)
    notifyResumeChatScope(to, nextTo.streaming !== toState.streaming)
  }

  for (const field of ['text', 'jobId']) {
    const fromKey = `resume-agent:${from}:${field}`
    const toKey = `resume-agent:${to}:${field}`
    const val = getDraft(fromKey, '')
    if (val) {
      if (!getDraft(toKey, '')) setDraft(toKey, val)
      clearDraft(fromKey)
    }
  }
}

export function stopResumeChatStream(scopeId = DEFAULT_CHAT_SCOPE) {
  const key = normalizeScopeId(scopeId)
  activeChatControllers.get(key)?.abort()
  activeChatControllers.delete(key)
  setResumeChatState(key, { streaming: false })
}

export function resetResumeChatStore(scopeId = null) {
  if (typeof scopeId === 'string' && scopeId.trim()) {
    const key = normalizeScopeId(scopeId)
    const prev = resumeChatMap.get(key)
    activeChatControllers.get(key)?.abort()
    activeChatControllers.delete(key)
    activeStreamBindings.delete(key)
    resumeChatMap.set(key, {
      scopeId: key,
      messages: [],
      expanded: false,
      fullPane: false,
      streaming: false,
      pendingEffects: [],
    })
    saveSettledChat(key, [])
    notifyResumeChatScope(key, Boolean(prev?.streaming))
    return
  }
  for (const controller of activeChatControllers.values()) {
    try { controller?.abort() } catch {}
  }
  activeChatControllers.clear()
  activeResumeCallbacks.clear()
  activeStreamBindings.clear()
  const scopesToNotify = new Set([DEFAULT_CHAT_SCOPE, ...resumeChatMap.keys(), ...resumeChatListeners.keys()])
  for (const key of scopesToNotify) saveSettledChat(key, [])
  resumeChatMap.clear()
  clearAllSavedChats()
  for (const key of scopesToNotify) {
    notifyResumeChatScope(key, false)
  }
  for (const fn of resumeChatStreamingListeners) {
    try { fn() } catch {}
  }
}

export function consumeResumeChatPendingEffects(scopeId = DEFAULT_CHAT_SCOPE) {
  const key = normalizeScopeId(scopeId)
  const cur = ensureResumeChatState(key)
  if (!cur.pendingEffects.length) return []
  const matching = []
  const remaining = []
  for (const eff of cur.pendingEffects) {
    const effScope = eff?.resumeId ? normalizeScopeId(eff.resumeId) : key
    if (effScope === key) matching.push(eff)
    else remaining.push(eff)
  }
  if (!matching.length) return []
  setResumeChatState(key, { pendingEffects: remaining })
  return matching
}

export async function startResumeChatStream({
  fetchImpl = globalThis.fetch,
  requestUrl = 'api/career-agent/resume-chat',
  headers = {},
  requestBody,
  userMsg,
  assistantMsg,
  trimmedInput = '',
  retryOptions = {},
  callbacksRef = null,
  resumeId = DEFAULT_CHAT_SCOPE,
  baseVersion = '',
  requestId = '',
  labels = {},
  onRestoreInput = null,
}) {
  const effectiveRequestId = requestId || globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let streamScope = normalizeScopeId(resumeId)
  const getScope = () => streamScope
  if (ensureResumeChatState(getScope()).streaming) return
  const controller = new AbortController()
  activeChatControllers.set(getScope(), controller)
  const streamBinding = {
    redirectTo(nextScope) {
      const target = normalizeScopeId(nextScope)
      if (!target || target === streamScope) return
      const prevSet = activeStreamBindings.get(streamScope)
      if (prevSet) {
        prevSet.delete(streamBinding)
        if (prevSet.size === 0) activeStreamBindings.delete(streamScope)
      }
      if (activeChatControllers.get(streamScope) === controller) {
        activeChatControllers.delete(streamScope)
        activeChatControllers.set(target, controller)
      }
      streamScope = target
      let nextSet = activeStreamBindings.get(target)
      if (!nextSet) {
        nextSet = new Set()
        activeStreamBindings.set(target, nextSet)
      }
      nextSet.add(streamBinding)
    },
  }
  let initSet = activeStreamBindings.get(streamScope)
  if (!initSet) {
    initSet = new Set()
    activeStreamBindings.set(streamScope, initSet)
  }
  initSet.add(streamBinding)

  const stampedUserMsg = { ...userMsg, resumeId: getScope(), baseVersion, requestId: effectiveRequestId }
  const stampedAssistantMsg = { ...assistantMsg, resumeId: getScope(), baseVersion, requestId: effectiveRequestId }

  setResumeChatState(getScope(), prev => ({
    ...prev,
    messages: [...prev.messages, stampedUserMsg, stampedAssistantMsg],
    expanded: true,
    streaming: true,
  }))

  const updateAssistant = updater => {
    const scope = getScope()
    setResumeChatState(scope, prev => ({
      ...prev,
      messages: prev.messages.map(item => (item.id === assistantMsg.id ? updater(item) : item)),
    }))
  }

  const resolveMatchingCallbacks = scope => {
    const cb = activeResumeCallbacks.get(scope)
      || (callbacksRef?.current && normalizeScopeId(callbacksRef.current.resumeId) === scope ? callbacksRef.current : null)
    if (!cb) return { matched: false, cb: null, drifted: false }
    if (cb.resumeId && normalizeScopeId(cb.resumeId) !== scope) {
      return { matched: false, cb: null, drifted: false }
    }
    const drifted = Boolean(baseVersion && cb.baseVersion && cb.baseVersion !== baseVersion)
    return { matched: true, cb, drifted }
  }

  const restoreInput = () => {
    const scope = getScope()
    const { matched } = resolveMatchingCallbacks(scope)
    if (matched && typeof onRestoreInput === 'function') {
      onRestoreInput(trimmedInput)
    } else if (trimmedInput) {
      const key = scope && scope !== DEFAULT_CHAT_SCOPE ? `resume-agent:${scope}:text` : 'resume-agent:text'
      const cur = getDraft(key, '')
      if (!cur) setDraft(key, trimmedInput)
    }
  }

  try {
    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const failed = await response.json().catch(() => null)
      if (response.status === 404) {
        throw new Error(labels.backendOutdated || 'Backend outdated')
      }
      throw new Error(failed?.error || `${labels.requestFailed || 'Request failed'} (${response.status})`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { continue }

        if (event.type === 'status') {
          updateAssistant(cur => ({ ...cur, status: event.text || labels.processingEllipsis || '' }))
        } else if (event.type === 'thinking') {
          updateAssistant(cur => ({
            ...cur,
            thinkingStartedAt: cur.thinkingStartedAt || Date.now(),
            thinking: `${cur.thinking || ''}${event.delta || ''}`.slice(0, 4000),
          }))
        } else if (event.type === 'text') {
          updateAssistant(cur => ({
            ...cur,
            status: '',
            thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
            content: cur.content + (event.delta || ''),
          }))
        } else if (event.type === 'tool-start') {
          const label = event.name === 'update_resume'
            ? (labels.updatingResume || '')
            : (labels.updatingStyle || '')
          updateAssistant(cur => ({
            ...cur,
            status: label,
            thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
          }))
        } else if (event.type === 'resume-update' && event.markdown) {
          const scope = getScope()
          const { matched, cb, drifted } = resolveMatchingCallbacks(scope)
          const metaPayload = {
            source: 'ai',
            sourceKind: 'chat',
            sourceLabel: labels.jobLabel || labels.sourceChatLabel || '',
            changes: Array.isArray(event.changes) ? event.changes : [],
            ...(Array.isArray(event.evidenceIds) && event.evidenceIds.length ? { evidenceIds: event.evidenceIds } : {}),
            ...(Array.isArray(event.changeProvenance) && event.changeProvenance.length ? { changeProvenance: event.changeProvenance } : {}),
            ...(labels.inheritedJobId ? { opportunityId: labels.inheritedJobId } : {}),
            ...(labels.jobTitle ? { title: labels.jobTitle } : {}),
            targetResumeId: scope,
            targetBaseVersion: baseVersion,
            baseMarkdown: assistantMsg.beforeMarkdown || '',
            requestId: effectiveRequestId,
            ...(drifted ? { forceStage: true } : {}),
          }
          if (matched && typeof cb.onStageProposal === 'function') {
            const outcome = cb.onStageProposal(event.markdown, metaPayload)
            updateAssistant(cur => ({
              ...cur,
              afterMarkdown: outcome === 'noop' ? null : event.markdown,
              changes: Array.isArray(event.changes) ? event.changes : cur.changes,
              stagedForReview: outcome === 'staged',
              noOpUpdate: outcome === 'noop',
              revertedResume: false,
            }))
          } else if (matched && !drifted && typeof cb.onApplyMarkdown === 'function') {
            cb.onApplyMarkdown(event.markdown, metaPayload)
            updateAssistant(cur => ({
              ...cur,
              afterMarkdown: event.markdown,
              changes: Array.isArray(event.changes) ? event.changes : cur.changes,
              stagedForReview: false,
              noOpUpdate: false,
              revertedResume: false,
            }))
          } else {
            // Detached or user opened a different resume: keep effect buffered strictly under initiating resumeId.
            updateAssistant(cur => ({
              ...cur,
              afterMarkdown: event.markdown,
              changes: Array.isArray(event.changes) ? event.changes : cur.changes,
              revertedResume: false,
            }))
            setResumeChatState(scope, prev => ({
              ...prev,
              pendingEffects: prev.pendingEffects.some(e => e.requestId === effectiveRequestId && e.type === 'resume-update')
                ? prev.pendingEffects
                : [
                    ...prev.pendingEffects,
                    {
                      type: 'resume-update',
                      requestId: effectiveRequestId,
                      resumeId: scope,
                      baseVersion,
                      baseMarkdown: assistantMsg.beforeMarkdown || '',
                      assistantMsgId: assistantMsg.id,
                      markdown: event.markdown,
                      metaPayload,
                    },
                  ],
            }))
          }
        } else if (event.type === 'appearance-update') {
          const scope = getScope()
          const { matched, cb, drifted } = resolveMatchingCallbacks(scope)
          const directive = {
            templateId: event.template || '',
            patch: event.reset ? { reset: true } : (event.style || {}),
            targetResumeId: scope,
            targetBaseVersion: baseVersion,
            requestId: effectiveRequestId,
          }
          let appliedStyle = false
          if (matched && typeof cb.onApplyStyleDirective === 'function') {
            if (!drifted) {
              cb.onApplyStyleDirective(directive)
              appliedStyle = true
            }
          } else {
            appliedStyle = true
            setResumeChatState(scope, prev => ({
              ...prev,
              pendingEffects: prev.pendingEffects.some(e => e.requestId === effectiveRequestId && e.type === 'appearance-update')
                ? prev.pendingEffects
                : [
                    ...prev.pendingEffects,
                    {
                      type: 'appearance-update',
                      requestId: effectiveRequestId,
                      resumeId: scope,
                      baseVersion,
                      assistantMsgId: assistantMsg.id,
                      directive,
                    },
                  ],
            }))
          }
          if (appliedStyle) {
            updateAssistant(cur => ({
              ...cur,
              appearanceSummary: event.summary || labels.styleAdjusted || '',
              appearanceAccent: event.style?.accent || '',
              revertedAppearance: false,
            }))
          }
        } else if (event.type === 'error') {
          restoreInput()
          updateAssistant(cur => ({
            ...cur,
            error: event.message || labels.modelError || '',
            retryInput: { rawInput: trimmedInput, options: retryOptions },
            status: '',
            streaming: false,
          }))
        } else if (event.type === 'done') {
          updateAssistant(cur => ({
            ...cur,
            status: '',
            streaming: false,
            thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
          }))
        }
      }
    }
    updateAssistant(cur => ({ ...cur, status: '', streaming: false }))
  } catch (reason) {
    if (reason?.name === 'AbortError') {
      updateAssistant(cur => ({ ...cur, status: '', streaming: false, content: cur.content || labels.stoppedReply || '' }))
    } else {
      restoreInput()
      updateAssistant(cur => ({
        ...cur,
        status: '',
        streaming: false,
        error: reason?.message || labels.connectFailed || '',
        retryInput: { rawInput: trimmedInput, options: retryOptions },
      }))
    }
  } finally {
    const scope = getScope()
    const bset = activeStreamBindings.get(scope)
    if (bset) {
      bset.delete(streamBinding)
      if (bset.size === 0) activeStreamBindings.delete(scope)
    }
    if (activeChatControllers.get(scope) === controller) activeChatControllers.delete(scope)
    setResumeChatState(scope, { streaming: false })
  }
}

export function resetDraftStoreForTests() {
  draftMemory.clear()
  draftListeners.clear()
  composerMap.clear()
  composerListeners.clear()
  composerRunningListeners.clear()
  composerInFlight.clear()
  for (const controller of activeChatControllers.values()) {
    try { controller?.abort() } catch {}
  }
  activeChatControllers.clear()
  activeResumeCallbacks.clear()
  activeStreamBindings.clear()
  resumeChatMap.clear()
  resumeChatListeners.clear()
  resumeChatStreamingListeners.clear()
}

if (typeof globalThis.window?.addEventListener === 'function') {
  globalThis.window.addEventListener('niuma:source-forgotten', () => {
    resetResumeChatStore()
  })
}
