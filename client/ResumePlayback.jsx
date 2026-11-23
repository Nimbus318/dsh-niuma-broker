import React from 'react'
import { resumeBullet } from '../src/resume-conversation.mjs'
import { buildUnifiedPlaybackSteps, computeReviewableLineChanges } from '../src/resume-diff.mjs'
import { useI18n } from './i18n.jsx'

function bulletGroups(lines) {
  const groups = []
  const nextIndent = lines.map(() => 0)
  let indentation = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    nextIndent[index] = indentation
    if (lines[index].trim()) indentation = lines[index].match(/^[ \t]*/u)[0].length
  }
  let group = 0
  let previousStyle
  for (const [index, line] of lines.entries()) {
    const prefix = resumeBullet.exec(line)?.[1]
    const hasChildren = prefix && nextIndent[index] > prefix.match(/^[ \t]*/u)[0].length
    const style = prefix && !hasChildren ? prefix.replace(/\d+/u, '#') : null
    if (!style || style !== previousStyle) group++
    groups.push(style ? group : null)
    previousStyle = style
  }
  return groups
}

function defaultReasonKey(kind) {
  switch (kind) {
    case 'move': return 'playback.reasonMove'
    case 'insert': return 'playback.reasonInsert'
    case 'delete': return 'playback.reasonDelete'
    default: return 'playback.reasonRewrite'
  }
}

function buildLineDiffSteps(before, after, reason = '') {
  const original = before.split(/\r?\n/u)
  const expected = after.split(/\r?\n/u)
  const separator = before.includes('\r\n') ? '\r\n' : '\n'
  let start = 0
  while (start < original.length && start < expected.length && original[start] === expected[start]) start++
  let endOrig = original.length - 1
  let endExp = expected.length - 1
  while (endOrig >= start && endExp >= start && original[endOrig] === expected[endExp]) {
    endOrig--
    endExp--
  }
  const working = [...original]
  const steps = []
  if (endOrig >= start && endExp < start) {
    // Pure deletions
    for (let i = endOrig; i >= start; i--) {
      if (!working[i].trim()) { working.splice(i, 1); continue }
      working.splice(i, 1)
      steps.push({ kind: 'delete', line: Math.max(0, Math.min(i, working.length - 1)), text: working.join(separator), reason: reason || '' })
    }
  } else if (endExp >= start && endOrig < start) {
    // Pure insertions
    for (let i = start; i <= endExp; i++) {
      working.splice(i, 0, expected[i])
      if (expected[i].trim()) {
        steps.push({ kind: 'insert', line: i, text: working.join(separator), reason: reason || '' })
      }
    }
  }
  if (!steps.length || working.join(separator) !== after) return []
  return steps.slice(0, 12)
}

