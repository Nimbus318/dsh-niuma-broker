import React from 'react'
import { DEFAULT_TRIAGE_BATCH_LIMIT, matchesJobFilter, migrateBoardsToHiringScope, planJobSources, reconcileJobSources, resolveDefaultHiringScope, TRIAGE_PROGRESS_CELLS } from '../src/job-view-scope.mjs'
import { buildBoardsTogglePatch, formatBoardScanToast } from '../src/automation-toggles.mjs'
import {
  Button, SegmentedControl, StateDot, Switch, Tag, TextShimmer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cleanTriageDisplayText, MatchScoreBadge, TriageReceiptBanner } from './TriageRubricPanel.jsx'
import { AiThinkingBubble, AiTraceCard, useActiveJobOps, useHasTrackedOperation, useTrackedOperation } from './AiActivity.jsx'
import FollowUps from './FollowUps.jsx'
import Composer, { resolveDefaultModelRow, useModels } from './Composer.jsx'
import LocalTemplatePaper from './LocalTemplatePaper.jsx'
import { LocalRichEditor, requiresMarkdownSource, resolveRichEditorLine } from './LocalRichEditor.jsx'
import ResumeLines from './ResumeLines.jsx'
import Sources, { ModelSelectMenu, ReasoningEffortMenu, sourceStatus } from './Sources.jsx'
import RecordingQueue from './RecordingQueue.jsx'
import BoardSubscribeSheet from './BoardSubscribeSheet.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import JobDetailSheet from './JobDetailSheet.jsx'
import MarketInsights from './MarketInsights.jsx'
import LifecycleStateMachine, { bucketToneOf, PIPELINE_BUCKETS, StageSteps } from './LifecycleMachine.jsx'
import {
  BranchResumeEmblem, BrokerBrandEmblem, DeepSeekMark, DistillEmblem, EmptySearchEmblem, MasterResumeEmblem, PatrolEmblem,
} from './Emblems.jsx'
import { boardForSourceId, contextualBoardChannelLabel, dimensionLabel, hiringScopeLabel, isCnBoard, localizeChangeLabel, readableDate, sourceLabel, stageLabel } from './shared.js'
import { getActiveLocale, getBrandTitle, I18nProvider, setActiveHostLocale, setActiveLocalePreference, setHostLocaleBound, subscribeLocale, useI18n } from './i18n.jsx'
import {
  activateProfileScope,
  captureProfileContext,
  checkProfileMismatch,
  clearProfileLocalPrefix,
  getActiveProfileKey,
  getProfileGeneration,
  isProfileContextCurrent,
  migrateLegacyStorageLocked,
  profileRequestHeaders,
  readProfileLocal,
  readProfileSession,
  removeProfileLocal,
  subscribeProfileMismatch,
  writeProfileLocal,
  writeProfileSession,
} from './profile-storage.js'
import { migrateResumeChatScope, sourceMatchesForgotten, useHasResumeChatStreaming, useHasRunningComposer, usePersistedDraft } from './draft-hooks.jsx'
import { AnimatedNumber, Expandable, LiveBeacon, SideSheet, SlidingTabs, useMenuDismiss, useRiseList } from './Motion.jsx'
import { AgentTailorBanner, FloatingResumeCommandBar, useResumeAgent } from './ResumeAgent.jsx'
import { buildResumePlayback, ResumePlaybackControls, ResumePlaybackCursor, useResumePlayback } from './ResumePlayback.jsx'
import ResumeGraphModal from './ResumeGraphModal.jsx'
import { applyResumeConversation, applyTailoredSelection, resumeBullet } from '../src/resume-apply.mjs'
import {
  applyReviewDecisions, attachStagedReviewProvenance, buildUnifiedPlaybackSteps, computeReviewableLineChanges,
  rebaseReviewDecisions, resolveAcceptedReviewEvidenceIds, suggestEvidencePlacement,
} from '../src/resume-diff.mjs'
import { normalizeResumeStyle } from '../src/resume-style.mjs'
import { isArchivedResume, organizeResumeVersions } from '../src/resume-versions.mjs'
import { connectHostLocale, translate } from '../src/i18n/index.mjs'

const ID = 'niuma'
import { version as CLIENT_VERSION } from '../package.json'
const BASE = 'api/career-agent/'
const TAB_SPECS = [
  ['resume', 'nav.resume', 'file'],
  ['jobs', 'nav.jobs', 'briefcase'],
  ['insights', 'nav.insights', 'trend'],
]
const DIMENSION_IDS = ['growth', 'scope', 'compensation', 'workload', 'values', 'direction']
const paths = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  briefcase: 'M9 6V3h6v3M3 11a23 23 0 0 0 18 0M11 13h2M5 6h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  refresh: 'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5',
  link: 'M13 5h6v6m0-6-9 9M10 5H5v14h14v-5',
  check: 'M5 12l4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  chevron: 'M9 6l6 6-6 6',
  layers: 'm12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  play: 'M7 5l11 7-11 7V5z',
}

function Icon({ name, size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

function BrokerIcon({ size = 16 }) {
  return <Icon name="briefcase" size={size} />
}

async function request(route, payload, signal, { profileKey = '' } = {}) {
  const locale = getActiveLocale()
  const response = await fetch(`${BASE}${route}`, {
    method: payload ? 'POST' : 'GET',
    headers: profileRequestHeaders({
      'x-career-locale': locale,
      ...(payload && { 'Content-Type': 'application/json' }),
    }, profileKey ? { profileKey } : null),
    credentials: 'same-origin',
    cache: 'no-store',
    body: payload ? JSON.stringify(payload) : undefined,
    signal,
  })
  const data = await response.json().catch(() => null)
  checkProfileMismatch(response, data)
  if (!response.ok || !data || data.ok === false) {
    const reason = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.message
    const err = new Error(reason || translate(locale, 'banner.connectFailed', { status: response.status }))
    if (data?.code) err.code = data.code
    err.status = response.status
    throw err
  }
  return data
}

function useWorkspace() {
  const [state, setState] = React.useState(null)
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [activeTriageOps, setActiveTriageOps] = React.useState(0)
  const operation = React.useRef(false)
  const lastErrorRef = React.useRef('')
  const fetchVersion = React.useRef(0)

  const reload = React.useCallback(async (signal) => {
    const version = ++fetchVersion.current
    try {
      const next = await request('state', null, signal)
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
          setState({ ...nextState, profileGeneration: scopeChange.generation })
          return true
        }
        setState(nextState)
      }
      return true
    } catch (e) {
      if (version === fetchVersion.current && e.name !== 'AbortError') setError(e.message)
      return false
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    const unsubscribeMismatch = subscribeProfileMismatch(() => {
      void reload()
    })
    const timer = setInterval(() => {
      if (!document.hidden && !operation.current) void reload(controller.signal)
    }, 20_000)
    return () => {
      unsubscribeMismatch()
      clearInterval(timer)
      controller.abort()
    }
  }, [reload])

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
      const reply = await request('action', { ...args, action }, undefined, { profileKey: ctxSnap.profileKey })
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
  act.background = async (action, args = {}, toast = '') => {
    const locale = getActiveLocale()
    const ctxSnap = captureProfileContext()
    const isTriage = action === 'triage-jobs'
    if (isTriage) setActiveTriageOps(c => c + 1)
    try {
      const reply = await request('action', { ...args, action }, undefined, { profileKey: ctxSnap.profileKey })
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
      const reply = await request('action', { ...args, action }, undefined, { profileKey: ctxSnap.profileKey })
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

const list = (value) => Array.isArray(value) ? value : []

function validatedLink(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function Empty({ children, icon = 'file', action }) {
  return <div className="ca-empty"><span className="ca-empty-icon"><Icon name={icon} size={18} /></span><p>{children}</p>{action}</div>
}

function Section({ title, aside, children }) {
  return <section className="ca-section"><div className="ca-section-head"><h2>{title}</h2>{aside}</div>{children}</section>
}

function Evidence({ item, config, busy, act, onResume }) {
  const { t, locale } = useI18n()
  const [sourceText, setSourceText] = React.useState('')
  const [sourceLoading, setSourceLoading] = React.useState(false)
  const [sourceErr, setSourceErr] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [draft, setDraft] = React.useState(() => ({ title: item.title ?? '', text: item.text ?? '', role: item.role ?? '', impact: item.impact ?? '' }))
  const onChange = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
  const isPending = item.status === 'pending'

  const openEdit = () => {
    setConfirmDelete(false)
    setDraft({ title: item.title ?? '', text: item.text ?? '', role: item.role ?? '', impact: item.impact ?? '' })
    setEditing(true)
  }

  const loadOriginal = async () => {
    if (sourceText || sourceLoading || item.sourceId !== 'dsh-session' || item.revokedAt) return
    setSourceLoading(true)
    setSourceErr('')
    try {
      const result = await request('action', { action: 'evidence-source', id: item.id })
      setSourceText(result?.result?.text ?? '')
    } catch (reason) {
      setSourceErr(reason.message || t('evidence.sourceLoadFailed'))
    } finally {
      setSourceLoading(false)
    }
  }

  const addToResume = async () => {
    const approval = await act('review', { id: item.id, decision: 'approve', shareable: true }, t('evidence.toastAddedToResume'))
    if (approval?.result?.resumeId) onResume?.(approval.result.resumeId)
  }

  const saveEdit = async (applyToResume = false) => {
    const changes = {
      title: draft.title.trim(),
      text: draft.text.trim(),
      role: draft.role.trim(),
      impact: draft.impact.trim(),
      ...(applyToResume ? { shareable: true } : {}),
    }
    if (!changes.title || !changes.text) return
    const reply = await act(
      'evidence-update',
      { id: item.id, changes, applyToResume },
      applyToResume ? t('evidence.toastSavedApplied') : t('evidence.toastUpdated'),
    )
    if (reply) {
      setEditing(false)
      if (reply.result?.resumeId) onResume?.(reply.result.resumeId)
    }
  }

  return <article className={`ca-ev-card${isPending ? ' is-pending' : ''}`}>
    <div className="ca-ev-body">
      <div className="ca-row-title">
        <h3>{item.title || t('evidence.defaultTitle')}</h3>
        {isPending
          ? <Tag tone="warning">{t('stage.pending')}</Tag>
          : <Tag tone={item.shareable ? 'success' : 'neutral'}>{item.shareable ? t('evidence.shareable') : t('evidence.privateOnly')}</Tag>}
      </div>
      {!editing && <>
        <p className="ca-evidence-text">{item.text}</p>
        {(item.role || item.impact) && (
          <div className="ca-ev-kv">
            {item.role && <span><strong>{t('evidence.role')}</strong> {item.role}</span>}
            {item.impact && <span><strong>{t('evidence.impact')}</strong> {item.impact}</span>}
          </div>
        )}
        <div className="ca-meta">
          {item.sourceName ?? sourceLabel(item.sourceId, t)}
          {item.createdAt && ` · ${readableDate(item.createdAt, config.timezone, locale)}`}
        </div>
        {(item.sourceRef || item.eventId || (item.sourceId === 'dsh-session' && !item.revokedAt)) && (
          <details className="ca-details" onToggle={event => { if (event.currentTarget.open) void loadOriginal() }}>
            <summary>{t('evidence.viewSource')}</summary>
            {(item.sourceRef || item.eventId) && <p className="ca-meta">{t('evidence.sourceRef', { ref: item.sourceRef || item.eventId })}</p>}
            {sourceLoading && <p className="ca-meta">{t('evidence.loadingSource')}</p>}
            {sourceErr && <p className="ca-form-error">{sourceErr}</p>}
            {sourceText && <blockquote className="ca-quote">{sourceText}</blockquote>}
          </details>
        )}
      </>}
      {editing && <form className="ca-form ca-formbox" onSubmit={event => { event.preventDefault(); void saveEdit(false) }}>
        <label>{t('evidence.titleLabel')}<input required maxLength={180} value={draft.title} onChange={onChange('title')} /></label>
        <label>{t('evidence.textLabel')}<textarea required rows="3" value={draft.text} onChange={onChange('text')} /></label>
        <div className="ca-fields">
          <label>{t('evidence.myRoleLabel')}<input value={draft.role} onChange={onChange('role')} placeholder={t('common.optional')} /></label>
          <label>{t('evidence.impactLabel')}<input value={draft.impact} onChange={onChange('impact')} placeholder={t('evidence.impactPlaceholder')} /></label>
        </div>
        <div className="ca-form-actions">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
          {(isPending || !item.shareable) && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void saveEdit(true)}>{t('evidence.saveAndApply')}</Button>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('common.saveChanges')}</Button>
        </div>
      </form>}
    </div>

    {!editing && ['pending', 'approved'].includes(item.status) && <div className="ca-ev-actions">
      {confirmDelete ? <>
        <span className="ca-meta">{t('evidence.confirmDeletePrompt')}</span>
        <div className="ca-inline">
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button variant="outline" size="sm" className="ca-danger-text" disabled={!!busy}
            onClick={() => act('evidence-delete', { id: item.id }, t('evidence.toastDeleted'))}>{t('common.confirmDelete')}</Button>
        </div>
      </> : <>
        <div className="ca-inline">
          <Button variant="outline" size="sm" disabled={!!busy} onClick={openEdit}>{t('common.edit')}</Button>
          {isPending ? <>
            <Button variant="primary" size="sm" disabled={!!busy} onClick={addToResume}>{t('evidence.addToResume')}</Button>
            <Button variant="ghost" size="sm" disabled={!!busy}
              onClick={() => act('review', { id: item.id, decision: 'approve', shareable: false }, t('evidence.toastPrivate'))}>{t('evidence.keepPrivate')}</Button>
          </> : <>
            {item.shareable && (
              <Button variant="outline" size="sm" disabled={!!busy} onClick={async () => {
                const reply = await act('evidence-update', { id: item.id, changes: { shareable: true }, applyToResume: true }, t('evidence.toastWrittenDraft'))
                if (reply?.result?.resumeId) onResume?.(reply.result.resumeId)
              }}>{t('evidence.addToResume')}</Button>
            )}
            <Button variant="ghost" size="sm" disabled={!!busy}
              onClick={() => act('evidence-update', { id: item.id, changes: { shareable: !item.shareable } }, item.shareable ? t('evidence.toastSetPrivate') : t('evidence.toastSetShareable'))}>
              {item.shareable ? t('evidence.setPrivate') : t('evidence.setShareable')}
            </Button>
          </>}
        </div>
        <Button variant="ghost" size="sm" className="ca-danger-text" disabled={!!busy}
          onClick={() => setConfirmDelete(true)}>{t('common.delete')}</Button>
      </>}
    </div>}
  </article>
}

function RecordEvidence({ config, busy, act, onDone }) {
  const { t } = useI18n()
  const [project] = React.useState(() => list(config.sources).find(source => source.id === 'manual' && !source.revokedAt)?.projects?.find(id => id !== '*') ?? 'personal')
  const [title, setTitle] = React.useState('')
  const [text, setText] = React.useState('')
  const [role, setRole] = React.useState('')
  const [impact, setImpact] = React.useState('')
  const submit = async (event) => {
    event.preventDefault()
    const payload = {
      id: crypto.randomUUID(), sourceId: 'manual', projectId: project.trim() || 'personal',
      kind: 'manual', occurredAt: new Date().toISOString(),
      evidence: [{ title: title.trim(), text: text.trim(), role: role.trim() || undefined, impact: impact.trim() || undefined }],
    }
    if (await act('ingest', { event: payload }, t('evidence.toastRecorded'))) onDone()
  }
  return <form className="ca-form ca-formbox" onSubmit={submit}>
    <label>{t('evidence.titleLabel')}<input required value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder={t('evidence.formTitlePlaceholder')} /></label>
    <label>{t('evidence.formFactsLabel')}<textarea required rows="3" value={text} onChange={event => setText(event.target.value)} /></label>
    <div className="ca-fields">
      <label>{t('evidence.myRoleLabel')}<input value={role} onChange={event => setRole(event.target.value)} /></label>
      <label>{t('evidence.formMetricsLabel')}<input value={impact} onChange={event => setImpact(event.target.value)} /></label>
    </div>
    <div className="ca-form-actions">
      <Button variant="ghost" size="sm" onClick={onDone}>{t('common.cancel')}</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('evidence.saveWin')}</Button>
    </div>
  </form>
}

const PARSE_METHOD_KEYS = {
  pdfkit: 'resume.methodPdfkit',
  unpdf: 'resume.methodPdfkit',
  'pdf-ocr': 'resume.methodPdfOcr',
  'pdf-mixed': 'resume.methodPdfMixed',
  pdftotext: 'resume.methodPdftotext',
  'office-kit': 'resume.methodTextutil',
  docx: 'resume.methodTextutil',
  odt: 'resume.methodTextutil',
  textutil: 'resume.methodTextutil',
  'vision-ocr': 'resume.methodVisionOcr',
  html: 'resume.methodText',
  text: 'resume.methodText',
}

function ResumeForm({ act, busy, onDone }) {
  const { t, locale } = useI18n()
  const [title, setTitle] = React.useState(() => t('common.baseResume'))
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState('')
  const [parsing, setParsing] = React.useState(false)
  const [parseStartedAt, setParseStartedAt] = React.useState(0)
  const [parseFileName, setParseFileName] = React.useState('')
  const [parseInfo, setParseInfo] = React.useState('')
  const [dragging, setDragging] = React.useState(false)
  const filePicker = React.useRef(null)

  const handleSelectedFile = async file => {
    if (!file || parsing) return
    const reqCtx = captureProfileContext()
    setError('')
    setParseInfo('')
    if (file.size === 0) {
      setError(t('resume.fileEmptyError'))
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setError(t('resume.fileTooLargeError'))
      return
    }
    const lower = (file.name || '').toLowerCase()
    const isPlainMd = /\.(md|markdown)$/i.test(lower)
    if (isPlainMd && file.size <= 400_000) {
      try {
        const body = await file.text()
        if (!isProfileContextCurrent(reqCtx)) return
        if (body.trim() && !body.includes('\0') && body.length <= 100_000) {
          setText(body.trim())
          const stem = file.name.replace(/\.[^.]+$/, '').trim()
          if (stem) setTitle(stem.slice(0, 120))
          setParseInfo(t('resume.fileReadMdInfo', { name: file.name }))
          return
        }
      } catch {}
    }

    setParsing(true)
    setParseStartedAt(Date.now())
    setParseFileName(file.name)
    try {
      const response = await fetch('api/career-agent/parse-resume-file', {
        method: 'POST',
        credentials: 'same-origin',
        headers: profileRequestHeaders({
          'content-type': 'application/octet-stream',
          'x-career-locale': locale,
          'x-resume-filename': encodeURIComponent(file.name || 'resume'),
          'x-resume-mime': file.type || '',
          'x-resume-use-ai': '1',
          'x-resume-explicit-ai': '1',
        }, reqCtx),
        body: file,
      })
      const payload = await response.json().catch(() => null)
      checkProfileMismatch(response, payload)
      if (!isProfileContextCurrent(reqCtx)) return
      if (!response.ok || !payload?.ok || !payload.result?.text) {
        throw new Error(payload?.error || t('resume.fileParseError'))
      }
      const res = payload.result
      setText(res.text)
      if (res.title) setTitle(res.title)
      const methodLabel = PARSE_METHOD_KEYS[res.method] ? t(PARSE_METHOD_KEYS[res.method]) : t('resume.methodDefault')
      const totalPages = Number(res.pages) || 0
      const extractedPages = Number.isFinite(Number(res.extractedPages)) ? Number(res.extractedPages) : totalPages
      const pagesSummary = totalPages > 0
        ? (res.method === 'pdf-mixed' && Number(res.ocrPages) > 0
          ? t('resume.fileParsedPagesMixed', {
              extracted: extractedPages,
              pages: totalPages,
              text: Number(res.textPages) || 0,
              ocr: Number(res.ocrPages) || 0,
            })
          : extractedPages < totalPages
            ? t('resume.fileParsedPagesCoverage', { extracted: extractedPages, pages: totalPages })
            : t('resume.fileParsedPages', { pages: totalPages }))
        : ''
      setParseInfo(res.warning
        ? (pagesSummary ? `${methodLabel}${pagesSummary} · ${res.warning}` : res.warning)
        : t('resume.fileParsedInfo', {
            method: methodLabel,
            ai: res.structuredByAi ? t('resume.fileParsedAi') : '',
            name: file.name,
            pages: pagesSummary,
          }))
    } catch (err) {
      if (isProfileContextCurrent(reqCtx) && !checkProfileMismatch(null, err)) {
        setError(err?.message || t('resume.fileParseFail'))
      }
    } finally {
      if (isProfileContextCurrent(reqCtx)) {
        setParsing(false)
        setParseFileName('')
      }
    }
  }

  return <form className="ca-form ca-import-form" onSubmit={async (event) => {
    event.preventDefault()
    if (parsing || !text.trim()) return
    const reply = await act('resume-import', { title: title.trim() || t('common.baseResume'), text: text.trim() }, t('resume.toastImported'))
    if (reply?.result?.id) {
      await act('resume-review', { id: reply.result.id, decision: 'approve' }, t('resume.toastImportedReady'))
      onDone(reply.result.id)
    }
  }}>
    <div
      className={`ca-file-dropzone${dragging ? ' is-dragging' : ''}${parsing ? ' is-busy' : ''}`}
      onDragOver={e => { e.preventDefault(); if (!parsing) setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer?.files?.[0]
        if (f) void handleSelectedFile(f)
      }}
      onClick={() => { if (!parsing) filePicker.current?.click() }}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !parsing) { e.preventDefault(); filePicker.current?.click() } }}
    >
      <div className="ca-file-dropzone-icon" aria-hidden="true">
        <Icon name="file" size={20} />
      </div>
      <div className="ca-file-dropzone-copy">
        <strong>{t('resume.dropTitle')}</strong>
      </div>
      <div className="ca-file-format-tags" aria-hidden="true">
        <span>PDF</span>
        <span>Word</span>
        <span>{t('resume.imageOcr')}</span>
        <span>Markdown / TXT</span>
      </div>
    </div>

    <input
      ref={filePicker}
      type="file"
      accept=".pdf,.docx,.doc,.rtf,.odt,.html,.htm,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.heic,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,text/*"
      hidden
      onChange={e => {
        const file = e.currentTarget.files?.[0]
        e.currentTarget.value = ''
        if (file) void handleSelectedFile(file)
      }}
    />

    {parsing && (
      <AiThinkingBubble
        title={t('resume.parsingBubble', { name: parseFileName })}
        steps={[
          { key: 'read', label: t('resume.stepExtract') },
          { key: 'structure', label: t('resume.stepStructure') },
        ]}
        startedAt={parseStartedAt}
        showSkeleton={false}
      />
    )}

    {parseInfo && !parsing && (
      <div className="ca-file-parse-ok" role="status">
        <Icon name="check" size={13} />
        <span>{parseInfo}</span>
      </div>
    )}

    {error && <p className="ca-form-error" role="alert">{error}</p>}

    <label>
      <span>{t('resume.titleLabel')}</span>
      <input maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('common.baseResume')} />
    </label>

    <label>
      <span>{t('resume.bodyLabel')}</span>
      <textarea spellCheck="false" required rows="10" maxLength={100000} disabled={parsing}
        placeholder={t('resume.bodyPlaceholder')}
        value={text} onChange={event => setText(event.target.value)} />
    </label>

    <div className="ca-form-actions">
      <Button type="submit" variant="primary" size="sm" disabled={!!busy || parsing || !text.trim()}>
        {parsing ? t('resume.parsing') : t('resume.importAndEdit')}
      </Button>
    </div>
  </form>
}

function ReflectionForm({ act, busy, onDone }) {
  const { t } = useI18n()
  const [dimension, setDimension] = React.useState('growth')
  const [severity, setSeverity] = React.useState('concern')
  const [text, setText] = React.useState('')
  return <form className="ca-form ca-formbox" onSubmit={async (event) => {
    event.preventDefault()
    const reflection = { id: crypto.randomUUID(), occurredAt: new Date().toISOString(), dimension, severity, text: text.trim() }
    if (await act('reflection', { reflection }, t('evidence.toastReflectionSaved'))) onDone()
  }}>
    <div className="ca-fields">
      <label>{t('evidence.reflectionDimension')}<select value={dimension} onChange={event => setDimension(event.target.value)}>{DIMENSION_IDS.map(id => <option key={id} value={id}>{dimensionLabel(id, t)}</option>)}</select></label>
      <label>{t('evidence.reflectionSentiment')}<select value={severity} onChange={event => setSeverity(event.target.value)}><option value="concern">{t('evidence.sentimentConcern')}</option><option value="neutral">{t('evidence.sentimentNeutral')}</option><option value="positive">{t('evidence.sentimentPositive')}</option></select></label>
    </div>
    <label>{t('evidence.reflectionFacts')}<textarea rows="3" required value={text} onChange={event => setText(event.target.value)} /></label>
    <div className="ca-form-actions">
      <Button variant="ghost" size="sm" onClick={onDone}>{t('common.cancel')}</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('evidence.saveReflection')}</Button>
    </div>
  </form>
}

function download(text, name, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

function displayResume(resume, all) {
  if (!resume) return ''
  if (resume.kind === 'import' || resume.kind === 'revised') return resume.text ?? ''
  if (resume.kind === 'tailored') return resume.previewText ?? resume.text ?? ''
  if (resume.text) return resume.text
  const baseRecord = all.find(record => record.id === resume.baseId)
  const base = baseRecord ? displayResume(baseRecord, all) : ''
  const bullets = list(resume.items).map(item => `- ${typeof item === 'string' ? item : item.text}`).join('\n')
  return `${base ? `${base}\n\n##` : '#'} ${resume.title}\n\n${bullets}`
}

function stripBulletPrefix(line = '') {
  return resumeBullet.exec(line)?.[2] ?? line.trim()
}

function stripMarkdownInline(text = '') {
  return String(text || '')
    .replace(/\*\*([^*\r\n]+)\*\*/gu, '$1')
    .replace(/(?<![\p{L}\p{N}])__([^_\r\n]+)__(?![\p{L}\p{N}])/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
}

const miniContactLine = /^(?:电子邮箱|邮箱|电话|手机|地址|位置|微信|网站|主页|Email|Phone|Location|GitHub|LinkedIn)\s*[：:]/iu

function parseMiniResumeBlocks(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/u)
  const blocks = []
  let contacts = []
  const flushContacts = () => {
    if (!contacts.length) return
    blocks.push({ kind: 'sub', text: contacts.map(c => c.text).join(' · '), raw: contacts.map(c => c.raw).join('\n'), rawLines: contacts.map(c => c.raw) })
    contacts = []
  }
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) { flushContacts(); continue }
    if (miniContactLine.test(trimmed) && blocks.length <= 3) {
      contacts.push({ text: trimmed.replace(/^[^：:]+[：:]\s*/u, ''), raw: trimmed })
      continue
    }
    flushContacts()
    if (trimmed.startsWith('# ')) blocks.push({ kind: 'h1', text: stripMarkdownInline(trimmed.slice(2).trim()), raw: trimmed })
    else if (trimmed.startsWith('## ')) blocks.push({ kind: 'h2', text: stripMarkdownInline(trimmed.slice(3).trim()), raw: trimmed })
    else if (trimmed.startsWith('### ')) blocks.push({ kind: 'h3', text: stripMarkdownInline(trimmed.slice(4).trim()), raw: trimmed })
    else if (/^_(.+)_$/.test(trimmed)) blocks.push({ kind: 'sub', text: stripMarkdownInline(trimmed.slice(1, -1).trim()), raw: trimmed })
    else if (/^[-*+•▪]\s+/.test(trimmed)) blocks.push({ kind: 'li', text: stripMarkdownInline(trimmed.replace(/^[-*+•▪]\s+/, '').trim()), raw: trimmed })
    else blocks.push({ kind: 'p', text: stripMarkdownInline(trimmed), raw: trimmed })
    if (blocks.length >= 28) break
  }
  flushContacts()
  return blocks
}

