const LOCAL_DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

export function isValidTimeZone(tz) {
  const clean = String(tz || '').trim()
  if (!clean) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: clean })
    return true
  } catch {
    return false
  }
}

export function resolveActiveTimeZone(preferred) {
  if (isValidTimeZone(preferred)) return String(preferred).trim()
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (isValidTimeZone(local)) return local
  } catch {}
  return 'UTC'
}

export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const map = Object.create(null)
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  const hourNum = Number(map.hour)
  const hour = hourNum === 24 ? '00' : String(hourNum).padStart(2, '0')
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(hour),
    minute: Number(map.minute),
    second: Number(map.second),
    yearStr: map.year,
    monthStr: map.month,
    dayStr: map.day,
    hourStr: hour,
    minuteStr: map.minute,
  }
}

function zonedWallClockUtcMs(epochMs, timeZone) {
  const p = zonedParts(new Date(epochMs), timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

function formatOffsetLabel(offsetMs, epochMs, timeZone) {
  const totalMin = Math.round(offsetMs / 60_000)
  const sign = totalMin >= 0 ? '+' : '-'
  const abs = Math.abs(totalMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  let abbr = ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(epochMs))
    abbr = parts.find(p => p.type === 'timeZoneName')?.value || ''
  } catch {}
  const utcStr = `UTC${sign}${hh}${mm === '00' ? '' : `:${mm}`}`
  return abbr && !abbr.startsWith('GMT') ? `${abbr} (${utcStr})` : utcStr
}

/**
 * Format a Date / ISO timestamp / epoch ms as `YYYY-MM-DDTHH:mm` in `timeZone`
 * for `<input type="datetime-local">`.
 */
export function toZonedDatetimeInput(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const tz = resolveActiveTimeZone(timeZone)
  const p = zonedParts(date, tz)
  return `${p.yearStr}-${p.monthStr}-${p.dayStr}T${p.hourStr}:${p.minuteStr}`
}

/**
 * Inspects a wall-clock `YYYY-MM-DDTHH:mm` string in `timeZone` for DST anomalies:
 * - `valid`: unique exact wall-clock instant.
 * - `nonexistent`: spring-forward DST gap (e.g. `America/New_York` `2027-03-14T02:30`);
 *   computes forward-shifted `suggestedLocal` / `suggestedIso` (never silently jumps backward!).
 * - `ambiguous`: fall-back repeated hour (e.g. `America/New_York` `2026-11-01T01:30`);
 *   returns both `options` (earlier DST offset and later standard offset).
 */
export function inspectZonedLocalTime(localStr, timeZone) {
  const raw = String(localStr || '').trim()
  if (!raw) return { status: 'invalid', localStr: raw, timeZone: resolveActiveTimeZone(timeZone) }
  const match = LOCAL_DT_RE.exec(raw)
  const tz = isValidTimeZone(timeZone) ? String(timeZone).trim() : resolveActiveTimeZone('')
  if (!match) {
    const parsed = new Date(raw)
    if (!Number.isFinite(parsed.getTime())) return { status: 'invalid', localStr: raw, timeZone: tz }
    return { status: 'valid', localStr: toZonedDatetimeInput(parsed, tz), timeZone: tz, iso: parsed.toISOString() }
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] || 0)
  const targetPrefix = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second)

  // Probe surrounding offsets (up to ±12h window covers every global DST transition cleanly)
  const offsetBefore = zonedWallClockUtcMs(wallUtc - 12 * 3600_000, tz) - (wallUtc - 12 * 3600_000)
  const offsetAfter = zonedWallClockUtcMs(wallUtc + 12 * 3600_000, tz) - (wallUtc + 12 * 3600_000)
  const candBefore = wallUtc - offsetBefore
  const candAfter = wallUtc - offsetAfter
  const matchBefore = toZonedDatetimeInput(candBefore, tz) === targetPrefix
  const matchAfter = toZonedDatetimeInput(candAfter, tz) === targetPrefix

  if (matchBefore && matchAfter && candBefore !== candAfter) {
    const ordered = [
      { epochMs: Math.min(candBefore, candAfter) },
      { epochMs: Math.max(candBefore, candAfter) },
    ].map(({ epochMs }) => {
      const off = zonedWallClockUtcMs(epochMs, tz) - epochMs
      return {
        iso: new Date(epochMs).toISOString(),
        offsetLabel: formatOffsetLabel(off, epochMs, tz),
      }
    })
    return {
      status: 'ambiguous',
      localStr: targetPrefix,
      timeZone: tz,
      iso: ordered[0].iso,
      options: ordered,
    }
  }
  if (matchBefore) {
    return { status: 'valid', localStr: targetPrefix, timeZone: tz, iso: new Date(candBefore).toISOString() }
  }
  if (matchAfter) {
    return { status: 'valid', localStr: targetPrefix, timeZone: tz, iso: new Date(candAfter).toISOString() }
  }

  // Spring-forward nonexistent gap: shift forward by the gap size (`offsetBefore` maps wallUtc forward into the post-transition clock)
  const forwardMs = wallUtc - offsetBefore
  const suggestedLocal = toZonedDatetimeInput(forwardMs, tz)
  return {
    status: 'nonexistent',
    localStr: targetPrefix,
    timeZone: tz,
    suggestedIso: new Date(forwardMs).toISOString(),
    suggestedLocal,
  }
}

