import { detectAbsorbedEvidenceIds } from './career.mjs'
import { normalizeLocale } from './i18n/index.mjs'
import { computeReviewableLineChanges } from './resume-diff.mjs'

export const CN_PROVIDERS = new Set([
  'feishu', 'moka', 'tencent', 'meituan', 'jd', 'netease',
  'alibaba', 'baidu', 'xiaohongshu', 'bilibili', 'trip', 'mihoyo',
])

const CN_CITY_LIST = ['上海', '北京', '深圳', '杭州', '广州', '成都', '南京', '苏州', '武汉', '西安', '厦门', '重庆', '珠海', '中国', '国内']
const GLOBAL_PREF_RE = /(海外|国外|北美|美国|硅谷|欧洲|英国|新加坡|日本|澳洲|overseas|abroad|united states|\busa\b|\beurope\b|singapore|global remote)/iu

export function isShareableEvidence(item) {
  return Boolean(item && item.status === 'approved' && item.shareable === true)
}

export function isShareableReflection(item, shareableEvidenceIds) {
  if (!item || item.status !== 'approved') return false
  if (Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0 && shareableEvidenceIds) {
    return item.evidenceIds.every(eid => shareableEvidenceIds.has(eid))
  }
  return true
}

export function inferMarketProfile({ resumeText = '', goal = '', searchTerms = [], evidence = [], timezone = '', locale = 'zh' }) {
  const isEn = normalizeLocale(locale, 'zh') === 'en'
  const goalAndTerms = `${goal} ${(searchTerms || []).join(' ')}`.trim()
  const evidenceText = (evidence || []).filter(isShareableEvidence).slice(-8).map(e => `${e.title || ''} ${e.summary || ''}`).join(' ')
  const combined = `${resumeText.slice(0, 3000)} ${evidenceText}`
  const cjkCount = (combined.match(/[\u4e00-\u9fff]/gu) || []).length
  const latinWords = (combined.match(/[A-Za-z]{2,}/gu) || []).length

  const cnCities = CN_CITY_LIST.filter(city => goalAndTerms.includes(city) || resumeText.slice(0, 1200).includes(city))
  const explicitCn = cnCities.length > 0 || /[\u4e00-\u9fff]/u.test(goal)
  const explicitGlobal = GLOBAL_PREF_RE.test(goalAndTerms)

  let region = 'balanced'
  let reason = ''
  if (explicitGlobal && !explicitCn && cjkCount < 30) {
    region = 'global'
    reason = isEn ? 'Prioritized for global roles' : '按海外方向优先'
  } else if (cjkCount >= 24 && (cjkCount * 3 >= latinWords || explicitCn) && !(explicitGlobal && !explicitCn)) {
    region = 'cn'
    reason = resumeText
      ? (isEn ? 'Prioritized by Chinese resume' : '按中文简历优先')
      : (isEn ? 'Prioritized by Chinese goal' : '按中文目标优先')
  } else if (latinWords >= 70 && cjkCount < 15) {
    region = 'global'
    reason = isEn ? 'Prioritized by English resume' : '按英文简历优先'
  } else if (explicitCn && !explicitGlobal) {
    region = 'cn'
    reason = isEn ? 'Prioritized for CN market' : '按国内方向优先'
  } else if (explicitGlobal && !explicitCn) {
    region = 'global'
    reason = isEn ? 'Prioritized for global roles' : '按海外方向优先'
  } else if (String(timezone || '').startsWith('Asia/Shanghai') || String(timezone || '').startsWith('Asia/Chongqing')) {
    region = 'cn'
    reason = isEn ? 'Prioritized by local timezone' : '按本地时区优先'
  }
  return {
    region,
    reason,
    cnCities: cnCities.slice(0, 6),
    resumeLanguage: cjkCount >= 24 ? 'zh' : (latinWords >= 70 ? 'en' : 'unknown'),
  }
}

