import React from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { MIN_CUA_DSH_LABEL } from '../src/cua-prompt.mjs'
import { useI18n } from './i18n.jsx'

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
    </svg>
  )
}

export function CuaReadinessCard({ cua, onUsePaste, onClose, onTryAnyway }) {
  const { t } = useI18n()
  const status = cua?.status || 'unknown'
  const minLabel = cua?.minDshLabel || MIN_CUA_DSH_LABEL
  const title = status === 'upgrade_required'
    ? t('jobs.cuaGuideTitleUpgrade', { version: minLabel })
    : status === 'disabled'
      ? t('jobs.cuaGuideTitleDisabled')
      : status === 'unsupported_platform'
        ? t('jobs.cuaGuideTitleUnsupported')
        : status === 'ready'
          ? t('jobs.cuaGuideTitleReady')
          : t('jobs.cuaGuideTitleUnknown')
  const desc = status === 'upgrade_required'
    ? t('jobs.cuaGuideDescUpgrade', { min: minLabel })
    : status === 'disabled'
      ? t('jobs.cuaGuideDescDisabled')
      : status === 'unsupported_platform'
        ? t('jobs.cuaGuideDescUnsupported')
        : t('jobs.cuaGuideDescUnknown', { min: minLabel })
  return (
    <div className="ca-cua-guide" role="region" aria-label={title}>
      <div className="ca-cua-guide-head">
        <div>
          <strong>{title}</strong>
          {cua?.dshVersion && (
            <p className="ca-cua-guide-desc">{t('jobs.cuaGuideCurrentVer', { version: cua.dshVersion, min: minLabel })}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" icon={<CloseGlyph />} aria-label={t('common.close')} onClick={onClose} />
      </div>
      <p className="ca-cua-guide-desc">{desc}</p>
      {cua?.diagnostic && <p className="ca-meta">{cua.diagnostic}</p>}
      <div className="ca-inline">
        <Button variant="primary" size="sm" onClick={onUsePaste}>{t('jobs.cuaGuideUsePaste')}</Button>
        {status === 'unknown' && onTryAnyway && (
          <Button variant="ghost" size="sm" onClick={onTryAnyway}>{t('jobs.cuaGuideTryAnyway')}</Button>
        )}
      </div>
    </div>
  )
}

export function PendingImportsDrawer({ items, act, busy, onClose }) {
  const { t } = useI18n()
  const seedOf = item => item.seedKey || item.url || `${item.company || ''}\0${item.title || ''}\0${item.location || ''}`
  const [selectedIds, setSelectedIds] = React.useState(() => new Set(items.map(i => i.id)))
  const seedCheckedRef = React.useRef(new Map(items.map(i => [seedOf(i), true])))
  const [editingId, setEditingId] = React.useState('')
  const [draft, setDraft] = React.useState({ company: '', title: '', location: '', url: '', jd: '' })

  React.useEffect(() => {
    const prevMap = seedCheckedRef.current
    const nextMap = new Map()
    const nextSelected = new Set()
    for (const item of items) {
      const seed = seedOf(item)
      const checked = prevMap.has(seed) ? prevMap.get(seed) : true
      nextMap.set(seed, checked)
      if (checked) nextSelected.add(item.id)
    }
    seedCheckedRef.current = nextMap
    setSelectedIds(nextSelected)
  }, [items])

  if (!items.length) return null

  const toggleSelect = id => {
    const target = items.find(i => i.id === id)
    const willCheck = !selectedIds.has(id)
    if (target) seedCheckedRef.current.set(seedOf(target), willCheck)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startEdit = item => {
    setEditingId(item.id)
    setDraft({
      company: item.company ?? '',
      title: item.title ?? '',
      location: item.location ?? '',
      url: item.url ?? '',
      jd: item.jd ?? '',
    })
  }

  const saveEdit = async (event, id) => {
    event.preventDefault()
    const reply = await act('staged-job-update', { id, changes: draft }, t('jobs.pendingUpdatedToast'))
    if (reply) {
      const nextId = reply?.result?.id
      if (nextId && nextId !== id) {
        setSelectedIds(prev => {
          const next = new Set(prev)
          if (next.delete(id)) next.add(nextId)
          return next
        })
      }
      setEditingId('')
    }
  }

  const commitIds = async ids => {
    const reply = await act('staged-jobs-commit', { ids }, r => t('jobs.pendingCommitToast', {
      added: Number(r?.addedCount || 0),
      updated: Number(r?.updatedCount || 0),
    }))
    if (reply && editingId && ids.includes(editingId)) setEditingId('')
  }

  const selectedList = items.filter(i => selectedIds.has(i.id)).map(i => i.id)

  return (
    <div className="ca-pending-drawer" data-surface="pending-imports">
      <div className="ca-pending-drawer-head">
        <div>
          <strong>{t('jobs.pendingDrawerTitle', { count: items.length })}</strong>
          <p className="ca-pending-drawer-sub">{t('jobs.pendingDrawerSubtitle')}</p>
        </div>
        <Button variant="ghost" size="sm" icon={<CloseGlyph />} aria-label={t('common.close')} onClick={onClose} />
      </div>
      <div className="ca-pending-list">
        {items.map(item => (
          <div key={item.id} className="ca-pending-row">
            {editingId === item.id ? (
              <form className="ca-form" onSubmit={e => void saveEdit(e, item.id)}>
                <div className="ca-fields">
                  <label>{t('common.company')}<input required maxLength={160} value={draft.company} onChange={e => setDraft(d => ({ ...d, company: e.target.value }))} /></label>
                  <label>{t('common.role')}<input required maxLength={300} value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} /></label>
                </div>
                <div className="ca-fields">
                  <label>{t('common.location')}<input maxLength={300} value={draft.location} onChange={e => setDraft(d => ({ ...d, location: e.target.value }))} /></label>
                  <label>{t('common.link')}<input type="url" pattern="https://.*" value={draft.url} onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} placeholder="https://..." /></label>
                </div>
                <label>JD<textarea rows="3" value={draft.jd} onChange={e => setDraft(d => ({ ...d, jd: e.target.value }))} /></label>
                <div className="ca-form-actions">
                  <Button variant="ghost" size="sm" onClick={() => setEditingId('')}>{t('common.cancel')}</Button>
                  <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('common.saveChanges')}</Button>
                </div>
              </form>
            ) : (
              <div className="ca-pending-row-top">
                <label className="ca-pending-row-main">
                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  <div>
                    <div className="ca-pending-row-title">
                      <strong>{item.company} · {item.title}</strong>
                      {item.location && <span className="ca-meta">{item.location}</span>}
                      {item.sourceSite && <Tag tone="neutral">{item.sourceSite}</Tag>}
                      {item.duplicateOpportunityId && <Tag tone="warning">{t('jobs.pendingDuplicateBadge')}</Tag>}
                    </div>
                    {item.jd && <p className="ca-pending-row-jd">{item.jd}</p>}
                    {item.url && <a className="ca-meta" href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>}
                  </div>
                </label>
                <div className="ca-inline">
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => startEdit(item)}>{t('common.edit')}</Button>
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void commitIds([item.id])}>
                    {item.duplicateOpportunityId ? t('jobs.pendingUpdateOne') : t('jobs.pendingCommitOne')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act('staged-jobs-dismiss', { ids: [item.id] }, t('jobs.pendingDismissedToast'))}>
                    {t('common.remove')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ca-pending-drawer-foot">
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act('staged-jobs-dismiss', { all: true }, t('jobs.pendingDismissedToast'))}>
          {t('jobs.pendingDismissAll')}
        </Button>
        <Button variant="primary" size="sm" disabled={!!busy || !selectedList.length} onClick={() => void commitIds(selectedList)}>
          {t('jobs.pendingCommitSelected', { count: selectedList.length })}
        </Button>
      </div>
    </div>
  )
}
