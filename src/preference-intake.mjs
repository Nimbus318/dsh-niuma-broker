const fields = ['intervalMinutes', 'notificationsEnabled', 'notificationHour', 'notificationEndHour', 'allowReflections', 'timezone']
const number = '[0-9零一二两三四五六七八九十]+'
const digits = '零一二三四五六七八九'
const time = `(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)?\\s*(${number})(?:\\s*(?:点|时)(整|半|[0-5]?\\d分)?|:([0-5]\\d))?`
const off = '不要(?:再|开启|启用)?|不再|关闭|停用|暂停|取消|停止|关掉|禁用|别'
const on = '开启|打开|启用|恢复|允许'

function amount(token) {
  if (/^\d+$/u.test(token)) return Number(token)
  const normalized = token.replaceAll('两', '二')
  if (normalized.length === 1 && digits.includes(normalized)) return digits.indexOf(normalized)
  const [tens, units, extra] = normalized.split('十')
  if (units === undefined || extra !== undefined || tens.length > 1 || units.length > 1) return Number.NaN
  return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0)
}

function validTimezone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/u.test(value)) return false
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

export function preferencePatch(input, locale = 'zh') {
  const result = Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]))
  const hour = value => Number.isInteger(value) && value >= 0 && value < 24
  if (!Object.keys(result).length
    || (Object.hasOwn(result, 'intervalMinutes') && (!Number.isInteger(result.intervalMinutes) || result.intervalMinutes < 1 || result.intervalMinutes > 10080))
    || ['notificationsEnabled', 'allowReflections'].some(key => Object.hasOwn(result, key) && typeof result[key] !== 'boolean')
    || (Object.hasOwn(result, 'timezone') && !validTimezone(result.timezone))
    || (['notificationHour', 'notificationEndHour'].some(key => Object.hasOwn(result, key))
      && (!hour(result.notificationHour) || !hour(result.notificationEndHour) || result.notificationHour === result.notificationEndHour))) {
    throw new Error(locale === 'en' ? 'Please verify the preference values to update.' : '请先核对要调整的设置。')
  }
  return result
}

function toggle(text, noun, question, enNoun = '') {
  const verbs = `(${off}|${on})`
  const pattern = new RegExp(`${verbs}\\s*(?:个人|自动|的)?\\s*${noun}|${noun}(?:功能|开关)?\\s*(?:设为|改为)?\\s*${verbs}`, 'gu')
  const isEnabled = value => !new RegExp(`^(?:${off})$`, 'u').test(value)
  const choices = new Set([...text.matchAll(pattern)].map(match => isEnabled(match[1] || match[2])))
  if (enNoun) {
    const enOff = 'turn\\s+off|disable|mute|pause|stop|silence|no\\s+more'
    const enOn = 'turn\\s+on|enable|unmute|resume|allow|activate'
    const enVerbs = `(${enOff}|${enOn})`
    const enPat = new RegExp(`\\b${enVerbs}\\s+(?:my\\s+|the\\s+|personal\\s+|auto\\s+)?${enNoun}\\b|\\b${enNoun}\\s+(?:off|disabled|muted|on|enabled)\\b`, 'giu')
    for (const m of text.matchAll(enPat)) {
      if (m[1]) choices.add(!new RegExp(`^(?:${enOff})$`, 'iu').test(m[1]))
      else choices.add(/\b(?:on|enabled)\b/iu.test(m[0]))
    }
  }
  if (!choices.size && (new RegExp(noun, 'u').test(question) || (enNoun && new RegExp(enNoun, 'iu').test(question)))) {
    const answer = text.match(new RegExp(`^${verbs}[。！!\\s]*$`, 'u'))
    if (answer) return isEnabled(answer[1])
    if (/^\s*(?:on|enable|yes|turn on)[.!\s]*$/iu.test(text)) return true
    if (/^\s*(?:off|disable|no|mute|turn off)[.!\s]*$/iu.test(text)) return false
  }
  return choices.size === 1 ? [...choices][0] : undefined
}

const EN_NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, thirty: 30,
  once: 1, twice: 2, half: 0.5,
}
function enAmount(token) {
  if (!token) return 1
  const low = token.toLowerCase()
  if (/^\d+$/u.test(low)) return Number(low)
  return EN_NUM_WORDS[low] ?? Number.NaN
}

