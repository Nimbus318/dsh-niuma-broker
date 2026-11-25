const DRAFT_PREFIX = 'niuma.draft.v1:'
const CHAT_STORAGE_KEY = 'niuma.resumeChat.v1'

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

// ---------- Resume Chat Singleton Stream Store (survives tab switches) ----------

function loadSavedChat() {
  const storage = getStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(CHAT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(m => m && m.id && m.role).slice(-16) : []
  } catch {
    return []
  }
}

function saveSettledChat(messages) {
  const storage = getStorage()
  if (!storage) return
  try {
    const settled = (Array.isArray(messages) ? messages : []).filter(m => !m.streaming).slice(-16)
    if (settled.length) storage.setItem(CHAT_STORAGE_KEY, JSON.stringify(settled))
    else storage.removeItem(CHAT_STORAGE_KEY)
  } catch {}
}

let resumeChatState = null
const resumeChatListeners = new Set()
let activeChatController = null

function ensureResumeChatState() {
  if (!resumeChatState) {
    const saved = loadSavedChat()
    resumeChatState = {
      messages: saved,
      expanded: saved.length > 0,
      fullPane: false,
      streaming: false,
      pendingEffects: [],
    }
  }
  return resumeChatState
}

export function getResumeChatState() {
  return ensureResumeChatState()
}

export function subscribeResumeChat(fn) {
  resumeChatListeners.add(fn)
  return () => { resumeChatListeners.delete(fn) }
}

export function setResumeChatState(updater) {
  const prev = ensureResumeChatState()
  const patch = typeof updater === 'function' ? updater(prev) : (updater ?? {})
  if (!patch || typeof patch !== 'object') return prev
  const next = { ...prev, ...patch }
  resumeChatState = next
  if (next.messages !== prev.messages) saveSettledChat(next.messages)
  for (const fn of resumeChatListeners) {
    try { fn() } catch {}
  }
  return next
}

export function stopResumeChatStream() {
  activeChatController?.abort()
  activeChatController = null
  setResumeChatState({ streaming: false })
}

export function resetResumeChatStore() {
  activeChatController?.abort()
  activeChatController = null
  resumeChatState = {
    messages: [],
    expanded: false,
    fullPane: false,
    streaming: false,
    pendingEffects: [],
  }
  saveSettledChat([])
  for (const fn of resumeChatListeners) {
    try { fn() } catch {}
  }
}

export function consumeResumeChatPendingEffects() {
  const cur = ensureResumeChatState()
  if (!cur.pendingEffects.length) return []
  const effects = cur.pendingEffects.slice()
  setResumeChatState({ pendingEffects: [] })
  return effects
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
  labels = {},
  onRestoreInput = null,
}) {
  if (ensureResumeChatState().streaming) return
  const controller = new AbortController()
  activeChatController = controller

  setResumeChatState(prev => ({
    ...prev,
    messages: [...prev.messages, userMsg, assistantMsg],
    expanded: true,
    streaming: true,
  }))

  const updateAssistant = updater => {
    setResumeChatState(prev => ({
      ...prev,
      messages: prev.messages.map(item => (item.id === assistantMsg.id ? updater(item) : item)),
    }))
  }

  const restoreInput = () => {
    if (callbacksRef?.current && typeof onRestoreInput === 'function') {
      onRestoreInput(trimmedInput)
    } else if (trimmedInput) {
      const cur = getDraft('resume-agent:text', '')
      if (!cur) setDraft('resume-agent:text', trimmedInput)
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
          const metaPayload = {
            source: 'ai',
            sourceKind: 'chat',
            sourceLabel: labels.jobLabel || labels.sourceChatLabel || '',
            changes: Array.isArray(event.changes) ? event.changes : [],
            ...(Array.isArray(event.evidenceIds) && event.evidenceIds.length ? { evidenceIds: event.evidenceIds } : {}),
            ...(Array.isArray(event.changeProvenance) && event.changeProvenance.length ? { changeProvenance: event.changeProvenance } : {}),
            ...(labels.inheritedJobId ? { opportunityId: labels.inheritedJobId } : {}),
            ...(labels.jobTitle ? { title: labels.jobTitle } : {}),
          }
          const cb = callbacksRef?.current
          if (cb && typeof cb.onStageProposal === 'function') {
            const outcome = cb.onStageProposal(event.markdown, metaPayload)
            updateAssistant(cur => ({
              ...cur,
              afterMarkdown: outcome === 'noop' ? null : event.markdown,
              changes: Array.isArray(event.changes) ? event.changes : cur.changes,
              stagedForReview: outcome === 'staged',
              noOpUpdate: outcome === 'noop',
              revertedResume: false,
            }))
          } else if (cb && typeof cb.onApplyMarkdown === 'function') {
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
            // Detached while user switched tabs: apply upon remount without dropping the update.
            updateAssistant(cur => ({
              ...cur,
              afterMarkdown: event.markdown,
              changes: Array.isArray(event.changes) ? event.changes : cur.changes,
              revertedResume: false,
            }))
            setResumeChatState(prev => ({
              ...prev,
              pendingEffects: [
                ...prev.pendingEffects,
                { type: 'resume-update', assistantMsgId: assistantMsg.id, markdown: event.markdown, metaPayload },
              ],
            }))
          }
        } else if (event.type === 'appearance-update') {
          const directive = {
            templateId: event.template || '',
            patch: event.reset ? { reset: true } : (event.style || {}),
          }
          const cb = callbacksRef?.current
          if (cb && typeof cb.onApplyStyleDirective === 'function') {
            cb.onApplyStyleDirective(directive)
          } else {
            setResumeChatState(prev => ({
              ...prev,
              pendingEffects: [
                ...prev.pendingEffects,
                { type: 'appearance-update', directive },
              ],
            }))
          }
          updateAssistant(cur => ({
            ...cur,
            appearanceSummary: event.summary || labels.styleAdjusted || '',
            appearanceAccent: event.style?.accent || '',
            revertedAppearance: false,
          }))
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
    if (activeChatController === controller) activeChatController = null
    setResumeChatState({ streaming: false })
  }
}

export function resetDraftStoreForTests() {
  draftMemory.clear()
  draftListeners.clear()
  composerMap.clear()
  composerListeners.clear()
  composerRunningListeners.clear()
  composerInFlight.clear()
  activeChatController?.abort()
  activeChatController = null
  resumeChatState = null
  resumeChatListeners.clear()
}

if (typeof globalThis.window?.addEventListener === 'function') {
  globalThis.window.addEventListener('niuma:source-forgotten', () => {
    resetResumeChatStore()
  })
}
