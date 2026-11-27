import React from 'react'
import { BranchResumeEmblem, MasterResumeEmblem } from './Emblems.jsx'
import { useMenuDismiss } from './Motion.jsx'
import { getActiveLocale, useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  getActiveProfileKey,
  isProfileContextCurrent,
  profileRequestHeaders,
  readProfileLocal,
} from './profile-storage.js'
import { localizeChangeLabel, readableDate } from './shared.js'
import { isArchivedResume, organizeResumeVersions } from '../src/resume-versions.mjs'

export const VERSION_HOVER_PREVIEW_CACHE = new Map()
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

export default function VersionMenu({
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

