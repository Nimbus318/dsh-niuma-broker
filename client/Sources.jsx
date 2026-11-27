import React from 'react'
import { Button, SegmentedControl, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveDefaultModelRow, useModels } from './Composer.jsx'
import { DistillEmblem, IntelEmblem, PatrolEmblem } from './Emblems.jsx'
import { InfoTip, LiveBeacon, SideSheet, useMenuDismiss } from './Motion.jsx'
import { SOURCE_LABELS, sourceLabel } from './shared.js'
import { detectBrowserHostLocale, getActiveLocale, useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  getActiveProfileKey,
  getProfileGeneration,
  isProfileContextCurrent,
  profileRequestHeaders,
} from './profile-storage.js'
import { localeMeta, translate } from '../src/i18n/index.mjs'
import {
  buildAutoIntelTogglePatch, buildBoardsTogglePatch, buildScopeSavePatch,
  buildSessionsTogglePatch, deriveAutomationFlags,
} from '../src/automation-toggles.mjs'

const prefix = 'workspace:'
const modeKeys = [
  ['workspace', 'sources.modeWorkspace', 'sources.modeWorkspaceDesc'],
  ['all', 'sources.modeAll', 'sources.modeAllDesc'],
  ['none', 'sources.modeNone', 'sources.modeNoneDesc'],
]
function formatPatrolCadence(minutes, t) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return t('composer.everyNHours', { count: 6 })
  if (m % 1440 === 0) return t('composer.everyNDays', { count: m / 1440 })
  if (m % 60 === 0) return t('composer.everyNHours', { count: m / 60 })
  return t('composer.everyNMinutes', { count: m })
}
const personalApps = [
  ['calendar', 'destination.calendar', 'destination.calendarDesc', 'blue'],
  ['reminders', 'destination.reminders', 'destination.remindersDesc', 'amber'],
  ['things', 'destination.things', 'destination.thingsDesc', 'indigo'],
]
const sourceNames = SOURCE_LABELS

function AppGlyph({ kind }) {
  if (kind === 'calendar') {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="3" /><path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  }
  if (kind === 'things') {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="m8 12.2 2.8 2.8L16.5 9" />
    </svg>
  }
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.2" fill="currentColor" /><circle cx="4.5" cy="12" r="1.2" fill="currentColor" /><circle cx="4.5" cy="18" r="1.2" fill="currentColor" />
  </svg>
}

function AppLogo({ kind, tone }) {
  const [failed, setFailed] = React.useState(false)
  if (!failed) {
    return <span className="ca-app-logo-wrap" aria-hidden="true">
      <img
        className="ca-app-native-icon"
        src={`api/career-agent/app-icon?destination=${encodeURIComponent(kind)}`}
        width="36"
        height="36"
        alt=""
        draggable="false"
        onError={() => setFailed(true)}
      />
    </span>
  }
  return <span className={`ca-app-badge tone-${tone}`} aria-hidden="true"><AppGlyph kind={kind} /></span>
}

function useWorkspaces(profileKey = '') {
  const { t } = useI18n()
  const [catalog, setCatalog] = React.useState({ rows: [], loading: true, error: '' })
  const [attempt, retry] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    if (profileKey && profileKey !== getActiveProfileKey()) {
      setCatalog({ rows: [], loading: false, error: '' })
      return
    }
    const reqCtx = profileKey
      ? { profileKey, generation: getProfileGeneration() }
      : captureProfileContext()
    const controller = new AbortController()
    setCatalog({ rows: [], loading: true, error: '' })
    fetch('api/career-agent/workspaces', {
      headers: profileRequestHeaders({ 'x-career-locale': getActiveLocale() }, reqCtx),
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    })
      .then(async response => {
        const data = await response.json().catch(() => null)
        checkProfileMismatch(response, data)
        if (!isProfileContextCurrent(reqCtx)) return
        if (!response.ok || !Array.isArray(data)) throw new Error(data?.error || t('sources.workspacesError'))
        if (!controller.signal.aborted) setCatalog({ rows: data, loading: false, error: '' })
      })
      .catch(error => {
        if (!controller.signal.aborted && isProfileContextCurrent(reqCtx)) {
          setCatalog({ rows: [], loading: false, error: error.message })
        }
      })
    return () => controller.abort()
  }, [attempt, profileKey, t])
  return { ...catalog, retry }
}

export function sourceStatus(state, busy, t) {
  const tr = t || (key => translate(getActiveLocale(), key))
  if (!state) return { dot: 'idle', mark: 'idle', label: tr('status.connecting') }
  if (state.watch?.running || busy === 'run') return { dot: 'ongoing', mark: 'running', label: tr('status.running') }
  if (state.watch?.lastError && state.config.mode !== 'off') return { dot: 'error', mark: 'error', label: tr('status.needsAttention') }
  const hasWork = state.config.sources?.some(row => row.id === 'dsh-session' && !row.revokedAt && row.projects?.length > 0)
    || state.recordings?.sources?.some(row => row.enabled && row.available)
  const sessionsOn = state.config.mode !== 'off' && state.config.watchSessions !== false && hasWork
  const boardsOn = state.config.mode === 'search' && (state.config.boards?.length > 0)
  const autoIntelOn = state.config.mode !== 'off' && state.config.sendToModel === true && state.config.autoJobIntel === true
  if (sessionsOn && boardsOn) return { dot: 'done', mark: 'ready', label: tr('status.autoRunning') }
  if (boardsOn) return { dot: 'done', mark: 'ready', label: tr('status.patrolling') }
  if (sessionsOn) return { dot: 'done', mark: 'ready', label: tr('status.distilling') }
  if (autoIntelOn) return { dot: 'done', mark: 'ready', label: tr('status.autoRunning') }
  return { dot: 'idle', mark: 'paused', label: tr('status.autoOff') }
}

