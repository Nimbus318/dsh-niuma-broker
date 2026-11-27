import React from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useHasTrackedOperation } from './AiActivity.jsx'
import Sources, { sourceStatus } from './Sources.jsx'
import MarketInsights from './MarketInsights.jsx'
import { BrokerBrandEmblem } from './Emblems.jsx'
import { Icon } from './ResumeLibrary.jsx'
import { VERSION_HOVER_PREVIEW_CACHE } from './ResumeVersionMenu.jsx'
import Resume from './ResumeWorkbench.jsx'
import Jobs from './JobsView.jsx'
import { displayResume, list, request } from './shared.js'
import { getActiveLocale, getBrandTitle, I18nProvider, setActiveHostLocale, setActiveLocalePreference, setHostLocaleBound, subscribeLocale, useI18n } from './i18n.jsx'
import {
  activateProfileScope,
  captureProfileContext,
  getActiveProfileKey,
  isProfileContextCurrent,
  migrateLegacyStorageLocked,
  readProfileSession,
  subscribeProfileMismatch,
  writeProfileSession,
} from './profile-storage.js'
import { sourceMatchesForgotten, useHasResumeChatStreaming, useHasRunningComposer } from './draft-hooks.jsx'
import { LiveBeacon, SlidingTabs } from './Motion.jsx'
import { connectHostLocale, translate } from '../src/i18n/index.mjs'
import { version as CLIENT_VERSION } from '../package.json'

const ID = 'niuma'
const TAB_SPECS = [
  ['resume', 'nav.resume', 'file'],
  ['jobs', 'nav.jobs', 'briefcase'],
  ['insights', 'nav.insights', 'trend'],
]
const ACTIVE_TAB_KEY = 'activeTab'

function BrokerIcon({ size = 16 }) {
  return <Icon name="briefcase" size={size} />
}