const PROVENANCE_STOPWORDS_EN = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'under', 'through',
  'across', 'using', 'their', 'your', 'about', 'while', 'where', 'when', 'which', 'such',
  'also', 'more', 'most', 'some', 'very', 'just', 'only', 'both', 'each', 'every', 'other',
  'being', 'have', 'has', 'had', 'were', 'been', 'will', 'would', 'could', 'should', 'than',
  'then', 'them', 'they', 'what', 'does', 'done', 'well', 'still', 'after', 'before',
  'between', 'during', 'without', 'within', 'since', 'until', 'upon', 'onto', 'towards',
  'toward', 'against', 'among', 'around', 'below', 'above', 'along', 'behind', 'beyond',
  'near', 'plus', 'per', 'via', 'are', 'was', 'not', 'but', 'all', 'can', 'our', 'out',
  'its', 'who', 'how', 'any', 'few', 'may', 'own', 'now', 'way', 'new', 'use', 'used',
])
const PROVENANCE_CJK_FUNC = new Set([...'的了和与及在对为等并中以将把向由从到可使被更也又都而所着过地得'])

function stemEnToken(word) {
  let w = word
  if (w.length > 7 && /(?:ational|itional|ization|isation)$/u.test(w)) {
    w = w.replace(/(?:ational|itional|ization|isation)$/u, '')
  } else if (w.length > 6 && /(?:ation|ition|ement|ment|ance|ence|ness|able|ible)$/u.test(w)) {
    w = w.replace(/(?:ation|ition|ement|ment|ance|ence|ness|able|ible)$/u, '')
  } else if (w.length > 5 && /(?:izing|ising|ating|ingly|edly|ities|ical|ally|ions|ing|ied|ies|ity|ive|ous|ful|ist|ism|ize|ise)$/u.test(w)) {
    w = w.replace(/(?:izing|ising|ating|ingly|edly|ities|ical|ally|ions|ing|ied|ies|ity|ive|ous|ful|ist|ism|ize|ise)$/u, '')
  } else if (w.length > 4 && /(?:ed|er|or|al|ly|es)$/u.test(w)) {
    w = w.replace(/(?:ed|er|or|al|ly|es)$/u, '')
  } else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) {
    w = w.slice(0, -1)
  }
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

function buildProvenanceLexicon(text) {
  const low = String(text || '').toLowerCase()
  const words = new Set()
  const stems = new Set()
  const prefixes5 = new Set()
  for (const m of low.matchAll(/[a-z][a-z0-9]{2,}|\d+(?:[.,]\d+)?%?/gu)) {
    const tok = m[0]
    if (PROVENANCE_STOPWORDS_EN.has(tok)) continue
    words.add(tok)
    if (/^[a-z]/u.test(tok)) {
      const stem = stemEnToken(tok)
      if (stem.length >= 4) stems.add(stem)
      if (tok.length >= 7) prefixes5.add(tok.slice(0, 5))
    }
  }
  const cjkBigrams = new Set()
  for (const m of low.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const run = m[0]
    for (let i = 0; i < run.length - 1; i += 1) {
      cjkBigrams.add(run.slice(i, i + 2))
    }
  }
  return { words, stems, prefixes5, cjkBigrams }
}

function tokenInLexicon(tok, lex) {
  if (lex.words.has(tok)) return true
  if (/^[a-z]/u.test(tok)) {
    const stem = stemEnToken(tok)
    if (stem.length >= 4 && lex.stems.has(stem)) return true
    if (tok.length >= 7 && lex.prefixes5.has(tok.slice(0, 5))) return true
  }
  return false
}

