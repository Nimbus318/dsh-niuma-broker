import { detectTextLanguage } from './i18n/prompt.mjs'

const STRUCTURAL_LINE_RE = /^(?:#{1,6}\s|\s*(?:[-*_]\s*){3,}$|[|<>]|\[!|!\[|\x60{3,}|~{3,}|\uFEFF)/u
const BULLET_PREFIX_RE = /^([ \t]*(?:(?:[-*+]|[1-9]\d?[.)])[ \t]+|(?:[•·▪●○]|[1-9]\d?、)[ \t]*))(\S.*)$/u
const PROTECTED_CONTACT_RE = /(?:https?:\/\/|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|(?:^|[\s:：])\+?\d[\d\s().-]{6,}\d(?:$|\s))|^(?:邮件|邮箱|电话|地址|微信|LinkedIn|Email|Phone)\s*[:：]/iu

export const EXPLICIT_TRANSLATION_RE = /(?:翻译|译成|译为|转成(?:中文|英文|英语|日文|日语)|改为(?:中文|英文|英语)|改成(?:中文|英文|英语)|换成(?:中文|英文|英语)|(?:写|出|整理)一份?(?:中文|英文|英语)版|中译英|英译中|translate|translation|in\s+(?:chinese|english)|into\s+(?:chinese|english)|to\s+(?:chinese|english)|(?:chinese|english)\s+version)/iu

export function isExplicitTranslationRequest(text = '') {
  return EXPLICIT_TRANSLATION_RE.test(String(text || ''))
}

const HAN_CHAR_RE = /\p{Script=Han}/gu
const LATIN_WORD_RE = /[A-Za-z]{2,}/g

const ZH_DIGIT_MAP = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const ZH_UNIT_MULT = { 十: 10, 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000 }

const EN_ONES = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
})
const EN_TENS = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
})
const EN_SCALES = Object.freeze({
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
})
const EN_MULTIPLIER_WORDS = Object.freeze({
  twice: 2,
  double: 2,
  doubled: 2,
  triple: 3,
  tripled: 3,
  quadruple: 4,
  quadrupled: 4,
  tenfold: 10,
  hundredfold: 100,
})
const EN_EXPLICIT_UNITS = new Set([
  'percent', 'percentage', 'pct', 'times', 'x', 'fold',
  'ms', 'millisecond', 'milliseconds', 'sec', 'secs', 'second', 'seconds',
  'min', 'mins', 'minute', 'minutes', 'hr', 'hrs', 'hour', 'hours',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'kb', 'mb', 'gb', 'tb', 'dollar', 'dollars', 'usd',
])
const EN_QUANTIFIED_NOUNS = new Set([
  'engineer', 'engineers', 'developer', 'developers', 'programmer', 'programmers',
  'researcher', 'researchers', 'scientist', 'scientists', 'designer', 'designers',
  'person', 'people', 'member', 'members', 'employee', 'employees', 'staff',
  'report', 'reports', 'headcount', 'team', 'teams', 'squad', 'squads', 'org', 'organizations',
  'user', 'users', 'customer', 'customers', 'client', 'clients', 'subscriber', 'subscribers',
  'account', 'accounts', 'tenant', 'tenants', 'merchant', 'merchants',
  'node', 'nodes', 'server', 'servers', 'cluster', 'clusters', 'gpu', 'gpus', 'host', 'hosts',
  'machine', 'machines', 'instance', 'instances', 'container', 'containers', 'pod', 'pods',
  'service', 'services', 'microservice', 'microservices', 'pipeline', 'pipelines',
  'project', 'projects', 'system', 'systems', 'product', 'products', 'region', 'regions',
  'country', 'countries', 'market', 'markets', 'request', 'requests', 'query', 'queries',
  'transaction', 'transactions', 'job', 'jobs', 'task', 'tasks', 'workload', 'workloads',
  'error', 'errors', 'bug', 'bugs', 'incident', 'incidents', 'outage', 'outages', 'downtime',
])