function VersionPreviewCard({ row, currentItem, resumes, timezone, originLabel, accent, font }) {
  const { t, locale } = useI18n()
  const previewText = React.useMemo(() => displayResume(row, resumes), [row, resumes])
  const currentText = React.useMemo(() => displayResume(currentItem, resumes), [currentItem, resumes])
  const currentSet = React.useMemo(
    () => new Set(currentText.split(/\r?\n/u).map(s => s.trim()).filter(Boolean)),
    [currentText],
  )
  const previewLines = React.useMemo(
    () => previewText.split(/\r?\n/u).map(s => s.trim()).filter(Boolean),
    [previewText],
  )
  const blocks = React.useMemo(() => parseMiniResumeBlocks(previewText), [previewText])
  const isCurrent = row.id === currentItem.id
  const addedLines = isCurrent ? 0 : previewLines.filter(line => !currentSet.has(line)).length
  const removedLines = isCurrent ? 0 : [...currentSet].filter(line => !previewLines.includes(line)).length
  const charCount = previewText.replace(/\s+/gu, '').length

  return <aside
    className="ca-ver-preview ca-popover-surface"
    aria-label={t('version.previewAria', { title: row.title })}>
    <div key={row.id} className="ca-ver-preview-inner">
      <div className="ca-ver-preview-head">
        <div className="ca-ver-preview-title">
          <strong>{row.title}</strong>
          <Tag tone={row.status === 'approved' ? 'success' : 'warning'}>{stageLabel(row.status, t)}</Tag>
        </div>
        <div className="ca-ver-preview-meta">
          <span>{originLabel}{row.createdAt ? ` · ${readableDate(row.createdAt, timezone, locale)}` : ''}</span>
          <span>{t('common.charCount', { count: charCount })}</span>
        </div>
        {!isCurrent && (addedLines > 0 || removedLines > 0) && (
          <div className="ca-ver-preview-diff">
            <span>{t('version.diffRelative')}</span>
            {addedLines > 0 && <strong className="is-add">{t('version.diffAdded', { count: addedLines })}</strong>}
            {removedLines > 0 && <span className="is-rem">{t('version.diffRemoved', { count: removedLines })}</span>}
          </div>
        )}
      </div>

      <div className="ca-ver-paper-frame">
        <div className={`ca-ver-paper${font === 'serif' ? ' is-serif' : ''}`} style={{ '--mini-accent': accent || '#18181b' }}>
          {blocks.length ? blocks.map((b, idx) => {
            const changed = !isCurrent && (b.rawLines ? b.rawLines.some(line => !currentSet.has(line)) : !currentSet.has(b.raw))
            return <div key={idx} className={`ca-ver-line is-${b.kind}${changed ? ' is-diff' : ''}`}>
              {b.kind === 'li' && <i aria-hidden="true" />}
              <span>{b.text}</span>
            </div>
          }) : <p className="ca-meta">{t('version.emptyVersion')}</p>}
        </div>
      </div>
    </div>
  </aside>
}

const VERSION_HOVER_PREVIEW_CACHE = new Map()
const VER_A4_W = 794
const VER_A4_H = 1123
const VER_PREVIEW_W = 236
const VER_PREVIEW_H = 334
const VER_PREVIEW_SCALE = VER_PREVIEW_W / VER_A4_W
const VER_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function escapeHoverHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function buildVersionHoverDoc({ html, css, lang }, title) {
  const miniCss = `html,body{margin:0;padding:0;background:#fff;overflow:hidden}.rr{margin:0;width:${VER_A4_W}px}.rr-page{width:${VER_A4_W}px;max-width:${VER_A4_W}px;box-shadow:none!important}.rr a{pointer-events:none}`
  return `<!doctype html><html lang="${escapeHoverHtml(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHoverHtml(VER_PREVIEW_CSP)}"><title>${escapeHoverHtml(title)}</title><style>${String(css || '').replaceAll('</', '<\\/')}${miniCss}</style></head><body><div class="rr">${html || ''}</div></body></html>`
}

function readHoverResumeAppearance(resume, fallbackAccent, fallbackFont) {
  let fallbackTemplate = 'onyx'
  let fallbackStyle
  try {
    fallbackTemplate = readProfileLocal('local.template') || 'onyx'
    const rawStyle = readProfileLocal('local.style')
    const parsed = rawStyle ? JSON.parse(rawStyle) : undefined
    fallbackStyle = parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {}
  const app = resume?.appearance && typeof resume.appearance === 'object' ? resume.appearance : null
  const mergedStyle = app?.style && typeof app.style === 'object'
    ? app.style
    : (fallbackStyle || ((fallbackAccent || fallbackFont) ? { ...(fallbackAccent ? { accent: fallbackAccent } : {}), ...(fallbackFont ? { font: fallbackFont } : {}) } : undefined))
  return {
    template: app?.template || fallbackTemplate,
    style: mergedStyle,
  }
}

function VersionRealPreviewCard({ row, timezone, accent, font }) {
  const { t, locale } = useI18n()
  const activePk = getActiveProfileKey()
  const { template, style } = React.useMemo(
    () => readHoverResumeAppearance(row, accent, font),
    [row?.id, row?.appearance?.template, JSON.stringify(row?.appearance?.style || null), accent, font],
  )
  const cacheKey = React.useMemo(() => {
    if (!row?.id) return ''
    const stamp = row.createdAt || row.sortTime || ''
    const len = typeof row.text === 'string' ? row.text.length : 0
    return `${activePk}:${row.id}:${stamp}:${len}:${template}:${JSON.stringify(style || {})}`
  }, [activePk, row?.id, row?.createdAt, row?.sortTime, row?.text, template, style])

  const [doc, setDoc] = React.useState(() => (cacheKey ? VERSION_HOVER_PREVIEW_CACHE.get(cacheKey) || '' : ''))
  const [loading, setLoading] = React.useState(() => Boolean(cacheKey && !VERSION_HOVER_PREVIEW_CACHE.has(cacheKey)))
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!row?.id || !cacheKey) {
      setDoc('')
      setLoading(false)
      setFailed(false)
      return
    }
    const cached = VERSION_HOVER_PREVIEW_CACHE.get(cacheKey)
    if (cached) {
      setDoc(cached)
      setLoading(false)
      setFailed(false)
      return
    }
    const reqCtx = captureProfileContext()
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    const timer = window.setTimeout(async () => {
      try {
        const payload = { id: row.id, title: row.trackTitle || row.title, template, style }
        if (typeof row.text === 'string' && row.text.trim()) payload.text = row.text
        const res = await fetch('api/career-agent/local-preview', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => null)
        checkProfileMismatch(res, data)
        if (!res.ok || !data?.ok || !data.result) throw new Error('preview failed')
        if (controller.signal.aborted || !isProfileContextCurrent(reqCtx)) return
        const htmlDoc = buildVersionHoverDoc(data.result, row.trackTitle || row.title)
        VERSION_HOVER_PREVIEW_CACHE.set(cacheKey, htmlDoc)
        setDoc(htmlDoc)
        setLoading(false)
      } catch {
        if (!controller.signal.aborted && isProfileContextCurrent(reqCtx)) {
          setFailed(true)
          setLoading(false)
        }
      }
    }, 110)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cacheKey, row?.id, row?.trackTitle, row?.title, row?.text, template, style])

  if (!row) return null
  const displayTitle = row.trackTitle || row.title || t('common.baseResume')
  const metaLine = [
    row.changeLabel ? localizeChangeLabel(row.changeLabel, t) : '',
    row.sortTime ? readableDate(row.sortTime, timezone, locale) : '',
  ].filter(Boolean).join(' · ')

  return (
    <aside className="ca-ver-real-preview ca-popover-surface" aria-label={t('version.previewAria', { title: displayTitle })}>
      <div className="ca-ver-real-preview-head">
        <span className="ca-ver-real-preview-title" title={displayTitle}>{displayTitle}</span>
        {row.versionTag && <span className="ca-ver-chip">{row.versionTag}</span>}
        <span className={`ca-doc-status ${row.status === 'approved' ? 'is-approved' : 'is-draft'}`}>
          {row.status === 'approved' ? t('version.statusApprovedShort') : t('version.statusDraft')}
        </span>
      </div>
      <div className="ca-ver-real-preview-stage" style={{ width: `${VER_PREVIEW_W}px`, height: `${VER_PREVIEW_H}px` }}>
        {doc ? (
          <iframe
            className="ca-ver-real-preview-iframe"
            title={t('version.previewAria', { title: displayTitle })}
            sandbox="allow-same-origin"
            srcDoc={doc}
            tabIndex={-1}
            style={{ width: `${VER_A4_W}px`, height: `${VER_A4_H}px`, transform: `scale(${VER_PREVIEW_SCALE})` }}
          />
        ) : (
          <div className="ca-ver-real-preview-placeholder">
            {loading ? (
              <div className="ca-mini-paper-skeleton" aria-label={t('graph.previewRendering')}>
                <span className="is-head" />
                <span className="is-sub" />
                <span className="is-line" />
                <span className="is-line is-short" />
                <span className="is-gap" />
                <span className="is-line" />
                <span className="is-line" />
                <span className="is-line is-short" />
              </div>
            ) : (
              <span className="ca-meta">{failed ? t('graph.previewEmpty') : ''}</span>
            )}
          </div>
        )}
      </div>
      {metaLine && <div className="ca-ver-real-preview-foot">{metaLine}</div>}
    </aside>
  )
}