function extractNovelProvenanceContent(candidateText, knownLex) {
  const low = String(candidateText || '').toLowerCase()
  const novelLatin = new Set()
  for (const m of low.matchAll(/[a-z][a-z0-9]{2,}|\d+(?:[.,]\d+)?%?/gu)) {
    const tok = m[0]
    if (PROVENANCE_STOPWORDS_EN.has(tok)) continue
    if (!tokenInLexicon(tok, knownLex)) novelLatin.add(tok)
  }
  const novelCjkBigrams = new Set()
  let novelCjkUnits = 0
  for (const m of low.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const run = m[0]
    const covered = new Array(run.length).fill(false)
    for (let i = 0; i < run.length; i += 1) {
      if (PROVENANCE_CJK_FUNC.has(run[i])) covered[i] = true
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      if (knownLex.cjkBigrams.has(run.slice(i, i + 2))) {
        covered[i] = true
        covered[i + 1] = true
      }
    }
    let spanStart = -1
    for (let i = 0; i <= run.length; i += 1) {
      if (i < run.length && !covered[i]) {
        if (spanStart < 0) spanStart = i
      } else if (spanStart >= 0) {
        const span = run.slice(spanStart, i)
        if (span.length >= 2) {
          novelCjkUnits += Math.max(1, Math.floor(span.length / 2))
          for (let j = 0; j < span.length - 1; j += 1) {
            novelCjkBigrams.add(span.slice(j, j + 2))
          }
        }
        spanStart = -1
      }
    }
  }
  const tokens = [...novelLatin]
  const cjkBigrams = [...novelCjkBigrams]
  return { count: tokens.length + novelCjkUnits, tokens, cjkBigrams }
}

function normalizeProvenanceLine(line = '') {
  return String(line || '')
    .replace(/^[ \t]*(?:(?:[-*+]|[1-9]\d?[.)])[ \t]+|(?:[•·▪●○]|[1-9]\d?、)[ \t]*)/u, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[.。;；]+$/u, '')
    .trim()
}

function evidenceTextBlob(ev) {
  return [ev?.title, ev?.text, ev?.role, ev?.impact].filter(Boolean).join('\n')
}

