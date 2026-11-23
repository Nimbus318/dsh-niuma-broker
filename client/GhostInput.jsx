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
  const [prediction, setPrediction] = React.useState({ prefix: '', full: '' })
  const [dismissedKey, setDismissedKey] = React.useState('')
  const [reveal, setReveal] = React.useState(null)
  const [composing, setComposing] = React.useState(false)
  const textareaRef = externalRef || innerRef

  React.useEffect(() => () => window.clearTimeout(revealTimerRef.current), [])

  const contextKey = suggestContext?.key ?? ''
  const activeContextKey = `${locale}:${contextKey}`

  // Speculative AI next-prompt & mid-sentence prefix completion (Claude Code + Cursor Tab style).
  React.useEffect(() => {
    if (disabled || !suggestContext?.enabled || composingRef.current) return
    if (skipNextSuggestRef.current) {
      skipNextSuggestRef.current = false
      return
    }

    // 0ms prefix-hit: if current text already extends the cached prediction, shrink suffix immediately.
    if (prediction.full && value && prediction.full.startsWith(value) && prediction.full.length > value.length) {
      return
    }
    if (!value && prediction.prefix === '' && prediction.full && activeContextKey === dismissedKey) {
      return
    }

    const delay = value ? 360 : 380
    const timer = window.setTimeout(async () => {
      if (composingRef.current) return
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const response = await fetch('career-agent/suggest', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
          body: JSON.stringify({
            surface,
            prefix: value.slice(0, 300),
            markdown: suggestContext.markdown ?? '',
            template: suggestContext.template ?? 'onyx',
            style: suggestContext.style ?? {},
            history: suggestContext.history ?? [],
            opportunityId: suggestContext.opportunityId ?? '',
            topic: suggestContext.topic ?? '',
            model: suggestContext.model ?? '',
            locale,
            explicitInteractive: true,
          }),
        })
        if (!response.ok || controller.signal.aborted) return
        const data = await response.json().catch(() => null)
        if (!controller.signal.aborted && data?.ok && typeof data.suggestion === 'string' && data.suggestion.length > value.length) {
          setPrediction({ prefix: value, full: data.suggestion })
        }
      } catch {}
    }, delay)

    return () => {
      window.clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [value, activeContextKey, disabled, surface, suggestContext?.enabled, suggestContext?.model, locale])

  // Reset cached prediction cleanly when context or language changes.
  React.useEffect(() => {
    setPrediction({ prefix: '', full: '' })
    setDismissedKey('')
  }, [activeContextKey])

  // Compute live ghost suffix aligned directly after `value`.
  let suffix = ''
  if (!disabled && !composing && !composingRef.current) {
    if (prediction.full && prediction.full.startsWith(value) && prediction.full.length > value.length) {
      if (!(value === '' && dismissedKey === `${activeContextKey}:empty`)) {
        suffix = prediction.full.slice(value.length)
      }
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
    setPrediction({ prefix: nextValue, full: '' })
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
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return
    const el = event.currentTarget
    const atEnd = el.selectionStart === value.length && el.selectionEnd === value.length

    if (event.key === 'Tab' && !event.shiftKey && suffix && atEnd) {
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
      setPrediction({ prefix: value, full: '' })
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
      onScroll={syncScroll}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => { composingRef.current = true; setComposing(true) }}
      onCompositionEnd={() => { composingRef.current = false; setComposing(false) }}
    />
  </div>
}