function useWorkspace(workspaceCacheRef = null) {
  const [state, setState] = React.useState(() => {
    const cached = workspaceCacheRef?.current
    const pk = getActiveProfileKey()
    return cached && pk && cached.profileKey === pk ? cached.state : null
  })
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [activeTriageOps, setActiveTriageOps] = React.useState(0)
  const operation = React.useRef(false)
  const lastErrorRef = React.useRef('')
  const fetchVersion = React.useRef(0)
  const hasStateRef = React.useRef(Boolean(state))
  hasStateRef.current = Boolean(state)

  const reload = React.useCallback(async (signal) => {
    const version = ++fetchVersion.current
    try {
      const endpoint = hasStateRef.current ? 'state' : 'state?deferMarket=1'
      const next = await request(endpoint, null, signal, { locale: getActiveLocale() })
      if (version === fetchVersion.current) {
        const nextState = next.state ?? next
        if (nextState?.profileKey) {
          await migrateLegacyStorageLocked(nextState, {
            profileKey: nextState.profileKey,
            resolveResumeBaseText: row => displayResume(row, list(nextState.resumes)),
          })
          if (version !== fetchVersion.current) return true
          const scopeChange = activateProfileScope(nextState.profileKey)
          if (scopeChange.changed) VERSION_HOVER_PREVIEW_CACHE.clear()
          const finalState = { ...nextState, profileGeneration: scopeChange.generation }
          if (workspaceCacheRef) workspaceCacheRef.current = { profileKey: finalState.profileKey, state: finalState }
          setState(finalState)
          return true
        }
        if (workspaceCacheRef) workspaceCacheRef.current = { profileKey: getActiveProfileKey(), state: nextState }
        setState(nextState)
      }
      return true
    } catch (e) {
      if (version === fetchVersion.current && e.name !== 'AbortError') setError(e.message)
      return false
    }
  }, [workspaceCacheRef])

  React.useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    const unsubscribeMismatch = subscribeProfileMismatch(() => {
      if (workspaceCacheRef) workspaceCacheRef.current = null
      void reload()
    })
    const onForgottenWindow = () => {
      if (workspaceCacheRef) workspaceCacheRef.current = null
    }
    window.addEventListener('niuma:source-forgotten', onForgottenWindow)
    const timer = setInterval(() => {
      if (!document.hidden && !operation.current) void reload(controller.signal)
    }, 20_000)
    return () => {
      unsubscribeMismatch()
      window.removeEventListener('niuma:source-forgotten', onForgottenWindow)
      clearInterval(timer)
      controller.abort()
    }
  }, [reload, workspaceCacheRef])

  React.useEffect(() => {
    if (!state?.marketRadar?.loading) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled && !operation.current) void reload()
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [state?.marketRadar?.loading, reload])

  const triagePollingActive = Boolean(state?.triageSummary?.running) || activeTriageOps > 0
  React.useEffect(() => {
    if (!triagePollingActive) return
    let cancelled = false
    let timer = null
    const schedule = delayMs => {
      if (cancelled) return
      timer = window.setTimeout(async () => {
        if (cancelled) return
        if (!document.hidden && !operation.current) {
          await reload()
        }
        if (!cancelled) schedule(1200)
      }, delayMs)
    }
    schedule(450)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [triagePollingActive, reload])

  React.useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 4000)
    return () => window.clearTimeout(timer)
  }, [message])

  const act = async (action, args = {}, toast = '') => {
    const locale = getActiveLocale()
    if (operation.current) {
      lastErrorRef.current = translate(locale, 'banner.busyConflict')
      return null
    }
    const ctxSnap = captureProfileContext()
    operation.current = true
    lastErrorRef.current = ''
    setBusy(action)
    setError('')
    setMessage('')
    try {
      const reply = await request('action', { ...args, action }, undefined, { profileKey: ctxSnap.profileKey, locale })
      if (!isProfileContextCurrent(ctxSnap)) return null
      await reload()
      if (!isProfileContextCurrent(ctxSnap)) return null
      if (reply.result?.error || reply.result?.lastError) {
        const msg = reply.result.error || reply.result.lastError
        lastErrorRef.current = msg
        setError(msg)
      } else {
        const resolvedToast = typeof toast === 'function' ? toast(reply.result) : toast
        setMessage(reply.result?.running ? translate(locale, 'banner.backgroundRunning') : resolvedToast)
      }
      return reply
    } catch (e) {
      if (!isProfileContextCurrent(ctxSnap) || e?.code === 'PROFILE_MISMATCH') return null
      lastErrorRef.current = e.message || translate(locale, 'activity.actionFailedFallback')
      setError(e.message)
      return null
    } finally {
      operation.current = false
      setBusy('')
    }
  }
  act.getLastError = () => lastErrorRef.current
  act.reload = reload
  act.notify = msg => setMessage(String(msg || ''))
  act.background = async (action, args = {}, toast = '', signal = undefined) => {
    const locale = getActiveLocale()
    const ctxSnap = captureProfileContext()
    const isTriage = action === 'triage-jobs'
    if (isTriage) setActiveTriageOps(c => c + 1)
    try {
      const reply = await request('action', { ...args, action }, signal, { profileKey: ctxSnap.profileKey, locale })
      if (!isProfileContextCurrent(ctxSnap)) return { ok: false, staleProfile: true }
      await reload()
      if (!isProfileContextCurrent(ctxSnap)) return { ok: false, staleProfile: true }
      if (reply.result?.error || reply.result?.lastError) {
        const msg = reply.result.error || reply.result.lastError
        lastErrorRef.current = msg
        return { ok: false, error: msg, result: reply.result }
      }
      const resolvedToast = typeof toast === 'function' ? toast(reply.result) : toast
      if (resolvedToast) setMessage(resolvedToast)
      return reply
    } catch (e) {
      if (!isProfileContextCurrent(ctxSnap) || e?.code === 'PROFILE_MISMATCH') {
        return { ok: false, staleProfile: true, ...(e?.code ? { code: e.code } : {}) }
      }
      const msg = e.message || translate(locale, 'activity.actionFailedFallback')
      lastErrorRef.current = msg
      return { ok: false, error: msg }
    } finally {
      if (isTriage) setActiveTriageOps(c => Math.max(0, c - 1))
    }
  }

  const silentAct = React.useCallback(async (action, args = {}) => {
    const ctxSnap = captureProfileContext()
    try {
      const reply = await request('action', { ...args, action }, undefined, { profileKey: ctxSnap.profileKey, locale: getActiveLocale() })
      if (!isProfileContextCurrent(ctxSnap)) return null
      await reload()
      if (!isProfileContextCurrent(ctxSnap)) return null
      return reply
    } catch {
      return null
    }
  }, [reload])

  return { state, error, message, busy, act, silentAct, reload: async () => { setError(''); await reload() } }
}