function intervals(text, question) {
  const results = []
  if (/(?:检查|扫描|查看|整理|回看|读取|扫一遍|积累|巡检|盯盘|拉取|抓取|刷新|频率|频次|间隔|定时|更新)/u.test(text + question)) {
    const unitPat = '(分钟|小时|小時|天|日|周|星期)'
    const verbPat = '(?:巡检|检查|扫描|查看|整理|回看|读取|扫一遍|积累|盯盘|拉取|抓取|刷新|同步|运行|执行)'
    const setterPat = '(?:改为|改成|设为|调成|调整为|换成|定为)'
    const cadenceWithQty = `(半|${number})\\s*(?:个\\s*)?${unitPat}`
    const cadenceOptQty = `(半|${number})?\\s*(?:个\\s*)?${unitPat}`
    const pattern = new RegExp(
      `(?:每隔?|隔)\\s*${cadenceOptQty}` +
      `|(?:${setterPat}\\s*)?${cadenceWithQty}(?=\\s*(?:${verbPat})?\\s*(?:${number}|多)\\s*次)` +
      `|${setterPat}\\s*${cadenceWithQty}` +
      `|^${cadenceOptQty}[。！!\\s]*$`,
      'gu',
    )
    const factors = { 分钟: 1, 小时: 60, 小時: 60, 天: 1440, 日: 1440, 周: 10080, 星期: 10080 }
    for (const match of text.matchAll(pattern)) {
      const [, pQty, pUnit, tQty, tUnit, sQty, sUnit, shortQty, shortUnit] = match
      if (shortUnit && !question) continue
      const quantity = pQty ?? tQty ?? sQty ?? shortQty
      const unit = pUnit ?? tUnit ?? sUnit ?? shortUnit
      const tail = text.slice(match.index + match[0].length).split(/[，,。；;！？!?\n]/u)[0]
      if (/^[一二三四五六日1-7]/u.test(tail) && /周|星期/u.test(unit)) continue
      if (/多次/u.test(tail)) continue
      if (!quantity && !/天|日|周|星期/u.test(unit)) continue
      const base = (quantity === '半' ? 0.5 : quantity ? amount(quantity) : 1) * factors[unit]
      if (!Number.isFinite(base) || base < 1) continue
      const timesMatches = [...tail.matchAll(new RegExp(`(${number})\\s*次`, 'gu'))]
      if (timesMatches.length > 1) continue
      if (timesMatches.length === 1) {
        const times = amount(timesMatches[0][1])
        if (!Number.isInteger(times) || times < 1) continue
        const divided = base / times
        if (Number.isInteger(divided) && divided >= 1) results.push(divided)
        continue
      }
      if (Number.isInteger(base)) results.push(base)
    }
  }

  // English cadence parsing (e.g., "every 6 hours", "once a day", "twice daily", "every 30 minutes", "hourly")
  if (/(?:check|scan|patrol|poll|refresh|fetch|cadence|interval|schedule|frequency|sync|watch|daily|hourly|weekly|every\s)/iu.test(text + ' ' + question)) {
    const enFactors = { min: 1, mins: 1, minute: 1, minutes: 1, hr: 60, hrs: 60, hour: 60, hours: 60, day: 1440, days: 1440, week: 10080, weeks: 10080 }
    for (const m of text.matchAll(/\bevery\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|half)\s+)?(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/giu)) {
      const qty = m[1] ? enAmount(m[1]) : 1
      const mins = qty * (enFactors[m[2].toLowerCase()] || 0)
      if (Number.isInteger(mins) && mins >= 1 && mins <= 10080) results.push(mins)
    }
    for (const m of text.matchAll(/\b(once|twice|\d+\s*times?)\s+(?:a|per|each)\s+(hour|day|week)\b/giu)) {
      const times = m[1].toLowerCase() === 'once' ? 1 : m[1].toLowerCase() === 'twice' ? 2 : Number(m[1].match(/\d+/)?.[0])
      const base = enFactors[m[2].toLowerCase()] || 0
      const mins = times > 0 ? base / times : 0
      if (Number.isInteger(mins) && mins >= 1 && mins <= 10080) results.push(mins)
    }
    if (!results.length) {
      if (/\bhourly\b/iu.test(text)) results.push(60)
      else if (/\btwice\s+daily\b/iu.test(text)) results.push(720)
      else if (/\bdaily\b/iu.test(text)) results.push(1440)
      else if (/\bweekly\b/iu.test(text)) results.push(10080)
    }
  }
  return results
}

function hourValue(period, value, fraction, minutes, inherited) {
  if (fraction && fraction !== '整' && fraction !== '0分' && fraction !== '00分') return undefined
  if (minutes && minutes !== '00') return undefined
  const n = amount(value)
  const dayPart = period || (!minutes && inherited)
  if (!dayPart && !minutes && n > 0 && n <= 12) return undefined
  if (dayPart && n <= 12) {
    if (dayPart === '中午' && n >= 11) return n
    if (['晚上', '深夜'].includes(dayPart) && n === 12) return 0
    if (['下午', '傍晚', '晚上', '深夜', '中午'].includes(dayPart)) return n <= 12 && n > 0 ? (n % 12) + 12 : undefined
    return n === 12 && dayPart === '凌晨' ? 0 : n
  }
  return n === 24 && minutes === '00' ? 0 : n
}

function parseEnHour(hStr, minStr, ampm) {
  if (minStr && minStr !== '00') return undefined
  const h = Number(hStr)
  if (!Number.isInteger(h)) return undefined
  if (ampm) {
    const p = ampm.toLowerCase()
    if (h < 1 || h > 12) return undefined
    if (p === 'am') return h === 12 ? 0 : h
    return h === 12 ? 12 : h + 12
  }
  if (!minStr && h > 0 && h <= 12) return undefined
  return h === 24 && minStr === '00' ? 0 : (h >= 0 && h < 24 ? h : undefined)
}

