import { createHash } from 'node:crypto'

const MAX_RECALL_JD_CHARS = 12_000
const BM25F_K1 = 1.2
const BM25F_FIELDS = Object.freeze({
  title: { weight: 3.0, b: 0.5 },
  jd: { weight: 1.0, b: 0.75 },
})

const LRU_LIMIT = 4096
const docSectionCache = new Map()
const docTokenCache = new Map()

function lruGet(map, key) {
  if (!map.has(key)) return undefined
  const val = map.get(key)
  map.delete(key)
  map.set(key, val)
  return val
}

function lruSet(map, key, val) {
  if (map.has(key)) map.delete(key)
  map.set(key, val)
  while (map.size > LRU_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Clear BM25F in-memory caches (used by cold-vs-hot verification tests). */
export function clearBm25fCache() {
  docSectionCache.clear()
  docTokenCache.clear()
}

export const INTERN_CAMPUS_RE = /(?:实习生|暑期实习|日常实习|寒假实习|毕业实习|\bintern\b|\binternship\b)/i
const INTERN_ORGANIZER_RE = /(?:实习生?(?:管理|运营|项目经理|项目负责人|培养)|internship\s+program)/iu
const CAMPUS_APPLICANT_RE = /(?:应届(?:生|毕业|岗|职位)|校招生|校招(?:专场|岗位|职位)|(?:秋招|春招)(?:应届|校招|岗位|专场)|\bnew\s+grad(?:uate)?\b|\bcampus\s+hire\b)/iu
const CAMPUS_ORGANIZER_RE = /(?:招聘负责人|校园招聘经理|校园招聘专员|校园招聘运营|校园招聘主管|校园招聘总监|校招(?:hr|hrbp|经理|专家|专员|主管|总监|负责人|运营|项目经理)|实习生?(?:管理|运营|项目经理)|campus\s+(?:recruiter|recruiting|talent|relations|program)|university\s+recruiting|internship\s+program)/iu

const PRIMARY_ROLE_HEAD_ZH_RE = /^(?:代表|经理|主管|总监|专员|顾问|专家|负责人|助理|岗|岗位|职位|员|师|工程师|vp|director|manager|lead|specialist|rep|representative|executive|consultant|engineer)$/iu
const PRIMARY_ROLE_HEAD_EN_RE = /^(?:rep|representative|manager|director|lead|head|vp|account\s+executive|executive|specialist|associate|consultant|engineer)$/iu

/** Determine whether an avoid hint specifically targets intern openings. */
export function isInternAvoidHint(avoid = '') {
  return /^(?:实习|实习生|intern|internship)$/iu.test(String(avoid || '').trim())
}

/** Determine whether an avoid hint targets campus/new-grad applicant openings. */
export function isCampusAvoidHint(avoid = '') {
  return /^(?:校招|应届|应届生|校园招聘|campus|new\s*grad)$/iu.test(String(avoid || '').trim())
}

/** Determine whether an avoid hint targets intern or campus postings. */
export function isInternOrCampusAvoidHint(avoid = '') {
  return isInternAvoidHint(avoid) || isCampusAvoidHint(avoid)
}

/** Determine whether a title refers to an experienced HR/program lead managing campus hiring. */
export function isCampusHiringOrganizerTitle(title = '') {
  return CAMPUS_ORGANIZER_RE.test(String(title || ''))
}

/** True only when the posting itself is explicitly an intern role. */
export function isExplicitInternOpening(title = '') {
  const str = String(title || '')
  return INTERN_CAMPUS_RE.test(str) && !INTERN_ORGANIZER_RE.test(str)
}

/** True only when the posting explicitly solicits campus/new-grad applicants (not campus security or organizers). */
export function isExplicitCampusApplicantOpening(title = '') {
  const str = String(title || '')
  return CAMPUS_APPLICANT_RE.test(str) && !CAMPUS_ORGANIZER_RE.test(str)
}

/** True only when the posting itself is an intern/campus applicant opening rather than organizer or campus staff. */
export function isActualInternOrCampusOpening(title = '') {
  return isExplicitInternOpening(title) || isExplicitCampusApplicantOpening(title)
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Conservative symmetric primary-role avoid matching:
 * Only hard-excludes when a main title segment (outside parentheses/brackets) unambiguously denotes
 * the avoided occupation itself, leaving ambiguous/support titles (e.g. "销售团队招聘负责人",
 * "产品经理（销售系统）", "销售管理系统产品经理") eligible.
 */
export function isPrimaryRoleAvoidMatch(titleLower = '', jdLower = '', avoid = '', { hasTerm } = {}) {
  const needle = String(avoid || '').trim().toLowerCase()
  if (!needle) return false
  const strippedMain = String(titleLower || '')
    .replace(/[（([【][^）)\]】]{0,60}[）)\]】]/gu, ' ')
    .trim()
  if (!strippedMain) return false

  const termMatch = typeof hasTerm === 'function' ? hasTerm(strippedMain, needle) : strippedMain.includes(needle)
  if (!termMatch) return false

  // Guard against JD explicitly negating the avoided responsibility/quota in a clause
  const jdNegated = new RegExp(
    `(?:不承担|无需|不涉及|非)[^，,。；;\\n]{0,6}${escapeRegex(needle)}(?:指标|任务|考核|业绩|岗|岗位|职能)?`,
    'iu',
  ).test(String(jdLower || ''))
  if (jdNegated) return false

  const hasCjk = /[\u4e00-\u9fff]/u.test(needle)
  for (const rawSeg of strippedMain.split(/[/|—–\-·,，+]+/u)) {
    const seg = rawSeg.trim()
    if (!seg) continue
    if (hasCjk) {
      let idx = seg.indexOf(needle)
      while (idx >= 0) {
        const after = seg.slice(idx + needle.length).trim()
        if (!after || PRIMARY_ROLE_HEAD_ZH_RE.test(after)) {
          return true
        }
        idx = seg.indexOf(needle, idx + needle.length)
      }
    } else {
      const enBoundary = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(needle)}(?=$|[^a-z0-9])`, 'iu')
      const m = enBoundary.exec(seg)
      if (m) {
        const after = seg.slice(m.index + m[0].length).trim()
        if (!after || PRIMARY_ROLE_HEAD_EN_RE.test(after)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Stage 0 deterministic, industry-symmetric hard filter.
 * Applies ONLY user-declared exclusions and objective posting facts (never engineer-only blacklists).
 */
export function evaluateStage0HardFilter(job, profile = {}, feedbackMap = {}, opts = {}) {
  if (!job) return { excluded: true, reason: 'invalid', avoidTerm: '' }
  if (job.closedAt) return { excluded: true, reason: 'closed', avoidTerm: '' }
  if (feedbackMap?.[job.id]?.status === 'dismissed') {
    return { excluded: true, reason: 'dismissed', avoidTerm: '' }
  }
  const companyLower = String(job.company || '').trim().toLowerCase()
  if (companyLower && profile?.dislikedCompanies?.has?.(companyLower)) {
    return { excluded: true, reason: 'hidden_company', avoidTerm: '' }
  }

  const titleLower = String(job.title || '').normalize('NFKC').toLowerCase()
  const jdLower = String(job.jd || '').slice(0, MAX_RECALL_JD_CHARS).normalize('NFKC').toLowerCase()
  const { hasExplicitOutsourceLabel, isOutsourceAvoidHint, hasTerm } = opts

  for (const avoid of (profile?.avoidHints || [])) {
    if (typeof isOutsourceAvoidHint === 'function' && isOutsourceAvoidHint(avoid)) {
      if (typeof hasExplicitOutsourceLabel === 'function' && hasExplicitOutsourceLabel(titleLower, jdLower)) {
        return { excluded: true, reason: 'avoid_hint', avoidTerm: avoid }
      }
      continue
    }
    if (isInternAvoidHint(avoid)) {
      if (isExplicitInternOpening(job.title || '')) {
        return { excluded: true, reason: 'avoid_hint', avoidTerm: avoid }
      }
      continue
    }
    if (isCampusAvoidHint(avoid)) {
      if (isExplicitCampusApplicantOpening(job.title || '')) {
        return { excluded: true, reason: 'avoid_hint', avoidTerm: avoid }
      }
      continue
    }
    if (isPrimaryRoleAvoidMatch(titleLower, jdLower, avoid, { hasTerm })) {
      return { excluded: true, reason: 'avoid_hint', avoidTerm: avoid }
    }
  }

  return { excluded: false, reason: '', avoidTerm: '' }
}

const DUTY_HEADING_RE = /^(?:[一二三四五六七八九十0-9、.)】\]]*\s*)?(?:岗位职责|工作职责|核心职责|主要职责|工作内容|职位描述|核心工作|你将负责|岗位描述|role\s+overview|responsibilities|duties|what\s+you(?:'ll|\s+will)\s+do|key\s+responsibilities)\s*[:：]?(.*)$/iu
const REQ_HEADING_RE = /^(?:[一二三四五六七八九十0-9、.)】\]]*\s*)?(?:任职要求|任职资格|岗位要求|职位要求|加分项|加分条件|优先条件|requirements?|qualifications?|what\s+we\s+look\s+for|preferred)\s*[:：]?(.*)$/iu
const BOILERPLATE_HEADING_RE = /^(?:[一二三四五六七八九十0-9、.)】\]]*\s*)?(?:公司介绍|公司简介|关于我们|企业介绍|企业简介|团队介绍|福利待遇|薪资福利|员工福利|公司福利|about\s+us|company\s+overview|benefits|perks|compensation|equal\s+opportunity)\s*[:：]?(.*)$/iu

const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'under', 'through', 'across', 'using',
  'your', 'about', 'while', 'where', 'when', 'which', 'such', 'also', 'more', 'most', 'some', 'very', 'just',
  'only', 'both', 'each', 'every', 'other', 'being', 'have', 'has', 'had', 'were', 'been', 'will', 'would',
  'could', 'should', 'than', 'then', 'them', 'they', 'what', 'does', 'well', 'still', 'after', 'before',
  'between', 'during', 'without', 'within', 'since', 'until', 'via', 'are', 'was', 'not', 'but', 'all', 'can',
  'our', 'out', 'its', 'who', 'how', 'any', 'you', 'role', 'job', 'position', 'team', 'work', 'experience',
])

const ZH_FUNC_PARTICLE_RE = /[的了和与及在为向以等或把被给于对由并将着过所而之]/u

/** Split JD text into weighted sections (duty-prioritized) — pure, profile-independent. */
export function parseJdSections(rawJd = '') {
  const norm = String(rawJd || '')
    .normalize('NFKC')
    .slice(0, MAX_RECALL_JD_CHARS)
    .replace(/\r\n?/gu, '\n')
  if (!norm.trim()) return []

  const sections = []
  let currentWeight = 1.0
  let buffer = []
  const flush = () => {
    const joined = buffer.join('\n').trim()
    if (joined) sections.push({ text: joined, weight: currentWeight })
    buffer = []
  }

  for (const rawLine of norm.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let m
    if ((m = DUTY_HEADING_RE.exec(line))) {
      flush()
      currentWeight = 1.35
      if (m[1]?.trim()) buffer.push(m[1].trim())
    } else if ((m = REQ_HEADING_RE.exec(line))) {
      flush()
      currentWeight = 1.0
      if (m[1]?.trim()) buffer.push(m[1].trim())
    } else if ((m = BOILERPLATE_HEADING_RE.exec(line))) {
      flush()
      currentWeight = 0.35
      if (m[1]?.trim()) buffer.push(m[1].trim())
    } else {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

function addWeightedToken(tfMap, term, weight, type, spanId = '') {
  const prev = tfMap.get(term)
  if (prev) {
    prev.tf += weight
    if (spanId && !prev.spans.has(spanId)) prev.spans.add(spanId)
  } else {
    tfMap.set(term, {
      tf: weight,
      type,
      spans: spanId ? new Set([spanId]) : new Set(),
    })
  }
}

function scanSectionIntoTf(lowerText, sectionWeight, sortedAnchors, anchorSet, tfMap, spanPrefix) {
  if (!lowerText) return 0
  let tokenLen = 0
  let spanCounter = 0

  // 1. ASCII / specialized alphanumeric tokens (c++, .net, ci/cd, vllm, tensorrt-llm, pipl, cpq)
  for (const m of lowerText.matchAll(/(?<![a-z0-9])(?:\.[a-z0-9]+|[a-z0-9]+(?:[+#._/-][a-z0-9+#]*)*)(?![a-z0-9+#])/giu)) {
    let tok = m[0].replace(/[./-]+$/u, '')
    if (!tok || (tok.length === 1 && !/[a-z0-9]/i.test(tok))) continue
    if (tok.length < 2 || EN_STOPWORDS.has(tok) || /^\d+$/u.test(tok)) continue
    addWeightedToken(tfMap, tok, sectionWeight, 'latin')
    tokenLen += sectionWeight
    // Also index hyphen/slash sub-segments when specialized (e.g. "tensorrt-llm" -> keep full AND sub-parts)
    if (/[/-]/u.test(tok)) {
      for (const sub of tok.split(/[/-]+/u)) {
        if (sub.length >= 2 && !EN_STOPWORDS.has(sub) && !/^\d+$/u.test(sub)) {
          addWeightedToken(tfMap, sub, sectionWeight * 0.65, 'latin')
        }
      }
    }
  }

  // 2. CJK contiguous runs -> greedy FMM with anchorVocab, then overlapping 2-char bigrams for unanchored spans
  const secFmmHits = new Map()
  for (const m of lowerText.matchAll(/[\u4e00-\u9fff]+/gu)) {
    const run = m[0]
    let i = 0
    let unanchored = ''

    const flushUnanchored = () => {
      if (!unanchored) return
      const segments = unanchored.split(ZH_FUNC_PARTICLE_RE).filter(Boolean)
      for (const seg of segments) {
        if (seg.length === 1) {
          if (anchorSet.has(seg)) {
            addWeightedToken(tfMap, seg, sectionWeight, 'anchor')
            secFmmHits.set(seg, (secFmmHits.get(seg) || 0) + 1)
            tokenLen += sectionWeight
          }
          continue
        }
        const spanId = `${spanPrefix}:${spanCounter++}`
        for (let k = 0; k < seg.length - 1; k += 1) {
          const bg = `bg:${seg.slice(k, k + 2)}`
          addWeightedToken(tfMap, bg, sectionWeight, 'cjk_bigram', spanId)
          tokenLen += sectionWeight * 0.5
        }
      }
      unanchored = ''
    }

    while (i < run.length) {
      let matched = ''
      for (let a = 0; a < sortedAnchors.length; a += 1) {
        const cand = sortedAnchors[a]
        if (cand.length > run.length - i) continue
        if (run.startsWith(cand, i)) {
          matched = cand
          break
        }
      }
      if (matched) {
        flushUnanchored()
        addWeightedToken(tfMap, matched, sectionWeight, 'anchor')
        secFmmHits.set(matched, (secFmmHits.get(matched) || 0) + 1)
        tokenLen += sectionWeight
        i += matched.length
      } else {
        unanchored += run[i]
        i += 1
      }
    }
    flushUnanchored()
  }

  // Reconcile shorter CJK anchors swallowed by longer FMM matches (e.g. query "数据出境" inside "数据出境合规")
  // without inflating field tokenLen.
  for (let a = 0; a < sortedAnchors.length; a += 1) {
    const anchor = sortedAnchors[a]
    if (!/^[\u4e00-\u9fff]{2,}$/u.test(anchor)) continue
    const fmmCount = secFmmHits.get(anchor) || 0
    let totalOcc = 0
    let pos = lowerText.indexOf(anchor)
    while (pos >= 0) {
      totalOcc += 1
      pos = lowerText.indexOf(anchor, pos + anchor.length)
    }
    if (totalOcc > fmmCount) {
      addWeightedToken(tfMap, anchor, (totalOcc - fmmCount) * sectionWeight, 'anchor')
    }
  }

  return tokenLen
}

function collectAnchorVocabulary(profile = {}, expandedTerms = []) {
  const anchors = new Set()
  const addPhrase = raw => {
    const norm = String(raw || '').normalize('NFKC').toLowerCase().trim()
    if (!norm) return
    // Extract CJK chunks and full phrase
    if (/^[\u4e00-\u9fff]{1,24}$/u.test(norm)) {
      anchors.add(norm)
    } else {
      for (const han of norm.matchAll(/[\u4e00-\u9fff]{2,16}/gu)) {
        anchors.add(han[0])
      }
    }
  }

  for (const term of (profile?.searchTerms || [])) addPhrase(term)
  for (const phrase of (profile?.goalTargets || [])) addPhrase(phrase)
  for (const kw of (profile?.resumeKeywords || [])) addPhrase(kw)
  for (const group of (profile?.targetGroups || [])) {
    addPhrase(group?.term)
    for (const alias of (group?.aliases || [])) addPhrase(alias)
  }
  for (const exp of (expandedTerms || [])) addPhrase(exp)

  const sortedAnchors = [...anchors].sort((a, b) => b.length - a.length || a.localeCompare(b))
  const vocabVersion = createHash('sha256').update(JSON.stringify(sortedAnchors)).digest('hex').slice(0, 12)
  return { sortedAnchors, anchorSet: anchors, vocabVersion }
}

/**
 * Tokenize a job into title/jd weighted TF maps using Tier-1 section cache and Tier-2 vocab-keyed cache.
 */
export function tokenizeJobForBm25f(job, vocabMeta, { useCache = true, jobFingerprint = '' } = {}) {
  const fp = jobFingerprint || `${job?.id || ''}::${String(job?.title || '').length}:${String(job?.jd || '').length}`
  const docKey = `${job?.id || 'anon'}@${fp}`

  let parsed = useCache ? lruGet(docSectionCache, docKey) : undefined
  if (!parsed) {
    parsed = {
      titleLower: String(job?.title || '').normalize('NFKC').toLowerCase(),
      jdSections: parseJdSections(job?.jd || ''),
    }
    if (useCache) lruSet(docSectionCache, docKey, parsed)
  }

  const tokenKey = `${vocabMeta.vocabVersion}::${docKey}`
  let tokenized = useCache ? lruGet(docTokenCache, tokenKey) : undefined
  if (!tokenized) {
    const titleTf = new Map()
    const jdTf = new Map()
    const dlTitle = scanSectionIntoTf(parsed.titleLower, 1.0, vocabMeta.sortedAnchors, vocabMeta.anchorSet, titleTf, 't')
    let dlJd = 0
    for (let s = 0; s < parsed.jdSections.length; s += 1) {
      const sec = parsed.jdSections[s]
      dlJd += scanSectionIntoTf(sec.text.toLowerCase(), sec.weight, vocabMeta.sortedAnchors, vocabMeta.anchorSet, jdTf, `j${s}`)
    }
    tokenized = {
      titleTf,
      jdTf,
      dlTitle: Math.max(1, dlTitle),
      dlJd: Math.max(1, dlJd),
    }
    if (useCache) lruSet(docTokenCache, tokenKey, tokenized)
  }

  return tokenized
}

const BROAD_MODIFIERS = new Set([
  'ai', 'ml', 'it', 'web', 'data', 'cloud', 'tech', 'llm', 'agent', 'rag', 'software', 'system', 'systems', 'platform',
  '大模型', '人工智能', '平台', '研发', '工程', '算法', '模型', '技术', '数据', '系统', '软件', '工具', '工作流',
])

/** Build BM25F weighted query terms from user searchTerms, goalTargets, resumeKeywords, and symmetric aliases. */
export function buildBm25fQuery(profile = {}, { expandedTerms = [], vocabMeta = null } = {}) {
  const queryMap = new Map()
  const addQ = (term, weight, type, spanGroup = '') => {
    const clean = String(term || '').normalize('NFKC').toLowerCase().trim()
    if (!clean) return
    const prev = queryMap.get(clean)
    if (!prev || weight > prev.weight) {
      queryMap.set(clean, { term: clean, weight, type, spanGroup })
    }
  }

  const decomposePhrase = (raw, baseWeight, groupTag, bigramWeight = 0.25) => {
    const norm = String(raw || '').normalize('NFKC').toLowerCase().trim()
    if (!norm) return
    const isBroad = BROAD_MODIFIERS.has(norm)
    const effectiveWeight = isBroad ? Math.min(baseWeight, 0.85) : baseWeight
    const isMixedCompound = /[a-z0-9]{2,}/iu.test(norm) && /[\u4e00-\u9fff]/u.test(norm) && !/\s+/u.test(norm)

    // English / ASCII compound or token
    for (const m of norm.matchAll(/(?<![a-z0-9])(?:\.[a-z0-9]+|[a-z0-9]+(?:[+#._/-][a-z0-9+#]*)*)(?![a-z0-9+#])/giu)) {
      const tok = m[0].replace(/[./-]+$/u, '')
      if (tok.length >= 2 && !EN_STOPWORDS.has(tok)) addQ(tok, effectiveWeight, 'latin')
    }
    // If multi-word English phrase (e.g. "account executive", "ai infra"), also add sub-words slightly weighted
    if (/\s+/u.test(norm) && /^[a-z0-9\s+#.-]+$/u.test(norm)) {
      for (const word of norm.split(/\s+/u)) {
        if (word.length >= 2 && !EN_STOPWORDS.has(word)) {
          addQ(word, effectiveWeight * 0.65, 'latin')
        }
      }
    }

    // CJK spans: attenuate trailing/partial CJK fragments of mixed Latin+CJK compounds (e.g. "GPU调度")
    const cjkWeight = isMixedCompound ? effectiveWeight * 0.35 : effectiveWeight
    for (const m of norm.matchAll(/[\u4e00-\u9fff]+/gu)) {
      const han = m[0]
      if (han.length === 1) {
        addQ(han, cjkWeight * 0.8, 'anchor')
        continue
      }
      addQ(han, cjkWeight, 'anchor')
      // When phrase is >= 3 CJK chars, include FMM inner anchors + low-weight capped overlapping bigrams for partial lexical match
      if (han.length >= 3) {
        for (const subSeg of han.split(ZH_FUNC_PARTICLE_RE).filter(Boolean)) {
          if (subSeg.length === 2) addQ(subSeg, cjkWeight * 0.45, 'anchor')
          else if (subSeg.length >= 3) {
            for (let k = 0; k < subSeg.length - 1; k += 1) {
              addQ(`bg:${subSeg.slice(k, k + 2)}`, bigramWeight, 'cjk_bigram', `${groupTag}:${han}`)
            }
          }
        }
      }
    }
  }

  const decomposePeer = (peer, peerWeight) => {
    for (const m of peer.matchAll(/(?<![a-z0-9])(?:\.[a-z0-9]+|[a-z0-9]+(?:[+#._/-][a-z0-9+#]*)*)(?![a-z0-9+#])/giu)) {
      const tok = m[0].replace(/[./-]+$/u, '')
      if (tok.length >= 2 && !EN_STOPWORDS.has(tok)) addQ(tok, peerWeight, 'latin')
    }
    for (const m of peer.matchAll(/[\u4e00-\u9fff]{2,16}/gu)) {
      addQ(m[0], peerWeight, 'anchor')
    }
  }

  for (const term of (profile?.searchTerms || [])) decomposePhrase(term, 2.4, 'term', 0.25)
  for (const target of (profile?.goalTargets || [])) decomposePhrase(target, 1.8, 'goal', 0.25)
  for (const group of (profile?.targetGroups || [])) {
    if (!group?.isBroad && Array.isArray(group?.aliases)) {
      for (const alias of group.aliases) {
        const low = String(alias || '').toLowerCase().trim()
        if (low && low !== String(group.term || '').toLowerCase().trim()) {
          decomposePeer(low, group.isNamedRole ? 0.75 : 0.55)
        }
      }
    }
  }
  for (const kw of (profile?.resumeKeywords || []).slice(0, 16)) {
    decomposePhrase(kw, 1.0, 'resume', 0.18)
  }
  if (Array.isArray(expandedTerms) && expandedTerms.length > 0) {
    for (const exp of expandedTerms) decomposePeer(String(exp || '').normalize('NFKC').toLowerCase(), 0.3)
  }

  // Ensure vocabMeta contains any sub-anchors added above if called standalone
  if (vocabMeta) {
    for (const entry of queryMap.values()) {
      if (entry.type === 'anchor' && /^[\u4e00-\u9fff]+$/u.test(entry.term) && !vocabMeta.anchorSet.has(entry.term)) {
        vocabMeta.anchorSet.add(entry.term)
        vocabMeta.sortedAnchors.push(entry.term)
        vocabMeta.sortedAnchors.sort((a, b) => b.length - a.length || a.localeCompare(b))
      }
    }
  }

  return [...queryMap.values()]
}

/**
 * Pure-JS Robertson-Zaragoza BM25F ranker with whole-doc DF, layered IDF smoothing,
 * field-normalized weighted TF summation before single k1=1.2 saturation, and symmetric soft signals.
 */
export function rankOpportunitiesBm25f(jobs = [], profile = {}, opts = {}) {
  const {
    feedbackMap = {},
    expandedTerms = [],
    useCache = true,
    dropHighDfBigrams = false,
    hasExplicitOutsourceLabel,
    isOutsourceAvoidHint,
    hasTerm,
    matchesCity,
    locationMarkets = [],
    jobContentFingerprint,
  } = opts

  const list = Array.isArray(jobs) ? jobs.filter(j => j?.id) : []
  const vocabMeta = collectAnchorVocabulary(profile, expandedTerms)
  const queryTerms = buildBm25fQuery(profile, { expandedTerms, vocabMeta })
  // Refresh vocabVersion if buildBm25fQuery decomposed additional CJK anchors
  vocabMeta.vocabVersion = createHash('sha256').update(JSON.stringify(vocabMeta.sortedAnchors)).digest('hex').slice(0, 12)

  const stage0Results = new Map()
  const activeDocs = []
  for (const job of list) {
    const st0 = evaluateStage0HardFilter(job, profile, feedbackMap, {
      hasExplicitOutsourceLabel,
      isOutsourceAvoidHint,
      hasTerm,
    })
    stage0Results.set(job.id, st0)
    if (st0.excluded) continue
    const fp = typeof jobContentFingerprint === 'function' ? jobContentFingerprint(job) : ''
    const tok = tokenizeJobForBm25f(job, vocabMeta, { useCache, jobFingerprint: fp })
    activeDocs.push({ job, tok })
  }

  const N = activeDocs.length
  let sumTitleLen = 0
  let sumJdLen = 0
  const dfMap = new Map()
  for (const { tok } of activeDocs) {
    sumTitleLen += tok.dlTitle
    sumJdLen += tok.dlJd
    // Whole-document df: each document increments df(t) at most ONCE across title & jd
    const docTerms = new Set([...tok.titleTf.keys(), ...tok.jdTf.keys()])
    for (const term of docTerms) {
      dfMap.set(term, (dfMap.get(term) || 0) + 1)
    }
  }
  const avgdlTitle = N > 0 ? Math.max(1, sumTitleLen / N) : 1
  const avgdlJd = N > 0 ? Math.max(1, sumJdLen / N) : 1

  const ranked = []
  const byId = new Map()

  for (const { job, tok } of activeDocs) {
    let bm25fRaw = 0
    const spanAccum = new Map()
    const matchedAnchors = []

    for (const q of queryTerms) {
      const df = dfMap.get(q.term) || 0
      if (df === 0) continue
      if (dropHighDfBigrams && q.type === 'cjk_bigram' && N >= 10 && df / N > 0.4) continue

      const effDf = q.type === 'cjk_bigram' ? Math.min(N, Math.max(df, 5)) : df
      const idf = Math.max(0, Math.log(1 + (N - effDf + 0.5) / (effDf + 0.5)))
      if (idf <= 0) continue

      const titleEntry = tok.titleTf.get(q.term)
      const jdEntry = tok.jdTf.get(q.term)
      const tfTitle = titleEntry ? titleEntry.tf : 0
      const tfJd = jdEntry ? jdEntry.tf : 0
      if (tfTitle <= 0 && tfJd <= 0) continue

      const normTitle = tfTitle > 0
        ? (BM25F_FIELDS.title.weight * tfTitle) / ((1 - BM25F_FIELDS.title.b) + BM25F_FIELDS.title.b * (tok.dlTitle / avgdlTitle))
        : 0
      const normJd = tfJd > 0
        ? (BM25F_FIELDS.jd.weight * tfJd) / ((1 - BM25F_FIELDS.jd.b) + BM25F_FIELDS.jd.b * (tok.dlJd / avgdlJd))
        : 0
      const tfTilde = normTitle + normJd
      if (tfTilde <= 0) continue

      const sat = (tfTilde * (BM25F_K1 + 1)) / (BM25F_K1 + tfTilde)
      const contrib = q.weight * idf * sat

      if (q.type === 'cjk_bigram' && q.spanGroup) {
        const cap = 0.65 * Math.log(1 + (N - Math.min(N, 5) + 0.5) / (Math.min(N, 5) + 0.5))
        const curSpan = spanAccum.get(q.spanGroup) || 0
        const allowed = Math.max(0, cap - curSpan)
        const clamped = Math.min(allowed, contrib)
        spanAccum.set(q.spanGroup, curSpan + clamped)
        bm25fRaw += clamped
      } else {
        bm25fRaw += contrib
        if (!q.term.startsWith('bg:') && !matchedAnchors.includes(q.term)) {
          matchedAnchors.push(q.term)
        }
      }
    }

    // Symmetric soft preference multipliers (location, disliked company/direction history, soft intern conflict)
    const location = String(job.location || '')
    const locLower = location.normalize('NFKC').toLowerCase()
    const titleStr = String(job.title || '')
    const titleLower = titleStr.normalize('NFKC').toLowerCase()
    let mult = 1.0
    let softBonus = 0

    const statedMarkets = (profile?.targetMarkets || []).map(i => locationMarkets[i]).filter(Boolean)
    const targetCities = profile?.targetCities || []
    const countryHit = statedMarkets.some(m => m.locations?.test(location))
    const cityHit = typeof matchesCity === 'function'
      ? targetCities.find(c => matchesCity(locLower, c) || matchesCity(titleLower, c))
      : targetCities.find(c => locLower.includes(c.toLowerCase()))
    const worldwide = /\b(?:worldwide|anywhere in the world|global remote)\b|全球远程/iu.test(location)
    const elsewhere = statedMarkets.length > 0 && !countryHit && !(cityHit && !['remote', '远程', '居家办公'].includes(cityHit))
      && !worldwide && locationMarkets.some(m => m.locations?.test(location))

    if (elsewhere) {
      mult *= 0.72
    } else if (cityHit) {
      mult *= 1.08
      softBonus += 0.25
    } else if (locLower.includes('remote') || locLower.includes('远程')) {
      mult *= 1.03
      softBonus += 0.12
    } else if (targetCities.length > 0 && locLower) {
      mult *= 0.88
    } else if (countryHit && targetCities.length === 0) {
      mult *= 1.05
      softBonus += 0.15
    }

    if (profile?.dislikedCities?.size > 0 && typeof matchesCity === 'function'
      && [...profile.dislikedCities].some(c => matchesCity(locLower, c))) {
      mult *= 0.82
    }
    if (profile?.dislikedTitleTokens?.size > 0) {
      const hitDisliked = [...profile.dislikedTitleTokens].some(t =>
        typeof hasTerm === 'function' ? hasTerm(titleLower, t) : titleLower.includes(t))
      if (hitDisliked) mult *= 0.82
    }
    if (!profile?.wantsIntern && (profile?.experienceYears ?? 0) >= 2 && isActualInternOrCampusOpening(titleStr)) {
      mult *= 0.65
    }

    const recallScore = bm25fRaw > 0 ? Number((bm25fRaw * mult + softBonus).toFixed(6)) : 0
    const recency = String(job.verifiedAt || job.firstSeenAt || '')
    const row = {
      job,
      id: job.id,
      recallScore,
      bm25fRaw: Number(bm25fRaw.toFixed(6)),
      softMultiplier: Number(mult.toFixed(4)),
      matchedAnchors,
      stage0: stage0Results.get(job.id),
      recency,
    }
    ranked.push(row)
    byId.set(job.id, row)
  }

  ranked.sort((a, b) => (b.recallScore - a.recallScore)
    || b.recency.localeCompare(a.recency)
    || String(a.id).localeCompare(String(b.id)))

  for (const job of list) {
    if (!byId.has(job.id)) {
      byId.set(job.id, {
        job,
        id: job.id,
        recallScore: 0,
        bm25fRaw: 0,
        softMultiplier: 0,
        matchedAnchors: [],
        stage0: stage0Results.get(job.id),
        recency: String(job.verifiedAt || job.firstSeenAt || ''),
      })
    }
  }

  return {
    ranked,
    byId,
    avgdlTitle,
    avgdlJd,
    activeCount: N,
    vocabVersion: vocabMeta.vocabVersion,
  }
}
