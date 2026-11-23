import React from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useI18n } from './i18n.jsx'

const closedStages = new Set(['rejected', 'withdrawn', 'offer_declined', 'offer_accepted', 'started'])
const interviewOrder = { interview_invited: 1, interview_confirmed: 2, interview_completed: 3 }
const ROUND_ORDINAL_ZH_FU = new Map([['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['初', 1], ['复', 2]])
const ROUND_ORDINAL_EN_FU = new Map([
  ['first', 1], ['1st', 1], ['one', 1],
  ['second', 2], ['2nd', 2], ['two', 2],
  ['third', 3], ['3rd', 3], ['three', 3],
  ['fourth', 4], ['4th', 4], ['four', 4],
  ['fifth', 5], ['5th', 5], ['five', 5],
  ['sixth', 6], ['6th', 6], ['six', 6],
])
const TRACK_QUALIFIERS_FU = [
  ['tech', /^(?:技术|tech(?:nical)?)$/iu],
  ['business', /^(?:业务|产品|business|product)$/iu],
  ['hm', /^(?:主管|经理|hiring\s*manager|hm|manager)$/iu],
  ['cross', /^(?:交叉|跨团队|cross[- ]?team|cross)$/iu],
  ['sysdesign', /^(?:系统设计|架构|system\s*design|architecture)$/iu],
  ['coding', /^(?:算法|编码|代码|coding|algorithm)$/iu],
  ['behavioral', /^(?:行为|文化|behavioral|culture)$/iu],
  ['domain', /^(?:专业|domain)$/iu],
]

function normalizeTrackQualifierFu(raw) {
  const clean = String(raw || '').trim()
  if (!clean || /^(?:电话|视频|线上|现场|phone|video|panel|online)$/iu.test(clean)) return ''
  for (const [key, re] of TRACK_QUALIFIERS_FU) if (re.test(clean)) return key
  return clean.toLowerCase().replace(/\s+/gu, '-')
}

function canonicalRoundKeyFu(rawRound) {
  const clean = String(rawRound || '').trim().replace(/\s+/gu, ' ')
  if (!clean) return 'round:default'
  const lower = clean.toLowerCase()
  if (/^(?:hr\s*(?:面|面试|初筛|沟通|round|screen|call|chat|interview)?|recruiter\s*(?:screen|call|chat|round)|初筛|电话初筛|phone\s*screen)$/iu.test(lower)) return 'round:hr'
  if (/^(?:终面|最终面|终审|总监终面|boss\s*面|final(?:\s*(?:round|interview|loop))?|onsite(?:\s*(?:loop|interview))?|virtual\s*onsite|loop)$/iu.test(lower)) return 'round:final'
  if (/^(?:加面|补充面|bonus\s*round|extra\s*round|follow[- ]?up\s*(?:round|interview))$/iu.test(lower)) return 'round:extra'
  const zhMatch = clean.match(/^(?:(技术|专业|业务|产品|主管|经理|交叉|跨团队|系统设计|架构|算法|编码|代码|行为|文化|电话|视频|线上|现场)\s*)?(?:第\s*)?([一二三四五六初复1-6])\s*(?:面|轮)(?:试)?$/u)
  if (zhMatch) {
    const num = ROUND_ORDINAL_ZH_FU.get(zhMatch[2]) ?? Number(zhMatch[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifierFu(zhMatch[1])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  const enMatch1 = lower.match(/^(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain|phone|video|panel)\s+)?(?:round|interview|stage)\s*#?\s*([1-6]|first|second|third|fourth|fifth|sixth|one|two|three|four|five|six)$/iu)
  if (enMatch1) {
    const num = ROUND_ORDINAL_EN_FU.get(enMatch1[2]) ?? Number(enMatch1[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifierFu(enMatch1[1])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  const enMatch2 = lower.match(/^(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain|phone|video|panel)\s+)?(1st|2nd|3rd|4th|5th|6th|first|second|third|fourth|fifth|sixth)\s+(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain)\s+)?(?:round|interview|stage)$/iu)
  if (enMatch2) {
    const num = ROUND_ORDINAL_EN_FU.get(enMatch2[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifierFu(enMatch2[1] || enMatch2[3])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  return `round:custom:${lower}`
}

function interviewKeyFu(receipt) {
  const explicitId = typeof receipt?.interviewId === 'string' ? receipt.interviewId.trim() : ''
  if (explicitId) return `id:${explicitId}`
  return canonicalRoundKeyFu(receipt?.round)
}

function parseTime(value) {
  return typeof value === 'string' && value.trim() ? Date.parse(value) : Number.NaN
}

function localCalendarDayUtcMs(value, tzOpt) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...tzOpt, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  }
  const map = Object.create(null)
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value)
  return Date.UTC(map.year, (map.month || 1) - 1, map.day || 1)
}

function formatDateParts(value, timezone, now, { bcp47, isZh, t }) {
  if (!Number.isFinite(value)) return null
  const tzOpt = timezone ? { timeZone: timezone } : {}
  const safeFormat = (date, opts) => {
    try { return new Intl.DateTimeFormat(bcp47, { ...opts, ...tzOpt }).format(date) }
    catch { return new Intl.DateTimeFormat(bcp47, opts).format(date) }
  }
  const month = isZh
    ? safeFormat(value, { month: 'numeric' }).replace(/月?$/, '月')
    : safeFormat(value, { month: 'short' }).toUpperCase()
  const day = safeFormat(value, { day: 'numeric' }).replace(/日$/, '')
  const clock = safeFormat(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  // DST-safe calendar-day difference in target timezone (immune to 23h/25h DST days)
  const dayDelta = Math.round((localCalendarDayUtcMs(value, tzOpt) - localCalendarDayUtcMs(now, tzOpt)) / 86_400_000)
  let rel = ''
  if (value < now) rel = t('followups.overdue')
  else if (dayDelta === 0) rel = t('followups.todayAt', { clock })
  else if (dayDelta === 1) rel = t('followups.tomorrowAt', { clock })
  else if (dayDelta === 2) rel = t('followups.afterTomorrowAt', { clock })
  else {
    const weekday = safeFormat(value, { weekday: 'short' })
    rel = `${weekday} ${clock}`
  }
  return { month, day, clock, rel }
}

function newerInterview(receipt, prior) {
  const delta = parseTime(receipt.occurredAt) - parseTime(prior.occurredAt)
  return delta > 0 || (delta === 0 && interviewOrder[receipt.type] >= interviewOrder[prior.type])
}

const orderTime = (value) => Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER

function followUps(opportunities, now, t) {
  const rows = []
  for (const job of Array.isArray(opportunities) ? opportunities : []) {
    if (!job?.id || closedStages.has(job.stage ?? job.status)) continue
    const title = [job.company?.trim(), job.title?.trim()].filter(Boolean).join(' · ')
    if (!title) continue
    const rounds = new Map()
    let offer
    for (const receipt of Array.isArray(job.receipts) ? job.receipts : []) {
      if (receipt?.confirmed !== true || !Number.isFinite(parseTime(receipt.occurredAt))) continue
      if (receipt.type === 'offer_received' && (!offer || parseTime(receipt.occurredAt) >= parseTime(offer.occurredAt))) {
        offer = receipt
      }
      const round = typeof receipt.round === 'string' ? receipt.round.trim().replace(/\s+/g, ' ') : ''
      if (!round || !Object.hasOwn(interviewOrder, receipt.type)) continue
      const groupKey = interviewKeyFu(receipt)
      const latest = rounds.get(groupKey)
      if (!latest || newerInterview(receipt, latest)) rounds.set(groupKey, receipt)
    }

    if (offer && (job.stage ?? job.status ?? 'offer_received') === 'offer_received') {
      const when = parseTime(offer.replyBy)
      if (Number.isFinite(when)) rows.push({
        id: `${job.id}:offer`, jobId: job.id, kind: 'offer-reply', title, when,
        action: when < now ? t('followups.offerOverdue') : t('followups.replyOffer'),
        subtag: offer.form === 'written' ? t('followups.writtenOffer') : t('followups.verbalOffer'),
        location: '',
        urgent: when < now + 48 * 3600 * 1000,
      })
      continue
    }
    for (const [roundKey, receipt] of rounds) {
      const round = String(receipt.round || '').trim()
      const when = parseTime(receipt.startsAt)
      if (receipt.type === 'interview_invited') rows.push({
        id: `${job.id}:interview:${roundKey}`, jobId: job.id, kind: 'interview-reply', round, roundKey,
        ...(receipt.interviewId && { interviewId: receipt.interviewId }),
        title, when,
        action: t('followups.replyInterview'), subtag: round, location: '',
      })
      if (receipt.type === 'interview_confirmed' && Number.isFinite(when) && when >= now) rows.push({
        id: `${job.id}:interview:${roundKey}`, jobId: job.id, kind: 'interview', round, roundKey,
        ...(receipt.interviewId && { interviewId: receipt.interviewId }),
        title, when,
        action: t('followups.attendInterview'), subtag: round, location: String(receipt.location || '').trim(),
        urgent: when < now + 24 * 3600 * 1000,
      })
    }
  }
  return rows.sort((a, b) => orderTime(a.when) - orderTime(b.when))
}

function matchingSyncBadges(row, personalSync, personalSchedule) {
  const items = Object.values(personalSync?.items ?? {})
  const rowKey = row.roundKey || (row.round ? interviewKeyFu(row) : '')
  const matched = items.filter(item => {
    if (!item || item.pendingDelete) return false
    if (item.opportunityId !== row.jobId || item.kind !== row.kind) return false
    if (!rowKey) return true
    const itemKey = item.roundKey || (item.interviewId ? `id:${item.interviewId}` : (item.round ? canonicalRoundKeyFu(item.round) : ''))
    return !itemKey || itemKey === rowKey
  })
  if (matched.length > 0) return matched
  const expectedDests = row.kind === 'interview' ? ['calendar'] : ['things', 'reminders']
  return expectedDests
    .filter(dest => Boolean(personalSchedule?.[dest]))
    .map(dest => ({ destination: dest, target: personalSchedule[dest], pending: true }))
}

export default function FollowUps({ opportunities, timezone, personalSync, personalSchedule, busy, act, onOpenJob, onSources }) {
  const i18n = useI18n()
  const { t } = i18n
  const now = Date.now()
  const rows = followUps(opportunities, now, t)
  if (!rows.length) return null
  const connectedApps = Object.entries(personalSchedule ?? {}).filter(([, val]) => Boolean(val))
  const destLabel = dest => ({
    calendar: t('destination.calendar'),
    things: t('destination.things'),
    reminders: t('destination.reminders'),
  }[dest] ?? dest)

  return <section className="ca-section ca-followups">
    <div className="ca-section-head">
      <div className="ca-inline">
        <h2>{t('followups.title')}</h2>
        <span className="ca-schedule-count">{rows.length}</span>
      </div>
      <div className="ca-inline">
        {connectedApps.length === 0 && onSources ? (
          <Button variant="ghost" size="sm" onClick={() => onSources('schedule')}>{t('followups.connectApps')}</Button>
        ) : null}
      </div>
    </div>
    <ul className="ca-schedule-list">
      {rows.map(row => {
        const badges = matchingSyncBadges(row, personalSync, personalSchedule)
        const hasFailedBadge = badges.some(b => !b.verified && !b.pending)
        const parts = formatDateParts(row.when, timezone, now, i18n)
        const hasFooter = Boolean(row.location) || badges.length > 0
        return <li key={row.id} className="ca-schedule-item">
          <div className={`ca-schedule-row-wrap${hasFailedBadge ? ' has-retry' : ''}`}>
            <button type="button" className={`ca-schedule-row${row.urgent ? ' is-urgent' : ''}`} onClick={() => onOpenJob(row.jobId, 'progress')}>
              <span className={`ca-date-tile${row.urgent ? ' is-urgent' : row.kind === 'offer-reply' ? ' is-offer' : ''}`} aria-hidden="true">
                {parts ? <>
                  <span className="ca-date-tile-month">{parts.month}</span>
                  <span className="ca-date-tile-day">{parts.day}</span>
                </> : <>
                  <span className="ca-date-tile-month">{t('followups.tbd')}</span>
                  <span className="ca-date-tile-day">—</span>
                </>}
              </span>

              <span className="ca-schedule-body">
                <span className="ca-schedule-top">
                  <span className="ca-schedule-heading">
                    <strong className="ca-schedule-action">{row.action}</strong>
                    {row.subtag && <span className="ca-schedule-subtag">{row.subtag}</span>}
                  </span>
                  {parts && (
                    <time className={`ca-schedule-time${row.urgent ? ' is-urgent' : ''}`} dateTime={new Date(row.when).toISOString()}>
                      {parts.rel}
                    </time>
                  )}
                </span>

                <span className="ca-schedule-role" title={row.title}>{row.title}</span>

                {hasFooter && (
                  <span className="ca-schedule-foot">
                    {row.location && <span className="ca-schedule-loc" title={row.location}>{row.location}</span>}
                    {badges.map(badge => {
                      const label = destLabel(badge.destination)
                      const showTarget = badge.target && badge.target !== label
                      return <span key={`${badge.destination}-${badge.target}`}
                        title={badge.error || undefined}
                        className={`ca-schedule-sync${badge.verified ? ' is-ok' : badge.pending ? ' is-pending' : ' is-err'}`}>
                        {badge.verified ? '✓ ' : badge.pending ? t('followups.pendingSync') : '⚠ '}
                        {label}{showTarget ? ` · ${badge.target}` : ''}
                        {!badge.verified && !badge.pending && badge.error ? ` · ${badge.error}` : ''}
                      </span>
                    })}
                  </span>
                )}
              </span>

              <svg className="ca-schedule-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6.2 4.2 10 8l-3.8 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {hasFailedBadge && connectedApps.length > 0 && (
              <div className="ca-schedule-retry-bar">
                <Button variant="ghost" size="sm" disabled={!!busy || personalSync?.running}
                  onClick={() => act?.('schedule-sync', {}, t('followups.syncToast'))}>
                  {personalSync?.running || busy === 'schedule-sync' ? t('followups.syncing') : t('common.retry')}
                </Button>
              </div>
            )}
          </div>
        </li>
      })}
    </ul>
  </section>
}