function windows(text, question) {
  const out = []
  if (/提醒|通知/u.test(text + question)) {
    const pattern = new RegExp(`${time}\\s*(?:至|到|[–—~-])\\s*${time}`, 'gu')
    for (const [, startPeriod, start, startFraction, startMinutes, endPeriod, end, endFraction, endMinutes] of text.matchAll(pattern)) {
      const from = hourValue(startPeriod, start, startFraction, startMinutes)
      const to = hourValue(endPeriod, end, endFraction, endMinutes, startPeriod)
      if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < 24 && to >= 0 && to < 24 && from !== to) {
        out.push([from, to])
      }
    }
  }
  if (/(?:notif|alert|remind|window|hours|quiet)/iu.test(text + ' ' + question)) {
    const enTime = '(\\d{1,2})(?::([0-5]\\d))?\\s*(am|pm)?'
    const enPat = new RegExp(`\\b${enTime}\\s*(?:to|until|-|–|—|~)\\s*${enTime}\\b`, 'giu')
    for (const [, sh, sm, sp, eh, em, ep] of text.matchAll(enPat)) {
      const from = parseEnHour(sh, sm, sp)
      const to = parseEnHour(eh, em, ep)
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
        out.push([from, to])
      }
    }
  }
  return out
}

export function normalizePreferenceIntake({ proposed, previous, text, question = '', locale = 'zh' }) {
  const isEn = locale === 'en'
  const input = text.normalize('NFKC')
  const pending = { ...previous }
  delete pending.kind
  const cadence = new Set(intervals(input, question))
  const ranges = new Set(windows(input, question).map(pair => pair.join(':')))
  const candidates = {
    notificationsEnabled: toggle(input, '(?:提醒|通知)', question, '(?:notifications?|alerts?|reminders?)'),
    allowReflections: toggle(input, '职业(?:观察|复盘|反思)', question, '(?:career\\s+)?(?:reflections?|observations?)'),
  }
  const asks = []
  if (Object.hasOwn(proposed, 'intervalMinutes')) {
    const value = proposed.intervalMinutes
    if (value !== pending.intervalMinutes && (cadence.size !== 1 || !cadence.has(value) || !Number.isInteger(value) || value < 1 || value > 10080)) {
      asks.push(isEn ? 'How often should patrol checks run? For example: "every 2 hours" or "once a day".' : '希望每隔多久检查一次？可以说「每两小时检查一次」。')
    } else pending.intervalMinutes = value
  }
  for (const [key, value] of Object.entries(candidates)) {
    if (!Object.hasOwn(proposed, key)) continue
    if (typeof proposed[key] === 'boolean' && (value === proposed[key] || pending[key] === proposed[key])) pending[key] = proposed[key]
    else asks.push(key === 'notificationsEnabled'
      ? (isEn ? 'Would you like personal alerts turned on or off?' : '个人提醒是开启，还是关闭？')
      : (isEn ? 'Would you like career observations turned on or off?' : '职业观察是开启，还是关闭？'))
  }
  if (Object.hasOwn(proposed, 'notificationHour') || Object.hasOwn(proposed, 'notificationEndHour')) {
    const { notificationHour, notificationEndHour } = proposed
    const key = `${notificationHour}:${notificationEndHour}`
    if (notificationHour !== pending.notificationHour || notificationEndHour !== pending.notificationEndHour) {
      if (Number.isInteger(notificationHour) && Number.isInteger(notificationEndHour) && ranges.size === 1 && ranges.has(key)) {
        Object.assign(pending, { notificationHour, notificationEndHour })
      } else asks.push(isEn ? 'Between which two hours would you like alerts? For example: "9am to 6pm" or "20:00 to 23:00".' : '希望每天在哪两个整点之间收到提醒？可以说「20:00 到 23:00」。')
    }
  }
  if (Object.hasOwn(proposed, 'timezone')) {
    const value = proposed.timezone
    const tokens = input.match(/[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+/gu) ?? []
    if (validTimezone(value) && (value === pending.timezone || (/(?:时区|time\s*zone)/iu.test(input + ' ' + question) && tokens.includes(value)))) pending.timezone = value
    else asks.push(isEn ? 'Which IANA time zone would you like to use (e.g., "America/Los_Angeles" or "Asia/Shanghai")?' : '要使用哪个时区？可以给出「Asia/Shanghai」这样的时区名称。')
  }
  const data = Object.fromEntries(fields.filter(key => Object.hasOwn(pending, key)).map(key => [key, pending[key]]))
  const missing = !Object.keys(data).length && (isEn ? 'Would you like to adjust patrol cadence, alerts, career observations, or time zone?' : '你想调整检查频率、个人提醒、职业观察，还是时区？')
  return { data, question: asks[0] || missing || '' }
}