const METRIC_DOMAIN_RULES = Object.freeze([
  ['cost_money', /\b(?:costs?|spend(?:ing)?|budgets?|expenses?|bills?|billing|opex|capex|pricing|price|savings?|revenue|arr|gmv|profit|margin|roi|usd|dollars?|euros?|pounds?)\b|[$¥€£]|(?:成本|费用|预算|开支|支出|账单|节省费用|营收|收入|利润|销售额|流水|客单价)/iu],
  ['error_reliability', /\b(?:errors?|failures?|faults?|defects?|bugs?|crashes?|outages?|incidents?|alerts?|timeouts?|retr(?:y|ies)|drops?|rollbacks?|availability|uptime|downtime|slas?|slos?|reliability|stability|mttr|mtbf|recovery|dispatch\s+errors?)\b|(?:错误|故障|报错|失败|异常|缺陷|事故|宕机|超时|重试|可用性|稳定性|恢复)/iu],
  ['latency_speed', /\b(?:latenc(?:y|ies)|delays?|lag|(?:response|load|execution|build|startup|boot|wait|handoff|cycle|processing|render|query|training|inference)\s+times?|runtimes?|cold\s+starts?|durations?|turnaround|p50|p90|p95|p99|ttft|tpot|speed|faster|slower|time)\b|(?:时延|延迟|耗时|用时|工时|时间|速度|提速|周期)/iu],
  ['throughput_scale', /\b(?:throughput|qps|rps|tps|bandwidth|capacit(?:y|ies)|concurrenc(?:y|ies)|traffic|requests?|queries|transactions?|messages?|events?|records?|tokens?|workloads?|pipelines?|deployments?|releases?|rps)\b|(?:吞吐|并发|流量|请求量|查询量|处理量|产能|规模)/iu],
  ['utilization_efficiency', /\b(?:cpu|gpus?|memory|ram|disk|storage|footprint|utilization|efficienc(?:y|ies)|mfu|power|energy|waste|overhead|toil|manual\s+(?:effort|work|hours))\b|(?:内存|显存|存储|磁盘|利用率|占用|功耗|效率|人效)/iu],
  ['headcount_org', /\b(?:engineers?|developers?|programmers?|researchers?|scientists?|designers?|members?|people|staff|employees?|reports?|headcount|teams?|squads?|orgs?|organizations?|departments?)\b|(?:工程师|研发|成员|团队|下属|人数|部门|组织)|(?:\d|[一二两三四五六七八九十百千万])\s*人(?!工|效|力|口|群|次)/iu],
  ['users_customers', /\b(?:users?|customers?|clients?|subscribers?|accounts?|tenants?|merchants?|dau|mau|wau|conversion|retention|churn|ctr|cvr|engagement|clicks?)\b|(?:用户|客户|买家|商家|会员|租户|日活|月活|留存|转化|点击率)/iu],
  ['accuracy_quality', /\b(?:accurac(?:y|ies)|precision|recall|f1|auc|ndcg|bleu|perplexity|pass\s+rates?|success\s+rates?|hit\s+rates?|cache\s+hits?|coverage|quality)\b|(?:准确率|精确率|召回率|命中率|覆盖率|通过率|成功率|质量)/iu],
])

function parseZhSimpleNumber(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s === '千') return 1000
  if (s === '万') return 10_000
  let total = 0
  let section = 0
  let cur = 0
  let seen = false
  for (const ch of s) {
    if (Object.hasOwn(ZH_DIGIT_MAP, ch)) {
      cur = ZH_DIGIT_MAP[ch]
      seen = true
    } else if (Object.hasOwn(ZH_UNIT_MULT, ch)) {
      seen = true
      const unit = ZH_UNIT_MULT[ch]
      if (unit >= 10_000) {
        section = (section + cur || 1) * unit
        total += section
        section = 0
        cur = 0
      } else {
        section += (cur || 1) * unit
        cur = 0
      }
    } else {
      return null
    }
  }
  if (!seen) return null
  return total + section + cur
}

