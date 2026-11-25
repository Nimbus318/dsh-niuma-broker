import React from 'react'
import { createPortal } from 'react-dom'
import { Button, Tag, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useElapsedSeconds } from './AiActivity.jsx'
import { DeepSeekMark } from './Emblems.jsx'
import GhostInput from './GhostInput.jsx'
import MarkdownProse from './MarkdownProse.jsx'
import { getActiveLocale, useI18n } from './i18n.jsx'
import { boardChannelLabel, boardForSourceId, dimensionLabel, providerLabel, receiptLabel } from './shared.js'
import { findCompanyBoard } from '../src/company-boards.mjs'

const MAX_SELECTED_JOBS = 6

const PICKER_GROUPS = [
  { id: 'offer', labelKey: 'composer.groupOffer', badgeKey: 'composer.badgeOffer', tone: 'offer', stages: new Set(['offer_received', 'offer_accepted', 'started']) },
  { id: 'interview', labelKey: 'composer.groupInterview', badgeKey: 'composer.badgeInterview', tone: 'interview', stages: new Set(['invited', 'interviewing', 'interview_invited', 'interview_confirmed', 'interview_completed']) },
  { id: 'applied', labelKey: 'composer.groupApplied', badgeKey: 'composer.badgeApplied', tone: 'applied', stages: new Set(['submitted', 'acknowledged', 'contacted', 'application_submitted', 'application_acknowledged', 'contact_sent', 'resume_sent']) },
  { id: 'discovered', labelKey: 'composer.groupDiscovered', badgeKey: 'composer.badgeDiscovered', tone: 'new', stages: new Set(['discovered', 'opened', 'application_prepared']) },
  { id: 'closed', labelKey: 'composer.groupClosed', badgeKey: 'composer.badgeClosed', tone: 'closed', stages: new Set(['rejected', 'withdrawn', 'offer_declined']) },
]

function stageGroupFor(opp) {
  const st = opp?.stage ?? opp?.status ?? 'discovered'
  if (opp?.closedAt && !PICKER_GROUPS[0].stages.has(st)) return PICKER_GROUPS[4]
  return PICKER_GROUPS.find(g => g.stages.has(st)) || PICKER_GROUPS[3]
}

function composerStatusLabel(rawText = '', opportunityId = '', selectedCount = 0, t) {
  const s = String(rawText || '').trim()
  if (selectedCount > 0) {
    if (/^(?:补充以下信息|以上薪资或内部细节暂时不补充|Here are my additional details|Skip compensation)/iu.test(s)) {
      return t('composer.statusRefine', { count: selectedCount })
    }
    return selectedCount >= 2
      ? t('composer.statusCompare', { count: selectedCount })
      : t('composer.statusSingleSelected')
  }
  if (/(?:巡检|盯盘|频率|频次|间隔|定时|提醒|通知|时区|职业观察|cadence|interval|patrol|schedule|timezone|alert)/iu.test(s) && !/(?:筛选|对比|比较|推荐|filter|compare|rank)/iu.test(s)) {
    return t('composer.statusPrefs')
  }
  if (/(?:投递|面试|offer|一面|二面|三面|终面|回执|通过|拒绝|入职|点错|撤销|重置|applied|interview|withdraw|reject|undo|reset)/iu.test(s)) {
    return t('composer.statusReceipt')
  }
  if (/(?:成果|上线|优化|重构|简历|履历|shipped|launched|built|win|accomplishment|resume)/iu.test(s) && !/(?:筛选|对比|岗位|filter|compare|role|job)/iu.test(s)) {
    return t('composer.statusEvidence')
  }
  return opportunityId ? t('composer.statusJob') : t('composer.statusGeneral')
}