export function buildResumePlayback({ before, after, items, variant, changes, locale, source = '' }) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return []
  const stepSource = typeof source === 'string' ? source.trim() : ''
  const original = before.split(/\r?\n/u)
  const expected = after.split(/\r?\n/u)
  if (!Array.isArray(items) || !items.length || original.length !== expected.length) {
    const unifiedItems = computeReviewableLineChanges(before, after, Array.isArray(changes) ? changes : [], { locale })
    const unifiedSteps = buildUnifiedPlaybackSteps(before, unifiedItems, { source: stepSource })
    if (unifiedSteps.length > 0) return unifiedSteps
    return buildLineDiffSteps(before, after).map(s => (stepSource ? { ...s, source: stepSource } : s))
  }
  const separator = before.includes('\r\n') ? '\r\n' : '\n'
  const indices = new Map()
  for (const [index, text] of original.entries()) indices.set(text, indices.has(text) ? null : index)

  const edits = []
  const picked = new Set()
  for (const item of items) {
    const line = Number.isInteger(item?.line) ? item.line : indices.get(item?.source)
    if (!Number.isInteger(line) || original[line] !== item.source || picked.has(line)
      || typeof item.text !== 'string' || !item.text || /[\r\n]/u.test(item.text)) return []
    picked.add(line)
    const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
    edits.push({ line, text: item.text, promote: item.promote === true || variant !== 'conversation', reason })
  }

  const working = [...original]
  const stages = []
  for (const { line, text, reason } of edits) {
    const prefix = resumeBullet.exec(original[line])?.[1] ?? original[line].match(/^[ \t]*/u)[0]
    const updated = prefix + text
    if (working[line] === updated) continue
    working[line] = updated
    stages.push({ kind: 'rewrite', line, text: working.join(separator), reason: reason || '', ...(stepSource ? { source: stepSource } : {}) })
  }

  const identities = original.map((_, index) => index)
  const groups = bulletGroups(original)
  const moves = []
  for (const { line, text, promote, reason } of edits) {
    if (!promote || groups[line] == null) continue
    const at = identities.indexOf(line)
    const destinations = expected.flatMap((entry, index) =>
      groups[index] === groups[line] && resumeBullet.exec(entry)?.[2] === text ? [index] : [])
    if (destinations.length !== 1 || destinations[0] === at) continue
    const [to] = destinations
    const first = Math.min(at, to)
    const last = Math.max(at, to)
    const slice = working.slice(first, last + 1)
    const parts = slice.map(row => resumeBullet.exec(row))
    if (parts.some(match => !match)) continue
    const contents = parts.map(match => match[2])
    contents.splice(to - first, 0, ...contents.splice(at - first, 1))
    identities.splice(to, 0, ...identities.splice(at, 1))
    contents.forEach((wording, index) => { working[first + index] = parts[index][1] + wording })
    moves.push({ kind: 'move', line: at, to, text: working.join(separator), reason: reason || '', ...(stepSource ? { source: stepSource } : {}) })
  }

  if (working.some((line, index) => line !== expected[index])) return []
  return [...stages, ...moves]
}

function anchorAt(canvas, step, line, resolveAnchor) {
  const element = resolveAnchor?.({ ...step, line }, canvas)
    ?? canvas.querySelector(`[data-agent-line="${line}"]`)
  if (!element?.getClientRects().length) return null
  return element
}

function locate(canvas, element) {
  const bounds = canvas.getBoundingClientRect()
  const box = element.getBoundingClientRect()
  if (!box.width || !box.height) return null
  const range = element.nodeType ? element.ownerDocument.createRange() : element
  if (element.nodeType) range.selectNodeContents(element)
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
  const firstRect = rects[0] ?? box
  const lastRect = rects.at(-1) ?? box
  const outline = {
    left: Math.max(2, box.left - bounds.left - 5),
    top: Math.max(2, box.top - bounds.top - 2),
    width: Math.min(bounds.width - 8, box.width + 10),
    height: box.height + 4,
  }

  // Pointer tip sits cleanly at the trailing edge of the active line's text,
  // never covering characters being read or edited.
  const tipX = Math.min(bounds.width - 28, Math.max(outline.left + 8, lastRect.right - bounds.left + 4))
  const tipY = Math.max(4, lastRect.top - bounds.top + Math.min(lastRect.height * 0.5, 11))

  // Figma-style multiplayer cursor tag: callout stays tightly attached to the cursor arrow
  // (15px right, 13px below tip) and only flips left/above if near canvas bounds.
  const flipLeft = bounds.width - tipX < 252 && tipX > 240
  const flipUp = bounds.height - tipY < 76 && tipY > 76

  return {
    x: tipX,
    y: tipY,
    side: flipLeft ? 'left' : 'right',
    vAlign: flipUp ? 'above' : 'below',
    lineStartX: Math.max(2, firstRect.left - bounds.left - 5),
    outline,
  }
}