async function fetchJson(route, t) {
  const response = await fetch(`api/career-agent/${route}`, {
    headers: profileRequestHeaders({ 'x-career-locale': getActiveLocale() }),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const data = await response.json().catch(() => null)
  checkProfileMismatch(response, data)
  if (!response.ok) throw new Error(data?.error || t('sources.fetchFailed', { status: response.status }))
  return data
}

function RecordingSources({ recordings, config, busy, act, timezone }) {
  const { t, formatDate } = useI18n()
  const sources = recordings?.sources ?? []
  if (!sources.length) {
    return <p className="ca-sheet-quiet">{t('sources.recordingEmpty')}</p>
  }
  return <div className="ca-sheet-list">
    {sources.map(source => {
      const incoming = [
        source.work && t('sources.recordingWork'),
        source.interview && t('sources.recordingInterview'),
        !source.available && t('sources.recordingOffline'),
      ].filter(Boolean).join(' · ')
      return <div className="ca-sheet-row" key={source.id}>
        <div className="ca-sheet-row-text">
          <strong>{source.name}</strong>
          <small>{incoming}{source.lastReceivedAt && t('sources.recordingRecent', { time: formatDate(source.lastReceivedAt, { timezone }) })}</small>
        </div>
        <Switch
          label={t('sources.allowSource', { name: source.name })}
          checked={!!source.enabled}
          disabled={!!busy || (!source.available && !source.enabled)}
          onChange={async next => {
            const reply = await act('recording-source', { id: source.id, enabled: next })
            if (!reply || reply.ok === false || reply.staleProfile) return
            if (next && config?.mode === 'off') {
              await act('configure', { config: { mode: 'observe' } })
            }
          }}
        />
      </div>
    })}
  </div>
}

function PersonalSyncSection({ state, act, busy, sectionRef, spotlight, onInteract }) {
  const { t } = useI18n()
  const [picker, setPicker] = React.useState(null)
  const [error, setError] = React.useState('')
  const schedule = state.config.personalSchedule ?? {}
  const connectedAny = Object.values(schedule).some(Boolean)
  const synced = Object.values(state.personalSync?.items ?? {}).filter(item => item.verified).length

  async function choose(destination) {
    if (picker?.destination === destination) { setPicker(null); return }
    setError('')
    setPicker({ destination, options: null })
    try {
      const result = await fetchJson(`personal-targets?destination=${encodeURIComponent(destination)}`, t)
      const options = [...new Set((Array.isArray(result) ? result : []).map(row => row?.name).filter(Boolean))]
      setPicker(current => current?.destination === destination ? { ...current, options } : current)
    } catch (reason) {
      setError(reason.message)
      setPicker(null)
    }
  }

  async function connectTarget(destination, targetName) {
    const reply = await act('configure', {
      config: { personalSchedule: { ...schedule, [destination]: targetName } },
    }, t('sources.toastConnected', { name: targetName }))
    if (reply) setPicker(null)
  }

  return <section ref={sectionRef} className={`ca-sheet-group ca-spotlight-target${spotlight ? ' is-spotlight' : ''}`} onPointerDown={onInteract}>
    <div className="ca-sheet-group-head">
      <h3>{t('sources.syncSectionTitle')}</h3>
    </div>
    <div className="ca-sheet-list">
      {personalApps.map(([id, nameKey, descKey, tone]) => {
        const name = t(nameKey)
        const desc = t(descKey)
        const connected = schedule[id]
        const picking = picker?.destination === id
        return <div className="ca-sheet-app-item" key={id}>
          <div className="ca-sheet-row">
            <AppLogo kind={id} tone={tone} />
            <div className="ca-sheet-row-text">
              <div className="ca-inline">
                <strong>{name}</strong>
                {connected && <Tag tone="success">{connected}</Tag>}
              </div>
              <small>{desc}</small>
            </div>
            {connected ? (
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => act('configure', { config: { personalSchedule: { ...schedule, [id]: null } } }, t('sources.toastDisconnected', { name }))}>{t('sources.disconnect')}</Button>
            ) : (
              <Button variant="outline" size="sm" disabled={!!busy || (!!picker && !picker.options)}
                onClick={() => choose(id)}>{picking ? t('common.cancel') : t('sources.connect')}</Button>
            )}
          </div>
          {picking && <div className="ca-target-tray">
            {picker.options === null ? (
              <p className="ca-meta">{t('sources.loadingTargets', { name })}</p>
            ) : picker.options.length ? <>
              <div className="ca-target-pills">
                {picker.options.slice(0, 18).map(option => (
                  <button key={option} type="button" className="ca-target-pill" disabled={!!busy}
                    onClick={() => void connectTarget(id, option)}>{option}</button>
                ))}
              </div>
            </> : <p className="ca-meta">{t('sources.noWritableTargets')}</p>}
          </div>}
        </div>
      })}
    </div>
    {error && <p className="ca-form-error" role="alert">{error}</p>}
    {state.personalSync?.lastError && <p className="ca-form-error">{state.personalSync.lastError}</p>}
    {synced > 0 && <p className="ca-meta">{t('sources.syncedCount', { count: synced })}</p>}
  </section>
}

function LanguageSection({ act }) {
  const { t, preference, setPreference, supportedLocales } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState('')
  const wrapRef = React.useRef(null)
  const detectedMeta = localeMeta(detectBrowserHostLocale())
  const activeMeta = preference === 'auto' ? null : localeMeta(preference)

  const closeLangMenu = React.useCallback(() => setOpen(false), [])
  useMenuDismiss(wrapRef, open, closeLangMenu)

  const choose = async nextPref => {
    setOpen(false)
    if (nextPref === preference || saving) return
    const ctxSnap = captureProfileContext()
    const prevPref = preference
    const prevLocale = prevPref === 'auto' ? detectBrowserHostLocale() : prevPref
    setSaveError('')
    setSaving(true)
    setPreference(nextPref)
    const runner = typeof act?.background === 'function' ? act.background : act
    const resolved = nextPref === 'auto' ? detectBrowserHostLocale() : nextPref
    try {
      const reply = await runner('configure', { config: { locale: nextPref } }, translate(resolved, 'sources.toastLanguageUpdated'))
      if (!isProfileContextCurrent(ctxSnap) || reply?.staleProfile || reply?.code === 'PROFILE_MISMATCH') return
      if (!reply || reply.ok === false) {
        setPreference(prevPref)
        setSaveError(reply?.error || translate(prevLocale, 'sources.languageSaveFailed'))
      }
    } catch (err) {
      if (!isProfileContextCurrent(ctxSnap) || err?.code === 'PROFILE_MISMATCH') return
      setPreference(prevPref)
      setSaveError(err?.message || translate(prevLocale, 'sources.languageSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const checkSvg = (
    <svg className="ca-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )

  return <>
    <section className="ca-lang-card" data-surface="language-setting" aria-label={t('sources.languageTitle')}>
      <div className="ca-lang-label-group">
        <strong className="ca-lang-label">{t('sources.languageTitle')}</strong>
        <InfoTip text={t('sources.languageDesc')} question={false} />
      </div>

      <div className="ca-lang-select-wrap" ref={wrapRef}>
        <button
          type="button"
          className={`ca-lang-trigger${open ? ' is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('sources.languageTitle')}
          disabled={saving}
          onClick={() => setOpen(v => !v)}
        >
          <svg className="ca-lang-globe" width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.25" />
            <path d="M2.2 8h11.6M8 1.9c1.7 1.8 2.6 3.9 2.6 6.1S9.7 12.3 8 14.1C6.3 12.3 5.4 10.2 5.4 8S6.3 3.7 8 1.9Z" stroke="currentColor" strokeWidth="1.15" />
          </svg>
          <span className="ca-lang-trigger-text">
            {preference === 'auto' ? t('sources.languageAuto') : (activeMeta?.nativeLabel || preference)}
          </span>
          {preference === 'auto' && (
            <span className="ca-lang-trigger-sub">{detectedMeta.nativeLabel}</span>
          )}
          <svg className="ca-select-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {open && <div className="ca-lang-pop ca-popover-surface" role="listbox" aria-label={t('sources.languageTitle')}>
          <button
            type="button"
            role="option"
            aria-selected={preference === 'auto'}
            className={`ca-lang-option${preference === 'auto' ? ' is-active' : ''}`}
            onClick={() => void choose('auto')}
          >
            <span className="ca-lang-option-body">
              <strong>{t('sources.languageAuto')}</strong>
              <small>{t('sources.languageAutoHint', { lang: detectedMeta.nativeLabel })}</small>
            </span>
            {preference === 'auto' && checkSvg}
          </button>
          <div className="ca-select-divider" role="separator" />
          {supportedLocales.map(item => {
            const active = preference === item.code
            const sub = item.englishName && item.englishName !== item.nativeLabel ? item.englishName : ''
            return <button
              key={item.code}
              type="button"
              role="option"
              aria-selected={active}
              className={`ca-lang-option${active ? ' is-active' : ''}`}
              onClick={() => void choose(item.code)}
            >
              <span className="ca-lang-option-body">
                <strong>{item.nativeLabel}</strong>
                {sub && <small>{sub}</small>}
              </span>
              {active && checkSvg}
            </button>
          })}
        </div>}
      </div>
    </section>
    {saveError && <p className="ca-form-error" role="alert">{saveError}</p>}
  </>
}

function DrawerContent({ state, busy, act, error, focusSection = '' }) {
  const { t, formatDate } = useI18n()
  const uid = React.useId()
  const { config, watch, recordings } = state
  const granted = config.sources.find(source => source.id === 'dsh-session')?.projects ?? []
  const legacy = granted.filter(id => id !== '*' && !id.startsWith(prefix))
  const existing = granted.filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length))
  const [scope, setScope] = React.useState(() => granted.includes('*') ? 'all' : existing.length ? 'workspace' : legacy.length ? 'legacy' : 'none')
  const [ids, setIds] = React.useState(existing)
  const [spotlight, setSpotlight] = React.useState(focusSection || '')
  const scopeSectionRef = React.useRef(null)
  const scheduleSectionRef = React.useRef(null)
  const workspaces = useWorkspaces(state?.profileKey || '')

  React.useEffect(() => {
    if (!focusSection) return
    setSpotlight(focusSection)
    const targetRef = focusSection === 'schedule' ? scheduleSectionRef : focusSection === 'scope' ? scopeSectionRef : null
    const scrollTimer = window.setTimeout(() => {
      targetRef?.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 90)
    const clearTimer = window.setTimeout(() => setSpotlight(''), 3200)
    return () => {
      window.clearTimeout(scrollTimer)
      window.clearTimeout(clearTimer)
    }
  }, [focusSection])
  const models = useModels()
  const detectedZone = React.useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' } catch { return 'Asia/Shanghai' }
  }, [])
  const defaultSystemRow = resolveDefaultModelRow(models.rows)
  const mainModelValue = config.model || ''
  const tabModelValue = config.tabModel || ''
  const reasoningEffortValue = config.reasoningEffort || ''
  const tabReasoningEffortValue = config.tabReasoningEffort || ''
  const tabAutocompleteOn = config.tabAutocomplete !== false
  const resolvedModel = mainModelValue || defaultSystemRow?.route || ''
  const projects = scope === 'all' ? ['*'] : scope === 'workspace' ? ids.map(id => prefix + id) : scope === 'legacy' ? legacy : []
  const running = config.mode !== 'off'
  const hasRecording = recordings?.sources?.some(source => source.enabled && source.available)
  const hasSource = projects.length > 0 || hasRecording
  const sameScope = granted.length === projects.length && granted.every(id => projects.includes(id))
  const validScope = scope !== 'workspace' || ids.length > 0
  const dirty = !sameScope
  const status = sourceStatus(state, busy, t)
  const rows = [...workspaces.rows, ...ids.filter(id => !workspaces.rows.some(row => row.id === id))
    .map(id => ({ id, title: t('sources.authorizedWorkspace'), missing: true }))]
  const clearableSources = (config.sources ?? [])
    .filter(source => sourceNames[source.id] && source.id !== 'transcript')
    .map(source => ({
      id: source.id,
      label: sourceLabel(source.id, t),
      offline: false,
    }))

  const boardCount = Array.isArray(config.boards) ? config.boards.length : 0
  const autoFlags = deriveAutomationFlags(state)
  const { hasInterviewRecording, hasSavedWorkSource, sessionsOn, boardsOn, autoIntelOn, anyAutoOn } = autoFlags

  const toggleSessions = async nextOn => {
    if (busy) return
    if (!nextOn) {
      await act('configure', {
        config: buildSessionsTogglePatch(state, false),
      }, t('sources.toastSessionsOff'))
      return
    }
    if (!hasSavedWorkSource && !hasSource) {
      setSpotlight('scope')
      scopeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.setTimeout(() => setSpotlight(''), 3200)
      return
    }
    const payload = buildSessionsTogglePatch(state, true, { timezone: detectedZone })
    if (dirty && validScope && projects.length > 0) {
      await act('session-scope', { projects, ...payload }, t('sources.toastSessionsOn'))
    } else {
      await act('configure', { config: payload }, t('sources.toastSessionsOn'))
    }
  }

  const careerLevel = ['campus', 'ic', 'senior'].includes(config.careerLevel) ? config.careerLevel : 'ic'
  const exclusionRules = Array.isArray(config.evidenceExclusions) ? config.evidenceExclusions : []

  const updateCareerLevel = async nextLevel => {
    if (busy || !nextLevel || nextLevel === careerLevel) return
    await act('configure', { config: { careerLevel: nextLevel } }, t('sources.careerLevelToast'))
  }

  const removeExclusionRule = async ruleText => {
    if (busy) return
    await act('evidence-remove-exclusion', { rule: ruleText })
  }

  const toggleBoards = async nextOn => {
    if (busy) return
    await act('configure', {
      config: buildBoardsTogglePatch(state, nextOn),
    }, nextOn ? t('sources.toastBoardsOn') : t('sources.toastBoardsOff'))
  }

  const toggleAutoIntel = async nextOn => {
    if (busy) return
    const runner = typeof act?.background === 'function' ? act.background : act
    await runner('configure', {
      config: buildAutoIntelTogglePatch(state, nextOn),
    }, nextOn ? t('sources.toastAutoIntelOn') : t('sources.toastAutoIntelOff'))
  }

  const saveScope = async event => {
    event.preventDefault()
    if (busy || !validScope) return
    // Saving readable workspace scope MUST NOT silently enable model uploads or start background distillation.
    const payload = buildScopeSavePatch(state, { projects, hasSource })
    await act('session-scope', payload, t('sources.toastScopeUpdated'))
  }

  const updateMainModel = async nextRoute => {
    if (busy || nextRoute === mainModelValue) return
    const nextRow = nextRoute ? models.rows.find(r => r.route === nextRoute) : defaultSystemRow
    const nextEfforts = nextRow?.reasoning?.efforts ?? []
    const keepEffort = !reasoningEffortValue || nextEfforts.some(e => e.id === reasoningEffortValue)
    const keepTabEffort = Boolean(tabModelValue) || !tabReasoningEffortValue || nextEfforts.some(e => e.id === tabReasoningEffortValue)
    // Picking a model only selects the model route; it must never silently turn on background model processing.
    await act(
      'configure',
      {
        config: {
          model: nextRoute,
          ...(keepEffort ? {} : { reasoningEffort: '' }),
          ...(keepTabEffort ? {} : { tabReasoningEffort: '' }),
        },
      },
      nextRoute ? t('sources.toastMainModelOn') : t('sources.toastMainModelReset'),
    )
  }

  const updateReasoningEffort = async nextEffort => {
    if (busy || nextEffort === reasoningEffortValue) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const activeRow = (mainModelValue ? models.rows.find(r => r.route === mainModelValue) : null) ?? defaultSystemRow
    const chosen = activeRow?.reasoning?.efforts?.find(e => e.id === nextEffort)
    await runner(
      'configure',
      { config: { reasoningEffort: nextEffort } },
      nextEffort
        ? t('sources.toastReasoningSet', { name: chosen?.name || nextEffort })
        : t('sources.toastReasoningReset'),
    )
  }

  const updateTabModel = async nextRoute => {
    if (busy || nextRoute === tabModelValue) return
    const effectiveMainRow = (mainModelValue ? models.rows.find(r => r.route === mainModelValue) : null) ?? defaultSystemRow
    const nextRow = nextRoute ? models.rows.find(r => r.route === nextRoute) : effectiveMainRow
    const nextEfforts = nextRow?.reasoning?.efforts ?? []
    const keepTabEffort = !tabReasoningEffortValue || nextEfforts.some(e => e.id === tabReasoningEffortValue)
    await act(
      'configure',
      { config: { tabModel: nextRoute, ...(keepTabEffort ? {} : { tabReasoningEffort: '' }) } },
      nextRoute ? t('sources.toastTabModelOn') : t('sources.toastTabModelReset'),
    )
  }

  const updateTabReasoningEffort = async nextEffort => {
    if (busy || nextEffort === tabReasoningEffortValue) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const effectiveMainRow = (mainModelValue ? models.rows.find(r => r.route === mainModelValue) : null) ?? defaultSystemRow
    const activeTabRow = (tabModelValue ? models.rows.find(r => r.route === tabModelValue) : null) ?? effectiveMainRow
    const chosen = activeTabRow?.reasoning?.efforts?.find(e => e.id === nextEffort)
    await runner(
      'configure',
      { config: { tabReasoningEffort: nextEffort } },
      nextEffort
        ? t('sources.toastTabReasoningSet', { name: chosen?.name || nextEffort })
        : t('sources.toastTabReasoningReset'),
    )
  }

  const toggleTabAutocomplete = async nextOn => {
    if (busy) return
    const runner = typeof act?.background === 'function' ? act.background : act
    await runner(
      'configure',
      { config: { tabAutocomplete: nextOn } },
      nextOn ? t('sources.toastTabAutoOn') : t('sources.toastTabAutoOff'),
    )
  }

  const savedScopeDesc = granted.includes('*')
    ? t('sources.scopeAll')
    : existing.length > 0
      ? t('sources.scopeWorkspaces', { count: existing.length })
      : legacy.length > 0
        ? t('sources.scopeLegacy', { count: legacy.length })
        : hasRecording ? t('sources.scopeRecording') : ''
  const scanningNow = busy === 'run' || Boolean(watch?.running)
  const patrolCadence = formatPatrolCadence(config.intervalMinutes, t)

  const modes = modeKeys.map(([id, key, descKey]) => [id, t(key), descKey ? t(descKey) : ''])

  return <form className="ca-sheet-form" onSubmit={saveScope}>
    <div className="ca-sheet-body">
      <section className="ca-auto-card" aria-label={t('sources.autoCardAria')}>
        <div className="ca-auto-head">
          <div className="ca-auto-head-left">
            <LiveBeacon state={status.dot} />
            <div className="ca-auto-head-text">
              <strong>{anyAutoOn ? t('sources.autoOn') : t('sources.autoOff')}</strong>
              {(watch?.lastError && anyAutoOn) || watch?.lastRun ? (
                <small>
                  {watch?.lastError && anyAutoOn
                    ? watch.lastError
                    : t('sources.lastRunAt', { time: formatDate(watch.lastRun, { timezone: config.timezone }) })}
                </small>
              ) : null}
            </div>
          </div>
        </div>

        <ul className="ca-auto-list" aria-label={t('sources.autoTogglesAria')}>
          <li className={`ca-auto-row${sessionsOn ? ' is-on' : ''}`}>
            <span className="ca-auto-icon" aria-hidden="true">
              <DistillEmblem size={30} active={sessionsOn} scanning={scanningNow && sessionsOn} />
            </span>
            <div className="ca-auto-body">
              <div className="ca-auto-body-head">
                <strong>{t('sources.distillTitle')}</strong>
                <InfoTip text={t('sources.distillNativeHint')} down wide />
              </div>
              <small>{savedScopeDesc ? t('sources.distillDesc', { scope: savedScopeDesc }) : t('sources.distillUnset')}</small>
            </div>
            <Switch
              label={t('sources.distillTitle')}
              checked={sessionsOn}
              disabled={!!busy || (!sessionsOn && !resolvedModel)}
              onChange={toggleSessions}
            />
          </li>

          <li className={`ca-auto-row${boardsOn ? ' is-on' : ''}`}>
            <span className="ca-auto-icon" aria-hidden="true">
              <PatrolEmblem size={30} active={boardsOn} scanning={scanningNow && boardCount > 0} />
            </span>
            <div className="ca-auto-body">
              <strong>{t('sources.patrolTitle')}</strong>
              <small>{boardCount > 0 ? `${t('sources.patrolDesc', { count: boardCount })}${boardsOn ? ` · ${patrolCadence}` : ''}` : t('sources.patrolUnset')}</small>
            </div>
            {boardCount > 0 ? (
              <Switch
                label={t('sources.patrolTitle')}
                checked={boardsOn}
                disabled={!!busy}
                onChange={toggleBoards}
              />
            ) : (
              <span className="ca-auto-empty-tag">{t('sources.unsubscribed')}</span>
            )}
          </li>

          <li className={`ca-auto-row${autoIntelOn ? ' is-on' : ''}`}>
            <span className="ca-auto-icon" aria-hidden="true">
              <IntelEmblem size={30} active={autoIntelOn} />
            </span>
            <div className="ca-auto-body">
              <strong>{t('sources.autoIntelTitle')}</strong>
              <small>
                {autoIntelOn ? t('sources.autoIntelOn') : t('sources.autoIntelOff')}
              </small>
            </div>
            <Switch
              label={t('sources.autoIntelTitle')}
              checked={autoIntelOn}
              disabled={!!busy}
              onChange={toggleAutoIntel}
            />
          </li>
        </ul>

        <div className="ca-level-calibration">
          <div className="ca-level-calibration-head">
            <div className="ca-auto-body-head">
              <strong>{t('sources.careerLevelTitle')}</strong>
              <InfoTip
                wide
                text={`${t('sources.careerLevelDesc')}\n\n${t(careerLevel === 'campus'
                  ? 'sources.careerLevelHintCampus'
                  : (careerLevel === 'senior' ? 'sources.careerLevelHintSenior' : 'sources.careerLevelHintIc'))}`}
              />
            </div>
            {(state.workBricksSummary?.totalBuffered ?? 0) > 0 && (
              <Tag tone="neutral">{t('sources.careerLevelBuffered', { count: state.workBricksSummary.totalBuffered })}</Tag>
            )}
          </div>
          <SegmentedControl
            id={`${uid}-career-level`}
            className="ca-full-seg ca-seg-on-layer ca-level-seg"
            label={t('sources.careerLevelTitle')}
            value={careerLevel}
            onChange={next => void updateCareerLevel(next)}
            options={[
              { value: 'campus', label: t('sources.careerLevelCampus') },
              { value: 'ic', label: t('sources.careerLevelIc') },
              { value: 'senior', label: t('sources.careerLevelSenior') },
            ]}
          />
          {exclusionRules.length > 0 && (
            <div>
              <small className="ca-meta">{t('sources.exclusionsTitle', { count: exclusionRules.length })}</small>
              <div className="ca-exclusion-chips">
                {exclusionRules.map(rule => (
                  <span key={rule} className="ca-exclusion-chip">
                    <span>{rule}</span>
                    <button
                      type="button"
                      disabled={!!busy}
                      aria-label={t('sources.exclusionsRemoveAria', { rule })}
                      onClick={() => void removeExclusionRule(rule)}
                    >×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <div ref={scopeSectionRef}
        className={`ca-spotlight-target${spotlight === 'scope' ? ' is-spotlight' : ''}`}
        onPointerDown={() => { if (spotlight === 'scope') setSpotlight('') }}>
        <fieldset className="ca-sheet-group">
          <legend className="ca-sheet-legend">{t('sources.scopeLegend')}</legend>
          <div className="ca-scope-options">
            {(scope === 'legacy' ? [...modes, ['legacy', t('sources.modeLegacy'), t('sources.legacyCount', { count: legacy.length })]] : modes)
              .map(([id, title, detail]) => <React.Fragment key={id}>
                <label className="ca-scope-option" data-selected={id === scope}>
                  <input type="radio" value={id} name="ca-account-scope" checked={id === scope}
                    onChange={() => setScope(id)} />
                  <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
                </label>
                {id === 'workspace' && <div className="ca-scope-disclosure" data-open={scope === 'workspace'} inert={scope !== 'workspace' ? true : undefined}>
                  <div><div className="ca-workspace-options">
                    {workspaces.loading ? <p role="status">{t('sources.loadingWorkspaces')}</p>
                      : workspaces.error ? <div className="ca-workspace-feedback" role="alert"><p>{workspaces.error}</p><Button variant="outline" size="sm" onClick={workspaces.retry}>{t('common.retry')}</Button></div>
                      : !rows.length && <p>{t('sources.noWorkspaces')}</p>}
                    {rows.map(row => <label className="ca-workspace-option" key={row.id}>
                      <input type="checkbox" checked={ids.includes(row.id)}
                        onChange={event => setIds(current => event.target.checked ? [...current, row.id] : current.filter(value => value !== row.id))} />
                      <span><strong>{row.title || t('sources.unnamedWorkspace')}</strong>{row.path && <small title={row.path}>{row.path}</small>}</span>
                      {!row.missing && <small>{t('sources.sessionCount', { count: row.sessionCount })}</small>}
                    </label>)}
                  </div></div>
                </div>}
              </React.Fragment>)}
          </div>
        </fieldset>
      </div>

      {(recordings?.sources?.length ?? 0) > 0 && (
        <section className="ca-sheet-group">
          <div className="ca-sheet-group-head">
            <h3>{t('sources.recordingSectionTitle')}</h3>
          </div>
          <RecordingSources recordings={recordings} config={config} busy={busy} act={act} timezone={config.timezone} />
        </section>
      )}

      <PersonalSyncSection
        state={state}
        act={act}
        busy={busy}
        sectionRef={scheduleSectionRef}
        spotlight={spotlight === 'schedule'}
        onInteract={() => { if (spotlight === 'schedule') setSpotlight('') }}
      />

      <ModelRoutingSection
        mainModel={mainModelValue}
        tabModel={tabModelValue}
        tabAutocomplete={tabAutocompleteOn}
        reasoningEffort={reasoningEffortValue}
        tabReasoningEffort={tabReasoningEffortValue}
        defaultSystemRow={defaultSystemRow}
        models={models}
        busy={busy}
        onChangeMain={updateMainModel}
        onChangeReasoning={updateReasoningEffort}
        onChangeTab={updateTabModel}
        onChangeTabReasoning={updateTabReasoningEffort}
        onToggleTabAutocomplete={toggleTabAutocomplete}
      />

      <LanguageSection busy={busy} act={act} />

      <AdvancedSettings
        knownSources={clearableSources}
        busy={busy}
        act={act}
      />
    </div>

    {(dirty || error) && <footer className="ca-sheet-footer">
      {error && <p className="ca-form-error" role="alert">{error}</p>}
      {dirty && <div className="ca-sheet-actions">
        <span className="ca-meta">{t('sources.unsavedChanges')}</span>
        <Button type="submit" variant="primary" size="sm" disabled={!!busy || !validScope}>
          {busy === 'session-scope' ? t('common.saving') : t('common.saveChanges')}
        </Button>
      </div>}
    </footer>}
  </form>
}

export function ModelSelectMenu({ value, rows, pending, disabled, defaultOption, ariaLabel, onChange, placement = 'up' }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef(null)

  const closeLangMenu = React.useCallback(() => setOpen(false), [])
  useMenuDismiss(wrapRef, open, closeLangMenu)

  const options = React.useMemo(() => {
    const base = defaultOption ? [defaultOption] : []
    if (value && !rows.some(r => r.route === value)) {
      const [provider = '', name = value] = value.split(':')
      return [...base, { route: value, name, provider }, ...rows]
    }
    return [...base, ...rows]
  }, [value, rows, defaultOption])

  const current = options.find(r => r.route === value) ?? defaultOption ?? null

  return <div className="ca-select-wrap" ref={wrapRef}>
    <button
      type="button"
      className="ca-select-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled || (!current && !options.length)}
      onClick={() => setOpen(v => !v)}
    >
      <span className="ca-select-value">
        {current ? <>
          <strong>{current.name}</strong>
          {current.provider && <small>{current.provider}</small>}
        </> : <span className="ca-meta">{pending ? t('sources.modelLoading') : t('sources.modelEmpty')}</span>}
      </span>
      <svg className="ca-select-caret" width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>

    {open && <div className={`ca-select-pop ca-popover-surface${placement === 'down' ? ' is-down' : ''}`} role="listbox" aria-label={ariaLabel || t('sources.modelMenuAria')}>
      {options.map((row, idx) => {
        const active = row.route === value
        return <React.Fragment key={row.route || '__default__'}>
          {idx === 1 && defaultOption && <div className="ca-select-divider" role="separator" />}
          <button
            type="button"
            role="option"
            aria-selected={active}
            className={`ca-select-option${active ? ' is-active' : ''}`}
            onClick={() => { onChange(row.route); setOpen(false) }}
          >
            <span className="ca-select-option-body">
              <strong>{row.name}</strong>
              {row.provider && <small>{row.provider}</small>}
            </span>
            {active && <svg className="ca-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>}
          </button>
        </React.Fragment>
      })}
    </div>}
  </div>
}

function pickLowestEffort(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return null
  for (const id of ['off', 'none', 'minimal', 'low']) {
    const hit = efforts.find(e => typeof e?.id === 'string' && e.id.toLowerCase() === id)
    if (hit) return hit
  }
  return efforts[0] ?? null
}

export function ReasoningEffortMenu({ value, reasoning, disabled, onChange, placement = 'up', preferLowestDefault = false, ariaLabel }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []

  const closeLangMenu = React.useCallback(() => setOpen(false), [])
  useMenuDismiss(wrapRef, open, closeLangMenu)

  if (efforts.length <= 1) return null

  const activeEffort = value ? efforts.find(e => e.id === value) : null
  const defaultEffortObj = preferLowestDefault
    ? (pickLowestEffort(efforts) ?? (reasoning?.defaultEffort ? efforts.find(e => e.id === reasoning.defaultEffort) : null))
    : (reasoning?.defaultEffort ? efforts.find(e => e.id === reasoning.defaultEffort) : null)
  const displayName = activeEffort ? activeEffort.name : t('sources.reasoningDefault')
  const menuAriaLabel = ariaLabel || t('sources.reasoningAria')

  return <div className="ca-select-wrap ca-effort-wrap" ref={wrapRef}>
    <button
      type="button"
      className="ca-select-trigger ca-effort-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={menuAriaLabel}
      disabled={disabled}
      onClick={() => setOpen(v => !v)}
    >
      <span className="ca-select-value">
        <small>{t('sources.reasoningLabel')}</small>
        <strong>{displayName}</strong>
      </span>
      <svg className="ca-select-caret" width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>

    {open && <div className={`ca-select-pop ca-popover-surface ca-effort-pop${placement === 'down' ? ' is-down' : ''}`} role="listbox" aria-label={menuAriaLabel}>
      <button
        type="button"
        role="option"
        aria-selected={!activeEffort}
        className={`ca-select-option${!activeEffort ? ' is-active' : ''}`}
        onClick={() => { onChange(''); setOpen(false) }}
      >
        <span className="ca-select-option-body">
          <strong>{t('sources.reasoningDefault')}</strong>
          {defaultEffortObj && <small>{defaultEffortObj.name}</small>}
        </span>
        {!activeEffort && <svg className="ca-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>}
      </button>
      <div className="ca-select-divider" role="separator" />
      {efforts.map(effort => {
        const active = activeEffort?.id === effort.id
        return <button
          key={effort.id}
          type="button"
          role="option"
          aria-selected={active}
          className={`ca-select-option${active ? ' is-active' : ''}`}
          onClick={() => { onChange(effort.id); setOpen(false) }}
        >
          <span className="ca-select-option-body">
            <strong>{effort.name}</strong>
          </span>
          {active && <svg className="ca-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>}
        </button>
      })}
    </div>}
  </div>
}

function ModelRoutingSection({ mainModel, tabModel, tabAutocomplete = true, reasoningEffort, tabReasoningEffort, defaultSystemRow, models, busy, onChangeMain, onChangeReasoning, onChangeTab, onChangeTabReasoning, onToggleTabAutocomplete }) {
  const { t } = useI18n()
  const effectiveMainRow = (mainModel ? models.rows.find(r => r.route === mainModel) : null)
    ?? (mainModel ? { name: mainModel.split(':')[1] || mainModel } : defaultSystemRow)
  const effectiveTabRow = (tabModel ? models.rows.find(r => r.route === tabModel) : null)
    ?? (tabModel ? { name: tabModel.split(':')[1] || tabModel } : effectiveMainRow)
  const mainDefaultOpt = React.useMemo(() => ({
    route: '',
    name: t('sources.modelFollowDsh'),
    provider: defaultSystemRow ? t('sources.modelCurrent', { name: defaultSystemRow.name }) : t('sources.modelAuto'),
  }), [defaultSystemRow, t])
  const tabDefaultOpt = React.useMemo(() => ({
    route: '',
    name: mainModel ? t('sources.modelFollowMain') : t('sources.modelFollowDsh'),
    provider: effectiveMainRow ? t('sources.modelCurrent', { name: effectiveMainRow.name }) : t('sources.modelAuto'),
  }), [mainModel, effectiveMainRow, t])

  return <section className="ca-sheet-group">
    <div className="ca-sheet-group-head">
      <h3>{t('sources.modelSectionTitle')}</h3>
    </div>
    <div className="ca-model-config-card">
      <div className="ca-model-row">
        <div className="ca-model-row-head">
          <strong>{t('sources.mainModelTitle')}</strong>
        </div>
        <div className="ca-model-select-pair">
          <ModelSelectMenu
            value={mainModel}
            rows={models.rows}
            pending={models.pending}
            disabled={!!busy}
            defaultOption={mainDefaultOpt}
            ariaLabel={t('sources.mainModelAria')}
            onChange={onChangeMain}
          />
          <ReasoningEffortMenu
            value={reasoningEffort}
            reasoning={effectiveMainRow?.reasoning}
            disabled={!!busy}
            onChange={onChangeReasoning}
          />
        </div>
      </div>

      <div className="ca-model-row is-toggle-row">
        <div className="ca-model-row-head is-toggleable">
          <span className="ca-model-row-title-group">
            <strong>{t('sources.tabModelTitle')}</strong>
            <span className="ca-info-tip" tabIndex={0} role="note" aria-label={t('sources.tabAutocompleteNote')}>
              <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
                <path d="M8 7.3v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
              </svg>
              <span className="ca-info-tip-pop" role="tooltip">
                {t('sources.tabAutocompleteNote')}
              </span>
            </span>
          </span>
          <Switch
            label={t('sources.tabModelTitle')}
            checked={tabAutocomplete}
            disabled={!!busy}
            onChange={onToggleTabAutocomplete}
          />
        </div>
        <div
          className="ca-model-disclosure"
          data-open={tabAutocomplete ? 'true' : 'false'}
          aria-hidden={!tabAutocomplete}
          inert={!tabAutocomplete ? true : undefined}
        >
          <div className="ca-model-disclosure-inner">
            <div className="ca-model-select-pair">
              <ModelSelectMenu
                value={tabModel}
                rows={models.rows}
                pending={models.pending}
                disabled={!!busy || !tabAutocomplete}
                defaultOption={tabDefaultOpt}
                ariaLabel={t('sources.tabModelAria')}
                onChange={onChangeTab}
              />
              <ReasoningEffortMenu
                value={tabReasoningEffort}
                reasoning={effectiveTabRow?.reasoning}
                disabled={!!busy || !tabAutocomplete}
                preferLowestDefault
                ariaLabel={t('sources.tabReasoningAria')}
                onChange={onChangeTabReasoning}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
}

function AdvancedSettings({ knownSources, busy, act }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [pendingClearId, setPendingClearId] = React.useState('')

  return <section className={`ca-adv-card${open ? ' is-open' : ''}`}>
    <button type="button" className="ca-adv-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <div className="ca-adv-toggle-text">
        <strong>{t('sources.privacyTitle')}</strong>
        <InfoTip
          text={t('sources.privacyExternalBoundary')}
          question={false}
          onClick={e => e.stopPropagation()}
        />
      </div>
      <svg className="ca-adv-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4.5 6.2 8 9.8l3.5-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>

    {open && <div className="ca-adv-body">
      <div className="ca-adv-block">
        {knownSources.length > 0 ? <div className="ca-adv-danger-list">
          {knownSources.map(source => {
            const label = source.label || sourceLabel(source.id, t)
            const confirming = pendingClearId === source.id
            return <div key={source.id} className="ca-adv-danger-row">
              <div className="ca-adv-danger-info">
                <strong>{label}{source.offline ? ` · ${t('sources.recordingOffline')}` : ''}</strong>
              </div>
              {confirming ? <div className="ca-inline">
                <Button variant="ghost" size="sm" onClick={() => setPendingClearId('')}>{t('common.cancel')}</Button>
                <Button variant="outline" size="sm" className="ca-danger-text" disabled={!!busy}
                  onClick={async () => {
                    if (await act('forget', { source: source.id, erase: true }, t('sources.toastClearedSource', { label }))) {
                      setPendingClearId('')
                      try { window.dispatchEvent(new CustomEvent('niuma:source-forgotten', { detail: { sourceId: source.id } })) } catch {}
                    }
                  }}>{t('sources.confirmClear')}</Button>
              </div> : <Button variant="ghost" size="sm" className="ca-danger-text" disabled={!!busy}
                onClick={() => setPendingClearId(source.id)}>{t('sources.clearAndDisable')}</Button>}
            </div>
          })}
        </div> : <p className="ca-meta">{t('sources.noAuthorizedSources')}</p>}
      </div>
    </div>}
  </section>
}

export default function Sources({ state, busy, act, toast = '', onClose, error, focusSection = '' }) {
  const { t } = useI18n()
  return <SideSheet title={t('sources.sheetTitle')} onClose={onClose}>
    {() => <>
      <DrawerContent state={state} busy={busy} act={act} error={error} focusSection={focusSection} />
      {toast && <div className="ca-toast" role="status">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.2 8.4 6.6 11.8 13 4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{toast}</span>
      </div>}
    </>}
  </SideSheet>
}