function formatShortSeconds(ms) {
  const sec = Math.max(0.1, (Number(ms) || 0) / 1000)
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

const titleKeys = {
  search: 'composer.titleSearch', job: 'composer.titleJob', evidence: 'composer.titleEvidence', resume: 'composer.titleResume',
  receipt: 'composer.titleReceipt', receipt_reset: 'composer.titleReceiptReset', reflection: 'composer.titleReflection',
  preferences: 'composer.titlePreferences', clarify: 'composer.titleClarify',
}
const acceptKeys = {
  search: 'composer.acceptSearch', job: 'composer.acceptJob', evidence: 'composer.acceptEvidence', resume: 'composer.acceptResume',
  receipt: 'composer.acceptReceipt', receipt_reset: 'composer.acceptReceiptReset', reflection: 'composer.acceptReflection',
  preferences: 'composer.acceptPreferences',
}

function resetActionLabel(data = {}, t) {
  const target = data.targetType ? receiptLabel(data.targetType, t) : ''
  switch (data.action) {
    case 'clear_all': return t('composer.resetClearAll')
    case 'undo_last': return t('composer.resetUndoLast')
    case 'remove_type': return target ? t('composer.resetRemoveType', { target }) : t('composer.resetRemoveTypeGeneric')
    case 'rollback_to': return target ? t('composer.resetRollbackTo', { target }) : t('composer.resetRollbackGeneric')
    default: return t('composer.resetDefault')
  }
}

export function resolveDefaultModelRow(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  return rows.find(row => row?.isDefault)
    ?? rows.find(row => typeof row?.route === 'string' && row.route.startsWith('deepseek-official:'))
    ?? rows[0]
    ?? null
}

export function resolveDefaultModelRoute(rows = []) {
  return resolveDefaultModelRow(rows)?.route || ''
}

export function useModels() {
  const { t } = useI18n()
  const [attempt, setAttempt] = React.useState(0)
  const [catalog, setCatalog] = React.useState({ rows: [], pending: true, error: '' })
  React.useEffect(() => {
    const controller = new AbortController()
    setCatalog({ rows: [], pending: true, error: '' })
    fetch('api/career-agent/models', {
      headers: { 'x-career-agent': '1', 'x-career-locale': getActiveLocale() },
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(t('composer.modelsLoadFailed', { status: response.status }))
        const rows = await response.json()
        if (!Array.isArray(rows)) throw new Error(t('composer.modelsBadFormat'))
        const options = new Map()
        for (const row of rows) {
          if (!row?.provider || !row.id) continue
          const route = `${row.provider}:${row.id}`
          options.set(route, {
            route,
            name: row.name || row.id,
            provider: row.providerName || row.provider,
            ...(row.isDefault ? { isDefault: true } : {}),
            ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
            ...(row.reasoning?.efforts?.length ? { reasoning: row.reasoning } : {}),
          })
        }
        if (!controller.signal.aborted) setCatalog({ rows: [...options.values()], pending: false, error: '' })
      })
      .catch(error => {
        if (!controller.signal.aborted) setCatalog({ rows: [], pending: false, error: error.message })
      })
    return () => controller.abort()
  }, [attempt, t])
  return { ...catalog, retry: () => setAttempt(value => value + 1) }
}

const fullHour = value => `${String(value).padStart(2, '0')}:00`
const enabledLabel = (value, t) => typeof value === 'boolean' ? (value ? t('common.enabled') : t('common.disabled')) : ''

function frequency(minutes, t) {
  if (!Number.isInteger(minutes)) return ''
  if (minutes % 1440 === 0) return t('composer.everyNDays', { count: minutes / 1440 })
  if (minutes % 60 === 0) return t('composer.everyNHours', { count: minutes / 60 })
  return t('composer.everyNMinutes', { count: minutes })
}

function Details({ item, opportunity, timezone }) {
  const { t, formatDate, isZh } = useI18n()
  const displayDate = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)))
    ? formatDate(value, { timezone, dateStyle: 'medium', timeStyle: 'short' })
    : ''
  const sep = isZh ? '、' : ', '
  const data = item.data ?? {}
  let fields
  switch (item.kind) {
    case 'search':
      fields = [
        [t('composer.fieldGoal'), data.goal], [t('composer.fieldKeywords'), data.searchTerms?.join(sep)],
        [t('composer.fieldBoards'), data.boards?.map(board => {
          const preset = findCompanyBoard(board.provider, board.slug)
          const localizedName = !isZh && preset?.company === board.company ? preset.companyEn : ''
          const name = localizedName || board.company || board.slug
          const channel = boardChannelLabel(preset, t)
          const source = [providerLabel(board.provider, t), channel].filter(Boolean).join(' · ')
          return isZh ? name + '（' + source + '）' : name + ' (' + source + ')'
        }).join(sep)],
        [t('composer.unavailableChannels'), data.unavailableChannels?.map(row => row.company + ' · ' + t(row.scope === 'campus' ? 'boards.campusRoles' : 'boards.experiencedRoles')).join(sep)],
        [t('composer.fieldReplacedBoards'), data.replacedBoardIds?.map(id => {
          const preset = boardForSourceId(id)
          if (!preset) return id
          const name = !isZh && preset.companyEn ? preset.companyEn : preset.company
          return [name, boardChannelLabel(preset, t)].filter(Boolean).join(' · ')
        }).join(sep)],
      ]
      break
    case 'job':
      fields = [[t('common.company'), data.company], [t('common.role'), data.title], [t('common.location'), data.location], [t('common.link'), data.url], [t('composer.fieldDesc'), data.jd]]
      break
    case 'evidence':
      fields = [[t('composer.fieldWin'), data.title], [t('composer.fieldDesc'), data.text], [t('composer.fieldRole'), data.role], [t('composer.fieldImpact'), data.impact]]
      break
    case 'resume':
      fields = [[t('composer.fieldName'), data.title], [t('composer.fieldBody'), data.text]]
      break
    case 'receipt':
      fields = [
        [t('common.role'), opportunity?.title ?? item.opportunityTitle ?? data.opportunityTitle], [t('composer.fieldProgress'), receiptLabel(data.type, t)],
        [t('composer.fieldTime'), displayDate(data.occurredAt)], [t('composer.fieldReceipt'), data.evidence], [t('composer.fieldVersion'), data.material],
        [t('composer.fieldRound'), data.round], [t('composer.fieldStart'), displayDate(data.startsAt)], [t('composer.fieldEnd'), displayDate(data.endsAt)],
        [t('common.location'), data.location], ['Offer', { written: t('composer.offerWritten'), verbal: t('composer.offerVerbal') }[data.form]],
        [t('composer.fieldDeadline'), displayDate(data.replyBy)], [t('common.notes'), data.notes],
      ]
      break
    case 'receipt_reset':
      fields = [
        [t('common.role'), opportunity?.title ?? item.opportunityTitle ?? data.opportunityTitle],
        [t('composer.fieldAction'), resetActionLabel(data, t)],
      ]
      break
    case 'reflection':
      fields = [[t('composer.fieldDimension'), dimensionLabel(data.dimension, t)], [t('composer.fieldRecord'), data.text], [t('composer.fieldTime'), displayDate(data.occurredAt)]]
      break
    case 'preferences':
      fields = [
        [t('composer.fieldFrequency'), frequency(data.intervalMinutes, t)],
        [t('composer.fieldReminders'), enabledLabel(data.notificationsEnabled, t)],
        [t('composer.fieldWindow'), Number.isInteger(data.notificationHour) && Number.isInteger(data.notificationEndHour)
          ? `${fullHour(data.notificationHour)}–${fullHour(data.notificationEndHour)}` : ''],
        [t('composer.fieldObserve'), enabledLabel(data.allowReflections, t)],
        [t('composer.fieldTimezone'), data.timezone],
      ]
      break
    default:
      return null
  }
  const visible = fields.filter(([, value]) => typeof value === 'string' && value.trim())
  if (!visible.length) return null
  return <dl className="ca-proposal-data">{visible.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function Proposal({ item, busy, act, onApplied, onReply, opportunity, timezone, active }) {
  const { t } = useI18n()
  const clarification = item.kind === 'clarify' || !!item.question
  const apply = async () => {
    const reply = await act('accept-intake', { id: item.id }, item.kind === 'preferences' ? t('composer.toastUpdated') : t('composer.toastSaved'))
    if (reply?.ok) onApplied?.(item.kind, item.data)
  }
  return <article className={`ca-proposal${active ? ' is-current' : ''}`}>
    <div className="ca-proposal-head">
      <Tag tone={clarification ? 'info' : 'neutral'}>{titleKeys[item.kind] ? t(titleKeys[item.kind]) : t('composer.titleSuggestion')}</Tag>
      <span className="ca-proposal-summary">{item.question || item.summary}</span>
    </div>
    {!clarification && <Details item={item} opportunity={opportunity} timezone={timezone} />}
    <div className="ca-proposal-actions">
      <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act('dismiss-intake', { id: item.id }, t('composer.toastDismissed'))}>{t('common.dismiss')}</Button>
      <Button variant={clarification ? 'primary' : 'outline'} size="sm" disabled={!!busy} onClick={() => onReply(item.id)}>{clarification ? t('composer.answer') : t('composer.addInfo')}</Button>
      {!clarification && acceptKeys[item.kind] && <Button variant="primary" size="sm" disabled={!!busy} onClick={apply}>{t(acceptKeys[item.kind])}</Button>}
    </div>
  </article>
}