export function useResumePlayback({ token, before, steps = [], canvasRef, resolveAnchor, onDone }) {
  const [frame, setFrame] = React.useState(null)
  const [paused, setPaused] = React.useState(false)
  const [reduced, setReduced] = React.useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false)
  const current = frame?.token === token ? frame : null
  const index = current?.completed ?? 0
  const result = React.useRef({ steps, resolveAnchor, onDone })
  const lastPosition = React.useRef(null)
  const lastToken = React.useRef(null)
  const finishedToken = React.useRef(null)
  const active = Boolean(token && token !== finishedToken.current && !reduced && index < steps.length)
  result.current = { steps, resolveAnchor, onDone }

  React.useEffect(() => {
    setPaused(false)
  }, [token])

  React.useEffect(() => {
    const setting = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = event => setReduced(event.matches)
    setting?.addEventListener('change', update)
    return () => setting?.removeEventListener('change', update)
  }, [])

  React.useEffect(() => {
    if (!token || active || finishedToken.current === token) return
    finishedToken.current = token
    result.current.onDone?.()
  }, [token, active])

  // Re-anchor smoothly when the editor scrolls or window resizes during playback.
  React.useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return
    const syncPosition = () => {
      const step = result.current.steps[index]
      if (!step) return
      const line = current?.line ?? step.line
      const target = anchorAt(canvas, step, line, result.current.resolveAnchor)
      const position = target && locate(canvas, target)
      if (!position) return
      lastPosition.current = position
      setFrame(old => old?.token === token ? { ...old, position, duration: 0 } : old)
    }
    const scroller = canvas.querySelector('[data-editor-scroll]')
    scroller?.addEventListener('scroll', syncPosition, { passive: true })
    const ro = new ResizeObserver(syncPosition)
    ro.observe(canvas)
    return () => {
      scroller?.removeEventListener('scroll', syncPosition)
      ro.disconnect()
    }
  }, [active, token, index, current?.line, canvasRef])

  React.useLayoutEffect(() => {
    if (!active || paused) return
    const step = result.current.steps[index]
    const canvas = canvasRef.current
    const resolve = result.current.resolveAnchor
    if (!step) return
    if (lastToken.current !== token) {
      lastToken.current = token
      lastPosition.current = null
    }
    let timer
    let raf1
    let raf2
    let cancelled = false
    const scale = result.current.steps.length > 8 ? 0.72 : 1
    const schedule = (run, delay) => { timer = window.setTimeout(() => { if (!cancelled) run() }, delay) }
    const nextFrames = run => {
      raf1 = window.requestAnimationFrame(() => {
        if (cancelled) return
        raf2 = window.requestAnimationFrame(() => { if (!cancelled) run() })
      })
    }
    const update = values => setFrame(old => ({
      ...(old?.token === token ? old : { token, completed: index, applied: index }),
      ...values,
    }))
    const settle = () => {
      const line = step.to ?? step.line
      const anchor = canvas && anchorAt(canvas, step, line, resolve)
      const position = anchor && locate(canvas, anchor)
      if (position) lastPosition.current = position
      update({ phase: 'applied', applied: index + 1, line, position: position || lastPosition.current, duration: 160 })
      schedule(() => update({ completed: index + 1 }), Math.round(320 * scale))
    }
    const travel = (line, phase, onArrival) => {
      const anchor = canvas && anchorAt(canvas, step, line, resolve)
      if (!anchor) return false
      const scrollTarget = anchor.nodeType ? anchor
        : anchor.startContainer.nodeType === 1 ? anchor.startContainer : anchor.startContainer.parentElement
      scrollTarget?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      const target = locate(canvas, anchor)
      if (!target) return false
      const origin = lastPosition.current ?? {
        ...target,
        x: Math.max(8, target.x - 28),
        y: Math.max(8, target.y - 24),
      }
      const distance = Math.hypot(target.x - origin.x, target.y - origin.y)
      const duration = Math.round(Math.min(540, 290 + distance * 0.42) * scale)
      if (!lastPosition.current) update({ phase, line, position: origin, duration: 0 })
      lastPosition.current = target
      nextFrames(() => {
        update({ phase, line, position: target, duration })
        schedule(onArrival, duration)
      })
      return true
    }
    const arrive = () => {
      update({ phase: 'arrived' })
      schedule(() => {
        if (step.kind === 'move' && travel(step.to, 'moving', settle)) return
        settle()
      }, Math.round(145 * scale))
    }
    const start = () => travel(step.line, 'moving', arrive)
    if (!start()) schedule(() => { if (!start()) settle() }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.cancelAnimationFrame(raf1)
      window.cancelAnimationFrame(raf2)
    }
  }, [token, index, active, paused, canvasRef])

  React.useLayoutEffect(() => {
    if (!active || current?.phase !== 'applied') return
    const canvas = canvasRef.current
    const step = result.current.steps[index]
    const target = canvas && step && anchorAt(canvas, step, current.line, result.current.resolveAnchor)
    const position = target && locate(canvas, target)
    if (!position) return
    lastPosition.current = position
    setFrame(old => old?.token === token ? { ...old, position } : old)
  }, [active, token, index, current?.phase, current?.line, canvasRef])

  const step = active ? steps[index] : null
  return {
    active,
    paused,
    text: active ? (current?.applied ? steps[current.applied - 1].text : before) : undefined,
    targetLine: active ? current?.line : undefined,
    phase: active ? current?.phase : undefined,
    kind: step?.kind,
    reason: step?.reason,
    source: step?.source || '',
    cursor: active ? current?.position : null,
    duration: active ? current?.duration ?? 0 : 0,
    stepIndex: Math.min(index + 1, steps.length),
    completed: Math.min(index, steps.length),
    total: steps.length,
    pause: () => setPaused(true),
    resume: () => setPaused(false),
    togglePause: () => setPaused(value => !value),
    skip: () => { setPaused(false); setFrame({ token, completed: steps.length }) },
  }
}

