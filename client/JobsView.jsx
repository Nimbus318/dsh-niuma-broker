import React from 'react'
import { DEFAULT_TRIAGE_BATCH_LIMIT, matchesJobFilter, migrateBoardsToHiringScope, planJobSources, reconcileJobSources, resolveDefaultHiringScope, TRIAGE_PROGRESS_CELLS } from '../src/job-view-scope.mjs'
import { buildBoardsTogglePatch, formatBoardScanToast } from '../src/automation-toggles.mjs'
import { Button, StateDot, Switch, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildCuaCollectPrompt } from '../src/cua-prompt.mjs'
import { CuaLauncherPanel, CuaReadinessCard, PendingImportsDrawer } from './PendingImportsDrawer.jsx'
import { cleanTriageDisplayText, MatchScoreBadge, TriageReceiptBanner } from './TriageRubricPanel.jsx'
import { useActiveJobOps } from './AiActivity.jsx'
import FollowUps from './FollowUps.jsx'
import Composer from './Composer.jsx'
import RecordingQueue from './RecordingQueue.jsx'
import BoardSubscribeSheet from './BoardSubscribeSheet.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import JobDetailSheet from './JobDetailSheet.jsx'
import LifecycleStateMachine, { bucketToneOf, PIPELINE_BUCKETS, StageSteps } from './LifecycleMachine.jsx'
import { DeepSeekMark, EmptySearchEmblem, PatrolEmblem } from './Emblems.jsx'
import { Icon, Section } from './ResumeLibrary.jsx'
import { boardForSourceId, contextualBoardChannelLabel, hiringScopeLabel, isCnBoard, list, opportunityOriginLabel, readableDate, stageLabel } from './shared.js'
import { getActiveLocale, useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  isProfileContextCurrent,
  profileRequestHeaders,
  readProfileLocal,
  writeProfileLocal,
} from './profile-storage.js'
import { usePersistedDraft } from './draft-hooks.jsx'
import { useRiseList } from './Motion.jsx'

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
  const originLabel = opportunityOriginLabel(item, t)
  const matchedBoard = subscribedBoards.find(b => `${b.provider}:${String(b.slug || '').toLowerCase()}` === item.sourceId)
  const match = item.match ?? null
  const isMissingJd = Boolean(match && match.mode !== 'llm' && (match.missingJd || match.uncertaintyCode === 'missing_jd'))
  const matchZone = match?.zone || (isMissingJd ? 'missing_jd' : match?.mode === 'llm' ? 'legacy_v1' : 'pending_local')
  const isEvaluated = matchZone === 'rubric_v2' || matchZone === 'legacy_v1'
  const isDismissed = item.feedback?.status === 'dismissed'
  const isFresh = receipts.length === 0 && !item.closedAt
  const intelVerdict = cleanTriageDisplayText(item.intel?.verdict || '')
  const displayReason = cleanTriageDisplayText(
    aiReason || (isFresh && !latestNote ? (isEvaluated ? (match?.reason || '') : (intelVerdict || match?.reason || '')) : ''),
  )
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
        {originLabel && <span className="ca-job-origin-tag">{originLabel}</span>}
        {liveOps.anyRunning && (
          <span className="ca-live-op-pill">
            <StateDot state="ongoing" size={8} />
            <span>{liveOps.label}</span>
          </span>
        )}
      </div>
      {displayReason && (
        <div className="ca-job-ai-reason">
          <span className="ca-job-ai-mark" aria-hidden="true">{match?.mode === 'llm' || aiReason || (!isEvaluated && intelVerdict) ? <DeepSeekMark size={11} /> : '·'}</span>
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
      {isFresh ? (
        <div className="ca-job-card-stage is-score">
          <MatchScoreBadge
            match={match}
            intel={item.intel || null}
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
const TRIAGE_RECEIPT_DISMISSED_KEY = 'triageReceiptDismissedAt'

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

export default function Jobs({ state, act, busy, focusedJob, onClearFocus, onOpenJob, onResume, onTailorJob, onResumeWithPrompt, onSources, onStartSession, onOpenResumeTab, pendingJobFilter, onConsumeJobFilter }) {
  const { t, locale } = useI18n()
  const { config } = state
  const [manual, setManual] = React.useState(false)
  const [pendingDrawerOpen, setPendingDrawerOpen] = React.useState(false)
  const [cuaGuideOpen, setCuaGuideOpen] = React.useState(false)
  const [cuaLauncherOpen, setCuaLauncherOpen] = React.useState(false)
  const pendingOpportunities = list(state.pendingOpportunities)
  const cuaCap = state.capabilities?.cua ?? null
  const prevPendingCountRef = React.useRef(pendingOpportunities.length)
  React.useEffect(() => {
    if (pendingOpportunities.length > prevPendingCountRef.current) {
      setPendingDrawerOpen(true)
    } else if (pendingOpportunities.length === 0) {
      setPendingDrawerOpen(false)
    }
    prevPendingCountRef.current = pendingOpportunities.length
  }, [pendingOpportunities.length])
  const launchCuaCollect = React.useCallback((opts = {}) => {
    if (!onStartSession) return
    const prompt = buildCuaCollectPrompt({
      locale,
      goal: config.goal || '',
      searchTerms: list(config.searchTerms),
      hiringScope: config.hiringScope || '',
      careerLevel: config.careerLevel || '',
      ...opts,
    })
    const ok = onStartSession(prompt)
    setCuaGuideOpen(false)
    setCuaLauncherOpen(false)
    if (ok) {
      act.notify?.(opts.mode === 'current-page' ? t('jobs.collectCurrentToast') : t('jobs.collectViaDshToast'))
    }
  }, [onStartSession, locale, config.goal, config.searchTerms, config.hiringScope, config.careerLevel, act, t])
  const handleCollectViaDsh = React.useCallback(() => {
    if (cuaCap?.status === 'ready' && onStartSession) {
      setCuaGuideOpen(false)
      setCuaLauncherOpen(v => {
        const next = !v
        if (next) setManual(false)
        return next
      })
      return
    }
    setCuaLauncherOpen(false)
    setCuaGuideOpen(v => !v)
  }, [cuaCap?.status, onStartSession])
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
  const [dismissedReceiptAt, setDismissedReceiptAt] = React.useState(() => readProfileLocal(TRIAGE_RECEIPT_DISMISSED_KEY) || '')
  const [goalEditing, setGoalEditing] = React.useState(false)
  const [goalGuideDismissed, setGoalGuideDismissed] = React.useState(() => readProfileLocal(GOAL_GUIDE_DISMISSED_KEY) === '1')
  React.useEffect(() => {
    setGoalGuideDismissed(readProfileLocal(GOAL_GUIDE_DISMISSED_KEY) === '1')
    setDismissedReceiptAt(readProfileLocal(TRIAGE_RECEIPT_DISMISSED_KEY) || '')
  }, [state.profileKey])
  const listRef = React.useRef(null)
  const topRef = React.useRef(null)
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

  const dismissTriageReceipt = React.useCallback(key => {
    if (!key) return
    setDismissedReceiptAt(key)
    writeProfileLocal(TRIAGE_RECEIPT_DISMISSED_KEY, key)
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
            {pendingOpportunities.length > 0 && (
              <button
                type="button"
                className={`ca-pending-pill${pendingDrawerOpen ? ' is-open' : ''}`}
                aria-expanded={pendingDrawerOpen}
                onClick={() => setPendingDrawerOpen(v => !v)}
              >
                <span>{t('jobs.pendingImportsPill', { count: pendingOpportunities.length })}</span>
              </button>
            )}
            <Button variant="ghost" size="sm" className="ca-nowrap-btn" onClick={handleCollectViaDsh}>
              {t('jobs.collectViaDsh')}
            </Button>
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
          {pendingDrawerOpen && pendingOpportunities.length > 0 && (
            <PendingImportsDrawer
              items={pendingOpportunities}
              act={act}
              busy={busy}
              onClose={() => setPendingDrawerOpen(false)}
            />
          )}
          {cuaLauncherOpen && (
            <CuaLauncherPanel
              config={config}
              onLaunch={opts => launchCuaCollect(opts)}
              onClose={() => setCuaLauncherOpen(false)}
            />
          )}
          {cuaGuideOpen && (
            <CuaReadinessCard
              cua={cuaCap}
              onUsePaste={() => { setCuaGuideOpen(false); setManual(true) }}
              onClose={() => setCuaGuideOpen(false)}
              onTryAnyway={onStartSession ? () => { setCuaGuideOpen(false); setCuaLauncherOpen(true) } : null}
            />
          )}
          {manual && <AddJob act={act} busy={busy} onDone={() => setManual(false)} />}
          {(() => {
            const serverReceipt = triage?.lastReceipt || null
            const activeReceipt = (serverReceipt?.at && (!lastRunReceipt?.at || serverReceipt.at >= lastRunReceipt.at))
              ? serverReceipt
              : (lastRunReceipt || serverReceipt)
            const receiptKey = activeReceipt ? (activeReceipt.at || JSON.stringify(activeReceipt.counts || {})) : ''
            if (!activeReceipt || (dismissedReceiptAt && dismissedReceiptAt === receiptKey)) return null
            return <TriageReceiptBanner receipt={activeReceipt} onDismiss={() => dismissTriageReceipt(receiptKey)} />
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
                <Button variant="outline" size="sm" onClick={handleCollectViaDsh}>{t('jobs.collectViaDsh')}</Button>
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