function VersionMenu({
  item, resumes, defaultMasterTrackId = '', opportunities = [], timezone, disabled,
  onVersion, onDismiss, onRename, onSetDefault, onBranchMaster, onRebase, onOpenGraph, onArchive, accent, font,
}) {
  const { t, locale } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [hoveredId, setHoveredId] = React.useState(null)
  const [expandedTracks, setExpandedTracks] = React.useState({})
  const [renamingTrackId, setRenamingTrackId] = React.useState('')
  const [renameDraft, setRenameDraft] = React.useState('')
  const wrapRef = React.useRef(null)

  const tree = React.useMemo(
    () => organizeResumeVersions(resumes, { defaultMasterTrackId, opportunities }),
    [resumes, defaultMasterTrackId, opportunities],
  )
  const archivedCount = React.useMemo(
    () => (Array.isArray(resumes) ? resumes.filter(isArchivedResume).length : 0),
    [resumes],
  )
  const allIndexed = React.useMemo(() => {
    const map = new Map()
    for (const m of tree.masters) {
      for (const rev of m.revisions) map.set(rev.id, rev)
    }
    for (const b of tree.branches) {
      for (const rev of b.revisions) map.set(rev.id, rev)
    }
    return map
  }, [tree])

  React.useEffect(() => {
    if (!open) {
      setHoveredId(null)
      setRenamingTrackId('')
    }
  }, [open])

  const closeVersionMenu = React.useCallback(() => setOpen(false), [])
  const handleVersionEscape = React.useCallback(() => {
    if (renamingTrackId) setRenamingTrackId('')
    else setOpen(false)
  }, [renamingTrackId])
  useMenuDismiss(wrapRef, open, closeVersionMenu, { onEscape: handleVersionEscape })

  const activeIndexed = allIndexed.get(item.id) || null
  const activeVersionTag = activeIndexed?.versionTag || ''
  const triggerTitle = activeIndexed?.trackTitle || item.title
  const activeMasterTrack = React.useMemo(
    () => tree.masters.find(m => m.revisions.some(r => r.id === item.id)) || null,
    [tree.masters, item.id],
  )
  const activeIsBranch = !activeMasterTrack && tree.branches.some(b => b.revisions.some(r => r.id === item.id))
  const previewRow = hoveredId ? allIndexed.get(hoveredId) ?? null : null

  const toggleHistory = (key, currentlyOpen) => setExpandedTracks(cur => ({ ...cur, [key]: !currentlyOpen }))

  const submitRename = async (event, targetResumeId) => {
    event.preventDefault()
    const clean = renameDraft.trim()
    if (!clean || !onRename) { setRenamingTrackId(''); return }
    await onRename(targetResumeId, clean)
    setRenamingTrackId('')
  }

  const renderHistoryList = revisions => {
    const ordered = revisions.slice().reverse()
    return (
      <div className="ca-ver-history-list">
        {ordered.map((rev, idx) => {
          const revActive = rev.id === item.id
          const isApproved = rev.status === 'approved'
          return (
            <div key={rev.id}
              className={`ca-ver-rev-row${revActive ? ' is-active' : ''}${isApproved ? ' is-approved' : ''}${rev.id === hoveredId ? ' is-hovering' : ''}${idx === 0 ? ' is-first' : ''}${idx === ordered.length - 1 ? ' is-last' : ''}`}
              onMouseEnter={() => setHoveredId(rev.id)}>
              <span className="ca-ver-tl-gutter" aria-hidden="true">
                <span className="ca-ver-tl-rail" />
                <span className="ca-ver-tl-node" />
              </span>
              <button type="button" role="option" aria-selected={revActive}
                className="ca-ver-rev-btn"
                onFocus={() => setHoveredId(rev.id)}
                onClick={() => { setOpen(false); onVersion(rev.id) }}>
                <span className="ca-ver-chip is-muted">{rev.versionTag}</span>
                <span className="ca-ver-rev-label">{localizeChangeLabel(rev.changeLabel, t)}</span>
                <span className="ca-ver-rev-time">{readableDate(rev.sortTime, timezone, locale)}</span>
                {revActive ? (
                  <span className="ca-ver-rev-badge is-current">{t('version.current')}</span>
                ) : isApproved ? (
                  <span className="ca-ver-rev-badge is-approved">{t('version.statusApprovedShort')}</span>
                ) : null}
              </button>
              {rev.status === 'pending' && !revActive && onDismiss && (
                <button type="button" className="ca-menu-dismiss" title={t('version.dismissDraftTitle')} aria-label={t('version.dismissDraftAria', { tag: rev.versionTag })}
                  onClick={e => { e.stopPropagation(); onDismiss(rev.id) }}>×</button>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const renderEmblemStatusPip = status => (
    <span className={`ca-ver-emblem-pip ${status === 'approved' ? 'is-approved' : 'is-draft'}`} aria-hidden="true">
      {status === 'approved' && (
        <svg viewBox="0 0 12 12" width="7" height="7" fill="none">
          <path d="M2.5 6.3 4.9 8.7 9.5 3.6" stroke="#ffffff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )

  return <div className="ca-menu-wrap" ref={wrapRef}>
    <button type="button" className={`ca-doc-trigger${open ? ' is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
      disabled={disabled} onClick={() => setOpen(v => !v)}>
      <span className="ca-doc-emblem" aria-hidden="true">
        {activeIsBranch
          ? <BranchResumeEmblem size={22} />
          : <MasterResumeEmblem size={22} isDefault={Boolean(activeMasterTrack?.isDefault)} />}
      </span>
      <span className="ca-doc-title">{triggerTitle}</span>
      {activeVersionTag && <span className="ca-doc-ver">{activeVersionTag}</span>}
      <span className={`ca-doc-status ${item.status === 'approved' ? 'is-approved' : 'is-draft'}`}>
        {item.status === 'approved' ? t('version.statusApproved') : t('version.statusDraft')}
      </span>
      <svg className="ca-doc-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {open && <div className="ca-ver-popover-group">
      <div className="ca-menu-panel ca-popover-surface ca-ver-menu-list is-structured" role="listbox" aria-label={t('version.libraryAria')}
        onMouseLeave={() => setHoveredId(null)}>
        <div className="ca-ver-popover-head">
          <div className="ca-ver-popover-head-left">
            <span className="ca-ver-popover-title">{t('version.libraryTitle')}</span>
            <span className="ca-ver-popover-summary">
              {tree.branches.length > 0
                ? t('version.summaryWithBranches', { masters: tree.masters.length, branches: tree.branches.length })
                : t('version.summaryMastersOnly', { masters: tree.masters.length })}
            </span>
          </div>
          {onOpenGraph ? (
            <button type="button" className="ca-ver-graph-btn" onClick={() => { setOpen(false); onOpenGraph('all') }}>
              <svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="11.5" cy="6.2" r="1.7" stroke="currentColor" strokeWidth="1.4" />
                <path d="M4.5 5.2v5.6M11.5 7.9V9c0 1.8-1.4 3.2-3.2 3.2H6.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              </svg>
              <span>{t('version.openGraphBtn')}</span>
            </button>
          ) : (
            <span className="ca-ver-popover-hint">{t('version.hoverPreviewHint')}</span>
          )}
        </div>

        <div className="ca-ver-popover-body">
          {tree.masters.length > 0 && (
            <div className="ca-ver-section">
              <div className="ca-ver-section-head">
                <svg className="ca-ver-section-icon is-master" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="2.2" y="1.8" width="9.6" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.35" />
                  <path d="M4.6 5.2h4.8M4.6 7.7h3.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
                <span className="ca-ver-section-title">{t('version.masterTracks')}</span>
                <span className="ca-ver-section-count">{tree.masters.length}</span>
              </div>
              <div className="ca-ver-track-stack">
                {tree.masters.map(master => {
                  const containsCurrent = master.revisions.some(r => r.id === item.id)
                  const primaryRev = master.latest
                  const isPrimaryActive = primaryRev?.id === item.id
                  const isRenaming = renamingTrackId === master.trackId
                  const histKey = `m:${master.trackId}`
                  const histOpen = expandedTracks[histKey] ?? (containsCurrent && !isPrimaryActive)
                  const olderCount = Math.max(0, master.revisions.length - 1)
                  const canArchiveMaster = Boolean(onArchive && tree.masters.length > 1 && primaryRev)
                  const hasSecondaryActions = Boolean((onRename && !isRenaming) || (onSetDefault && !master.isDefault) || (onBranchMaster && primaryRev) || canArchiveMaster)

                  return <div key={master.trackId}
                    className={`ca-ver-track-card is-master${containsCurrent ? ' is-current-track' : ''}${histOpen ? ' is-expanded' : ''}`}>
                    {isRenaming ? (
                      <form className="ca-ver-rename-form" onSubmit={e => void submitRename(e, primaryRev.id)}>
                        <input autoFocus maxLength={80} value={renameDraft}
                          onChange={e => setRenameDraft(e.target.value)}
                          placeholder={t('version.renamePlaceholder')} />
                        <button type="submit" className="ca-ver-micro-btn is-primary">{t('common.save')}</button>
                        <button type="button" className="ca-ver-micro-btn" onClick={() => setRenamingTrackId('')}>{t('common.cancel')}</button>
                      </form>
                    ) : (
                      <div className={`ca-ver-main-row${isPrimaryActive ? ' is-active' : ''}${primaryRev?.id === hoveredId ? ' is-hovering' : ''}`}
                        onMouseEnter={() => primaryRev && setHoveredId(primaryRev.id)}>
                        <button type="button" role="option" aria-selected={isPrimaryActive}
                          className={`ca-ver-main-btn${isPrimaryActive ? ' is-active' : ''}`}
                          onFocus={() => primaryRev && setHoveredId(primaryRev.id)}
                          onClick={() => { if (primaryRev) { setOpen(false); onVersion(primaryRev.id) } }}>
                          <span className="ca-ver-emblem-wrap">
                            <MasterResumeEmblem size={28} isDefault={master.isDefault} />
                          </span>
                          <span className="ca-ver-main-body">
                            <span className="ca-ver-row-title">
                              <strong>{master.title}</strong>
                              {primaryRev?.versionTag && <span className="ca-ver-chip">{primaryRev.versionTag}</span>}
                              {master.isDefault && <span className="ca-ver-default-tag">{t('version.defaultMaster')}</span>}
                            </span>
                            <span className="ca-ver-meta-row">
                              {[
                                primaryRev?.changeLabel ? localizeChangeLabel(primaryRev.changeLabel, t) : '',
                                primaryRev?.status === 'approved' ? t('version.statusApproved') : t('version.statusDraft'),
                                primaryRev?.sortTime ? readableDate(primaryRev.sortTime, timezone, locale) : '',
                              ].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          {isPrimaryActive && (
                            <span className="ca-ver-active-pill" aria-hidden="true">
                              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                                <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          )}
                        </button>
                      </div>
                    )}

                    {(olderCount > 0 || hasSecondaryActions) && (
                      <div className="ca-ver-track-bar">
                        {olderCount > 0 ? (
                          <button type="button" className={`ca-ver-hist-pill${histOpen ? ' is-open' : ''}`} aria-expanded={histOpen}
                            onClick={() => toggleHistory(histKey, histOpen)}>
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                              <circle cx="7" cy="7" r="5.1" stroke="currentColor" strokeWidth="1.25" />
                              <path d="M7 4.4V7l1.8 1.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{histOpen ? t('version.collapseHistory') : t('version.historyCount', { count: master.versionCount })}</span>
                            <svg className="ca-ver-hist-chev" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                              <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        ) : <span />}
                        {hasSecondaryActions && (
                          <div className="ca-ver-secondary-actions">
                            {onRename && !isRenaming && (
                              <button type="button" className="ca-ver-micro-btn"
                                onClick={() => { setRenamingTrackId(master.trackId); setRenameDraft(master.title) }}>
                                <svg width="10.5" height="10.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <path d="M9.6 2.3 11.7 4.4 4.8 11.3H2.7V9.2l6.9-6.9Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                                </svg>
                                <span>{t('version.rename')}</span>
                              </button>
                            )}
                            {onSetDefault && !master.isDefault && (
                              <button type="button" className="ca-ver-micro-btn"
                                onClick={() => void onSetDefault(master.trackId)}>
                                <svg width="10.5" height="10.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <path d="M7 2.1 8.5 5.1 11.8 5.6 9.4 7.9 10 11.2 7 9.6 4 11.2 4.6 7.9 2.2 5.6 5.5 5.1 7 2.1Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
                                </svg>
                                <span>{t('version.setDefault')}</span>
                              </button>
                            )}
                            {onBranchMaster && primaryRev && (
                              <button type="button" className="ca-ver-micro-btn"
                                onClick={async () => { setOpen(false); await onBranchMaster(primaryRev.id, t('version.branchSuffix', { title: master.title })) }}>
                                <svg width="10.5" height="10.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <circle cx="4.2" cy="3.3" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                                  <circle cx="9.8" cy="4.8" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                                  <circle cx="4.2" cy="10.7" r="1.4" stroke="currentColor" strokeWidth="1.2" />
                                  <path d="M4.2 4.7v4.6M9.8 6.2c0 1.8-1.5 2.4-5.6 2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                </svg>
                                <span>{t('version.newMaster')}</span>
                              </button>
                            )}
                            {canArchiveMaster && (
                              <button type="button" className="ca-ver-micro-btn is-archive"
                                title={t('version.archiveMasterTitle')}
                                onClick={event => {
                                  event.stopPropagation()
                                  void onArchive(primaryRev.id, 'track')
                                }}>
                                <span>{t('version.archive')}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {histOpen && olderCount > 0 && renderHistoryList(master.revisions)}
                  </div>
                })}
              </div>
            </div>
          )}

          {tree.branches.length > 0 && (
            <div className="ca-ver-section">
              <div className="ca-ver-section-head">
                <svg className="ca-ver-section-icon is-branch" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="4" cy="3.2" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="10" cy="4.8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="4" cy="10.8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M4 4.7v4.6M10 6.3c0 1.8-1.6 2.4-6 2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span className="ca-ver-section-title">{t('version.tailoredBranches')}</span>
                <span className="ca-ver-section-count">{tree.branches.length}</span>
              </div>
              <div className="ca-ver-track-stack">
                {tree.branches.map(branch => {
                  const primaryRev = branch.latest
                  const isPrimaryActive = primaryRev?.id === item.id
                  const containsCurrent = branch.revisions.some(r => r.id === item.id)
                  const branchRenameKey = `b:${branch.opportunityId}`
                  const isRenamingBranch = renamingTrackId === branchRenameKey
                  const histKey = `b:${branch.opportunityId}`
                  const histOpen = expandedTracks[histKey] ?? (containsCurrent && !isPrimaryActive)
                  const olderCount = Math.max(0, branch.revisions.length - 1)
                  const lineageText = primaryRev?.sourceTrackTitle
                    ? `${primaryRev.sourceTrackTitle}${primaryRev.sourceBaseVersion ? ` v${primaryRev.sourceBaseVersion}` : ''}`
                    : ''
                  const hasBranchActions = Boolean(
                    (primaryRev?.masterBehind && onRebase)
                    || (onRename && primaryRev && !isRenamingBranch)
                    || (onArchive && primaryRev),
                  )

                  return <div key={branch.opportunityId}
                    className={`ca-ver-track-card is-branch${containsCurrent ? ' is-current-track' : ''}${histOpen ? ' is-expanded' : ''}`}>
                    {isRenamingBranch ? (
                      <form className="ca-ver-rename-form" onSubmit={e => void submitRename(e, primaryRev.id)}>
                        <input autoFocus maxLength={80} value={renameDraft}
                          onChange={e => setRenameDraft(e.target.value)}
                          placeholder={t('version.renamePlaceholder')} />
                        <button type="submit" className="ca-ver-micro-btn is-primary">{t('common.save')}</button>
                        <button type="button" className="ca-ver-micro-btn" onClick={() => setRenamingTrackId('')}>{t('common.cancel')}</button>
                      </form>
                    ) : (
                      <div className={`ca-ver-main-row${isPrimaryActive ? ' is-active' : ''}${primaryRev?.id === hoveredId ? ' is-hovering' : ''}`}
                        onMouseEnter={() => primaryRev && setHoveredId(primaryRev.id)}>
                        <button type="button" role="option" aria-selected={isPrimaryActive}
                          className={`ca-ver-main-btn${isPrimaryActive ? ' is-active' : ''}`}
                          onFocus={() => primaryRev && setHoveredId(primaryRev.id)}
                          onClick={() => { if (primaryRev) { setOpen(false); onVersion(primaryRev.id) } }}>
                          <span className="ca-ver-emblem-wrap">
                            <BranchResumeEmblem size={28} />
                          </span>
                          <span className="ca-ver-main-body">
                            <span className="ca-ver-row-title">
                              <strong>{branch.label}</strong>
                              {primaryRev?.versionTag && <span className="ca-ver-chip">{primaryRev.versionTag}</span>}
                            </span>
                            <span className="ca-ver-meta-row">
                              {lineageText && <span className="ca-ver-lineage">↳ {lineageText}</span>}
                              {primaryRev?.sortTime && (
                                <span className="ca-ver-meta-time">
                                  {lineageText ? '· ' : ''}{readableDate(primaryRev.sortTime, timezone, locale)}
                                </span>
                              )}
                            </span>
                            {primaryRev?.masterBehind && (
                              <span className="ca-ver-drift-row">
                                <span className="ca-ver-drift-pill">{t('version.masterBehind')}</span>
                              </span>
                            )}
                          </span>
                          {isPrimaryActive && (
                            <span className="ca-ver-active-pill" aria-hidden="true">
                              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                                <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          )}
                        </button>
                      </div>
                    )}

                    {(olderCount > 0 || hasBranchActions) && (
                      <div className="ca-ver-track-bar">
                        {olderCount > 0 ? (
                          <button type="button" className={`ca-ver-hist-pill${histOpen ? ' is-open' : ''}`} aria-expanded={histOpen}
                            onClick={() => toggleHistory(histKey, histOpen)}>
                            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                              <circle cx="7" cy="7" r="5.1" stroke="currentColor" strokeWidth="1.25" />
                              <path d="M7 4.4V7l1.8 1.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{histOpen ? t('version.collapseHistory') : t('version.historyCount', { count: branch.versionCount })}</span>
                            <svg className="ca-ver-hist-chev" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                              <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        ) : <span />}
                        {hasBranchActions && (
                          <div className={`ca-ver-secondary-actions${primaryRev?.masterBehind ? ' is-visible' : ''}`}>
                            {primaryRev?.masterBehind && onRebase && (
                              <button
                                type="button"
                                className="ca-ver-micro-btn is-rebase"
                                title={t('version.syncMasterTitle')}
                                onClick={event => {
                                  event.stopPropagation()
                                  setOpen(false)
                                  void onRebase(primaryRev.id)
                                }}
                              >
                                <svg width="10.5" height="10.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <path d="M11.6 6.8a4.6 4.6 0 0 1-7.9 3.2M2.4 7.2a4.6 4.6 0 0 1 7.9-3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                                  <path d="M10.4 2.3v2h-2M3.6 11.7v-2h2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <span>{t('version.syncMaster')}</span>
                              </button>
                            )}
                            {onRename && primaryRev && !isRenamingBranch && (
                              <button type="button" className="ca-ver-micro-btn"
                                onClick={event => {
                                  event.stopPropagation()
                                  setRenamingTrackId(branchRenameKey)
                                  setRenameDraft(branch.label)
                                }}>
                                <svg width="10.5" height="10.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                                  <path d="M9.6 2.3 11.7 4.4 4.8 11.3H2.7V9.2l6.9-6.9Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                                </svg>
                                <span>{t('version.rename')}</span>
                              </button>
                            )}
                            {onArchive && primaryRev && (
                              <button
                                type="button"
                                className="ca-ver-micro-btn is-archive"
                                title={t('version.archiveBranchTitle')}
                                onClick={event => {
                                  event.stopPropagation()
                                  void onArchive(primaryRev.id, 'track')
                                }}
                              >
                                <span>{t('version.archive')}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {histOpen && olderCount > 0 && renderHistoryList(branch.revisions)}
                  </div>
                })}
              </div>
            </div>
          )}
        </div>
        {archivedCount > 0 && onOpenGraph && (
          <button type="button" className="ca-ver-archived-bar"
            onClick={() => { setOpen(false); onOpenGraph('archived') }}>
            <span>{t('version.archivedFooter', { count: archivedCount })}</span>
            <span>{t('version.archivedManage')}</span>
          </button>
        )}
      </div>
      {previewRow && !renamingTrackId && (
        <VersionRealPreviewCard row={previewRow} timezone={timezone} accent={accent} font={font} />
      )}
    </div>}
  </div>
}

function computeSpanDelta(before, after) {
  if (before === after) return { changed: false }
  let start = 0
  const minLen = Math.min(before.length, after.length)
  while (start < minLen && before[start] === after[start]) start += 1
  let end = 0
  while (end < minLen - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1
  const removed = before.slice(start, before.length - end)
  const added = after.slice(start, after.length - end)
  const localized = (start + end) >= Math.max(4, Math.floor(after.length * 0.3))
  return { changed: true, start, end, removed, added, localized }
}

function EditorialDiff({ source, text, kept, rank, promoted }) {
  const { t } = useI18n()
  const before = stripMarkdownInline(stripBulletPrefix(source))
  const after = stripMarkdownInline(stripBulletPrefix(text))
  const delta = React.useMemo(() => computeSpanDelta(before, after), [before, after])

  if (!kept) {
    return <div className="ca-ed-card is-rejected">
      <p className="ca-ed-main">{before}</p>
      <span className="ca-ed-note">{t('resume.keptOriginalNote')}</span>
    </div>
  }

  if (!delta.changed) {
    return <div className="ca-ed-card">
      <p className="ca-ed-main">{after}</p>
      {promoted && <span className="ca-ed-note">{t('resume.promotedOnlyNote', { rank })}</span>}
    </div>
  }

  const head = after.slice(0, delta.start)
  const tail = delta.end > 0 ? after.slice(after.length - delta.end) : ''
  const compactOld = delta.localized && delta.removed && delta.removed.length <= 18

  return <div className="ca-ed-card">
    <p className="ca-ed-main">
      {delta.localized && delta.added ? (
        <>{head}<mark className="ca-ed-mark">{delta.added}</mark>{tail}</>
      ) : after}
    </p>
    {compactOld ? (
      <span className="ca-ed-note">{t('resume.originalDeltaNote', { removed: delta.removed, added: delta.added || t('resume.trimmed') })}</span>
    ) : (
      <p className="ca-ed-origin">
        <span>{t('resume.originalLine')}</span>
        <span>{before}</span>
      </p>
    )}
  </div>
}

function parseGapChips(raw = '') {
  const clean = String(raw || '').trim()
  if (!clean) return { lead: '', chips: [] }
  // Split intro before "需确认：" / "缺少证据：" / "如下：" if followed by semicolon/newline list
  let lead = ''
  let body = clean
  const colonMatch = /^(.{6,90}?[：:])\s*([\s\S]+)$/.exec(clean)
  if (colonMatch && /[;；\n]/.test(colonMatch[2])) {
    lead = colonMatch[1].replace(/[：:]\s*$/, '')
    body = colonMatch[2]
  }
  const parts = body
    .split(/[;；\n]+/u)
    .map(s => s.replace(/^[\s•·\-–—\d.、]+|[。；;.\s]+$/gu, '').trim())
    .filter(Boolean)
  if (parts.length <= 1) return { lead: '', chips: [], prose: clean }
  return { lead, chips: parts, prose: '' }
}

function GapsPanel({ gaps, onPickGap }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = React.useState(false)
  const parsed = React.useMemo(() => parseGapChips(gaps), [gaps])
  if (!gaps) return null
  const limit = 6
  const visible = expanded ? parsed.chips : parsed.chips.slice(0, limit)
  const hiddenCount = Math.max(0, parsed.chips.length - visible.length)

  return <div className="ca-gaps-panel">
    <div className="ca-gaps-head">
      <div className="ca-inline">
        <strong>{t('resume.gapsTitle')}</strong>
        {parsed.chips.length > 0 && <span className="ca-gaps-count">{t('common.countItems', { count: parsed.chips.length })}</span>}
      </div>
      {onPickGap && <button type="button" className="ca-text-button" onClick={() => onPickGap(t('resume.askAiGapsPrompt'))}>{t('resume.askAiGaps')}</button>}
    </div>
    {parsed.lead && <p className="ca-gaps-lead">{parsed.lead}</p>}
    {parsed.chips.length > 0 ? <>
      <div className="ca-gaps-chips">
        {visible.map((chip, idx) => (
          <button key={idx} type="button" className="ca-gap-chip" title={t('resume.gapChipTitle')}
            onClick={() => onPickGap?.(t('resume.gapChipSeed', { chip }))}>
            <span className="ca-gap-plus" aria-hidden="true">+</span>
            <span>{chip}</span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button type="button" className="ca-gap-chip is-more" onClick={() => setExpanded(true)}>
            {t('resume.expandMoreGaps', { count: hiddenCount })}
          </button>
        )}
        {expanded && parsed.chips.length > limit && (
          <button type="button" className="ca-gap-chip is-more" onClick={() => setExpanded(false)}>{t('common.collapse')}</button>
        )}
      </div>
      <p className="ca-gaps-tip">{t('resume.gapsTip')}</p>
    </> : <p className="ca-gaps-prose">{parsed.prose}</p>}
  </div>
}

const SEVERITY_SPECS = {
  concern: { labelKey: 'evidence.sentimentConcern', tone: 'warning' },
  positive: { labelKey: 'evidence.sentimentPositiveSignal', tone: 'success' },
  neutral: { labelKey: 'evidence.sentimentNeutralObs', tone: 'neutral' },
}

function LibrarySheet({ evidence, reflections, state, config, busy, act, onResume, onSources, onClose }) {
  const { t, locale } = useI18n()
  const uid = React.useId()
  const [libTab, setLibTab] = React.useState('evidence')
  const [evFilter, setEvFilter] = React.useState('all')
  const [form, setForm] = React.useState('')
  const [confirmRefId, setConfirmRefId] = React.useState('')
  const [distilling, setDistilling] = React.useState(false)
  const [distillFeedback, setDistillFeedback] = React.useState(null)
  const activeEvidence = evidence.filter(item => ['pending', 'approved'].includes(item.status)).toReversed()
  const activeReflections = reflections.filter(item => ['pending', 'approved'].includes(item.status)).toReversed()
  const libraryIntakes = list(state?.intakes).filter(entry => ['evidence', 'reflection', 'clarify'].includes(entry?.kind))

  const sessionSource = list(config.sources).find(s => s.id === 'dsh-session' && !s.revokedAt)
  const sessionProjects = sessionSource?.projects ?? []
  const hasRecordings = list(state?.recordings?.sources).some(s => s.enabled && s.available)
  const passiveOn = config.mode !== 'off' && config.watchSessions !== false && (sessionProjects.length > 0 || hasRecordings)
  const passiveScopeText = sessionProjects.includes('*')
    ? t('sources.scopeAll')
    : sessionProjects.length > 0
      ? t('evidence.passiveWorkspaces', { count: sessionProjects.length })
      : hasRecordings ? t('evidence.passiveRecording') : ''

  const runDistillNow = async () => {
    if (distilling || state?.watch?.running) return
    setDistilling(true)
    setDistillFeedback(null)
    try {
      const runner = typeof act?.background === 'function' ? act.background : act
      const reply = await runner('run', { scope: 'sessions', explicitManual: true })
      const res = reply?.result ?? {}
      const results = Array.isArray(res.results) ? res.results : []
      const sessionRows = results.filter(r => r?.sourceId === 'dsh-session')
      const sessionErr = sessionRows.find(r => r?.status === 'error')?.error
      const sessionOk = sessionRows.find(r => r?.status === 'ok')
      const sessionSkipped = sessionRows.find(r => r?.status === 'skipped')

      if (!reply?.ok || res.error || res.lastError || sessionErr) {
        setDistillFeedback({
          tone: 'error',
          title: t('evidence.distillErrorTitle'),
          detail: reply?.error || res.error || res.lastError || sessionErr || t('activity.actionFailedFallback'),
        })
        return
      }
      if (res.running) {
        setDistillFeedback({
          tone: 'info',
          title: t('evidence.distillRunningTitle'),
          detail: t('evidence.distillRunningDetail'),
        })
        return
      }
      if (res.paused || sessionSkipped?.reason === 'disabled' || sessionSkipped?.reason === 'no_scope') {
        setDistillFeedback({
          tone: 'info',
          title: t('evidence.distillPausedTitle'),
          detail: t('evidence.distillPausedDetail'),
        })
        return
      }
      if (sessionSkipped?.reason === 'no_model_auth') {
        setDistillFeedback({
          tone: 'info',
          title: t('evidence.distillNoModelAuthTitle'),
          detail: t('evidence.distillNoModelAuthDetail'),
        })
        return
      }
      const checkedCount = Number(sessionOk?.count ?? 0)
      const proposedCount = Number(sessionOk?.proposed ?? 0)
      const achCount = Number(sessionOk?.achievements ?? proposedCount)
      const refCount = Number(sessionOk?.reflections ?? 0)
      if (proposedCount > 0) {
        if (achCount === 0 && refCount > 0) setLibTab('reflections')
        setDistillFeedback({
          tone: 'ok',
          title: t('evidence.distillFoundTitle', { count: checkedCount, proposed: proposedCount }),
          detail: achCount === 0 && refCount > 0
            ? t('evidence.distillFoundReflectionsDetail')
            : t('evidence.distillFoundDetail'),
        })
      } else if (checkedCount > 0) {
        setDistillFeedback({
          tone: 'info',
          title: t('evidence.distillNoneMatchedTitle', { count: checkedCount }),
          detail: t('evidence.distillNoneMatchedDetail'),
        })
      } else {
        setDistillFeedback({
          tone: 'info',
          title: t('evidence.distillNoNewTitle'),
          detail: t('evidence.distillNoNewDetail'),
        })
      }
    } finally {
      setDistilling(false)
    }
  }

  const pendingEvCount = activeEvidence.filter(i => i.status === 'pending').length
  const hasRecordingEv = activeEvidence.some(i => String(i.sourceId || '').startsWith('recording:'))
  const filteredEvidence = activeEvidence.filter(item => {
    if (evFilter === 'pending') return item.status === 'pending'
    if (evFilter === 'shareable') return item.status === 'approved' && item.shareable
    if (evFilter === 'session') return item.sourceId === 'dsh-session'
    if (evFilter === 'manual') return item.sourceId === 'manual'
    if (evFilter === 'recording') return String(item.sourceId || '').startsWith('recording:')
    return true
  })

  const concernCount = activeReflections.filter(r => r.severity === 'concern').length
  const positiveCount = activeReflections.filter(r => r.severity === 'positive').length

  return <SideSheet wide title={t('evidence.libraryTitle')} onClose={onClose}>
    {({ dismiss }) => <div className="ca-sheet-body ca-library-body" data-surface="library">
      {/* Compact single-line perception status bar */}
      <div className="ca-library-perception-bar">
        <div className="ca-library-perception-left">
          <DistillEmblem size={28} active={passiveOn} scanning={distilling || busy === 'run' || Boolean(state?.watch?.running)} />
          <div className="ca-library-perception-text">
            <strong>{passiveOn ? t('evidence.passiveOn', { scope: passiveScopeText }) : t('evidence.passiveOff')}</strong>
            {passiveOn && state?.watch?.lastRun && (
              <small>{t('evidence.lastDistilled', { time: readableDate(state.watch.lastRun, config.timezone, locale) })}</small>
            )}
          </div>
        </div>
        <div className="ca-inline">
          {passiveOn && (
            <Button variant="outline" size="sm" disabled={distilling || !!busy || state?.watch?.running}
              onClick={() => void runDistillNow()}>
              {distilling || busy === 'run' || state?.watch?.running ? <><StateDot state="ongoing" size={10} /> {t('evidence.distilling')}</> : t('evidence.distillNow')}
            </Button>
          )}
          {onSources && (
            <Button variant="ghost" size="sm" onClick={() => { dismiss(); onSources('scope') }}>
              {passiveOn ? t('common.settings') : t('common.enable')}
            </Button>
          )}
        </div>
      </div>

      {distillFeedback && (
        <div className={`ca-library-distill-feedback is-${distillFeedback.tone}`} role="status" aria-live="polite">
          <div className="ca-library-distill-feedback-copy">
            <strong>{distillFeedback.title}</strong>
            {distillFeedback.detail && <span>{distillFeedback.detail}</span>}
          </div>
          <button
            type="button"
            className="ca-library-distill-feedback-close"
            aria-label={t('common.close')}
            onClick={() => setDistillFeedback(null)}
          >×</button>
        </div>
      )}

      {/* Embedded natural-language quick capture right inside Library */}
      <Composer
        compact
        surface="library"
        config={config}
        act={act}
        busy={busy}
        intakes={libraryIntakes}
        placeholderOverride={t('evidence.libraryPlaceholder')}
        fallbackOverride={t('evidence.libraryFallback')}
        onApplied={kind => {
          if (kind === 'reflection') setLibTab('reflections')
          else if (kind === 'evidence') setLibTab('evidence')
        }}
      />

      {/* Segmented tabs + manual add trigger */}
      <div className="ca-library-tabs-row">
        <SegmentedControl
          id={`${uid}-lib`}
          label={t('evidence.libraryTabsAria')}
          value={libTab}
          onChange={next => { setLibTab(next); setForm('') }}
          options={[
            { value: 'evidence', label: t('evidence.tabEvidence', { count: activeEvidence.length }) },
            { value: 'reflections', label: t('evidence.tabReflections', { count: activeReflections.length }) },
          ]}
        />
        <Button variant="outline" size="sm" icon={<Icon name="plus" size={13} />}
          onClick={() => setForm(cur => cur === libTab ? '' : libTab)}>
          {form === libTab ? t('common.collapse') : t('evidence.manualAdd')}
        </Button>
      </div>

      {libTab === 'evidence' && <>
        {form === 'evidence' && <RecordEvidence config={config} busy={busy} act={act} onDone={() => setForm('')} />}
        {activeEvidence.length > 0 && (
          <div className="ca-quick-chip-group" role="group" aria-label={t('evidence.filterEvidenceAria')}>
            {[
              ['all', t('evidence.filterAll', { count: activeEvidence.length })],
              ...(pendingEvCount > 0 ? [['pending', t('evidence.filterPending', { count: pendingEvCount })]] : []),
              ['shareable', t('evidence.shareable')],
              ['session', t('evidence.filterSession')],
              ['manual', t('evidence.filterManual')],
              ...(hasRecordingEv ? [['recording', t('evidence.filterRecording')]] : []),
            ].map(([id, label]) => (
              <button key={id} type="button" className={`ca-target-pill${evFilter === id ? ' is-active' : ''}`}
                onClick={() => setEvFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {filteredEvidence.length ? <div className="ca-ev-list">
          {filteredEvidence.map(item => <Evidence key={item.id} item={item} config={config} act={act} busy={busy}
            onResume={id => { dismiss(); onResume(id) }} />)}
        </div> : (
          <div className="ca-library-empty-wrap">
            <Empty>{activeEvidence.length ? t('evidence.emptyFiltered') : t('evidence.emptyEvidence')}</Empty>
            {activeEvidence.length === 0 && (
              <p className="ca-library-empty-criteria">{t('evidence.emptyEvidenceCriteria')}</p>
            )}
          </div>
        )}
      </>}

      {libTab === 'reflections' && <>
        {form === 'reflections' && <ReflectionForm busy={busy} act={act} onDone={() => setForm('')} />}
        {activeReflections.length > 0 && (
          <div className="ca-library-ref-summary">
            <span>{t('evidence.reflectionStats', { total: activeReflections.length, concern: concernCount, positive: positiveCount })}</span>
          </div>
        )}
        {activeReflections.length ? <div className="ca-stream">
          {activeReflections.map(item => {
            const sev = SEVERITY_SPECS[item.severity] ?? SEVERITY_SPECS.neutral
            const srcLabel = item.sourceId ? sourceLabel(item.sourceId, t) : t('evidence.filterManual')
            return <article className="ca-row ca-ref-row" key={item.id}>
              <div className="ca-row-body">
                <div className="ca-inline">
                  <h3>{dimensionLabel(item.dimension, t) || t('evidence.reflectionTitle')}</h3>
                  <Tag tone={sev.tone}>{t(sev.labelKey)}</Tag>
                  {item.status === 'pending' && <Tag tone="info">{t('evidence.pendingConfirm')}</Tag>}
                </div>
                <p>{item.text}</p>
                <div className="ca-meta">{srcLabel} · {readableDate(item.occurredAt ?? item.createdAt, config.timezone, locale)}</div>
              </div>
              <div className="ca-row-actions">
                {confirmRefId === item.id ? <>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRefId('')}>{t('common.cancel')}</Button>
                  <Button variant="outline" size="sm" className="ca-danger-text" disabled={!!busy}
                    onClick={async () => { if (await act('reflection-delete', { id: item.id }, t('evidence.toastReflectionDeleted'))) setConfirmRefId('') }}>{t('common.confirmDelete')}</Button>
                </> : <>
                  {item.status === 'pending' && <Button variant="primary" size="sm" disabled={!!busy}
                    onClick={() => act('reflection-review', { id: item.id, decision: 'approve' }, t('evidence.toastReflectionApproved'))}>{t('common.confirm')}</Button>}
                  <Button variant="ghost" size="sm" className="ca-danger-text" disabled={!!busy}
                    onClick={() => setConfirmRefId(item.id)}>{t('common.delete')}</Button>
                </>}
              </div>
            </article>
          })}
        </div> : <Empty>{t('evidence.emptyReflections')}</Empty>}
      </>}
    </div>}
  </SideSheet>
}

function readSavedStyle() {
  try {
    const raw = readProfileLocal('local.style')
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const DRAFT_STORAGE_PREFIX = 'resumeDraft.'
const VERSION_APPEARANCE_PREFIX = 'versionAppearance.'
const SELECTED_RESUME_KEY = 'selectedResumeId'
const ACTIVE_TAB_KEY = 'activeTab'

function readVersionAppearance(item) {
  const serverApp = item?.appearance && typeof item.appearance === 'object' ? item.appearance : null
  let localApp = null
  if (item?.id) {
    try {
      const raw = readProfileLocal(VERSION_APPEARANCE_PREFIX + item.id)
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) localApp = parsed
    } catch {}
  }
  const template = serverApp?.template
    || localApp?.template
    || readProfileLocal('local.template')
    || 'onyx'
  const style = (serverApp?.style && typeof serverApp.style === 'object')
    ? serverApp.style
    : (localApp?.style && typeof localApp.style === 'object')
      ? localApp.style
      : readSavedStyle()
  return { template, style }
}

function writeVersionAppearance(id, template, style, opts) {
  try {
    if (template) writeProfileLocal('local.template', template, opts)
    if (style && typeof style === 'object') {
      if (Object.keys(style).length) writeProfileLocal('local.style', JSON.stringify(style), opts)
      else removeProfileLocal('local.style', opts)
    }
    if (id) {
      writeProfileLocal(VERSION_APPEARANCE_PREFIX + id, JSON.stringify({
        ...(template ? { template } : {}),
        ...(style && typeof style === 'object' ? { style } : {}),
      }), opts)
    }
  } catch {}
}

function buildStarterMarkdown({ name, role, highlights, skills, locale }) {
  const isEn = locale === 'en'
  const cleanName = String(name || '').trim() || (isEn ? 'My Resume' : '个人简历')
  const cleanRole = String(role || '').trim()
  const rawLines = String(highlights || '').replace(/\r\n?/gu, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  const bullets = rawLines.length
    ? rawLines.map(l => /^[-*+•]\s+/u.test(l) ? `- ${l.replace(/^[-*+•]\s+/u, '')}` : `- ${l}`)
    : [isEn ? '- Key project and delivery highlight (click to edit or ask AI to refine).' : '- 在此补充一段核心项目与量化成果（可直接编辑，或在下方与 AI 对话润色）。']
  const cleanSkills = String(skills || '').trim()
  const parts = [`# ${cleanName}`]
  if (cleanRole) parts.push(`_${cleanRole}_`)
  parts.push('')
  parts.push(isEn ? '## Experience & Projects' : '## 核心工作与项目经历')
  if (cleanRole) parts.push(`### ${cleanRole}`)
  parts.push(...bullets)
  if (cleanSkills) {
    parts.push('')
    parts.push(isEn ? '## Core Skills' : '## 核心技能')
    parts.push(`- ${cleanSkills}`)
  }
  return `${parts.join('\n')}\n`
}

function buildBlankResumeMarkdown(locale) {
  if (locale === 'en') {
    return '# Your Name\n_Target Role · City · Email_\n\n## Summary\n\n## Experience\n\n## Projects\n\n## Education\n\n## Skills\n'
  }
  return '# 你的姓名\n_求职方向 · 城市 · 联系方式_\n\n## 个人简介\n\n## 工作经历\n\n## 项目经历\n\n## 教育背景\n\n## 核心技能\n'
}

const ROLE_WORD_RE = /(?:engineer|infra|ai|ml|product|manager|design|stack|backend|frontend|data|ops|后端|前端|全栈|算法|产品|架构|开发|经理|运营|设计|工程|平台)/iu

function parseIdentityInput(raw) {
  const clean = String(raw || '').trim()
  if (!clean) return { name: '', role: '' }
  const parts = clean.split(/[，,\n]+/u).map(s => s.trim()).filter(Boolean)
  if (parts.length >= 2 && parts[0].length <= 16 && !ROLE_WORD_RE.test(parts[0])) {
    return { name: parts[0].slice(0, 60), role: parts.slice(1).join(' · ').slice(0, 120) }
  }
  return { name: '', role: clean.slice(0, 120) }
}

function readLocalDraft(id, expectedBase, opts) {
  if (!id) return null
  try {
    const raw = readProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.text === 'string' && parsed.baseText === expectedBase && parsed.text !== expectedBase) {
      return parsed.text
    }
  } catch {}
  return null
}

function writeLocalDraft(id, text, baseText, opts) {
  if (!id) return
  try {
    if (!text || text === baseText) removeProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
    else writeProfileLocal(DRAFT_STORAGE_PREFIX + id, JSON.stringify({ text, baseText, updatedAt: Date.now() }), opts)
  } catch {}
}

function clearLocalDraft(id, opts) {
  if (!id) return
  removeProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
}

function clearAllLocalDrafts(opts) {
  clearProfileLocalPrefix(DRAFT_STORAGE_PREFIX, opts)
}

function ResumeWorkbench({
  item, resumes, defaultMasterTrackId = '', profileKey = '', templates, opportunities, config, capabilities, act, silentAct, busy,
  onVersion, agent, playback, onReplay, onTriggerStagedPlayback, onEditorReady, retainedPreviewRef,
  onOpenImport, onOpenLibrary, evidenceCountTotal, pendingEvidence, unmergedCount, unmergedEvidence = [],
  hasSources, onSources, seedPrompt, onConsumeSeedPrompt,
}) {
  const { t, locale } = useI18n()
  const ownerProfileRef = React.useRef(null)
  if (!ownerProfileRef.current) {
    const pk = (typeof profileKey === 'string' && profileKey.trim()) || getActiveProfileKey()
    ownerProfileRef.current = { profileKey: pk, generation: getProfileGeneration() }
  }
  const editorOpts = React.useMemo(() => ({ profileKey: ownerProfileRef.current.profileKey }), [])
  const baseText = displayResume(item, resumes)
  const initialApp = React.useMemo(() => readVersionAppearance(item), [item.id])
  const [draftText, setDraftText] = React.useState(() => readLocalDraft(item.id, baseText) ?? baseText)
  const [saveState, setSaveState] = React.useState(() => item.autoSaved ? 'saved' : 'idle')
  const [excluded, setExcluded] = React.useState([])
  const [stagedProposal, setStagedProposal] = React.useState(null)
  const [stagedOpen, setStagedOpen] = React.useState(true)
  const [lastAppliedUndo, setLastAppliedUndo] = React.useState(null)
  const [evidenceSourcePreviews, setEvidenceSourcePreviews] = React.useState({})
  const [mobilePane, setMobilePane] = React.useState('edit')
  const [templateChoice, setTemplateChoice] = React.useState(() => initialApp.template)
  const [styleOverrides, setStyleOverrides] = React.useState(() => initialApp.style)
  const [highlightLine, setHighlightLine] = React.useState(null)
  const [syncedResumeId, setSyncedResumeId] = React.useState(item.id)
  const [pendingOpen, setPendingOpen] = React.useState(false)
  const [reviewOpen, setReviewOpen] = React.useState(
    () => (item.kind === 'tailored' && item.status === 'pending')
      || ((item.kind === 'generated' || item.origin === 'rebase') && item.status === 'pending' && Boolean(item.placements?.length || item.summary)),
  )
  const [localSeedPrompt, setLocalSeedPrompt] = React.useState('')
  const [exportState, setExportState] = React.useState({ ready: false, exporting: '' })
  const paperExportRef = React.useRef(null)
  const reviewCardRef = React.useRef(null)
  const prevIdRef = React.useRef(item.id)
  const prevBaseTextRef = React.useRef(baseText)
  const autoSaveTimerRef = React.useRef(null)
  const autoSaveSeqRef = React.useRef(0)
  const autoSavedIdsRef = React.useRef(new Set())
  const latestRef = React.useRef({
    id: item.id, draftText, baseText, editable: ['pending', 'approved'].includes(item.status),
    isAutoSavedPending: item.status === 'pending' && item.autoSaved === true, dirty: false,
  })

  const activeTemplate = templates.find(row => row.id === templateChoice) ?? templates[0] ?? null

  const persistVersionAppearance = React.useCallback((nextTpl, nextStyle) => {
    writeVersionAppearance(item.id, nextTpl, nextStyle, editorOpts)
    if (item.id && ['pending', 'approved'].includes(item.status)) {
      void silentAct?.('resume-appearance', { id: item.id, template: nextTpl, style: nextStyle })
    }
  }, [item.id, item.status, silentAct, editorOpts])

  const selectTemplate = React.useCallback(id => {
    setTemplateChoice(id)
    persistVersionAppearance(id, styleOverrides)
  }, [persistVersionAppearance, styleOverrides])

  const updateStyle = React.useCallback(patch => {
    setStyleOverrides(current => {
      const next = { ...current, ...patch }
      persistVersionAppearance(templateChoice, next)
      return next
    })
  }, [persistVersionAppearance, templateChoice])

  const resetStyle = React.useCallback(() => {
    setStyleOverrides({})
    persistVersionAppearance(templateChoice, {})
  }, [persistVersionAppearance, templateChoice])

  const applyStyleDirective = React.useCallback(directive => {
    if (directive?.targetResumeId && directive.targetResumeId !== latestRef.current.id) return
    const nextTpl = directive.templateId || templateChoice
    const nextStyle = directive.patch?.reset
      ? {}
      : (directive.patch && Object.keys(directive.patch).length > 0 ? { ...styleOverrides, ...directive.patch } : styleOverrides)
    if (directive.templateId) setTemplateChoice(nextTpl)
    if (directive.patch?.reset) setStyleOverrides({})
    else if (directive.patch && Object.keys(directive.patch).length > 0) setStyleOverrides(nextStyle)
    persistVersionAppearance(nextTpl, nextStyle)
  }, [templateChoice, styleOverrides, persistVersionAppearance])

  React.useEffect(() => {
    if (prevIdRef.current !== item.id || prevBaseTextRef.current !== baseText) {
      const switchedVersion = prevIdRef.current !== item.id
      const fromOwnAutoSave = autoSavedIdsRef.current.has(item.id)
      if (fromOwnAutoSave) autoSavedIdsRef.current.delete(item.id)
      prevIdRef.current = item.id
      prevBaseTextRef.current = baseText
      if (fromOwnAutoSave) {
        // Keep user's in-flight typing if they typed ahead while auto-save was completing.
        setDraftText(cur => cur === baseText ? baseText : cur)
      } else {
        const recovered = readLocalDraft(item.id, baseText)
        setDraftText(recovered ?? baseText)
        setSaveState(recovered ? 'saving' : (item.autoSaved ? 'saved' : 'idle'))
      }
      setExcluded([])
      if (switchedVersion && !fromOwnAutoSave) {
        setStagedProposal(null)
        setLastAppliedUndo(null)
        const nextApp = readVersionAppearance(item)
        setTemplateChoice(nextApp.template)
        setStyleOverrides(nextApp.style)
        setReviewOpen(
          (item.kind === 'tailored' && item.status === 'pending')
          || ((item.kind === 'generated' || item.origin === 'rebase') && item.status === 'pending' && Boolean(item.placements?.length || item.summary)),
        )
      }
    }
    setSyncedResumeId(item.id)
  }, [item.id, item.status, item.autoSaved, item.kind, item.origin, item.appearance, baseText])

  const editable = ['pending', 'approved'].includes(item.status)
  const locked = !!busy || playback.active
  const items = list(item.items)
  const mergePlacements = (item.kind === 'generated' || item.origin === 'rebase') ? list(item.placements) : []
  const isEmptyRebase = item.origin === 'rebase' && mergePlacements.length === 0
  const hasMergeSummary = (item.kind === 'generated' || item.origin === 'rebase') && !isEmptyRebase && (mergePlacements.length > 0 || Boolean(item.summary))
  const isReviewable = item.kind === 'tailored' && items.length > 0
  const versionTree = React.useMemo(
    () => organizeResumeVersions(resumes, { defaultMasterTrackId, opportunities }),
    [resumes, defaultMasterTrackId, opportunities],
  )
  const currentBranchRev = React.useMemo(() => {
    for (const b of versionTree.branches) {
      const hit = b.revisions.find(r => r.id === item.id)
      if (hit) return hit
    }
    return null
  }, [versionTree, item.id])
  const currentMasterBehind = Boolean(currentBranchRev?.masterBehind)
  const currentMasterHasDiff = Boolean(currentBranchRev?.masterBehind && currentBranchRev?.masterHasContentDiff !== false)
  const currentMasterInSync = Boolean(currentBranchRev?.masterBehind && currentBranchRev?.masterHasContentDiff === false)
  const canSelectChanges = isReviewable && item.status === 'pending' && draftText === baseText
  const selectedIndices = React.useMemo(
    () => items.flatMap((_, index) => excluded.includes(index) ? [] : [index]),
    [items, excluded],
  )
  const hasPartialSelection = canSelectChanges && excluded.length > 0

  const hasUnappliedStaged = Boolean(stagedProposal && !stagedProposal.applied)
  const stagedPreviewText = React.useMemo(() => {
    if (!hasUnappliedStaged) return null
    return rebaseReviewDecisions(draftText, stagedProposal.baseText, stagedProposal.items, stagedProposal.rejectedIds)
  }, [hasUnappliedStaged, draftText, stagedProposal])

  // editorText is ALWAYS the real editable draft (or animated playback frame while read-only).
  // Unapproved staged suggestions NEVER enter the editor document, localStorage, auto-save, Cmd+S, or export.
  const editorText = React.useMemo(() => {
    if (playback.active && playback.text !== undefined) return playback.text
    if (draftText !== baseText) return draftText
    if (hasPartialSelection) {
      const parent = resumes.find(row => row.id === item.baseId)
      const parentText = parent ? displayResume(parent, resumes) : ''
      if (parentText) {
        if (!selectedIndices.length) return parentText
        const chosen = selectedIndices.map(index => items[index])
        try {
          return item.variant === 'conversation'
            ? applyResumeConversation(parentText, chosen)
            : applyTailoredSelection(parentText, chosen)
        } catch { return baseText }
      }
    }
    return baseText
  }, [playback.active, playback.text, draftText, baseText, hasPartialSelection, resumes, item.baseId, item.variant, selectedIndices, items])

  // previewText drives the right-hand A4 layout preview: shows unapproved staged lines visually without persisting them.
  const previewText = React.useMemo(() => {
    if (playback.active && playback.text !== undefined) return playback.text
    if (stagedPreviewText !== null) return stagedPreviewText
    return editorText
  }, [playback.active, playback.text, stagedPreviewText, editorText])

  const dirty = editable && !playback.active && draftText !== baseText
  latestRef.current = {
    id: item.id,
    draftText,
    baseText,
    editable,
    isAutoSavedPending: item.status === 'pending' && item.autoSaved === true,
    dirty,
    profileKey: ownerProfileRef.current.profileKey,
    profileGeneration: ownerProfileRef.current.generation,
  }

  const persistDraftNow = React.useCallback(async ({ text: nextText, title, variant, evidenceIds, opportunityId } = {}) => {
    const snap = latestRef.current
    const ctxSnap = { profileKey: ownerProfileRef.current.profileKey, generation: ownerProfileRef.current.generation }
    if (!isProfileContextCurrent(ctxSnap)) return null
    const bodyText = typeof nextText === 'string' ? nextText : snap.draftText
    const forkingJob = Boolean(opportunityId && opportunityId !== item.opportunityId)
    if (!snap.editable || !bodyText?.trim() || (!forkingJob && bodyText === snap.baseText)) return null
    const seq = ++autoSaveSeqRef.current
    setSaveState('saving')
    const reply = await silentAct?.('resume-revise', {
      id: snap.id,
      text: bodyText,
      autoSaved: true,
      inPlace: !forkingJob && snap.isAutoSavedPending && !title,
      ...(Array.isArray(evidenceIds) && evidenceIds.length ? { evidenceIds } : {}),
      ...(opportunityId ? { opportunityId } : {}),
      ...(title ? { title } : {}),
      ...(variant ? { variant } : {}),
      ...(ctxSnap.profileKey ? { profileKey: ctxSnap.profileKey } : {}),
    })
    if (!isProfileContextCurrent(ctxSnap)) return null
    if (seq !== autoSaveSeqRef.current) return reply?.result?.id ?? null
    if (reply?.result?.id) {
      const savedId = reply.result.id
      clearLocalDraft(snap.id, editorOpts)
      if (latestRef.current.draftText === bodyText) {
        clearLocalDraft(savedId, editorOpts)
        setSaveState('saved')
      } else {
        writeLocalDraft(savedId, latestRef.current.draftText, bodyText, editorOpts)
      }
      if (savedId !== snap.id) {
        autoSavedIdsRef.current.add(savedId)
        migrateResumeChatScope(snap.id, savedId)
        onVersion(savedId)
      }
      return savedId
    }
    setSaveState('error')
    return null
  }, [silentAct, onVersion, item.opportunityId])

  const scheduleAutoSave = React.useCallback(nextText => {
    window.clearTimeout(autoSaveTimerRef.current)
    writeLocalDraft(latestRef.current.id, nextText, latestRef.current.baseText, editorOpts)
    if (nextText === latestRef.current.baseText) {
      setSaveState(item.autoSaved ? 'saved' : 'idle')
      return
    }
    setSaveState('saving')
    autoSaveTimerRef.current = window.setTimeout(() => {
      void persistDraftNow({ text: nextText })
    }, 1100)
  }, [persistDraftNow, item.autoSaved, editorOpts])

  // If a recovered localStorage draft exists on mount, flush it to disk automatically.
  React.useEffect(() => {
    if (dirty && saveState === 'saving') {
      autoSaveTimerRef.current = window.setTimeout(() => {
        void persistDraftNow({ text: latestRef.current.draftText })
      }, 350)
    }
    return () => window.clearTimeout(autoSaveTimerRef.current)
  }, [item.id])

  // Zero-data-loss unmount flush: if the user switches to「新会话」or closes tab mid-edit,
  // flush pending edits via keepalive fetch so career.json on disk never loses work.
  React.useEffect(() => () => {
    window.clearTimeout(autoSaveTimerRef.current)
    const snap = latestRef.current
    if (snap.dirty && snap.editable && snap.draftText?.trim()) {
      writeLocalDraft(snap.id, snap.draftText, snap.baseText, { profileKey: snap.profileKey })
      try {
        void fetch(`${BASE}action`, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: {
            'content-type': 'application/json',
            'x-career-agent': '1',
            'x-career-locale': getActiveLocale(),
            ...(snap.profileKey ? { 'x-career-profile-key': snap.profileKey } : {}),
          },
          body: JSON.stringify({
            action: 'resume-revise',
            id: snap.id,
            text: snap.draftText,
            autoSaved: true,
            inPlace: snap.isAutoSavedPending,
            ...(snap.profileKey ? { profileKey: snap.profileKey } : {}),
          }),
        }).catch(() => {})
      } catch {}
    }
  }, [])

  React.useEffect(() => {
    const onForgotten = () => {
      window.clearTimeout(autoSaveTimerRef.current)
      clearAllLocalDrafts(editorOpts)
      setStagedProposal(null)
      setLastAppliedUndo(null)
      setEvidenceSourcePreviews({})
      if (retainedPreviewRef) retainedPreviewRef.current = null
      setSaveState('idle')
    }
    window.addEventListener('niuma:source-forgotten', onForgotten)
    return () => window.removeEventListener('niuma:source-forgotten', onForgotten)
  }, [retainedPreviewRef])

  const stageReviewProposal = React.useCallback((proposedMarkdown, meta = {}) => {
    if (meta.targetResumeId && meta.targetResumeId !== latestRef.current.id) return 'noop'
    const cleanNext = String(proposedMarkdown || '')
    const fallbackEvidenceIds = Array.isArray(meta.evidenceIds) ? meta.evidenceIds : []
    const provList = Array.isArray(meta.changeProvenance) && meta.changeProvenance.length ? meta.changeProvenance : null
    const isEvidenceSource = (meta.sourceKind || 'chat') === 'evidence'
    const currentBase = latestRef.current.draftText
    if (!cleanNext.trim() || cleanNext.trim() === String(currentBase || '').trim()) return 'noop'
    const rawItems = computeReviewableLineChanges(currentBase, cleanNext, meta.changes || [], { locale })
    if (!rawItems.length) return 'noop'
    const prevItems = (isEvidenceSource && stagedProposal && !stagedProposal.applied && Array.isArray(stagedProposal.items))
      ? stagedProposal.items
      : []
    const itemSourceLabel = meta.sourceLabel || (isEvidenceSource ? t('resume.sourceEvidenceLabel') : t('agent.sourceChatLabel'))
    const newItemReason = isEvidenceSource && Array.isArray(meta.changes) && meta.changes.length === 1
      ? String(meta.changes[0]?.summary || '')
      : ''
    const reviewItems = attachStagedReviewProvenance(rawItems, {
      changeProvenance: provList,
      previousItems: prevItems,
      fallbackEvidenceIds,
      sourceLabel: itemSourceLabel,
      sourceKind: meta.sourceKind || 'chat',
      newItemReason,
    })
    const allEvidenceIds = [...new Set(reviewItems.flatMap(row => Array.isArray(row.evidenceIds) ? row.evidenceIds : []))]
    const distinctSources = [...new Set(reviewItems.map(row => row.sourceLabel).filter(Boolean))]
    const playbackSource = distinctSources.length ? distinctSources.join(' · ') : itemSourceLabel
    // Wording-only chat edits apply optimistically with lightweight undo unless base drifted or staging is forced;
    // any evidence suggestion, newly inserted factual lines, or JD branch edit stays staged until explicitly accepted.
    const hasNewFacts = isEvidenceSource
      || allEvidenceIds.length > 0
      || reviewItems.some(row => row.kind === 'insert' || (Array.isArray(row.evidenceIds) && row.evidenceIds.length > 0))
    const baseDrifted = Boolean(meta.forceStage) || (typeof meta.baseMarkdown === 'string' && meta.baseMarkdown !== currentBase)
    const isOptimisticChat = (meta.sourceKind || 'chat') === 'chat' && !hasNewFacts && !meta.opportunityId && !baseDrifted
    const propId = crypto.randomUUID()
    const nextProposal = {
      id: propId,
      applied: isOptimisticChat,
      sourceKind: meta.sourceKind || 'chat',
      sourceLabel: playbackSource,
      sourceTitle: meta.sourceTitle || '',
      baseText: currentBase,
      proposedText: cleanNext,
      items: reviewItems,
      rejectedIds: [],
      evidenceIds: allEvidenceIds,
      meta,
    }
    setStagedProposal(nextProposal)
    setStagedOpen(!isOptimisticChat)
    setLastAppliedUndo(null)
    if (isOptimisticChat) {
      const appliedEvidenceIds = resolveAcceptedReviewEvidenceIds(reviewItems, [], allEvidenceIds)
      window.clearTimeout(autoSaveTimerRef.current)
      setDraftText(cleanNext)
      writeLocalDraft(latestRef.current.id, cleanNext, latestRef.current.baseText, editorOpts)
      void persistDraftNow({
        text: cleanNext,
        title: meta.title,
        variant: 'conversation',
        ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
        ...(appliedEvidenceIds.length ? { evidenceIds: appliedEvidenceIds } : {}),
      })
    }
    const steps = buildUnifiedPlaybackSteps(currentBase, reviewItems, { source: playbackSource })
    if (steps.length > 0 && onTriggerStagedPlayback) {
      onTriggerStagedPlayback({ token: propId, before: currentBase, steps })
    }
    return isOptimisticChat ? 'applied' : 'staged'
  }, [stagedProposal, locale, onTriggerStagedPlayback, persistDraftNow, t, editorOpts])

  const syncAppliedReviewDraft = React.useCallback((proposal, nextRejectedIds) => {
    const finalText = applyReviewDecisions(proposal.baseText, proposal.items, nextRejectedIds)
    const evidenceIds = resolveAcceptedReviewEvidenceIds(proposal.items, nextRejectedIds, proposal.evidenceIds)
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(finalText)
    writeLocalDraft(latestRef.current.id, finalText, latestRef.current.baseText, editorOpts)
    void persistDraftNow({
      text: finalText,
      title: proposal.meta?.title,
      variant: 'conversation',
      ...(proposal.meta?.opportunityId ? { opportunityId: proposal.meta.opportunityId } : {}),
      ...(evidenceIds.length ? { evidenceIds } : {}),
    })
  }, [persistDraftNow, editorOpts])

  const toggleStagedItem = React.useCallback(itemId => {
    if (!stagedProposal) return
    const isRejected = stagedProposal.rejectedIds.includes(itemId)
    const nextRejectedIds = isRejected
      ? stagedProposal.rejectedIds.filter(id => id !== itemId)
      : [...stagedProposal.rejectedIds, itemId]
    setStagedProposal(cur => cur ? { ...cur, rejectedIds: nextRejectedIds } : cur)
    if (stagedProposal.applied) {
      syncAppliedReviewDraft(stagedProposal, nextRejectedIds)
    }
  }, [stagedProposal, syncAppliedReviewDraft])

  const applyStagedProposal = React.useCallback(async () => {
    if (!stagedProposal) return
    if (stagedProposal.applied) {
      setStagedProposal(null)
      onTriggerStagedPlayback?.(null)
      return
    }
    const acceptedItems = stagedProposal.items.filter(row => !stagedProposal.rejectedIds.includes(row.id))
    const acceptedCount = acceptedItems.length
    const beforeSnapshot = latestRef.current.draftText
    const finalText = rebaseReviewDecisions(beforeSnapshot, stagedProposal.baseText, stagedProposal.items, stagedProposal.rejectedIds)
    const meta = stagedProposal.meta || {}
    const evidenceIds = resolveAcceptedReviewEvidenceIds(stagedProposal.items, stagedProposal.rejectedIds, stagedProposal.evidenceIds)
    setStagedProposal(null)
    onTriggerStagedPlayback?.(null)
    if (!acceptedCount || finalText === beforeSnapshot) return
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(finalText)
    writeLocalDraft(latestRef.current.id, finalText, latestRef.current.baseText, editorOpts)
    setLastAppliedUndo({ before: beforeSnapshot, after: finalText, count: acceptedCount })
    await persistDraftNow({
      text: finalText,
      title: meta.title,
      variant: 'conversation',
      ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
      ...(Array.isArray(evidenceIds) && evidenceIds.length ? { evidenceIds } : {}),
    })
  }, [stagedProposal, persistDraftNow, onTriggerStagedPlayback, editorOpts])

  const discardStagedProposal = React.useCallback(() => {
    if (stagedProposal?.applied) {
      const target = stagedProposal.baseText
      setStagedProposal(null)
      onTriggerStagedPlayback?.(null)
      window.clearTimeout(autoSaveTimerRef.current)
      setDraftText(target)
      writeLocalDraft(latestRef.current.id, target, latestRef.current.baseText, editorOpts)
      void persistDraftNow({ text: target })
      return
    }
    setStagedProposal(null)
    onTriggerStagedPlayback?.(null)
  }, [stagedProposal, onTriggerStagedPlayback, persistDraftNow, editorOpts])

  const replayStagedProposal = React.useCallback(() => {
    if (!stagedProposal || !onTriggerStagedPlayback) return
    const steps = buildUnifiedPlaybackSteps(stagedProposal.baseText, stagedProposal.items, { source: stagedProposal.sourceLabel })
    if (steps.length > 0) {
      onTriggerStagedPlayback({ token: `${stagedProposal.id}:${Date.now()}`, before: stagedProposal.baseText, steps })
    }
  }, [stagedProposal, onTriggerStagedPlayback])

  const undoLastApplied = React.useCallback(() => {
    if (!lastAppliedUndo) return
    const target = lastAppliedUndo.before
    setLastAppliedUndo(null)
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(target)
    writeLocalDraft(latestRef.current.id, target, latestRef.current.baseText, editorOpts)
    if (target !== latestRef.current.baseText) {
      void persistDraftNow({ text: target })
    } else {
      setSaveState('idle')
    }
  }, [lastAppliedUndo, persistDraftNow, editorOpts])

  const jumpToStagedItem = React.useCallback(row => {
    const lines = editorText.split(/\r?\n/u)
    const rejected = stagedProposal?.rejectedIds?.includes(row.id)
    const candidates = [
      (!rejected && row.text) ? stripBulletPrefix(row.text) : '',
      row.source ? stripBulletPrefix(row.source) : '',
    ].filter(Boolean)
    let idx = -1
    for (const targetText of candidates) {
      idx = lines.findIndex(line => stripBulletPrefix(line) === targetText || line === row.text || line === row.source)
      if (idx >= 0) break
    }
    if (idx < 0 && row.section) {
      idx = lines.findIndex(line => line.trim().includes(row.section))
    }
    if (idx < 0) idx = Math.max(0, Math.min(lines.length - 1, row.line ?? 0))
    setHighlightLine({ line: idx, token: Date.now() })
  }, [editorText, stagedProposal?.rejectedIds])

  const previewUnmergedEvidence = React.useCallback(ev => {
    if (hasUnappliedStaged && stagedProposal.items.some(row => Array.isArray(row.evidenceIds) && row.evidenceIds.includes(ev.id))) {
      const alreadyRejected = stagedProposal.items
        .filter(row => Array.isArray(row.evidenceIds) && row.evidenceIds.includes(ev.id) && stagedProposal.rejectedIds.includes(row.id))
        .map(row => row.id)
      if (alreadyRejected.length) {
        setStagedProposal(cur => cur ? { ...cur, rejectedIds: cur.rejectedIds.filter(id => !alreadyRejected.includes(id)) } : cur)
      }
      setStagedOpen(true)
      setPendingOpen(false)
      window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
      return
    }
    const placementBase = hasUnappliedStaged && stagedPreviewText !== null ? stagedPreviewText : editorText
    const placement = suggestEvidencePlacement(placementBase, ev, locale)
    const staged = stageReviewProposal(placement.proposedText, {
      sourceKind: 'evidence',
      sourceLabel: sourceLabel(ev.sourceId, t),
      sourceTitle: ev.title || t('evidence.defaultTitle'),
      evidenceIds: [ev.id],
      changes: [{
        kind: 'add',
        summary: t('resume.evidenceInsertReason', {
          section: placement.sectionLabel,
          title: ev.title || t('evidence.defaultTitle'),
        }),
      }],
    })
    if (staged === 'staged') {
      setPendingOpen(false)
      window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    }
  }, [hasUnappliedStaged, stagedProposal, stagedPreviewText, editorText, locale, stageReviewProposal, t])

  const toggleEvidenceSourcePreview = React.useCallback(async ev => {
    const cur = evidenceSourcePreviews[ev.id]
    if (cur?.open) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { ...cur, open: false } }))
      return
    }
    if (cur?.text || cur?.error) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { ...cur, open: true } }))
      return
    }
    setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: true, text: '', error: '' } }))
    const runner = typeof act?.background === 'function' ? act.background : act
    const reply = await runner('evidence-source', { id: ev.id })
    if (reply?.result?.text) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: false, text: reply.result.text, error: '' } }))
    } else {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: false, text: ev.sourceRef || '', error: reply?.error || '' } }))
    }
  }, [evidenceSourcePreviews, act])

  const handleApplyAiMarkdown = React.useCallback((next, meta = {}) => {
    if (meta?.targetResumeId && meta.targetResumeId !== latestRef.current.id) return
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(next)
    writeLocalDraft(latestRef.current.id, next, latestRef.current.baseText, editorOpts)
    void persistDraftNow({
      text: next,
      title: meta.title,
      variant: 'conversation',
      ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
      ...(Array.isArray(meta.evidenceIds) && meta.evidenceIds.length ? { evidenceIds: meta.evidenceIds } : {}),
    })
  }, [persistDraftNow, editorOpts])

  const pdfSupported = capabilities?.pdfExport === true
  const hasPendingWork = pendingEvidence.length > 0 || unmergedCount > 0
  const effectiveStyle = React.useMemo(
    () => normalizeResumeStyle(styleOverrides, templateChoice),
    [styleOverrides, templateChoice],
  )

  const restoreAppearance = React.useCallback(prev => {
    if (!prev) return
    if (prev.template) selectTemplate(prev.template)
    if (prev.style) {
      setStyleOverrides(prev.style)
      try { writeProfileLocal('local.style', JSON.stringify(prev.style), editorOpts) } catch {}
    }
  }, [selectTemplate, editorOpts])

  const saveDraft = React.useCallback(async () => {
    if (busy) return null
    if (!dirty) {
      if (item.status === 'pending' && item.autoSaved === true) {
        const reply = await act('resume-review', { id: item.id, decision: 'approve' }, t('resume.toastSavedApproved'))
        if (reply?.result?.id) {
          clearLocalDraft(item.id, editorOpts)
          setSaveState('saved')
          return reply.result.id
        }
      }
      return null
    }
    window.clearTimeout(autoSaveTimerRef.current)
    const reply = await act('resume-revise', {
      id: item.id,
      text: draftText,
      approve: true,
      inPlace: item.status === 'pending' && item.autoSaved === true,
    }, t('resume.toastSavedApproved'))
    if (reply?.result?.id) {
      const savedId = reply.result.id
      clearLocalDraft(item.id, editorOpts)
      clearLocalDraft(savedId, editorOpts)
      setSaveState('saved')
      if (savedId !== item.id) {
        autoSavedIdsRef.current.add(savedId)
      }
      onVersion(savedId)
      return savedId
    }
    return null
  }, [dirty, busy, act, item.id, item.status, item.autoSaved, draftText, onVersion, t, editorOpts])

  const exportWithAutoSave = async kind => {
    let targetId = item.id
    if (dirty) {
      targetId = await saveDraft()
      if (!targetId) return
    }
    if (kind === 'pdf') await paperExportRef.current?.downloadPdf(targetId)
    else await paperExportRef.current?.downloadHtml(targetId)
  }

  const confirmVersion = async () => {
    const args = { id: item.id, decision: 'approve' }
    if (hasPartialSelection) args.selected = selectedIndices
    const reply = await act('resume-review', args, hasPartialSelection ? t('resume.toastApprovedSelected') : t('resume.toastApprovedVersion'))
    if (reply?.result?.id && reply.result.id !== item.id) onVersion(reply.result.id)
    else if (reply) agent.dismiss()
  }

  const jumpToChange = row => {
    const lines = editorText.split(/\r?\n/u)
    const stripped = stripBulletPrefix(row.text)
    const idx = lines.findIndex(line => stripBulletPrefix(line) === stripped || line === row.source)
    if (idx >= 0) setHighlightLine({ line: idx, token: Date.now() })
  }

  const jumpToPlacement = placement => {
    const lines = editorText.split(/\r?\n/u)
    const target = stripBulletPrefix(placement?.bullet || '')
    if (!target) return
    const head = target.slice(0, 18)
    const idx = lines.findIndex(line => {
      const clean = stripBulletPrefix(line)
      return clean === target || (head.length >= 6 && clean.includes(head))
    })
    if (idx >= 0) setHighlightLine({ line: idx, token: Date.now() })
  }

  const focusSnippet = React.useCallback(summaryText => {
    const clean = String(summaryText || '').trim()
    if (!clean) return
    const lines = editorText.split(/\r?\n/u)
    const tokens = [...clean.matchAll(/[\u4e00-\u9fff]{2,6}|[a-z0-9._+-]{3,}/giu)]
      .map(m => m[0].toLowerCase())
      .filter(t => !['优化', '调整', '补充', '精简', '更新', '结构', '表述', '简历', '经历', 'the', 'and', 'for', 'with', 'resume', 'update', 'updated', 'refine'].includes(t))
    if (!tokens.length) return
    let bestIdx = -1
    let bestHits = 0
    lines.forEach((line, idx) => {
      const lower = line.toLowerCase()
      const hits = tokens.filter(t => lower.includes(t)).length
      if (hits > bestHits) { bestHits = hits; bestIdx = idx }
    })
    if (bestIdx >= 0) setHighlightLine({ line: bestIdx, token: Date.now() })
  }, [editorText])

  const handleSmartMergeEvidence = React.useCallback(async () => {
    const canUseActiveBase = item.status === 'approved' && !item.opportunityId && item.general !== false && item.kind !== 'tailored'
    const reply = await act(
      'resume-generate',
      canUseActiveBase ? { baseId: item.id } : {},
      result => result?.summary || t('resume.toastMergedDraft'),
    )
    if (reply?.result?.id) { setPendingOpen(false); onVersion(reply.result.id) }
  }, [act, item.id, item.status, item.opportunityId, item.general, item.kind, onVersion, t])

  const rebaseOp = useTrackedOperation(act, 'resume-rebase')
  const [rebaseTargetLabel, setRebaseTargetLabel] = React.useState('')
  const [graphFilter, setGraphFilter] = React.useState('')

  const activeResumeCount = React.useMemo(
    () => resumes.filter(r => !r.archivedAt && (r.status === 'approved' || r.status === 'pending')).length,
    [resumes],
  )
  const archivedResumeCount = React.useMemo(
    () => resumes.filter(isArchivedResume).length,
    [resumes],
  )

  const handleArchiveResume = React.useCallback(async (id, scope = 'version') => {
    const toast = scope === 'older'
      ? t('resume.toastSquashed')
      : t('resume.toastArchived')
    const reply = await act('resume-archive', { id, scope }, toast)
    const archivedIds = Array.isArray(reply?.result?.archivedIds) ? reply.result.archivedIds : []
    if (archivedIds.includes(item.id)) {
      onVersion('')
    }
  }, [act, item.id, onVersion, t])

  const handleRestoreResume = React.useCallback(async (id, scope = 'version') => {
    await act('resume-restore', { id, scope }, t('resume.toastRestored'))
  }, [act, t])

  const handleDeleteArchived = React.useCallback(async id => {
    await act('resume-delete', { id }, t('resume.toastDeletedArchived'))
  }, [act, t])

  const handleRebaseBranch = React.useCallback(async (branchId = item.id) => {
    const targetId = branchId || item.id
    const targetBranch = versionTree.branches.find(b => b.revisions.some(r => r.id === targetId))
    const targetRow = resumes.find(r => r.id === targetId)
    const label = targetBranch?.label || targetRow?.title || t('resume.tailoredResumeDefault')
    setRebaseTargetLabel(label)
    if (targetId && targetId !== item.id) onVersion(targetId)
    const reply = await rebaseOp.run(
      'resume-rebase',
      { id: targetId },
      {
        kind: 'resume-rebase',
        label,
        toast: result => result?.summary || t('resume.toastRebased', { label }),
      },
    )
    if (reply?.result?.id) {
      onVersion(reply.result.id)
      setReviewOpen(true)
    }
  }, [rebaseOp, item.id, versionTree.branches, resumes, onVersion, t])

  const toolbarMeta = saveState === 'saving'
    ? <span className="ca-save-pill is-saving">{t('resume.autoSaving')}</span>
    : saveState === 'error'
      ? <button type="button" className="ca-save-pill is-error" onClick={() => void persistDraftNow()}>{t('resume.autoSaveError')}</button>
      : dirty
        ? <span className="ca-dirty-pill">{t('resume.unsavedShortcut')}</span>
        : (saveState === 'saved' || item.autoSaved)
          ? <span className="ca-save-pill is-saved">{t('resume.autoSaved')}</span>
          : item.evidenceCount > 0
            ? <span>{t('resume.linkedEvidence', { count: item.evidenceCount })}</span>
            : null

  const beforeExport = React.useCallback(
    async targetId => {
      const reply = await act('export', { id: targetId || item.id })
      return typeof reply?.result?.text === 'string' && reply.result.text.length > 0 ? reply.result.text : ''
    },
    [act, item.id],
  )

  return <div className="ca-studio">
    <div className="ca-studio-bar" data-agent-toolbar>
      <div className="ca-studio-bar-left">
        <VersionMenu item={item} resumes={resumes} defaultMasterTrackId={defaultMasterTrackId}
          opportunities={opportunities} timezone={config.timezone}
          disabled={busy === 'resume-optimize' || playback.active} onVersion={onVersion}
          accent={effectiveStyle.accent} font={effectiveStyle.font}
          onDismiss={id => act('resume-review', { id, decision: 'dismiss' }, t('resume.toastDismissedDraft'))}
          onRename={(id, title) => act('resume-rename', { id, title }, t('resume.toastRenamedMaster'))}
          onSetDefault={trackId => act('resume-set-default', { trackId }, t('resume.toastSetDefault'))}
          onBranchMaster={async (id, title) => {
            const reply = await act('resume-branch-master', { id, title }, t('resume.toastBranchedMaster'))
            if (reply?.result?.id) onVersion(reply.result.id)
          }}
          onRebase={handleRebaseBranch}
          onOpenGraph={mode => setGraphFilter(mode || 'all')}
          onArchive={handleArchiveResume} />

        {(currentMasterInSync || isEmptyRebase) && !playback.active && (
          <span className="ca-version-sync-inline" title={isEmptyRebase ? (item.summary || t('resume.masterInSyncTitle')) : t('resume.masterInSyncTitle')}>
            {isEmptyRebase ? t('resume.rebaseAlignedShort') : t('resume.masterInSyncShort')}
          </span>
        )}

        {(activeResumeCount >= 2 || archivedResumeCount > 0) && (
          <button
            type="button"
            className={`ca-graph-trigger-btn${graphFilter ? ' is-open' : ''}`}
            aria-label={t('graph.triggerAria')}
            title={t('graph.triggerTitle')}
            disabled={busy === 'resume-optimize' || playback.active}
            onClick={() => setGraphFilter('all')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="11.5" cy="6.2" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <path d="M4.5 5.3v5.4M11.5 8v1.1c0 1.8-1.4 3.2-3.2 3.2H6.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>
        )}

        <Button variant="ghost" size="sm" icon={<Icon name="plus" size={13} />} disabled={locked} onClick={onOpenImport}>{t('resume.importBtn')}</Button>

        {hasPendingWork && <button type="button" className="ca-studio-work-pill"
          aria-expanded={pendingOpen} onClick={() => setPendingOpen(v => !v)}>
          <i aria-hidden="true" />
          {pendingEvidence.length > 0 ? t('resume.newEvidencePill', { count: pendingEvidence.length }) : t('resume.unmergedPill', { count: unmergedCount })}
        </button>}

        <Button variant="ghost" size="sm" disabled={locked} onClick={onOpenLibrary}>
          {evidenceCountTotal > 0 ? t('resume.libraryBtnCount', { count: evidenceCountTotal }) : t('resume.libraryBtn')}
        </Button>
      </div>

      <div className="ca-studio-bar-right">
        {playback.active ? (
          <ResumePlaybackControls playback={playback} />
        ) : dirty ? <>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => {
            window.clearTimeout(autoSaveTimerRef.current)
            clearLocalDraft(item.id, editorOpts)
            setDraftText(baseText)
            setSaveState('idle')
          }}>{t('resume.discard')}</Button>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={saveDraft}>{t('common.save')}</Button>
          {pdfSupported ? <Button variant="primary" size="sm" disabled={!!busy || !exportState.ready || !!exportState.exporting}
            onClick={() => void exportWithAutoSave('pdf')}>
            {exportState.exporting === 'pdf' ? t('resume.exportingPdf') : t('resume.saveExportPdf')}
          </Button> : <Button variant="primary" size="sm" disabled={!!busy || !exportState.ready || !!exportState.exporting}
            onClick={() => void exportWithAutoSave('html')}>
            {exportState.exporting === 'html' ? t('resume.exporting') : t('resume.saveExport')}
          </Button>}
        </> : item.status === 'pending' ? <>
          <Button variant="ghost" size="sm" disabled={locked}
            onClick={() => {
              clearLocalDraft(item.id, editorOpts)
              void act('resume-review', { id: item.id, decision: 'dismiss' }, t('resume.toastIgnoredDraft'))
            }}>{t('common.dismiss')}</Button>
          <Button variant="primary" size="sm"
            disabled={locked || (hasPartialSelection && !selectedIndices.length)}
            onClick={confirmVersion}>
            {hasPartialSelection ? t('resume.confirmSelected', { selected: selectedIndices.length, total: items.length }) : t('resume.approveVersion')}
          </Button>
        </> : item.status === 'approved' ? (
          pdfSupported ? <>
            <Button variant="ghost" size="sm" disabled={!exportState.ready || !!exportState.exporting}
              onClick={() => paperExportRef.current?.downloadHtml()}>
              {exportState.exporting === 'html' ? t('resume.exporting') : 'HTML'}
            </Button>
            <Button variant="primary" size="sm" disabled={!exportState.ready || !!exportState.exporting}
              onClick={() => paperExportRef.current?.downloadPdf()}>
              {exportState.exporting === 'pdf' ? t('resume.exportingPdf') : t('resume.exportPdf')}
            </Button>
          </> : <Button variant="primary" size="sm" disabled={!exportState.ready || !!exportState.exporting}
            onClick={() => paperExportRef.current?.downloadHtml()}>
            {exportState.exporting === 'html' ? t('resume.exporting') : t('resume.downloadPrint')}
          </Button>
        ) : null}
      </div>
    </div>

    {pendingOpen && hasPendingWork && <div className="ca-pending-tray">
      <div className="ca-pending-tray-head">
        <span>{pendingEvidence.length > 0 ? t('resume.pendingBannerTitle') : t('resume.unmergedBannerTitle', { count: unmergedEvidence.length || unmergedCount })}</span>
        <div className="ca-inline">
          {unmergedCount > 0 && <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void handleSmartMergeEvidence()}>
            {busy === 'resume-generate' ? t('resume.merging') : t('resume.smartMerge', { count: unmergedCount })}
          </Button>}
          <Button variant="ghost" size="sm" onClick={() => setPendingOpen(false)}>{t('common.collapse')}</Button>
        </div>
      </div>
      {pendingEvidence.length > 0 && <div className="ca-pending-tray-list">
        {pendingEvidence.map(ev => <Evidence key={ev.id} item={ev} config={config} busy={busy} act={act}
          onResume={id => { setPendingOpen(false); onVersion(id) }} />)}
      </div>}
      {unmergedEvidence.length > 0 && <div className="ca-pending-tray-list">
        {unmergedEvidence.map(ev => {
          const placement = suggestEvidencePlacement(editorText, ev, locale)
          const srcPreview = evidenceSourcePreviews[ev.id]
          return (
            <article key={ev.id} className="ca-unmerged-ev-card">
              <div className="ca-unmerged-ev-head">
                <div className="ca-inline" style={{ gap: '6px', flexWrap: 'wrap' }}>
                  <strong>{ev.title || t('evidence.defaultTitle')}</strong>
                  <Tag tone="neutral">{sourceLabel(ev.sourceId, t)}</Tag>
                  <Tag tone="info">{t('resume.intendedSectionBadge', { section: placement.sectionLabel })}</Tag>
                </div>
                <span className="ca-meta">{readableDate(ev.occurredAt || ev.createdAt, config.timezone, locale)}</span>
              </div>
              {ev.text && <p className="ca-unmerged-ev-text">{ev.text}</p>}
              {(ev.impact || ev.role) && (
                <div className="ca-unmerged-ev-meta">
                  {ev.role && <span>{t('evidence.role')}: {ev.role}</span>}
                  {ev.impact && <span>{t('evidence.impact')}: {ev.impact}</span>}
                </div>
              )}
              <div className="ca-inline" style={{ marginTop: '8px', gap: '8px', flexWrap: 'wrap' }}>
                <Button variant="outline" size="sm" disabled={locked} onClick={() => previewUnmergedEvidence(ev)}>
                  {t('resume.previewEvidenceInsert')}
                </Button>
                {(ev.sourceId === 'dsh-session' || ev.sourceRef) && (
                  <button type="button" className="ca-text-button" onClick={() => void toggleEvidenceSourcePreview(ev)}>
                    {srcPreview?.open ? t('common.collapse') : t('resume.viewEvidenceSource')}
                  </button>
                )}
              </div>
              {srcPreview?.open && (
                <div className="ca-ev-source-excerpt">
                  {srcPreview.loading
                    ? <span className="ca-meta">{t('common.processingEllipsis')}</span>
                    : srcPreview.text
                      ? <p className="ca-preline">{srcPreview.text}</p>
                      : <span className="ca-meta">{srcPreview.error || t('resume.noSourceExcerpt')}</span>}
                </div>
              )}
            </article>
          )
        })}
      </div>}
    </div>}

    <div className="ca-narrow-switcher" role="tablist" aria-label={t('resume.switchPaneAria')}>
      <button type="button" role="tab" aria-selected={mobilePane === 'edit'} onClick={() => setMobilePane('edit')}>{t('resume.editBody')}</button>
      <button type="button" role="tab" aria-selected={mobilePane === 'preview'} onClick={() => setMobilePane('preview')}>
        {t('resume.layoutPreview')}{activeTemplate ? ` · ${activeTemplate.label}` : ''}
      </button>
    </div>

    <div className="ca-studio-split" data-mobile-pane={mobilePane} data-agent-paper>
      <div className="ca-studio-left">
        <div className="ca-studio-left-scroll" data-editor-scroll>
          <AgentTailorBanner activity={agent.activity} onDismiss={agent.dismiss} />
          {rebaseOp.activity && rebaseOp.activity.phase !== 'ready' && (
            <AiTraceCard
              compact
              activity={rebaseOp.activity}
              title={rebaseOp.activity.phase === 'error'
                ? t('resume.rebaseFailed')
                : t('resume.rebasingBranch', { label: rebaseTargetLabel || currentBranchRev?.title || t('version.tailoredBranches') })}
              onDismiss={rebaseOp.dismiss}
            />
          )}
          {currentMasterHasDiff && !playback.active && !rebaseOp.running && (
            <div className="ca-rebase-banner" role="status">
              <div className="ca-rebase-copy">
                <i className="ca-rebase-dot" aria-hidden="true" />
                <strong>{t('resume.masterUpdatedTitle', { version: currentBranchRev?.masterLatestVersion })}</strong>
              </div>
              <Button variant="outline" size="sm" disabled={!!busy || rebaseOp.running} onClick={() => void handleRebaseBranch(item.id)}>
                {rebaseOp.running ? t('resume.syncing') : t('version.syncMaster')}
              </Button>
            </div>
          )}
          {lastAppliedUndo && !stagedProposal && !playback.active && (
            <div className="ca-rebase-banner" role="status">
              <div className="ca-rebase-copy">
                <strong>{t('resume.appliedUndoBanner', { count: lastAppliedUndo.count })}</strong>
              </div>
              <div className="ca-inline">
                <Button variant="outline" size="sm" onClick={undoLastApplied}>{t('resume.undoApplied')}</Button>
                <button type="button" className="ca-text-button" onClick={() => setLastAppliedUndo(null)}>{t('common.close')}</button>
              </div>
            </div>
          )}
          {stagedProposal && !playback.active && (() => {
            const totalCount = stagedProposal.items.length
            const selectedCount = totalCount - stagedProposal.rejectedIds.length
            const isSingle = totalCount === 1
            const isEvidence = stagedProposal.sourceKind === 'evidence'
            const showBatchControls = stagedProposal.applied || !isSingle
            const primaryCommitLabel = selectedCount === 0
              ? t('resume.noEditsSelected')
              : isSingle
                ? (isEvidence ? t('resume.insertIntoResume') : t('resume.applySingleEdit'))
                : selectedCount === totalCount
                  ? (isEvidence ? t('resume.insertAllCount', { count: totalCount }) : t('resume.applyAllCount', { count: totalCount }))
                  : (isEvidence ? t('resume.insertSelectedCount', { count: selectedCount }) : t('resume.applySelectedShort', { count: selectedCount }))
            const footHint = isSingle
              ? t('resume.stagedSingleHint')
              : selectedCount === 0
                ? t('resume.stagedNoneHint')
                : t('resume.stagedMultiHint', { selected: selectedCount, total: totalCount })
            return <section ref={reviewCardRef} className={`ca-review-card${stagedOpen ? ' is-open' : ''}`} data-surface="unified-review">
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={stagedOpen}
                onClick={() => setStagedOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {isEvidence
                    ? t('resume.stagedEvidenceTitle')
                    : stagedProposal.applied
                      ? t('resume.appliedChatTitle')
                      : t('resume.stagedChatTitle')}
                </span>
                {showBatchControls && (
                  <Tag tone={stagedProposal.applied ? 'success' : 'info'}>
                    {t('resume.selectedEdits', {
                      selected: selectedCount,
                      total: totalCount,
                    })}
                  </Tag>
                )}
                {stagedProposal.sourceLabel && <Tag tone="neutral">{stagedProposal.sourceLabel}</Tag>}
              </button>
              <div className="ca-inline" style={{ flexWrap: 'nowrap', flexShrink: 0 }}>
                <Button variant="ghost" size="sm" icon={<Icon name="play" size={11} />} onClick={replayStagedProposal}>{t('resume.replay')}</Button>
                {stagedProposal.applied ? <>
                  <button type="button" className="ca-text-button" onClick={discardStagedProposal}>{t('agent.undoStep')}</button>
                  <button type="button" className="ca-text-button" onClick={() => setStagedProposal(null)}>{t('common.close')}</button>
                </> : (!isSingle && (
                  <button type="button" className="ca-text-button" onClick={() => setStagedProposal(cur => cur ? {
                    ...cur,
                    rejectedIds: cur.rejectedIds.length > 0 ? [] : cur.items.map(it => it.id),
                  } : cur)}>
                    {stagedProposal.rejectedIds.length > 0 ? t('resume.includeAllEdits') : t('resume.skipAllEdits')}
                  </button>
                ))}
              </div>
            </div>

            <div className="ca-review-collapse" aria-hidden={!stagedOpen}>
              <div className="ca-review-collapse-inner">
                <div className="ca-review-list">
                  {stagedProposal.items.map((row, index) => {
                    const kept = !stagedProposal.rejectedIds.includes(row.id)
                    const multiSource = new Set(stagedProposal.items.map(it => it.sourceLabel).filter(Boolean)).size > 1
                    const kindLabel = row.kind === 'insert'
                      ? t('agent.changeAdd')
                      : row.kind === 'delete'
                        ? t('agent.changeDelete')
                        : t('agent.changeEdit')
                    return <div className="ca-ed-row" key={row.id}
                      data-staged-change={index} data-excluded={!kept || undefined}
                      onClick={() => jumpToStagedItem(row)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head">
                          <span className={`ca-ed-kind${row.kind === 'insert' ? ' is-add' : row.kind === 'delete' ? ' is-del' : ' is-edit'}`}>{kindLabel}</span>
                          {row.section && <span className="ca-ed-kind is-section" title={row.section}>{row.section}</span>}
                          {multiSource && row.sourceLabel && <span className="ca-ed-kind is-section" title={row.sourceLabel}>{row.sourceLabel}</span>}
                          {row.reason && <span className="ca-ed-reason">{row.reason}</span>}
                          {showBatchControls && (
                            <button type="button"
                              className={`ca-ed-toggle${stagedProposal.applied ? ' is-applied-revert' : ''}${kept ? ' is-kept' : ''}`}
                              aria-pressed={kept}
                              disabled={locked}
                              onClick={event => {
                                event.stopPropagation()
                                toggleStagedItem(row.id)
                              }}>
                              {stagedProposal.applied
                                ? (kept ? t('resume.revertLineBtn') : t('resume.reapplyLineBtn'))
                                : (kept ? <>✓ {t('resume.includeEditPill')}</> : t('resume.skippedEditPill'))}
                            </button>
                          )}
                        </div>
                        {row.kind === 'edit' ? (
                          <EditorialDiff source={row.source} text={row.text} kept={kept} rank={index + 1} promoted={false} />
                        ) : row.kind === 'insert' ? (
                          <div className={`ca-ed-card${!kept ? ' is-rejected' : ''}`}>
                            <p className="ca-ed-main">
                              {kept
                                ? <mark className="ca-ed-mark">{stripMarkdownInline(stripBulletPrefix(row.text))}</mark>
                                : stripMarkdownInline(stripBulletPrefix(row.text))}
                            </p>
                            <span className="ca-ed-note">{kept ? t('resume.addedLineNote') : t('resume.skippedInsertNote')}</span>
                          </div>
                        ) : (
                          <div className={`ca-ed-card${!kept ? ' is-rejected' : ''}`}>
                            <p className="ca-ed-main">
                              {kept
                                ? <del className="ca-ed-del">{stripMarkdownInline(stripBulletPrefix(row.source))}</del>
                                : stripMarkdownInline(stripBulletPrefix(row.source))}
                            </p>
                            <span className="ca-ed-note">{kept ? t('resume.removedLineNote') : t('resume.keptOriginalNote')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  })}
                </div>
                {!stagedProposal.applied && (
                  <div className="ca-review-staged-foot">
                    <span className="ca-review-staged-foot-hint">{footHint}</span>
                    <div className="ca-review-staged-foot-actions">
                      <Button variant="ghost" size="sm" onClick={discardStagedProposal}>{t('resume.discardProposal')}</Button>
                      <Button variant="primary" size="sm" disabled={!!busy || selectedCount === 0} onClick={() => void applyStagedProposal()}>
                        {primaryCommitLabel}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
          })()}
          {hasMergeSummary && !playback.active && <section className={`ca-review-card${reviewOpen ? ' is-open' : ''}`}>
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={reviewOpen}
                onClick={() => setReviewOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {item.origin === 'rebase' ? t('resume.rebaseSummary') : t('resume.mergeSummary')}
                </span>
                <Tag tone={item.status === 'pending' ? 'info' : 'neutral'}>
                  {mergePlacements.length ? t('resume.placementsCount', { count: mergePlacements.length }) : t('resume.merged')}
                </Tag>
                {item.summary && !reviewOpen && <span className="ca-review-bar-sub">{item.summary}</span>}
              </button>
            </div>

            <div className="ca-review-collapse" aria-hidden={!reviewOpen}>
              <div className="ca-review-collapse-inner">
                {item.summary && <p className="ca-change-summary">{item.summary}</p>}
                {mergePlacements.length > 0 && <div className="ca-review-list">
                  {mergePlacements.map((pl, index) => (
                    <div className="ca-ed-row" key={`${pl.evidenceId || index}-${index}`} onClick={() => jumpToPlacement(pl)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head is-wrap">
                          {pl.section && <span className="ca-ed-kind is-edit is-section" title={pl.section}>{pl.section}</span>}
                          {pl.reason && <span className="ca-ed-reason">{pl.reason}</span>}
                        </div>
                        {pl.bullet && <p className="ca-ed-merge-bullet">{String(pl.bullet).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\*+(?!\s)/, '')}</p>}
                      </div>
                    </div>
                  ))}
                </div>}
              </div>
            </div>
          </section>}
          {isReviewable && !playback.active && <section className={`ca-review-card${reviewOpen ? ' is-open' : ''}`}>
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={reviewOpen}
                onClick={() => setReviewOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {item.variant === 'conversation' ? t('resume.reviewEdits') : t('resume.tailorSummary')}
                </span>
                <Tag tone={canSelectChanges ? 'info' : 'neutral'}>
                  {canSelectChanges ? t('resume.selectedEdits', { selected: selectedIndices.length, total: items.length }) : t('resume.optimizationsCount', { count: items.length })}
                </Tag>
                {item.gaps && !reviewOpen && <span className="ca-review-bar-sub">{t('resume.hasGapsHint')}</span>}
              </button>
              <div className="ca-inline">
                {canSelectChanges && (
                  <button type="button" className="ca-text-button" onClick={() => setExcluded(excluded.length > 0 ? [] : items.map((_, i) => i))}>
                    {excluded.length > 0 ? t('resume.selectAllEdits') : t('resume.keepAllOriginal')}
                  </button>
                )}
                {onReplay && <Button variant="ghost" size="sm" icon={<Icon name="play" size={11} />}
                  onClick={onReplay}>{t('resume.replay')}</Button>}
              </div>
            </div>

            <div className="ca-review-collapse" aria-hidden={!reviewOpen}>
              <div className="ca-review-collapse-inner">
                {item.summary && <p className="ca-change-summary">{item.summary}</p>}

                <div className="ca-review-list">
                  {items.map((row, index) => {
                    const kept = !excluded.includes(index)
                    const promoted = row.promote === true || item.variant !== 'conversation'
                    const textChanged = stripBulletPrefix(row.source) !== stripBulletPrefix(row.text)
                    const changeKind = promoted && textChanged ? t('resume.changePromotedEdited') : promoted ? t('resume.changePromoted') : t('resume.changeEdited')
                    const rank = index + 1
                    return <div className="ca-ed-row" key={index}
                      data-agent-change={index} data-excluded={!kept || undefined}
                      onClick={() => jumpToChange(row)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(rank).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head">
                          <span className={`ca-ed-kind${textChanged ? ' is-edit' : ''}`}>{changeKind}</span>
                          {row.reason && <span className="ca-ed-reason">{row.reason}</span>}
                          {canSelectChanges && <button type="button"
                            className={`ca-ed-toggle${kept ? ' is-kept' : ''}`}
                            aria-pressed={kept}
                            disabled={locked}
                            onClick={event => {
                              event.stopPropagation()
                              setExcluded(kept ? [...excluded, index] : excluded.filter(v => v !== index))
                            }}>
                            {kept ? t('resume.kept') : t('resume.keepOriginal')}
                          </button>}
                        </div>
                        <EditorialDiff source={row.source} text={row.text} kept={kept} rank={rank} promoted={promoted} />
                      </div>
                    </div>
                  })}
                </div>

                <GapsPanel gaps={item.gaps} onPickGap={prompt => setLocalSeedPrompt(prompt)} />
              </div>
            </div>
          </section>}

          <div className="ca-editor-host">
            {playback.active && requiresMarkdownSource(editorText)
              ? <ResumeLines text={editorText} />
              : <LocalRichEditor
                ariaLabel={playback.active ? t('editor.lineByLineAria') : t('editor.ariaLabel')}
                text={editorText}
                disabled={!editable || locked}
                playing={playback.active}
                showToolbar={!playback.active}
                toolbarMeta={toolbarMeta}
                highlightLine={highlightLine}
                onChange={next => {
                  if (!playback.active) {
                    if (next === editorText) return
                    if (stagedProposal?.applied) {
                      setStagedProposal(null)
                    }
                    setDraftText(next)
                    scheduleAutoSave(next)
                  }
                }}
                onSaveShortcut={saveDraft}
                onUserInteract={() => {
                  if (playback.active && !playback.paused) playback.pause()
                }}
                onEditorReady={onEditorReady}
              />}
          </div>
        </div>

        {editable && <FloatingResumeCommandBar
          resumeId={item.id}
          resumeVersion={`${item.id}:${item.updatedAt || item.createdAt || ''}:${item.versionTag || ''}:${baseText.length}`}
          readyForEffects={syncedResumeId === item.id && prevIdRef.current === item.id}
          markdown={editorText}
          template={templateChoice}
          effectiveStyle={effectiveStyle}
          opportunities={opportunities}
          templates={templates}
          config={config}
          busy={busy}
          disabled={playback.active}
          unmergedCount={unmergedCount}
          masterBehind={currentMasterHasDiff && !rebaseOp.running}
          onMergeEvidence={unmergedCount > 0 ? handleSmartMergeEvidence : undefined}
          onRebaseBranch={(currentMasterHasDiff && !rebaseOp.running) ? () => handleRebaseBranch(item.id) : undefined}
          onFocusSnippet={focusSnippet}
          onApplyMarkdown={handleApplyAiMarkdown}
          onStageProposal={stageReviewProposal}
          hasStagedProposal={Boolean(stagedProposal)}
          onFocusReview={() => {
            setStagedOpen(true)
            window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
          }}
          onApplyStyleDirective={applyStyleDirective}
          onRestoreAppearance={restoreAppearance}
          seedPrompt={localSeedPrompt || seedPrompt}
          onConsumeSeedPrompt={() => { setLocalSeedPrompt(''); onConsumeSeedPrompt?.() }}
        />}
      </div>

      <div className="ca-studio-right">
        <LocalTemplatePaper
          title={item.title}
          text={previewText}
          previewingUnapplied={hasUnappliedStaged}
          templates={templates}
          template={templateChoice}
          onSelectTemplate={selectTemplate}
          styleOverrides={styleOverrides}
          onStyleChange={updateStyle}
          onStyleReset={resetStyle}
          playing={playback.active}
          resumeId={item.id}
          pdfSupported={pdfSupported}
          retainedHtml={retainedPreviewRef.current}
          onRenderHtml={html => { retainedPreviewRef.current = html }}
          externalExportRef={paperExportRef}
          onExportState={setExportState}
          beforeExport={beforeExport}
        />
      </div>
    </div>

    {graphFilter && (
      <ResumeGraphModal
        resumes={resumes}
        defaultMasterTrackId={defaultMasterTrackId}
        opportunities={opportunities}
        currentId={item.id}
        timezone={config.timezone}
        template={templateChoice}
        style={effectiveStyle}
        initialFilter={graphFilter}
        busy={busy}
        onSelectVersion={id => onVersion(id)}
        onBranchMaster={async (id, title) => {
          const reply = await act('resume-branch-master', { id, title }, t('resume.toastBranchedMaster'))
          if (reply?.result?.id) onVersion(reply.result.id)
        }}
        onSetDefault={trackId => act('resume-set-default', { trackId }, t('resume.toastSetDefault'))}
        onRebase={handleRebaseBranch}
        onArchive={handleArchiveResume}
        onRestore={handleRestoreResume}
        onDeleteArchived={handleDeleteArchived}
        onClose={() => setGraphFilter('')}
      />
    )}
  </div>
}

function OnboardingModelCard({ config, busy, act }) {
  const { t } = useI18n()
  const models = useModels()
  const mainModel = config?.model || ''
  const reasoningEffort = config?.reasoningEffort || ''
  const defaultSystemRow = resolveDefaultModelRow(models.rows)
  const effectiveMainRow = (mainModel ? models.rows.find(r => r.route === mainModel) : null) ?? defaultSystemRow
  const mainDefaultOpt = React.useMemo(() => ({
    route: '',
    name: t('sources.modelFollowDsh'),
    provider: defaultSystemRow ? t('sources.modelCurrent', { name: defaultSystemRow.name }) : t('sources.modelAuto'),
  }), [defaultSystemRow, t])

  const changeModel = nextRoute => {
    if (busy || nextRoute === mainModel) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const chosen = nextRoute ? models.rows.find(r => r.route === nextRoute) : defaultSystemRow
    const nextEfforts = chosen?.reasoning?.efforts ?? []
    const keepEffort = !reasoningEffort || nextEfforts.some(e => e.id === reasoningEffort)
    const tabEffort = config?.tabReasoningEffort || ''
    const keepTabEffort = Boolean(config?.tabModel) || !tabEffort || nextEfforts.some(e => e.id === tabEffort)
    void runner(
      'configure',
      {
        config: {
          model: nextRoute,
          ...(keepEffort ? {} : { reasoningEffort: '' }),
          ...(keepTabEffort ? {} : { tabReasoningEffort: '' }),
        },
      },
      nextRoute
        ? t('sources.toastMainModelSet', { name: chosen?.name || nextRoute })
        : t('sources.toastMainModelFollow'),
    )
  }

  const changeReasoning = nextEffort => {
    if (busy || nextEffort === reasoningEffort) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const chosen = effectiveMainRow?.reasoning?.efforts?.find(e => e.id === nextEffort)
    void runner(
      'configure',
      { config: { reasoningEffort: nextEffort } },
      nextEffort
        ? t('sources.toastReasoningSet', { name: chosen?.name || nextEffort })
        : t('sources.toastReasoningReset'),
    )
  }

  return <section className="ca-onboarding-model-card" data-surface="onboarding-model" aria-label={t('resume.onboardingModelTitle')}>
    <div className="ca-onboarding-model-label">
      <strong>{t('resume.onboardingModelTitle')}</strong>
      <span className="ca-info-tip" tabIndex={0} role="note" aria-label={t('resume.onboardingModelNote')}>
        <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7.3v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
        </svg>
        <span className="ca-info-tip-pop is-down" role="tooltip">
          {t('resume.onboardingModelNote')}
        </span>
      </span>
    </div>
    <div className="ca-onboarding-model-picker">
      <div className="ca-model-select-pair">
        <ModelSelectMenu
          value={mainModel}
          rows={models.rows}
          pending={models.pending}
          disabled={!!busy}
          defaultOption={mainDefaultOpt}
          ariaLabel={t('sources.mainModelAria')}
          placement="down"
          onChange={changeModel}
        />
        <ReasoningEffortMenu
          value={reasoningEffort}
          reasoning={effectiveMainRow?.reasoning}
          disabled={!!busy}
          placement="down"
          onChange={changeReasoning}
        />
      </div>
    </div>
  </section>
}

function Resume({ state, busy, act, silentAct, initialId, onSources, retainedPreviewRef, seedPrompt, onConsumeSeedPrompt, pendingTailor, onConsumeTailor, returnJob, onReturnToJob, onDismissReturnJob }) {
  const { t, locale } = useI18n()
  const [sheet, setSheet] = React.useState('')
  const resumeProfileKey = state.profileKey || getActiveProfileKey()
  const [selected, setSelectedState] = React.useState(() => {
    if (initialId) return initialId
    return readProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey }) || ''
  })
  React.useEffect(() => {
    if (!initialId) setSelectedState(readProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey }) || '')
  }, [resumeProfileKey, initialId])
  const setSelected = React.useCallback(id => {
    const next = id || ''
    setSelectedState(next)
    if (next) writeProfileLocal(SELECTED_RESUME_KEY, next, { profileKey: resumeProfileKey })
    else removeProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey })
    if (next && returnJob?.id) {
      const targetRow = list(state.resumes).find(r => r.id === next)
      if (targetRow?.opportunityId && targetRow.opportunityId !== returnJob.id) {
        onDismissReturnJob?.()
      }
    }
  }, [returnJob?.id, state.resumes, onDismissReturnJob, resumeProfileKey])
  const [replaySeed, setReplaySeed] = React.useState(0)
  const [stagedPlayback, setStagedPlayback] = React.useState(null)
  const [agentDraftSeed, setAgentDraftSeed] = React.useState('')
  const canvas = React.useRef(null)
  const richEditor = React.useRef(null)
  const fallbackPreviewRef = React.useRef(null)
  const previewCacheRef = retainedPreviewRef ?? fallbackPreviewRef
  const onEditorReady = React.useCallback(editor => { richEditor.current = editor }, [])
  const agent = useResumeAgent(act, id => setSelected(id))
  const tailorTriggeredRef = React.useRef(0)

  React.useEffect(() => {
    if (initialId) setSelected(initialId)
  }, [initialId, setSelected])

  React.useEffect(() => {
    if (!pendingTailor?.id || pendingTailor.nonce === tailorTriggeredRef.current) return
    tailorTriggeredRef.current = pendingTailor.nonce
    const { id, label } = pendingTailor
    onConsumeTailor?.()
    void agent.tailor({ id, label })
  }, [pendingTailor, onConsumeTailor, agent])

  const evidence = list(state.evidence)
  const resumes = list(state.resumes)
  const reflections = list(state.reflections)
  const activeResumes = resumes.filter(row => !row.archivedAt && row.status !== 'revoked' && row.status !== 'rejected')
  // Default to the latest approved version unless a strictly newer pending draft exists.
  const latestApproved = activeResumes.findLast(row => row.status === 'approved')
  const latestOverall = activeResumes.at(-1)
  const defaultResume = latestOverall?.status === 'pending' && (!latestApproved || Date.parse(latestOverall.createdAt || '') > Date.parse(latestApproved.createdAt || ''))
    ? latestOverall
    : (latestApproved ?? latestOverall)
  const current = activeResumes.find(row => row.id === selected) ?? defaultResume

  React.useEffect(() => {
    if (current?.id) {
      writeProfileLocal(SELECTED_RESUME_KEY, current.id, { profileKey: resumeProfileKey })
    }
  }, [current?.id, resumeProfileKey])

  const activeSources = list(state.config?.sources)
  const isSourceUsable = item => {
    const entry = activeSources.find(s => s.id === item.sourceId)
    if (entry?.revokedAt) return false
    if (entry && (entry.projects?.includes('*') || entry.projects?.includes(item.projectId))) return true
    return item.sourceId === 'manual' && !entry
  }
  const pendingEvidence = evidence.filter(item => item.status === 'pending').toReversed()
  const shareableEvidence = evidence.filter(item => item.status === 'approved' && item.shareable && isSourceUsable(item))
  const resumeTree = React.useMemo(
    () => organizeResumeVersions(resumes, { defaultMasterTrackId: state.defaultMasterTrackId || '', opportunities: list(state.opportunities) }),
    [resumes, state.defaultMasterTrackId, state.opportunities],
  )
  const isViewingApprovedMaster = Boolean(current && current.status === 'approved' && !current.opportunityId && current.general !== false && current.kind !== 'tailored')
  const defaultMasterNode = resumeTree.masters.find(m => m.isDefault) ?? resumeTree.masters[0] ?? null
  const targetMasterForMerge = isViewingApprovedMaster
    ? current
    : (defaultMasterNode?.latestApproved ?? defaultMasterNode?.latest ?? activeResumes.findLast(row => !row.opportunityId && row.general !== false))
  const mergedEvidenceIds = new Set(Array.isArray(targetMasterForMerge?.evidenceIds) ? targetMasterForMerge.evidenceIds : [])
  const unmergedEvidence = shareableEvidence.filter(item => !mergedEvidenceIds.has(item.id)).toReversed()
  const unmergedCount = unmergedEvidence.length
  const hasSources = (state.config?.sources?.length > 0) || state.recordings?.sources?.some(row => row.enabled)

  const tailoredPlaybackToken = agent.activity?.phase === 'ready' && current?.id === agent.activity.version
    ? `${agent.activity.id}:${replaySeed}`
    : replaySeed > 0 && current?.kind === 'tailored' ? `replay:${current.id}:${replaySeed}` : null
  const parent = tailoredPlaybackToken && current?.baseId ? resumes.find(row => row.id === current.baseId) : null
  const tailoredBefore = parent ? displayResume(parent, resumes) : ''
  const tailoredSteps = React.useMemo(() => tailoredPlaybackToken && tailoredBefore && current ? buildResumePlayback({
    before: tailoredBefore,
    after: displayResume(current, resumes),
    items: current.items,
    variant: current.variant,
    locale,
    source: current.kind === 'tailored' ? t('resume.sourceJdTailorLabel') : '',
  }) : [], [tailoredPlaybackToken, tailoredBefore, current, resumes, locale, t])

  const activePlaybackToken = stagedPlayback?.token || tailoredPlaybackToken
  const activePlaybackBefore = stagedPlayback?.token ? stagedPlayback.before : tailoredBefore
  const activePlaybackSteps = stagedPlayback?.token ? stagedPlayback.steps : tailoredSteps
  const playback = useResumePlayback({
    token: activePlaybackToken,
    before: activePlaybackBefore,
    steps: activePlaybackSteps,
    canvasRef: canvas,
    resolveAnchor: ({ line }) => resolveRichEditorLine(richEditor.current, playback.text ?? activePlaybackBefore, line),
  })

  const createBlankResume = async ({ withAgent = false } = {}) => {
    if (busy) return
    const md = buildBlankResumeMarkdown(locale)
    const reply = await act('resume-import', { title: t('resume.blankResumeTitle'), text: md }, t('resume.toastBlankCreated'))
    if (reply?.result?.id) {
      await act('resume-review', { id: reply.result.id, decision: 'approve' })
      if (withAgent) setAgentDraftSeed(t('resume.agentDraftStarterPrompt'))
      setSelected(reply.result.id)
    }
  }

  if (!current) {
    return <div className="ca-width ca-content">
      <AgentTailorBanner activity={agent.activity} onDismiss={agent.dismiss} />
      <section className="ca-resume-onboarding" data-surface="resume-onboarding">
        <OnboardingModelCard config={state.config} busy={busy} act={act} />
        <div className="ca-resume-onboarding-head is-split">
          <h2>{t('resume.emptyTitle')}</h2>
          <div className="ca-inline">
            {shareableEvidence.length > 0 && (
              <Button variant="primary" size="sm" disabled={!!busy} onClick={async () => {
                const reply = await act('resume-generate', {}, t('resume.toastGenerated'))
                if (reply?.result?.id) setSelected(reply.result.id)
              }}>{t('resume.generateFromEvidence', { count: shareableEvidence.length })}</Button>
            )}
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void createBlankResume({ withAgent: true })}>
              {t('resume.onboardingChatTitle')}
            </Button>
            <button type="button" className="ca-text-button ca-nowrap-btn" disabled={!!busy} onClick={() => void createBlankResume()}>
              {t('resume.skipToBlankEditor')}
            </button>
          </div>
        </div>
        <div className="ca-formbox">
          <ResumeForm busy={busy} act={act} onDone={id => setSelected(id)} />
        </div>
      </section>
    </div>
  }

  return <div className="ca-resume-canvas" ref={canvas}>
    {returnJob && (
      <div className="ca-return-job-bar" role="region" aria-label={t('resume.returnJobAria')}>
        <button type="button" className="ca-return-job-btn" onClick={onReturnToJob}>
          <span className="ca-return-job-arrow" aria-hidden="true">←</span>
          <span>{t('resume.returnJob')}</span>
          <CompanyAvatar company={returnJob.company} url={returnJob.url} size={18} />
          <strong className="ca-return-job-title">{[returnJob.company, returnJob.title].filter(Boolean).join(' · ')}</strong>
        </button>
        <button type="button" className="ca-return-job-close" aria-label={t('resume.hideReturnJobAria')} onClick={onDismissReturnJob}>×</button>
      </div>
    )}
    <ResumePlaybackCursor playback={playback} />
    <ResumeWorkbench
      item={current}
      resumes={resumes}
      defaultMasterTrackId={state.defaultMasterTrackId || ''}
      profileKey={resumeProfileKey}
      templates={list(state.resumeTemplates)}
      opportunities={list(state.opportunities)}
      config={state.config}
      capabilities={state.capabilities}
      act={act}
      silentAct={silentAct}
      busy={busy}
      onVersion={id => {
        agent.dismiss()
        setReplaySeed(0)
        setStagedPlayback(null)
        setSelected(id)
      }}
      agent={agent}
      playback={playback}
      onReplay={current.kind === 'tailored' && current.baseId ? () => { setStagedPlayback(null); setReplaySeed(v => v + 1) } : null}
      onTriggerStagedPlayback={setStagedPlayback}
      onEditorReady={onEditorReady}
      retainedPreviewRef={previewCacheRef}
      onOpenImport={() => setSheet('import')}
      onOpenLibrary={() => setSheet('library')}
      evidenceCountTotal={evidence.filter(e => ['pending', 'approved'].includes(e.status)).length + reflections.filter(r => ['pending', 'approved'].includes(r.status)).length}
      pendingEvidence={pendingEvidence}
      unmergedCount={unmergedCount}
      unmergedEvidence={unmergedEvidence}
      hasSources={hasSources}
      onSources={onSources}
      seedPrompt={agentDraftSeed || seedPrompt}
      onConsumeSeedPrompt={() => { setAgentDraftSeed(''); onConsumeSeedPrompt?.() }}
    />
    {sheet === 'import' && <SideSheet title={t('resume.importSheetTitle')} onClose={() => setSheet('')}>
      {({ dismiss }) => <div className="ca-sheet-body">
        <ResumeForm busy={busy} act={act} onDone={id => { setSelected(id); dismiss() }} />
      </div>}
    </SideSheet>}
    {sheet === 'library' && <LibrarySheet evidence={evidence} reflections={reflections}
      state={state} config={state.config} busy={busy} act={act}
      onResume={id => setSelected(id)} onSources={onSources} onClose={() => setSheet('')} />}
  </div>
}

const BADGE_TONES = ['blue', 'indigo', 'teal', 'amber', 'rose', 'slate']

function companyTone(name = '') {
  let sum = 0
  for (let i = 0; i < name.length; i += 1) sum = (sum * 31 + name.charCodeAt(i)) % 997
  return BADGE_TONES[sum % BADGE_TONES.length]
}

function latestJobSummary(item, timezone, t, locale) {
  const receipts = list(item.receipts ?? item.history)
  if (!receipts.length) return ''
  const ordered = [...receipts].sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''))
  const top = ordered[0]
  const customNote = String(top.notes || '').trim()
  if (top.type === 'interview_confirmed' && top.startsAt) {
    return `${t('jobs.summaryInterview', { round: top.round || t('jobs.defaultInterview'), time: readableDate(top.startsAt, timezone, locale) })}${top.location ? ` · ${top.location}` : ''}`
  }
  if (top.type === 'offer_received') {
    const formLabel = top.form === 'written' ? t('followups.writtenOffer') : top.form === 'verbal' ? t('followups.verbalOffer') : ''
    if (top.replyBy) return t('jobs.summaryOfferDeadline', { form: formLabel || 'Offer', time: readableDate(top.replyBy, timezone, locale) })
    return [formLabel, customNote].filter(Boolean).join(' · ')
  }
  if (top.type === 'interview_invited' || top.type === 'interview_completed') {
    return [top.round, customNote].filter(Boolean).join(' · ')
  }
  if ((top.type === 'application_submitted' || top.type === 'resume_sent') && String(top.material || '').trim()) {
    const mat = t('jobs.summaryMaterial', { material: String(top.material).trim() })
    return customNote ? `${mat} · ${customNote}` : mat
  }
  return customNote
}

