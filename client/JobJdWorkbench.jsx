import React from 'react'
import { Button, Switch, Tag, UserMessageBubble, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiThinkingBubble, AiTraceCard, TRACE_STEPS, useTrackedOperation } from './AiActivity.jsx'
import { resolveDefaultModelRoute, useModels } from './Composer.jsx'
import GhostInput from './GhostInput.jsx'
import MarkdownProse from './MarkdownProse.jsx'
import { CopyButton } from './Motion.jsx'
import TurnProcess from './TurnProcess.jsx'
import { DeepSeekMark } from './Emblems.jsx'
import { buildAutoIntelTogglePatch } from '../src/automation-toggles.mjs'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { annotateJd, buildDiligencePrompt, buildStudyPrompt, buildUserJdSignals, mergeJdRiskItems } from '../src/jd-highlight.mjs'
import { getDraft, usePersistedDraft } from './draft-hooks.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  isProfileContextCurrent,
  profileRequestHeaders,
  subscribeProfileChange,
} from './profile-storage.js'

function buildEscalatedStudyPrompt({ job, term, isBonus, matched, probe, locale, t }) {
  const base = buildStudyPrompt({ job, term, isBonus, matched, locale })
  const msgs = Array.isArray(probe?.messages) ? probe.messages : []
  if (!msgs.length) return base
  const sep = locale === 'en' ? ': ' : '：'
  const digest = msgs.slice(-6).map(m => `${m.role === 'user' ? t('jobDetail.studyMyFollowup') : t('jobDetail.studyPriorPoints')}${sep}${String(m.text || '').replace(/\s+/gu, ' ').slice(0, 180)}`).join('\n')
  return `${base}\n\n${t('jobDetail.studyContextPrefix')}\n${digest}`
}

const AUTO_INTEL_ATTEMPTED = new Set()

