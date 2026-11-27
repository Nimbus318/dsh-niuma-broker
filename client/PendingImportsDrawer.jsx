import React from 'react'
import { Button, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { CUA_PLATFORMS, MIN_CUA_DSH_LABEL } from '../src/cua-prompt.mjs'
import { useI18n } from './i18n.jsx'
import { InfoTip } from './Motion.jsx'

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

export function CuaLauncherPanel({ config, onLaunch, onClose }) {
  const { t, locale } = useI18n()
  const modeId = React.useId()
  const isEn = locale === 'en'
  const initialTerms = [
    ...(typeof config?.goal === 'string' && config.goal.trim() ? [config.goal.trim()] : []),
    ...(Array.isArray(config?.searchTerms) ? config.searchTerms : []),
  ]
  const dedupedInitialTerms = [...new Set(initialTerms.map(s => String(s || '').trim()).filter(Boolean))]
  const [mode, setMode] = React.useState('hunt')
  const [platformId, setPlatformId] = React.useState('zhipin')
  const [keywordsText, setKeywordsText] = React.useState(() => dedupedInitialTerms.join(isEn ? ', ' : '、'))
  const [hiringScope, setHiringScope] = React.useState(() => (config?.hiringScope === 'campus' || config?.hiringScope === 'experienced' ? config.hiringScope : 'any'))
  const [targetCount, setTargetCount] = React.useState('8')
  const [extraNotes, setExtraNotes] = React.useState('')

  const activePlatform = CUA_PLATFORMS.find(p => p.id === platformId) || CUA_PLATFORMS[0]
  const activePlatformLabel = isEn ? activePlatform.labelEn : activePlatform.labelZh
  const launcherTip = `${mode === 'hunt' ? t('jobs.cuaLauncherSubtitle') : t('jobs.cuaCurrentPageHint')}\n\n${t('jobs.cuaSafetyHint')}`

  const submit = event => {
    event.preventDefault()
    const parsedTerms = keywordsText.split(/[，,、/\n]+/u).map(s => s.trim()).filter(Boolean)
    onLaunch({
      mode,
      platform: mode === 'hunt' ? activePlatform.id : '',
      searchTerms: parsedTerms,
      hiringScope: hiringScope === 'any' ? 'both' : hiringScope,
      careerLevel: typeof config?.careerLevel === 'string' ? config.careerLevel : '',
      targetCount: Number(targetCount) || (mode === 'hunt' ? 8 : 6),
      extraNotes: extraNotes.trim(),
    })
  }

  return (
    <form className="ca-cua-launcher" data-surface="cua-launcher" onSubmit={submit}>
      <div className="ca-cua-guide-head">
        <div className="ca-auto-body-head">
          <strong>{t('jobs.cuaLauncherTitle')}</strong>
          <InfoTip text={launcherTip} down wide />
        </div>
        <Button variant="ghost" size="sm" icon={<CloseGlyph />} aria-label={t('common.close')} onClick={onClose} />
      </div>

      <SegmentedControl
        id={modeId}
        className="ca-full-seg ca-seg-on-layer ca-level-seg"
        label={t('jobs.cuaModeAria')}
        value={mode}
        onChange={next => {
          setMode(next)
          setTargetCount(next === 'current-page' ? '5' : '8')
        }}
        options={[
          { value: 'hunt', label: t('jobs.cuaModeHunt') },
          { value: 'current-page', label: t('jobs.cuaModeCurrentPage') },
        ]}
      />

      {mode === 'hunt' ? (
        <>
          <div className="ca-form">
            <label>{t('jobs.cuaPlatformLabel')}</label>
            <div className="ca-cua-platforms" role="radiogroup" aria-label={t('jobs.cuaPlatformLabel')}>
              {CUA_PLATFORMS.map(item => {
                const label = isEn ? item.labelEn : item.labelZh
                const selected = item.id === platformId
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`ca-cua-platform-chip${selected ? ' is-active' : ''}`}
                    onClick={() => setPlatformId(item.id)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="ca-form">
            {t('jobs.cuaKeywordsLabel')}
            <input
              value={keywordsText}
              onChange={e => setKeywordsText(e.target.value)}
              placeholder={t('jobs.cuaKeywordsPh')}
            />
          </label>

          <div className="ca-fields">
            <label>
              {t('jobs.cuaScopeLabel')}
              <select value={hiringScope} onChange={e => setHiringScope(e.target.value)}>
                <option value="any">{t('jobs.cuaScopeAny')}</option>
                <option value="experienced">{t('jobs.cuaScopeExperienced')}</option>
                <option value="campus">{t('jobs.cuaScopeCampus')}</option>
              </select>
            </label>
            <label>
              {t('jobs.cuaCountLabel')}
              <select value={targetCount} onChange={e => setTargetCount(e.target.value)}>
                <option value="5">{t('jobs.cuaCountOption', { count: 5 })}</option>
                <option value="8">{t('jobs.cuaCountOption', { count: 8 })}</option>
                <option value="12">{t('jobs.cuaCountOption', { count: 12 })}</option>
              </select>
            </label>
          </div>
        </>
      ) : (
        <label className="ca-form">
          {t('jobs.cuaCountLabel')}
          <select value={targetCount} onChange={e => setTargetCount(e.target.value)}>
            <option value="5">{t('jobs.cuaCountOption', { count: 5 })}</option>
            <option value="10">{t('jobs.cuaCountOption', { count: 10 })}</option>
          </select>
        </label>
      )}

      <label className="ca-form">
        {t('jobs.cuaExtraNotesLabel')}
        <input
          value={extraNotes}
          onChange={e => setExtraNotes(e.target.value)}
          placeholder={t('jobs.cuaExtraNotesPh')}
          maxLength={240}
        />
      </label>

      <div className="ca-form-actions">
        <Button type="submit" variant="primary" size="sm">
          {mode === 'hunt'
            ? t('jobs.cuaLaunchHuntBtn', { platform: activePlatformLabel })
            : t('jobs.cuaLaunchCurrentBtn')}
        </Button>
      </div>
    </form>
  )
}

export function PendingImportsDrawer({ items, act, busy, onClose }) {
  const { t } = useI18n()
  const seedOf = item => item.seedKey || item.url || `${item.company || ''}\0${item.title || ''}\0${item.location || ''}`
  const [selectedIds, setSelectedIds] = React.useState(() => new Set(items.map(i => i.id)))
  const [expandedIds, setExpandedIds] = React.useState(() => new Set())
  const seedCheckedRef = React.useRef(new Map(items.map(i => [seedOf(i), true])))
  const [editingId, setEditingId] = React.useState('')
  const [draft, setDraft] = React.useState({ company: '', title: '', location: '', url: '', jd: '' })

  const toggleExpand = id => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    if (reply) {
      if (editingId && ids.includes(editingId)) setEditingId('')
      setExpandedIds(prev => {
        if (!prev.size) return prev
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }
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
        {items.map(item => {
          const isExpanded = expandedIds.has(item.id)
          const canExpand = Boolean(item.jd)
          return (
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
                  <label>JD<textarea className="ca-pending-edit-jd" rows="10" value={draft.jd} onChange={e => setDraft(d => ({ ...d, jd: e.target.value }))} /></label>
                  <div className="ca-form-actions">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId('')}>{t('common.cancel')}</Button>
                    <Button type="submit" variant="primary" size="sm" disabled={!!busy}>{t('common.saveChanges')}</Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="ca-pending-row-top">
                    <div className="ca-pending-row-main">
                      <input
                        className="ca-pending-row-check"
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        aria-label={`${item.company} · ${item.title}`}
                        onChange={() => toggleSelect(item.id)}
                      />
                      <div
                        className="ca-pending-row-body"
                        role={canExpand ? 'button' : undefined}
                        tabIndex={canExpand ? 0 : undefined}
                        aria-expanded={canExpand ? isExpanded : undefined}
                        onClick={canExpand ? () => toggleExpand(item.id) : undefined}
                        onKeyDown={canExpand ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleExpand(item.id)
                          }
                        } : undefined}
                      >
                        <div className="ca-pending-row-title">
                          <strong>{item.company} · {item.title}</strong>
                          {item.location && <span className="ca-meta">{item.location}</span>}
                          {item.sourceSite && <Tag tone="neutral">{item.sourceSite}</Tag>}
                          {item.duplicateOpportunityId && <Tag tone="warning">{t('jobs.pendingDuplicateBadge')}</Tag>}
                        </div>
                        {!isExpanded && item.jd && <p className="ca-pending-row-jd">{item.jd}</p>}
                        {item.url && <a className="ca-meta" href={item.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{item.url}</a>}
                      </div>
                    </div>
                    <div className="ca-inline ca-pending-row-actions">
                      {canExpand && (
                        <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => toggleExpand(item.id)}>
                          {isExpanded ? t('jobs.pendingCollapseJd') : t('jobs.pendingExpandJd')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => startEdit(item)}>{t('common.edit')}</Button>
                      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void commitIds([item.id])}>
                        {item.duplicateOpportunityId ? t('jobs.pendingUpdateOne') : t('jobs.pendingCommitOne')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act('staged-jobs-dismiss', { ids: [item.id] }, t('jobs.pendingDismissedToast'))}>
                        {t('common.remove')}
                      </Button>
                    </div>
                  </div>
                  {isExpanded && item.jd && (
                    <div className="ca-pending-jd-reader">
                      <div className="ca-pending-jd-reader-body">{item.jd}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
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