function Panel({ onStartSession, workspaceCacheRef = null }) {
  const { state, error, message, busy, act, silentAct, reload } = useWorkspace(workspaceCacheRef)
  const content = state && {
    ...state,
    config: {
      ...state.preferences,
      ...state.config,
      sources: state.config?.sources ?? state.sources ?? [],
      mode: state.config?.mode ?? state.mode,
    },
  }
  const panelKey = content?.profileKey ? `${content.profileKey}:${content.profileGeneration ?? 0}` : 'boot'
  return (
    <PanelBody
      key={panelKey}
      content={content}
      error={error}
      message={message}
      busy={busy}
      act={act}
      silentAct={silentAct}
      reload={reload}
      onStartSession={onStartSession}
    />
  )
}

function PanelBody({ content, error, message, busy, act: rawAct, silentAct: rawSilentAct, reload, onStartSession }) {
  const { t, bcp47 } = useI18n()
  const panelCtxRef = React.useRef(null)
  if (!panelCtxRef.current) panelCtxRef.current = captureProfileContext()
  const scopedAct = React.useMemo(() => {
    const bound = (action, args, toast) => {
      if (!isProfileContextCurrent(panelCtxRef.current)) return Promise.resolve({ ok: false, staleProfile: true })
      return rawAct(action, args, toast)
    }
    bound.background = (action, args, toast, signal) => {
      if (!isProfileContextCurrent(panelCtxRef.current)) return Promise.resolve({ ok: false, staleProfile: true })
      return typeof rawAct?.background === 'function'
        ? rawAct.background(action, args, toast, signal)
        : rawAct(action, args, toast)
    }
    bound.getLastError = () => rawAct?.getLastError?.() ?? ''
    bound.reload = () => rawAct?.reload?.()
    bound.notify = msg => rawAct?.notify?.(msg)
    return bound
  }, [rawAct])
  const act = scopedAct
  const silentAct = React.useCallback((action, args) => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return Promise.resolve(null)
    return rawSilentAct(action, args)
  }, [rawSilentAct])
  const [tab, setTabState] = React.useState(() => {
    const saved = readProfileSession(ACTIVE_TAB_KEY)
    return saved === 'jobs' || saved === 'insights' ? saved : 'resume'
  })
  const bodyProfileKey = content?.profileKey || ''
  const setTab = React.useCallback(next => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    setTabState(next)
    if (bodyProfileKey) writeProfileSession(ACTIVE_TAB_KEY, next, { profileKey: bodyProfileKey })
  }, [bodyProfileKey])
  const [sourcesOpen, setSourcesOpen] = React.useState(false)
  const [sourcesFocus, setSourcesFocus] = React.useState('')
  const [focusedJob, setFocusedJob] = React.useState(null)
  const [pendingJobFilter, setPendingJobFilter] = React.useState(null)
  const [returnJob, setReturnJob] = React.useState(null)
  const [focusedResume, setFocusedResume] = React.useState(null)
  const [resumeSeedPrompt, setResumeSeedPrompt] = React.useState('')
  const [pendingTailor, setPendingTailor] = React.useState(null)
  const retainedPreviewRef = React.useRef(null)

  React.useEffect(() => {
    if (!content?.profileKey) return
    const saved = readProfileSession(ACTIVE_TAB_KEY)
    if (saved === 'jobs' || saved === 'insights' || saved === 'resume') setTabState(saved)
  }, [content?.profileKey])

  // Sync persisted server locale preference into live client i18n store when state/profile loads/updates.
  const syncedLocaleProfileRef = React.useRef('')
  React.useEffect(() => {
    if (!content) return
    const pk = content.profileKey || ''
    const rawPref = typeof content?.config?.locale === 'string' ? content.config.locale.trim() : ''
    if (rawPref && rawPref !== 'auto') {
      syncedLocaleProfileRef.current = pk
      setActiveLocalePreference(rawPref, { persist: true })
    } else if (syncedLocaleProfileRef.current !== pk || rawPref === 'auto') {
      syncedLocaleProfileRef.current = pk
      setActiveLocalePreference('auto', { persist: false })
    }
  }, [content?.profileKey, content?.config?.locale, Boolean(content)])

  const localizedTabs = React.useMemo(
    () => TAB_SPECS.map(([id, labelKey, icon]) => [id, t(labelKey), icon]),
    [t],
  )

  const captureReturnJob = (explicitJob, fallbackSection = 'progress') => {
    const target = explicitJob
      ?? (focusedJob?.id ? list(content?.opportunities).find(o => o.id === focusedJob.id) : null)
    if (!target?.id) return
    setReturnJob({
      id: target.id,
      company: target.company || '',
      title: target.title || '',
      url: target.url || '',
      section: focusedJob?.section || fallbackSection,
    })
  }
  const navigate = next => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    setFocusedJob(null)
    setFocusedResume(null)
    if (next === 'jobs') setReturnJob(null)
    setTab(next)
  }
  const openJob = (id, section = '') => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setReturnJob(null)
    setFocusedJob(id ? { id, section } : null)
    setTab('jobs')
  }
  const clearFocusedJob = React.useCallback(() => {
    setFocusedJob(null)
    window.requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
  }, [])
  const openResume = id => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    captureReturnJob(null, 'progress')
    setFocusedJob(null)
    setFocusedResume(id || null)
    setTab('resume')
  }
  const openResumeForTailor = job => {
    if (!isProfileContextCurrent(panelCtxRef.current) || !job?.id) return
    captureReturnJob(job, 'jd')
    setFocusedJob(null)
    setFocusedResume(null)
    setPendingTailor({ id: job.id, label: [job.company, job.title].filter(Boolean).join(' · '), nonce: Date.now() })
    setTab('resume')
  }
  const consumeTailor = React.useCallback(() => setPendingTailor(null), [])
  const consumeJobFilter = React.useCallback(() => setPendingJobFilter(null), [])
  const exploreJobsFromInsights = React.useCallback(filter => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    setFocusedJob(null)
    setReturnJob(null)
    setPendingJobFilter(filter ? { ...filter, nonce: Date.now() } : null)
    setTab('jobs')
  }, [setTab])
  const openResumeWithPrompt = prompt => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    captureReturnJob(null, 'debrief')
    setResumeSeedPrompt(prompt)
    setFocusedJob(null)
    setTab('resume')
  }
  const handleReturnToJob = () => {
    if (!isProfileContextCurrent(panelCtxRef.current) || !returnJob?.id) return
    const target = returnJob
    setReturnJob(null)
    setFocusedJob({ id: target.id, section: target.section || 'progress' })
    setTab('jobs')
  }
  const consumeSeedPrompt = React.useCallback(() => setResumeSeedPrompt(''), [])
  React.useEffect(() => {
    const onForgotten = event => {
      const sourceId = typeof event?.detail?.sourceId === 'string' ? event.detail.sourceId.trim() : ''
      setResumeSeedPrompt(prev => (prev && typeof prev === 'object' && sourceMatchesForgotten(prev.sourceIds, sourceId) ? '' : prev))
    }
    window.addEventListener('niuma:source-forgotten', onForgotten)
    return () => window.removeEventListener('niuma:source-forgotten', onForgotten)
  }, [])
  const openSources = section => {
    if (!isProfileContextCurrent(panelCtxRef.current)) return
    setSourcesFocus(typeof section === 'string' ? section : '')
    setSourcesOpen(true)
  }
  const closeSources = React.useCallback(() => {
    setSourcesOpen(false)
    setSourcesFocus('')
  }, [])
  const status = sourceStatus(content, busy, t)

  // Accurate badge counts — NO zombie badge for superseded old pending drafts!
  const resumePendingCount = list(content?.evidence).filter(item => item.status === 'pending').length
  const jobsPendingCount = list(content?.intakes).length + list(content?.recordings?.interviews).length + list(content?.notifications).length
  const tailorResumeActive = useHasTrackedOperation('tailor-resume', content?.activeOperations)
  const resumeRebaseActive = useHasTrackedOperation('resume-rebase', content?.activeOperations)
  const resumeChatStreamingActive = useHasResumeChatStreaming()
  const jobIntelActive = useHasTrackedOperation('job-intel', content?.activeOperations)
  const tailorJobActive = useHasTrackedOperation('tailor', content?.activeOperations)
  const jdProbeActive = useHasTrackedOperation('jd-probe', content?.activeOperations)
  const discoverCompaniesActive = useHasTrackedOperation('discover-companies', content?.activeOperations)
  const jobsComposerActive = useHasRunningComposer('jobs')
  const marketInsightActive = useHasTrackedOperation('market-insight', content?.activeOperations)

  const resumeRunning = tailorResumeActive || resumeRebaseActive || resumeChatStreamingActive
  const jobsRunning = Boolean(content?.triageSummary?.running)
    || Boolean(content?.watch?.running)
    || jobIntelActive
    || tailorJobActive
    || jdProbeActive
    || discoverCompaniesActive
    || jobsComposerActive
  const insightsRunning = marketInsightActive || Boolean(content?.marketRadar?.running)
  const tabCounts = { resume: resumePendingCount, jobs: jobsPendingCount }
  const runningTabs = { resume: resumeRunning, jobs: jobsRunning, insights: insightsRunning }
  const hasActiveResume = list(content?.resumes).some(row => !row.archivedAt && row.status !== 'revoked' && row.status !== 'rejected')
  const studioMode = tab === 'resume' && !!content && hasActiveResume

  return <div className="ca-page" lang={bcp47}>
    <style>{__CAREER_AGENT_CSS__}</style>
    <header className="ca-header" data-window-drag>
      <div className="ca-header-inner">
        <div className="ca-brand">
          <BrokerBrandEmblem size={22} />
          <h1>{t('brand.name')}</h1>
        </div>
        <SlidingTabs tabs={localizedTabs} value={tab} onChange={navigate} counts={tabCounts} runningTabs={runningTabs}
          renderIcon={icon => <Icon name={icon} size={14} />} />
        <button type="button" className="ca-source-trigger" data-status={status.dot} onClick={() => openSources('')} disabled={!content}
          aria-label={t('nav.sourcesButtonAria', { status: status.label })} aria-haspopup="dialog" title={t('nav.sourcesButtonTitle')}>
          <LiveBeacon state={status.dot} />
          <span className="ca-source-trigger-label">{status.label}</span>
          <svg className="ca-source-trigger-sliders" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 5h11M2.5 11h11" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            <circle cx="6" cy="5" r="1.6" fill="var(--ca-bg)" stroke="currentColor" strokeWidth="1.35" />
            <circle cx="10.5" cy="11" r="1.6" fill="var(--ca-bg)" stroke="currentColor" strokeWidth="1.35" />
          </svg>
        </button>
      </div>
    </header>

    <main key={`${content?.profileKey || ''}:${tab}`} className={studioMode ? 'ca-scroll ca-scroll-studio' : 'ca-scroll'}>
      {content && content.pluginVersion !== CLIENT_VERSION && <div className="ca-error-banner-wrap">
        <div className="ca-notice warning" role="status">
          <span>{t('banner.versionMismatch', { clientVersion: CLIENT_VERSION, serverVersion: content.pluginVersion ? `v${content.pluginVersion}` : t('banner.oldVersion') })}</span>
        </div>
      </div>}

      {error && !sourcesOpen && <div className="ca-error-banner-wrap">
        <div className="ca-notice error" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={reload} disabled={!!busy}>{t('common.refresh')}</Button>
        </div>
      </div>}

      {!content && !error && (
        <div className="ca-width ca-content">
          <div className="ca-loading-shell" role="status" aria-label={t('status.connectingBroker')}>
            <div className="ca-loading-caption">{t('status.connectingBroker')}</div>
            <div className="ca-skeleton-card">
              <div className="ca-skeleton-bar is-title" />
              <div className="ca-skeleton-bar is-wide" />
              <div className="ca-skeleton-bar is-mid" />
            </div>
            <div className="ca-skeleton-card">
              <div className="ca-skeleton-bar is-title" />
              <div className="ca-skeleton-bar is-wide" />
            </div>
          </div>
        </div>
      )}

      {content && (
        tab === 'resume' ? <Resume state={content} busy={busy} act={act} silentAct={silentAct} initialId={focusedResume}
          onSources={openSources} retainedPreviewRef={retainedPreviewRef}
          seedPrompt={resumeSeedPrompt} onConsumeSeedPrompt={consumeSeedPrompt}
          pendingTailor={pendingTailor} onConsumeTailor={consumeTailor}
          returnJob={returnJob} onReturnToJob={handleReturnToJob} onDismissReturnJob={() => setReturnJob(null)} />
          : tab === 'insights' ? <div className="ca-width ca-content ca-content-insights">
            <MarketInsights
              state={content}
              act={act}
              busy={busy}
              onExploreJobs={exploreJobsFromInsights}
              onOpenJobs={() => navigate('jobs')}
              onResumeWithPrompt={openResumeWithPrompt}
              onStartSession={onStartSession}
              onSources={openSources}
            />
          </div>
          : <div className="ca-width ca-content ca-content-jobs">
            <Jobs state={content} busy={busy} act={act} focusedJob={focusedJob}
              onClearFocus={clearFocusedJob} onOpenJob={openJob} onResume={openResume}
              onTailorJob={openResumeForTailor}
              onResumeWithPrompt={openResumeWithPrompt} onSources={openSources}
              onStartSession={onStartSession}
              onOpenResumeTab={() => setTab('resume')}
              pendingJobFilter={pendingJobFilter}
              onConsumeJobFilter={consumeJobFilter} />
          </div>
      )}
    </main>

    {message && !sourcesOpen && <div className="ca-toast" role="status"><Icon name="check" size={14} /><span>{message}</span></div>}
    {sourcesOpen && content && <Sources state={content} busy={busy} act={act} toast={message} focusSection={sourcesFocus} onClose={closeSources} error={error} />}
  </div>
}

