import React from 'react'
import {
  clearDraft,
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  getComposerState,
  getDraft,
  getDraftSources,
  getResumeChatState,
  hasAnyResumeChatStreaming,
  hasRunningComposer,
  invalidateDraftsBySource,
  migrateResumeChatScope,
  registerResumeChatCallbacks,
  resetResumeChatStore,
  runComposerTask,
  setDraft,
  setResumeChatState,
  sourceMatchesForgotten,
  startResumeChatStream,
  stopComposerTask,
  stopResumeChatStream,
  subscribeComposer,
  subscribeDraft,
  subscribeResumeChat,
  subscribeResumeChatStreaming,
  subscribeRunningComposers,
  updateComposerStore,
} from './draft-store.js'

export function usePersistedDraft(key, initialValue = '') {
  const initialRef = React.useRef(initialValue)
  initialRef.current = initialValue

  const [localValue, setLocalValue] = React.useState(initialValue)
  const storedValue = React.useSyncExternalStore(
    React.useCallback(listener => subscribeDraft(key, listener), [key]),
    () => (key ? getDraft(key, initialRef.current) : localValue),
    () => initialRef.current,
  )

  const setValue = React.useCallback((nextOrFn, options = null) => {
    if (!key) {
      setLocalValue(nextOrFn)
      return
    }
    const cur = getDraft(key, initialRef.current)
    const next = typeof nextOrFn === 'function' ? nextOrFn(cur) : nextOrFn
    setDraft(key, next, options)
  }, [key])

  const clearValue = React.useCallback(() => {
    if (!key) {
      setLocalValue(initialRef.current)
      return
    }
    clearDraft(key)
  }, [key])

  return [key ? storedValue : localValue, setValue, clearValue]
}

export function useComposerStore(scopeKey) {
  const state = React.useSyncExternalStore(
    React.useCallback(listener => subscribeComposer(scopeKey, listener), [scopeKey]),
    () => getComposerState(scopeKey),
    () => getComposerState(scopeKey),
  )
  const update = React.useCallback(patchOrFn => updateComposerStore(scopeKey, patchOrFn), [scopeKey])
  return [state, update]
}

export function useHasRunningComposer(scopeKey = '') {
  return React.useSyncExternalStore(
    subscribeRunningComposers,
    () => hasRunningComposer(scopeKey),
    () => false,
  )
}

export function useResumeChatStore(resumeId = 'default') {
  return React.useSyncExternalStore(
    React.useCallback(listener => subscribeResumeChat(resumeId, listener), [resumeId]),
    () => getResumeChatState(resumeId),
    () => getResumeChatState(resumeId),
  )
}

export function useHasResumeChatStreaming() {
  return React.useSyncExternalStore(
    subscribeResumeChatStreaming,
    hasAnyResumeChatStreaming,
    () => false,
  )
}

export {
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  getDraft,
  getDraftSources,
  invalidateDraftsBySource,
  migrateResumeChatScope,
  registerResumeChatCallbacks,
  resetResumeChatStore,
  runComposerTask,
  setResumeChatState,
  sourceMatchesForgotten,
  startResumeChatStream,
  stopComposerTask,
  stopResumeChatStream,
  updateComposerStore,
}