function unitMultiplier(unitRaw) {
  const u = String(unitRaw || '').trim().toLowerCase()
  if (!u) return { kind: 'plain', factor: 1 }
  if (u === '%' || u === '％' || u === 'percent' || u === 'percentage' || u === 'pct') return { kind: 'pct', factor: 1 }
  if (u === 'k' || u === '千') return { kind: 'count', factor: 1_000 }
  if (u === 'w' || u === '万') return { kind: 'count', factor: 10_000 }
  if (u === 'm' || u === 'million' || u === '百万') return { kind: 'count', factor: 1_000_000 }
  if (u === 'b' || u === 'billion' || u === '十亿') return { kind: 'count', factor: 1_000_000_000 }
  if (u === '亿') return { kind: 'count', factor: 100_000_000 }
  if (u === 'ms' || u === 'millisecond' || u === 'milliseconds' || u === '毫秒') return { kind: 'time_s', factor: 0.001 }
  if (u === 's' || u === 'sec' || u === 'secs' || u === 'second' || u === 'seconds' || u === '秒') return { kind: 'time_s', factor: 1 }
  if (u === 'min' || u === 'mins' || u === 'minute' || u === 'minutes' || u === '分' || u === '分钟') return { kind: 'time_s', factor: 60 }
  if (u === 'h' || u === 'hr' || u === 'hrs' || u === 'hour' || u === 'hours' || u === '小时') return { kind: 'time_s', factor: 3600 }
  if (u === 'kb') return { kind: 'bytes', factor: 1024 }
  if (u === 'mb') return { kind: 'bytes', factor: 1024 * 1024 }
  if (u === 'gb') return { kind: 'bytes', factor: 1024 * 1024 * 1024 }
  if (u === 'tb') return { kind: 'bytes', factor: 1024 * 1024 * 1024 * 1024 }
  if (u === 'x' || u === 'times' || u === 'fold' || u === '倍') return { kind: 'mult', factor: 1 }
  return { kind: 'plain', factor: 1 }
}

function clauseWindowAround(text, startIdx, endIdx) {
  const s = String(text || '')
  const leftBound = Math.max(0, startIdx - 96)
  const rightBound = Math.min(s.length, endIdx + 64)
  let left = s.slice(leftBound, startIdx)
  let right = s.slice(endIdx, rightBound)

  // Clip at nearest strong clause boundary so sibling clauses don't cross-contaminate metric subjects.
  const leftBreakRe = /(?:[;；—–]|\b(?:while|whereas|and|but|plus)\b|[，,]\s*(?:并|同时|以及|且|将|把|使|让|leading|while|with)|(?:并|同时|以及))/giu
  let lastLeftBreak = -1
  for (const m of left.matchAll(leftBreakRe)) {
    lastLeftBreak = (m.index ?? 0) + m[0].length
  }
  if (lastLeftBreak >= 0) left = left.slice(lastLeftBreak)

  const rightBreakRe = /(?:[;；—–]|\b(?:while|whereas|and|but)\b|[，,]\s*(?:并|同时|以及|且|while|and)|(?:并|同时|以及))/iu
  const rightBreak = rightBreakRe.exec(right)
  if (rightBreak) right = right.slice(0, rightBreak.index)

  return `${left}${s.slice(startIdx, endIdx)}${right}`.trim()
}

export function extractMetricDomains(snippet) {
  const clean = String(snippet || '')
  const domains = new Set()
  for (const [domain, re] of METRIC_DOMAIN_RULES) {
    if (re.test(clean)) domains.add(domain)
  }
  return domains
}

function isEnNumberToken(word) {
  return Object.hasOwn(EN_ONES, word) || Object.hasOwn(EN_TENS, word) || Object.hasOwn(EN_SCALES, word)
}

