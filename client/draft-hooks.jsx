import React from 'react'
import {
  clearDraft,
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  getComposerState,
  getDraft,
  getResumeChatState,
  hasRunningComposer,
  resetResumeChatStore,
  runComposerTask,
  setDraft,
  setResumeChatState,
  startResumeChatStream,
  stopResumeChatStream,
  subscribeComposer,
  subscribeDraft,
  subscribeResumeChat,
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

  const setValue = React.useCallback(nextOrFn => {
    if (!key) {
      setLocalValue(nextOrFn)
      return
    }
    const cur = getDraft(key, initialRef.current)
    const next = typeof nextOrFn === 'function' ? nextOrFn(cur) : nextOrFn
    setDraft(key, next)
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

export function useResumeChatStore() {
  return React.useSyncExternalStore(
    subscribeResumeChat,
    getResumeChatState,
    getResumeChatState,
  )
}

export function useHasResumeChatStreaming() {
  const chat = useResumeChatStore()
  return Boolean(chat?.streaming)
}

export {
  consumeComposerPendingFilter,
  consumeResumeChatPendingEffects,
  resetResumeChatStore,
  runComposerTask,
  setResumeChatState,
  startResumeChatStream,
  stopResumeChatStream,
  updateComposerStore,
}