export function attributeChatResumeProvenance({
  injectedEvidence = [],
  beforeMarkdown = '',
  afterMarkdown = '',
  modelChanges = [],
  explicitUsedIds = [],
  userMessage = '',
  history = [],
  locale = 'zh',
} = {}) {
  if (!Array.isArray(injectedEvidence) || !injectedEvidence.length || typeof afterMarkdown !== 'string' || !afterMarkdown.trim()) {
    return { evidenceIds: [], sourceIds: [], changeProvenance: [] }
  }
  const evById = new Map(injectedEvidence.map(e => [e.id, e]))
  const evLexById = new Map(injectedEvidence.map(e => [e.id, buildProvenanceLexicon(evidenceTextBlob(e))]))
  const allInjectedIds = injectedEvidence.map(e => e.id)
  const validExplicitIds = [...new Set(
    (Array.isArray(explicitUsedIds) ? explicitUsedIds : []).filter(eid => evById.has(eid)),
  )]
  const docDetectedIds = detectAbsorbedEvidenceIds(injectedEvidence, beforeMarkdown, afterMarkdown)
  const baseKnownText = [
    beforeMarkdown,
    userMessage,
    ...(Array.isArray(history) ? history : []).filter(turn => turn?.role === 'user').map(turn => String(turn.content || '')),
  ].join('\n')
  const baseKnownLex = buildProvenanceLexicon(baseKnownText)
  const reviewItems = computeReviewableLineChanges(beforeMarkdown, afterMarkdown, modelChanges, { locale })

  const changeProvenance = reviewItems.map(item => {
    if (item.kind === 'delete' || !String(item.text || '').trim()) {
      return {
        id: item.id,
        kind: item.kind,
        line: item.line,
        source: item.source || '',
        text: item.text || '',
        evidenceIds: [],
        sourceIds: [],
      }
    }
    const directSet = new Set(detectAbsorbedEvidenceIds(injectedEvidence, beforeMarkdown, item.text))
    // Multi-line evidence quotes matched at document level may span two lines; link lines sharing novel tokens with them.
    if (docDetectedIds.length > directSet.size) {
      const baseNovel = extractNovelProvenanceContent(item.text, baseKnownLex)
      for (const eid of docDetectedIds) {
        if (directSet.has(eid)) continue
        const evLex = evLexById.get(eid)
        if (!evLex) continue
        const shared = baseNovel.tokens.filter(t => tokenInLexicon(t, evLex)).length
          + baseNovel.cjkBigrams.filter(bg => evLex.cjkBigrams.has(bg)).length
        if (shared >= 2) directSet.add(eid)
      }
    }
    const directIds = [...directSet]
    const itemKnownLex = directIds.length
      ? buildProvenanceLexicon(`${baseKnownText}\n${directIds.map(id => evidenceTextBlob(evById.get(id))).join('\n')}`)
      : baseKnownLex
    const novel = extractNovelProvenanceContent(item.text, itemKnownLex)
    const overlapIds = []
    if (novel.tokens.length > 0 || novel.cjkBigrams.length > 0) {
      for (const ev of injectedEvidence) {
        if (directSet.has(ev.id)) continue
        const evLex = evLexById.get(ev.id)
        if (!evLex) continue
        if (novel.tokens.some(t => tokenInLexicon(t, evLex))
          || novel.cjkBigrams.some(bg => evLex.cjkBigrams.has(bg))) {
          overlapIds.push(ev.id)
        }
      }
    }
    const isHeading = /^#{1,6}\s+/u.test(item.text.trim())
    const needsConservative = item.kind === 'insert' && directIds.length === 0
      ? (isHeading ? novel.count >= 3 : novel.count >= 1)
      : novel.count >= 2
    const itemEvidenceIds = needsConservative
      ? [...allInjectedIds]
      : [...new Set([...directIds, ...overlapIds])]
    const itemSourceIds = [...new Set(itemEvidenceIds.map(eid => evById.get(eid)?.sourceId).filter(Boolean))]
    return {
      id: item.id,
      kind: item.kind,
      line: item.line,
      source: item.source || '',
      text: item.text || '',
      evidenceIds: itemEvidenceIds,
      sourceIds: itemSourceIds,
    }
  })

  // Ensure any explicitly declared or doc-level detected IDs not yet claimed by a specific item are still preserved.
  const claimedIds = new Set(changeProvenance.flatMap(ch => ch.evidenceIds))
  const unassignedIds = [...new Set([...validExplicitIds, ...docDetectedIds])].filter(id => !claimedIds.has(id))
  if (unassignedIds.length > 0) {
    const nonDeletes = changeProvenance.filter(ch => ch.kind !== 'delete' && ch.text.trim())
    const targets = nonDeletes.filter(ch => ch.evidenceIds.length === 0)
    const recipients = targets.length > 0 ? targets : nonDeletes
    for (const ch of recipients) {
      ch.evidenceIds = [...new Set([...ch.evidenceIds, ...unassignedIds])]
      ch.sourceIds = [...new Set(ch.evidenceIds.map(eid => evById.get(eid)?.sourceId).filter(Boolean))]
    }
  }

  const evidenceIds = [...new Set([
    ...validExplicitIds,
    ...docDetectedIds,
    ...changeProvenance.flatMap(ch => ch.evidenceIds),
  ])]
  const sourceIds = [...new Set(evidenceIds.map(eid => evById.get(eid)?.sourceId).filter(Boolean))]
  return { evidenceIds, sourceIds, changeProvenance }
}

export function matchPartialChatProvenance(recentChatProvenance, previousText = '', nextText = '') {
  if (!recentChatProvenance?.size || typeof nextText !== 'string' || !nextText.trim()) return []
  const prevLines = new Set(
    String(previousText || '').split(/\r?\n/u).map(normalizeProvenanceLine).filter(Boolean),
  )
  const addedLines = new Set(
    nextText.split(/\r?\n/u).map(normalizeProvenanceLine).filter(line => line && !prevLines.has(line)),
  )
  if (!addedLines.size) return []
  const entries = [...recentChatProvenance.values()].reverse()
  const matched = new Set()
  for (const normLine of addedLines) {
    for (const entry of entries) {
      const hit = (entry.changeProvenance ?? []).find(
        ch => ch && ch.kind !== 'delete' && normalizeProvenanceLine(ch.text) === normLine,
      )
      if (hit) {
        for (const eid of (hit.evidenceIds ?? [])) matched.add(eid)
        break
      }
    }
  }
  return [...matched]
}