export const inject = ['slots']

export function apply(ctx) {
  const startDshSession = prompt => {
    const text = String(prompt || '').trim()
    let ws = null
    try {
      ws = typeof ctx.get === 'function' ? (ctx.get('uiWorkspace') ?? null) : (ctx?.uiWorkspace ?? null)
    } catch {
      ws = null
    }
    if (ws && typeof ws.startSession === 'function') {
      ws.startSession(undefined, { prompt: text, whenDraftExists: 'keep' })
      return true
    }
    if (text) void writeClipboard(text)
    return false
  }
  connectHostLocale(ctx, {
    onBound: setHostLocaleBound,
    onLocaleChange: setActiveHostLocale,
  })
  const workspaceCacheRef = { current: null }
  const BoundPanel = () => (
    <I18nProvider>
      <Panel onStartSession={startDshSession} workspaceCacheRef={workspaceCacheRef} />
    </I18nProvider>
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, BoundPanel))
  ctx.slots.inject('sidebar.panellist', () => {
    const releaseSlot = handle => {
      if (typeof handle === 'function') handle()
      else if (handle && typeof handle.dispose === 'function') handle.dispose()
    }
    let currentLabel = getBrandTitle()
    let handle = ctx.slots.register({ name: 'sidebar.panellist', id: ID, order: 6, label: currentLabel }, BrokerIcon)
    const unsubscribe = subscribeLocale(() => {
      const nextLabel = getBrandTitle()
      if (nextLabel === currentLabel) return
      currentLabel = nextLabel
      try { releaseSlot(handle) } catch {}
      handle = ctx.slots.register({ name: 'sidebar.panellist', id: ID, order: 6, label: nextLabel }, BrokerIcon)
    })
    return () => {
      unsubscribe()
      try { releaseSlot(handle) } catch {}
    }
  })
}