const pointerStyles = `
.ca-playback-cursor, .ca-playback-outline {
  position: absolute; top: 0; left: 0; pointer-events: none;
}
.ca-playback-outline {
  z-index: 4;
  border: 1px solid color-mix(in srgb, var(--ca-blue, #315bd6) 46%, transparent);
  background: color-mix(in srgb, var(--ca-blue, #315bd6) 8%, transparent);
  border-radius: 6px;
  transition: transform 180ms cubic-bezier(.22, 1, .36, 1), opacity 140ms ease;
  will-change: transform;
}
.ca-playback-outline[data-phase="applied"] {
  border-color: color-mix(in srgb, var(--ca-success, #228451) 55%, transparent);
  background: color-mix(in srgb, var(--ca-success, #228451) 10%, transparent);
  animation: ca-playback-flash 260ms ease-out both;
}
.ca-playback-cursor {
  z-index: 20;
  color: var(--ca-blue, #315bd6);
  display: inline-flex;
  align-items: flex-start;
  transition: transform var(--ca-playback-time) cubic-bezier(.22, 1, .36, 1);
  will-change: transform;
}
.ca-playback-cursor svg {
  filter: drop-shadow(0 1.5px 3px rgb(22 39 84 / .28));
  flex: 0 0 auto;
  transform-origin: 3px 3px;
  transition: transform 130ms cubic-bezier(.22, 1, .36, 1);
}
.ca-playback-cursor[data-phase="arrived"] svg {
  transform: scale(.9);
}
.ca-playback-callout {
  position: absolute;
  top: 13px;
  left: 15px;
  pointer-events: none;
  width: max-content;
  max-width: 226px;
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 10px 5px 6px;
  color: var(--ca-ink, #17191c);
  background: var(--ca-bg, #fff);
  border: 1px solid color-mix(in srgb, var(--ca-blue, #315bd6) 36%, var(--ca-line, #d8dce3));
  border-radius: 4px 11px 11px 11px;
  font-size: 12px;
  line-height: 1.44;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--ca-ink, #17191c) 12%, transparent),
              0 1px 3px color-mix(in srgb, var(--ca-ink, #17191c) 6%, transparent);
  transition: border-color 180ms ease, opacity 150ms ease;
}
.ca-playback-callout[data-side="left"] {
  left: auto;
  right: calc(100% + 2px);
  border-radius: 11px 4px 11px 11px;
}
.ca-playback-callout[data-v="above"] {
  top: auto;
  bottom: calc(100% - 4px);
  border-radius: 11px 11px 11px 4px;
}
.ca-playback-callout[data-side="left"][data-v="above"] {
  border-radius: 11px 11px 4px 11px;
}
.ca-playback-callout[data-phase="applied"] {
  border-color: color-mix(in srgb, var(--ca-success, #228451) 46%, var(--ca-line, #d8dce3));
}
.ca-playback-callout-step {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  corner-shape: round;
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: var(--ca-blue, #315bd6);
  margin-top: 1px;
  transition: background-color 180ms ease;
}
.ca-playback-callout[data-phase="applied"] .ca-playback-callout-step {
  background: var(--ca-success, #228451);
}
.ca-playback-callout-source {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 560;
  color: var(--ca-muted, #575e68);
  background: var(--ca-hover, #f2f4f8);
  margin-top: 1px;
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ca-playback-callout-text {
  font-weight: 500;
  overflow-wrap: anywhere;
}
@keyframes ca-playback-flash { 0% { opacity: .55 } 35% { opacity: 1 } 100% { opacity: .72 } }
@media (prefers-reduced-motion: reduce) {
  .ca-playback-cursor, .ca-playback-callout, .ca-playback-outline { display: none !important; }
}
`

