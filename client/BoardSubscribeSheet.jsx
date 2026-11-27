import React from 'react'
import { Button, SegmentedControl, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiThinkingBubble, TRACE_STEPS, useTrackedOperation } from './AiActivity.jsx'
import { CopyButton, SideSheet } from './Motion.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import { contextualBoardChannelLabel, isCnBoard, PROVIDER_LABELS, shortBoardChannelLabel } from './shared.js'
import { CURATED_BOARDS, CURATED_COMPANIES, boardPosition, boardSearchText, companyBoardChannels, findCompanyBoard, findNamedCompanyBoards, mergeSearchBoards, parseBoardInput } from '../src/company-boards.mjs'
import { pickChannelForScope, resolveDefaultHiringScope } from '../src/job-view-scope.mjs'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { buildCuaCollectPrompt } from '../src/cua-prompt.mjs'
import { captureProfileContext, checkProfileMismatch, isProfileContextCurrent, profileRequestHeaders } from './profile-storage.js'

export { CURATED_BOARDS, isCnBoard, parseBoardInput, PROVIDER_LABELS }
export const MAX_BOARD_SUBSCRIPTIONS = 20

function keyOf(board) {
  return `${board.provider}:${String(board.slug || '').toLowerCase()}`
}

function discoveryKey(item) {
  return item.provider && item.slug ? keyOf(item) : `${item.company}-${item.domain}`
}

function ScanStatus({ scan, t }) {
  if (scan?.status === 'ok') return <Tag tone="success">{t('boards.jobsCount', { count: scan.count })}</Tag>
  if (scan?.status === 'error') return <Tag tone="danger">{scan.error}</Tag>
  return null
}

