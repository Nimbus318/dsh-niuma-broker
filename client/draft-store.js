import {
  captureProfileContext,
  checkProfileMismatch,
  clearProfileSessionPrefix,
  getActiveProfileKey,
  getProfileGeneration,
  isProfileContextCurrent,
  listProfileSessionKeys,
  readProfileSession,
  removeProfileSession,
  sanitizePersistedChatJson,
  sanitizeSettledChatMessage,
  subscribeProfileChange,
  writeProfileSession,
} from './profile-storage.js'

const DRAFT_PREFIX = 'draft.v1:'
const DRAFT_SOURCE_PREFIX = 'draftSources.v1:'
const DRAFT_SOURCE_INDEX_KEY = 'draftSourcesIndex.v1'
const CHAT_STORAGE_PREFIX = 'resumeChat.v2:'
const DEFAULT_CHAT_SCOPE = 'default'

const draftMemory = new Map()
const draftSourcesMemory = new Map()
const draftListeners = new Map()

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

function normalizeSourceIds(sourceIds) {
  const list = Array.isArray(sourceIds) ? sourceIds : (sourceIds ? [sourceIds] : [])
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function readDraftSourceIndex() {
  try {
    const raw = readProfileSession(DRAFT_SOURCE_INDEX_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(k => typeof k === 'string' && k) : []
  } catch {
    return []
  }
}

function writeDraftSourceIndex(keys) {
  try {
    if (!keys.length) removeProfileSession(DRAFT_SOURCE_INDEX_KEY)
    else writeProfileSession(DRAFT_SOURCE_INDEX_KEY, JSON.stringify(keys))
  } catch {}
}

export function getDraftSources(key) {
  if (!key) return []
  if (draftSourcesMemory.has(key)) return draftSourcesMemory.get(key)
  try {
    const raw = readProfileSession(DRAFT_SOURCE_PREFIX + key)
    if (raw != null) {
      const parsed = normalizeSourceIds(JSON.parse(raw))
      draftSourcesMemory.set(key, parsed)
      return parsed
    }
  } catch {}
  return []
}

function setDraftSources(key, sourceIds) {
  if (!key) return
  const normalized = normalizeSourceIds(sourceIds)
  if (!normalized.length) {
    draftSourcesMemory.delete(key)
    removeProfileSession(DRAFT_SOURCE_PREFIX + key)
    const idx = readDraftSourceIndex().filter(k => k !== key)
    writeDraftSourceIndex(idx)
    return
  }
  draftSourcesMemory.set(key, normalized)
  writeProfileSession(DRAFT_SOURCE_PREFIX + key, JSON.stringify(normalized))
  const idx = readDraftSourceIndex()
  if (!idx.includes(key)) writeDraftSourceIndex([...idx, key])
}

export function sourceMatchesForgotten(sources, forgottenSourceId = '') {
  if (!Array.isArray(sources) || sources.length === 0) return false
  const target = String(forgottenSourceId || '').trim()
  if (!target) return true
  if (sources.includes(target)) return true
  if (target === 'transcript') {
    return sources.some(s => s === 'transcript' || s.startsWith('recording:'))
  }
  return false
}

export function getDraft(key, fallback = '') {
  if (!key) return fallback
  if (draftMemory.has(key)) return draftMemory.get(key)
  try {
    const raw = readProfileSession(DRAFT_PREFIX + key)
    if (raw != null) {
      const parsed = JSON.parse(raw)
      draftMemory.set(key, parsed)
      return parsed
    }
  } catch {}
  return fallback
}

export function setDraft(key, value, options = null) {
  if (!key) return
  if (isEmptyDraftValue(value)) {
    draftMemory.delete(key)
    setDraftSources(key, [])
    removeProfileSession(DRAFT_PREFIX + key)
    notifyDraft(key)
    return
  }
  draftMemory.set(key, value)
  if (options && Object.prototype.hasOwnProperty.call(options, 'sourceIds')) {
    setDraftSources(key, options.sourceIds)
  }
  writeProfileSession(DRAFT_PREFIX + key, JSON.stringify(value))
  notifyDraft(key)
}

export function clearDraft(key) {
  setDraft(key, null)
}

export function invalidateDraftsBySource(sourceId = '') {
  const candidates = new Set(draftSourcesMemory.keys())
  for (const k of readDraftSourceIndex()) candidates.add(k)
  for (const scopedKey of listProfileSessionKeys(DRAFT_SOURCE_PREFIX)) {
    candidates.add(scopedKey.slice(DRAFT_SOURCE_PREFIX.length))
  }
  let cleared = 0
  for (const key of candidates) {
    if (sourceMatchesForgotten(getDraftSources(key), sourceId)) {
      clearDraft(key)
      cleared += 1
    }
  }
  for (const bindings of activeStreamBindings.values()) {
    for (const binding of bindings) {
      if (sourceMatchesForgotten(binding?.sourceIds, sourceId)) {
        binding.markForgotten?.()
      }
    }
  }
  return cleared
}

// ---------- Scoped Composer Store (survives tab switches + drawer close/reopen) ----------

const composerMap = new Map()
const composerListeners = new Map()
const composerRunningListeners = new Set()
const composerInFlight = new Set()
const composerControllers = new Map()

export function stopComposerTask(scopeKey) {
  const key = scopeKey || 'jobs'
  const controller = composerControllers.get(key)
  if (!controller) return false
  try { controller.abort() } catch {}
  return true
}

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
  const ctxSnap = captureProfileContext()
  const controller = new AbortController()
  composerInFlight.add(key)
  composerControllers.set(key, controller)
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
    let aborted = false
    try {
      reply = await runnerFn(controller.signal)
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        aborted = true
        reply = null
      } else {
        reply = { ok: false, error: err?.message || '' }
      }
    }
    if (!isProfileContextCurrent(ctxSnap)) return reply
    if (aborted || controller.signal.aborted) {
      if (typeof overrideText !== 'string' && nextText && !getComposerState(key).text) {
        updateComposerStore(key, { text: nextText })
      }
      return { ok: false, aborted: true }
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
    if (composerControllers.get(key) === controller) composerControllers.delete(key)
    if (isProfileContextCurrent(ctxSnap)) {
      composerInFlight.delete(key)
      updateComposerStore(key, { submitting: false })
    }
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

const scrubbedChatGenerations = new Set()

function scrubProfileResumeChatsOnce() {
  const marker = `${getActiveProfileKey()}:${getProfileGeneration()}`
  if (scrubbedChatGenerations.has(marker)) return
  scrubbedChatGenerations.add(marker)
  for (const key of listProfileSessionKeys(CHAT_STORAGE_PREFIX)) {
    const raw = readProfileSession(key)
    if (!raw) continue
    const { text, dirty } = sanitizePersistedChatJson(raw)
    if (dirty && text) writeProfileSession(key, text)
  }
}

function loadSavedChat(scopeId) {
  try {
    scrubProfileResumeChatsOnce()
    const key = CHAT_STORAGE_PREFIX + scopeId
    const raw = readProfileSession(key)
    const { messages, text, dirty } = sanitizePersistedChatJson(raw)
    if (dirty && text) writeProfileSession(key, text)
    return messages
  } catch {
    return []
  }
}

function saveSettledChat(scopeId, messages) {
  try {
    const settled = (Array.isArray(messages) ? messages : [])
      .filter(m => !m.streaming)
      .slice(-16)
      .map(sanitizeSettledChatMessage)
    if (settled.length) writeProfileSession(CHAT_STORAGE_PREFIX + scopeId, JSON.stringify(settled))
    else removeProfileSession(CHAT_STORAGE_PREFIX + scopeId)
  } catch {}
}

function clearAllSavedChats() {
  clearProfileSessionPrefix(CHAT_STORAGE_PREFIX)
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
      const fromSources = getDraftSources(fromKey)
      if (!getDraft(toKey, '')) setDraft(toKey, val, fromSources.length ? { sourceIds: fromSources } : null)
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
    for (const binding of activeStreamBindings.get(key) ?? []) {
      binding.markForgotten?.()
    }
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
  for (const bindings of activeStreamBindings.values()) {
    for (const binding of bindings) {
      binding.markForgotten?.()
    }
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
  inputSourceIds = [],
  retryOptions = {},
  callbacksRef = null,
  resumeId = DEFAULT_CHAT_SCOPE,
  baseVersion = '',
  requestId = '',
  labels = {},
  onRestoreInput = null,
}) {
  const effectiveRequestId = requestId || globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const ctxSnap = captureProfileContext()
  const requestHeaders = {
    ...(headers || {}),
    ...(ctxSnap.profileKey ? { 'x-career-profile-key': ctxSnap.profileKey } : {}),
  }
  const requestSourceIds = normalizeSourceIds(inputSourceIds?.length ? inputSourceIds : retryOptions?.sourceIds)
  const preservedRetryOptions = requestSourceIds.length ? { ...(retryOptions || {}), sourceIds: requestSourceIds } : retryOptions
  let streamScope = normalizeScopeId(resumeId)
  const getScope = () => streamScope
  if (ensureResumeChatState(getScope()).streaming) return
  const controller = new AbortController()
  activeChatControllers.set(getScope(), controller)
  let forgottenBySource = false
  const isStale = () => forgottenBySource || !isProfileContextCurrent(ctxSnap)
  const streamBinding = {
    sourceIds: requestSourceIds,
    markForgotten() {
      forgottenBySource = true
      try { controller.abort() } catch {}
    },
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

  const createInitialTrace = (turnId, existing = null) => ({
    turnId,
    startedAt: existing?.startedAt || Date.now(),
    attemptStartedAt: existing?.attemptStartedAt || 0,
    elapsedMs: existing?.elapsedMs || 0,
    outcome: 'running',
    route: existing?.route || '',
    modelName: existing?.modelName || '',
    effort: existing?.effort || '',
    contextItems: Array.isArray(existing?.contextItems) ? existing.contextItems : [],
    citedEvidenceCount: Number(existing?.citedEvidenceCount) || 0,
    artifactState: existing?.artifactState || '',
    thinkingText: existing?.thinkingText || '',
    thinkingStartedAt: existing?.thinkingStartedAt || 0,
    thinkingMs: existing?.thinkingMs || 0,
    steps: Array.isArray(existing?.steps) ? existing.steps : [],
  })

  const finalizeSteps = (steps, terminalState) => (Array.isArray(steps) ? steps : []).map(step => (
    step?.state === 'ongoing' ? { ...step, state: terminalState } : step
  ))

  const freezeThinkingMs = trace => {
    if (trace.thinkingMs > 0) return trace.thinkingMs
    return trace.thinkingStartedAt ? Math.max(100, Date.now() - trace.thinkingStartedAt) : 0
  }

  const stampedUserMsg = { ...userMsg, resumeId: getScope(), baseVersion, requestId: effectiveRequestId }
  const stampedAssistantMsg = {
    ...assistantMsg,
    resumeId: getScope(),
    baseVersion,
    requestId: effectiveRequestId,
    trace: createInitialTrace(effectiveRequestId, assistantMsg?.trace),
  }

  setResumeChatState(getScope(), prev => ({
    ...prev,
    messages: [...prev.messages, stampedUserMsg, stampedAssistantMsg],
    expanded: true,
    streaming: true,
  }))

  const updateAssistant = updater => {
    if (isStale()) return
    const scope = getScope()
    setResumeChatState(scope, prev => ({
      ...prev,
      messages: prev.messages.map(item => (item.id === assistantMsg.id ? updater(item) : item)),
    }))
  }

  const resolveMatchingCallbacks = scope => {
    if (isStale()) return { matched: false, cb: null, drifted: false }
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
    if (isStale() || controller.signal.aborted) return
    const scope = getScope()
    const { matched } = resolveMatchingCallbacks(scope)
    if (matched && typeof onRestoreInput === 'function') {
      onRestoreInput(trimmedInput, requestSourceIds)
    } else if (trimmedInput) {
      const key = scope && scope !== DEFAULT_CHAT_SCOPE ? `resume-agent:${scope}:text` : 'resume-agent:text'
      const cur = getDraft(key, '')
      if (!cur) setDraft(key, trimmedInput, requestSourceIds.length ? { sourceIds: requestSourceIds } : null)
    }
  }

  let lastSeq = 0
  let receivedDone = false

  try {
    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const failed = await response.json().catch(() => null)
      if (checkProfileMismatch(response, failed)) {
        forgottenBySource = !isProfileContextCurrent(ctxSnap)
        if (!forgottenBySource) {
          throw new Error(failed?.error || `${labels.requestFailed || 'Request failed'} (${response.status})`)
        }
        return
      }
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
      if (done || isStale()) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        if (isStale()) break
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (!event || typeof event !== 'object') continue
        if (event.turnId && event.turnId !== effectiveRequestId) continue
        if (Number.isInteger(event.seq)) {
          if (event.seq <= lastSeq) continue
          lastSeq = event.seq
        }

        if (event.type === 'context') {
          const items = Array.isArray(event.items) ? event.items : []
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            return { ...cur, trace: { ...trace, contextItems: items } }
          })
        } else if (event.type === 'attempt') {
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const now = Date.now()
            let steps = trace.steps
            if (event.reason === 'language-repair') {
              const retryId = `retry:${event.attemptId || steps.length}`
              if (!steps.some(s => s.id === retryId)) {
                steps = [...steps, { id: retryId, kind: 'retry', name: 'language-repair', state: 'ongoing', startedAt: now, summary: '' }]
              }
            }
            const nextAttemptStart = event.reason === 'primary'
              ? (trace.attemptStartedAt || now)
              : now
            return {
              ...cur,
              trace: {
                ...trace,
                attemptStartedAt: nextAttemptStart,
                route: event.route || trace.route,
                modelName: event.modelName || trace.modelName,
                effort: typeof event.effort === 'string' ? event.effort : trace.effort,
                steps,
              },
            }
          })
        } else if (event.type === 'status') {
          updateAssistant(cur => ({ ...cur, status: event.text || labels.processingEllipsis || '' }))
        } else if (event.type === 'thinking') {
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const startedAt = trace.thinkingStartedAt || trace.attemptStartedAt || trace.startedAt || Date.now()
            const nextThinking = `${trace.thinkingText || ''}${event.delta || ''}`.slice(0, 8000)
            return {
              ...cur,
              trace: { ...trace, thinkingStartedAt: startedAt, thinkingText: nextThinking },
            }
          })
        } else if (event.type === 'tool-preparing') {
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const normAttempt = event.attemptId || ''
            const toolName = event.name || ''
            const prepId = `prep:${normAttempt || 'a1'}:${event.index ?? 0}:${toolName}`
            if (trace.steps.some(s => s.id === prepId)) return cur
            const tMs = freezeThinkingMs(trace)
            return {
              ...cur,
              thinkingMs: tMs,
              trace: {
                ...trace,
                thinkingMs: tMs,
                steps: [...trace.steps, {
                  id: prepId,
                  kind: 'tool',
                  attemptId: normAttempt,
                  name: toolName,
                  state: 'ongoing',
                  startedAt: Date.now(),
                  summary: '',
                }],
              },
            }
          })
        } else if (event.type === 'text') {
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const tMs = freezeThinkingMs(trace)
            return {
              ...cur,
              status: '',
              thinkingMs: tMs,
              trace: { ...trace, thinkingMs: tMs },
              content: cur.content + (event.delta || ''),
            }
          })
        } else if (event.type === 'tool-start' && event.callId) {
          const normAttempt = event.attemptId || ''
          const toolName = event.name || ''
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            if (trace.steps.some(s => s.id === event.callId)) return cur
            const tMs = freezeThinkingMs(trace)
            const prepIdx = trace.steps.findIndex(s => s.id.startsWith('prep:') && s.name === toolName && (!normAttempt || !s.attemptId || s.attemptId === normAttempt))
            const existingPrep = prepIdx >= 0 ? trace.steps[prepIdx] : null
            const nextStep = {
              id: event.callId,
              kind: 'tool',
              attemptId: normAttempt,
              name: toolName,
              state: 'ongoing',
              startedAt: existingPrep?.startedAt || Date.now(),
              summary: '',
            }
            const nextSteps = prepIdx >= 0
              ? trace.steps.map((s, idx) => (idx === prepIdx ? nextStep : s))
              : [...trace.steps, nextStep]
            return {
              ...cur,
              thinkingMs: tMs,
              trace: { ...trace, thinkingMs: tMs, steps: nextSteps },
            }
          })
        } else if (event.type === 'tool-end' && event.callId) {
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const now = Date.now()
            const nextSteps = trace.steps.map(step => {
              if (step.id === event.callId) {
                return {
                  ...step,
                  state: event.ok ? 'done' : 'error',
                  elapsedMs: step.startedAt ? Math.max(100, now - step.startedAt) : 0,
                  summary: event.summary || '',
                  ...(event.languageMismatch ? { languageMismatch: true } : {}),
                }
              }
              if (step.kind === 'retry' && step.state === 'ongoing' && event.ok) {
                return {
                  ...step,
                  state: 'done',
                  elapsedMs: step.startedAt ? Math.max(100, now - step.startedAt) : 0,
                }
              }
              return step
            })
            return {
              ...cur,
              trace: { ...trace, steps: nextSteps },
            }
          })
        } else if (event.type === 'resume-update' && event.markdown) {
          if (isStale()) break
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
          const citedCount = Number.isFinite(Number(event.citedEvidenceCount))
            ? Number(event.citedEvidenceCount)
            : (Array.isArray(event.evidenceIds) ? event.evidenceIds.length : 0)
          const settleMatchingToolStep = (steps, toolName) => (Array.isArray(steps) ? steps : []).map(step => (
            step?.state === 'ongoing' && step.name === toolName ? { ...step, state: 'done' } : step
          ))
          if (matched && typeof cb.onStageProposal === 'function') {
            const outcome = cb.onStageProposal(event.markdown, metaPayload)
            updateAssistant(cur => {
              const trace = cur.trace || createInitialTrace(effectiveRequestId)
              return {
                ...cur,
                afterMarkdown: outcome === 'noop' ? null : event.markdown,
                changes: Array.isArray(event.changes) ? event.changes : cur.changes,
                stagedForReview: outcome === 'staged',
                noOpUpdate: outcome === 'noop',
                revertedResume: false,
                trace: {
                  ...trace,
                  citedEvidenceCount: Math.max(trace.citedEvidenceCount || 0, citedCount),
                  artifactState: outcome === 'noop' ? 'noop' : outcome === 'staged' ? 'staged' : 'applied',
                  steps: settleMatchingToolStep(trace.steps, 'update_resume'),
                },
              }
            })
          } else if (matched && !drifted && typeof cb.onApplyMarkdown === 'function') {
            cb.onApplyMarkdown(event.markdown, metaPayload)
            updateAssistant(cur => {
              const trace = cur.trace || createInitialTrace(effectiveRequestId)
              return {
                ...cur,
                afterMarkdown: event.markdown,
                changes: Array.isArray(event.changes) ? event.changes : cur.changes,
                stagedForReview: false,
                noOpUpdate: false,
                revertedResume: false,
                trace: {
                  ...trace,
                  citedEvidenceCount: Math.max(trace.citedEvidenceCount || 0, citedCount),
                  artifactState: 'applied',
                  steps: settleMatchingToolStep(trace.steps, 'update_resume'),
                },
              }
            })
          } else {
            // Detached or user opened a different resume: keep effect buffered strictly under initiating resumeId.
            updateAssistant(cur => {
              const trace = cur.trace || createInitialTrace(effectiveRequestId)
              return {
                ...cur,
                afterMarkdown: event.markdown,
                changes: Array.isArray(event.changes) ? event.changes : cur.changes,
                revertedResume: false,
                trace: {
                  ...trace,
                  citedEvidenceCount: Math.max(trace.citedEvidenceCount || 0, citedCount),
                  artifactState: 'buffered',
                  steps: settleMatchingToolStep(trace.steps, 'update_resume'),
                },
              }
            })
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
          if (isStale()) break
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
            updateAssistant(cur => {
              const trace = cur.trace || createInitialTrace(effectiveRequestId)
              return {
                ...cur,
                appearanceSummary: event.summary || labels.styleAdjusted || '',
                appearanceAccent: event.style?.accent || '',
                revertedAppearance: false,
                trace: {
                  ...trace,
                  steps: (trace.steps || []).map(step => (
                    step?.state === 'ongoing' && step.name === 'update_appearance' ? { ...step, state: 'done' } : step
                  )),
                },
              }
            })
          }
        } else if (event.type === 'error') {
          receivedDone = true
          if (isStale() || controller.signal.aborted) break
          restoreInput()
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const tMs = freezeThinkingMs(trace)
            return {
              ...cur,
              error: event.message || labels.modelError || '',
              retryInput: { rawInput: trimmedInput, options: preservedRetryOptions },
              status: '',
              streaming: false,
              thinkingMs: tMs,
              trace: {
                ...trace,
                outcome: 'error',
                thinkingMs: tMs,
                elapsedMs: Math.max(100, Date.now() - trace.startedAt),
                steps: finalizeSteps(trace.steps, 'error'),
              },
            }
          })
        } else if (event.type === 'done') {
          receivedDone = true
          updateAssistant(cur => {
            const trace = cur.trace || createInitialTrace(effectiveRequestId)
            const tMs = freezeThinkingMs(trace)
            const nextSteps = finalizeSteps(trace.steps, 'done')
            return {
              ...cur,
              status: '',
              streaming: false,
              thinkingMs: tMs,
              trace: {
                ...trace,
                outcome: event.outcome || 'ok',
                elapsedMs: Number(event.elapsedMs) || Math.max(100, Date.now() - trace.startedAt),
                route: event.route || trace.route,
                modelName: event.modelName || trace.modelName,
                effort: typeof event.effort === 'string' && event.effort ? event.effort : trace.effort,
                thinkingMs: tMs,
                steps: nextSteps,
              },
            }
          })
        }
      }
      if (isStale()) break
    }
    if (!isStale() && !receivedDone && !controller.signal.aborted) {
      updateAssistant(cur => {
        const trace = cur.trace || createInitialTrace(effectiveRequestId)
        const tMs = freezeThinkingMs(trace)
        return {
          ...cur,
          status: '',
          streaming: false,
          thinkingMs: tMs,
          retryInput: cur.retryInput || { rawInput: trimmedInput, options: preservedRetryOptions },
          trace: {
            ...trace,
            outcome: 'interrupted',
            thinkingMs: tMs,
            elapsedMs: Math.max(100, Date.now() - trace.startedAt),
            steps: finalizeSteps(trace.steps, 'error'),
          },
        }
      })
    } else if (!isStale()) {
      updateAssistant(cur => ({ ...cur, status: '', streaming: false }))
    }
  } catch (reason) {
    if (isStale()) {
      return
    }
    if (reason?.name === 'AbortError') {
      updateAssistant(cur => {
        const trace = cur.trace || createInitialTrace(effectiveRequestId)
        const tMs = freezeThinkingMs(trace)
        return {
          ...cur,
          status: '',
          streaming: false,
          thinkingMs: tMs,
          content: cur.content || labels.stoppedReply || '',
          retryInput: { rawInput: trimmedInput, options: preservedRetryOptions },
          trace: {
            ...trace,
            outcome: 'stopped',
            thinkingMs: tMs,
            elapsedMs: Math.max(100, Date.now() - trace.startedAt),
            steps: finalizeSteps(trace.steps, 'stopped'),
          },
        }
      })
    } else {
      restoreInput()
      updateAssistant(cur => {
        const trace = cur.trace || createInitialTrace(effectiveRequestId)
        const tMs = freezeThinkingMs(trace)
        return {
          ...cur,
          status: '',
          streaming: false,
          thinkingMs: tMs,
          error: reason?.message || labels.connectFailed || '',
          retryInput: { rawInput: trimmedInput, options: preservedRetryOptions },
          trace: {
            ...trace,
            outcome: 'error',
            thinkingMs: tMs,
            elapsedMs: Math.max(100, Date.now() - trace.startedAt),
            steps: finalizeSteps(trace.steps, 'error'),
          },
        }
      })
    }
  } finally {
    if (isProfileContextCurrent(ctxSnap)) {
      const scope = getScope()
      const bset = activeStreamBindings.get(scope)
      if (bset) {
        bset.delete(streamBinding)
        if (bset.size === 0) activeStreamBindings.delete(scope)
      }
      if (activeChatControllers.get(scope) === controller) activeChatControllers.delete(scope)
      if (!forgottenBySource) setResumeChatState(scope, { streaming: false })
    }
  }
}