export function AnnotatedJd({ job, state, tailoredResumes, busy, act, dismiss, onStartSession }) {
  const { t, locale } = useI18n()
  const catalog = useModels()
  // Editorial highlight filter: 'all' | 'match' | 'learn' | 'risk' | 'off'
  const [hlFilter, setHlFilter] = React.useState('all')
  // Single-focus on-demand inspector lens: '' | 'learn' | 'risk' | 'diligence'
  const [activeLens, setActiveLens] = React.useState('')
  const [pinnedTerm, setPinnedTerm] = React.useState('')
  const [pinPulse, setPinPulse] = React.useState(0)
  const [activeProbeTerm, setActiveProbeTerm] = React.useState('')
  const [studyOpen, setStudyOpen] = React.useState(false)
  const studyDraftKey = activeProbeTerm ? `study:${job.id}:${activeProbeTerm}` : ''
  const [studyInput, setStudyInput] = usePersistedDraft(studyDraftKey, '')
  const [liveStudyTurn, setLiveStudyTurn] = React.useState(null)
  const studyAbortRef = React.useRef(null)
  const studyThinkingMapRef = React.useRef(new Map())
  const intelOp = useTrackedOperation(act, {
    scopeKey: job?.id ? `job-intel:${job.id}` : '',
    nonBlocking: true,
    serverOps: state.activeOperations,
  })
  const probeOp = useTrackedOperation(act, {
    scopeKey: job?.id ? `jd-probe:${job.id}` : '',
    nonBlocking: true,
    serverOps: state.activeOperations,
  })
  const probing = probeOp.running
  const bodyRef = React.useRef(null)
  const inspectorRef = React.useRef(null)
  const studyInputRef = React.useRef(null)
  const studyMsgsRef = React.useRef(null)

  const abortStudyStream = React.useCallback(() => {
    try { studyAbortRef.current?.abort() } catch {}
  }, [])

  const model = state.config?.model || resolveDefaultModelRoute(catalog.rows)
  const tabModel = state.config?.tabModel || model

  React.useEffect(() => () => {
    abortStudyStream()
  }, [abortStudyStream])

  React.useEffect(() => subscribeProfileChange(() => {
    studyThinkingMapRef.current.clear()
    abortStudyStream()
    setLiveStudyTurn(null)
  }), [abortStudyStream])

  React.useEffect(() => {
    abortStudyStream()
    setLiveStudyTurn(null)
    setHlFilter('all')
    setActiveLens('')
    setPinnedTerm('')
    setActiveProbeTerm('')
    setStudyOpen(false)
    setStudyInput('')
  }, [job?.id, abortStudyStream])

  const autoIntelEnabled = state.config?.autoJobIntel === true
    && state.config?.sendToModel === true
    && state.mode !== 'off'

  // Auto-silent private broker brief on open: runs 100% async in background without locking any UI button.
  React.useEffect(() => {
    const id = job?.id
    if (!autoIntelEnabled) return
    if (!id || job.intel || job.closedAt || job.jdPreview || !job.jd || String(job.jd).trim().length < 40) return
    if (!model || intelOp.running || AUTO_INTEL_ATTEMPTED.has(id)) return
    const timer = window.setTimeout(() => {
      if (AUTO_INTEL_ATTEMPTED.has(id)) return
      AUTO_INTEL_ATTEMPTED.add(id)
      void intelOp.run('job-intel', { id, auto: true }, {
        kind: 'job-intel',
        label: `${job.company || ''} · ${job.title || ''}`.replace(/^\s*·\s*/, ''),
      })
    }, 280)
    return () => window.clearTimeout(timer)
  }, [autoIntelEnabled, job?.id, job?.intel, job?.closedAt, job?.jd, model, intelOp.running, intelOp.run])

  const tailoredGaps = React.useMemo(
    () => tailoredResumes.map(r => r.gaps || '').filter(Boolean).join('\n'),
    [tailoredResumes],
  )
  const annotated = React.useMemo(() => {
    const signals = buildUserJdSignals({
      resumes: state.resumes,
      evidence: state.evidence,
      reflections: state.reflections,
      config: state.config,
      job,
      tailoredGaps,
      locale,
    })
    return annotateJd(job.jd, signals)
  }, [state.resumes, state.evidence, state.reflections, state.config, job, tailoredGaps, locale])

  const { matched, focused, learn = [], gaps, risks } = annotated.summary
  const matchCount = matched.length + focused.length
  const learnCount = learn.length + gaps.length
  const riskCount = risks.length
  const hasAny = matchCount + learnCount + riskCount > 0

  const probesByKey = React.useMemo(() => {
    const map = new Map()
    for (const p of Array.isArray(job.probes) ? job.probes : []) {
      if (p?.term) map.set(p.term.toLowerCase(), p)
    }
    return map
  }, [job.probes])

  const activeProbe = activeProbeTerm ? probesByKey.get(activeProbeTerm.toLowerCase()) ?? null : null
  const activeProbeKey = (job?.id && activeProbeTerm) ? `${job.id}::${activeProbeTerm.toLowerCase()}` : ''
  const activeStudyTurn = liveStudyTurn && liveStudyTurn.probeKey === activeProbeKey ? liveStudyTurn : null
  const studyStreaming = Boolean(activeStudyTurn?.streaming)
  const activeLearnItem = activeProbeTerm
    ? learn.find(l => l.term.toLowerCase() === activeProbeTerm.toLowerCase())
    : null
  const studyUserTurns = (activeProbe?.messages ?? []).filter(m => m.role === 'user').length
  const showEscalateBanner = studyOpen && studyUserTurns >= 3

  const activeStudyPrompt = React.useMemo(() => (
    activeProbeTerm ? buildEscalatedStudyPrompt({
      job, term: activeProbeTerm, isBonus: Boolean(activeProbe?.isBonus || activeLearnItem?.isBonus), matched, probe: activeProbe, locale, t,
    }) : ''
  ), [job, activeProbeTerm, activeProbe, activeLearnItem?.isBonus, matched, locale, t])

  const explicitTabModel = state.config?.tabModel || state.config?.model || ''
  const allowStudySuggest = state.config?.tabAutocomplete !== false
  const studySuggestContext = React.useMemo(() => ({
    enabled: allowStudySuggest && studyOpen && Boolean(activeProbeTerm) && !probing && !studyStreaming && Boolean(tabModel),
    tabEnabled: allowStudySuggest,
    key: `jd-study:${allowStudySuggest ? 1 : 0}:${job.id}:${activeProbeTerm}:${studyUserTurns}`,
    opportunityId: job.id,
    topic: activeProbeTerm,
    model: explicitTabModel,
    history: (activeProbe?.messages ?? []).slice(-4).map(m => ({ role: m.role, content: String(m.text || '').slice(0, 260) })),
  }), [allowStudySuggest, studyOpen, activeProbeTerm, probing, studyStreaming, tabModel, explicitTabModel, job.id, studyUserTurns, activeProbe?.messages])

  const studyFallbackHint = React.useMemo(() => {
    if (!activeProbeTerm) return ''
    if (studyUserTurns === 0) return t('jobDetail.studyHint0', { term: activeProbeTerm })
    if (studyUserTurns === 1) return t('jobDetail.studyHint1', { term: activeProbeTerm })
    return t('jobDetail.studyHint2', { term: activeProbeTerm })
  }, [activeProbeTerm, studyUserTurns, t])

  const intel = job.intel ?? null
  const [intelPrefOpen, setIntelPrefOpen] = React.useState(false)
  const intelPrefRef = React.useRef(null)
  const intelPrefDialogRef = React.useRef(null)
  const closeIntelPref = React.useCallback(() => setIntelPrefOpen(false), [])

  useDismissOnOutsidePointer(intelPrefRef, intelPrefOpen, setIntelPrefOpen)
  useModalLayer(intelPrefDialogRef, intelPrefOpen, closeIntelPref)
  const riskItems = React.useMemo(
    () => mergeJdRiskItems(intel?.riskNotes, risks),
    [intel?.riskNotes, risks],
  )

  const diligencePrompt = React.useMemo(
    () => buildDiligencePrompt({ job, risks: riskItems, matched, diligence: intel?.diligence ?? [], locale }),
    [job, riskItems, matched, intel?.diligence, locale],
  )

  const launchDshSession = prompt => {
    if (!prompt) return
    dismiss?.()
    onStartSession?.(prompt)
  }

  const toggleLens = lens => {
    setActiveLens(cur => {
      if (cur === lens) return ''
      return lens
    })
  }

  React.useEffect(() => {
    if (liveStudyTurn?.streaming && studyMsgsRef.current) {
      studyMsgsRef.current.scrollTop = studyMsgsRef.current.scrollHeight
    }
  }, [liveStudyTurn?.streaming, liveStudyTurn?.content, liveStudyTurn?.trace?.steps?.length, liveStudyTurn?.trace?.thinkingText])

  const closeInspector = () => {
    abortStudyStream()
    setLiveStudyTurn(null)
    setActiveLens('')
    setActiveProbeTerm('')
    setPinnedTerm('')
    setStudyOpen(false)
  }

  // Explicitly scroll to & spotlight a term inside the JD body (NEVER hijacks viewport when opening a probe card!)
  const focusTermInJd = term => {
    const key = term.toLowerCase()
    if (hlFilter === 'off') setHlFilter('all')
    setPinnedTerm(key)
    setPinPulse(v => v + 1)
    window.requestAnimationFrame(() => {
      const target = bodyRef.current?.querySelector(`[data-jd-term="${CSS.escape(key)}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const openProbe = async (term, isBonus = false, { scrollToInspector = false } = {}) => {
    const clean = String(term || '').trim()
    if (!clean) return
    if (clean.toLowerCase() !== activeProbeTerm.toLowerCase()) {
      abortStudyStream()
      setLiveStudyTurn(null)
    }
    setActiveLens('learn')
    setActiveProbeTerm(clean)
    setStudyOpen(false)
    setPinnedTerm(clean.toLowerCase())
    if (scrollToInspector) {
      window.requestAnimationFrame(() => {
        inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
    if (probesByKey.has(clean.toLowerCase()) || probing) return
    await probeOp.run('jd-probe', { id: job.id, term: clean, isBonus }, { kind: 'jd-probe', label: clean })
  }

  const submitStudyQuestion = async (overrideQuestion = '', { replaceLast = false, expectedUpdatedAt = '', replaceTurnId = '' } = {}) => {
    const q = (typeof overrideQuestion === 'string' && overrideQuestion.trim() ? overrideQuestion : studyInput).trim()
    if (!q || !activeProbeTerm || !activeProbe || probing || studyStreaming) return
    const ctxSnap = captureProfileContext()
    const targetJobId = job.id
    const targetTerm = activeProbeTerm
    const probeKey = `${targetJobId}::${targetTerm.toLowerCase()}`
    const turnId = globalThis.crypto?.randomUUID?.() || `study-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const explicitModel = state.config?.model || ''
    const resolvedExpectedAt = replaceLast ? (expectedUpdatedAt || activeProbe.updatedAt || '') : ''
    const resolvedReplaceTurnId = replaceLast
      ? (replaceTurnId || activeProbe.messages?.at(-1)?.trace?.turnId || '')
      : ''
    if (typeof overrideQuestion !== 'string' || !overrideQuestion.trim()) {
      setStudyInput('')
    }
    setStudyOpen(true)
    abortStudyStream()
    const controller = new AbortController()
    studyAbortRef.current = controller
    const isActiveTurn = () => studyAbortRef.current === controller && isProfileContextCurrent(ctxSnap)
    const startedAt = Date.now()
    const updateLive = updater => {
      if (!isActiveTurn()) return
      setLiveStudyTurn(cur => (cur && cur.turnId === turnId ? updater(cur) : cur))
    }
    setLiveStudyTurn({
      probeKey,
      turnId,
      question: q,
      replaceLast,
      expectedUpdatedAt: resolvedExpectedAt,
      replaceTurnId: resolvedReplaceTurnId,
      content: '',
      error: '',
      retryQuestion: '',
      streaming: true,
      trace: {
        turnId,
        startedAt,
        attemptStartedAt: 0,
        elapsedMs: 0,
        outcome: 'running',
        route: '',
        modelName: '',
        effort: '',
        contextItems: [],
        citedEvidenceCount: 0,
        thinkingText: '',
        thinkingStartedAt: 0,
        thinkingMs: 0,
        steps: [],
      },
    })

    const freezeThinking = trace => (trace.thinkingMs > 0
      ? trace.thinkingMs
      : (trace.thinkingStartedAt ? Math.max(100, Date.now() - trace.thinkingStartedAt) : 0))

    let lastSeq = 0
    let receivedDone = false
    try {
      const response = await fetch('api/career-agent/jd-study-chat', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: profileRequestHeaders({
          'content-type': 'application/json',
          'x-career-locale': getActiveLocale(),
        }, ctxSnap),
        body: JSON.stringify({
          id: targetJobId,
          term: targetTerm,
          question: q,
          turnId,
          ...(replaceLast ? {
            replaceLast: true,
            ...(resolvedExpectedAt ? { expectedUpdatedAt: resolvedExpectedAt } : {}),
            ...(resolvedReplaceTurnId ? { replaceTurnId: resolvedReplaceTurnId } : {}),
          } : {}),
          ...(explicitModel ? { model: explicitModel } : {}),
        }),
      })
      if (!response.ok) {
        const failed = await response.json().catch(() => null)
        checkProfileMismatch(response, failed)
        if (!isProfileContextCurrent(ctxSnap)) {
          setLiveStudyTurn(null)
          return
        }
        if (response.status === 404) {
          throw new Error(t('agent.backendOutdated'))
        }
        throw new Error(failed?.error || t('activity.actionFailedFallback'))
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done || !isActiveTurn()) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIdx
        while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
          if (!isActiveTurn()) break
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)
          if (!line) continue
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (!event || typeof event !== 'object') continue
          if (event.turnId && event.turnId !== turnId) continue
          if (Number.isInteger(event.seq)) {
            if (event.seq <= lastSeq) continue
            lastSeq = event.seq
          }
          if (event.type === 'context') {
            const items = Array.isArray(event.items) ? event.items : []
            updateLive(cur => ({ ...cur, trace: { ...cur.trace, contextItems: items } }))
          } else if (event.type === 'attempt') {
            updateLive(cur => ({
              ...cur,
              trace: {
                ...cur.trace,
                attemptStartedAt: cur.trace.attemptStartedAt || Date.now(),
                route: event.route || cur.trace.route,
                modelName: event.modelName || cur.trace.modelName,
                effort: typeof event.effort === 'string' ? event.effort : cur.trace.effort,
              },
            }))
          } else if (event.type === 'thinking') {
            updateLive(cur => {
              const thinkingStartedAt = cur.trace.thinkingStartedAt || cur.trace.attemptStartedAt || cur.trace.startedAt || Date.now()
              const nextThinking = `${cur.trace.thinkingText || ''}${event.delta || ''}`.slice(0, 8000)
              if (studyThinkingMapRef.current.size >= 20) {
                const oldest = studyThinkingMapRef.current.keys().next().value
                if (oldest) studyThinkingMapRef.current.delete(oldest)
              }
              studyThinkingMapRef.current.set(turnId, nextThinking)
              return { ...cur, trace: { ...cur.trace, thinkingStartedAt, thinkingText: nextThinking } }
            })
          } else if (event.type === 'text') {
            updateLive(cur => ({
              ...cur,
              content: cur.content + (event.delta || ''),
              trace: { ...cur.trace, thinkingMs: freezeThinking(cur.trace) },
            }))
          } else if (event.type === 'error') {
            receivedDone = true
            updateLive(cur => ({
              ...cur,
              streaming: false,
              error: event.message || t('activity.actionFailedFallback'),
              retryQuestion: q,
              trace: {
                ...cur.trace,
                outcome: 'error',
                thinkingMs: freezeThinking(cur.trace),
                elapsedMs: Math.max(100, Date.now() - cur.trace.startedAt),
              },
            }))
          } else if (event.type === 'done') {
            receivedDone = true
            updateLive(cur => ({
              ...cur,
              streaming: false,
              trace: {
                ...cur.trace,
                outcome: event.outcome || 'ok',
                thinkingMs: freezeThinking(cur.trace),
                elapsedMs: Number(event.elapsedMs) || Math.max(100, Date.now() - cur.trace.startedAt),
                route: event.route || cur.trace.route,
                modelName: event.modelName || cur.trace.modelName,
                effort: typeof event.effort === 'string' && event.effort ? event.effort : cur.trace.effort,
              },
            }))
            await act?.reload?.()
            if (isActiveTurn()) {
              setLiveStudyTurn(cur => (cur && cur.turnId === turnId ? null : cur))
            }
          }
        }
      }
      if (isActiveTurn() && !receivedDone && !controller.signal.aborted) {
        updateLive(cur => ({
          ...cur,
          streaming: false,
          retryQuestion: q,
          trace: {
            ...cur.trace,
            outcome: 'interrupted',
            thinkingMs: freezeThinking(cur.trace),
            elapsedMs: Math.max(100, Date.now() - cur.trace.startedAt),
          },
        }))
      }
    } catch (err) {
      if (!isActiveTurn()) return
      if (err?.name === 'AbortError') {
        if (!replaceLast && (!studyDraftKey || !String(getDraft(studyDraftKey, '') || '').trim())) setStudyInput(q)
        updateLive(cur => ({
          ...cur,
          streaming: false,
          retryQuestion: q,
          trace: {
            ...cur.trace,
            outcome: 'stopped',
            thinkingMs: freezeThinking(cur.trace),
            elapsedMs: Math.max(100, Date.now() - cur.trace.startedAt),
          },
        }))
      } else {
        if (!replaceLast && (!studyDraftKey || !String(getDraft(studyDraftKey, '') || '').trim())) setStudyInput(q)
        updateLive(cur => ({
          ...cur,
          streaming: false,
          error: err?.message || t('activity.actionFailedFallback'),
          retryQuestion: q,
          trace: {
            ...cur.trace,
            outcome: 'error',
            thinkingMs: freezeThinking(cur.trace),
            elapsedMs: Math.max(100, Date.now() - cur.trace.startedAt),
          },
        }))
      }
    } finally {
      if (studyAbortRef.current === controller) studyAbortRef.current = null
    }
  }

  // Collapse 5 internal categories into 3 calm editorial tones: match | learn | risk
  const visualBucketOf = kind => {
    if (kind === 'match' || kind === 'focus') return 'match'
    if (kind === 'learn' || kind === 'gap') return 'learn'
    if (kind === 'risk') return 'risk'
    return ''
  }

  const renderSegments = segments => segments.map((seg, i) => {
    const bucket = visualBucketOf(seg.kind)
    if (!bucket || hlFilter === 'off') return <React.Fragment key={i}>{seg.text}</React.Fragment>
    const key = (seg.term || seg.text).toLowerCase()
    const isPinned = Boolean(pinnedTerm && pinnedTerm === key)
    if (hlFilter !== 'all' && hlFilter !== bucket && !isPinned) {
      return <React.Fragment key={i}>{seg.text}</React.Fragment>
    }
    const tip = bucket === 'risk' && seg.translation
      ? t('jobDetail.jdRiskTooltip', {
          category: seg.category || t('jobDetail.jdRiskSignal'),
          translation: seg.translation,
          question: seg.question ? t('jobDetail.jdRiskQuestion', { question: seg.question }) : '',
        })
      : t('jobDetail.jdTermTooltip', { reason: seg.reason, term: seg.term })
    const handleClick = () => {
      if (bucket === 'risk') {
        setActiveLens('risk')
        setPinnedTerm(key)
        window.requestAnimationFrame(() => {
          inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
      } else {
        void openProbe(seg.term || seg.text, Boolean(seg.isBonus), { scrollToInspector: true })
      }
    }
    return <mark
      key={isPinned ? `${i}-${pinPulse}` : i}
      role="button"
      tabIndex={0}
      data-jd-term={key}
      className={`ca-jd-mark is-${bucket}${isPinned ? ' is-pinned' : ''}`}
      title={tip}
      onClick={handleClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } }}
    >{seg.text}</mark>
  })

  const instantVerdict = (() => {
    const parts = []
    const listSep = locale === 'en' ? ', ' : '、'
    if (job.match?.reason && job.match.tier !== 'skip') {
      parts.push(job.match.reason)
    } else if (matched.length >= 3) {
      parts.push(t('jobDetail.jdMatchedMany', { count: matched.length, terms: matched.slice(0, 3).map(m => m.term).join(listSep) }))
    } else if (matched.length > 0) {
      parts.push(t('jobDetail.jdMatchedFew', { count: matched.length, terms: matched.slice(0, 3).map(m => m.term).join(listSep) }))
    } else {
      parts.push(t('jobDetail.jdMatchedNone'))
    }
    if (learn.length > 0) parts.push(t('jobDetail.jdLearnNote', { count: learn.length }))
    if (riskItems.length > 0) parts.push(t('jobDetail.jdRiskNote', { count: riskItems.length }))
    return locale === 'en' ? `${parts.join('; ')}.` : `${parts.join('，')}。`
  })()

  const inspectorOpen = activeLens !== ''

  return <div className="ca-jd-workspace">
    {/* Layer 1: Full-Width Editorial Briefing Bar + Compact Header Tools */}
    <section className="ca-jd-summary" aria-label={t('jobDetail.summaryAria')}>
      <div className="ca-jd-brief-head">
        <div className="ca-jd-brief-label">
          {intelOp.running ? (
            <>
              <span className="ca-ai-orb is-inline" aria-hidden="true" />
              <span>{t('jobDetail.aiIntelActive')}</span>
            </>
          ) : intel ? (
            <>
              <span className="ca-jd-brief-mark" aria-hidden="true"><DeepSeekMark size={14} /></span>
              <span>{t('jobDetail.aiIntelDone')}</span>
            </>
          ) : (
            <span>{t('jobDetail.quickOverview')}</span>
          )}
        </div>

        <div className="ca-jd-brief-controls">
          <button
            type="button"
            className={`ca-jd-brief-action${!intel ? ' is-primary' : ''}${intelOp.running ? ' is-running' : ''}`}
            disabled={intelOp.running}
            onClick={() => {
              AUTO_INTEL_ATTEMPTED.add(job.id)
              void intelOp.run('job-intel', { id: job.id }, {
                kind: 'job-intel',
                label: `${job.company} · ${job.title}`,
                toast: t('jobDetail.toastIntelDone'),
              })
            }}
          >
            {intel ? (
              <svg className={intelOp.running ? 'is-spinning' : ''} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13.2 6.8A5.4 5.4 0 0 0 3.7 4.4L2.5 5.6m0-2.8v2.8h2.8M2.8 9.2a5.4 5.4 0 0 0 9.5 2.4l1.2-1.2m0 2.8v-2.8h-2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <DeepSeekMark size={13} />
            )}
            <span>{intelOp.running ? t('jobDetail.intelRunning') : (intel ? t('common.refresh') : t('jobDetail.intelTrigger'))}</span>
          </button>

          <div className="ca-jd-pref-wrap" ref={intelPrefRef}>
            <button
              type="button"
              className={`ca-jd-brief-pref-btn${intelPrefOpen ? ' is-open' : ''}`}
              aria-label={t('jobDetail.intelPrefAria')}
              aria-haspopup="dialog"
              aria-expanded={intelPrefOpen}
              title={autoIntelEnabled ? t('jobDetail.intelPrefTitleOn') : t('jobDetail.intelPrefTitleOff')}
              onClick={() => setIntelPrefOpen(v => !v)}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                <circle cx="11" cy="4.5" r="1.5" stroke="currentColor" strokeWidth="1.35" />
                <circle cx="5" cy="11.5" r="1.5" stroke="currentColor" strokeWidth="1.35" />
              </svg>
            </button>
            {intelPrefOpen && (
              <div ref={intelPrefDialogRef} className="ca-jd-pref-pop ca-popover-surface" role="dialog" aria-label={t('jobDetail.intelPrefDialogAria')}>
                <div className="ca-jd-pref-row">
                  <strong className="ca-jd-pref-label">{t('sources.autoIntelTitle')}</strong>
                  <Switch
                    label={t('sources.autoIntelTitle')}
                    checked={autoIntelEnabled}
                    onChange={next => {
                      const runner = typeof act?.background === 'function' ? act.background : act
                      const cfg = buildAutoIntelTogglePatch(state, next)
                      void runner('configure', { config: cfg }, next ? t('sources.toastAutoIntelOn') : t('sources.toastAutoIntelOff'))
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="ca-jd-summary-copy">
        <p className="ca-jd-verdict-line">{intel?.verdict || instantVerdict}</p>
        {intel?.highlights?.length > 0 && (
          <ul className="ca-jd-verdict-points">
            {intel.highlights.map((pt, idx) => <li key={idx}>{pt}</li>)}
          </ul>
        )}
      </div>

      {intelOp.activity && intelOp.activity.phase !== 'ready' && (
        <AiTraceCard
          compact
          activity={intelOp.activity}
          title={intelOp.activity.phase === 'error' ? t('jobDetail.intelFailed') : t('jobDetail.intelWorking')}
          onDismiss={intelOp.dismiss}
        />
      )}

      <div className="ca-jd-lens-bar" role="tablist" aria-label={t('jobDetail.lensBarAria')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeLens === 'learn'}
          className={`ca-jd-lens-btn${activeLens === 'learn' ? ' is-active' : ''}`}
          onClick={() => toggleLens('learn')}
        >
          <span>{t('jobDetail.lensLearn')}</span>
          <span className="ca-jd-lens-count">{learn.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeLens === 'risk'}
          className={`ca-jd-lens-btn${activeLens === 'risk' ? ' is-active' : ''}${riskItems.length > 0 ? ' has-alert' : ''}`}
          onClick={() => toggleLens('risk')}
        >
          {riskItems.length > 0 && <i className="ca-jd-lens-dot is-warn" aria-hidden="true" />}
          <span>{t('jobDetail.lensRisk')}</span>
          <span className="ca-jd-lens-count">
            {intelOp.running
              ? t('jobDetail.riskAnalyzing')
              : !intel
                ? t('jobDetail.riskPending')
                : riskItems.length > 0
                  ? t('jobDetail.riskCount', { count: riskItems.length })
                  : t('jobDetail.riskNone')}
          </span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeLens === 'diligence'}
          className={`ca-jd-lens-btn${activeLens === 'diligence' ? ' is-active' : ''}`}
          onClick={() => toggleLens('diligence')}
        >
          <span>{t('jobDetail.lensDiligence')}</span>
          <span className="ca-jd-lens-count">
            {intelOp.running
              ? t('jobDetail.riskAnalyzing')
              : intel?.diligence?.length > 0
                ? t('jobDetail.diligenceCount', { count: intel.diligence.length })
                : t('jobDetail.diligenceDshReady')}
          </span>
        </button>
      </div>
    </section>

    {/* Layer 2: Single-Focus On-Demand Inspector (0px footprint when closed) */}
    {inspectorOpen && (
      <section ref={inspectorRef} className="ca-jd-inspector" role="region" aria-label={t('jobDetail.inspectorAria')}>
        {activeLens === 'learn' && (
          <div className="ca-jd-panel">
            <div className="ca-jd-panel-head">
              <div className="ca-inline">
                <strong>{t('jobDetail.learnHeading')}</strong>
                <span className="ca-meta">{t('jobDetail.learnSub')}</span>
              </div>
              <button type="button" className="ca-text-button" onClick={closeInspector}>{t('common.collapse')}</button>
            </div>

            {learn.length > 0 ? (
              <div className="ca-jd-topic-list">
                {learn.slice(0, 10).map(item => {
                  const isSelected = activeProbeTerm.toLowerCase() === item.term.toLowerCase()
                  const cached = probesByKey.has(item.term.toLowerCase())
                  return <button
                    key={item.term}
                    type="button"
                    className={`ca-jd-topic-pill${isSelected ? ' is-selected' : ''}`}
                    title={item.reason}
                    onClick={() => void openProbe(item.term, Boolean(item.isBonus))}
                  >
                    <span>{item.term}</span>
                    {item.isBonus && <small>{t('jobDetail.bonusShort')}</small>}
                    {cached && <small className="is-done">{t('jobDetail.probedShort')}</small>}
                  </button>
                })}
              </div>
            ) : !activeProbeTerm ? (
              <p className="ca-meta">{t('jobDetail.learnEmpty')}</p>
            ) : null}

            {activeProbeTerm && (
              <div className="ca-jd-probe-view">
                <div className="ca-jd-probe-view-head">
                  <div className="ca-inline">
                    <strong>{activeProbeTerm}</strong>
                    {(activeProbe?.isBonus || activeLearnItem?.isBonus) && <Tag tone="neutral">{t('jobDetail.bonusTag')}</Tag>}
                  </div>
                  <div className="ca-inline">
                    <button type="button" className="ca-text-button" onClick={() => focusTermInJd(activeProbeTerm)}>{t('jobDetail.locateInJd')}</button>
                    <button type="button" className="ca-text-button" onClick={() => { setActiveProbeTerm(''); setPinnedTerm('') }}>{t('jobDetail.closeProbe')}</button>
                  </div>
                </div>

                {!activeProbe && probing ? (
                  <AiThinkingBubble
                    activity={probeOp.activity}
                    title={t('jobDetail.probingTerm', { term: activeProbeTerm })}
                    steps={TRACE_STEPS['jd-probe']}
                  />
                ) : activeProbe ? <>
                  <div className="ca-jd-probe-sections">
                    <div className="ca-jd-probe-sec">
                      <strong>{t('jobDetail.probeRole')}</strong>
                      <p>{activeProbe.summary}</p>
                      {activeProbe.whyItMatters && <p className="ca-jd-probe-muted">{activeProbe.whyItMatters}</p>}
                    </div>
                    {activeProbe.bridgeToYou && (
                      <div className="ca-jd-probe-sec">
                        <strong>{t('jobDetail.probeBridge')}</strong>
                        <p>{activeProbe.bridgeToYou}</p>
                      </div>
                    )}
                    {activeProbe.interviewQuestions?.length > 0 && (
                      <div className="ca-jd-probe-sec">
                        <strong>{t('jobDetail.probeQuestions')}</strong>
                        <ul>{activeProbe.interviewQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                      </div>
                    )}
                  </div>

                  <div className="ca-jd-probe-actions">
                    <Button variant={studyOpen ? 'outline' : 'primary'} size="sm"
                      onClick={() => setStudyOpen(v => !v)}>
                      {studyOpen ? t('jobDetail.collapseStudy') : (studyUserTurns > 0 ? t('jobDetail.continueStudy', { count: studyUserTurns }) : t('jobDetail.startStudy'))}
                    </Button>
                    {onStartSession && (
                      <Button variant="outline" size="sm" onClick={() => launchDshSession(activeStudyPrompt)}>
                        {t('jobDetail.openDshStudy')}
                      </Button>
                    )}
                    <CopyButton text={activeStudyPrompt} label={t('jobDetail.copyDshStudy')} />
                  </div>

                  {studyOpen && (() => {
                    const rawMsgs = Array.isArray(activeProbe.messages) ? activeProbe.messages : []
                    const hideTrailingForRegen = Boolean(activeStudyTurn?.replaceLast && rawMsgs.length >= 2)
                    const persistedMsgs = hideTrailingForRegen ? rawMsgs.slice(0, -2) : rawMsgs
                    return <div className="ca-jd-study-thread">
                      {(persistedMsgs.length > 0 || activeStudyTurn) && (
                        <div className="ca-jd-study-msgs" ref={studyMsgsRef}>
                          {persistedMsgs.map((m, idx) => {
                            if (m.role === 'user') {
                              return (
                                <div key={idx} className="ca-chat-msg ca-chat-user">
                                  <UserMessageBubble className="ca-chat-user-bubble">{m.text}</UserMessageBubble>
                                </div>
                              )
                            }
                            const memThinking = m.trace?.turnId ? (studyThinkingMapRef.current.get(m.trace.turnId) || '') : ''
                            const hydratedTrace = m.trace ? (memThinking ? { ...m.trace, thinkingText: memThinking } : m.trace) : null
                            const isLatest = idx === persistedMsgs.length - 1 && !activeStudyTurn
                            const prevUser = persistedMsgs[idx - 1]?.role === 'user' ? persistedMsgs[idx - 1].text : ''
                            return (
                              <div key={idx} className="ca-chat-msg ca-chat-assistant">
                                {hydratedTrace && (
                                  <TurnProcess trace={hydratedTrace} streaming={false} hasContent={Boolean(m.text)} />
                                )}
                                {m.text && <MarkdownProse text={m.text} />}
                                {m.text && (
                                  <div className="ca-chat-msg-tools">
                                    <CopyButton text={m.text} label={t('agent.copyReply')} className="ca-chat-tool-btn" />
                                    {isLatest && prevUser && (
                                      <button
                                        type="button"
                                        className="ca-chat-tool-btn"
                                        disabled={studyStreaming || probing}
                                        onClick={() => void submitStudyQuestion(prevUser, {
                                          replaceLast: true,
                                          expectedUpdatedAt: activeProbe.updatedAt || '',
                                          replaceTurnId: m.trace?.turnId || '',
                                        })}
                                      >
                                        {t('agent.regenerate')}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                          {activeStudyTurn && (
                            <>
                              <div className="ca-chat-msg ca-chat-user">
                                <UserMessageBubble className="ca-chat-user-bubble">{activeStudyTurn.question}</UserMessageBubble>
                              </div>
                              <div className="ca-chat-msg ca-chat-assistant">
                                <TurnProcess
                                  trace={activeStudyTurn.trace}
                                  streaming={Boolean(activeStudyTurn.streaming)}
                                  hasContent={Boolean(activeStudyTurn.content)}
                                  fallbackStatus={t('jobDetail.mentorThinkingShort')}
                                />
                                {activeStudyTurn.content && (
                                  <MarkdownProse text={activeStudyTurn.content} streaming={Boolean(activeStudyTurn.streaming)} />
                                )}
                                {!activeStudyTurn.streaming && activeStudyTurn.error && (
                                  <p className="ca-form-error" role="alert">{activeStudyTurn.error}</p>
                                )}
                                {!activeStudyTurn.streaming && activeStudyTurn.retryQuestion && (
                                  <div className="ca-chat-msg-tools">
                                    <button
                                      type="button"
                                      className="ca-chat-tool-btn"
                                      disabled={probing}
                                      onClick={() => void submitStudyQuestion(activeStudyTurn.retryQuestion, {
                                        replaceLast: Boolean(activeStudyTurn.replaceLast),
                                        expectedUpdatedAt: activeStudyTurn.expectedUpdatedAt || '',
                                        replaceTurnId: activeStudyTurn.replaceTurnId || '',
                                      })}
                                    >
                                      {t('agent.regenerate')}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      <div className={`ca-study-escalate${showEscalateBanner ? ' is-visible' : ''}`} aria-hidden={!showEscalateBanner}>
                        <div className="ca-study-escalate-inner">
                          <div className="ca-study-escalate-card">
                            <div className="ca-study-escalate-copy">
                              <strong>{t('jobDetail.escalateTitle', { count: studyUserTurns, term: activeProbeTerm })}</strong>
                              <small>{t('jobDetail.escalateDesc')}</small>
                            </div>
                            <Button variant="primary" size="sm" onClick={() => launchDshSession(activeStudyPrompt)}>
                              {t('jobDetail.escalateBtn')}
                            </Button>
                          </div>
                        </div>
                      </div>

                      <form className="ca-jd-study-composer" onSubmit={e => { e.preventDefault(); void submitStudyQuestion() }}>
                        <div className="ca-jd-study-ghost">
                          <GhostInput
                            inputRef={studyInputRef}
                            surface="jd-study"
                            value={studyInput}
                            onChange={setStudyInput}
                            onSubmit={() => void submitStudyQuestion()}
                            disabled={probing || studyStreaming}
                            minRows={1}
                            maxLength={1200}
                            ariaLabel={t('jobDetail.studyInputAria', { term: activeProbeTerm })}
                            placeholder={t('jobDetail.studyInputPlaceholder', { term: activeProbeTerm })}
                            suggestContext={studySuggestContext}
                            fallbackSuggestion={studyFallbackHint}
                          />
                        </div>
                        <div className="ca-jd-study-foot">
                          <span className="ca-compose-hint">
                            {studyStreaming ? t('jobDetail.mentorThinkingShort') : ''}
                          </span>
                          {studyStreaming ? (
                            <Button type="button" variant="outline" size="sm" onClick={abortStudyStream}>
                              {t('common.stop')}
                            </Button>
                          ) : (
                            <Button type="submit" variant="primary" size="sm" disabled={probing || !studyInput.trim()}>
                              {t('jobDetail.askBtn')}
                            </Button>
                          )}
                        </div>
                      </form>
                    </div>
                  })()}
                </> : null}
              </div>
            )}
          </div>
        )}

        {activeLens === 'risk' && (
          <div className="ca-jd-panel">
            <div className="ca-jd-panel-head">
              <div className="ca-inline">
                <strong>{t('jobDetail.riskHeading')}</strong>
                {riskItems.length > 0 && <span className="ca-jd-lens-count">{riskItems.length}</span>}
              </div>
              <button type="button" className="ca-text-button" onClick={closeInspector}>{t('common.collapse')}</button>
            </div>
            {riskItems.length > 0 ? (
              <ul className="ca-jd-risk-list">
                {riskItems.map((item, idx) => {
                  const targetKey = (item.locateTerm || '').toLowerCase()
                  const isFocused = Boolean(targetKey && pinnedTerm === targetKey)
                  return <li key={idx} className={`ca-jd-risk-item${isFocused ? ' is-focused' : ''}`}>
                    <div className="ca-jd-risk-head">
                      <span className="ca-jd-risk-quote">{item.term}</span>
                      {item.locateTerm && (
                        <button type="button" className={`ca-jd-risk-locate${isFocused ? ' is-active' : ''}`}
                          onClick={() => isFocused ? setPinnedTerm('') : focusTermInJd(item.locateTerm)}>
                          {isFocused ? t('jobDetail.unlocate') : t('jobDetail.locateOriginal')}
                        </button>
                      )}
                    </div>
                    <p className="ca-jd-risk-desc">{item.translation}</p>
                    {item.question && (
                      <p className="ca-jd-risk-q">
                        <span>{t('jobDetail.askBackLabel')}</span>
                        {item.question}
                      </p>
                    )}
                  </li>
                })}
              </ul>
            ) : intelOp.running ? (
              <div className="ca-jd-empty-lens">
                <p className="ca-meta">{t('jobDetail.riskAnalyzingHint')}</p>
              </div>
            ) : !intel ? (
              <div className="ca-jd-empty-lens">
                <p className="ca-meta">{t('jobDetail.riskPendingHint')}</p>
                <Button variant="outline" size="sm" disabled={intelOp.running} onClick={() => {
                  AUTO_INTEL_ATTEMPTED.add(job.id)
                  void intelOp.run('job-intel', { id: job.id }, {
                    kind: 'job-intel',
                    label: `${job.company} · ${job.title}`,
                    toast: t('jobDetail.toastIntelDone'),
                  })
                }}>{t('jobDetail.riskAnalyzeBtn')}</Button>
              </div>
            ) : (
              <div className="ca-jd-empty-lens">
                <p className="ca-meta">{t('jobDetail.riskEmpty')}</p>
              </div>
            )}
          </div>
        )}

        {activeLens === 'diligence' && (
          <div className="ca-jd-panel">
            <div className="ca-jd-panel-head">
              <div className="ca-inline">
                <strong>{t('jobDetail.diligenceHeading')}</strong>
              </div>
              <button type="button" className="ca-text-button" onClick={closeInspector}>{t('common.collapse')}</button>
            </div>
            {intel?.diligence?.length > 0 ? (
              <ul className="ca-jd-verdict-points">
                {intel.diligence.map((item, idx) => <li key={idx}>{item}</li>)}
              </ul>
            ) : intelOp.running ? (
              <div className="ca-jd-empty-lens">
                <p className="ca-meta">{t('jobDetail.diligenceAnalyzingHint')}</p>
              </div>
            ) : (
              <div className="ca-jd-empty-lens">
                <p className="ca-meta">{t('jobDetail.diligenceEmptyHint')}</p>
              </div>
            )}
            <div className="ca-jd-diligence-actions">
              {onStartSession && (
                <Button variant="primary" size="sm" onClick={() => launchDshSession(diligencePrompt)}>
                  {t('jobDetail.openDshDiligence')}
                </Button>
              )}
              <CopyButton text={diligencePrompt} label={t('jobDetail.copyDshDiligence')} />
              {!intel && !intelOp.running && (
                <Button variant="outline" size="sm" onClick={() => {
                  AUTO_INTEL_ATTEMPTED.add(job.id)
                  void intelOp.run('job-intel', { id: job.id }, {
                    kind: 'job-intel',
                    label: `${job.company} · ${job.title}`,
                    toast: t('jobDetail.toastIntelDone'),
                  })
                }}>
                  {t('jobDetail.extractDiligenceBtn')}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    )}

    {/* Layer 3: Uncluttered Editorial JD Document Canvas */}
    <section className="ca-jd-reader" aria-label={t('jobDetail.jdReaderAria')}>
      <div className="ca-jd-reader-bar">
        <div className="ca-jd-filter-group" role="group" aria-label={t('jobDetail.hlFilterAria')}>
          {hasAny ? <>
            <button type="button" className={`ca-jd-filter-btn${hlFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => { setHlFilter('all'); setPinnedTerm('') }}>{t('common.all')}</button>
            {matchCount > 0 && (
              <button type="button" className={`ca-jd-filter-btn${hlFilter === 'match' ? ' is-active' : ''}`}
                onClick={() => { setHlFilter('match'); setPinnedTerm('') }}>
                <i className="ca-jd-swatch is-match" aria-hidden="true" />
                <span>{t('jobDetail.hlMatch', { count: matchCount })}</span>
              </button>
            )}
            {learnCount > 0 && (
              <button type="button" className={`ca-jd-filter-btn${hlFilter === 'learn' ? ' is-active' : ''}`}
                onClick={() => { setHlFilter('learn'); setPinnedTerm('') }}>
                <i className="ca-jd-swatch is-learn" aria-hidden="true" />
                <span>{t('jobDetail.hlLearn', { count: learnCount })}</span>
              </button>
            )}
            {riskCount > 0 && (
              <button type="button" className={`ca-jd-filter-btn${hlFilter === 'risk' ? ' is-active' : ''}`}
                onClick={() => { setHlFilter('risk'); setPinnedTerm('') }}>
                <i className="ca-jd-swatch is-risk" aria-hidden="true" />
                <span>{t('jobDetail.hlRisk', { count: riskCount })}</span>
              </button>
            )}
            <button type="button" className={`ca-jd-filter-btn${hlFilter === 'off' ? ' is-active' : ''}`}
              onClick={() => { setHlFilter('off'); setPinnedTerm('') }}>{t('jobDetail.hlPlain')}</button>
            {pinnedTerm && (
              <button type="button" className="ca-filter-chip" onClick={() => setPinnedTerm('')}>
                <span>{t('jobDetail.hlFocus', { term: pinnedTerm })}</span>
                <span className="ca-filter-chip-x" aria-hidden="true">×</span>
              </button>
            )}
          </> : <span className="ca-meta">{t('jobDetail.rawJdLabel')}</span>}
        </div>
        <CopyButton text={job.jd} label={t('jobDetail.copyJd')} />
      </div>

      <div className={`ca-jd-body${pinnedTerm ? ' has-pinned' : ''}`} ref={bodyRef}>
        {annotated.blocks.map((block, idx) => {
          if (block.type === 'heading') return <h4 key={idx} className="ca-jd-h">{block.text}</h4>
          if (block.type === 'list') {
            return <ul key={idx} className="ca-jd-ul">
              {block.items.map((segs, li) => <li key={li}>{renderSegments(segs)}</li>)}
            </ul>
          }
          return <p key={idx} className="ca-jd-p">{renderSegments(block.segments)}</p>
        })}
      </div>
    </section>
  </div>
}

