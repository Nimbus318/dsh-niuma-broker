import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import CompanyAvatar from './CompanyAvatar.jsx'
import { BranchResumeEmblem, MasterResumeEmblem } from './Emblems.jsx'
import { buildResumeGitGraph } from '../src/resume-graph.mjs'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { localizeChangeLabel } from './shared.js'

const ROW_H = 54
const LANE_W = 22
const PAD_X = 16
const MINI_W = 216
const MINI_H = 264
const A4_W = 794
const MINI_SCALE = MINI_W / A4_W
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const GRAPH_PREVIEW_CACHE = new Map()
if (typeof window !== 'undefined') {
  window.addEventListener('niuma:source-forgotten', () => GRAPH_PREVIEW_CACHE.clear())
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function buildMiniDoc({ html, css, lang }, title) {
  const miniCss = `html,body{margin:0;padding:0;background:#fff;overflow:hidden}.rr{margin:0;width:${A4_W}px}.rr-page{width:${A4_W}px;max-width:${A4_W}px;box-shadow:none!important}.rr a{pointer-events:none}`
  return `<!doctype html><html lang="${escapeHtml(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(PREVIEW_CSP)}"><title>${escapeHtml(title)}</title><style>${String(css || '').replaceAll('</', '<\\/')}${miniCss}</style></head><body><div class="rr">${html || ''}</div></body></html>`
}

function edgePath(edge) {
  const x1 = PAD_X + edge.fromLane * LANE_W
  const y1 = edge.fromRow * ROW_H + ROW_H / 2
  const x2 = PAD_X + edge.toLane * LANE_W
  const y2 = edge.toRow * ROW_H + ROW_H / 2
  if (edge.fromLane === edge.toLane) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  const dy = y2 - y1
  if (edge.kind === 'fork' && dy > ROW_H * 1.15) {
    const bendY = y2 - ROW_H * 0.85
    const ctrl = ROW_H * 0.48
    return `M ${x1} ${y1} L ${x1} ${bendY} C ${x1} ${bendY + ctrl}, ${x2} ${y2 - ctrl}, ${x2} ${y2}`
  }
  const ctrl = Math.max(20, Math.min(44, dy * 0.5))
  return `M ${x1} ${y1} C ${x1} ${y1 + ctrl}, ${x2} ${y2 - ctrl}, ${x2} ${y2}`
}

function MiniA4Preview({ resume, template = 'onyx', style }) {
  const { t } = useI18n()
  const cacheKey = resume?.id ? `${resume.id}:${resume.updatedAt || resume.createdAt || ''}:${template}:${JSON.stringify(style || {})}` : ''
  const [doc, setDoc] = React.useState(() => (cacheKey && GRAPH_PREVIEW_CACHE.get(cacheKey)) || '')
  const [loading, setLoading] = React.useState(() => Boolean(cacheKey && !GRAPH_PREVIEW_CACHE.has(cacheKey)))

  React.useEffect(() => {
    if (!resume?.id) { setDoc(''); setLoading(false); return }
    const cached = GRAPH_PREVIEW_CACHE.get(cacheKey)
    if (cached) { setDoc(cached); setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    const payload = { id: resume.id, title: resume.title || t('template.previewFrameTitle'), template, style }
    if (typeof resume.text === 'string' && resume.text.trim()) payload.text = resume.text
    fetch('api/career-agent/local-preview', {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
      body: JSON.stringify(payload),
    })
      .then(async res => {
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.ok || !data.result) throw new Error('preview failed')
        const htmlDoc = buildMiniDoc(data.result, resume.title || t('nav.resume'))
        GRAPH_PREVIEW_CACHE.set(cacheKey, htmlDoc)
        if (!controller.signal.aborted) {
          setDoc(htmlDoc)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [cacheKey, resume?.id, resume?.title, template, style, t])

  return (
    <div className="ca-graph-preview-frame" style={{ width: `${MINI_W}px`, height: `${MINI_H}px` }}>
      {doc ? (
        <iframe
          title={t('graph.previewTitle', { title: resume?.title || t('nav.resume') })}
          srcDoc={doc}
          sandbox=""
          tabIndex={-1}
          style={{
            width: `${A4_W}px`,
            height: `${Math.round(MINI_H / MINI_SCALE)}px`,
            transform: `scale(${MINI_SCALE})`,
            transformOrigin: 'top left',
            border: 0,
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div className="ca-graph-preview-skeleton">
          <span>{loading ? t('graph.previewRendering') : t('graph.previewEmpty')}</span>
        </div>
      )}
    </div>
  )
}

export default function ResumeGraphModal({
  resumes = [],
  defaultMasterTrackId = '',
  opportunities = [],
  currentId = '',
  timezone,
  template = 'onyx',
  style,
  initialFilter = 'all',
  busy = '',
  onSelectVersion,
  onBranchMaster,
  onSetDefault,
  onRebase,
  onArchive,
  onRestore,
  onDeleteArchived,
  onClose,
}) {
  const { t, bcp47, formatShortDate } = useI18n()
  const dialogRef = React.useRef(null)
  const [filter, setFilter] = React.useState(initialFilter)
  const [selectedId, setSelectedId] = React.useState(currentId)
  const [hoveredId, setHoveredId] = React.useState('')
  const [branchingFromId, setBranchingFromId] = React.useState('')
  const [branchTitle, setBranchTitle] = React.useState('')
  const [confirmDeleteId, setConfirmDeleteId] = React.useState('')

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

  const graph = React.useMemo(
    () => buildResumeGitGraph(resumes, {
      defaultMasterTrackId,
      opportunities,
      currentId,
      filter: filter === 'archived' ? 'all' : filter,
    }),
    [resumes, defaultMasterTrackId, opportunities, currentId, filter],
  )

  const oppById = React.useMemo(
    () => new Map((Array.isArray(opportunities) ? opportunities : []).filter(Boolean).map(o => [o.id, o])),
    [opportunities],
  )

  const nodeById = React.useMemo(() => new Map(graph.nodes.map(n => [n.id, n])), [graph.nodes])
  const archivedById = React.useMemo(() => new Map(graph.archived.map(a => [a.id, a])), [graph.archived])

  const activeNode = filter === 'archived'
    ? null
    : (nodeById.get(hoveredId) || nodeById.get(selectedId) || nodeById.get(currentId) || graph.nodes[0] || null)

  const activeArchived = filter === 'archived'
    ? (archivedById.get(hoveredId) || archivedById.get(selectedId) || graph.archived[0] || null)
    : null

  const focusNodeId = activeNode?.id || ''
  const connectedIds = React.useMemo(() => {
    if (!activeNode) return null
    const set = new Set([activeNode.id])
    if (activeNode.sameTrackParentId) set.add(activeNode.sameTrackParentId)
    if (activeNode.forkFromId) set.add(activeNode.forkFromId)
    if (activeNode.rebaseFromId) set.add(activeNode.rebaseFromId)
    for (const edge of graph.edges) {
      if (edge.toId === activeNode.id) set.add(edge.fromId)
    }
    return set
  }, [activeNode, graph.edges])

  const trackRevisionCount = activeNode
    ? graph.nodes.filter(n => n.trackKey === activeNode.trackKey).length
    : 0
  const isSoleMaster = Boolean(activeNode?.isMaster && graph.counts.masters <= 1)
  const canArchiveSingle = Boolean(
    activeNode
    && !(activeNode.isMaster && graph.counts.masters <= 1 && trackRevisionCount <= 1),
  )
  const canArchiveTrack = Boolean(activeNode && !isSoleMaster)
  const canSquashOlder = Boolean(activeNode && trackRevisionCount >= 2)

  const svgW = Math.max(46, PAD_X * 2 + Math.max(0, graph.laneCount - 1) * LANE_W)
  const svgH = Math.max(ROW_H, graph.nodes.length * ROW_H)

  const submitBranchMaster = async event => {
    event.preventDefault()
    const clean = branchTitle.trim()
    if (!clean || !branchingFromId || !onBranchMaster) return
    await onBranchMaster(branchingFromId, clean)
    setBranchingFromId('')
    setBranchTitle('')
    onClose()
  }

  const handleArchiveAction = async (targetId, scope) => {
    if (!onArchive) return
    await onArchive(targetId, scope)
    setBranchingFromId('')
  }

  return (
    <dialog
      ref={dialogRef}
      className="ca-graph-dialog"
      lang={bcp47}
      aria-label={t('graph.title')}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === dialogRef.current) onClose() }}
    >
      <div className="ca-graph-shell">
        <header className="ca-graph-head">
          <div className="ca-graph-head-left">
            <span className="ca-graph-head-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="11.5" cy="6.2" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                <path d="M4.5 5.3v5.4M11.5 8v1.1c0 1.8-1.4 3.2-3.2 3.2H6.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              </svg>
            </span>
            <h2>{t('graph.title')}</h2>
            <span className="ca-graph-stats">
              {t('graph.stats', { masters: graph.counts.masters, branches: graph.counts.branches, total: graph.counts.total })}
            </span>
          </div>

          <div className="ca-graph-head-right">
            <div className="ca-graph-legend" aria-hidden="true">
              <span><i className="is-solid" />{t('graph.legendApproved')}</span>
              <span><i className="is-hollow" />{t('graph.legendDraft')}</span>
              <span><i className="is-dashed" />{t('graph.legendRebase')}</span>
            </div>
            <button type="button" className="ca-followup-close" aria-label={t('graph.closeAria')} onClick={onClose}>×</button>
          </div>
        </header>

        <div className="ca-graph-filters" role="tablist" aria-label={t('graph.filterAria')}>
          <button type="button" role="tab" aria-selected={filter === 'all'}
            className={`ca-graph-filter-pill${filter === 'all' ? ' is-active' : ''}`}
            onClick={() => { setFilter('all'); setHoveredId('') }}>
            {t('graph.filterAll')} <b>{graph.counts.total}</b>
          </button>
          <button type="button" role="tab" aria-selected={filter === 'masters'}
            className={`ca-graph-filter-pill${filter === 'masters' ? ' is-active' : ''}`}
            onClick={() => { setFilter('masters'); setHoveredId('') }}>
            {t('graph.filterMasters')} <b>{graph.counts.masters}</b>
          </button>
          <button type="button" role="tab" aria-selected={filter === 'branches'}
            className={`ca-graph-filter-pill${filter === 'branches' ? ' is-active' : ''}`}
            onClick={() => { setFilter('branches'); setHoveredId('') }}>
            {t('graph.filterBranches')} <b>{graph.counts.branches}</b>
          </button>
          {graph.counts.behind > 0 && (
            <button type="button" role="tab" aria-selected={filter === 'behind'}
              className={`ca-graph-filter-pill is-warn${filter === 'behind' ? ' is-active' : ''}`}
              onClick={() => { setFilter('behind'); setHoveredId('') }}>
              {t('graph.filterBehind')} <b>{graph.counts.behind}</b>
            </button>
          )}
          <button type="button" role="tab" aria-selected={filter === 'archived'}
            className={`ca-graph-filter-pill is-quiet${filter === 'archived' ? ' is-active' : ''}`}
            onClick={() => { setFilter('archived'); setHoveredId(''); setConfirmDeleteId('') }}>
            {t('graph.filterArchived')} <b>{graph.counts.archived}</b>
          </button>
        </div>

        <div className="ca-graph-split">
          <div className="ca-graph-canvas" onMouseLeave={() => setHoveredId('')}>
            {filter === 'archived' ? (
              graph.archived.length > 0 ? (
                <div className="ca-graph-archived-list">
                  {graph.archived.map(entry => {
                    const selected = activeArchived?.id === entry.id
                    const opp = entry.raw?.opportunityId ? oppById.get(entry.raw.opportunityId) : null
                    return (
                      <div
                        key={entry.id}
                        className={`ca-graph-archived-row${selected ? ' is-selected' : ''}`}
                        onMouseEnter={() => setHoveredId(entry.id)}
                        onClick={() => setSelectedId(entry.id)}
                      >
                        <div className="ca-graph-archived-left">
                          {entry.isMaster
                            ? <MasterResumeEmblem size={24} isDefault={false} />
                            : (opp ? <CompanyAvatar company={opp.company} url={opp.url} size={24} /> : <BranchResumeEmblem size={24} />)}
                          <div className="ca-graph-archived-copy">
                            <strong>{entry.title}</strong>
                            <small>
                              {[
                                entry.isMaster ? t('version.masterTracks') : t('graph.filterBranches'),
                                localizeChangeLabel(entry.changeLabel, t),
                                entry.archivedAt ? t('graph.archivedAt', { time: formatShortDate(entry.archivedAt, timezone) }) : '',
                              ].filter(Boolean).join(' · ')}
                            </small>
                          </div>
                        </div>
                        <div className="ca-graph-archived-actions">
                          {onRestore && (
                            <button type="button" className="ca-graph-mini-btn is-restore" disabled={!!busy}
                              onClick={e => { e.stopPropagation(); void onRestore(entry.id, 'version') }}>
                              {t('common.restore')}
                            </button>
                          )}
                          {onDeleteArchived && (
                            confirmDeleteId === entry.id ? (
                              <button type="button" className="ca-graph-mini-btn is-danger" disabled={!!busy}
                                onClick={e => { e.stopPropagation(); setConfirmDeleteId(''); void onDeleteArchived(entry.id) }}>
                                {t('graph.confirmPermanentDelete')}
                              </button>
                            ) : (
                              <button type="button" className="ca-graph-mini-btn" disabled={!!busy}
                                onClick={e => { e.stopPropagation(); setConfirmDeleteId(entry.id) }}>
                                {t('graph.permanentDelete')}
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="ca-graph-empty">
                  <p>{t('graph.emptyArchivedTitle')}</p>
                  <small>{t('graph.emptyArchivedHint')}</small>
                </div>
              )
            ) : graph.nodes.length > 0 ? (
              <div className="ca-graph-board" style={{ minHeight: `${svgH}px` }}>
                <svg
                  className="ca-graph-svg"
                  width={svgW}
                  height={svgH}
                  viewBox={`0 0 ${svgW} ${svgH}`}
                  aria-hidden="true"
                >
                  {graph.edges.map(edge => {
                    const emphasized = !focusNodeId
                      || edge.fromId === focusNodeId
                      || edge.toId === focusNodeId
                      || (activeNode && nodeById.get(edge.fromId)?.trackKey === activeNode.trackKey && nodeById.get(edge.toId)?.trackKey === activeNode.trackKey)
                    return (
                      <path
                        key={edge.id}
                        d={edgePath(edge)}
                        fill="none"
                        stroke={edge.color}
                        strokeWidth={edge.kind === 'commit' ? 2.1 : 1.75}
                        strokeDasharray={edge.kind === 'rebase' ? '4 3' : undefined}
                        strokeLinecap="round"
                        opacity={emphasized ? 0.92 : 0.34}
                        className="ca-graph-edge"
                      />
                    )
                  })}
                  {graph.nodes.map(node => {
                    const cx = PAD_X + node.lane * LANE_W
                    const cy = node.row * ROW_H + ROW_H / 2
                    const isFocused = node.id === focusNodeId
                    const isConnected = !connectedIds || connectedIds.has(node.id)
                    const isApproved = node.status === 'approved'
                    return (
                      <g key={node.id} opacity={isConnected ? 1 : 0.45}>
                        {(node.isCurrent || isFocused) && (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={node.isCurrent ? 9.5 : 8.5}
                            fill={node.color}
                            opacity={node.isCurrent ? 0.16 : 0.11}
                          />
                        )}
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isApproved ? 5.3 : 5.1}
                          fill={isApproved ? node.color : 'var(--ca-bg)'}
                          stroke={isApproved ? 'var(--ca-bg)' : node.color}
                          strokeWidth={isApproved ? 2 : 2.2}
                        />
                        {!isApproved && (
                          <circle cx={cx} cy={cy} r={2} fill={node.color} />
                        )}
                      </g>
                    )
                  })}
                </svg>

                <div className="ca-graph-rows" role="listbox" aria-label={t('graph.nodesAria')}>
                  {graph.nodes.map(node => {
                    const isSelected = activeNode?.id === node.id
                    const showTrackPill = node.isHead || !node.sameTrackParentId || node.isCurrent
                    const shortBranch = node.isMaster
                      ? (node.isDefaultMaster ? t('graph.defaultMasterPrefix', { title: node.trackTitle }) : node.trackTitle)
                      : (node.company ? `${node.company}${node.jobTitle ? ` · ${node.jobTitle}` : ''}` : node.branchLabel)
                    const sourceRef = `${node.sourceTrackTitle}${node.sourceBaseVersion ? ` v${node.sourceBaseVersion}` : ''}`
                    const subMeta = [
                      node.origin === 'rebase' && node.sourceTrackTitle
                        ? t('graph.syncedFrom', { title: sourceRef })
                        : (!node.sameTrackParentId && node.sourceTrackTitle
                          ? t('graph.forkedFrom', { title: sourceRef })
                          : ''),
                      node.summary || '',
                    ].filter(Boolean).join(' · ')

                    return (
                      <button
                        key={node.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`ca-graph-row${isSelected ? ' is-selected' : ''}${node.isCurrent ? ' is-current' : ''}`}
                        style={{ height: `${ROW_H}px`, paddingLeft: `${svgW + 6}px` }}
                        onMouseEnter={() => setHoveredId(node.id)}
                        onClick={() => { setSelectedId(node.id); setBranchingFromId('') }}
                        onDoubleClick={() => { onSelectVersion?.(node.id); onClose() }}
                      >
                        <div className="ca-graph-row-top">
                          {showTrackPill && (
                            <span
                              className="ca-graph-branch-tag"
                              style={{ '--lane-color': node.color }}
                              title={shortBranch}
                            >
                              <i aria-hidden="true" />
                              <span>{shortBranch}</span>
                            </span>
                          )}
                          <span className="ca-graph-ver-chip">{node.versionTag}</span>
                          {node.isCurrent && <span className="ca-graph-head-pill">{t('version.current')}</span>}
                          <span className="ca-graph-change-text">{localizeChangeLabel(node.changeLabel, t)}</span>
                          {node.masterBehind && node.isHead && (
                            <span className="ca-graph-drift-chip">{t('version.masterUpdatedTo', { version: node.masterLatestVersion })}</span>
                          )}
                          <span className="ca-graph-time">{formatShortDate(node.sortTime, timezone)}</span>
                        </div>
                        <div className="ca-graph-row-sub">
                          <span className="ca-graph-row-sub-text">
                            {subMeta || (node.status === 'approved' ? t('graph.approvedSnapshot') : t('graph.autoSaveDraft'))}
                          </span>
                          <span className={`ca-graph-status-dot ${node.status === 'approved' ? 'is-approved' : 'is-draft'}`}>
                            {node.status === 'approved' ? t('version.statusApprovedShort') : t('version.statusDraft')}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <div className="ca-graph-empty">
                <p>{t('graph.emptyFiltered')}</p>
              </div>
            )}
          </div>

          <aside className="ca-graph-inspector" aria-label={t('graph.inspectorAria')}>
            {activeNode ? (
              <>
                <div className="ca-graph-ins-head">
                  <div className="ca-graph-ins-title-row">
                    {activeNode.isMaster ? (
                      <MasterResumeEmblem size={26} isDefault={activeNode.isDefaultMaster} />
                    ) : (() => {
                      const opp = activeNode.opportunityId ? oppById.get(activeNode.opportunityId) : null
                      return opp
                        ? <CompanyAvatar company={opp.company} url={opp.url} size={26} />
                        : <BranchResumeEmblem size={26} />
                    })()}
                    <div className="ca-graph-ins-title-copy">
                      <strong>{activeNode.branchLabel}</strong>
                      <small>
                        {activeNode.versionTag} · {localizeChangeLabel(activeNode.changeLabel, t)} · {activeNode.status === 'approved' ? t('version.statusApproved') : t('version.statusDraft')}
                      </small>
                    </div>
                  </div>

                  {(activeNode.forkFromId || activeNode.rebaseFromId || activeNode.masterBehind) && (
                    <div className="ca-graph-ins-lineage">
                      {activeNode.forkFromId && nodeById.has(activeNode.forkFromId) && (
                        <button type="button" className="ca-graph-lineage-link"
                          onClick={() => setSelectedId(activeNode.forkFromId)}>
                          {t('graph.inspectorForkedFrom', { title: nodeById.get(activeNode.forkFromId).trackTitle, tag: nodeById.get(activeNode.forkFromId).versionTag })}
                        </button>
                      )}
                      {activeNode.rebaseFromId && nodeById.has(activeNode.rebaseFromId) && (
                        <button type="button" className="ca-graph-lineage-link is-rebase"
                          onClick={() => setSelectedId(activeNode.rebaseFromId)}>
                          {t('graph.inspectorSyncedFrom', { title: nodeById.get(activeNode.rebaseFromId).trackTitle, tag: nodeById.get(activeNode.rebaseFromId).versionTag })}
                        </button>
                      )}
                      {activeNode.masterBehind && (
                        <span className="ca-graph-ins-drift">
                          {t('graph.inspectorDrift', { version: activeNode.masterLatestVersion })}
                        </span>
                      )}
                    </div>
                  )}

                  {activeNode.summary && (
                    <p className="ca-graph-ins-summary">{activeNode.summary}</p>
                  )}
                </div>

                <div className="ca-graph-ins-preview">
                  <MiniA4Preview resume={activeNode.raw} template={template} style={style} />
                </div>

                <div className="ca-graph-ins-actions">
                  {branchingFromId === activeNode.id ? (
                    <form className="ca-graph-branch-form" onSubmit={e => void submitBranchMaster(e)}>
                      <input
                        autoFocus
                        maxLength={80}
                        value={branchTitle}
                        onChange={e => setBranchTitle(e.target.value)}
                        placeholder={t('graph.branchInputPlaceholder')}
                      />
                      <div className="ca-graph-branch-form-btns">
                        <Button type="submit" variant="primary" size="sm" disabled={!branchTitle.trim() || !!busy}>{t('graph.create')}</Button>
                        <Button variant="ghost" size="sm" onClick={() => setBranchingFromId('')}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={activeNode.isCurrent}
                        onClick={() => { onSelectVersion?.(activeNode.id); onClose() }}
                      >
                        {activeNode.isCurrent ? t('graph.currentlyEditing') : t('graph.openForEdit')}
                      </Button>

                      <div className="ca-graph-ins-btn-row">
                        {activeNode.masterBehind && onRebase && (
                          <Button variant="outline" size="sm" disabled={!!busy}
                            onClick={() => { onClose(); void onRebase(activeNode.id) }}>
                            {t('version.syncMaster')}
                          </Button>
                        )}
                        {onBranchMaster && (
                          <Button variant="outline" size="sm" disabled={!!busy}
                            onClick={() => {
                              setBranchingFromId(activeNode.id)
                              setBranchTitle(t('graph.branchDefaultName', { base: activeNode.isMaster ? activeNode.trackTitle : (activeNode.company || t('graph.newDirection')) }))
                            }}>
                            {t('graph.openNewMaster')}
                          </Button>
                        )}
                        {activeNode.isMaster && !activeNode.isDefaultMaster && onSetDefault && (
                          <Button variant="outline" size="sm" disabled={!!busy}
                            onClick={() => void onSetDefault(activeNode.trackId)}>
                            {t('version.setDefault')}
                          </Button>
                        )}
                      </div>

                      {onArchive && (
                        <div className="ca-graph-ins-cleanup">
                          {canSquashOlder && (
                            <button type="button" className="ca-graph-cleanup-btn" disabled={!!busy}
                              title={t('graph.squashOlderTitle')}
                              onClick={() => void handleArchiveAction(activeNode.id, 'older')}>
                              {t('graph.squashOlder', { count: trackRevisionCount - 1 })}
                            </button>
                          )}
                          {canArchiveSingle && (
                            <button type="button" className="ca-graph-cleanup-btn" disabled={!!busy}
                              onClick={() => void handleArchiveAction(activeNode.id, 'version')}>
                              {t('graph.archiveVersion')}
                            </button>
                          )}
                          {canArchiveTrack && (
                            <button type="button" className="ca-graph-cleanup-btn is-muted-danger" disabled={!!busy}
                              onClick={() => void handleArchiveAction(activeNode.id, 'track')}>
                              {activeNode.isMaster ? t('graph.archiveMasterTrack') : t('graph.archiveBranchTrack')}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : activeArchived ? (
              <>
                <div className="ca-graph-ins-head">
                  <div className="ca-graph-ins-title-row">
                    {activeArchived.isMaster ? (
                      <MasterResumeEmblem size={26} isDefault={false} />
                    ) : (() => {
                      const opp = activeArchived.raw?.opportunityId ? oppById.get(activeArchived.raw.opportunityId) : null
                      return opp
                        ? <CompanyAvatar company={opp.company} url={opp.url} size={26} />
                        : <BranchResumeEmblem size={26} />
                    })()}
                    <div className="ca-graph-ins-title-copy">
                      <strong>{activeArchived.title}</strong>
                      <small>{t('graph.archivedTag')} · {localizeChangeLabel(activeArchived.changeLabel, t)}</small>
                    </div>
                  </div>
                  {activeArchived.summary && <p className="ca-graph-ins-summary">{activeArchived.summary}</p>}
                </div>
                <div className="ca-graph-ins-preview">
                  <MiniA4Preview resume={activeArchived.raw} template={template} style={style} />
                </div>
                <div className="ca-graph-ins-actions">
                  {onRestore && (
                    <Button variant="primary" size="sm" disabled={!!busy}
                      onClick={() => void onRestore(activeArchived.id, 'version')}>
                      {t('graph.restoreToLibrary')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="ca-graph-empty">
                <p>{t('graph.emptyInspector')}</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </dialog>
  )
}
