import React from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMenuDismiss } from './Motion.jsx'
import { BranchResumeEmblem, MasterResumeEmblem } from './Emblems.jsx'
import { localizeChangeLabel, readableDate } from './shared.js'
import { getActiveLocale, useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  getActiveProfileKey,
  isProfileContextCurrent,
  profileRequestHeaders,
  readProfileLocal,
  subscribeProfileChange,
} from './profile-storage.js'

const MINI_PREVIEW_CACHE = new Map()
const PREVIEW_RAW_CACHE = new Map()
subscribeProfileChange(() => {
  MINI_PREVIEW_CACHE.clear()
  PREVIEW_RAW_CACHE.clear()
})
const MINI_PAPER_W = 176
const MINI_PAPER_H = 249
const A4_BASE_W = 794
const A4_BASE_H = 1123
const MINI_PAPER_SCALE = MINI_PAPER_W / A4_BASE_W
const MINI_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function readSavedResumeAppearance(resume = null) {
  let fallbackTemplate = 'onyx'
  let fallbackStyle
  try {
    fallbackTemplate = readProfileLocal('local.template') || 'onyx'
    const rawStyle = readProfileLocal('local.style')
    const parsed = rawStyle ? JSON.parse(rawStyle) : undefined
    fallbackStyle = parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {}
  const app = resume?.appearance && typeof resume.appearance === 'object' ? resume.appearance : null
  return {
    template: app?.template || fallbackTemplate,
    style: app?.style && typeof app.style === 'object' ? app.style : fallbackStyle,
  }
}

function escapeMiniHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function buildMiniPaperDoc({ html, css, lang }, title) {
  const miniCss = `html,body{margin:0;padding:0;background:#fff;overflow:hidden}.rr{margin:0;width:${A4_BASE_W}px}.rr-page{width:${A4_BASE_W}px;max-width:${A4_BASE_W}px;box-shadow:none!important}.rr a{pointer-events:none}`
  return `<!doctype html><html lang="${escapeMiniHtml(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeMiniHtml(MINI_PREVIEW_CSP)}"><title>${escapeMiniHtml(title)}</title><style>${String(css || '').replaceAll('</', '<\\/')}${miniCss}</style></head><body><div class="rr">${html || ''}</div></body></html>`
}

function buildFullPaperDoc({ html, css, lang }, title) {
  const fullCss = `html,body{margin:0;padding:20px 18px 28px;background:#eef0f4;min-height:100%;box-sizing:border-box}.rr{margin:0 auto;max-width:${A4_BASE_W}px}.rr-page{width:100%;max-width:${A4_BASE_W}px;background:#fff;border-radius:4px;box-shadow:0 2px 14px rgba(15,23,42,.08)!important}`
  return `<!doctype html><html lang="${escapeMiniHtml(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeMiniHtml(MINI_PREVIEW_CSP)}"><title>${escapeMiniHtml(title)}</title><style>${String(css || '').replaceAll('</', '<\\/')}${fullCss}</style></head><body><div class="rr">${html || ''}</div></body></html>`
}

function previewCacheKey(resume, template, style) {
  if (!resume?.id) return ''
  const pk = getActiveProfileKey()
  const stamp = resume.createdAt || ''
  const len = typeof resume.text === 'string' ? resume.text.length : 0
  return `${pk}:${resume.id}:${stamp}:${len}:${template}:${JSON.stringify(style || {})}`
}

async function fetchResumePreviewData(resume, template, style, signal, fallbackErr = 'Preview failed') {
  const reqCtx = captureProfileContext()
  const cacheKey = previewCacheKey(resume, template, style)
  if (PREVIEW_RAW_CACHE.has(cacheKey)) return PREVIEW_RAW_CACHE.get(cacheKey)
  const payload = { id: resume.id, title: resume.title, template, style }
  if (typeof resume.text === 'string' && resume.text.trim()) payload.text = resume.text
  const res = await fetch('api/career-agent/local-preview', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => null)
  checkProfileMismatch(res, data)
  if (!res.ok || !data?.ok || !data.result) throw new Error(data?.error || fallbackErr)
  if (isProfileContextCurrent(reqCtx)) {
    PREVIEW_RAW_CACHE.set(cacheKey, data.result)
    MINI_PREVIEW_CACHE.set(cacheKey, buildMiniPaperDoc(data.result, resume.title))
  }
  return data.result
}

export function ResumeQuickLookModal({ resume, canExportPdf, busy, onApprove, onEditResume, onClose }) {
  const { t } = useI18n()
  const { template, style } = React.useMemo(
    () => readSavedResumeAppearance(resume),
    [resume?.id, resume?.appearance?.template, JSON.stringify(resume?.appearance?.style || null)],
  )
  const cacheKey = previewCacheKey(resume, template, style)
  const [doc, setDoc] = React.useState(() => {
    const raw = cacheKey ? PREVIEW_RAW_CACHE.get(cacheKey) : null
    return raw ? buildFullPaperDoc(raw, resume.title) : ''
  })
  const [loading, setLoading] = React.useState(() => Boolean(cacheKey && !PREVIEW_RAW_CACHE.has(cacheKey)))
  const [failed, setFailed] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const dialogRef = React.useRef(null)

  React.useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    if (!node.open) {
      try { node.showModal() } catch {}
    }
    return () => {
      if (node.open) {
        try { node.close() } catch {}
      }
    }
  }, [])

  React.useEffect(() => {
    if (!resume?.id) return
    const cached = PREVIEW_RAW_CACHE.get(cacheKey)
    if (cached) {
      setDoc(buildFullPaperDoc(cached, resume.title))
      setLoading(false)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    fetchResumePreviewData(resume, template, style, controller.signal, t('jobDetail.previewFailed'))
      .then(result => {
        if (!controller.signal.aborted) {
          setDoc(buildFullPaperDoc(result, resume.title))
          setLoading(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true)
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [cacheKey, resume?.id, resume?.title, template, style])

  const downloadPdf = async () => {
    if (!resume?.id || exporting) return
    const reqCtx = captureProfileContext()
    setExporting(true)
    try {
      const res = await fetch('api/career-agent/export-pdf', {
        method: 'POST',
        credentials: 'same-origin',
        headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
        body: JSON.stringify({ id: resume.id, template, style }),
      })
      if (!res.ok) {
        const failed = await res.json().catch(() => null)
        checkProfileMismatch(res, failed)
        return
      }
      if (!isProfileContextCurrent(reqCtx)) return
      const blob = await res.blob()
      if (!isProfileContextCurrent(reqCtx)) return
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${(resume.title || 'resume').replace(/[\\/:*?"<>|]/g, '').trim() || 'resume'}.pdf`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 15_000)
    } finally {
      setExporting(false)
    }
  }

  return <dialog ref={dialogRef} className="ca-quicklook-dialog" aria-label={t('jobDetail.quickLookAria', { title: resume?.title || t('nav.resume') })}
    onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose?.() }}
    onClick={e => { if (e.target === dialogRef.current) onClose?.() }}>
    <div className="ca-quicklook-panel">
      <header className="ca-quicklook-head">
        <div className="ca-quicklook-title">
          <strong>{resume?.title || t('jobDetail.resumePreview')}{resume?.versionTag ? ` ${resume.versionTag}` : ''}</strong>
          <Tag tone={resume?.status === 'approved' ? 'success' : 'info'}>
            {resume?.status === 'approved' ? t('version.statusApproved') : t('version.statusDraft')}
          </Tag>
        </div>
        <div className="ca-inline">
          {resume?.status === 'pending' && onApprove && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void onApprove(resume.id)}>
              {t('jobDetail.approveBtn')}
            </Button>
          )}
          {canExportPdf && resume?.status === 'approved' && (
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => void downloadPdf()}>
              {exporting ? t('resume.exporting') : t('resume.exportPdf')}
            </Button>
          )}
          {resume?.id && (
            <Button variant="primary" size="sm" onClick={() => onEditResume?.(resume.id)}>
              {t('jobDetail.goEdit')}
            </Button>
          )}
          <button type="button" className="ca-quicklook-close" aria-label={t('jobDetail.closePreviewAria')} onClick={onClose}>×</button>
        </div>
      </header>
      <div className="ca-quicklook-stage">
        {doc ? (
          <iframe
            className="ca-quicklook-iframe"
            title={t('jobDetail.fullPreviewTitle', { title: resume?.title || t('nav.resume') })}
            sandbox="allow-same-origin"
            srcDoc={doc}
          />
        ) : (
          <div className="ca-quicklook-empty">
            {loading ? <span className="ca-meta">{t('jobDetail.renderingA4')}</span>
              : <span className="ca-meta">{failed ? t('jobDetail.renderFailed') : t('jobDetail.nothingToPreview')}</span>}
          </div>
        )}
      </div>
    </div>
  </dialog>
}

export function ResumeMiniPaper({ resume, canExportPdf, onOpenResume, onQuickLook }) {
  const { t } = useI18n()
  const { template, style } = React.useMemo(
    () => readSavedResumeAppearance(resume),
    [resume?.id, resume?.appearance?.template, JSON.stringify(resume?.appearance?.style || null)],
  )
  const cacheKey = previewCacheKey(resume, template, style)
  const [doc, setDoc] = React.useState(() => (cacheKey ? MINI_PREVIEW_CACHE.get(cacheKey) || '' : ''))
  const [loading, setLoading] = React.useState(() => Boolean(cacheKey && !MINI_PREVIEW_CACHE.has(cacheKey)))
  const [failed, setFailed] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  React.useEffect(() => {
    if (!resume?.id) {
      setDoc('')
      setLoading(false)
      setFailed(false)
      return
    }
    const cached = MINI_PREVIEW_CACHE.get(cacheKey)
    if (cached) {
      setDoc(cached)
      setLoading(false)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    fetchResumePreviewData(resume, template, style, controller.signal, t('jobDetail.previewFailed'))
      .then(result => {
        const htmlDoc = buildMiniPaperDoc(result, resume.title)
        if (!controller.signal.aborted) {
          setDoc(htmlDoc)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true)
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [cacheKey, resume?.id, resume?.title, template, style])

  const downloadPdf = async () => {
    if (!resume?.id || exporting) return
    const reqCtx = captureProfileContext()
    setExporting(true)
    try {
      const res = await fetch('api/career-agent/export-pdf', {
        method: 'POST',
        credentials: 'same-origin',
        headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
        body: JSON.stringify({ id: resume.id, template, style }),
      })
      if (!res.ok) {
        const failed = await res.json().catch(() => null)
        checkProfileMismatch(res, failed)
        return
      }
      if (!isProfileContextCurrent(reqCtx)) return
      const blob = await res.blob()
      if (!isProfileContextCurrent(reqCtx)) return
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${(resume.title || 'resume').replace(/[\\/:*?"<>|]/g, '').trim() || 'resume'}.pdf`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 15_000)
    } finally {
      setExporting(false)
    }
  }

  return <div className="ca-mini-paper-col">
    <button type="button" className="ca-mini-paper-frame"
      disabled={!resume?.id}
      title={resume ? t('jobDetail.quickLookBtnTitle', { title: resume.title }) : t('jobDetail.noPreviewableResume')}
      onClick={() => resume?.id && (onQuickLook ? onQuickLook(resume) : onOpenResume?.(resume.id))}>
      {doc ? (
        <iframe
          className="ca-mini-paper-iframe"
          title={t('version.previewAria', { title: resume?.title || t('nav.resume') })}
          sandbox="allow-same-origin"
          srcDoc={doc}
          tabIndex={-1}
          style={{ width: `${A4_BASE_W}px`, height: `${A4_BASE_H}px`, transform: `scale(${MINI_PAPER_SCALE})` }}
        />
      ) : (
        <div className="ca-mini-paper-placeholder">
          {loading ? (
            <div className="ca-mini-paper-skeleton" aria-label={t('jobDetail.generatingPreviewAria')}>
              <span className="is-head" />
              <span className="is-sub" />
              <span className="is-line" />
              <span className="is-line is-short" />
              <span className="is-line" />
              <span className="is-line is-med" />
            </div>
          ) : (
            <span className="ca-meta">{failed ? t('jobDetail.cannotPreview') : t('jobDetail.noResume')}</span>
          )}
        </div>
      )}
      {resume?.id && <span className="ca-mini-paper-hover-pill">{t('jobDetail.viewFullResume')}</span>}
    </button>
    {resume?.id && (
      <div className="ca-mini-paper-tools">
        <button type="button" className="ca-mini-tool-btn" onClick={() => onOpenResume?.(resume.id)}>
          {t('jobDetail.editResume')}
        </button>
        {canExportPdf && resume.status === 'approved' ? (
          <button type="button" className="ca-mini-tool-btn" disabled={exporting} onClick={() => void downloadPdf()}>
            {exporting ? t('resume.exporting') : t('resume.exportPdf')}
          </button>
        ) : (
          <button type="button" className="ca-mini-tool-btn" onClick={() => onOpenResume?.(resume.id)}>
            {resume.status === 'approved' ? t('jobDetail.openPreview') : t('jobDetail.goApprove')}
          </button>
        )}
      </div>
    )}
  </div>
}

export function ResumeSelectMenu({ pickerModel, choices = [], selectedId = '', onSelect, timezone, compact = false }) {
  const { t, locale } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [showHistory, setShowHistory] = React.useState(false)
  const rootRef = React.useRef(null)
  const tailored = pickerModel?.tailoredOptions ?? choices.filter(c => c.isTailored)
  const masters = pickerModel?.masterOptions ?? choices.filter(c => !c.isTailored)
  const history = pickerModel?.historyOptions ?? []
  const allItems = pickerModel?.allOptions ?? choices
  const active = allItems.find(c => c.id === selectedId) || allItems[0] || null

  const closeResumeMenu = React.useCallback(() => setOpen(false), [])
  useMenuDismiss(rootRef, open, closeResumeMenu)

  React.useEffect(() => {
    if (!open) setShowHistory(false)
  }, [open])

  if (!allItems.length) {
    return <span className="ca-meta">{t('jobDetail.noResumeVersions')}</span>
  }

  const badgeFor = item => {
    if (item.isTailored) return { label: item.status === 'approved' ? t('version.tailoredApproved') : t('version.tailoredDraft'), tone: 'is-tailored' }
    if (item.status === 'approved') return { label: t('version.statusApproved'), tone: 'is-approved' }
    return { label: t('version.statusDraft'), tone: 'is-draft' }
  }

  const activeBadge = active ? badgeFor(active) : null

  const metaLineFor = item => {
    const parts = []
    if (item.isCurrentEditor) parts.push(t('version.currentEditing'))
    if (item.isDefaultMaster) parts.push(t('version.defaultMaster'))
    if (item.lineage) parts.push(localizeChangeLabel(item.lineage, t))
    if (item.masterBehind) parts.push(t('version.masterBehindPlain'))
    if (item.changeLabel && !item.isTailored && item.changeLabel !== '已定稿主干') parts.push(localizeChangeLabel(item.changeLabel, t))
    if (item.createdAt) parts.push(readableDate(item.createdAt, timezone, locale))
    return parts.join(' · ')
  }

  const renderOption = item => {
    const isCurrent = item.id === active?.id
    const badge = badgeFor(item)
    const meta = metaLineFor(item)
    return <button key={item.id} type="button" role="option" aria-selected={isCurrent}
      className={`ca-resume-select-opt${isCurrent ? ' is-active' : ''}`}
      onClick={() => { onSelect(item.id); setOpen(false) }}>
      <span className="ca-resume-select-emblem" aria-hidden="true">
        {item.isTailored
          ? <BranchResumeEmblem size={26} />
          : <MasterResumeEmblem size={26} isDefault={Boolean(item.isDefaultMaster)} />}
      </span>
      <span className="ca-resume-select-opt-main">
        <span className="ca-resume-select-opt-head">
          <span className="ca-resume-select-opt-title">{item.title}</span>
          {item.versionTag && <span className="ca-resume-ver-chip">{item.versionTag}</span>}
        </span>
        {meta && <span className="ca-resume-select-opt-meta">{meta}</span>}
      </span>
      <span className={`ca-resume-select-badge ${badge.tone}`}>{badge.label}</span>
      {isCurrent && <span className="ca-resume-select-check" aria-hidden="true">✓</span>}
    </button>
  }

  const renderGroup = (title, items) => items.length > 0 && (
    <div className="ca-resume-select-group" role="group" aria-label={title}>
      <div className="ca-resume-select-group-title">{title}</div>
      {items.map(renderOption)}
    </div>
  )

  const singleChoice = allItems.length <= 1
  const triggerContent = <>
    <span className="ca-resume-select-icon" aria-hidden="true">
      {active?.isTailored
        ? <BranchResumeEmblem size={compact ? 20 : 24} />
        : <MasterResumeEmblem size={compact ? 20 : 24} isDefault={Boolean(active?.isDefaultMaster)} />}
    </span>
    {activeBadge && <span className={`ca-resume-select-badge ${activeBadge.tone}`}>{activeBadge.label}</span>}
    <span className="ca-resume-select-title">{active?.title || t('jobDetail.chooseResume')}</span>
    {active?.versionTag && <span className="ca-resume-ver-chip">{active.versionTag}</span>}
    {!singleChoice && (
      <svg className="ca-resume-select-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </>

  return <div ref={rootRef} className={`ca-resume-select${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}>
    {singleChoice ? (
      <div className="ca-resume-select-trigger is-single" role="status" aria-label={active?.title || t('jobDetail.chooseResume')}>
        {triggerContent}
      </div>
    ) : (
      <button type="button" className="ca-resume-select-trigger" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(v => !v)}>
        {triggerContent}
      </button>
    )}
    {open && (
      <div className="ca-resume-select-popover" role="listbox" aria-label={t('jobDetail.chooseResumeAria')}>
        {renderGroup(t('jobDetail.groupTailored'), tailored)}
        {renderGroup(t('jobDetail.groupMasters'), masters)}
        {history.length > 0 && (
          <div className="ca-resume-select-group ca-resume-select-history">
            <button type="button" className="ca-resume-history-toggle" aria-expanded={showHistory}
              onClick={() => setShowHistory(v => !v)}>
              <span>{t('jobDetail.groupHistory', { count: history.length })}</span>
              <svg className={`ca-resume-select-chevron${showHistory ? ' is-open' : ''}`} width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showHistory && history.map(renderOption)}
          </div>
        )}
      </div>
    )}
  </div>
}