function clearVolatileDraftStoreState() {
  for (const bindings of activeStreamBindings.values()) {
    for (const binding of bindings) {
      binding.markForgotten?.()
    }
  }
  for (const controller of composerControllers.values()) {
    try { controller?.abort() } catch {}
  }
  for (const controller of activeChatControllers.values()) {
    try { controller?.abort() } catch {}
  }
  const staleDraftKeys = [...draftMemory.keys()]
  const staleComposerKeys = [...composerMap.keys()]
  const staleChatScopes = new Set([DEFAULT_CHAT_SCOPE, ...resumeChatMap.keys(), ...resumeChatListeners.keys()])
  draftMemory.clear()
  draftSourcesMemory.clear()
  composerMap.clear()
  composerInFlight.clear()
  composerControllers.clear()
  activeChatControllers.clear()
  activeResumeCallbacks.clear()
  activeStreamBindings.clear()
  resumeChatMap.clear()
  scrubbedChatGenerations.clear()
  for (const k of staleDraftKeys) notifyDraft(k)
  for (const k of draftListeners.keys()) {
    if (!staleDraftKeys.includes(k)) notifyDraft(k)
  }
  for (const k of new Set([...staleComposerKeys, ...composerListeners.keys()])) {
    const set = composerListeners.get(k)
    if (set) for (const fn of set) { try { fn() } catch {} }
  }
  for (const fn of composerRunningListeners) {
    try { fn() } catch {}
  }
  for (const k of staleChatScopes) {
    notifyResumeChatScope(k, true)
  }
  for (const fn of resumeChatStreamingListeners) {
    try { fn() } catch {}
  }
}

subscribeProfileChange(() => {
  clearVolatileDraftStoreState()
  scrubProfileResumeChatsOnce()
})

export function resetDraftStoreForTests() {
  draftListeners.clear()
  composerListeners.clear()
  composerRunningListeners.clear()
  resumeChatListeners.clear()
  resumeChatStreamingListeners.clear()
  clearVolatileDraftStoreState()
}

if (typeof globalThis.window?.addEventListener === 'function') {
  globalThis.window.addEventListener('niuma:source-forgotten', event => {
    const sourceId = typeof event?.detail?.sourceId === 'string' ? event.detail.sourceId.trim() : ''
    resetResumeChatStore()
    invalidateDraftsBySource(sourceId)
  })
}