const MATCH_ACRONYMS = {
  ai: 'AI', llm: 'LLM', gpu: 'GPU', cuda: 'CUDA', rag: 'RAG', k8s: 'K8s', sre: 'SRE',
  ml: 'ML', nlp: 'NLP', rlhf: 'RLHF', devops: 'DevOps', infra: 'Infra',
  infrastructure: 'Infrastructure', agent: 'Agent', remote: 'Remote', platform: 'Platform',
}

function prettyMatchLabel(raw, searchTerms = []) {
  const clean = String(raw || '').trim()
  if (!clean) return ''
  const lower = clean.toLowerCase()
  const exact = searchTerms.find(t => String(t || '').trim().toLowerCase() === lower)
  if (exact && /[A-Z]/.test(exact)) return exact.trim()
  if (/[A-Z]/.test(clean)) return clean
  return clean.split(/\s+/).map(word => MATCH_ACRONYMS[word.toLowerCase()] || word).join(' ')
}

function formatMatchChips(rawMatches, searchTerms = []) {
  const labeled = []
  const seen = new Set()
  for (const m of rawMatches) {
    const label = prettyMatchLabel(m, searchTerms)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    labeled.push(label)
  }
  // Drop redundant shorter tokens already covered by a longer matched phrase (e.g. "AI" when "AI Infra" matched)
  const sortedByLen = [...labeled].sort((a, b) => b.length - a.length)
  const kept = new Set()
  for (const item of sortedByLen) {
    const lower = item.toLowerCase()
    const covered = [...kept].some(longer => {
      const l = longer.toLowerCase()
      if (l === lower) return true
      if (/^[a-z0-9]+$/i.test(lower)) {
        return new RegExp(`(?:^|[^a-z0-9])${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(l)
      }
      return l.includes(lower)
    })
    if (!covered) kept.add(item)
  }
  return labeled.filter(item => kept.has(item))
}

function nextStepHintForStage(stage, t) {
  switch (stage) {
    case 'contacted':
    case 'resume_sent':
    case 'submitted':
    case 'acknowledged':
      return t('jobs.nextStepSubmitted')
    case 'invited':
      return t('jobs.nextStepInvited')
    case 'interview_confirmed':
      return t('jobs.nextStepInterviewConfirmed')
    case 'interview_completed':
      return t('jobs.nextStepInterviewCompleted')
    case 'offer_received':
      return t('jobs.nextStepOffer')
    default:
      return ''
  }
}

function JobCard({ item, config, personalSync, activeOperations = null, basisResume = null, aiReason = '', act, busy, onSelect, onResume, onTailorJob }) {
  const { t, locale } = useI18n()
  const [dismissOpen, setDismissOpen] = React.useState(false)
  const [scoreOpen, setScoreOpen] = React.useState(false)
  const [rechecking, setRechecking] = React.useState(false)
  const liveOps = useActiveJobOps(item.id, activeOperations)
  const receipts = list(item.receipts ?? item.history)
  const interviewNotes = list(item.interviewNotes)
  const stage = item.stage ?? item.status ?? 'discovered'
  const stageTone = ['offer_received', 'offer_accepted', 'started'].includes(stage) ? 'success'
    : ['invited', 'interview_confirmed', 'interview_completed'].includes(stage) ? 'info'
      : ['rejected', 'withdrawn', 'offer_declined'].includes(stage) ? 'neutral' : 'outline'
  const syncCount = Object.values(personalSync?.items ?? {}).filter(si => si?.opportunityId === item.id && si.verified).length
  const latestNote = latestJobSummary(item, config.timezone, t, locale)
  const nextStepNote = !latestNote && receipts.length > 0 && !item.closedAt ? nextStepHintForStage(stage, t) : ''
  const preset = boardForSourceId(item.sourceId)
  const companyName = (locale === 'en' && item.company === preset?.company && preset?.companyEn) || item.company || t('common.company')
  const subscribedBoards = list(config.boards)
  const userScope = resolveDefaultHiringScope(config)
  const channelBadge = contextualBoardChannelLabel(preset, t, { userScope, boards: subscribedBoards })
  const matchedBoard = subscribedBoards.find(b => `${b.provider}:${String(b.slug || '').toLowerCase()}` === item.sourceId)
  const match = item.match ?? null
  const isMissingJd = Boolean(match && match.mode !== 'llm' && (match.missingJd || match.uncertaintyCode === 'missing_jd'))
  const matchZone = match?.zone || (isMissingJd ? 'missing_jd' : match?.mode === 'llm' ? 'legacy_v1' : 'pending_local')
  const isEvaluated = matchZone === 'rubric_v2' || matchZone === 'legacy_v1'
  const isDismissed = item.feedback?.status === 'dismissed'
  const isFresh = receipts.length === 0 && !item.closedAt
  const displayReason = cleanTriageDisplayText(aiReason || (isFresh && !latestNote ? (match?.reason || '') : ''))
  const canRecheck = !isDismissed && (item.oneOff || matchedBoard || item.provider === 'manual' || item.feedback?.status === 'pinned')
  const executeRecheck = async (payload = { id: item.id, recheck: true }) => {
    setRechecking(true)
    try {
      const reply = await act.background('triage-jobs', payload, result => {
        if (result?.alreadyRunning || result?.running) return t('jobs.triageBusyToast')
        if (result?.staleConfirmation) return t('jobs.triageStaleConfirmToast')
        if (result?.requiresConfirmation) return ''
        if (result?.mode === 'llm') return t('jobs.retriageToast', { count: 1 })
        if (result?.missingJdCount > 0) return t('jobs.retriageMissingJdToast')
        return t('jobs.retriageUnchanged')
      })
      return reply?.result || null
    } finally {
      setRechecking(false)
    }
  }
  const recheck = async () => {
    const wasAutoSend = config.sendToModel === true
    if (wasAutoSend) {
      const res = await executeRecheck({ id: item.id, recheck: true })
      if (!res?.requiresConfirmation) return
    }
    setRechecking(true)
    let token = ''
    let previewSendToModel = wasAutoSend
    try {
      const previewReply = await act.background('triage-preview', { id: item.id }, res => {
        if (res?.alreadyRunning || res?.running) return t('jobs.triageBusyToast')
        if (res?.staleConfirmation) return t('jobs.triageStaleConfirmToast')
        if (!res?.confirmToken || !res?.count) {
          return res?.missingJdCount > 0 ? t('jobs.retriageMissingJdToast') : t('jobs.retriageUnchanged')
        }
        return ''
      })
      token = previewReply?.result?.confirmToken || ''
      previewSendToModel = previewReply?.result?.sendToModel === true
    } finally {
      setRechecking(false)
    }
    if (token) {
      await executeRecheck({
        confirmed: true,
        confirmToken: token,
        ...(wasAutoSend || previewSendToModel ? { autoConfirmed: true } : {}),
      })
    }
  }
  const stageText = stageLabel(stage, t) || t('stage.discovered')
  const cardAriaLabel = [item.title || t('common.role'), companyName, stageText].filter(Boolean).join(' · ')

  const submitFeedback = async (status, reason = '') => {
    setDismissOpen(false)
    await act(
      'job-feedback',
      { id: item.id, status, reason },
      status === 'clear' ? t('jobs.feedbackRestoredToast') : t('jobs.feedbackSavedToast'),
    )
  }

  return <article
    className={`ca-job-card${isDismissed || (isFresh && isEvaluated && match?.tier === 'skip') ? ' is-dimmed' : ''}${scoreOpen ? ' is-score-open' : ''}`}
    data-rise data-job-id={item.id} data-stage={stage} data-tone={bucketToneOf(stage)}
    data-fit-tier={isEvaluated ? (match?.tier || '') : ''}
    data-match-zone={matchZone}
  >
    <CompanyAvatar
      company={companyName}
      domain={matchedBoard?.domain || ''}
      slug={matchedBoard?.slug || ''}
      url={item.url}
      size={36}
      className="ca-job-monogram"
    />
    <div className="ca-job-card-main">
      <div className="ca-job-title-row">
        <h3>
          <button
            type="button"
            className="ca-job-card-open"
            aria-label={cardAriaLabel}
            onClick={() => onSelect(item.id, isFresh ? 'jd' : 'progress')}
          >
            {item.title || t('common.role')}
          </button>
        </h3>
        {item.closedAt && <Tag tone="danger">{t('jobs.closedTag')}</Tag>}
      </div>
      <div className="ca-meta ca-job-meta-row">
        <span>{[
          companyName,
          channelBadge,
          item.location,
          receipts.length > 1 && t('jobs.receiptsCount', { count: receipts.length }),
          interviewNotes.length > 0 && t('jobs.debriefsCount', { count: interviewNotes.length }),
          syncCount > 0 && t('jobs.syncedCalendar'),
        ].filter(Boolean).join(' · ')}</span>
        {liveOps.anyRunning && (
          <span className="ca-live-op-pill">
            <StateDot state="ongoing" size={8} />
            <span>{liveOps.label}</span>
          </span>
        )}
      </div>
      {displayReason && (
        <div className="ca-job-ai-reason">
          <span className="ca-job-ai-mark" aria-hidden="true">{match?.mode === 'llm' || aiReason ? <DeepSeekMark size={11} /> : '·'}</span>
          <span className="ca-job-ai-reason-text">{displayReason}</span>
        </div>
      )}
      {(latestNote || nextStepNote) && <p className="ca-job-latest">{latestNote || nextStepNote}</p>}
      {dismissOpen && (
        <div className="ca-feedback-bar" onClick={event => event.stopPropagation()}>
          <span className="ca-feedback-prompt">{t('jobs.feedbackPrompt')}</span>
          <button type="button" className="ca-feedback-opt" onClick={() => void submitFeedback('dismissed', 'direction')}>{t('jobs.reasonDirection')}</button>
          <button type="button" className="ca-feedback-opt" onClick={() => void submitFeedback('dismissed', 'location')}>{t('jobs.reasonLocation')}</button>
          <button type="button" className="ca-feedback-opt" onClick={() => void submitFeedback('dismissed', 'company')}>{t('jobs.reasonCompany')}</button>
          <button type="button" className="ca-feedback-opt is-quiet" onClick={() => void submitFeedback('dismissed', 'other')}>{t('jobs.reasonOther')}</button>
          <button type="button" className="ca-text-button" onClick={() => setDismissOpen(false)}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
    <div className="ca-job-card-side" onClick={event => event.stopPropagation()}>
      {isFresh ? (
        <div className="ca-job-card-stage is-score">
          <MatchScoreBadge
            match={match}
            isDismissed={isDismissed}
            basisResume={basisResume}
            open={scoreOpen}
            onToggle={() => setScoreOpen(v => !v)}
            onClose={() => setScoreOpen(false)}
            onRecheck={canRecheck ? recheck : undefined}
            rechecking={rechecking}
          />
        </div>
      ) : (
        <button
          type="button"
          className="ca-job-card-stage"
          onClick={() => onSelect(item.id, 'progress')}
          aria-label={`${stageText} · ${t('jobDetail.tabProgress', { count: receipts.length })}`}
        >
          <StageSteps stage={stage} label={stageText} />
          <Tag tone={stageTone}>{stageText}</Tag>
        </button>
      )}
      <div className="ca-job-card-actions">
        {isFresh && !isDismissed && (
          <Button variant="ghost" size="sm" disabled={!!busy}
            onClick={() => setDismissOpen(v => !v)}>{t('jobs.hideJob')}</Button>
        )}
        {isDismissed && (
          <Button variant="ghost" size="sm" disabled={!!busy}
            onClick={() => void submitFeedback('clear')}>{t('common.restore')}</Button>
        )}
        {!item.closedAt && !isDismissed && <Button variant="ghost" size="sm" disabled={!!busy} onClick={async () => {
          if (onTailorJob) {
            onTailorJob(item)
            return
          }
          const reply = await act('tailor-resume', { id: item.id }, t('jobs.tailorResumeToast'))
          if (reply?.result?.id) onResume(reply.result.id)
        }}>{t('jobs.tailorResume')}</Button>}
      </div>
    </div>
  </article>
}

function AddJob({ act, busy, onDone }) {
  const { t } = useI18n()
  const [job, setJob, clearJob] = usePersistedDraft('add-job', { company: '', title: '', location: '', url: '', jd: '' })
  const change = (key) => (event) => setJob(cur => ({ ...cur, [key]: event.target.value }))
  return <form className="ca-form ca-formbox" data-surface="add-job" onSubmit={async event => {
    event.preventDefault()
    if (await act('job-add', { job }, t('jobs.addJobToast'))) {
      clearJob()
      onDone()
    }
  }}>
    <div className="ca-fields">
      <label>{t('common.company')}<input required maxLength="160" value={job.company} onChange={change('company')} placeholder={t('jobs.companyPlaceholder')} /></label>
      <label>{t('common.role')}<input required maxLength="300" value={job.title} onChange={change('title')} placeholder={t('jobs.rolePlaceholder')} /></label>
    </div>
    <div className="ca-fields">
      <label>{t('common.location')}<input value={job.location} onChange={change('location')} placeholder={t('jobs.locationPlaceholder')} /></label>
      <label>{t('common.link')}<input type="url" pattern="https://.*" value={job.url} onChange={change('url')} placeholder="https://..." /></label>
    </div>
    <label>JD<textarea rows="3" value={job.jd} onChange={change('jd')} placeholder={t('jobs.jdPlaceholder')} /></label>
    <div className="ca-form-actions">
      <Button variant="ghost" size="sm" onClick={onDone}>{t('common.cancel')}</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('common.save')}</Button>
    </div>
  </form>
}

function formatIntervalLabel(minutes, t) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return t('composer.everyNHours', { count: 6 })
  if (m % 1440 === 0) return t('composer.everyNDays', { count: m / 1440 })
  if (m % 60 === 0) return t('composer.everyNHours', { count: m / 60 })
  return t('composer.everyNMinutes', { count: m })
}

function shortClock(iso, zone, locale = 'zh') {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const now = new Date()
  const bcp47 = locale === 'en' ? 'en-US' : 'zh-CN'
  try {
    const fmtDay = new Intl.DateTimeFormat(bcp47, { month: 'numeric', day: 'numeric', timeZone: zone })
    const fmtTime = new Intl.DateTimeFormat(bcp47, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone })
    return fmtDay.format(date) === fmtDay.format(now)
      ? fmtTime.format(date)
      : `${fmtDay.format(date)} ${fmtTime.format(date)}`
  } catch {
    return date.toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
}

function WatchTransparencyBar({ state, busy, act, activeCompanyKey = '', activeKeyword = '', onToggleCompany, onToggleKeyword, onManageBoards, onEditGoal, onSources, onSeedPrompt }) {
  const { t, locale } = useI18n()
  const [expanded, setExpanded] = React.useState(false)
  const [pulling, setPulling] = React.useState(false)
  const { config, watch, mode, personalSync } = state
  const rawBoards = list(config.boards)
  const terms = list(config.searchTerms)
  const scanning = pulling || Boolean(watch?.running)
  const isSearch = mode === 'search'
  const results = list(watch?.results)
  const resultMap = new Map(results.map(r => [r.sourceId, r]))
  const marketRegion = state.marketProfile?.region || 'cn'
  const hasWorkSources = list(config.sources).some(s => s.id === 'dsh-session' && !s.revokedAt && s.projects?.length > 0)
    || list(state.recordings?.sources).some(s => s.enabled && s.available)
  const sessionsOn = mode !== 'off' && config.watchSessions !== false && hasWorkSources
  const activeReceiptSources = new Set(
    list(state.opportunities).filter(j => j.receiptCount > 0 && j.sourceId).map(j => j.sourceId),
  )
  const boards = React.useMemo(() => {
    const score = b => {
      const id = `${b.provider}:${String(b.slug || '').toLowerCase()}`
      const r = resultMap.get(id)
      const cn = isCnBoard(b)
      let s = 0
      if (marketRegion === 'cn' && cn) s += 100
      else if (marketRegion === 'global' && !cn) s += 100
      if (activeReceiptSources.has(id)) s += 30
      if (r?.status === 'ok') s += 10 + Math.min(20, Math.floor((r.count ?? 0) / 5))
      else if (r?.status === 'error') s -= 15
      return s
    }
    return rawBoards.slice().sort((a, b) => score(b) - score(a))
  }, [rawBoards, results, marketRegion, state.opportunities])
  const errorCount = boards.filter(b => resultMap.get(`${b.provider}:${String(b.slug || '').toLowerCase()}`)?.status === 'error').length

  const autoWatching = isSearch && boards.length > 0
  const statusTitle = scanning
    ? t('jobs.watchScanning', { count: boards.length })
    : boards.length === 0 ? t('jobs.watchUnsubscribed')
    : autoWatching ? t('jobs.watchActive')
    : t('jobs.watchPaused')

  const lastTime = shortClock(watch?.lastRun, config.timezone, locale)
  const scheduleMeta = [
    autoWatching ? formatIntervalLabel(config.intervalMinutes, t) : null,
    lastTime ? t('jobs.watchLast', { time: lastTime }) : null,
  ].filter(Boolean).join(' · ')

  const toggleAutoWatch = nextOn => {
    const nextConfig = buildBoardsTogglePatch(state, nextOn)
    void act('configure', { config: nextConfig }, nextOn ? t('jobs.watchToastOn') : t('jobs.watchToastOff'))
  }

  const previewBoards = boards.slice(0, 5)
  const extraBoards = Math.max(0, boards.length - previewBoards.length)
  const userScope = resolveDefaultHiringScope(config)

  return <section className="ca-watch-card" data-surface="watch-status" data-status={scanning ? 'scanning' : autoWatching ? 'active' : 'paused'} aria-label={t('jobs.watchAria')}>
    <div className="ca-watch-head">
      <div className="ca-watch-head-left">
        <PatrolEmblem size={28} active={autoWatching} scanning={scanning} />
        <div className="ca-watch-toggle is-static">
          <span className="ca-watch-title-row">
            <span className="ca-watch-status">{statusTitle}</span>
            {errorCount > 0 && <span className="ca-watch-err-pill">{t('jobs.watchErrCount', { count: errorCount })}</span>}
          </span>
          {scheduleMeta && (
            <span className="ca-watch-time-row">
              <span className="ca-watch-time">{scheduleMeta}</span>
              <span className="ca-tip-anchor">
                <button
                  type="button"
                  className="ca-inline-help"
                  aria-label={t('jobs.watchFreqHelpAria')}
                  onClick={() => onSeedPrompt?.(t('jobs.watchFreqSeed'))}
                >?</button>
                <span className="ca-tip-pop is-left" role="tooltip">
                  <strong>{t('jobs.watchFreqTitle')}</strong>
                  <span>{t('jobs.watchFreqDesc')}</span>
                </span>
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="ca-watch-actions">
        {boards.length === 0 ? (
          <Button variant="outline" size="sm" onClick={() => onManageBoards('curated')}>{t('jobs.subscribeCompanies')}</Button>
        ) : <>
          <Button variant="outline" size="sm" disabled={scanning}
            onClick={async () => {
              setPulling(true)
              try {
                await act.background('run', { scope: 'boards' }, result => formatBoardScanToast(result, t))
              } finally {
                setPulling(false)
              }
            }}>
            {scanning ? <><StateDot state="ongoing" size={10} /> {t('jobs.scanningNow')}</> : <><Icon name="refresh" size={13} /> {t('jobs.scanNow')}</>}
          </Button>
          <Switch label={t('jobs.autoWatchLabel')} checked={autoWatching} disabled={!!busy} onChange={toggleAutoWatch} />
        </>}
      </div>
    </div>

    <div className="ca-watch-strip">
      <div className="ca-watch-prop-row">
        <button type="button" className="ca-watch-kicker is-link" onClick={() => onManageBoards('curated')}>{t('jobs.watchingCount', { count: boards.length })}</button>
        {boards.length > 0 ? <div className="ca-watch-wrap-list">
          {(expanded ? boards : previewBoards).map(b => {
            const id = `${b.provider}:${String(b.slug || '').toLowerCase()}`
            const r = resultMap.get(id)
            const isErr = r?.status === 'error'
            const preset = boardForSourceId(id)
            const company = (locale === 'en' && b.company === preset?.company && preset?.companyEn) || b.company || b.slug
            const channelBadge = contextualBoardChannelLabel(preset, t, { userScope, boards })
            const filterLabel = [company, channelBadge].filter(Boolean).join(' · ')
            const selected = activeCompanyKey === id
            return <button key={id} type="button"
              className={`ca-watch-source is-clickable${isErr ? ' is-error' : ''}${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              title={r?.error || t('jobs.filterCompanyTitle', { company: filterLabel })}
              onClick={() => onToggleCompany?.(id, filterLabel)}>
              {isErr
                ? <i className="ca-watch-source-err" aria-hidden="true" />
                : <CompanyAvatar company={company} domain={b.domain} slug={b.slug} size={14} />}
              <span>{company}</span>
              {channelBadge && <em className="ca-watch-channel-tag">{channelBadge}</em>}
              {r?.status === 'ok' && <small>{r.count}</small>}
              {isErr && <small>{t('jobs.boardErrShort')}</small>}
            </button>
          })}
          {extraBoards > 0 && (
            <button type="button" className="ca-watch-more is-btn" onClick={() => setExpanded(v => !v)}>
              {expanded ? t('common.collapse') : t('jobs.moreCompanies', { count: extraBoards })}
            </button>
          )}
        </div> : <span className="ca-meta">{t('jobs.watchUnsubscribed')}</span>}
      </div>

      {(terms.length > 0 || list(state.patrolProfile?.avoidHints).length > 0 || boards.length > 0) && (
        <div className="ca-watch-prop-row is-bottom">
          <button type="button" className="ca-watch-kicker is-link" onClick={() => (onEditGoal ? onEditGoal() : onManageBoards('curated'))}>{t('jobs.profileKeywords')}</button>
          <div className="ca-watch-term-inline">
            {terms.map(term => {
              const selected = activeKeyword.toLowerCase() === String(term || '').toLowerCase()
              return (
                <button key={term} type="button"
                  className={`ca-watch-term-pill is-clickable${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  title={t('jobs.filterKeywordTitle', { keyword: term })}
                  onClick={() => onToggleKeyword?.(term)}>
                  {term}
                </button>
              )
            })}
            {terms.length === 0 && (
              <button type="button" className="ca-watch-term-pill is-clickable is-add-cta"
                onClick={() => (onEditGoal ? onEditGoal() : onManageBoards('curated'))}>
                + {t('jobs.addProfileKeywordsCta')}
              </button>
            )}
            {list(state.patrolProfile?.avoidHints).slice(0, 2).map(a => (
              <span key={`avoid-${a}`} className="ca-tip-anchor is-row-anchored">
                <button type="button" className="ca-watch-term-pill is-avoid is-clickable"
                  onClick={() => onEditGoal?.()}>
                  − {a}
                </button>
                <span className="ca-tip-pop is-row-full" role="tooltip">
                  <strong>{t('jobs.avoidTermsTitle')}</strong>
                  <span>{t('jobs.avoidTermsDesc')}</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {watch?.lastError && (
        <p className="ca-watch-warn" role="status">
          {watch.lastError}
        </p>
      )}
    </div>
  </section>
}

const GOAL_GUIDE_DISMISSED_KEY = 'goalGuideDismissed'

function GoalEditorPanel({ config, patrolProfile, act, busy, isFirstTime, onDone, onDismissGuide }) {
  const { t, locale } = useI18n()
  const inputRef = React.useRef(null)
  const initialScope = React.useMemo(() => resolveDefaultHiringScope(config), [config])
  const [goal, setGoal] = React.useState(() => config.goal || '')
  const [hiringScope, setHiringScope] = React.useState(() => initialScope)
  const [syncBoards, setSyncBoards] = React.useState(true)
  const [terms, setTerms] = React.useState(() => list(config.searchTerms))
  const [dismissedTerms, setDismissedTerms] = React.useState(() => list(config.dismissedTerms))
  const [aiSuggestions, setAiSuggestions] = React.useState(() => list(patrolProfile?.suggestedTerms))
  const [suggestLoading, setSuggestLoading] = React.useState(false)
  const [termInput, setTermInput] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const currentBoards = React.useMemo(() => list(config.boards), [config.boards])
  const migrationPreview = React.useMemo(
    () => migrateBoardsToHiringScope(currentBoards, hiringScope),
    [currentBoards, hiringScope],
  )
  const showSyncOption = (hiringScope === 'experienced' || hiringScope === 'campus')
    && migrationPreview.migratedCount > 0

  React.useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const suggestAbortRef = React.useRef(null)
  const suggestReqIdRef = React.useRef(0)
  const savedGoalRef = React.useRef((config.goal || '').trim())

  React.useEffect(() => {
    const nextSavedGoal = (config.goal || '').trim()
    const incoming = list(patrolProfile?.suggestedTerms)
    if (nextSavedGoal !== savedGoalRef.current) {
      savedGoalRef.current = nextSavedGoal
      suggestReqIdRef.current += 1
      suggestAbortRef.current?.abort()
      suggestAbortRef.current = null
      setSuggestLoading(false)
      setAiSuggestions(incoming)
      return
    }
    if (goal.trim() === nextSavedGoal && incoming.length > 0 && aiSuggestions.length === 0) {
      setAiSuggestions(incoming)
    }
  }, [config.goal, patrolProfile?.suggestedTerms])

  React.useEffect(() => () => {
    suggestReqIdRef.current += 1
    suggestAbortRef.current?.abort()
    suggestAbortRef.current = null
  }, [])

  const handleGoalChange = nextVal => {
    setGoal(nextVal)
    if (nextVal.trim() !== goal.trim()) {
      suggestReqIdRef.current += 1
      suggestAbortRef.current?.abort()
      suggestAbortRef.current = null
      setSuggestLoading(false)
      setAiSuggestions([])
    }
  }

  const loadAiSuggestions = React.useCallback(async (force = false) => {
    if (!goal.trim() && terms.length === 0) return
    const reqCtx = captureProfileContext()
    suggestAbortRef.current?.abort()
    const controller = new AbortController()
    suggestAbortRef.current = controller
    const reqId = ++suggestReqIdRef.current
    setSuggestLoading(true)
    try {
      const response = await fetch('api/career-agent/suggest-directions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': locale || getActiveLocale() }, reqCtx),
        body: JSON.stringify({
          force,
          goal: goal.trim(),
          searchTerms: terms,
          dismissedTerms,
          explicitInteractive: true,
        }),
        signal: controller.signal,
      })
      const payload = await response.json().catch(() => null)
      checkProfileMismatch(response, payload)
      if (!isProfileContextCurrent(reqCtx)) return
      if (suggestReqIdRef.current === reqId && response.ok && payload?.ok && Array.isArray(payload.result?.keywords)) {
        setAiSuggestions(payload.result.keywords)
      }
    } catch {
      // Offline / aborted / no model: never fall back to hardcoded guesses
    } finally {
      if (suggestReqIdRef.current === reqId && isProfileContextCurrent(reqCtx)) {
        if (suggestAbortRef.current === controller) suggestAbortRef.current = null
        setSuggestLoading(false)
      }
    }
  }, [goal, terms, dismissedTerms, locale])

  const recommended = React.useMemo(() => {
    const excluded = new Set([
      ...terms.map(item => String(item || '').trim().toLowerCase()),
      ...dismissedTerms.map(item => String(item || '').trim().toLowerCase()),
    ])
    const out = []
    for (const item of aiSuggestions) {
      const clean = String(item || '').trim()
      const lower = clean.toLowerCase()
      if (!clean || excluded.has(lower)) continue
      excluded.add(lower)
      out.push(clean)
      if (out.length >= 6) break
    }
    return out
  }, [aiSuggestions, terms, dismissedTerms])

  const addTerm = raw => {
    const clean = String(raw || '').trim()
    if (!clean || terms.some(item => item.toLowerCase() === clean.toLowerCase()) || terms.length >= 24) return
    setTerms(cur => [...cur, clean])
    setDismissedTerms(cur => cur.filter(item => item.toLowerCase() !== clean.toLowerCase()))
  }

  const dismissSuggestion = raw => {
    const clean = String(raw || '').trim()
    if (!clean) return
    const nextDismissed = dismissedTerms.some(item => item.toLowerCase() === clean.toLowerCase())
      ? dismissedTerms
      : [...dismissedTerms, clean].slice(-48)
    setDismissedTerms(nextDismissed)
    setAiSuggestions(cur => cur.filter(item => item.toLowerCase() !== clean.toLowerCase()))
    const runner = typeof act?.background === 'function' ? act.background : act
    if (typeof runner === 'function') {
      void runner('configure', { config: { dismissedTerms: nextDismissed } }).catch?.(() => {})
    }
  }

  const removeTerm = target => setTerms(cur => cur.filter(item => item !== target))

  const submit = async event => {
    event.preventDefault()
    if (saving || busy) return
    const pendingTerm = termInput.trim()
    const finalTerms = pendingTerm && !terms.some(item => item.toLowerCase() === pendingTerm.toLowerCase())
      ? [...terms, pendingTerm].slice(0, 24)
      : terms
    setSaving(true)
    try {
      const runner = typeof act?.background === 'function' ? act.background : act
      const patch = {
        goal: goal.trim(),
        hiringScope,
        searchTerms: finalTerms,
        dismissedTerms,
        ...(showSyncOption && syncBoards ? { boards: migrationPreview.nextBoards } : {}),
      }
      const reply = await runner('configure', {
        config: patch,
      }, t('jobs.goalSavedToast'))
      if (reply?.ok) {
        setTermInput('')
        onDone?.()
      }
    } finally {
      setSaving(false)
    }
  }

  const scopeChanged = hiringScope !== (config.hiringScope || '')
  const canSave = Boolean(goal.trim() || terms.length > 0 || termInput.trim() || scopeChanged)

  return (
    <form className="ca-goal-editor-card" data-surface="goal-editor" onSubmit={submit}>
      <div className="ca-goal-editor-head">
        <div className="ca-goal-editor-title">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="0.9" fill="currentColor" />
          </svg>
          <strong>{isFirstTime ? t('jobs.goalGuideTitle') : t('jobs.goalLabelPrefix')}</strong>
        </div>
        <button type="button" className="ca-text-button" onClick={isFirstTime ? onDismissGuide : onDone}>
          {isFirstTime ? t('jobs.goalLater') : t('common.cancel')}
        </button>
      </div>

      <div className="ca-goal-track-row">
        <span className="ca-goal-terms-label">{t('jobs.hiringTrackLabel')}</span>
        <div className="ca-goal-track-pills" role="radiogroup" aria-label={t('jobs.hiringTrackAria')}>
          {[
            { value: 'experienced', label: t('jobs.hiringTrackExperienced') },
            { value: 'campus', label: t('jobs.hiringTrackCampus') },
          ].map(opt => {
            const active = hiringScope === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`ca-goal-track-pill${active ? ' is-active' : ''}`}
                onClick={() => setHiringScope(opt.value)}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {showSyncOption && (
        <label className="ca-goal-sync-check">
          <input
            type="checkbox"
            checked={syncBoards}
            onChange={e => setSyncBoards(e.target.checked)}
          />
          <span>
            {t('jobs.hiringTrackSyncBoards', {
              count: migrationPreview.migratedCount,
              track: hiringScopeLabel(hiringScope, t),
            })}
            {migrationPreview.unavailable.length > 0 && (
              <em>{t('jobs.hiringTrackSyncUnavailable', { count: migrationPreview.unavailable.length })}</em>
            )}
          </span>
        </label>
      )}

      <div className="ca-goal-editor-main">
        <input
          ref={inputRef}
          className="ca-goal-input"
          value={goal}
          maxLength={400}
          onChange={e => handleGoalChange(e.target.value)}
          placeholder={t('jobs.goalPlaceholderInline')}
          aria-label={t('jobs.goalLabelPrefix')}
        />
        <Button type="submit" variant="primary" size="sm" disabled={saving || !!busy || !canSave}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>

      <div className="ca-goal-editor-terms">
        <span className="ca-goal-terms-label">{t('jobs.goalKeywordsLabel')}</span>
        <div className="ca-goal-terms-list">
          {terms.map(term => (
            <span key={term} className="ca-term-chip is-selected">
              <span>{term}</span>
              <button type="button" aria-label={t('boards.removeTermAria', { term })} onClick={() => removeTerm(term)}>×</button>
            </span>
          ))}
          <input
            className="ca-goal-term-input"
            value={termInput}
            placeholder={t('jobs.goalAddKeywordPh')}
            onChange={e => setTermInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addTerm(termInput)
                setTermInput('')
              }
            }}
          />
        </div>
      </div>

      {(recommended.length > 0 || goal.trim() || terms.length > 0) && (
        <div className="ca-goal-editor-recs">
          <span className="ca-goal-terms-label">{t('jobs.goalRecommended')}</span>
          <div className="ca-goal-rec-pills">
            {recommended.map(kw => (
              <span key={kw} className="ca-suggest-chip">
                <button type="button" className="ca-suggest-chip-add" onClick={() => addTerm(kw)}
                  title={t('jobs.acceptSuggestedKeywordTitle', { keyword: kw })}>
                  + {kw}
                </button>
                <button type="button" className="ca-suggest-chip-dismiss"
                  aria-label={t('jobs.dismissSuggestedKeywordAria', { keyword: kw })}
                  title={t('jobs.dismissSuggestedKeywordAria', { keyword: kw })}
                  onClick={() => dismissSuggestion(kw)}>
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className="ca-suggest-trigger-btn"
              disabled={suggestLoading}
              onClick={() => void loadAiSuggestions(recommended.length > 0)}
            >
              <DeepSeekMark size={12} />
              <span>
                {suggestLoading
                  ? t('jobs.goalSuggestLoading')
                  : recommended.length > 0
                    ? t('jobs.goalSuggestRefresh')
                    : t('jobs.goalSuggestBtn')}
              </span>
            </button>
          </div>
        </div>
      )}
    </form>
  )
}

function Jobs({ state, act, busy, focusedJob, onClearFocus, onOpenJob, onResume, onTailorJob, onResumeWithPrompt, onSources, onStartSession, onOpenResumeTab, pendingJobFilter, onConsumeJobFilter }) {
  const { t } = useI18n()
  const [manual, setManual] = React.useState(false)
  const [boardsTab, setBoardsTab] = React.useState('')
  const [stageFilter, setStageFilter] = React.useState('all')
  const [showDismissed, setShowDismissed] = React.useState(false)
  const [companyFilter, setCompanyFilter] = React.useState(null) // { key, label } | null
  const [keywordFilter, setKeywordFilter] = React.useState('')
  const [aiFilter, setAiFilter] = React.useState(null) // { label, ids, reasons } | null
  const [query, setQuery] = React.useState('')
  const [seedPrompt, setSeedPrompt] = React.useState({ text: '', nonce: 0 })
  const clearSeedPrompt = React.useCallback(() => {
    setSeedPrompt(cur => (cur.text ? { text: '', nonce: cur.nonce } : cur))
  }, [])
  const [extraVisible, setExtraVisible] = React.useState(0)
  const [triaging, setTriaging] = React.useState(false)
  const [lastRunReceipt, setLastRunReceipt] = React.useState(null)
  const [dismissedReceiptAt, setDismissedReceiptAt] = React.useState('')
  const [goalEditing, setGoalEditing] = React.useState(false)
  const [goalGuideDismissed, setGoalGuideDismissed] = React.useState(() => readProfileLocal(GOAL_GUIDE_DISMISSED_KEY) === '1')
  React.useEffect(() => {
    setGoalGuideDismissed(readProfileLocal(GOAL_GUIDE_DISMISSED_KEY) === '1')
  }, [state.profileKey])
  const listRef = React.useRef(null)
  const topRef = React.useRef(null)
  const { config } = state
  const opportunities = list(state.opportunities)
  const notices = list(state.notifications)
  const boards = list(config.boards)
  const userScope = resolveDefaultHiringScope(config)
  const trackTag = hiringScopeLabel(userScope, t)
  const goalTerms = list(config.searchTerms)
  const hasGoal = Boolean((config.goal || '').trim() || goalTerms.length > 0 || config.hiringScope)
  const showGoalEditor = goalEditing || (!hasGoal && !goalGuideDismissed)
  const triage = state.triageSummary ?? null
  const focusedJobId = typeof focusedJob === 'string' ? focusedJob : focusedJob?.id ?? null
  const focusedJobSection = typeof focusedJob === 'object' ? (focusedJob?.section ?? '') : ''
  const activeJob = opportunities.find(item => item.id === focusedJobId) ?? null

  const openGoalEditor = React.useCallback(() => {
    setGoalEditing(true)
    window.requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }, [])

  const dismissGoalGuide = React.useCallback(() => {
    setGoalGuideDismissed(true)
    setGoalEditing(false)
    writeProfileLocal(GOAL_GUIDE_DISMISSED_KEY, '1')
  }, [])

  React.useEffect(() => {
    setExtraVisible(0)
  }, [stageFilter, showDismissed, companyFilter?.key, keywordFilter, aiFilter?.label, query])

  React.useEffect(() => {
    if (!pendingJobFilter) return
    setStageFilter('all')
    setShowDismissed(false)
    setKeywordFilter('')
    if (Array.isArray(pendingJobFilter.ids)) {
      setCompanyFilter(null)
      setQuery('')
      setAiFilter({
        label: pendingJobFilter.label || t('composer.aiFilterLabel'),
        ids: pendingJobFilter.ids,
        reasons: pendingJobFilter.reasons || {},
      })
    } else if (pendingJobFilter.company) {
      setAiFilter(null)
      setQuery('')
      setCompanyFilter(pendingJobFilter.company)
    } else if (pendingJobFilter.query) {
      setCompanyFilter(null)
      setAiFilter(null)
      setQuery(pendingJobFilter.query)
    }
    onConsumeJobFilter?.()
  }, [pendingJobFilter, onConsumeJobFilter, t])

  const channelFilter = React.useCallback(sourceIds => {
    const label = sourceIds.map(id => {
      const board = boardForSourceId(id)
      if (!board) return id
      const name = (getActiveLocale() === 'en' && board.companyEn) || board.company
      return [name, contextualBoardChannelLabel(board, t, { userScope, boards })].filter(Boolean).join(' · ')
    }).join(' / ')
    return { key: sourceIds.join(','), sourceIds, label }
  }, [t, userScope, boards])
  React.useEffect(() => {
    setCompanyFilter(current => {
      if (!current?.sourceIds) return current
      const ids = reconcileJobSources(current.sourceIds, boards)
      if (ids.join(',') === current.key) return current
      return ids.length ? channelFilter(ids) : null
    })
  }, [config.boards, channelFilter])

  const openBoards = (tab = 'curated') => setBoardsTab(tab || 'curated')
  const toggleCompanyFilter = (key, label) => {
    setCompanyFilter(cur => (cur?.key === key ? null : { key, label, sourceIds: [key] }))
  }
  const toggleKeywordFilter = keyword => {
    const clean = String(keyword || '').trim()
    if (!clean) return
    setShowDismissed(false)
    setKeywordFilter(cur => (cur.toLowerCase() === clean.toLowerCase() ? '' : clean))
  }
  const applyAiFilter = next => {
    if (!next) {
      setAiFilter(null)
      return
    }
    if (next.stage && ['all', 'saved', 'applied', 'interview', 'offer', 'closed'].includes(next.stage)) {
      setStageFilter(next.stage)
    }
    setCompanyFilter(null)
    setKeywordFilter('')
    setAiFilter({
      label: next.label || t('composer.aiFilterLabel'),
      ids: Array.isArray(next.ids) ? next.ids : [],
      reasons: next.reasons || {},
    })
  }
  const clearAllFilters = () => {
    setStageFilter('all')
    setShowDismissed(false)
    setCompanyFilter(null)
    setKeywordFilter('')
    setAiFilter(null)
    setQuery('')
  }

  const aiOrderMap = aiFilter ? new Map(aiFilter.ids.map((id, idx) => [id, idx])) : null
  const dismissedOpportunities = React.useMemo(
    () => opportunities.filter(item => item.feedback?.status === 'dismissed'),
    [opportunities],
  )
  // One unified list for status filtering and recommendation ordering; counts ALWAYS match filtered list.
  const scopedPool = React.useMemo(() => {
    const base = showDismissed
      ? dismissedOpportunities
      : opportunities.filter(item => item.feedback?.status !== 'dismissed')
    const kwNeedle = keywordFilter.trim().toLowerCase()
    const kwAscii = /^[a-z0-9.+#/-]+$/i.test(kwNeedle)
    const kwRe = kwNeedle && kwAscii && kwNeedle.length <= 4
      ? new RegExp(`(?:^|[^a-z0-9])${kwNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i')
      : null
    return base.filter(item => {
      if (!matchesJobFilter(item, companyFilter)) return false
      if (aiOrderMap && !aiOrderMap.has(item.id)) return false
      if (kwNeedle) {
        const breakdownText = [...list(item.match?.breakdown), ...list(item.match?.factSignals)].map(r => r?.detail || '').join(' ')
        const kwHay = `${item.company || ''} ${item.title || ''} ${item.location || ''} ${item.jd || ''} ${item.match?.reason || ''} ${breakdownText}`.toLowerCase()
        if (kwRe ? !kwRe.test(kwHay) : !kwHay.includes(kwNeedle)) return false
      }
      if (query.trim()) {
        const needle = query.trim().toLowerCase()
        const hay = `${item.company || ''} ${item.title || ''} ${item.location || ''} ${item.match?.reason || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [opportunities, dismissedOpportunities, showDismissed, companyFilter, keywordFilter, aiOrderMap, query])

  const bucketCounts = React.useMemo(() => Object.fromEntries(
    PIPELINE_BUCKETS.map(bucket => [
      bucket.id,
      scopedPool.filter(item => bucket.stages.has(item.stage ?? item.status ?? 'discovered')).length,
    ]),
  ), [scopedPool])

  const filtered = React.useMemo(() => {
    const rows = stageFilter === 'all'
      ? scopedPool.slice()
      : scopedPool.filter(item => {
        const bucket = PIPELINE_BUCKETS.find(b => b.id === stageFilter)
        return Boolean(bucket?.stages.has(item.stage ?? item.status ?? 'discovered'))
      })
    if (aiOrderMap) {
      rows.sort((a, b) => (aiOrderMap.get(a.id) ?? 9999) - (aiOrderMap.get(b.id) ?? 9999))
    }
    return rows
  }, [scopedPool, stageFilter, aiOrderMap])

  const activeStageBucket = PIPELINE_BUCKETS.find(b => b.id === stageFilter)
  const activeFilterCount = (stageFilter !== 'all' ? 1 : 0) + (companyFilter ? 1 : 0) + (keywordFilter ? 1 : 0) + (aiFilter ? 1 : 0)
  const isNarrowed = showDismissed || stageFilter !== 'all' || Boolean(companyFilter) || Boolean(keywordFilter) || Boolean(aiFilter) || Boolean(query.trim())
  const DEFAULT_JOB_LIMIT = isNarrowed ? 30 : 16
  const visibleLimit = DEFAULT_JOB_LIMIT + extraVisible
  const visibleJobs = filtered.slice(0, visibleLimit)
  const hiddenJobCount = Math.max(0, filtered.length - visibleJobs.length)

  useRiseList(listRef, `${stageFilter}:${showDismissed ? 'd' : 'a'}:${companyFilter?.key || ''}:${keywordFilter}:${aiFilter?.label || ''}:${visibleJobs.length}:${query}`)

  return <div className="ca-jobs-screen" data-surface="jobs" ref={topRef}>
    <div className="ca-dsh-page-head">
      <div className="ca-jobs-head-title">
        <h2>{t('jobs.title')}</h2>
        {!showGoalEditor && (
          <button
            type="button"
            className={`ca-goal-anchor-pill${hasGoal ? ' is-set' : ' is-unset'}`}
            aria-label={t('jobs.goalAnchorAria')}
            onClick={openGoalEditor}
          >
            <svg className="ca-goal-anchor-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.45" />
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.45" />
              <circle cx="8" cy="8" r="0.9" fill="currentColor" />
            </svg>
            {hasGoal ? <>
              {trackTag && <span className={`ca-goal-track-badge${userScope === 'campus' ? ' is-campus' : ''}`}>{trackTag}</span>}
              <span className="ca-goal-anchor-text">
                {config.goal ? config.goal : goalTerms.length > 0 ? goalTerms.slice(0, 3).join(' · ') : t('jobs.goalSetPrompt')}
              </span>
              {config.goal && goalTerms.length > 0 && (
                <span className="ca-goal-anchor-meta">{t('jobs.goalKeywordsCount', { count: goalTerms.length })}</span>
              )}
              <span className="ca-goal-anchor-action">{t('jobs.goalEdit')}</span>
            </> : (
              <span className="ca-goal-anchor-text">+ {t('jobs.goalSetPrompt')}</span>
            )}
          </button>
        )}
      </div>
      <div className="ca-inline">
        {opportunities.length > 0 && (() => {
          const isTriageRunning = triaging || Boolean(triage?.running)
          const evaluatedCount = Number(triage?.evaluatedCount ?? triage?.llmTriagedCount ?? 0)
          const triageProgressLabel = triage?.progress?.total > 1
            ? t('jobs.triagingProgress', { completed: triage.progress.completed, total: triage.progress.total })
            : t('jobs.triaging')
          const triageTooltipText = evaluatedCount > 0
            ? t('jobs.retriageTooltipScored', { evaluated: evaluatedCount, limit: DEFAULT_TRIAGE_BATCH_LIMIT })
            : t('jobs.retriageTooltip', { limit: DEFAULT_TRIAGE_BATCH_LIMIT })
          const isCompleteRubricCard = j => {
            const r = j?.match?.rubric
            return j?.match?.zone === 'rubric_v2' && j?.match?.mode === 'llm' && r && r.incomplete !== true
              && !(typeof r.E === 'number' && r.E >= 2 && (!Array.isArray(r.resumeEvidence) || r.resumeEvidence.length === 0))
          }
          const isFilteredMissingJd = j => j?.match?.zone === 'missing_jd'
            || (j?.match?.mode !== 'llm' && (j?.match?.missingJd || j?.match?.uncertaintyCode === 'missing_jd'))
          const eligibleFiltered = isNarrowed
            ? filtered.filter(j => !j.closedAt && j.feedback?.status !== 'dismissed' && !isCompleteRubricCard(j))
            : []
          const filteredPendingIds = isNarrowed
            ? [
                ...eligibleFiltered.filter(j => j?.match?.zone !== 'legacy_v1' && !isFilteredMissingJd(j)).map(j => j.id),
                ...eligibleFiltered.filter(j => isFilteredMissingJd(j)).map(j => j.id),
                ...eligibleFiltered.filter(j => j?.match?.zone === 'legacy_v1').map(j => j.id),
              ].slice(0, 500)
            : undefined
          const filterScope = isNarrowed ? 'filtered' : 'default'
          const executeBatchTriage = async (payload = { force: true }) => {
            setTriaging(true)
            try {
              const reply = await act.background('triage-jobs', payload, r => {
                if (r?.alreadyRunning) return t('jobs.triageBusyToast')
                if (r?.staleConfirmation) return t('jobs.triageStaleConfirmToast')
                if (r?.requiresConfirmation) return t('jobs.triageNeedsConfirmToast')
                if (r?.emptyTarget) return isNarrowed ? t('jobs.triageFilteredEmptyToast') : t('jobs.triageEmptyTargetToast')
                if (r?.mode === 'cached' || r?.skipped) return t('jobs.retriageUpToDate')
                const missing = Number(r?.missingJdCount || 0)
                const scored = Number(r?.llmScoredCount || 0)
                if (!scored && !missing) return t('jobs.retriageNoNewScores')
                if (!scored) return t('jobs.retriageMissingJdBatchToast', { count: missing })
                return missing > 0 ? t('jobs.retriageToastWithMissing', { count: scored, missing }) : t('jobs.retriageToast', { count: scored })
              })
              if (reply?.result?.receipt) {
                setLastRunReceipt(reply.result.receipt)
                setDismissedReceiptAt('')
              }
            } finally {
              setTriaging(false)
            }
          }
          const requestBatchTriage = async () => {
            if (isNarrowed && (!filteredPendingIds || filteredPendingIds.length === 0)) {
              act.notify(t('jobs.triageFilteredEmptyToast'))
              return
            }
            const wasAutoSend = config.sendToModel === true
            const previewArgs = isNarrowed
              ? { limit: DEFAULT_TRIAGE_BATCH_LIMIT, upgradeLegacy: true, filterScope: 'filtered', targetJobIds: filteredPendingIds }
              : { limit: DEFAULT_TRIAGE_BATCH_LIMIT, upgradeLegacy: true, filterScope: 'default' }
            setTriaging(true)
            let token = ''
            let previewSendToModel = wasAutoSend
            try {
              const previewReply = await act.background('triage-preview', previewArgs, r => {
                if (r?.alreadyRunning || r?.running) return t('jobs.triageBusyToast')
                if (r?.staleConfirmation) return t('jobs.triageStaleConfirmToast')
                if (!r?.confirmToken || !r?.count) {
                  return r?.missingJdCount > 0
                    ? t('jobs.retriageMissingJdBatchToast', { count: r.missingJdCount })
                    : (isNarrowed ? t('jobs.triageFilteredEmptyToast') : t('jobs.retriageUpToDate'))
                }
                return ''
              })
              token = previewReply?.result?.confirmToken || ''
              previewSendToModel = previewReply?.result?.sendToModel === true
            } finally {
              setTriaging(false)
            }
            if (token) {
              await executeBatchTriage({
                confirmed: true,
                confirmToken: token,
                ...(wasAutoSend || previewSendToModel ? { autoConfirmed: true } : {}),
              })
            }
          }
          const buttonLabel = isNarrowed
            ? t('jobs.retriageFiltered', { limit: DEFAULT_TRIAGE_BATCH_LIMIT })
            : t('jobs.retriageCandidates', { limit: DEFAULT_TRIAGE_BATCH_LIMIT })
          const progressTotal = Math.max(0, Number(triage?.progress?.total || 0))
          const progressCompleted = Math.max(0, Number(triage?.progress?.completed || 0))
          const filledCells = progressTotal > 0
            ? Math.min(TRIAGE_PROGRESS_CELLS, Math.floor((progressCompleted / progressTotal) * TRIAGE_PROGRESS_CELLS))
            : 0
          return <span className="ca-tip-anchor">
            <Button variant="ghost" size="sm" disabled={isTriageRunning}
              className={isTriageRunning ? 'ca-triage-btn is-running' : 'ca-triage-btn'}
              icon={<DeepSeekMark size={13} className={isTriageRunning ? 'is-pulsing' : ''} />}
              onClick={requestBatchTriage}>
              {isTriageRunning ? (
                <span className="ca-triage-progress-inline">
                  <TextShimmer active>{triageProgressLabel}</TextShimmer>
                  <span className="ca-triage-cells" aria-hidden="true">
                    {Array.from({ length: TRIAGE_PROGRESS_CELLS }, (_, idx) => {
                      const cls = idx < filledCells
                        ? 'ca-triage-cell is-filled'
                        : (idx === filledCells ? 'ca-triage-cell is-active' : 'ca-triage-cell')
                      return <span key={idx} className={cls} />
                    })}
                  </span>
                </span>
              ) : buttonLabel}
            </Button>
            <span className="ca-tip-pop is-right" role="tooltip">
              <strong>
                {triage?.basisResume
                  ? t('jobs.basisResume', { title: `${triage.basisResume.title}${triage.basisResume.versionTag ? ` ${triage.basisResume.versionTag}` : ''}` })
                  : t('jobs.basisGoal')}
              </strong>
              <span>{triageTooltipText}</span>
            </span>
          </span>
        })()}
        <Button variant="primary" size="sm" onClick={() => openBoards('curated')}>
          {boards.length > 0 ? t('jobs.boardsBtnCount', { count: boards.length }) : t('jobs.subscribeBoardsBtn')}
        </Button>
      </div>
    </div>

    {showGoalEditor && (
      <GoalEditorPanel
        config={config}
        patrolProfile={state.patrolProfile}
        act={act}
        busy={busy}
        isFirstTime={!hasGoal && !goalEditing}
        onDone={() => setGoalEditing(false)}
        onDismissGuide={dismissGoalGuide}
      />
    )}

    {/* Directed 5-stage job lifecycle state machine (4 forward flow nodes + archive branch) */}
    <LifecycleStateMachine
      counts={bucketCounts}
      activeStage={showDismissed ? 'all' : stageFilter}
      onSelect={next => { setShowDismissed(false); setStageFilter(next) }}
    />

    {/* 2-Column Desktop Cockpit */}
    <div className="ca-jobs-cockpit">
      <div className="ca-jobs-main">
        <Section title={
          opportunities.length > 0 ? (
            <div className="ca-jobs-section-head">
              {showDismissed ? (
                <button type="button" className="ca-jobs-list-title is-link" onClick={() => setShowDismissed(false)}>
                  <span>{t('jobs.openRoles')}</span>
                  <span className="ca-jobs-list-count">{opportunities.filter(i => i.feedback?.status !== 'dismissed').length}</span>
                </button>
              ) : (
                <span className="ca-jobs-list-title">
                  <span>{activeStageBucket ? (activeStageBucket.labelKey ? t(activeStageBucket.labelKey) : activeStageBucket.label) : t('jobs.openRoles')}</span>
                  <span className="ca-jobs-list-count">{filtered.length}</span>
                </span>
              )}
              {dismissedOpportunities.length > 0 && (
                <button
                  type="button"
                  className={`ca-stage-filter-pill is-quiet${showDismissed ? ' is-active' : ''}`}
                  aria-pressed={showDismissed}
                  onClick={() => { setShowDismissed(v => !v); setStageFilter('all') }}
                >
                  <span>{t('jobs.dismissedPill')}</span>
                  <b>{showDismissed ? scopedPool.length : dismissedOpportunities.length}</b>
                </button>
              )}
            </div>
          ) : t('jobs.openRoles')
        } aside={
          <div className="ca-jobs-toolbar">
            {opportunities.length > 3 && (
              <input className="ca-jobs-search" type="search" value={query} onChange={e => setQuery(e.target.value)}
                placeholder={t('jobs.searchPlaceholder')} aria-label={t('jobs.searchAria')} />
            )}
            <Button variant="ghost" size="sm" className="ca-nowrap-btn" icon={<Icon name={manual ? 'close' : 'plus'} size={13} />}
              aria-expanded={manual}
              onClick={() => setManual(v => !v)}>{manual ? t('common.collapse') : t('jobs.addJob')}</Button>
          </div>
        }>
          {activeFilterCount > 0 && (
            <div className="ca-active-filters" role="region" aria-label={t('jobs.activeFiltersAria')}>
              <span className="ca-active-filters-label">{t('jobs.filterLabel')}</span>
              {stageFilter !== 'all' && (
                <button type="button" className="ca-filter-chip"
                  onClick={() => setStageFilter('all')}>
                  <span>{activeStageBucket ? (activeStageBucket.labelKey ? t(activeStageBucket.labelKey) : activeStageBucket.label) : stageFilter}</span>
                  <span className="ca-filter-chip-x" aria-hidden="true">×</span>
                </button>
              )}
              {companyFilter && (
                <button type="button" className="ca-filter-chip"
                  onClick={() => setCompanyFilter(null)}>
                  <span>{companyFilter.label}</span>
                  <span className="ca-filter-chip-x" aria-hidden="true">×</span>
                </button>
              )}
              {keywordFilter && (
                <button type="button" className="ca-filter-chip"
                  onClick={() => setKeywordFilter('')}>
                  <span>{t('jobs.keywordFilterChip', { keyword: keywordFilter })}</span>
                  <span className="ca-filter-chip-x" aria-hidden="true">×</span>
                </button>
              )}
              {aiFilter && (
                <button type="button" className="ca-filter-chip is-ai"
                  onClick={() => setAiFilter(null)}>
                  <span className="ca-inline-mark"><DeepSeekMark size={12} /><span>{aiFilter.label}</span></span>
                  <span className="ca-filter-chip-x" aria-hidden="true">×</span>
                </button>
              )}
              {activeFilterCount > 1 && (
                <button type="button" className="ca-active-filters-clear" onClick={clearAllFilters}>
                  {t('common.clearAll')}
                </button>
              )}
            </div>
          )}
          {manual && <AddJob act={act} busy={busy} onDone={() => setManual(false)} />}
          {(() => {
            const serverReceipt = triage?.lastReceipt || null
            const activeReceipt = (serverReceipt?.at && (!lastRunReceipt?.at || serverReceipt.at >= lastRunReceipt.at))
              ? serverReceipt
              : (lastRunReceipt || serverReceipt)
            if (!activeReceipt || (dismissedReceiptAt && dismissedReceiptAt === activeReceipt.at)) return null
            return <TriageReceiptBanner receipt={activeReceipt} onDismiss={() => setDismissedReceiptAt(activeReceipt.at || 'dismissed')} />
          })()}
          {visibleJobs.length ? <>
            <div className="ca-job-list" ref={listRef}>
              {visibleJobs.map(item => (
                <JobCard
                  key={item.id}
                  item={item}
                  config={config}
                  personalSync={state.personalSync}
                  activeOperations={state.activeOperations}
                  basisResume={triage?.basisResume || null}
                  aiReason={aiFilter?.reasons?.[item.id] || ''}
                  busy={busy}
                  act={act}
                  onSelect={onOpenJob}
                  onResume={onResume}
                  onTailorJob={onTailorJob}
                />
              ))}
            </div>
            {(hiddenJobCount > 0 || extraVisible > 0) && (
              <div className="ca-job-list-more">
                {hiddenJobCount > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setExtraVisible(n => n + 30)}>
                    {t('jobs.loadMoreJobs', { count: hiddenJobCount })}
                  </Button>
                )}
                {extraVisible > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setExtraVisible(0)}>
                    {t('jobs.collapseList')}
                  </Button>
                )}
              </div>
            )}
          </> : <div className="ca-jobs-empty">
            <div className="ca-jobs-empty-art" aria-hidden="true">
              <EmptySearchEmblem size={54} emptyCatalog={opportunities.length === 0} />
            </div>
            <p className="ca-jobs-empty-title">
              {opportunities.length === 0 ? t('jobs.emptyNoJobs') : t('jobs.emptyFiltered')}
            </p>
            {opportunities.length > 0 && (
              <p className="ca-jobs-empty-sub">
                {t('jobs.totalInLibrary', { count: opportunities.length })}
              </p>
            )}
            <div className="ca-inline">
              {opportunities.length === 0 ? <>
                <Button variant="primary" size="sm" onClick={() => openBoards('curated')}>{t('jobs.subscribeBoardsCta')}</Button>
                <Button variant="outline" size="sm" onClick={() => setManual(true)}>{t('jobs.addJob')}</Button>
              </> : (
                <Button variant="outline" size="sm" onClick={clearAllFilters}>{t('jobs.clearFilters')}</Button>
              )}
            </div>
          </div>}
        </Section>
      </div>

      <aside className="ca-jobs-rail" aria-label={t('jobs.railAria')}>
        {/* Things-style upcoming schedule with live macOS Calendar/Things/Reminders readback badges */}
        <FollowUps
          opportunities={state.opportunities}
          timezone={config.timezone}
          personalSync={state.personalSync}
          personalSchedule={config.personalSchedule}
          busy={busy}
          act={act}
          onOpenJob={onOpenJob}
          onSources={onSources}
        />

        {/* Transparent Background Watchdog Status Bar (Active vs Passive clarity) */}
        <WatchTransparencyBar
          state={state}
          busy={busy}
          act={act}
          activeCompanyKey={companyFilter?.key || ''}
          activeKeyword={keywordFilter}
          onToggleCompany={toggleCompanyFilter}
          onToggleKeyword={toggleKeywordFilter}
          onManageBoards={openBoards}
          onEditGoal={openGoalEditor}
          onSources={onSources}
          onSeedPrompt={prompt => setSeedPrompt(cur => ({ text: prompt, nonce: cur.nonce + 1 }))}
        />

        {/* Natural-language career command bar right inside Jobs (filter, compare, multi-job Offer evaluation + follow-up inquiry, receipts!) */}
        <Composer config={config} act={act} busy={busy} intakes={state.intakes} opportunities={state.opportunities}
          viewSourceIds={companyFilter?.sourceIds}
          initialText={seedPrompt.text}
          initialTextKey={seedPrompt.nonce}
          onSeedConsumed={clearSeedPrompt}
          onApplyFilter={applyAiFilter}
          onOpenJob={onOpenJob}
          onApplied={(kind, data) => {
            clearSeedPrompt()
            if (kind === 'resume') onResume?.()
            if (kind === 'search') {
              clearAllFilters()
              const sourceIds = planJobSources(data)
              if (sourceIds.length) setCompanyFilter(channelFilter(sourceIds))
            }
          }} />

        <RecordingQueue recordings={state.recordings} opportunities={state.opportunities} config={config}
          busy={busy} act={act} onOpenJob={onOpenJob} />

        {notices.length > 0 && <Section title={t('jobs.careerReflections')}>
          <div className="ca-stream">
            {notices.map(item => <article className="ca-row" key={item.id}>
              <div className="ca-row-body">
                <h3>{item.title || t('jobs.notableChange')}</h3>
                <p>{item.text ?? item.reason ?? item.message}</p>
              </div>
              <div className="ca-row-actions">
                <Button variant="ghost" size="sm" disabled={!!busy}
                  onClick={() => act('suggestion-review', { id: item.id, decision: 'dismiss' }, t('composer.toastDismissed'))}>{t('common.gotIt')}</Button>
              </div>
            </article>)}
          </div>
        </Section>}
      </aside>
    </div>

    {boardsTab && <BoardSubscribeSheet state={state} busy={busy} act={act} initialTab={boardsTab} onClose={() => setBoardsTab('')} onStartSession={onStartSession} />}
    {activeJob && <JobDetailSheet
      job={activeJob}
      initialSection={focusedJobSection}
      state={state}
      busy={busy}
      act={act}
      onClose={onClearFocus}
      onResume={onResume}
      onTailorJob={onTailorJob}
      onResumeWithPrompt={onResumeWithPrompt}
      onSources={onSources}
      onStartSession={onStartSession}
    />}
  </div>
}

function Panel({ onStartSession }) {
  const { state, error, message, busy, act, silentAct, reload } = useWorkspace()
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
    bound.background = (action, args, toast) => {
      if (!isProfileContextCurrent(panelCtxRef.current)) return Promise.resolve({ ok: false, staleProfile: true })
      return typeof rawAct?.background === 'function'
        ? rawAct.background(action, args, toast)
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

      {!content && !error && <div className="ca-width ca-content"><div className="ca-loading" role="status">{t('status.connectingBroker')}</div></div>}

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
  const BoundPanel = () => (
    <I18nProvider>
      <Panel onStartSession={startDshSession} />
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
