import React from 'react'
import { Button, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiThinkingBubble } from './AiActivity.jsx'
import Composer from './Composer.jsx'
import { DistillEmblem } from './Emblems.jsx'
import { SideSheet } from './Motion.jsx'
import { useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  isProfileContextCurrent,
  profileRequestHeaders,
} from './profile-storage.js'
import { dimensionLabel, download, list, readableDate, sourceLabel, validatedLink } from './shared.js'

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

export function Icon({ name, size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

function Empty({ children, icon = 'file', action }) {
  return <div className="ca-empty"><span className="ca-empty-icon"><Icon name={icon} size={18} /></span><p>{children}</p>{action}</div>
}

export function Section({ title, aside, children }) {
  return <section className="ca-section"><div className="ca-section-head"><h2>{title}</h2>{aside}</div>{children}</section>
}

const REASON_TAG_KEYS = {
  impact: 'evidence.reasonTagImpact',
  gap: 'evidence.reasonTagGap',
  milestone: 'evidence.reasonTagMilestone',
  ownership: 'evidence.reasonTagOwnership',
}

export function Evidence({ item, config, busy, act, onResume }) {
  const { t, locale } = useI18n()
  const [sourceText, setSourceText] = React.useState('')
  const [sourceDelivery, setSourceDelivery] = React.useState('')
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
      setSourceDelivery(result?.result?.deliverySummary ?? '')
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
      {(item.reasonTag || item.reasonText) && (
        <div className="ca-ev-reason">
          {REASON_TAG_KEYS[item.reasonTag] && <Tag tone={item.reasonTag === 'gap' ? 'info' : 'neutral'}>{t(REASON_TAG_KEYS[item.reasonTag])}</Tag>}
          {item.reasonText && <span>{item.reasonText}</span>}
        </div>
      )}
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
            {sourceDelivery && (
              <div className="ca-ev-delivery">
                <strong>{t('evidence.deliveryReceiptTitle')}</strong>{'\n'}
                {sourceDelivery}
              </div>
            )}
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
            <Button variant="ghost" size="sm" disabled={!!busy}
              onClick={() => act('evidence-dismiss-taste', { id: item.id }, t('evidence.toastDismissedTaste'))}>{t('evidence.dismissTaste')}</Button>
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

export function ResumeForm({ act, busy, onDone }) {
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

const SEVERITY_SPECS = {
  concern: { labelKey: 'evidence.sentimentConcern', tone: 'warning' },
  positive: { labelKey: 'evidence.sentimentPositiveSignal', tone: 'success' },
  neutral: { labelKey: 'evidence.sentimentNeutralObs', tone: 'neutral' },
}

export function LibrarySheet({ evidence, reflections, state, config, busy, act, onResume, onSources, onClose }) {
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
            {pendingEvCount === 0 && (state?.workBricksSummary?.recentWeekCount ?? 0) > 0 && (
              <p className="ca-bricks-note">{t('evidence.bufferedBricksLine', { count: state.workBricksSummary.recentWeekCount })}</p>
            )}
          </div>
        )}
        {filteredEvidence.length > 0 && pendingEvCount === 0 && (state?.workBricksSummary?.recentWeekCount ?? 0) > 0 && (
          <p className="ca-bricks-note">{t('evidence.bufferedBricksLine', { count: state.workBricksSummary.recentWeekCount })}</p>
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