function DrawerBody({ state, busy, act, dismiss, onStartSession, initialTab = 'curated' }) {
  const { t, isEn } = useI18n()
  const uid = React.useId()
  const { config, watch } = state
  const marketRegion = state.marketProfile?.region || (isEn ? 'global' : 'cn')
  const [sheetTab, setSheetTab] = React.useState(() => {
    const normalized = (initialTab === 'settings' || initialTab === 'prefs') ? 'custom' : initialTab
    return ['curated', 'discover', 'custom'].includes(normalized) ? normalized : 'curated'
  })
  const [boards, setBoards] = React.useState(() => Array.isArray(config.boards) ? config.boards : [])
  const initialSelectedKeysRef = React.useRef(null)
  if (!initialSelectedKeysRef.current) {
    initialSelectedKeysRef.current = new Set((Array.isArray(config.boards) ? config.boards : []).map(keyOf))
  }
  const terms = React.useMemo(() => Array.isArray(config.searchTerms) ? config.searchTerms : [], [config.searchTerms])
  const goal = config.goal || ''
  const userScope = React.useMemo(() => resolveDefaultHiringScope(config), [config])
  const [channelScope, setChannelScope] = React.useState(() => userScope)
  const [region, setRegion] = React.useState('all')
  const [boardFilter, setBoardFilter] = React.useState('')
  const [onlySelected, setOnlySelected] = React.useState(false)
  const [discoverQuery, setDiscoverQuery] = React.useState(() => state.discoveredCompanies?.query || config.goal || '')
  const [customUrl, setCustomUrl] = React.useState('')
  const [customProvider, setCustomProvider] = React.useState(isEn ? 'greenhouse' : 'feishu')
  const [customSlug, setCustomSlug] = React.useState('')
  const [customCompany, setCustomCompany] = React.useState('')
  const [localError, setLocalError] = React.useState('')
  const [quickAddKey, setQuickAddKey] = React.useState('')
  const [quickJob, setQuickJob] = React.useState({ title: '', location: '', url: '', jd: '' })
  const [fetchingCompany, setFetchingCompany] = React.useState('')
  const [resolvingCuaKey, setResolvingCuaKey] = React.useState('')
  const [companyHints, setCompanyHints] = React.useState({})
  const [companyPreviews, setCompanyPreviews] = React.useState({})
  const [importingPreviewKey, setImportingPreviewKey] = React.useState('')
  const [personalDirs, setPersonalDirs] = React.useState(() => state.discoveryDirections ?? null)
  const [dirsLoading, setDirsLoading] = React.useState(false)
  React.useEffect(() => {
    if (!state.discoveryDirections) setPersonalDirs(null)
  }, [state.discoveryDirections])
  const discoverOp = useTrackedOperation(act, { scopeKey: 'discover-companies', nonBlocking: true })
  const fetchJobsOp = useTrackedOperation(act, { scopeKey: 'company-search-jobs', nonBlocking: true })

  const hasProfileSignal = Boolean(
    goal.trim()
    || terms.length > 0
    || boards.length > 0
    || (state.resumes?.length ?? 0) > 0
    || (state.evidence ?? []).some(e => e?.status === 'approved' && e?.shareable === true)
    || (state.opportunities?.length ?? 0) > 0,
  )

  const loadPersonalDirections = React.useCallback(async (force = false, signal) => {
    if (!hasProfileSignal) return
    const reqCtx = captureProfileContext()
    setDirsLoading(true)
    try {
      const response = await fetch('api/career-agent/suggest-directions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
        body: JSON.stringify({ force, goal, searchTerms: terms, boards, explicitInteractive: true }),
        signal,
      })
      const payload = await response.json().catch(() => null)
      checkProfileMismatch(response, payload)
      if (!isProfileContextCurrent(reqCtx)) return
      if (response.ok && payload?.ok && payload.result) {
        setPersonalDirs(payload.result)
      }
    } catch {
      // Non-blocking background enhancement
    } finally {
      if (!signal?.aborted && isProfileContextCurrent(reqCtx)) setDirsLoading(false)
    }
  }, [hasProfileSignal, goal, terms, boards])

  const autoFetchedRef = React.useRef(false)
  React.useEffect(() => {
    if (autoFetchedRef.current || !hasProfileSignal) return
    autoFetchedRef.current = true
    const controller = new AbortController()
    void loadPersonalDirections(false, controller.signal)
    return () => controller.abort()
  }, [hasProfileSignal, loadPersonalDirections])

  const openQuickAdd = item => {
    const key = discoveryKey(item)
    if (quickAddKey === key) {
      setQuickAddKey('')
      return
    }
    setQuickAddKey(key)
    setQuickJob({
      title: '',
      location: item.location || '',
      url: item.careersUrl || '',
      jd: '',
    })
  }

  const submitQuickAdd = async (event, item) => {
    event.preventDefault()
    if (!quickJob.title.trim() || busy) return
    const reply = await act('job-add', {
      job: {
        company: item.company,
        title: quickJob.title.trim(),
        location: quickJob.location.trim(),
        url: quickJob.url.trim(),
        jd: quickJob.jd.trim(),
      },
    }, t('boards.quickAddToast', { company: item.company, title: quickJob.title.trim() }))
    if (reply?.ok) {
      setQuickAddKey('')
      setQuickJob({ title: '', location: '', url: '', jd: '' })
    }
  }

  const fetchCompanyJobs = async item => {
    const key = discoveryKey(item)
    setFetchingCompany(key)
    setCompanyHints(cur => {
      if (!cur[key]) return cur
      const next = { ...cur }
      delete next[key]
      return next
    })
    try {
      const reply = await fetchJobsOp.run('company-search-jobs', {
        company: item.company,
        domain: item.domain,
        careersUrl: item.careersUrl,
        provider: item.provider,
        slug: item.slug,
        hiringScope: channelScope,
        previewOnly: true,
      }, { kind: 'discover-companies', label: item.company })
      if (reply?.ok) {
        const res = reply.result ?? {}
        const candidates = Array.isArray(res.candidates) ? res.candidates : []
        if (candidates.length > 0) {
          setCompanyPreviews(cur => ({
            ...cur,
            [key]: {
              candidates,
              filteredOut: Number(res.filteredOut || 0),
              totalFound: Number(res.totalFound || candidates.length),
              selected: new Set(candidates.map((_, idx) => idx)),
            },
          }))
        } else if (res.imported > 0) {
          setCompanyHints(cur => ({ ...cur, [key]: { tone: 'ok', text: t('boards.importedHint', { count: res.imported }) } }))
        } else {
          setCompanyPreviews(cur => {
            if (!cur[key]) return cur
            const next = { ...cur }
            delete next[key]
            return next
          })
          setCompanyHints(cur => ({ ...cur, [key]: { tone: 'note', text: res.reason || t('boards.noJobsFallback') } }))
        }
      } else {
        setCompanyHints(cur => ({ ...cur, [key]: { tone: 'error', text: reply?.error || t('boards.noJobsFallback') } }))
      }
    } finally {
      setFetchingCompany('')
    }
  }

  const launchCuaCompanyHunt = async item => {
    if (!onStartSession) return
    const key = discoveryKey(item)
    setResolvingCuaKey(key)
    let resolved = null
    try {
      const res = await act('company-resolve-target', {
        company: item.company,
        domain: item.domain,
        careersUrl: item.careersUrl,
        provider: item.provider,
        slug: item.slug,
        hiringScope: channelScope,
      })
      resolved = res?.result ?? null
    } catch {
      resolved = null
    } finally {
      setResolvingCuaKey('')
    }
    if (resolved?.resolvedMode === 'ats') {
      const candidates = Array.isArray(resolved.candidates) ? resolved.candidates : []
      if (candidates.length > 0) {
        setCompanyPreviews(cur => ({
          ...cur,
          [key]: {
            candidates,
            filteredOut: Number(resolved.filteredOut || 0),
            totalFound: Number(resolved.totalFound || candidates.length),
            selected: new Set(candidates.map((_, idx) => idx)),
          },
        }))
        act.notify?.(t('boards.atsFastPathToast'))
        return
      }
      setCompanyHints(cur => ({ ...cur, [key]: { tone: 'note', text: resolved.reason || t('boards.noJobsFallback') } }))
      return
    }
    dismiss()
    onStartSession(buildCuaCollectPrompt({
      locale: isEn ? 'en' : 'zh',
      mode: 'hunt',
      company: item.company,
      careersUrl: resolved?.careersUrl || item.careersUrl,
      goal: state?.config?.goal || '',
      searchTerms: Array.isArray(state?.config?.searchTerms) ? state.config.searchTerms : [],
      hiringScope: state?.config?.hiringScope || '',
      careerLevel: state?.config?.careerLevel || '',
      targetCount: 6,
    }))
  }

  const togglePreviewIndex = (rowKey, idx) => {
    setCompanyPreviews(cur => {
      const entry = cur[rowKey]
      if (!entry) return cur
      const nextSel = new Set(entry.selected)
      if (nextSel.has(idx)) nextSel.delete(idx)
      else nextSel.add(idx)
      return { ...cur, [rowKey]: { ...entry, selected: nextSel } }
    })
  }

  const togglePreviewAll = (rowKey) => {
    setCompanyPreviews(cur => {
      const entry = cur[rowKey]
      if (!entry) return cur
      const allSelected = entry.selected.size === entry.candidates.length
      const nextSel = allSelected ? new Set() : new Set(entry.candidates.map((_, idx) => idx))
      return { ...cur, [rowKey]: { ...entry, selected: nextSel } }
    })
  }

  const dismissPreview = (rowKey) => {
    setCompanyPreviews(cur => {
      if (!cur[rowKey]) return cur
      const next = { ...cur }
      delete next[rowKey]
      return next
    })
  }

  const importSelectedPreview = async (item) => {
    const rowKey = discoveryKey(item)
    const entry = companyPreviews[rowKey]
    if (!entry) return
    const chosen = entry.candidates.filter((_, idx) => entry.selected.has(idx))
    if (!chosen.length) return
    setImportingPreviewKey(rowKey)
    try {
      const stageReply = await act('staged-jobs-add', {
        captureMode: 'company-preview',
        jobs: chosen.slice(0, 10).map(row => ({
          company: row.company || item.company,
          title: row.title,
          location: row.location || '',
          url: row.url || item.careersUrl || '',
          jd: row.jd || '',
          sourceSite: row.sourceSite || '',
        })),
      })
      const stagedIds = Array.isArray(stageReply?.result?.staged)
        ? stageReply.result.staged.map(s => s.id).filter(Boolean)
        : []
      if (!stagedIds.length) return
      const commitReply = await act('staged-jobs-commit', { ids: stagedIds })
      if (commitReply) {
        dismissPreview(rowKey)
        const count = Number(commitReply?.result?.committedCount ?? stagedIds.length)
        setCompanyHints(cur => ({ ...cur, [rowKey]: { tone: 'ok', text: t('boards.importedHint', { count }) } }))
      }
    } finally {
      setImportingPreviewKey('')
    }
  }

  const discovered = state.discoveredCompanies ?? null
  const boardMap = new Map(boards.map(item => [keyOf(item), item]))
  const resultMap = new Map((watch?.results ?? []).map(item => [item.sourceId, item]))
  const customBoards = boards.filter(b => !CURATED_BOARDS.some(preset => keyOf(preset) === keyOf(b)))
  const cnTotal = CURATED_COMPANIES.filter(b => b.region === 'cn').length
  const globalTotal = CURATED_COMPANIES.length - cnTotal
  const selectedCompanies = CURATED_COMPANIES.filter(b => companyBoardChannels(b).some(channel => boardMap.has(keyOf(channel)))).length
  const filterNorm = boardFilter.trim().normalize('NFKC').toLowerCase()
  const profileTokens = React.useMemo(() => {
    const raw = `${goal} ${terms.join(' ')}`.toLowerCase()
    return raw.split(/[\s,，、/|·]+/u).filter(t => t.length >= 2)
  }, [goal, terms])

  const visiblePresets = React.useMemo(() => {
    const initialSelected = initialSelectedKeysRef.current || new Set()
    const filterWords = filterNorm.split(/\s+/u).filter(Boolean)
    const filtered = CURATED_COMPANIES.filter(b => {
      if (region !== 'all' && b.region !== region) return false
      const channels = companyBoardChannels(b)
      if (onlySelected && !channels.some(channel => boardMap.has(keyOf(channel)))) return false
      if (!filterNorm) return true
      return channels.some(channel => {
        const text = boardSearchText(channel)
        return filterWords.every(word => text.includes(word))
      })
    })
    const score = preset => {
      let s = 0
      if (marketRegion === 'cn' && preset.region === 'cn') s += 100
      else if (marketRegion === 'global' && preset.region === 'global') s += 100
      if (channelScope === 'campus') {
        if (pickChannelForScope(preset, 'campus')) s += 45
        else s -= 25
      }
      if (companyBoardChannels(preset).some(channel => initialSelected.has(keyOf(channel)))) s += 20
      const hay = boardSearchText(preset)
      for (const tok of profileTokens) {
        if (hay.includes(tok)) s += 6
      }
      return s
    }
    return filtered.slice().sort((a, b) => score(b) - score(a))
  }, [region, onlySelected, filterNorm, onlySelected ? boards : null, marketRegion, profileTokens, channelScope])

  const togglePreset = (preset, nextOn) => {
    setLocalError('')
    const id = keyOf(preset)
    if (nextOn) {
      if (boardMap.has(id)) return
      const updated = mergeSearchBoards(boards, [{
        provider: preset.provider, slug: preset.slug, company: preset.company,
        ...(preset.domain ? { domain: preset.domain } : {}),
      }])
      if (updated.length > MAX_BOARD_SUBSCRIPTIONS) { setLocalError(t('boards.maxLimitError', { max: MAX_BOARD_SUBSCRIPTIONS })); return }
      setBoards(updated)
    } else {
      setBoards(boards.filter(item => keyOf(item) !== id))
    }
  }

  const runDiscover = async (overrideQuery) => {
    setLocalError('')
    const q = String(overrideQuery ?? discoverQuery ?? goal).trim()
    if (!q) { setLocalError(t('boards.discoverEmptyError')); return }
    setDiscoverQuery(q)
    await discoverOp.run('discover-companies', { query: q, hiringScope: channelScope }, {
      kind: 'discover-companies',
      label: q,
      toast: t('boards.discoverToast'),
    })
  }

  const addCustomBoard = event => {
    event.preventDefault()
    setLocalError('')
    const target = customUrl.trim() || customProvider + ':' + customSlug.trim()
    const next = parseBoardInput(target)
    if (!next) {
      setLocalError(t(customUrl.trim() ? 'boards.customUrlError' : 'boards.customSlugError'))
      return
    }
    if (customCompany.trim()) next.company = customCompany.trim()
    const id = keyOf(next)
    if (boardMap.has(id)) { setLocalError(t('boards.duplicateBoardError')); return }
    const updated = mergeSearchBoards(boards, [next])
    if (updated.length > MAX_BOARD_SUBSCRIPTIONS) { setLocalError(t('boards.maxLimitError', { max: MAX_BOARD_SUBSCRIPTIONS })); return }
    setBoards(updated)
    setCustomUrl('')
    setCustomSlug('')
    setCustomCompany('')
  }

  const saveAndScan = async (runNow) => {
    setLocalError('')
    // Never mutate mode (e.g. from paused 'off'/'observe' to 'search') when saving boards or running a one-off fetch.
    const patch = { boards }
    const saved = await act('configure', { config: patch }, runNow ? '' : t('boards.saveOnlyToast'))
    if (!saved?.ok) return
    if (runNow && boards.length > 0) {
      const res = await act('run', { scope: 'boards' }, t('boards.scanDoneToast'))
      if (res?.ok) dismiss()
    } else {
      dismiss()
    }
  }

  const directions = Array.isArray(personalDirs?.directions) ? personalDirs.directions.slice(0, 4) : []

  return <div className="ca-sheet-form">
    <nav className="ca-sheet-nav-tabs" role="tablist" aria-label={t('boards.tabsAria')}>
      {[
        { value: 'curated', label: t('boards.tabCurated', { count: boards.length, max: MAX_BOARD_SUBSCRIPTIONS }) },
        { value: 'discover', label: discovered?.items?.length ? t('boards.tabDiscoverCount', { count: discovered.items.length }) : t('boards.tabDiscover') },
        { value: 'custom', label: customBoards.length ? t('boards.tabCustomCount', { count: customBoards.length }) : t('boards.tabCustom') },
      ].map(item => {
        const active = sheetTab === item.value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ca-sheet-nav-tab${active ? ' is-active' : ''}`}
            onClick={() => setSheetTab(item.value)}
          >
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>

    <div className="ca-sheet-body">
      {localError && <p className="ca-form-error" role="alert">{localError}</p>}

      {sheetTab === 'curated' && (
        <section className="ca-sheet-group ca-sheet-group-fill" data-surface="boards-curated">
          <div className="ca-board-toolbar">
            <div className="ca-board-search-row">
              <div className="ca-board-search-wrap">
                <svg className="ca-board-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.6-3.6" />
                </svg>
                <input
                  type="search"
                  value={boardFilter}
                  onChange={e => setBoardFilter(e.target.value)}
                  placeholder={t('boards.searchPlaceholder')}
                  aria-label={t('boards.searchPlaceholder')}
                />
              </div>
              <div className="ca-board-track-group" role="tablist" aria-label={t('boards.channelFilterAria')}>
                {[
                  { value: 'experienced', label: t('boards.trackShortExperienced') },
                  { value: 'campus', label: t('boards.trackShortCampus') },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={channelScope === opt.value}
                    className={`ca-board-track-chip${channelScope === opt.value ? ' is-active' : ''}`}
                    onClick={() => setChannelScope(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ca-board-filter-rail">
              <div className="ca-board-region-group" role="tablist" aria-label={t('boards.regionAria')}>
                {[
                  { value: 'all', label: t('boards.regionAll', { count: CURATED_COMPANIES.length }) },
                  { value: 'cn', label: t('boards.regionCn', { count: cnTotal }) },
                  { value: 'global', label: t('boards.regionGlobal', { count: globalTotal }) },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={region === opt.value}
                    className={`ca-board-region-chip${region === opt.value ? ' is-active' : ''}`}
                    onClick={() => setRegion(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {(selectedCompanies > 0 || onlySelected) && (
                <button
                  type="button"
                  className={`ca-board-selected-toggle ca-nowrap-btn${onlySelected ? ' is-active' : ''}`}
                  aria-pressed={onlySelected}
                  onClick={() => setOnlySelected(v => !v)}
                >
                  <span className="ca-board-selected-dot" aria-hidden="true" />
                  <span>{onlySelected ? t('boards.onlySelectedActive', { count: selectedCompanies }) : t('boards.onlySelected', { count: selectedCompanies })}</span>
                </button>
              )}
            </div>
          </div>
          <div className="ca-sheet-list is-curated-full">
            {visiblePresets.length > 0 ? visiblePresets.map(preset => {
              const id = keyOf(preset)
              const channels = companyBoardChannels(preset)
              const displayCompany = isEn && preset.companyEn ? preset.companyEn : preset.company
              const displayTag = boardPosition(preset, isEn ? 'en' : 'zh')

              const target = pickChannelForScope(preset, channelScope)
              const allCh = channels.find(c => c.hiringScope === 'all')
              const allId = allCh ? keyOf(allCh) : ''
              const siblingChannel = channelScope === 'campus'
                ? channels.find(c => c.hiringScope === 'experienced')
                : channels.find(c => c.hiringScope === 'campus')
              const hasSiblingSubscribed = Boolean(siblingChannel && boardMap.has(keyOf(siblingChannel)))
              const targetId = target ? keyOf(target) : ''
              const checked = target
                ? (boardMap.has(targetId) || (channelScope === 'experienced' && Boolean(allId && boardMap.has(allId))))
                : false
              const activeScanId = target && boardMap.has(targetId)
                ? targetId
                : (channelScope === 'experienced' && allId && boardMap.has(allId) ? allId : targetId)

              return <div className="ca-sheet-row" key={id}>
                <CompanyAvatar company={preset.company} domain={preset.domain} slug={preset.slug} tone={preset.tone} size={34} />
                <div className="ca-sheet-row-text">
                  <div className="ca-inline">
                    <strong>{displayCompany}</strong>
                    {activeScanId && <ScanStatus scan={resultMap.get(activeScanId)} t={t} />}
                    {hasSiblingSubscribed && (
                      <button
                        type="button"
                        className="ca-channel-mini-note"
                        onClick={() => setChannelScope(channelScope === 'campus' ? 'experienced' : 'campus')}
                      >
                        {channelScope === 'campus' ? t('boards.alsoSubscribedExperienced') : t('boards.alsoSubscribedCampus')}
                      </button>
                    )}
                  </div>
                  <small>{displayTag}</small>
                </div>
                {target ? (
                  <Switch
                    label={t('boards.subscribeCompany', { company: displayCompany })}
                    checked={checked}
                    disabled={!!busy}
                    onChange={next => {
                      if (next) {
                        togglePreset(target, true)
                      } else {
                        setLocalError('')
                        setBoards(cur => cur.filter(item => {
                          const k = keyOf(item)
                          if (k === targetId) return false
                          if (channelScope === 'experienced' && allId && k === allId) return false
                          return true
                        }))
                      }
                    }}
                  />
                ) : (
                  <a
                    className="ca-board-campus-link"
                    href={preset.manualHiring?.campus || 'https://' + preset.host}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('boards.campusOfficialLink')}
                  </a>
                )}
              </div>
            }) : (
              <div className="ca-curated-empty">
                <p className="ca-meta">{t('boards.noMatches')}</p>
                <div className="ca-inline">
                  <Button variant="outline" size="sm" onClick={() => { setDiscoverQuery(boardFilter); setSheetTab('discover') }}>
                    {t('boards.tabDiscover')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSheetTab('custom')}>
                    {t('boards.addLink')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {sheetTab === 'discover' && (
        <section className="ca-sheet-group ca-sheet-group-fill" data-surface="boards-discover">
          <div className="ca-discover-box">
            <div className="ca-discover-input-row">
              <input
                value={discoverQuery}
                onChange={e => setDiscoverQuery(e.target.value)}
                placeholder={t('boards.discoverPlaceholder')}
                aria-label={t('boards.discoverAria')}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runDiscover() } }}
              />
              <Button variant="primary" size="sm" disabled={!!busy || discoverOp.running} onClick={() => void runDiscover()}>
                {discoverOp.running ? t('boards.discoverFinding') : t('boards.discoverBtn')}
              </Button>
            </div>

            {hasProfileSignal && (directions.length > 0 || dirsLoading) && (
              <div className="ca-discover-personalized">
                {dirsLoading && directions.length === 0 ? (
                  <span className="ca-discover-gen-hint">{t('boards.expandingDirections')}</span>
                ) : (
                  <div className="ca-discover-oneline-row">
                    <div className="ca-discover-oneline-pills" role="group" aria-label={t('boards.personalDirectionsAria')}>
                      {directions.map(dir => (
                        <button key={dir.label} type="button"
                          className={`ca-target-pill ca-oneline-pill${discoverQuery === dir.query ? ' is-active' : ''}`}
                          disabled={!!busy || discoverOp.running}
                          title={dir.basis ? `${dir.query} (${dir.basis})` : dir.query}
                          onClick={() => void runDiscover(dir.query)}>
                          {dir.label}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="ca-discover-refresh-btn"
                      disabled={dirsLoading || discoverOp.running}
                      title={t('boards.refreshDirections')}
                      aria-label={t('boards.refreshDirections')}
                      onClick={() => void loadPersonalDirections(true)}>
                      {dirsLoading ? '…' : '↻'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {hasProfileSignal && !dirsLoading && directions.length === 0 && (
              <div className="ca-discover-oneline-row">
                <button type="button" className="ca-target-pill ca-oneline-pill"
                  disabled={dirsLoading || discoverOp.running}
                  onClick={() => void loadPersonalDirections(true)}>
                  {t('boards.expandFromProfile')}
                </button>
              </div>
            )}

            {discoverOp.running && (
              <AiThinkingBubble
                activity={discoverOp.activity}
                title={t('boards.discoverBubbleTitle')}
                steps={TRACE_STEPS['discover-companies']}
              />
            )}

            {discovered?.items?.length > 0 && !discoverOp.running && (
              <div className="ca-sheet-list ca-discover-list">
                {discovered.items.map(rawItem => {
                  const cachedPreset = findCompanyBoard(rawItem.provider, rawItem.slug)
                  const fallbackPreset = !cachedPreset
                    ? (() => {
                      const named = findNamedCompanyBoards(rawItem.company)[0]
                      return named ? (pickChannelForScope(named, channelScope) || named) : null
                    })()
                    : null
                  const preset = cachedPreset || fallbackPreset
                  const item = preset && (!rawItem.provider || !rawItem.slug || !rawItem.verified)
                    ? {
                      ...rawItem,
                      provider: rawItem.provider || preset.provider,
                      slug: rawItem.slug || preset.slug,
                      domain: preset.domain || rawItem.domain,
                      careersUrl: preset.host ? `https://${preset.host}` : rawItem.careersUrl,
                      verified: rawItem.verified || Boolean(fallbackPreset),
                    }
                    : rawItem
                  const rowKey = discoveryKey(rawItem)
                  const channel = contextualBoardChannelLabel(preset, t, { userScope: channelScope, boards })
                  const displayCompany = preset && isEn ? preset.companyEn || preset.company : preset?.company || item.company
                  const boardName = [displayCompany, channel].filter(Boolean).join(' · ')
                  const industry = preset ? boardPosition(preset, isEn ? 'en' : 'zh') : item.industry
                  const canSubscribe = Boolean(item.verified && item.provider && item.slug)
                  const boardObj = canSubscribe
                    ? { provider: item.provider, slug: item.slug, company: item.company, domain: item.domain }
                    : null
                  const boardId = boardObj ? keyOf(boardObj) : ''
                  const subscribed = boardId ? boardMap.has(boardId) : false
                  const isFetching = (fetchingCompany === rowKey && fetchJobsOp.running) || resolvingCuaKey === rowKey
                  const isResolvingCua = resolvingCuaKey === rowKey
                  const hint = companyHints[rowKey]
                  const addingHere = quickAddKey === rowKey
                  const searchPrompt = t('boards.searchPrompt', {
                    company: boardName,
                    domain: item.domain || industry || '',
                    goal: goal || terms.join(' / ') || t('boards.myResumeDirection'),
                  })
                  const diligencePrompt = t('boards.diligencePrompt', {
                    company: item.company,
                    meta: [industry, item.location].filter(Boolean).join(' · '),
                  })
                  return <div className="ca-discover-card" key={rowKey}>
                    <div className="ca-sheet-row ca-discover-row">
                      <CompanyAvatar company={item.company} domain={item.domain} url={item.careersUrl} size={34} />
                      <div className="ca-sheet-row-text">
                        <div className="ca-inline">
                          <strong>{displayCompany}</strong>
                          {channel && <Tag tone="neutral">{channel}</Tag>}
                          {canSubscribe && (
                            <Tag tone="success">
                              {item.jobCount > 0 ? t('boards.directJobsTag', { count: item.jobCount }) : t('boards.directChannelTag')}
                            </Tag>
                          )}
                        </div>
                        <small>{[industry, item.location, item.reason].filter(Boolean).join(' · ')}</small>

                        <div className="ca-discover-row-actions">
                          {!canSubscribe && state?.capabilities?.cua?.status === 'ready' && onStartSession ? (
                            <>
                              <button type="button" className="ca-jd-research-link is-action" disabled={!!busy || fetchJobsOp.running || isResolvingCua}
                                onClick={() => void launchCuaCompanyHunt(item)}>
                                {isResolvingCua ? t('boards.verifyingEntry') : t('boards.collectWithDsh')}
                              </button>
                              <button type="button" className="ca-jd-research-link" disabled={!!busy || fetchJobsOp.running || isResolvingCua}
                                onClick={() => void fetchCompanyJobs(item)}>
                                {fetchingCompany === rowKey && fetchJobsOp.running ? t('boards.fetching') : t('boards.previewPublicJobs')}
                              </button>
                            </>
                          ) : (
                            <button type="button" className="ca-jd-research-link is-action" disabled={!!busy || fetchJobsOp.running}
                              onClick={() => void fetchCompanyJobs(item)}>
                              {fetchingCompany === rowKey && fetchJobsOp.running ? t('boards.fetching') : t('boards.viewJobs')}
                            </button>
                          )}
                          {item.careersUrl && (
                            <a className="ca-jd-research-link" href={item.careersUrl} target="_blank" rel="noopener noreferrer">
                              {t('boards.officialSite')}
                            </a>
                          )}
                          {hint && hint.tone !== 'ok' && (
                            <button type="button" className="ca-jd-research-link" onClick={() => openQuickAdd(item)}>
                              {addingHere ? t('common.collapse') : t('boards.quickAddManual')}
                            </button>
                          )}
                          {hint && hint.tone !== 'ok' && (onStartSession ? (
                            <>
                              <button type="button" className="ca-jd-research-link" onClick={() => {
                                dismiss()
                                onStartSession(searchPrompt)
                              }}>{t('boards.dshSearch')}</button>
                              {canSubscribe && state?.capabilities?.cua?.status === 'ready' && (
                                <button type="button" className="ca-jd-research-link" disabled={isResolvingCua}
                                  onClick={() => void launchCuaCompanyHunt(item)}>
                                  {isResolvingCua ? t('boards.verifyingEntry') : t('boards.collectWithDsh')}
                                </button>
                              )}
                            </>
                          ) : (
                            <CopyButton text={searchPrompt} label={t('boards.copySearchPrompt')} />
                          ))}
                        </div>
                      </div>
                      {canSubscribe && (
                        <div className="ca-discover-sub-toggle">
                          <span className="ca-discover-sub-label">{subscribed ? t('boards.subscribedShort') : t('boards.subscribeShort')}</span>
                          <Switch
                            label={t('boards.subscribeCompany', { company: boardName })}
                            checked={subscribed}
                            disabled={!!busy}
                            onChange={next => togglePreset(boardObj, next)}
                          />
                        </div>
                      )}
                    </div>

                    {isFetching && (
                      <div className="ca-discover-subbox">
                        <AiThinkingBubble
                          activity={fetchJobsOp.activity}
                          title={t('boards.fetchingCompanyTitle', { company: item.company })}
                          steps={[
                            { key: 'reading', label: t('boards.stepCheckBoard') },
                            { key: 'matching', label: t('boards.stepSearchJobs') },
                            { key: 'verifying', label: t('boards.stepSaveJobs') },
                          ]}
                          showSkeleton={false}
                        />
                      </div>
                    )}

                    {companyPreviews[rowKey] && !isFetching && (() => {
                      const prev = companyPreviews[rowKey]
                      const selectedCount = prev.selected.size
                      const allSelected = selectedCount === prev.candidates.length
                      const busyImport = importingPreviewKey === rowKey || !!busy
                      return (
                        <div className="ca-discover-preview" data-surface="company-jobs-preview">
                          <div className="ca-discover-preview-head">
                            <div className="ca-inline">
                              <strong>{t('boards.previewMatchedTitle', { count: prev.candidates.length })}</strong>
                              {prev.filteredOut > 0 && (
                                <Tag tone="neutral">{t('boards.previewFilteredTag', { count: prev.filteredOut })}</Tag>
                              )}
                            </div>
                            <button type="button" className="ca-text-button" onClick={() => dismissPreview(rowKey)}>
                              {t('common.collapse')}
                            </button>
                          </div>
                          <div className="ca-discover-preview-list">
                            {prev.candidates.map((row, idx) => (
                              <label key={`${row.url || row.title}:${idx}`} className="ca-discover-preview-row">
                                <input
                                  type="checkbox"
                                  checked={prev.selected.has(idx)}
                                  onChange={() => togglePreviewIndex(rowKey, idx)}
                                />
                                <div className="ca-discover-preview-body">
                                  <div className="ca-discover-preview-title">
                                    <strong>{row.title}</strong>
                                    {row.location && <span className="ca-meta">{row.location}</span>}
                                    {row.jdPreview && <Tag tone="warning">{t('boards.previewSummaryOnly')}</Tag>}
                                    {row.url && (
                                      <a className="ca-jd-research-link" href={row.url} target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}>
                                        {t('boards.previewSourceLink')}
                                      </a>
                                    )}
                                  </div>
                                  {row.matchedAnchors?.length > 0 && (
                                    <div className="ca-discover-preview-tags">
                                      {row.matchedAnchors.map(kw => <Tag key={kw} tone="success">{kw}</Tag>)}
                                    </div>
                                  )}
                                  {row.jd && <p className="ca-discover-preview-jd">{row.jd}</p>}
                                </div>
                              </label>
                            ))}
                          </div>
                          <div className="ca-discover-preview-foot">
                            <button type="button" className="ca-text-button" onClick={() => togglePreviewAll(rowKey)}>
                              {allSelected ? t('boards.previewUnselectAll') : t('boards.previewSelectAll')}
                            </button>
                            <Button variant="primary" size="sm" disabled={busyImport || selectedCount === 0}
                              onClick={() => void importSelectedPreview(item)}>
                              {t('boards.previewImportSelected', { count: selectedCount })}
                            </Button>
                          </div>
                        </div>
                      )
                    })()}

                    {hint && !isFetching && (
                      <div className={`ca-discover-hint${hint.tone === 'ok' ? ' is-ok' : ''}`}>
                        <span>{hint.text}</span>
                        {hint.tone === 'ok' && (
                          <button type="button" className="ca-text-button ca-nowrap-btn" onClick={dismiss}>
                            {t('boards.goToJobList')}
                          </button>
                        )}
                      </div>
                    )}

                    {addingHere && (
                      <form className="ca-discover-quickadd" onSubmit={e => void submitQuickAdd(e, item)}>
                        <div className="ca-fields">
                          <label>{t('common.role')}
                            <input required maxLength={240} value={quickJob.title}
                              onChange={e => setQuickJob(v => ({ ...v, title: e.target.value }))}
                              placeholder={t('boards.rolePlaceholder')} />
                          </label>
                          <label>{t('common.location')}
                            <input maxLength={100} value={quickJob.location}
                              onChange={e => setQuickJob(v => ({ ...v, location: e.target.value }))}
                              placeholder={t('boards.locationPlaceholder')} />
                          </label>
                        </div>
                        <label>JD
                          <textarea rows="2" value={quickJob.jd}
                            onChange={e => setQuickJob(v => ({ ...v, jd: e.target.value }))}
                            placeholder={t('boards.jdPlaceholder')} />
                        </label>
                        <div className="ca-form-actions">
                          <Button variant="ghost" size="sm" onClick={() => setQuickAddKey('')}>{t('common.cancel')}</Button>
                          <Button type="submit" variant="primary" size="sm" disabled={!!busy || !quickJob.title.trim()}>
                            {t('common.save')}
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {sheetTab === 'custom' && <>
        {customBoards.length > 0 && <section className="ca-sheet-group">
          <div className="ca-sheet-group-head"><h3>{t('boards.customBoardsHeading')}</h3></div>
          <div className="ca-sheet-list">
            {customBoards.map(board => {
              const id = keyOf(board)
              const scan = resultMap.get(id)
              return <div className="ca-sheet-row" key={id}>
                <CompanyAvatar company={board.company || board.slug} domain={board.domain} slug={board.slug} size={34} />
                <div className="ca-sheet-row-text">
                  <div className="ca-inline">
                    <strong>{board.company || board.slug}</strong>
                    {scan?.status === 'ok' && <Tag tone="success">{t('boards.jobsCount', { count: scan.count })}</Tag>}
                    {scan?.status === 'error' && <Tag tone="danger">{scan.error}</Tag>}
                  </div>
                  <small>{board.domain || id}</small>
                </div>
                <Button variant="ghost" size="sm" disabled={!!busy}
                  onClick={() => setBoards(boards.filter(item => keyOf(item) !== id))}>{t('common.remove')}</Button>
              </div>
            })}
          </div>
        </section>}

        <section className="ca-sheet-group">
          <div className="ca-sheet-group-head"><h3>{t('boards.addBoardHeading')}</h3></div>
          <form className="ca-form ca-formbox" onSubmit={addCustomBoard}>
            <label>
              <span>{t('boards.officialUrl')}</span>
              <input value={customUrl} onChange={e => setCustomUrl(e.target.value)}
                placeholder="https://..." />
            </label>
            <div className="ca-field-block">
              <span className="ca-field-label" id={`${uid}-provider-label`}>{t('boards.manualProvider')}</span>
              <div className="ca-provider-grid" role="radiogroup" aria-labelledby={`${uid}-provider-label`}>
                <div className="ca-provider-row is-two">
                  {[
                    { value: 'feishu', label: t('provider.feishu') },
                    { value: 'greenhouse', label: 'Greenhouse' },
                  ].map(opt => {
                    const active = customProvider === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`ca-provider-opt${active ? ' is-active' : ''}`}
                        onClick={() => setCustomProvider(opt.value)}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <div className="ca-provider-row is-three">
                  {[
                    { value: 'ashby', label: 'Ashby' },
                    { value: 'lever', label: 'Lever' },
                    { value: 'moka', label: 'Moka' },
                  ].map(opt => {
                    const active = customProvider === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`ca-provider-opt${active ? ' is-active' : ''}`}
                        onClick={() => setCustomProvider(opt.value)}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="ca-fields">
              <label>{t('boards.companySlug')}
                <input value={customSlug} onChange={e => setCustomSlug(e.target.value)}
                  placeholder="slug" />
              </label>
              <label>{t('boards.companyName')}
                <input value={customCompany} onChange={e => setCustomCompany(e.target.value)} placeholder={t('common.optional')} />
              </label>
            </div>
            <div className="ca-form-actions">
              <Button type="submit" variant="outline" size="sm" disabled={!!busy || (!customUrl.trim() && !customSlug.trim())}>{t('common.add')}</Button>
            </div>
          </form>
        </section>
      </>}
    </div>

    <footer className="ca-sheet-footer">
      <div className="ca-sheet-actions ca-sheet-actions-end">
        <div className="ca-inline">
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void saveAndScan(false)}>{t('boards.saveOnly')}</Button>
          <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void saveAndScan(true)}>
            {busy === 'run' ? t('boards.scanning') : boards.length > 0 ? t('boards.saveAndScan', { count: boards.length }) : t('common.save')}
          </Button>
        </div>
      </div>
    </footer>
  </div>
}

export default function BoardSubscribeSheet({ state, busy, act, onClose, onStartSession, initialTab = 'curated' }) {
  const { t } = useI18n()
  return <SideSheet title={t('boards.sheetTitle')} onClose={onClose}>
    {({ dismiss }) => <DrawerBody state={state} busy={busy} act={act} dismiss={dismiss} onStartSession={onStartSession} initialTab={initialTab} />}
  </SideSheet>
}
