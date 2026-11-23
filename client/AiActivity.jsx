import React from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { translate } from '../src/i18n/index.mjs'

const SETTLED = new Set(['ready', 'error'])

export const TRACE_STEPS = {
  tailor: [
    { key: 'reading', labelKey: 'activity.stepReading' },
    { key: 'matching', labelKey: 'activity.stepMatching' },
    { key: 'gaps', labelKey: 'activity.stepGaps' },
    { key: 'drafting', labelKey: 'activity.stepDrafting' },
  ],
  'tailor-resume': [
    { key: 'reading', labelKey: 'activity.stepReading' },
    { key: 'drafting', labelKey: 'activity.stepTailorDrafting' },
    { key: 'gaps', labelKey: 'activity.stepTailorGaps' },
    { key: 'verifying', labelKey: 'activity.stepTailorVerifying' },
  ],
  'job-intel': [
    { key: 'reading', labelKey: 'activity.stepIntelReading' },
    { key: 'verdict', labelKey: 'activity.stepIntelVerdict' },
    { key: 'risks', labelKey: 'activity.stepIntelRisks' },
    { key: 'diligence', labelKey: 'activity.stepIntelDiligence' },
  ],
  'jd-probe': [
    { key: 'reading', labelKey: 'activity.stepProbeReading' },
    { key: 'analyzing', labelKey: 'activity.stepProbeAnalyzing' },
    { key: 'bridging', labelKey: 'activity.stepProbeBridging' },
    { key: 'questions', labelKey: 'activity.stepProbeQuestions' },
  ],
  'jd-probe-reply': [
    { key: 'reading', labelKey: 'activity.stepProbeReplyReading' },
    { key: 'answering', labelKey: 'activity.stepProbeReplyAnswering' },
  ],
  'discover-companies': [
    { key: 'reading', labelKey: 'activity.stepDiscoverReading' },
    { key: 'matching', labelKey: 'activity.stepDiscoverMatching' },
    { key: 'verifying', labelKey: 'activity.stepDiscoverVerifying' },
  ],
  'resume-rebase': [
    { key: 'diff', labelKey: 'activity.stepRebaseDiff' },
    { key: 'merging', labelKey: 'activity.stepRebaseMerging' },
    { key: 'saving', labelKey: 'activity.stepRebaseSaving' },
  ],
  'market-insight': [
    { key: 'reading', labelKey: 'activity.stepMarketReading' },
    { key: 'trends', labelKey: 'activity.stepMarketTrends' },
    { key: 'aligning', labelKey: 'activity.stepMarketAligning' },
    { key: 'advising', labelKey: 'activity.stepMarketAdvising' },
  ],
}

export function useElapsedSeconds(active, startedAt) {
  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!active) {
      setElapsed(0)
      return
    }
    const base = Number.isFinite(startedAt) ? startedAt : Date.now()
    const tick = () => setElapsed(Math.max(0, Date.now() - base))
    tick()
    const timer = window.setInterval(tick, 120)
    return () => window.clearInterval(timer)
  }, [active, startedAt])
  return elapsed
}

