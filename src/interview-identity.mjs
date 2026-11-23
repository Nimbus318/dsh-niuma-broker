const ROUND_ORDINAL_ZH = new Map([['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['初', 1], ['复', 2]])
const ROUND_ORDINAL_EN = new Map([
  ['first', 1], ['1st', 1], ['one', 1],
  ['second', 2], ['2nd', 2], ['two', 2],
  ['third', 3], ['3rd', 3], ['three', 3],
  ['fourth', 4], ['4th', 4], ['four', 4],
  ['fifth', 5], ['5th', 5], ['five', 5],
  ['sixth', 6], ['6th', 6], ['six', 6],
])

const TRACK_QUALIFIERS = [
  ['tech', /^(?:技术|tech(?:nical)?)$/iu],
  ['business', /^(?:业务|产品|business|product)$/iu],
  ['hm', /^(?:主管|经理|hiring\s*manager|hm|manager)$/iu],
  ['cross', /^(?:交叉|跨团队|cross[- ]?team|cross)$/iu],
  ['sysdesign', /^(?:系统设计|架构|system\s*design|architecture)$/iu],
  ['coding', /^(?:算法|编码|代码|coding|algorithm)$/iu],
  ['behavioral', /^(?:行为|文化|behavioral|culture)$/iu],
  ['domain', /^(?:专业|domain)$/iu],
]

function normalizeTrackQualifier(raw) {
  const clean = String(raw || '').trim()
  if (!clean) return ''
  // Ignore pure medium descriptors (phone/video/online/onsite) when no distinct track is named
  if (/^(?:电话|视频|线上|现场|phone|video|panel|online)$/iu.test(clean)) return ''
  for (const [key, re] of TRACK_QUALIFIERS) {
    if (re.test(clean)) return key
  }
  return clean.toLowerCase().replace(/\s+/gu, '-')
}

/**
 * Produces a language-independent canonical key for an interview round label:
 * - Generic bilingual equivalents merge: "一面" / "Round 1" / "1st Round" -> "round:1".
 * - Distinct qualified tracks stay SEPARATE while unifying bilingual equivalents:
 *   "技术一面" / "Technical Round 1" -> "round:1:tech"
 *   "业务一面" / "Business Round 1" -> "round:1:business"
 */
export function canonicalInterviewRoundKey(rawRound) {
  const clean = String(rawRound || '').trim().replace(/\s+/gu, ' ')
  if (!clean) return 'round:default'
  const lower = clean.toLowerCase()
  if (/^(?:hr\s*(?:面|面试|初筛|沟通|round|screen|call|chat|interview)?|recruiter\s*(?:screen|call|chat|round)|初筛|电话初筛|phone\s*screen)$/iu.test(lower)) {
    return 'round:hr'
  }
  if (/^(?:终面|最终面|终审|总监终面|boss\s*面|final(?:\s*(?:round|interview|loop))?|onsite(?:\s*(?:loop|interview))?|virtual\s*onsite|loop)$/iu.test(lower)) {
    return 'round:final'
  }
  if (/^(?:加面|补充面|bonus\s*round|extra\s*round|follow[- ]?up\s*(?:round|interview))$/iu.test(lower)) {
    return 'round:extra'
  }
  const zhMatch = clean.match(/^(?:(技术|专业|业务|产品|主管|经理|交叉|跨团队|系统设计|架构|算法|编码|代码|行为|文化|电话|视频|线上|现场)\s*)?(?:第\s*)?([一二三四五六初复1-6])\s*(?:面|轮)(?:试)?$/u)
  if (zhMatch) {
    const num = ROUND_ORDINAL_ZH.get(zhMatch[2]) ?? Number(zhMatch[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifier(zhMatch[1])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  const enMatch1 = lower.match(/^(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain|phone|video|panel)\s+)?(?:round|interview|stage)\s*#?\s*([1-6]|first|second|third|fourth|fifth|sixth|one|two|three|four|five|six)$/iu)
  if (enMatch1) {
    const num = ROUND_ORDINAL_EN.get(enMatch1[2]) ?? Number(enMatch1[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifier(enMatch1[1])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  const enMatch2 = lower.match(/^(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain|phone|video|panel)\s+)?(1st|2nd|3rd|4th|5th|6th|first|second|third|fourth|fifth|sixth)\s+(?:(tech(?:nical)?|business|product|coding|algorithm|system\s*design|architecture|behavioral|culture|hiring\s*manager|hm|manager|cross[- ]?team|cross|domain)\s+)?(?:round|interview|stage)$/iu)
  if (enMatch2) {
    const num = ROUND_ORDINAL_EN.get(enMatch2[2])
    if (Number.isInteger(num) && num >= 1 && num <= 6) {
      const qual = normalizeTrackQualifier(enMatch2[1] || enMatch2[3])
      return qual ? `round:${num}:${qual}` : `round:${num}`
    }
  }
  return `round:custom:${lower}`
}

/**
 * Unified interview identity key shared across receipts, FollowUps, ICS, and native Calendar sync.
 * Explicit `interviewId` takes precedence so distinct sessions (even with identical round names)
 * never collide and reschedules always preserve the same event identity.
 */
export function interviewGroupKey(receiptOrRound) {
  if (receiptOrRound && typeof receiptOrRound === 'object') {
    const explicitId = typeof receiptOrRound.interviewId === 'string' ? receiptOrRound.interviewId.trim() : ''
    if (explicitId) return `id:${explicitId}`
    return canonicalInterviewRoundKey(receiptOrRound.round)
  }
  return canonicalInterviewRoundKey(receiptOrRound)
}
