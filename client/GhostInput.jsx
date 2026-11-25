import React from 'react'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'

export default function GhostInput({
  value = '',
  onChange,
  onSubmit,
  placeholder = '',
  ariaLabel = '',
  disabled = false,
  maxLength = 20000,
  minRows = 1,
  surface = 'resume',
  suggestContext = null,
  fallbackSuggestion = '',
  inputRef: externalRef,
  className = '',
}) {
  const { locale } = useI18n()
  const innerRef = React.useRef(null)
  const mirrorRef = React.useRef(null)
  const composingRef = React.useRef(false)
  const abortRef = React.useRef(null)
  const skipNextSuggestRef = React.useRef(false)
  const revealTimerRef = React.useRef(null)
  const [prediction, setPrediction] = React.useState(null)
  const [dismissedKey, setDismissedKey] = React.useState('')
  const [reveal, setReveal] = React.useState(null)
  const [composing, setComposing] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const requestSeqRef = React.useRef(0)
  const textareaRef = externalRef || innerRef

  const contextKey = suggestContext?.key ?? ''
  const activeContextKey = JSON.stringify([locale, surface, suggestContext?.model, contextKey])
  const currentPrediction = prediction?.contextKey === activeContextKey ? prediction.full : ''
  const suggestEnabled = !disabled && Boolean(suggestContext?.enabled)

  const focusedRef = React.useRef(focused)
  focusedRef.current = focused
  const valueRef = React.useRef(value)
  valueRef.current = value
  const enabledRef = React.useRef(suggestEnabled)
  enabledRef.current = suggestEnabled
  const contextKeyRef = React.useRef(activeContextKey)
  contextKeyRef.current = activeContextKey

  React.useEffect(() => {
    const el = textareaRef.current
    if (el && typeof document !== 'undefined' && document.activeElement === el) {
      setFocused(true)
    }
    return () => {
      requestSeqRef.current += 1
      abortRef.current?.abort()
      window.clearTimeout(revealTimerRef.current)
    }
  }, [textareaRef])

  // Reset cached prediction cleanly when context, selection, authorization, or language changes.
  React.useEffect(() => {
    requestSeqRef.current += 1
    abortRef.current?.abort()
    setPrediction(null)
    setDismissedKey('')
  }, [activeContextKey, suggestEnabled])

  // Speculative mid-sentence prefix completion: only fires when focused, non-empty, and authorized.
  React.useEffect(() => {
    if (!focused || !suggestEnabled || composing || composingRef.current || !value.trim()) {
      requestSeqRef.current += 1
      abortRef.current?.abort()
      setPrediction(null)
      return
    }
    if (skipNextSuggestRef.current) {
      skipNextSuggestRef.current = false
      return
    }

    // 0ms prefix-hit: if current text already extends the cached prediction, shrink suffix immediately.
    if (currentPrediction.startsWith(value) && currentPrediction.length > value.length) {
      return
    }

    const requestPrefix = value
    const requestContextKey = activeContextKey
    const seq = ++requestSeqRef.current
    const timer = window.setTimeout(async () => {
      if (
        seq !== requestSeqRef.current
        || !focusedRef.current
        || !enabledRef.current
        || composingRef.current
        || contextKeyRef.current !== requestContextKey
        || valueRef.current !== requestPrefix
        || !requestPrefix.trim()
      ) return
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const payload = {
          surface,
          prefix: requestPrefix.slice(0, 300),
          ...(surface === 'resume' ? {
            template: suggestContext.template ?? 'onyx',
            style: suggestContext.style ?? {},
          } : {}),
          history: Array.isArray(suggestContext.history) ? suggestContext.history.slice(-4) : [],
          opportunityId: suggestContext.opportunityId ?? '',
          selectedOpportunityIds: Array.isArray(suggestContext.selectedOpportunityIds) ? suggestContext.selectedOpportunityIds.slice(0, 6) : [],
          topic: suggestContext.topic ?? '',
          model: suggestContext.model ?? '',
          locale,
        }
        const response = await fetch('api/career-agent/suggest', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
          body: JSON.stringify(payload),
        })
        if (!response.ok || controller.signal.aborted) return
        const data = await response.json().catch(() => null)
        if (
          controller.signal.aborted
          || seq !== requestSeqRef.current
          || !focusedRef.current
          || !enabledRef.current
          || composingRef.current
          || contextKeyRef.current !== requestContextKey
          || !valueRef.current.trim()
          || !valueRef.current.startsWith(requestPrefix)
        ) return
        if (data?.ok && typeof data.suggestion === 'string' && data.suggestion.startsWith(valueRef.current) && data.suggestion.length > valueRef.current.length) {
          setPrediction({ contextKey: requestContextKey, full: data.suggestion })
        }
      } catch {}
    }, 360)

    return () => {
      window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [value, focused, composing, activeContextKey, suggestEnabled, surface, suggestContext?.model, locale])

  // Compute live ghost suffix aligned directly after `value`.
  let suffix = ''
  const canShowAiPrediction = focused && suggestEnabled && Boolean(value.trim())
  if (!disabled && !composing && !composingRef.current) {
    if (canShowAiPrediction && currentPrediction.startsWith(value) && currentPrediction.length > value.length) {
      suffix = currentPrediction.slice(value.length)
    } else if (!value && fallbackSuggestion && dismissedKey !== `${activeContextKey}:empty`) {
      suffix = fallbackSuggestion
    }
  }

  // Auto-grow textarea smoothly to fit BOTH typed text and wrapped multi-line ghost suffix (never clips!).
  React.useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const minH = minRows > 1 ? 58 : 30
    const mirrorH = mirrorRef.current ? mirrorRef.current.scrollHeight : 0
    el.style.height = `${Math.max(minH, Math.min(176, Math.max(el.scrollHeight, mirrorH)))}px`
  }, [value, suffix, minRows, textareaRef])

  const acceptSuggestion = () => {
    if (!suffix) return false
    const nextValue = value + suffix
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    skipNextSuggestRef.current = true
    abortRef.current?.abort()
    onChange(nextValue)
    setPrediction(null)
    window.clearTimeout(revealTimerRef.current)
    if (!reduced) {
      const chars = [...suffix]
      // Keep total sweep crisp & silky (~220–340ms regardless of length)
      const stepMs = Math.max(4, Math.min(11, Math.round(190 / Math.max(1, chars.length))))
      const totalMs = chars.length * stepMs + 150
      setReveal({ prefix: value, chars, stepMs, token: Date.now() })
      revealTimerRef.current = window.setTimeout(() => setReveal(null), totalMs)
    } else {
      setReveal(null)
    }
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(nextValue.length, nextValue.length)
      }
    })
    return true
  }

  const handleKeyDown = event => {
    if (event.nativeEvent?.isComposing || event.keyCode === 229 || composingRef.current) return
    const el = event.currentTarget
    const atEnd = el.selectionStart === value.length && el.selectionEnd === value.length

    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && suffix && atEnd) {
      event.preventDefault()
      acceptSuggestion()
      return
    }
    if (event.key === 'ArrowRight' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && suffix && atEnd && value.length > 0) {
      event.preventDefault()
      acceptSuggestion()
      return
    }
    if (event.key === 'Escape' && suffix) {
      event.preventDefault()
      requestSeqRef.current += 1
      abortRef.current?.abort()
      setPrediction(null)
      if (!value) setDismissedKey(`${activeContextKey}:empty`)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (reveal) { window.clearTimeout(revealTimerRef.current); setReveal(null) }
      if (value.trim()) onSubmit?.()
    }
  }

  const syncScroll = event => {
    if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop
  }

  const revealing = Boolean(reveal && value === reveal.prefix + reveal.chars.join(''))

  return <div className={`ca-ghost-wrap${revealing ? ' is-revealing' : ''} ${className}`}>
    <div ref={mirrorRef} className="ca-ghost-mirror" aria-hidden="true">
      {revealing ? <>
        <span className="ca-ghost-fixed">{reveal.prefix}</span>
        <span key={reveal.token} className="ca-ghost-sweep">
          {reveal.chars.map((ch, idx) => (
            <span key={idx} className="ca-ghost-char" style={{ animationDelay: `${idx * reveal.stepMs}ms` }}>{ch}</span>
          ))}
        </span>
      </> : <>
        <span className="ca-ghost-typed">{value}</span>
        {suffix && <span key={suffix} className="ca-ghost-suffix">
          {suffix}
          <span className="ca-ghost-tab-hint">
            <ShortcutKeys keys={['Tab']} />
          </span>
        </span>}
      </>}
    </div>
    <textarea
      ref={textareaRef}
      className="ca-ghost-textarea"
      aria-label={ariaLabel}
      rows={minRows}
      maxLength={maxLength}
      value={value}
      placeholder={suffix ? '' : placeholder}
      readOnly={disabled}
      onChange={event => {
        if (reveal) { window.clearTimeout(revealTimerRef.current); setReveal(null) }
        onChange(event.target.value)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        skipNextSuggestRef.current = false
        requestSeqRef.current += 1
        abortRef.current?.abort()
        setPrediction(null)
      }}
      onScroll={syncScroll}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true
        setComposing(true)
        requestSeqRef.current += 1
        abortRef.current?.abort()
      }}
      onCompositionEnd={() => { composingRef.current = false; setComposing(false) }}
    />
  </div>
}