function AssistantReplyCard({ reply, oppById, onOpenJob, onApplyFilter, onOpenFollowUp, onOpenMatrix, onDismiss }) {
  const { t } = useI18n()
  const [expandedIds, setExpandedIds] = React.useState({})
  const [recExpanded, setRecExpanded] = React.useState(false)

  React.useEffect(() => {
    setExpandedIds({})
    setRecExpanded(false)
  }, [reply?.id])

  if (!reply) return null
  const { kind, summary, data = {} } = reply
  const hasFollowUp = Array.isArray(data.followUp?.fields) && data.followUp.fields.length > 0

  if (kind === 'filter') {
    const count = Array.isArray(data.opportunityIds) ? data.opportunityIds.length : 0
    return <article className="ca-copilot-card is-filter" role="status">
      <div className="ca-copilot-head">
        <span className="ca-copilot-kind">{t('composer.kindFilter')}</span>
        <span className="ca-copilot-title">{data.clear ? t('composer.filterRestored') : `${data.label || t('composer.filterResults')} (${count})`}</span>
        <button type="button" className="ca-copilot-close" aria-label={t('composer.closeReplyAria')} onClick={onDismiss}>×</button>
      </div>
      {summary && <p className="ca-copilot-text">{summary}</p>}
      {!data.clear && count > 0 && onApplyFilter && (
        <div className="ca-copilot-actions">
          <button type="button" className="ca-text-button" onClick={() => onApplyFilter(null)}>{t('composer.restoreAllJobs')}</button>
        </div>
      )}
    </article>
  }

  if (kind === 'compare') {
    const items = Array.isArray(data.items) ? data.items : []
    const ids = items.map(i => i.opportunityId).filter(Boolean)
    const recText = String(data.recommendation || '').trim()
    const longRec = recText.length > 105
    return <article className="ca-copilot-card is-compare">
      <div className="ca-copilot-head">
        <span className="ca-copilot-kind">{t('composer.kindCompare')}</span>
        <strong className="ca-copilot-title" title={data.title || t('composer.compareDefaultTitle')}>{data.title || t('composer.compareDefaultTitle')}</strong>
        <button type="button" className="ca-copilot-close" aria-label={t('composer.closeCompareAria')} onClick={onDismiss}>×</button>
      </div>
      {recText && (
        <div className="ca-copilot-rec-wrap">
          <p className={`ca-copilot-rec${longRec && !recExpanded ? ' is-clamped' : ''}`}>{recText}</p>
          {longRec && (
            <button type="button" className="ca-copilot-rec-more" onClick={() => setRecExpanded(v => !v)}>
              {recExpanded ? t('composer.collapseConclusion') : t('composer.expandConclusion')}
            </button>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="ca-compare-compact-list">
          {items.map((item, idx) => {
            const liveOpp = oppById?.get(item.opportunityId)
            const grp = stageGroupFor(liveOpp || { stage: item.stage })
            const showStage = grp.id === 'offer' || grp.id === 'interview' || grp.id === 'applied'
            const hasDetail = Boolean(item.pros || item.cons)
            const isOpen = Boolean(expandedIds[item.opportunityId])
            return (
              <div key={item.opportunityId} className={`ca-compare-row${isOpen ? ' is-open' : ''}`}>
                <div className="ca-compare-row-top">
                  <span className={`ca-compare-rank${idx === 0 ? ' is-top' : ''}`}>{idx + 1}</span>
                  <button type="button" className="ca-compare-job-link" onClick={() => onOpenJob?.(item.opportunityId, 'jd')}>
                    <strong>{item.company}</strong>
                    <span>{item.title}</span>
                  </button>
                  {showStage && (
                    <span className={`ca-compose-job-stage is-tone-${grp.tone}`}>{t(grp.badgeKey)}</span>
                  )}
                  {Number.isFinite(item.fitScore) && (
                    <span className="ca-compare-score">{item.fitScore}%</span>
                  )}
                  {hasDetail && (
                    <button
                      type="button"
                      className={`ca-compare-expand-btn${isOpen ? ' is-open' : ''}`}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? t('composer.collapseDetailsAria') : t('composer.expandDetailsAria')}
                      onClick={() => setExpandedIds(cur => ({ ...cur, [item.opportunityId]: !cur[item.opportunityId] }))}
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
                {item.verdict && <p className="ca-compare-row-verdict">{item.verdict}</p>}
                {hasDetail && isOpen && (
                  <div className="ca-compare-pc is-compact">
                    {item.pros && <div className="ca-compare-pro"><b>{t('composer.pros')}</b><span>{item.pros}</span></div>}
                    {item.cons && <div className="ca-compare-con"><b>{t('composer.cons')}</b><span>{item.cons}</span></div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {(hasFollowUp || items.length >= 2 || (ids.length > 0 && onApplyFilter)) && (
        <div className="ca-copilot-actions">
          {hasFollowUp && onOpenFollowUp && (
            <button type="button" className="ca-copilot-followup-btn" onClick={onOpenFollowUp}>
              <DeepSeekMark size={13} />
              <span>{t('composer.fillSalaryBtn')}</span>
            </button>
          )}
          {items.length >= 2 && onOpenMatrix && (
            <button type="button" className="ca-copilot-matrix-btn" onClick={onOpenMatrix}>
              <span>{t('composer.fullMatrixBtn')}</span>
              <span aria-hidden="true">↗</span>
            </button>
          )}
          {ids.length > 0 && onApplyFilter && (
            <button type="button" className="ca-text-button" onClick={() => onApplyFilter({
              label: data.title || t('composer.compareShort', { count: ids.length }),
              ids,
              reasons: Object.fromEntries(items.filter(i => i.verdict).map(i => [i.opportunityId, i.verdict])),
            })}>{t('composer.filterLeftOnly', { count: ids.length })}</button>
          )}
        </div>
      )}
    </article>
  }

  const refs = Array.isArray(data.referencedJobs) ? data.referencedJobs : []
  const suggested = data.suggestedFilter
  return <article className="ca-copilot-card is-answer">
    <div className="ca-copilot-head">
      <span className="ca-copilot-kind">{t('composer.kindAnswer')}</span>
      {summary && <span className="ca-copilot-title">{summary}</span>}
      <button type="button" className="ca-copilot-close" aria-label={t('composer.closeReplyAria')} onClick={onDismiss}>×</button>
    </div>
    {data.answer && <MarkdownProse text={data.answer} className="ca-copilot-md" />}
    {refs.length > 0 && (
      <div className="ca-copilot-refs">
        {refs.map(ref => (
          <button key={ref.opportunityId} type="button" className="ca-copilot-ref-chip"
            onClick={() => onOpenJob?.(ref.opportunityId, 'jd')}>
            <strong>{ref.company}</strong>
            <span>{ref.title}</span>
            {ref.note && <small>{ref.note}</small>}
          </button>
        ))}
      </div>
    )}
    {(hasFollowUp || (suggested?.opportunityIds?.length > 0 && onApplyFilter)) && (
      <div className="ca-copilot-actions">
        {hasFollowUp && onOpenFollowUp && (
          <button type="button" className="ca-copilot-followup-btn" onClick={onOpenFollowUp}>
            <DeepSeekMark size={13} />
            <span>{t('composer.addInfoJudge')}</span>
          </button>
        )}
        {suggested?.opportunityIds?.length > 0 && onApplyFilter && (
          <button type="button" className="ca-text-button" onClick={() => onApplyFilter({
            label: suggested.label || t('composer.aiFilterLabel'),
            ids: suggested.opportunityIds,
          })}>{t('composer.filterLeftJobs', { count: suggested.opportunityIds.length })}</button>
        )}
      </div>
    )}
  </article>
}

function JobMultiPickerPopover({ anchorRef, opportunities, selectedIds, onToggle, onSetIds, onCompareNow, onClose }) {
  const { t } = useI18n()
  const popRef = React.useRef(null)
  const searchRef = React.useRef(null)
  const [search, setSearch] = React.useState('')
  const [pos, setPos] = React.useState(null)

  const updatePos = React.useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const popWidth = Math.min(352, window.innerWidth - 24)
    const estHeight = 396
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - popWidth - 12))
    const spaceAbove = rect.top - 12
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const openUp = spaceAbove >= Math.min(estHeight, 260) || spaceAbove > spaceBelow
    if (openUp) {
      setPos({ left, bottom: Math.max(12, window.innerHeight - rect.top + 8), width: popWidth, maxHeight: Math.min(420, Math.max(220, spaceAbove - 8)) })
    } else {
      setPos({ left, top: rect.bottom + 8, width: popWidth, maxHeight: Math.min(420, Math.max(220, spaceBelow - 8)) })
    }
  }, [anchorRef])

  React.useLayoutEffect(() => {
    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [updatePos])

  const mountNode = (typeof document !== 'undefined' && document.querySelector('.ca-page')) || document.body
  const isDialogMounted = Boolean(pos && mountNode)
  const dismissOutside = React.useCallback(next => {
    if (!next) onClose?.()
  }, [onClose])
  useDismissOnOutsidePointer(anchorRef, isDialogMounted, dismissOutside, popRef)
  useModalLayer(popRef, isDialogMounted, onClose)

  React.useEffect(() => {
    if (!isDialogMounted) return undefined
    const timer = window.setTimeout(() => searchRef.current?.focus(), 20)
    return () => window.clearTimeout(timer)
  }, [isDialogMounted])

  const selectedSet = new Set(selectedIds)
  const needle = search.trim().toLowerCase()

  const grouped = React.useMemo(() => {
    const buckets = new Map(PICKER_GROUPS.map(g => [g.id, []]))
    for (const opp of opportunities) {
      if (!opp?.id) continue
      const group = stageGroupFor(opp)
      if (group.id === 'discovered' && opp.feedback?.status === 'dismissed' && !selectedSet.has(opp.id) && !needle) continue
      if (group.id === 'closed' && !selectedSet.has(opp.id) && !needle) continue
      if (needle) {
        const hay = `${opp.company || ''} ${opp.title || ''} ${opp.location || ''}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      buckets.get(group.id).push(opp)
    }
    for (const [id, list] of buckets.entries()) {
      list.sort((a, b) => {
        if (id === 'discovered') {
          return (Number(b.match?.score) || 0) - (Number(a.match?.score) || 0)
            || (b.verifiedAt || '').localeCompare(a.verifiedAt || '')
        }
        return (b.receiptCount || 0) - (a.receiptCount || 0)
          || (Number(b.match?.score) || 0) - (Number(a.match?.score) || 0)
          || (b.verifiedAt || '').localeCompare(a.verifiedAt || '')
      })
    }
    return PICKER_GROUPS
      .map(g => ({ ...g, items: g.id === 'discovered' ? buckets.get(g.id).slice(0, needle ? 50 : 18) : buckets.get(g.id).slice(0, 60) }))
      .filter(g => g.items.length > 0)
  }, [opportunities, needle, selectedIds])

  const offerIds = React.useMemo(() => opportunities.filter(o => stageGroupFor(o).id === 'offer').map(o => o.id), [opportunities])
  const offerAndInterviewIds = React.useMemo(
    () => opportunities.filter(o => { const id = stageGroupFor(o).id; return id === 'offer' || id === 'interview' }).map(o => o.id),
    [opportunities],
  )

  if (!isDialogMounted) return null

  return createPortal(
    <div
      ref={popRef}
      className="ca-compose-job-pop ca-popover-surface"
      role="dialog"
      aria-label={t('composer.pickerAria')}
      style={{
        position: 'fixed',
        left: `${pos.left}px`,
        width: `${pos.width}px`,
        maxHeight: `${pos.maxHeight}px`,
        ...(pos.bottom != null ? { bottom: `${pos.bottom}px` } : { top: `${pos.top}px` }),
      }}
    >
      <div className="ca-compose-job-pop-head">
        <input
          ref={searchRef}
          type="search"
          className="ca-compose-job-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('composer.pickerSearchPlaceholder')}
          aria-label={t('composer.pickerSearchAria')}
        />
        {!needle && (offerIds.length >= 2 || offerAndInterviewIds.length >= 2) && (
          <div className="ca-compose-job-shortcuts">
            {offerIds.length >= 2 && (
              <button
                type="button"
                className="ca-compose-job-shortcut is-offer"
                onClick={() => onSetIds(offerIds.slice(0, MAX_SELECTED_JOBS))}
              >
                {t('composer.selectAllOffers', { count: offerIds.length })}
              </button>
            )}
            {offerAndInterviewIds.length >= 2 && offerAndInterviewIds.length > offerIds.length && (
              <button
                type="button"
                className="ca-compose-job-shortcut"
                onClick={() => onSetIds(offerAndInterviewIds.slice(0, MAX_SELECTED_JOBS))}
              >
                {t('composer.selectOffersInterviews', { count: Math.min(offerAndInterviewIds.length, MAX_SELECTED_JOBS) })}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="ca-compose-job-pop-list" role="listbox" aria-multiselectable="true">
        {grouped.length === 0 ? (
          <p className="ca-compose-job-empty">{t('composer.pickerEmpty')}</p>
        ) : grouped.map(group => (
          <div key={group.id} className="ca-compose-job-group">
            <div className="ca-compose-job-group-label">
              <span>{t(group.labelKey)}</span>
              <span className="ca-compose-job-group-count">{group.items.length}</span>
            </div>
            {group.items.map(opp => {
              const checked = selectedSet.has(opp.id)
              const atLimit = !checked && selectedIds.length >= MAX_SELECTED_JOBS
              const score = Number.isFinite(opp.match?.score) ? Math.round(opp.match.score) : null
              return (
                <button
                  key={opp.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  disabled={atLimit}
                  className={`ca-compose-job-opt${checked ? ' is-selected' : ''}`}
                  onClick={() => onToggle(opp.id)}
                >
                  <span className={`ca-compose-job-check${checked ? ' is-checked' : ''}`} aria-hidden="true">
                    {checked && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M2.4 6.2 4.9 8.7 9.6 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="ca-compose-job-opt-copy">
                    <strong>{opp.company || t('common.unknownCompany')}</strong>
                    <span>{opp.title || t('common.untitledRole')}</span>
                  </span>
                  <span className={`ca-compose-job-stage is-tone-${group.tone}`}>
                    {group.id === 'discovered' && score != null ? t('composer.scoreUnit', { score }) : t(group.badgeKey)}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="ca-compose-job-pop-foot">
        <span className="ca-compose-job-pop-count">
          {t('composer.selectedCount')} <b>{selectedIds.length}</b> / {MAX_SELECTED_JOBS}
          {selectedIds.length > 0 && (
            <button type="button" className="ca-compose-job-clear" onClick={() => onSetIds([])}>{t('common.clear')}</button>
          )}
        </span>
        <div className="ca-compose-job-pop-btns">
          <button type="button" className="ca-compose-job-done" onClick={onClose}>{t('common.done')}</button>
          {selectedIds.length >= 2 && (
            <button type="button" className="ca-compose-job-eval" onClick={onCompareNow}>
              {t('composer.evaluateNowArrow')}
            </button>
          )}
        </div>
      </div>
    </div>,
    mountNode,
  )
}

function FollowUpInquiryModal({ followUp, preliminary, busy, onSubmit, onSkip }) {
  const { t } = useI18n()
  const dialogRef = React.useRef(null)
  const [values, setValues] = React.useState({})
  const [extraNote, setExtraNote] = React.useState('')

  React.useEffect(() => {
    setValues({})
    setExtraNote('')
  }, [followUp])

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

  const fields = Array.isArray(followUp?.fields) ? followUp.fields : []
  const filledCount = fields.filter(f => String(values[f.id] || '').trim()).length + (extraNote.trim() ? 1 : 0)

  const handleSubmit = event => {
    event.preventDefault()
    if (busy) return
    const lines = []
    for (const field of fields) {
      const val = String(values[field.id] || '').trim()
      if (val) lines.push(`- ${field.label}: ${val}`)
    }
    if (extraNote.trim()) lines.push(`- ${t('composer.extraNoteLabel')}: ${extraNote.trim()}`)
    const message = lines.length > 0
      ? t('composer.followUpPromptWithData', { lines: lines.join('\n') })
      : t('composer.followUpPromptSkip')
    onSubmit(message)
  }

  return (
    <dialog
      ref={dialogRef}
      className="ca-followup-dialog"
      aria-label={followUp?.title || t('composer.followUpAria')}
      onCancel={event => { event.preventDefault(); onSkip() }}
      onClick={event => { if (event.target === dialogRef.current) onSkip() }}
    >
      <form className="ca-followup-form" onSubmit={handleSubmit}>
        <div className="ca-followup-head">
          <div className="ca-followup-head-top">
            <span className="ca-followup-badge">
              <DeepSeekMark size={13} />
              <span>{t('composer.followUpBadge')}</span>
            </span>
            <button type="button" className="ca-followup-close" aria-label={t('composer.followUpCloseAria')} onClick={onSkip}>×</button>
          </div>
          <h3>{followUp?.title || t('composer.followUpDefaultTitle')}</h3>
          {followUp?.reason && <p className="ca-followup-reason">{followUp.reason}</p>}
          {preliminary && (
            <div className="ca-followup-prelim">
              <span>{t('composer.preliminaryVerdict')}</span>
              <p>{preliminary}</p>
            </div>
          )}
        </div>

        <div className="ca-followup-body">
          {fields.map(field => {
            const val = values[field.id] ?? ''
            return (
              <div key={field.id} className="ca-followup-field">
                <label className="ca-followup-label" htmlFor={`ca-fq-${field.id}`}>
                  <span>{field.label}</span>
                  <em>{t('common.optional')}</em>
                </label>
                <input
                  id={`ca-fq-${field.id}`}
                  type="text"
                  className="ca-followup-input"
                  value={val}
                  placeholder={field.placeholder || t('composer.followUpPlaceholder')}
                  onChange={e => setValues(cur => ({ ...cur, [field.id]: e.target.value }))}
                />
                {Array.isArray(field.options) && field.options.length > 0 && (
                  <div className="ca-followup-opts">
                    {field.options.map(opt => {
                      const active = val === opt
                      return (
                        <button
                          key={opt}
                          type="button"
                          className={`ca-followup-opt${active ? ' is-active' : ''}`}
                          onClick={() => setValues(cur => ({ ...cur, [field.id]: cur[field.id] === opt ? '' : opt }))}
                        >
                          {opt}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          <div className="ca-followup-field">
            <label className="ca-followup-label" htmlFor="ca-fq-extra">
              <span>{t('composer.extraNoteLabel')}</span>
              <em>{t('common.optional')}</em>
            </label>
            <input
              id="ca-fq-extra"
              type="text"
              className="ca-followup-input"
              value={extraNote}
              placeholder={t('composer.extraNotePlaceholder')}
              onChange={e => setExtraNote(e.target.value)}
            />
          </div>
        </div>

        <div className="ca-followup-foot">
          <Button variant="ghost" size="sm" onClick={onSkip}>{t('composer.skipFollowUp')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {filledCount > 0 ? t('composer.submitFollowUpCount', { count: filledCount }) : t('composer.giveFinalAdvice')}
          </Button>
        </div>
      </form>
    </dialog>
  )
}

function CompareMatrixModal({ reply, oppById, onOpenJob, onOpenFollowUp, onClose }) {
  const { t } = useI18n()
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

  const data = reply?.data || {}
  const items = Array.isArray(data.items) ? data.items : []
  const dims = Array.isArray(data.dimensions) ? data.dimensions : []
  const hasFollowUp = Array.isArray(data.followUp?.fields) && data.followUp.fields.length > 0

  return (
    <dialog
      ref={dialogRef}
      className="ca-matrix-dialog"
      aria-label={data.title || t('composer.matrixAria')}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === dialogRef.current) onClose() }}
    >
      <div className="ca-matrix-wrap">
        <div className="ca-matrix-head">
          <div className="ca-matrix-head-top">
            <span className="ca-followup-badge">{t('composer.matrixBadge', { count: items.length })}</span>
            <button type="button" className="ca-followup-close" aria-label={t('composer.matrixCloseAria')} onClick={onClose}>×</button>
          </div>
          <h3>{data.title || t('composer.compareDefaultTitle')}</h3>
          {data.recommendation && <p className="ca-matrix-rec">{data.recommendation}</p>}
        </div>

        <div className="ca-matrix-scroll">
          <table className="ca-matrix-table">
            <thead>
              <tr>
                <th className="ca-matrix-dim-col">{t('composer.matrixDimCol')}</th>
                {items.map((item, idx) => {
                  const liveOpp = oppById?.get(item.opportunityId)
                  const grp = stageGroupFor(liveOpp || { stage: item.stage })
                  return (
                    <th key={item.opportunityId} className="ca-matrix-job-col">
                      <div className="ca-matrix-col-top">
                        <span className={`ca-compare-rank${idx === 0 ? ' is-top' : ''}`}>{idx + 1}</span>
                        <span className={`ca-compose-job-stage is-tone-${grp.tone}`}>{t(grp.badgeKey)}</span>
                        {Number.isFinite(item.fitScore) && (
                          <span className="ca-compare-score">{item.fitScore}%</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="ca-matrix-col-link"
                        onClick={() => { onClose(); onOpenJob?.(item.opportunityId, 'jd') }}
                      >
                        <strong>{item.company}</strong>
                        <span>{item.title}</span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>{t('composer.matrixVerdict')}</th>
                {items.map(item => <td key={item.opportunityId} className="is-verdict">{item.verdict || '—'}</td>)}
              </tr>
              <tr>
                <th>{t('composer.matrixPros')}</th>
                {items.map(item => <td key={item.opportunityId} className="is-pro">{item.pros || '—'}</td>)}
              </tr>
              <tr>
                <th>{t('composer.matrixCons')}</th>
                {items.map(item => <td key={item.opportunityId} className="is-con">{item.cons || '—'}</td>)}
              </tr>
              {dims.map(dim => (
                <tr key={dim.name}>
                  <th>{dim.name}</th>
                  {items.map(item => <td key={item.opportunityId}>{dim.values?.[item.opportunityId] || '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ca-followup-foot">
          {hasFollowUp && onOpenFollowUp && (
            <Button variant="outline" size="sm" onClick={() => { onClose(); onOpenFollowUp() }}>
              <span className="ca-inline-mark"><DeepSeekMark size={13} /><span>{t('composer.matrixFillSalaryBtn')}</span></span>
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </dialog>
  )
}

export default function Composer({
  config, act, busy, intakes, opportunities = [], viewSourceIds, onApplied, onApplyFilter, onOpenJob,
  opportunity, onCancel, initialText = '', initialTextKey = 0, onSeedConsumed, showStarters = false, compact = false,
  placeholderOverride = '', fallbackOverride = '', focusNonce = 0, surface = 'jobs',
}) {
  const { t } = useI18n()
  const catalog = useModels()
  const field = React.useRef(null)
  const pickerBtnRef = React.useRef(null)
  const inFlight = React.useRef(false)
  const [text, setText] = React.useState(initialText)
  const textRef = React.useRef(text)
  textRef.current = text
  const [sendError, setSendError] = React.useState('')
  const [seedNote, setSeedNote] = React.useState('')
  const [activeId, setActiveId] = React.useState('')
  const [priorId, setPriorId] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [submitStartedAt, setSubmitStartedAt] = React.useState(0)
  const [submitLabel, setSubmitLabel] = React.useState('')
  const elapsedMs = useElapsedSeconds(submitting, submitStartedAt)
  const [assistantReply, setAssistantReply] = React.useState(null)
  const [inquiryOpen, setInquiryOpen] = React.useState(false)
  const [matrixOpen, setMatrixOpen] = React.useState(false)
  const [history, setHistory] = React.useState([])
  const [selectedJobIds, setSelectedJobIds] = React.useState([])
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const opportunityId = typeof opportunity === 'string' ? opportunity : opportunity?.id
  const canPickJobs = !opportunityId && !compact && Array.isArray(opportunities) && opportunities.length > 0
  const oppById = React.useMemo(() => new Map((Array.isArray(opportunities) ? opportunities : []).map(o => [o.id, o])), [opportunities])
  const selectedJobs = React.useMemo(
    () => selectedJobIds.map(id => oppById.get(id)).filter(Boolean),
    [selectedJobIds, oppById],
  )
  const hasSelectedOffer = selectedJobs.some(job => stageGroupFor(job).id === 'offer')
  const model = config?.model || resolveDefaultModelRoute(catalog.rows)
  const tabModel = config?.tabModel || model
  const proposals = (Array.isArray(intakes) ? intakes : []).filter(item => item?.id && (!opportunityId
    || item.id === activeId || item.data?.opportunityId === opportunityId || item.opportunityId === opportunityId)).toReversed()
  const active = proposals.find(item => item.id === activeId)
  const activeQuestion = active?.kind === 'clarify' || !!active?.question
  const replying = proposals.find(item => item.id === priorId)
  const disabled = !!busy || submitting
  const starterPrompts = React.useMemo(() => [
    t('composer.starter1'),
    t('composer.starter2'),
    t('composer.starter3'),
  ], [t])

  React.useEffect(() => {
    if (!initialText) return
    onSeedConsumed?.()
    if (textRef.current.trim().length > 0) {
      setSeedNote(t('composer.seedPreservedDraft'))
      window.requestAnimationFrame(() => field.current?.focus())
      return
    }
    setSeedNote('')
    setSendError('')
    setSelectedJobIds([])
    setText(initialText)
    window.requestAnimationFrame(() => {
      if (!field.current) return
      field.current.focus()
      field.current.setSelectionRange(initialText.length, initialText.length)
    })
  }, [initialText, initialTextKey, onSeedConsumed, t])

  React.useEffect(() => {
    if (!focusNonce) return
    window.requestAnimationFrame(() => {
      field.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      field.current?.focus()
    })
  }, [focusNonce])

  React.useEffect(() => {
    if (activeId && activeQuestion) {
      setPriorId(activeId)
      field.current?.focus()
    }
  }, [activeId, activeQuestion])

  const toggleJobSelection = id => {
    setSelectedJobIds(cur => {
      if (cur.includes(id)) return cur.filter(item => item !== id)
      if (cur.length >= MAX_SELECTED_JOBS) return cur
      return [...cur, id]
    })
  }

  async function send(overrideText, overrideIds) {
    const chosenIds = Array.isArray(overrideIds) ? overrideIds : selectedJobs.map(j => j.id)
    const raw = typeof overrideText === 'string' ? overrideText : text
    const next = raw.trim()
    if (inFlight.current || submitting || !next || !model) return
    inFlight.current = true
    setPickerOpen(false)
    setInquiryOpen(false)
    setSubmitStartedAt(Date.now())
    setSubmitLabel(composerStatusLabel(next, opportunityId, chosenIds.length, t))
    setSubmitting(true)
    try {
      const explicitModel = config?.model || ''
      const payload = {
        ...(viewSourceIds?.length && { viewSourceIds }),
        text: next,
        ...(explicitModel && { model: explicitModel }),
        ...(replying && { priorId }),
        ...(opportunityId && { opportunityId }),
        ...(!opportunityId && chosenIds.length > 0 && { selectedOpportunityIds: chosenIds }),
        ...(!replying && history.length > 0 && { history: history.slice(-8) }),
      }
      const runner = typeof act?.background === 'function' ? act.background : act
      setSendError('')
      setSeedNote('')
      const reply = await runner('draft-intake', payload)
      if (!reply?.ok) {
        const msg = reply?.error || (typeof act?.getLastError === 'function' ? act.getLastError() : '') || t('composer.sendFailedPreserve')
        setSendError(msg)
      }
      if (reply?.ok) {
        const res = reply.result
        if (typeof overrideText !== 'string') setText('')
        setPriorId('')
        if (res?.ephemeral && ['filter', 'compare', 'answer'].includes(res.kind)) {
          setAssistantReply(res)
          if (Array.isArray(res.data?.followUp?.fields) && res.data.followUp.fields.length > 0) {
            setInquiryOpen(true)
          }
          const assistantDigest = res.kind === 'answer'
            ? (res.data?.answer || res.summary || '')
            : res.kind === 'compare'
              ? `${res.data?.title || t('composer.kindCompare')}: ${res.data?.recommendation || res.summary || ''}`
              : (res.summary || res.data?.label || '')
          setHistory(cur => [
            ...cur.slice(-6),
            { role: 'user', text: next.slice(0, 750) },
            { role: 'assistant', text: assistantDigest.slice(0, 750) },
          ])
          if (res.kind === 'filter' && onApplyFilter) {
            if (res.data?.clear) {
              onApplyFilter(null)
            } else {
              onApplyFilter({
                label: res.data?.label || t('composer.aiFilterLabel'),
                ids: Array.isArray(res.data?.opportunityIds) ? res.data.opportunityIds : [],
                reasons: res.data?.reasons || {},
                stage: res.data?.stage || undefined,
              })
            }
          }
        } else {
          setActiveId(res?.id ?? '')
        }
      }
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const triggerCompareSelected = (ids = selectedJobs.map(j => j.id)) => {
    if (!ids.length) return
    const prompt = ids.length >= 2
      ? (hasSelectedOffer ? t('composer.comparePromptOffer') : t('composer.comparePromptJobs'))
      : t('composer.comparePromptSingle')
    void send(prompt, ids)
  }

  const placeholder = replying
    ? t('composer.placeholderReply')
    : selectedJobs.length >= 2
      ? (hasSelectedOffer
        ? t('composer.placeholderMultiOffer', { count: selectedJobs.length })
        : t('composer.placeholderMultiJobs', { count: selectedJobs.length }))
      : selectedJobs.length === 1
        ? t('composer.placeholderSingleJob', { company: selectedJobs[0].company })
        : (placeholderOverride || (opportunityId ? t('composer.placeholderJobDetail') : t('composer.placeholderRoot')))

  const explicitTabModel = config?.tabModel || config?.model || ''
  const allowTabSuggest = config?.tabAutocomplete !== false
  const selectedIdsKey = selectedJobIds.join(',')
  const suggestContext = React.useMemo(() => {
    const isLibrary = surface === 'library'
    const scopedIds = isLibrary ? [] : (opportunityId ? [opportunityId] : selectedJobIds)
    const activeOpportunityId = isLibrary ? '' : (opportunityId || (selectedJobIds.length === 1 ? selectedJobIds[0] : ''))
    return {
      enabled: allowTabSuggest && !disabled && Boolean(tabModel) && !replying,
      tabEnabled: allowTabSuggest,
      key: `${allowTabSuggest ? 1 : 0}:${surface}:${opportunityId || 'root'}:${selectedIdsKey}:${proposals.length}`,
      opportunityId: activeOpportunityId,
      selectedOpportunityIds: scopedIds,
      model: explicitTabModel,
    }
  }, [allowTabSuggest, disabled, tabModel, explicitTabModel, replying, surface, opportunityId, selectedJobIds, selectedIdsKey, proposals.length])

  const fallbackHint = replying
    ? ''
    : selectedJobs.length >= 2
      ? (hasSelectedOffer ? t('composer.fallbackMultiOffer') : t('composer.fallbackMultiJobs'))
      : selectedJobs.length === 1
        ? t('composer.fallbackSingleJob')
        : (fallbackOverride || (opportunityId ? t('composer.fallbackJobDetail') : t('composer.fallbackRoot')))

  const activeFollowUp = assistantReply?.data?.followUp
  const prelimSummary = assistantReply?.kind === 'compare'
    ? (assistantReply.data?.recommendation || assistantReply.summary || '')
    : (assistantReply?.data?.answer?.slice(0, 180) || assistantReply?.summary || '')

  return <section className="ca-compose" data-surface="composer" aria-label={opportunityId ? t('composer.ariaFollowUpJob') : t('composer.ariaCommandInput')}>
    {assistantReply && (
      <AssistantReplyCard
        reply={assistantReply}
        oppById={oppById}
        onOpenJob={onOpenJob}
        onApplyFilter={onApplyFilter}
        onOpenFollowUp={activeFollowUp ? () => setInquiryOpen(true) : undefined}
        onOpenMatrix={assistantReply.kind === 'compare' ? () => setMatrixOpen(true) : undefined}
        onDismiss={() => { setAssistantReply(null); setInquiryOpen(false); setMatrixOpen(false); setHistory([]) }}
      />
    )}
    {matrixOpen && assistantReply?.kind === 'compare' && (
      <CompareMatrixModal
        reply={assistantReply}
        oppById={oppById}
        onOpenJob={onOpenJob}
        onOpenFollowUp={activeFollowUp ? () => setInquiryOpen(true) : undefined}
        onClose={() => setMatrixOpen(false)}
      />
    )}
    {inquiryOpen && activeFollowUp && (
      <FollowUpInquiryModal
        followUp={activeFollowUp}
        preliminary={prelimSummary}
        busy={submitting}
        onSkip={() => setInquiryOpen(false)}
        onSubmit={compiled => void send(compiled)}
      />
    )}
    {proposals.length > 0 && <div className="ca-compose-proposals" aria-label={t('composer.proposalsAria')}>
      {proposals.map(item => <Proposal key={item.id} item={item} act={act} busy={disabled}
        onApplied={(kind, data) => { setPriorId(''); onApplied?.(kind, data) }}
        onReply={id => { setPriorId(id); field.current?.focus() }}
        opportunity={opportunity} timezone={config?.timezone} active={item.id === (priorId || activeId)} />)}
    </div>}
    <form className={`ca-compose-input${compact ? ' is-compact' : ''}`} onSubmit={event => { event.preventDefault(); void send() }}>
      {((opportunityId && !compact) || replying || onCancel) && <div className="ca-compose-context">
        {opportunityId && !compact && <span>{[opportunity.company, opportunity.title].filter(Boolean).join(' · ') || t('composer.currentJob')}</span>}
        {replying && <span>{t('composer.replyConfirm')}</span>}
        {replying && <button className="ca-text-button" type="button" onClick={() => setPriorId('')}>{t('common.cancel')}</button>}
        {onCancel && <button className="ca-text-button" type="button" onClick={onCancel}>{t('common.collapse')}</button>}
      </div>}
      {selectedJobs.length > 0 && (
        <div className="ca-compose-selected-jobs" aria-label={t('composer.selectedJobsAria')}>
          {selectedJobs.map(job => {
            const grp = stageGroupFor(job)
            return (
              <span key={job.id} className={`ca-compose-job-chip is-tone-${grp.tone}`}>
                <em className="ca-compose-job-chip-stage">{t(grp.badgeKey)}</em>
                <span className="ca-compose-job-chip-name" title={`${job.company} · ${job.title}`}>
                  {job.company} · {job.title}
                </span>
                <button
                  type="button"
                  className="ca-compose-job-chip-x"
                  aria-label={t('composer.removeSelectedJobAria', { company: job.company, title: job.title })}
                  onClick={() => toggleJobSelection(job.id)}
                >×</button>
              </span>
            )
          })}
          {selectedJobs.length >= 2 && (
            <button type="button" className="ca-compose-jobs-clear" onClick={() => setSelectedJobIds([])}>{t('common.clear')}</button>
          )}
        </div>
      )}
      <div className="ca-compose-field-pad">
        <GhostInput
          inputRef={field}
          surface={surface}
          value={text}
          onChange={next => { setText(next); if (sendError) setSendError(''); if (seedNote) setSeedNote('') }}
          onSubmit={() => void send()}
          disabled={submitting}
          minRows={compact ? 1 : 2}
          maxLength={24000}
          ariaLabel={t('composer.ariaCommandInput')}
          placeholder={placeholder}
          suggestContext={suggestContext}
          fallbackSuggestion={fallbackHint}
        />
      </div>
      <div className="ca-compose-footer">
        <span className="ca-compose-hint">
          {submitting ? (
            <span className="ca-compose-live" role="status" aria-live="polite">
              <span className="ca-ai-orb is-inline" aria-hidden="true" />
              <span className="ca-compose-live-label">{submitLabel || t('common.processingEllipsis')}</span>
              <span className="ca-compose-live-time">{formatShortSeconds(elapsedMs)}</span>
            </span>
          ) : canPickJobs ? (
            <span className="ca-compose-tools">
              <button
                ref={pickerBtnRef}
                type="button"
                className={`ca-compose-job-btn${selectedJobs.length > 0 ? ' has-selection' : ''}${pickerOpen ? ' is-open' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen(v => !v)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2.2" y="4.5" width="11.6" height="8.5" rx="2" stroke="currentColor" strokeWidth="1.35" />
                  <path d="M5.7 4.5V3.4c0-.66.54-1.2 1.2-1.2h2.2c.66 0 1.2.54 1.2 1.2v1.1" stroke="currentColor" strokeWidth="1.35" />
                </svg>
                <span>{selectedJobs.length > 0 ? t('composer.selectedJobsBtn', { count: selectedJobs.length }) : t('composer.selectJobsBtn')}</span>
              </button>
              {selectedJobs.length >= 2 && !text.trim() && (
                <button
                  type="button"
                  className="ca-compose-quick-eval"
                  disabled={!model}
                  onClick={() => triggerCompareSelected()}
                >
                  <DeepSeekMark size={13} />
                  <span>{t('composer.evaluateNow')}</span>
                </button>
              )}
            </span>
          ) : null}
        </span>
        <button className={`ca-send-btn${submitting ? ' is-loading' : ''}`} type="submit" data-action="composer-send" disabled={submitting || !text.trim() || !model}
          aria-label={submitting ? t('common.processing') : t('common.send')} title={submitting ? t('common.processingEllipsis') : t('common.sendWithEnter')}>
          {submitting ? (
            <span className="ca-send-spinner" aria-hidden="true" />
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 13V3.5M8 3.5L3.8 7.7M8 3.5l4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </form>
    {pickerOpen && canPickJobs && (
      <JobMultiPickerPopover
        anchorRef={pickerBtnRef}
        opportunities={opportunities}
        selectedIds={selectedJobIds}
        onToggle={toggleJobSelection}
        onSetIds={ids => setSelectedJobIds(ids.slice(0, MAX_SELECTED_JOBS))}
        onCompareNow={() => triggerCompareSelected(selectedJobIds)}
        onClose={() => setPickerOpen(false)}
      />
    )}
    {showStarters && !text && !proposals.length && <div className="ca-starter-row">
      {starterPrompts.map(prompt => <button key={prompt} type="button" className="ca-starter-chip"
        onClick={() => { setText(prompt); field.current?.focus() }}>{prompt}</button>)}
    </div>}
    {seedNote && <p className="ca-compose-status" role="status">{seedNote}</p>}
    {sendError && (
      <div className="ca-form-error" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '6px' }}>
        <span>{sendError}</span>
        <button type="button" className="ca-text-button ca-nowrap-btn" disabled={submitting} onClick={() => void send()}>
          {t('common.retry')}
        </button>
      </div>
    )}
    {!catalog.pending && !model && <p className="ca-compose-status" role="status">
      {catalog.error || t('composer.needModelConfig')}
    </p>}
  </section>
}
