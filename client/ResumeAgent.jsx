import React from 'react'
import { TextShimmer, useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiTraceCard, useElapsedSeconds } from './AiActivity.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import { resolveDefaultModelRoute, useModels } from './Composer.jsx'
import { DeepSeekMark } from './Emblems.jsx'
import GhostInput from './GhostInput.jsx'
import MarkdownProse from './MarkdownProse.jsx'
import { useMenuDismiss } from './Motion.jsx'
import { parseStyleDirective } from '../src/resume-style.mjs'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { translate } from '../src/i18n/index.mjs'

const PHASE_KEYS = new Set(['reading', 'drafting', 'gaps', 'verifying', 'ready', 'error'])
const settled = new Set(['ready', 'error'])

export function useResumeAgent(act, onVersion) {
  const [activity, setActivity] = React.useState(null)
  const inFlight = activity && !settled.has(activity.phase) ? activity.id : null

  React.useEffect(() => {
    if (!inFlight) return
    const controller = new AbortController()
    let timer
    const poll = async () => {
      try {
        const response = await fetch(`api/career-agent/resume-activity?id=${encodeURIComponent(inFlight)}`, {
          headers: { 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        const next = response.ok ? await response.json() : null
        if (next && PHASE_KEYS.has(next.phase) && !settled.has(next.phase)) {
          setActivity(current => current?.id === inFlight && !settled.has(current.phase) ? { ...current, ...next } : current)
        }
      } catch {}
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 220)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [inFlight])

  async function optimize(input) {
    const operationId = crypto.randomUUID()
    const startedAt = Date.now()
    const runner = typeof act?.background === 'function' ? act.background : act
    setActivity({ id: operationId, kind: 'tailor-resume', phase: 'reading', startedAt })
    const response = await runner('resume-optimize', { ...input, operationId }, translate(getActiveLocale(), 'agent.toastOptimizeDone'))
    if (response?.result?.id) {
      onVersion(response.result.id)
      setActivity({ id: operationId, kind: 'tailor-resume', version: response.result.id, phase: 'ready', changeCount: response.result.items?.length })
      return true
    }
    setActivity({ id: operationId, kind: 'tailor-resume', phase: 'error', error: response?.error || '' })
    return false
  }

  async function tailor(input) {
    const operationId = crypto.randomUUID()
    const startedAt = Date.now()
    const label = typeof input?.label === 'string' ? input.label : ''
    const { label: _omit, ...payload } = input ?? {}
    const runner = typeof act?.background === 'function' ? act.background : act
    setActivity({ id: operationId, kind: 'tailor-resume', phase: 'reading', label, startedAt })
    const response = await runner('tailor-resume', { ...payload, operationId }, translate(getActiveLocale(), 'agent.toastTailorDone'))
    if (response?.result?.id) {
      onVersion(response.result.id)
      setActivity({ id: operationId, kind: 'tailor-resume', version: response.result.id, phase: 'ready', label, changeCount: response.result.items?.length })
      return true
    }
    const exactError = response?.error || (typeof act?.getLastError === 'function' ? act.getLastError() : '') || ''
    setActivity({ id: operationId, kind: 'tailor-resume', phase: 'error', label, error: exactError })
    return false
  }

  return { activity, optimize, tailor, dismiss: () => setActivity(null) }
}

export function AgentTailorBanner({ activity, onDismiss }) {
  const { t } = useI18n()
  if (!activity || activity.phase === 'ready') return null
  const shortTarget = activity.label ? activity.label.slice(0, 26) + (activity.label.length > 26 ? '…' : '') : ''
  const title = activity.phase === 'error'
    ? t('agent.tailorFailed')
    : (shortTarget ? t('agent.tailorRunningTarget', { target: shortTarget }) : t('agent.tailorRunning'))

  return <div className="ca-tailor-banner-wrap">
    <AiTraceCard
      activity={activity}
      title={title}
      onDismiss={onDismiss}
    />
  </div>
}

function formatThinkingSec(ms) {
  const sec = Math.max(0.1, (Number(ms) || 0) / 1000)
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

function ThinkingDisclosure({ thinking, active, startedAt, durationMs }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(Boolean(active))
  const wasActiveRef = React.useRef(Boolean(active))
  const elapsed = useElapsedSeconds(Boolean(active), startedAt)

  React.useEffect(() => {
    if (wasActiveRef.current && !active) {
      setOpen(false)
    } else if (!wasActiveRef.current && active) {
      setOpen(true)
    }
    wasActiveRef.current = Boolean(active)
  }, [active])

  if (!thinking) return null
  const shownMs = active ? elapsed : (durationMs || elapsed)

  return (
    <div className={`ca-think-card${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ca-think-toggle"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="ca-think-head-left">
          <DeepSeekMark size={12} className={active ? 'is-pulsing' : ''} />
          <span>{active ? t('agent.thinkingActive') : t('agent.thinkingDone')}</span>
          {shownMs > 0 && <em className="ca-think-time">{formatThinkingSec(shownMs)}</em>}
        </span>
        <svg className={`ca-think-chev${open ? ' is-open' : ''}`} width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ca-think-body">
          <p>{thinking}</p>
        </div>
      )}
    </div>
  )
}

function AssistantMessageActions({ content, isLatest, disabled, onRegenerate }) {
  const { t } = useI18n()
  const { copied, onCopy } = useClipboardCopy(String(content ?? ''))

  return (
    <div className="ca-chat-msg-tools">
      <button type="button" className="ca-chat-tool-btn" onClick={onCopy}>
        {copied ? t('common.copiedTick') : t('agent.copyReply')}
      </button>
      {isLatest && onRegenerate && (
        <button type="button" className="ca-chat-tool-btn" disabled={disabled} onClick={onRegenerate}>
          {t('agent.regenerate')}
        </button>
      )}
    </div>
  )
}

const CHANGE_META = {
  add: { symbol: '+', labelKey: 'agent.changeAdd', cls: 'is-add' },
  edit: { symbol: '✎', labelKey: 'agent.changeEdit', cls: 'is-edit' },
  delete: { symbol: '−', labelKey: 'agent.changeDelete', cls: 'is-del' },
  reorder: { symbol: '↕', labelKey: 'agent.changeReorder', cls: 'is-reorder' },
}

function formatCharCount(len = 0, t) {
  const n = Number(len) || 0
  if (n >= 1000) return t('common.charCountK', { count: (n / 1000).toFixed(1).replace(/\.0$/, '') })
  return n > 0 ? t('common.charCount', { count: n }) : t('agent.fullJd')
}

function buildJobContextAttachment(job, t) {
  if (!job) return null
  const jdText = String(job.jd || '').trim()
  return {
    id: job.id || '',
    company: job.company || t('common.company'),
    title: job.title || t('common.role'),
    location: job.location || '',
    url: job.url || '',
    jdLength: jdText.length,
    jdExcerpt: jdText.slice(0, 720) + (jdText.length > 720 ? '…' : ''),
  }
}

function instantHeuristic(markdown, messages, trackedWithJd, { unmergedCount = 0, masterBehind = false, selectedJob = null, t }) {
  if (selectedJob) return t('agent.hintJob')
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content)
  if (lastAssistant?.content) {
    if (!lastAssistant.afterMarkdown) return t('agent.hintApplyAdvice')
    if (/学历|教育|education|degree/i.test(lastAssistant.content)) return t('agent.hintEducation')
    if (/量化|指标|数据|metric|quantif/i.test(lastAssistant.content)) return t('agent.hintQuantify')
    return t('agent.hintTighten')
  }
  if (masterBehind) return t('agent.hintMasterBehind')
  if (unmergedCount > 0) return t('agent.hintUnmerged', { count: unmergedCount })
  if (trackedWithJd.length > 0) return t('agent.hintTopJob', { company: trackedWithJd[0].company })
  if (markdown && markdown.length < 360) return t('agent.hintShort')
  return t('agent.hintDefault')
}

function buildDynamicResumeChips({
  markdown = '',
  template = '',
  effectiveStyle = {},
  templates = [],
  messages = [],
  selectedJob = null,
  trackedWithJd = [],
  unmergedCount = 0,
  masterBehind = false,
  onMergeEvidence,
  onRebaseBranch,
  t,
}) {
  const chips = []
  const push = chip => {
    if (!chip || chips.length >= 2 || chips.some(c => c.label === chip.label)) return
    chips.push(chip)
  }

  if (selectedJob) {
    const contextJob = buildJobContextAttachment(selectedJob, t)
    push({
      id: 'job-tailor',
      label: t('agent.chipJobTailor'),
      accent: true,
      prompt: t('agent.chipJobTailorPrompt'),
      display: t('agent.chipJobTailorDisplay'),
      contextJob,
      jobMeta: { company: selectedJob.company, title: selectedJob.title },
    })
    push({
      id: 'job-gap',
      label: t('agent.chipJobGap'),
      prompt: t('agent.chipJobGapPrompt'),
      display: t('agent.chipJobGapDisplay'),
      contextJob,
    })
    return chips
  }

  // Top toolbar already exposes master-sync and unmerged-evidence actions; keep command chips non-duplicate.
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && !m.streaming && !m.error)
  if (lastAssistant) {
    if (!lastAssistant.afterMarkdown && lastAssistant.content) {
      push({
        id: 'apply-advice',
        label: t('agent.chipApplyAdvice'),
        accent: true,
        prompt: t('agent.followApplyPrompt'),
        display: t('agent.chipApplyAdviceDisplay'),
      })
    } else if (lastAssistant.afterMarkdown) {
      push({
        id: 'tighten-more',
        label: t('agent.chipTighten15'),
        prompt: t('agent.chipTighten15Prompt'),
      })
    }
    const isCompact = effectiveStyle?.density === 'compact'
    const currentTpl = templates.find(item => item.id === template)
    if (!isCompact && markdown.length > 900) {
      push({ id: 'fit-one-page', label: t('agent.chipFitOnePage'), prompt: t('agent.chipFitOnePagePrompt') })
    } else if (currentTpl?.columns === 1) {
      push({ id: 'try-two-col', label: t('agent.chipTryTwoCol'), prompt: t('agent.chipTryTwoColPrompt') })
    } else {
      push({
        id: 'next-quantify',
        label: t('agent.chipQuantify'),
        prompt: t('agent.chipQuantifyPrompt'),
      })
    }
    return chips
  }

  const trimmed = markdown.trim()
  const hasSummary = /^##\s*(?:个人简介|个人总结|核心优势|职业定位|summary|profile|about)/im.test(trimmed)
  const isLong = trimmed.length > 1150
  const isShort = trimmed.length < 480
  const isCompact = effectiveStyle?.density === 'compact'
  const isNavy = String(effectiveStyle?.accent || '').toLowerCase() === '#1e3a5f'
  const currentTpl = templates.find(item => item.id === template)

  if (isShort || !hasSummary) {
    push({
      id: 'build-structure',
      label: hasSummary ? t('agent.chipDiagnoseMissing') : t('agent.chipAddSummary'),
      prompt: hasSummary ? t('agent.chipDiagnoseMissingPrompt') : t('agent.chipAddSummaryPrompt'),
    })
  } else {
    push({
      id: 'diagnose',
      label: t('agent.chipDiagnose'),
      prompt: t('agent.chipDiagnosePrompt'),
    })
  }

  if (trackedWithJd.length > 0 && chips.length < 2) {
    const topJob = trackedWithJd[0]
    push({
      id: 'top-job-tailor',
      label: t('agent.chipFitCompany', { company: topJob.company }),
      prompt: t('agent.chipFitCompanyPrompt'),
      display: t('agent.chipFitCompanyDisplay'),
      contextJob: buildJobContextAttachment(topJob, t),
      jobMeta: { company: topJob.company, title: topJob.title },
    })
  } else {
    push({
      id: 'polish',
      label: t('agent.chipPolish'),
      prompt: t('agent.chipPolishPrompt'),
    })
  }

  if (isLong && !isCompact) {
    push({
      id: 'compact-page',
      label: t('agent.chipFitOnePage'),
      prompt: t('agent.chipCompactPagePrompt'),
    })
  } else if (!isNavy && currentTpl?.columns === 1) {
    push({ id: 'style-refresh', label: t('agent.chipNavyTwoCol'), prompt: t('agent.chipNavyTwoColPrompt') })
  } else if (currentTpl?.columns === 2) {
    push({ id: 'style-single', label: t('agent.chipAtsSingle'), prompt: t('agent.chipAtsSinglePrompt') })
  }

  return chips
}

const changeSymbols = { add: '+', edit: '✎', delete: '−', reorder: '↕' }

const PICKER_TONES = ['blue', 'indigo', 'teal', 'amber', 'rose', 'slate']

function pickerTone(name = '') {
  let sum = 0
  for (let i = 0; i < name.length; i += 1) sum = (sum * 31 + name.charCodeAt(i)) % 997
  return PICKER_TONES[sum % PICKER_TONES.length]
}

function JobPickerMenu({ jobs, value, onChange, disabled }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const wrapRef = React.useRef(null)
  const searchRef = React.useRef(null)

  const closeMenu = React.useCallback(() => setOpen(false), [])
  useMenuDismiss(wrapRef, open, closeMenu)

  React.useEffect(() => {
    if (!open) { setFilter(''); return }
    if (jobs.length >= 4) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, jobs.length])

  const selected = jobs.find(j => j.id === value) ?? null
  const needle = filter.trim().toLowerCase()
  const matchedJobs = needle
    ? jobs.filter(j => `${j.company || ''} ${j.title || ''} ${j.location || ''}`.toLowerCase().includes(needle))
    : jobs
  const visible = matchedJobs.slice(0, 40)
  if (selected && !needle && !visible.some(j => j.id === selected.id)) {
    visible.unshift(selected)
  }

  return <div className="ca-job-picker-wrap" ref={wrapRef}>
    <button
      type="button"
      className={`ca-command-chip${selected ? ' is-selected' : ''}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(v => !v)}
    >
      <span>{selected ? t('agent.switchJob') : t('agent.attachJob')}</span>
      <svg className="ca-chip-caret" width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>

    {open && <div className="ca-job-picker-pop ca-popover-surface" role="listbox" aria-label={t('agent.pickJobAria')}>
      <div className="ca-job-picker-head">
        <span>{t('agent.pickJobHead')}</span>
        <small>{t('agent.pickJobCount', { count: jobs.length })}</small>
      </div>
      {jobs.length >= 4 && (
        <div className="ca-job-picker-search">
          <input
            ref={searchRef}
            type="search"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder={t('agent.pickJobSearchPlaceholder')}
            aria-label={t('agent.pickJobSearchAria')}
          />
        </div>
      )}
      <div className="ca-job-picker-list">
        {visible.length > 0 ? visible.slice(0, 40).map(job => {
          const active = job.id === value
          const company = job.company || t('common.company')
          return <button
            key={job.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`ca-job-picker-item${active ? ' is-active' : ''}`}
            onClick={() => { onChange(job.id); setOpen(false) }}
          >
            <CompanyAvatar company={company} url={job.url} size={28} />
            <span className="ca-job-picker-body">
              <strong>{job.title}</strong>
              <small>{[company, job.location].filter(Boolean).join(' · ')}</small>
            </span>
            {active && <svg className="ca-menu-check" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="m3 7.2 2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>}
          </button>
        }) : <p className="ca-job-picker-empty">{t('agent.pickJobEmpty')}</p>}
      </div>
      {selected && <div className="ca-job-picker-foot">
        <button type="button" className="ca-text-button" onClick={() => { onChange(''); setOpen(false) }}>
          {t('agent.detachCurrentJob')}
        </button>
      </div>}
    </div>}
  </div>
}

const CHAT_STORAGE_KEY = 'niuma.resumeChat.v1'

function loadSavedChat() {
  try {
    const raw = window.sessionStorage?.getItem(CHAT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(m => m && m.id && m.role).slice(-16) : []
  } catch {
    return []
  }
}

export function FloatingResumeCommandBar({
  markdown, template, effectiveStyle, templates = [], opportunities = [], config, busy,
  onApplyMarkdown, onStageProposal, onFocusReview, hasStagedProposal = false,
  onApplyStyleDirective, onRestoreAppearance, disabled = false,
  seedPrompt = '', onConsumeSeedPrompt,
  unmergedCount = 0, masterBehind = false, onMergeEvidence, onRebaseBranch, onFocusSnippet,
}) {
  const { t, locale } = useI18n()
  const [messages, setMessages] = React.useState(loadSavedChat)
  const [expanded, setExpanded] = React.useState(() => loadSavedChat().length > 0)
  const [fullPane, setFullPane] = React.useState(false)
  const [text, setText] = React.useState('')
  const [streaming, setStreaming] = React.useState(false)
  const [jobId, setJobId] = React.useState('')
  const [previewDraftJd, setPreviewDraftJd] = React.useState(false)
  const [expandedCtxIds, setExpandedCtxIds] = React.useState({})
  const inputRef = React.useRef(null)
  const threadRef = React.useRef(null)
  const nearBottomRef = React.useRef(true)
  const abortRef = React.useRef(null)
  const activeJobMetaRef = React.useRef(null)
  const lastTurnRef = React.useRef(null)

  React.useEffect(() => {
    try {
      const settled = messages.filter(m => !m.streaming).slice(-16)
      if (settled.length) window.sessionStorage?.setItem(CHAT_STORAGE_KEY, JSON.stringify(settled))
      else window.sessionStorage?.removeItem(CHAT_STORAGE_KEY)
    } catch {}
  }, [messages])
  const models = useModels()
  const model = config?.model || resolveDefaultModelRoute(models.rows)
  const tabModel = config?.tabModel || model
  const trackedWithJd = React.useMemo(
    () => opportunities
      .filter(job => job?.id && !job.closedAt && job.jd && job.feedback?.status !== 'dismissed')
      .slice()
      .sort((a, b) => (b.receiptCount > 0 ? 1 : 0) - (a.receiptCount > 0 ? 1 : 0) || (b.match?.score ?? 0) - (a.match?.score ?? 0)),
    [opportunities],
  )
  const selectedJob = trackedWithJd.find(job => job.id === jobId)

  React.useEffect(() => {
    if (!seedPrompt) return
    setText(seedPrompt)
    setExpanded(true)
    onConsumeSeedPrompt?.()
    window.requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) { el.focus(); el.setSelectionRange(seedPrompt.length, seedPrompt.length) }
    })
  }, [seedPrompt, onConsumeSeedPrompt])

  React.useEffect(() => {
    if (expanded && threadRef.current && nearBottomRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight
    }
  }, [messages, expanded, fullPane])

  const onThreadScroll = event => {
    const el = event.currentTarget
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 52
  }

  React.useEffect(() => () => { abortRef.current?.abort() }, [])

  const stopStreaming = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }

  const sendMessage = async (rawInput, options = {}) => {
    const trimmed = rawInput.trim()
    if (!trimmed || streaming || disabled || busy) return
    const displayContent = (options.display || trimmed).trim()
    const contextJob = options.contextJob || null
    const inheritedJob = contextJob || [...messages].reverse().find(m => m.role === 'user' && m.contextJob)?.contextJob || null
    if (options.jobMeta) activeJobMetaRef.current = options.jobMeta
    else if (contextJob) activeJobMetaRef.current = { company: contextJob.company, title: contextJob.title }

    const prevMarkdown = markdown
    const prevAppearance = { template, style: effectiveStyle }

    const directStyle = parseStyleDirective(trimmed, templates, locale)
    if (directStyle.matched && directStyle.pureStyle && !contextJob && onApplyStyleDirective) {
      onApplyStyleDirective(directStyle)
      nearBottomRef.current = true
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: displayContent },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: t('agent.styleAppliedReply', { summary: directStyle.summary }),
          appearanceSummary: directStyle.summary,
          appearanceAccent: directStyle.patch?.accent || '',
          prevAppearance,
          revertedAppearance: false,
        },
      ])
      setExpanded(true)
      setText('')
      return
    }

    lastTurnRef.current = { rawInput: trimmed, options }
    nearBottomRef.current = true

    if (!model) {
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: displayContent, ...(contextJob ? { contextJob } : {}) },
        { id: crypto.randomUUID(), role: 'assistant', error: t('agent.noModelError') },
      ])
      setExpanded(true)
      return
    }

    const userMsgId = crypto.randomUUID()
    const assistantMsgId = crypto.randomUUID()
    const historyPayload = messages
      .filter(m => !m.error && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map(m => ({
        role: m.role,
        content: m.role === 'user' && m.contextJob
          ? `${t('agent.historyJobPrefix', { company: m.contextJob.company, title: m.contextJob.title })}\n${m.content}`
          : m.content,
      }))

    const resolvedJobRecord = inheritedJob?.id
      ? opportunities.find(j => j?.id === inheritedJob.id) || null
      : null
    const initialStatus = contextJob
      ? t('agent.statusReadJob', { company: contextJob.company, title: contextJob.title, chars: formatCharCount(contextJob.jdLength, t) })
      : t('agent.statusThinking')

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: displayContent, ...(contextJob ? { contextJob } : {}) },
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        status: initialStatus,
        thinking: '',
        changes: [],
        beforeMarkdown: prevMarkdown,
        afterMarkdown: null,
        revertedResume: false,
        appearanceSummary: '',
        prevAppearance,
        revertedAppearance: false,
        streaming: true,
      },
    ])
    setExpanded(true)
    setText('')
    setStreaming(true)

    const updateAssistant = updater => {
      setMessages(prev => prev.map(item => item.id === assistantMsgId ? updater(item) : item))
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const explicitModel = config?.model || ''
      const response = await fetch('api/career-agent/resume-chat', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
        body: JSON.stringify({
          message: trimmed,
          markdown,
          template,
          style: effectiveStyle,
          history: historyPayload,
          ...(explicitModel && { model: explicitModel }),
          locale,
          ...(inheritedJob?.id ? { attachedJobId: inheritedJob.id } : {}),
          ...(resolvedJobRecord?.jd ? {
            attachedJob: {
              id: resolvedJobRecord.id,
              company: resolvedJobRecord.company || '',
              title: resolvedJobRecord.title || '',
              location: resolvedJobRecord.location || '',
              jd: resolvedJobRecord.jd,
            },
          } : {}),
        }),
      })

      if (!response.ok) {
        const failed = await response.json().catch(() => null)
        if (response.status === 404) {
          throw new Error(t('agent.backendOutdated'))
        }
        throw new Error(failed?.error || t('agent.requestFailed', { status: response.status }))
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line) continue
          let event
          try { event = JSON.parse(line) } catch { continue }

          if (event.type === 'status') {
            updateAssistant(cur => ({ ...cur, status: event.text || t('common.processingEllipsis') }))
          } else if (event.type === 'thinking') {
            updateAssistant(cur => ({
              ...cur,
              thinkingStartedAt: cur.thinkingStartedAt || Date.now(),
              thinking: `${cur.thinking || ''}${event.delta || ''}`.slice(0, 4000),
            }))
          } else if (event.type === 'text') {
            updateAssistant(cur => ({
              ...cur,
              status: '',
              thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
              content: cur.content + (event.delta || ''),
            }))
          } else if (event.type === 'tool-start') {
            const label = event.name === 'update_resume' ? t('agent.statusUpdatingResume') : t('agent.statusUpdatingStyle')
            updateAssistant(cur => ({
              ...cur,
              status: label,
              thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
            }))
          } else if (event.type === 'resume-update' && event.markdown) {
            const jobMeta = activeJobMetaRef.current
            const metaPayload = {
              source: 'ai',
              sourceKind: 'chat',
              sourceLabel: jobMeta ? `${jobMeta.company} · ${jobMeta.title}`.slice(0, 40) : t('agent.sourceChatLabel'),
              changes: Array.isArray(event.changes) ? event.changes : [],
              ...(Array.isArray(event.evidenceIds) && event.evidenceIds.length ? { evidenceIds: event.evidenceIds } : {}),
              ...(Array.isArray(event.changeProvenance) && event.changeProvenance.length ? { changeProvenance: event.changeProvenance } : {}),
              ...(inheritedJob?.id ? { opportunityId: inheritedJob.id } : {}),
              ...(jobMeta ? { title: `${jobMeta.company} · ${jobMeta.title}`.slice(0, 140) } : {}),
            }
            if (typeof onStageProposal === 'function') {
              const outcome = onStageProposal(event.markdown, metaPayload)
              updateAssistant(cur => ({
                ...cur,
                afterMarkdown: outcome === 'noop' ? null : event.markdown,
                changes: Array.isArray(event.changes) ? event.changes : cur.changes,
                stagedForReview: outcome === 'staged',
                noOpUpdate: outcome === 'noop',
                revertedResume: false,
              }))
            } else {
              onApplyMarkdown?.(event.markdown, metaPayload)
              updateAssistant(cur => ({
                ...cur,
                afterMarkdown: event.markdown,
                changes: Array.isArray(event.changes) ? event.changes : cur.changes,
                stagedForReview: false,
                noOpUpdate: false,
                revertedResume: false,
              }))
            }
          } else if (event.type === 'appearance-update') {
            onApplyStyleDirective?.({
              templateId: event.template || '',
              patch: event.reset ? { reset: true } : (event.style || {}),
            })
            updateAssistant(cur => ({
              ...cur,
              appearanceSummary: event.summary || t('agent.styleAdjusted'),
              appearanceAccent: event.style?.accent || '',
              revertedAppearance: false,
            }))
          } else if (event.type === 'error') {
            setText(cur => cur || trimmed)
            updateAssistant(cur => ({
              ...cur,
              error: event.message || t('agent.modelError'),
              retryInput: { rawInput: trimmed, options },
              status: '',
              streaming: false,
            }))
          } else if (event.type === 'done') {
            updateAssistant(cur => ({
              ...cur,
              status: '',
              streaming: false,
              thinkingMs: cur.thinkingMs || (cur.thinkingStartedAt ? Math.max(100, Date.now() - cur.thinkingStartedAt) : 0),
            }))
          }
        }
      }
      updateAssistant(cur => ({ ...cur, status: '', streaming: false }))
    } catch (reason) {
      if (reason?.name === 'AbortError') {
        updateAssistant(cur => ({ ...cur, status: '', streaming: false, content: cur.content || t('agent.stoppedReply') }))
      } else {
        setText(cur => cur || trimmed)
        updateAssistant(cur => ({
          ...cur,
          status: '',
          streaming: false,
          error: reason?.message || t('agent.connectFailed'),
          retryInput: { rawInput: trimmed, options },
        }))
      }
    } finally {
      abortRef.current = null
      activeJobMetaRef.current = null
      setStreaming(false)
    }
  }

  const submitCurrent = () => {
    if (selectedJob) {
      const note = text.trim()
      const contextJob = buildJobContextAttachment(selectedJob, t)
      const prompt = note
        ? t('agent.submitWithJobPrompt', { company: selectedJob.company, title: selectedJob.title, note })
        : t('agent.submitWithJobDefaultPrompt', { company: selectedJob.company, title: selectedJob.title })
      const display = note || t('agent.submitWithJobDefaultDisplay')
      const jobMeta = { company: selectedJob.company, title: selectedJob.title }
      setJobId('')
      setPreviewDraftJd(false)
      void sendMessage(prompt, { display, jobMeta, contextJob })
      return
    }
    activeJobMetaRef.current = null
    void sendMessage(text)
  }

  const toggleRevertResume = msg => {
    if (!msg.afterMarkdown) return
    if (msg.revertedResume) {
      onApplyMarkdown?.(msg.afterMarkdown, { source: 'ai' })
      setMessages(prev => prev.map(item => item.id === msg.id ? { ...item, revertedResume: false } : item))
    } else {
      onApplyMarkdown?.(msg.beforeMarkdown, { source: 'ai' })
      setMessages(prev => prev.map(item => item.id === msg.id ? { ...item, revertedResume: true } : item))
    }
  }

  const toggleRevertAppearance = msg => {
    if (!msg.prevAppearance) return
    onRestoreAppearance?.(msg.prevAppearance)
    setMessages(prev => prev.map(item => item.id === msg.id ? { ...item, revertedAppearance: true } : item))
  }

  React.useEffect(() => {
    const onForgotten = () => {
      abortRef.current?.abort()
      setMessages([])
      setExpanded(false)
      setFullPane(false)
    }
    window.addEventListener('niuma:source-forgotten', onForgotten)
    return () => window.removeEventListener('niuma:source-forgotten', onForgotten)
  }, [])

  const explicitTabModel = config?.tabModel || config?.model || ''
  const allowTabSuggest = config?.sendToModel === true
  const suggestContext = React.useMemo(() => ({
    enabled: allowTabSuggest && !streaming && !disabled && !busy && Boolean(tabModel),
    key: `${allowTabSuggest ? 1 : 0}:${template}:${effectiveStyle?.density}:${selectedJob?.id || ''}`,
    template,
    style: effectiveStyle,
    opportunityId: selectedJob?.id || '',
    model: explicitTabModel,
  }), [allowTabSuggest, streaming, disabled, busy, tabModel, explicitTabModel, template, effectiveStyle, selectedJob?.id])

  const fallbackHint = React.useMemo(
    () => instantHeuristic(markdown, messages, trackedWithJd, { unmergedCount, masterBehind, selectedJob, t }),
    [markdown, messages, trackedWithJd, unmergedCount, masterBehind, selectedJob, t],
  )

  const dynamicChips = React.useMemo(
    () => buildDynamicResumeChips({
      markdown, template, effectiveStyle, templates, messages, selectedJob,
      trackedWithJd, unmergedCount, masterBehind, onMergeEvidence, onRebaseBranch, t,
    }),
    [markdown, template, effectiveStyle, templates, messages, selectedJob, trackedWithJd, unmergedCount, masterBehind, onMergeEvidence, onRebaseBranch, t],
  )

  const canSend = !streaming && !disabled && !busy && (Boolean(text.trim()) || Boolean(selectedJob))
  const isFullPane = fullPane && expanded && messages.length > 0

  return <div className="ca-command-dock" data-has-chat={messages.length > 0 || undefined} data-full-pane={isFullPane || undefined}>
    {messages.length > 0 && <div className="ca-chat-panel" data-expanded={expanded}>
      <div className="ca-chat-head">
        <button type="button" className="ca-chat-toggle" onClick={() => {
          if (expanded) { setExpanded(false); setFullPane(false) }
          else setExpanded(true)
        }}>
          <DeepSeekMark size={13} className={streaming ? 'is-pulsing' : ''} />
          <span>{t('agent.partnerTitle')}</span>
          <small>{t('agent.rounds', { count: messages.filter(m => m.role === 'user').length })}</small>
          <span className="ca-chat-caret">{expanded ? t('common.collapse') : t('common.expand')}</span>
        </button>
        <div className="ca-chat-head-actions">
          {streaming && <button type="button" className="ca-text-button" onClick={stopStreaming}>{t('common.stop')}</button>}
          {!streaming && <button type="button" className="ca-text-button" onClick={() => { setMessages([]); setFullPane(false) }}>{t('common.clear')}</button>}
          <button
            type="button"
            className={`ca-chat-icon-btn${isFullPane ? ' is-active' : ''}`}
            aria-label={isFullPane ? t('agent.shrinkFullPaneAria') : t('agent.expandFullPaneAria')}
            title={isFullPane ? t('agent.shrinkFullPaneTitle') : t('agent.expandFullPaneTitle')}
            aria-pressed={isFullPane}
            onClick={() => {
              if (isFullPane) {
                setFullPane(false)
              } else {
                setExpanded(true)
                setFullPane(true)
              }
            }}
          >
            {isFullPane ? (
              <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.25 3.25v3.5h3.5M13.25 2.75l-4 4M3.25 9.25h3.5v3.5M2.75 13.25l4-4" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.75 2.75h3.5v3.5M13.25 2.75l-4.1 4.1M6.25 13.25h-3.5v-3.5M2.75 13.25l4.1-4.1" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {expanded && <div className="ca-chat-messages" ref={threadRef} onScroll={onThreadScroll} aria-live="polite">
        {messages.map((msg, msgIdx) => msg.role === 'user' ? (
          <div key={msg.id} className="ca-chat-msg ca-chat-user">
            {msg.contextJob && (
              <div className="ca-msg-ctx-wrap">
                <button
                  type="button"
                  className={`ca-msg-ctx-chip${expandedCtxIds[msg.id] ? ' is-open' : ''}`}
                  aria-expanded={Boolean(expandedCtxIds[msg.id])}
                  title={t('agent.ctxChipTitle')}
                  onClick={() => setExpandedCtxIds(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                >
                  <CompanyAvatar company={msg.contextJob.company || t('common.company')} url={msg.contextJob.url} size={15} />
                  <span className="ca-msg-ctx-title">{msg.contextJob.company} · {msg.contextJob.title}</span>
                  <span className="ca-msg-ctx-tag">{t('agent.ctxChipTag', { chars: formatCharCount(msg.contextJob.jdLength, t) })}</span>
                  <svg className={`ca-ctx-chev${expandedCtxIds[msg.id] ? ' is-open' : ''}`} width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {expandedCtxIds[msg.id] && (
                  <div className="ca-msg-ctx-drawer">
                    <div className="ca-ctx-preview-meta">
                      <span>{t('agent.ctxDrawerTitle')}</span>
                      <span>{[msg.contextJob.location, t('common.charCount', { count: msg.contextJob.jdLength || 0 })].filter(Boolean).join(' · ')}</span>
                    </div>
                    <p>{msg.contextJob.jdExcerpt || t('agent.ctxDrawerFallback')}</p>
                  </div>
                )}
              </div>
            )}
            <span className="ca-chat-user-bubble">{msg.content}</span>
          </div>
        ) : (
          <div key={msg.id} className="ca-chat-msg ca-chat-assistant">
            {msg.thinking && (
              <ThinkingDisclosure
                thinking={msg.thinking}
                active={Boolean(msg.streaming && !msg.content && !msg.afterMarkdown)}
                startedAt={msg.thinkingStartedAt}
                durationMs={msg.thinkingMs}
              />
            )}
            {msg.status && (
              <div className="ca-chat-status">
                <DeepSeekMark size={12} className="is-pulsing" />
                <TextShimmer active>{msg.status}</TextShimmer>
              </div>
            )}
            {msg.content && (
              <MarkdownProse
                text={msg.content}
                streaming={Boolean(msg.streaming)}
                onApplySnippet={streaming ? undefined : snippet => void sendMessage(
                  t('agent.applySnippetPrompt', { snippet }),
                  { display: t('agent.applySnippetDisplay') },
                )}
              />
            )}
            {msg.noOpUpdate && !msg.afterMarkdown && (
              <div className="ca-chat-action-card">
                <div className="ca-chat-action-head">
                  <span className="ca-chat-action-badge">{t('agent.actionNoOp')}</span>
                </div>
              </div>
            )}
            {msg.afterMarkdown && <div className="ca-chat-action-card">
              <div className="ca-chat-action-head">
                <span className="ca-chat-action-badge">
                  {msg.revertedResume
                    ? t('agent.actionReverted')
                    : (msg.stagedForReview && hasStagedProposal && msgIdx === messages.length - 1)
                      ? (msg.changes?.length ? t('agent.actionStagedCount', { count: msg.changes.length }) : t('agent.actionStaged'))
                      : (msg.changes?.length ? t('agent.actionAppliedCount', { count: msg.changes.length }) : t('agent.actionApplied'))}
                </span>
                <div className="ca-inline">
                  {hasStagedProposal && msgIdx === messages.length - 1 && onFocusReview && !msg.revertedResume && (
                    <button type="button" className="ca-text-button" onClick={() => { setFullPane(false); onFocusReview() }}>
                      {t('agent.focusReviewBar')}
                    </button>
                  )}
                  {!(msg.stagedForReview && hasStagedProposal && msgIdx === messages.length - 1) && (
                    <button type="button" className="ca-text-button" onClick={() => toggleRevertResume(msg)}>
                      {msg.revertedResume ? t('agent.restoreEdit') : t('agent.undoStep')}
                    </button>
                  )}
                </div>
              </div>
              {!msg.revertedResume && msg.changes?.length > 0 && <ul className="ca-chat-changes">
                {msg.changes.map((ch, idx) => {
                  const meta = CHANGE_META[ch.kind] || { symbol: '•', labelKey: 'agent.changeDefault', cls: 'is-edit' }
                  return (
                    <li key={idx} className={onFocusSnippet ? 'is-clickable' : undefined}
                      onClick={() => { setFullPane(false); onFocusSnippet?.(ch.summary) }}>
                      <em className={`ca-chat-change-pill ${meta.cls}`}>{t(meta.labelKey)}</em>
                      <span>{ch.summary}</span>
                    </li>
                  )
                })}
              </ul>}
            </div>}
            {msg.appearanceSummary && <div className="ca-chat-style-badge">
              <span className="ca-inline-mark">
                {msg.appearanceAccent ? (
                  <i className="ca-chat-swatch" style={{ background: msg.appearanceAccent }} aria-hidden="true" />
                ) : (
                  <DeepSeekMark size={12} />
                )}
                <span>{msg.appearanceSummary}</span>
              </span>
              {!msg.revertedAppearance && msg.prevAppearance && (
                <button type="button" className="ca-text-button" onClick={() => toggleRevertAppearance(msg)}>{t('agent.revertStyle')}</button>
              )}
            </div>}
            {!msg.streaming && !msg.error && msg.content && (
              <AssistantMessageActions
                content={msg.content}
                isLatest={msgIdx === messages.length - 1}
                disabled={streaming || disabled || !!busy}
                onRegenerate={msgIdx === messages.length - 1 && lastTurnRef.current
                  ? () => void sendMessage(lastTurnRef.current.rawInput, lastTurnRef.current.options)
                  : undefined}
              />
            )}
            {!msg.streaming && !msg.error && msg.content && msgIdx === messages.length - 1 && (
              <div className="ca-chat-follow-row">
                {!msg.afterMarkdown && !msg.appearanceSummary ? (
                  <>
                    <button
                      type="button"
                      className="ca-chat-follow-btn is-primary"
                      disabled={streaming || disabled || !!busy}
                      onClick={() => void sendMessage(
                        t('agent.followApplyPrompt'),
                        { display: t('agent.followApplyDisplay') },
                      )}
                    >
                      <DeepSeekMark size={12} />
                      <span>{t('agent.followApplyBtn')}</span>
                    </button>
                    <button
                      type="button"
                      className="ca-chat-follow-btn"
                      disabled={streaming || disabled || !!busy}
                      onClick={() => void sendMessage(
                        t('agent.followTightenPrompt'),
                        { display: t('agent.followTightenBtn') },
                      )}
                    >
                      {t('agent.followTightenBtn')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ca-chat-follow-btn"
                    disabled={streaming || disabled || !!busy}
                    onClick={() => void sendMessage(
                      t('agent.followReviewPrompt'),
                      { display: t('agent.followReviewBtn') },
                    )}
                  >
                    {t('agent.followReviewBtn')}
                  </button>
                )}
              </div>
            )}
            {msg.error && <div className="ca-chat-error" role="alert">
              <span>{msg.error}</span>
              {msg.retryInput && !streaming && (
                <button type="button" className="ca-text-button ca-nowrap-btn"
                  onClick={() => void sendMessage(msg.retryInput.rawInput, msg.retryInput.options)}>
                  {t('common.retry')}
                </button>
              )}
            </div>}
          </div>
        ))}
      </div>}
    </div>}

    <section className="ca-command-capsule" data-surface="resume-agent" aria-label={t('agent.commandAria')} data-busy={streaming || undefined}>
      <form onSubmit={event => { event.preventDefault(); submitCurrent() }}>
        {selectedJob && (
          <div className="ca-ctx-card">
            <div className="ca-ctx-card-row">
              <button
                type="button"
                className="ca-ctx-card-main"
                aria-expanded={previewDraftJd}
                title={t('agent.ctxDraftTitle')}
                onClick={() => setPreviewDraftJd(v => !v)}
              >
                <CompanyAvatar company={selectedJob.company || t('common.company')} url={selectedJob.url} size={17} />
                <span className="ca-ctx-card-title">{selectedJob.company} · {selectedJob.title}</span>
                <span className="ca-ctx-badge">{t('agent.ctxDraftBadge', { chars: formatCharCount(selectedJob.jd?.length || 0, t) })}</span>
                <svg className={`ca-ctx-chev${previewDraftJd ? ' is-open' : ''}`} width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="ca-ctx-remove"
                aria-label={t('agent.ctxDraftRemoveAria')}
                title={t('agent.ctxDraftRemoveAria')}
                onClick={() => { setJobId(''); setPreviewDraftJd(false) }}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {previewDraftJd && (
              <div className="ca-ctx-preview">
                <div className="ca-ctx-preview-meta">
                  <span>{t('agent.ctxDraftMeta')}</span>
                  <span>{[selectedJob.location, t('common.charCount', { count: String(selectedJob.jd || '').trim().length })].filter(Boolean).join(' · ')}</span>
                </div>
                <p>{String(selectedJob.jd || '').trim().slice(0, 640)}{String(selectedJob.jd || '').trim().length > 640 ? '…' : ''}</p>
              </div>
            )}
          </div>
        )}

        <GhostInput
          inputRef={inputRef}
          surface="resume"
          value={text}
          onChange={setText}
          onSubmit={submitCurrent}
          disabled={disabled}
          minRows={1}
          maxLength={20000}
          ariaLabel={t('agent.commandAria')}
          placeholder={selectedJob ? t('agent.placeholderWithJob') : t('agent.placeholderDefault')}
          suggestContext={suggestContext}
          fallbackSuggestion={fallbackHint}
        />

        <div className="ca-command-footer">
          <div className="ca-command-tools">
            {trackedWithJd.length > 0 && (
              <JobPickerMenu
                jobs={trackedWithJd}
                value={jobId}
                onChange={nextId => { setJobId(nextId); setPreviewDraftJd(false) }}
                disabled={streaming || disabled}
              />
            )}
            {!text && !streaming && dynamicChips.map(chip => (
              <button
                key={chip.id}
                type="button"
                className={`ca-command-hint-chip${chip.accent ? ' is-accent' : ''}`}
                disabled={disabled || !!busy}
                onClick={() => {
                  if (chip.action) { void chip.action(); return }
                  if (chip.contextJob || chip.jobMeta) {
                    setJobId('')
                    setPreviewDraftJd(false)
                  }
                  void sendMessage(chip.prompt, {
                    display: chip.display,
                    jobMeta: chip.jobMeta,
                    contextJob: chip.contextJob,
                  })
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {streaming ? (
            <button className="ca-send-btn is-stop" type="button" onClick={stopStreaming} aria-label={t('agent.stopAria')} title={t('agent.stopAria')}>
              <span className="ca-stop-square" aria-hidden="true" />
            </button>
          ) : (
            <button className="ca-send-btn" type="submit" disabled={!canSend} aria-label={t('agent.sendAria')} title={t('common.sendWithEnter')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3.5M8 3.5L3.8 7.7M8 3.5l4.2 4.2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </section>
  </div>
}