function parseEnNumberTokens(words) {
  let total = 0
  let current = 0
  let sawNumber = false
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (w === 'and') { i += 1; continue }
    if (w === 'point') {
      i += 1
      let frac = ''
      while (i < words.length && Object.hasOwn(EN_ONES, words[i]) && EN_ONES[words[i]] < 10) {
        frac += String(EN_ONES[words[i]])
        i += 1
      }
      if (frac) {
        const base = total + current
        return Number(`${base}.${frac}`)
      }
      break
    }
    if (Object.hasOwn(EN_ONES, w)) {
      current += EN_ONES[w]
      sawNumber = true
    } else if (Object.hasOwn(EN_TENS, w)) {
      current += EN_TENS[w]
      sawNumber = true
    } else if (w === 'hundred') {
      current = (current || 1) * 100
      sawNumber = true
    } else if (Object.hasOwn(EN_SCALES, w)) {
      const scale = EN_SCALES[w]
      total += (current || 1) * scale
      current = 0
      sawNumber = true
    } else {
      break
    }
    i += 1
  }
  return sawNumber ? total + current : null
}

function extractEnglishWordNumbers(clean) {
  const results = []
  const tokenRe = /[A-Za-z]+/g
  const tokens = []
  for (const m of clean.matchAll(tokenRe)) {
    tokens.push({ word: m[0].toLowerCase(), raw: m[0], index: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    // Standalone multiplier words ("twice", "doubled", "tripled", "tenfold", etc.)
    if (Object.hasOwn(EN_MULTIPLIER_WORDS, tok.word)) {
      const val = EN_MULTIPLIER_WORDS[tok.word]
      results.push({
        raw: tok.raw,
        numVal: val,
        kind: 'mult',
        canonical: val,
        normalizedDigits: String(val),
        index: tok.index,
        endIndex: tok.end,
      })
      i += 1
      continue
    }

    if (!isEnNumberToken(tok.word)) {
      i += 1
      continue
    }

    // Collect contiguous sequence of English number words (allowing spaces/hyphens, "and", "point <digits>")
    let j = i
    const numWords = []
    let lastNumTokenIdx = i
    while (j < tokens.length) {
      const prevEnd = j > i ? tokens[j - 1].end : tok.index
      const gap = j > i ? clean.slice(prevEnd, tokens[j].index) : ''
      if (j > i && !/^[\s-]+$/.test(gap)) break
      const w = tokens[j].word
      if (isEnNumberToken(w)) {
        numWords.push(w)
        lastNumTokenIdx = j
        j += 1
        continue
      }
      if (w === 'and' && j + 1 < tokens.length && isEnNumberToken(tokens[j + 1].word)) {
        const nextGap = clean.slice(tokens[j].end, tokens[j + 1].index)
        if (/^[\s-]+$/.test(nextGap)) {
          numWords.push(w)
          j += 1
          continue
        }
      }
      if (w === 'point' && j + 1 < tokens.length && Object.hasOwn(EN_ONES, tokens[j + 1].word) && EN_ONES[tokens[j + 1].word] < 10) {
        const nextGap = clean.slice(tokens[j].end, tokens[j + 1].index)
        if (/^[\s-]+$/.test(nextGap)) {
          numWords.push(w)
          j += 1
          continue
        }
      }
      break
    }

    const parsedVal = parseEnNumberTokens(numWords)
    const nextIdx = lastNumTokenIdx + 1
    let trailingUnit = ''
    let trailingNoun = ''
    let endIdx = tokens[lastNumTokenIdx].end
    if (nextIdx < tokens.length) {
      const nextGap = clean.slice(endIdx, tokens[nextIdx].index)
      const nextWord = tokens[nextIdx].word
      if (/^[\s-]+$/.test(nextGap)) {
        if (EN_EXPLICIT_UNITS.has(nextWord)) {
          trailingUnit = nextWord
          endIdx = tokens[nextIdx].end
        } else if (EN_QUANTIFIED_NOUNS.has(nextWord)) {
          trailingNoun = nextWord
          endIdx = tokens[nextIdx].end
        }
      }
    }

    // Decide whether this written-out number is an actual metric/scale claim (avoid false positives like "one of the", "a single", "zero-in").
    const meaningfulWordCount = numWords.filter(w => w !== 'and' && w !== 'point').length
    const isBenignOne = parsedVal === 1 && meaningfulWordCount === 1 && !trailingUnit
    const isBenignZero = parsedVal === 0 && meaningfulWordCount === 1 && !trailingUnit && !trailingNoun
    const hasMetricSignal = Boolean(trailingUnit || trailingNoun || meaningfulWordCount >= 2 || (parsedVal !== null && parsedVal >= 10))

    if (parsedVal !== null && !isBenignOne && !isBenignZero && hasMetricSignal) {
      const { kind, factor } = unitMultiplier(trailingUnit)
      const canonical = Math.round(parsedVal * factor * 1_000_000) / 1_000_000
      results.push({
        raw: clean.slice(tok.index, endIdx).trim(),
        numVal: parsedVal,
        kind,
        canonical,
        normalizedDigits: String(parsedVal),
        index: tok.index,
        endIndex: endIdx,
      })
      i = trailingUnit || trailingNoun ? nextIdx + 1 : lastNumTokenIdx + 1
    } else {
      i = lastNumTokenIdx + 1
    }
  }
  return results
}

/**
 * Extracts normalized numeric & metric tokens (including Arabic numerals, Chinese written numbers,
 * and written-out English numbers) along with their local semantic metric domains.
 * Supports equivalent legal representations (e.g. `1,000` <-> `1k`, `2500ms` <-> `2.5s`, `45%` <-> `forty-five percent`).
 */
export function extractNumericClaims(text) {
  const clean = String(text || '')
  const claims = []

  // 1. Arabic numerals with optional commas, decimals, and trailing unit
  const numRe = /(?<![A-Za-z0-9_])(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|％|percent\b|percentage\b|pct\b|ms\b|milliseconds?\b|secs?\b|seconds?\b|mins?\b|minutes?\b|hrs?\b|hours?\b|tb\b|gb\b|mb\b|kb\b|million\b|billion\b|times\b|[kKwWmMbBsShHxX]\b|毫秒|分钟|小时|百万|十亿|千|万|亿|秒|分|倍)?/gu
  for (const match of clean.matchAll(numRe)) {
    const rawNum = match[1]
    const rawUnit = match[2] || ''
    // Ignore version-like identifiers embedded inside tech tokens like P99, H800, HTTP2, Python3, S3, K8s
    const startIdx = match.index ?? 0
    const prevChar = startIdx > 0 ? clean[startIdx - 1] : ''
    if (/[A-Za-z]/.test(prevChar)) continue
    const numVal = Number(rawNum.replace(/,/g, ''))
    if (!Number.isFinite(numVal)) continue
    const { kind, factor } = unitMultiplier(rawUnit)
    const canonical = Math.round(numVal * factor * 1_000_000) / 1_000_000
    const endIdx = startIdx + match[0].length
    claims.push({
      raw: match[0].trim(),
      numVal,
      kind,
      canonical,
      normalizedDigits: rawNum.replace(/,/g, ''),
      index: startIdx,
      endIndex: endIdx,
      domains: extractMetricDomains(clauseWindowAround(clean, startIdx, endIdx)),
    })
  }

  // 2. Chinese written percentages ("百分之七十三") and multiplier/scale phrases ("千卡", "万级", "三倍", "五十人")
  const zhPctRe = /百分之([一二两三四五六七八九十百点零〇]+)/gu
  for (const match of clean.matchAll(zhPctRe)) {
    const parsed = parseZhSimpleNumber(match[1])
    if (parsed !== null) {
      const startIdx = match.index ?? 0
      const endIdx = startIdx + match[0].length
      claims.push({
        raw: match[0],
        numVal: parsed,
        kind: 'pct',
        canonical: parsed,
        normalizedDigits: String(parsed),
        index: startIdx,
        endIndex: endIdx,
        domains: extractMetricDomains(clauseWindowAround(clean, startIdx, endIdx)),
      })
    }
  }
  const zhScaleRe = /([一二两三四五六七八九十百千万亿]+)\s*(倍|人|名|个|家|台|卡|次|年|月|天|小时|分钟|秒|万|千|亿|级)/gu
  for (const match of clean.matchAll(zhScaleRe)) {
    const rawZh = match[1]
    const unit = match[2]
    if ((rawZh === '一' || rawZh === '两') && (unit === '个' || unit === '次' || unit === '家' || unit === '种')) continue
    const parsed = parseZhSimpleNumber(rawZh)
    if (parsed !== null && parsed > 0) {
      const { kind, factor } = unitMultiplier(unit)
      const canonical = Math.round(parsed * factor * 1_000_000) / 1_000_000
      const startIdx = match.index ?? 0
      const endIdx = startIdx + match[0].length
      claims.push({
        raw: match[0],
        numVal: parsed,
        kind,
        canonical,
        normalizedDigits: String(parsed),
        index: startIdx,
        endIndex: endIdx,
        domains: extractMetricDomains(clauseWindowAround(clean, startIdx, endIdx)),
      })
    }
  }

  // 3. Written-out English numbers ("forty-five percent", "two hundred fifty engineers", "three times", "ninety-nine point nine percent")
  for (const enClaim of extractEnglishWordNumbers(clean)) {
    claims.push({
      ...enClaim,
      domains: extractMetricDomains(clauseWindowAround(clean, enClaim.index, enClaim.endIndex)),
    })
  }

  // 4. Tech identifier tokens with numbers (e.g. P99, H800, H100, A100, L40, K8s)
  const techIdRe = /\b([A-Za-z]{1,8}\d+(?:\.\d+)?)\b/g
  const techIds = new Set()
  for (const m of clean.matchAll(techIdRe)) {
    techIds.add(m[1].toLowerCase())
  }

  return { claims, techIds, lineDomains: extractMetricDomains(clean) }
}

function claimMatchesNumeric(claim, src) {
  if (src.normalizedDigits === claim.normalizedDigits && (src.kind === claim.kind || src.kind === 'plain' || claim.kind === 'plain')) {
    return true
  }
  if (src.kind === claim.kind && Math.abs(src.canonical - claim.canonical) <= Math.max(1e-6, Math.abs(src.canonical) * 1e-4)) {
    return true
  }
  // Plain number <-> scaled count equivalence (e.g. "10,000" <-> "10k" <-> "1万")
  if ((src.kind === 'plain' || src.kind === 'count') && (claim.kind === 'plain' || claim.kind === 'count')) {
    if (Math.abs(src.canonical - claim.canonical) <= Math.max(1e-6, Math.abs(src.canonical) * 1e-4)) {
      return true
    }
  }
  return false
}

function setsIntersect(a, b) {
  for (const item of a) {
    if (b.has(item)) return true
  }
  return false
}

function claimSemanticCompatible(claim, src, origLineDomains) {
  const srcDomains = src.domains instanceof Set ? src.domains : new Set()
  const nextDomains = claim.domains instanceof Set ? claim.domains : new Set()
  if (nextDomains.size === 0) return true
  if (srcDomains.size > 0) {
    return setsIntersect(srcDomains, nextDomains)
  }
  // Original numeric clause had no explicit domain keyword; only allow rewritten domains already present in original line.
  return [...nextDomains].every(d => origLineDomains.has(d))
}

/**
 * Validates a single rewritten resume bullet/line against its original source line.
 * Enforces:
 * 1. Single-line non-structural text (no injected headings/fences/bullets).
 * 2. Zero newly fabricated contact info / URLs.
 * 3. Zero newly fabricated numbers, written-out English/Chinese numbers, percentages, headcounts, or scales
 *    (while allowing equivalent legal unit rewrites).
 * 4. Semantic metric subject anchoring (blocks relabeling e.g. "dispatch errors by 45%" -> "infrastructure cost by 45%").
 * 5. Language preservation unless explicit translation was requested.
 */
export function validateResumeEditLine({
  original,
  rewritten,
  resumeLang = '',
  allowTranslation = false,
  locale = 'zh',
} = {}) {
  const isEn = String(locale || '').toLowerCase().startsWith('en')
  const origRaw = String(original || '').replace(BULLET_PREFIX_RE, '$2').trim()
  if (typeof rewritten !== 'string' || rewritten.length > 6000 || /[\r\n\u0000]/u.test(rewritten)) {
    return {
      ok: false,
      code: 'structure',
      reason: isEn ? 'Each resume edit must be a single line of plain text.' : '每项简历改动应是一行纯文本。',
    }
  }
  const text = rewritten.trim()
  if (!text || STRUCTURAL_LINE_RE.test(text) || BULLET_PREFIX_RE.test(text)) {
    return {
      ok: false,
      code: 'structure',
      reason: isEn
        ? 'Resume edits must contain body wording only and preserve existing heading/bullet structure.'
        : '简历改动应为正文内容，不能破坏现有标题或项目符号结构。',
    }
  }

  // Protected contact / URL check (block newly injected emails, phones, URLs)
  if (PROTECTED_CONTACT_RE.test(text) && !PROTECTED_CONTACT_RE.test(origRaw)) {
    return {
      ok: false,
      code: 'protected',
      reason: isEn
        ? 'Blocked newly added contact details or links not present in the original line.'
        : '模型建议包含原句之外的联系方式或链接，已拦截。',
    }
  }

  // Fact, numeric & semantic metric subject verification (allowing mathematically equivalent unit conversions)
  const origMetrics = extractNumericClaims(origRaw)
  const nextMetrics = extractNumericClaims(text)
  const unverified = []
  const relabeled = []
  for (const claim of nextMetrics.claims) {
    const numericMatches = origMetrics.claims.filter(src => claimMatchesNumeric(claim, src))
    if (!numericMatches.length) {
      unverified.push(claim.raw)
      continue
    }
    const semanticOk = numericMatches.some(src => claimSemanticCompatible(claim, src, origMetrics.lineDomains))
    if (!semanticOk) {
      relabeled.push(claim.raw)
    }
  }
  if (unverified.length > 0) {
    const sample = [...new Set(unverified)].slice(0, 5).join(', ')
    return {
      ok: false,
      code: 'metric',
      details: [...new Set(unverified)],
      reason: isEn
        ? `Rejected unverified numbers or metrics (${sample}) not present in the original bullet.`
        : `模型建议包含原句之外的新增数字或指标（${sample}），请先核实后再修改。`,
    }
  }
  if (relabeled.length > 0) {
    const sample = [...new Set(relabeled)].slice(0, 5).join(', ')
    return {
      ok: false,
      code: 'metric_semantic',
      details: [...new Set(relabeled)],
      reason: isEn
        ? `Rejected relabeled metric claim (${sample}): the modified metric subject does not match the original bullet.`
        : `模型建议将原句指标（${sample}）偷换到了原句之外的不同对象上，已拦截。`,
    }
  }

  // Language preservation check
  if (!allowTranslation) {
    const origHan = (origRaw.match(HAN_CHAR_RE) || []).length
    const origLatin = (origRaw.match(LATIN_WORD_RE) || []).length
    const nextHan = (text.match(HAN_CHAR_RE) || []).length
    const nextLatin = (text.match(LATIN_WORD_RE) || []).length
    const effectiveOrigLang = origHan >= 4
      ? 'zh'
      : (origLatin >= 3 && origHan === 0 ? 'en' : (resumeLang || detectTextLanguage(origRaw)))

    if (effectiveOrigLang === 'en' && origHan < 2 && (nextHan >= 3 || detectTextLanguage(text) === 'zh')) {
      return {
        ok: false,
        code: 'language',
        reason: isEn
          ? 'Blocked unsolicited translation to Chinese — resume language must remain English unless translation is explicitly requested.'
          : '已拦截未经要求的中文翻译——未明确要求翻译时，英文简历正文必须保持英文。',
      }
    }
    if (effectiveOrigLang === 'zh' && origHan >= 4 && nextHan === 0 && nextLatin >= 3) {
      return {
        ok: false,
        code: 'language',
        reason: isEn
          ? 'Blocked unsolicited translation to English — resume language must remain Chinese unless translation is explicitly requested.'
          : '已拦截未经要求的英文翻译——未明确要求翻译时，中文简历正文必须保持中文。',
      }
    }
  }

  return { ok: true, text }
}