/**
 * Convert a `YYYY-MM-DDTHH:mm` wall-clock string interpreted in `timeZone`
 * into an ISO-8601 UTC timestamp string.
 * - For fall-back ambiguous times, honors `disambiguation: 'earlier' | 'later'`.
 * - For spring-forward gaps, shifts forward cleanly (never backward).
 */
export function zonedLocalToIso(localStr, timeZone, { disambiguation = 'earlier' } = {}) {
  const raw = String(localStr || '').trim()
  if (!raw) return ''
  const match = LOCAL_DT_RE.exec(raw)
  if (!match) {
    const parsed = new Date(raw)
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ''
  }
  if (!isValidTimeZone(timeZone)) {
    const parsed = new Date(raw)
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ''
  }
  const info = inspectZonedLocalTime(raw, timeZone)
  if (info.status === 'valid') return info.iso
  if (info.status === 'ambiguous') {
    return disambiguation === 'later' ? info.options[1].iso : info.options[0].iso
  }
  if (info.status === 'nonexistent') return info.suggestedIso
  return ''
}

/**
 * DST-safe local calendar-day delta between `targetMs` and `nowMs` in `timeZone`.
 * Returns `0` for same calendar day, `1` for tomorrow, `2` for day after tomorrow, etc.
 * Immune to 23-hour and 25-hour DST transition days.
 */
export function zonedCalendarDayDelta(targetMs, nowMs, timeZone) {
  const tz = resolveActiveTimeZone(timeZone)
  const t = zonedParts(new Date(targetMs), tz)
  const n = zonedParts(new Date(nowMs), tz)
  const tDay = Date.UTC(t.year, t.month - 1, t.day)
  const nDay = Date.UTC(n.year, n.month - 1, n.day)
  return Math.round((tDay - nDay) / 86_400_000)
}

export function buildZonedQuickSlot(daysAhead, hour, minute = 0, durationMin = 60, timeZone, now = new Date()) {
  const tz = resolveActiveTimeZone(timeZone)
  const today = zonedParts(now instanceof Date ? now : new Date(now), tz)
  const targetDay = new Date(Date.UTC(today.year, today.month - 1, today.day + daysAhead))
  const pad = n => String(n).padStart(2, '0')
  const startsAt = `${targetDay.getUTCFullYear()}-${pad(targetDay.getUTCMonth() + 1)}-${pad(targetDay.getUTCDate())}T${pad(hour)}:${pad(minute)}`
  const startMs = Date.parse(zonedLocalToIso(startsAt, tz))
  const endsAt = Number.isFinite(startMs)
    ? toZonedDatetimeInput(new Date(startMs + durationMin * 60 * 1000), tz)
    : startsAt
  return { startsAt, endsAt }
}

export function buildZonedDeadlineSlot(daysAhead, timeZone, now = new Date()) {
  return buildZonedQuickSlot(daysAhead, 18, 0, 0, timeZone, now).startsAt
}