function formatSeconds(ms) {
  const sec = Math.max(0.1, ms / 1000)
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

// Module-level persistent async operation store so live progress survives drawer close/reopen & tab switches.
const OP_STORE = new Map()
const OP_LISTENERS = new Set()
let pollTimer = null
let pollingActive = false

function notifyOpStore() {
  for (const fn of OP_LISTENERS) {
    try { fn() } catch {}
  }
}

function subscribeOpStore(fn) {
  OP_LISTENERS.add(fn)
  return () => { OP_LISTENERS.delete(fn) }
}

function setOpEntry(key, value) {
  if (!key) return
  if (value == null) OP_STORE.delete(key)
  else OP_STORE.set(key, value)
  notifyOpStore()
  scheduleOpPoll()
}

function scheduleOpPoll() {
  const activeEntries = []
  for (const [key, op] of OP_STORE.entries()) {
    if (op && op.id && !SETTLED.has(op.phase)) activeEntries.push([key, op])
  }
  if (!activeEntries.length) {
    if (pollTimer) {
      window.clearTimeout(pollTimer)
      pollTimer = null
    }
    return
  }
  if (pollTimer || pollingActive) return
  pollTimer = window.setTimeout(async () => {
    pollTimer = null
    pollingActive = true
    try {
      const snapshot = []
      for (const [key, op] of OP_STORE.entries()) {
        if (op && op.id && !SETTLED.has(op.phase)) snapshot.push([key, op])
      }
      await Promise.allSettled(snapshot.map(async ([key, op]) => {
        try {
          const response = await fetch(`career-agent/resume-activity?id=${encodeURIComponent(op.id)}`, {
            headers: { 'x-career-agent': '1' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const next = response.ok ? await response.json() : null
          const cur = OP_STORE.get(key)
          if (!cur || cur.id !== op.id || SETTLED.has(cur.phase)) return
          if (next && next.phase) {
            if (!SETTLED.has(next.phase)) {
              OP_STORE.set(key, { ...cur, ...next })
              notifyOpStore()
            } else if (cur.rehydrated) {
              OP_STORE.set(key, { ...cur, ...next })
              notifyOpStore()
              if (typeof cur.onRehydratedSettled === 'function') {
                void cur.onRehydratedSettled()
              }
            }
          } else if (cur.rehydrated && Date.now() - (cur.startedAt || 0) > 4000) {
            OP_STORE.delete(key)
            notifyOpStore()
            if (typeof cur.onRehydratedSettled === 'function') {
              void cur.onRehydratedSettled()
            }
          }
        } catch {}
      }))
    } finally {
      pollingActive = false
      scheduleOpPoll()
    }
  }, 240)
}

export function useTrackedOperation(act, options = {}) {
  const { scopeKey = '', nonBlocking = true, serverOps = null } = options
  const actRef = React.useRef(act)
  actRef.current = act
  const fallbackKeyRef = React.useRef('')
  if (!fallbackKeyRef.current) fallbackKeyRef.current = `local:${crypto.randomUUID()}`
  const effectiveKey = scopeKey || fallbackKeyRef.current
  const isScoped = Boolean(scopeKey)

  const activity = React.useSyncExternalStore(
    subscribeOpStore,
    () => OP_STORE.get(effectiveKey) ?? null,
    () => null,
  )

  // Clean up ephemeral local keys on unmount; scoped keys intentionally persist across close/reopen!
  React.useEffect(() => {
    if (isScoped) return
    const key = fallbackKeyRef.current
    return () => {
      const cur = OP_STORE.get(key)
      if (cur && SETTLED.has(cur.phase)) OP_STORE.delete(key)
    }
  }, [isScoped])

  // Reconnect automatically if the server reports an already-running operation for this scopeKey (e.g. after reload).
  React.useEffect(() => {
    if (!isScoped || !Array.isArray(serverOps) || !serverOps.length) return
    const cur = OP_STORE.get(effectiveKey)
    if (cur && !SETTLED.has(cur.phase)) return
    const match = serverOps.find(op => {
      const target = op?.opportunityId || op?.scope
      return Boolean(op?.id && op.kind && target && `${op.kind}:${target}` === effectiveKey)
    })
    if (match) {
      setOpEntry(effectiveKey, {
        ...match,
        rehydrated: true,
        onRehydratedSettled: () => (typeof actRef.current?.reload === 'function' ? actRef.current.reload() : undefined),
      })
    }
  }, [isScoped, effectiveKey, serverOps])

  const inFlightId = activity && !SETTLED.has(activity.phase) ? activity.id : null

  const run = React.useCallback(async (actionName, payload, { kind = actionName, label = '', toast = '' } = {}) => {
    const existing = OP_STORE.get(effectiveKey)
    if (existing && !SETTLED.has(existing.phase)) return null
    const operationId = crypto.randomUUID()
    const startedAt = Date.now()
    const curAct = actRef.current
    const runner = (nonBlocking && typeof curAct?.background === 'function') ? curAct.background : curAct
    setOpEntry(effectiveKey, { id: operationId, kind, label, phase: 'reading', startedAt, detail: '' })
    const reply = await runner(actionName, { ...(payload ?? {}), operationId }, toast)
    const curAfter = OP_STORE.get(effectiveKey)
    if (curAfter && curAfter.id !== operationId) return reply
    if (reply?.ok) {
      setOpEntry(effectiveKey, {
        ...(curAfter ?? {}),
        id: operationId,
        kind,
        label,
        phase: 'ready',
        elapsedMs: Date.now() - startedAt,
      })
      return reply
    }
    let serverErr = ''
    try {
      const check = await fetch(`career-agent/resume-activity?id=${encodeURIComponent(operationId)}`, {
        headers: { 'x-career-agent': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const snap = check.ok ? await check.json().catch(() => null) : null
      if (typeof snap?.error === 'string' && snap.error.trim()) serverErr = snap.error.trim()
    } catch {}
    const exactError = reply?.error || serverErr || (typeof actRef.current?.getLastError === 'function' ? actRef.current.getLastError() : '') || translate(getActiveLocale(), 'activity.actionFailedFallback')
    setOpEntry(effectiveKey, {
      ...(curAfter ?? {}),
      id: operationId,
      kind,
      label,
      phase: 'error',
      error: exactError,
      elapsedMs: Date.now() - startedAt,
    })
    return reply
  }, [effectiveKey, nonBlocking])

  const dismiss = React.useCallback(() => {
    const cur = OP_STORE.get(effectiveKey)
    if (!cur || SETTLED.has(cur.phase)) {
      setOpEntry(effectiveKey, null)
    }
  }, [effectiveKey])

  return {
    activity,
    running: Boolean(inFlightId),
    run,
    dismiss,
  }
}

export function useHasTrackedOperation(kindPrefix, serverOps = null) {
  const localRunning = React.useSyncExternalStore(
    subscribeOpStore,
    () => {
      for (const [key, op] of OP_STORE.entries()) {
        if (!op || SETTLED.has(op.phase)) continue
        if (key.startsWith(`${kindPrefix}:`) || op.kind === kindPrefix) return true
      }
      return false
    },
    () => false,
  )
  const serverRunning = Array.isArray(serverOps)
    && serverOps.some(op => op && op.kind === kindPrefix && !SETTLED.has(op.phase))
  return localRunning || serverRunning
}

export function useActiveJobOps(opportunityId, serverOps = null) {
  const { t } = useI18n()
  const version = React.useSyncExternalStore(
    subscribeOpStore,
    () => {
      if (!opportunityId) return ''
      const intel = OP_STORE.get(`job-intel:${opportunityId}`)
      const tailor = OP_STORE.get(`tailor:${opportunityId}`)
      const probe = OP_STORE.get(`jd-probe:${opportunityId}`)
      const a = intel && !SETTLED.has(intel.phase) ? `i:${intel.phase}` : ''
      const b = tailor && !SETTLED.has(tailor.phase) ? `t:${tailor.phase}` : ''
      const c = probe && !SETTLED.has(probe.phase) ? `p:${probe.phase}` : ''
      return `${a}|${b}|${c}`
    },
    () => '',
  )
  const serverActive = Array.isArray(serverOps)
    ? serverOps.filter(op => op?.opportunityId === opportunityId && op.phase && !SETTLED.has(op.phase))
    : []
  const intelRunning = version.includes('i:') || serverActive.some(op => op.kind === 'job-intel')
  const tailorRunning = version.includes('t:') || serverActive.some(op => op.kind === 'tailor')
  const probeRunning = version.includes('p:') || serverActive.some(op => op.kind === 'jd-probe')
  const label = intelRunning ? t('activity.aiIntelRunning')
    : tailorRunning ? t('activity.tailorRunning')
      : probeRunning ? t('activity.probeRunning')
        : ''
  return {
    intelRunning,
    tailorRunning,
    probeRunning,
    anyRunning: Boolean(label),
    label,
  }
}

export function AiTraceCard({
  activity,
  title,
  compact = false,
  onDismiss,
}) {
  const { t } = useI18n()
  const active = Boolean(activity && !SETTLED.has(activity.phase))
  const elapsed = useElapsedSeconds(active, activity?.startedAt)
  if (!activity || activity.phase === 'ready') return null

  const isError = activity.phase === 'error'
  if (isError) {
    return <section className={`ca-ai-surface is-error${compact ? ' is-compact' : ''}`} role="status">
      <div className="ca-ai-row-head">
        <div className="ca-ai-row-title">
          <span className="ca-ai-orb is-error" aria-hidden="true" />
          <strong>{title || t('activity.taskFailed')}</strong>
        </div>
        {onDismiss && <button type="button" className="ca-text-button" onClick={onDismiss}>{t('common.close')}</button>}
      </div>
      <p className="ca-ai-row-sub">{activity.error || t('activity.taskFailedFallback')}</p>
    </section>
  }

  const primaryLabel = activity.detail || title || t('activity.agentWorking')
  const telemetry = [
    activity.model || '',
    formatSeconds(elapsed || activity.elapsedMs || 100),
    activity.chars > 0 ? t('common.charCount', { count: activity.chars }) : (activity.reasoningChars > 0 ? t('activity.thinkingChars', { count: activity.reasoningChars }) : ''),
  ].filter(Boolean).join(' · ')

  return <section className={`ca-ai-surface${compact ? ' is-compact' : ''}`} role="status" aria-live="polite">
    <span className="ca-ai-sheen-bar" aria-hidden="true" />
    <div className="ca-ai-row-head">
      <div className="ca-ai-row-title">
        <span className="ca-ai-orb" aria-hidden="true" />
        <TextShimmer active>{title || primaryLabel}</TextShimmer>
      </div>
      <span className="ca-ai-telemetry">{telemetry}</span>
    </div>

    {(Array.isArray(activity.sources) && activity.sources.length > 0) && (
      <div className="ca-ai-meta-line">
        <span className="ca-ai-meta-k">{t('activity.context')}</span>
        <span className="ca-ai-meta-v">{activity.sources.join(' · ')}</span>
      </div>
    )}

    {activity.preview ? (
      <p className="ca-ai-whisper">
        <span>{activity.preview}</span>
        <i className="ca-ai-caret" aria-hidden="true" />
      </p>
    ) : (
      <div className="ca-ai-live-line">
        <span className="ca-ai-pulse-bar" aria-hidden="true" />
        <span>{activity.detail || t('activity.readingContext')}</span>
      </div>
    )}
  </section>
}

export function AiThinkingBubble({
  activity = null,
  title,
  showSkeleton = true,
  startedAt,
}) {
  const { t } = useI18n()
  const live = Boolean(!activity || !SETTLED.has(activity.phase))
  const elapsed = useElapsedSeconds(live, activity?.startedAt ?? startedAt)
  const headline = activity?.detail || title || t('activity.aiThinking')

  const telemetry = [
    activity?.model || '',
    formatSeconds(elapsed || 100),
    activity?.chars > 0 ? t('common.charCount', { count: activity.chars }) : '',
  ].filter(Boolean).join(' · ')

  return <div className="ca-ai-surface is-compact" role="status" aria-live="polite">
    <span className="ca-ai-sheen-bar" aria-hidden="true" />
    <div className="ca-ai-row-head">
      <div className="ca-ai-row-title">
        <span className="ca-ai-orb" aria-hidden="true" />
        <TextShimmer active>{headline}</TextShimmer>
      </div>
      <span className="ca-ai-telemetry">{telemetry}</span>
    </div>

    {activity?.preview ? (
      <p className="ca-ai-whisper">
        <span>{activity.preview}</span>
        <i className="ca-ai-caret" aria-hidden="true" />
      </p>
    ) : showSkeleton ? (
      <div className="ca-ai-skeleton-lines" aria-hidden="true">
        <span style={{ width: '84%' }} />
        <span style={{ width: '56%' }} />
      </div>
    ) : null}
  </div>
}