const kindLabelKeys = {
  move: 'playback.kindMove',
  rewrite: 'playback.kindRewrite',
  insert: 'playback.kindInsert',
  delete: 'playback.kindDelete',
}

export function ResumePlaybackCursor({ playback }) {
  const { t } = useI18n()
  const { cursor, phase, duration, kind, reason, source, stepIndex, total, paused } = playback
  if (!cursor || !phase) return null
  const label = t(kindLabelKeys[kind] ?? 'playback.kindRewrite')
  const note = reason || t(defaultReasonKey(kind))
  const motionStyle = { '--ca-playback-time': `${duration}ms` }
  return <>
    <style>{pointerStyles}</style>
    {phase !== 'moving' && <div className="ca-playback-outline" aria-hidden="true" data-phase={phase}
      style={{
        transform: `translate3d(${cursor.outline.left}px,${cursor.outline.top}px,0)`,
        width: cursor.outline.width,
        height: cursor.outline.height,
      }} />}
    <div className="ca-playback-cursor" data-phase={phase} data-paused={paused || undefined}
      style={{ ...motionStyle, transform: `translate3d(${cursor.x}px,${cursor.y}px,0)` }}>
      <svg width="19" height="21" viewBox="0 0 20 22" fill="none" aria-hidden="true">
        <path d="M3 2.3 17.3 10.7l-6.4 1.6-3.1 5.9L3 2.3Z" fill="currentColor" stroke="white" strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
      <div className="ca-playback-callout" role="status" aria-live="polite"
        data-phase={phase} data-side={cursor.side ?? 'right'} data-v={cursor.vAlign ?? 'below'}>
        <span className="ca-playback-callout-step">{stepIndex}/{total}</span>
        {source && <span className="ca-playback-callout-source">{source}</span>}
        <span className="ca-playback-callout-text"><strong>{label}</strong> · {note}</span>
      </div>
    </div>
  </>
}

export function ResumePlaybackControls({ playback }) {
  const { t } = useI18n()
  if (!playback.active) return null
  return <div className="ca-playback-controls" role="region" aria-label={t('playback.controlsAria')}>
    <span className="ca-playback-status" role="status">
      <i className="ca-pulse-dot" data-paused={playback.paused || undefined} aria-hidden="true" />
      {playback.paused ? t('playback.paused') : t('playback.playing', { step: playback.stepIndex, total: playback.total })}
    </span>
    <div className="ca-inline">
      <button type="button" className="ca-btn ca-btn-sm" onClick={playback.togglePause}>
        {playback.paused ? t('playback.resume') : t('playback.pause')}
      </button>
      <button type="button" className="ca-btn ca-btn-sm primary" onClick={playback.skip}>{t('playback.skip')}</button>
    </div>
  </div>
}
