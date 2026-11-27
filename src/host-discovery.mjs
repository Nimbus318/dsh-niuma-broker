import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { resumeEvidenceIds } from './career.mjs'
import { boardSourceId, collectOpportunities, fetchOpportunityDetail, MAX_SOURCES, validateBoardSource } from './opportunities.mjs'
import {
  buildPatrolSearchProfile, isOpportunityJdIncomplete, rankPendingOpportunitiesBm25f, scoreOpportunityHeuristic,
} from './job-triage.mjs'
import { normalizeHiringScope } from './job-view-scope.mjs'
import {
  CURATED_BOARDS, CURATED_COMPANIES, boardPosition, companyHiringBoards, findCompanyBoard,
  findNamedCompanyBoards, hiringScopesFromText, mergeSearchBoards, parseBoardInput, resolveNamedHiringBoard,
} from './company-boards.mjs'
import { normalizeDomain, resolveCompanyDomain } from './company-domains.mjs'
import { modelJson, modelRoute } from './watch.mjs'
import { normalizeLocale } from './i18n/index.mjs'
import { uiLanguageDirective } from './i18n/prompt.mjs'
import { isShareableEvidence } from './host-provenance.mjs'

const NATIVE_FETCH = globalThis.fetch
const PRIVATE_PAGE_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home', '.arpa', '.localdomain']

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224
}

function isPrivateIpAddress(rawIp) {
  const clean = String(rawIp || '').trim().replace(/^\[|\]$/gu, '').split('%')[0].toLowerCase()
  const version = isIP(clean)
  if (!version) return true
  if (version === 4) return isPrivateIpv4(clean)
  if (clean === '::' || clean === '::1') return true
  if (clean.startsWith('::ffff:')) {
    const tail = clean.slice(7)
    if (tail.includes('.')) return isPrivateIpv4(tail)
    const hexParts = tail.split(':')
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16)
      const lo = Number.parseInt(hexParts[1], 16)
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
      }
    }
    return true
  }
  const firstWord = Number.parseInt(clean.split(':')[0] || '0', 16)
  if (Number.isNaN(firstWord)) return true
  if ((firstWord & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((firstWord & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((firstWord & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

function isSafePublicJobPageUrl(rawUrl, { allowRoot = false } = {}) {
  let parsed
  try { parsed = new URL(String(rawUrl || '').trim()) } catch { return '' }
  if (parsed.protocol !== 'https:') return ''
  if (parsed.username || parsed.password) return ''
  if (parsed.port && parsed.port !== '443') return ''
  const host = parsed.hostname.toLowerCase()
  if (!host || host === 'localhost' || PRIVATE_PAGE_HOST_SUFFIXES.some(sfx => host.endsWith(sfx))) return ''
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) || host.includes(':')) return ''
  if (!normalizeDomain(host)) return ''
  if (!allowRoot && parsed.pathname === '/' && !parsed.search && !parsed.hash) return ''
  return parsed.href
}

function stripHtmlToText(raw) {
  return String(raw || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<(?:noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/(?:noscript|svg|nav|header|footer)>/giu, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t\r\f\v]+/gu, ' ')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, 4000)
}

function inferBoardFromCareersUrl(rawUrl, providerHint, slugHint, company, intent) {
  const named = findNamedCompanyBoards(company)[0]
  const fromUrl = parseBoardInput(rawUrl)
  const fromHint = providerHint && slugHint ? parseBoardInput(providerHint + ':' + slugHint) : null
  if (named) {
    const channel = resolveNamedHiringBoard(named, rawUrl, fromHint, intent)
    return channel ? validateBoardSource(channel) : null
  }
  if (fromUrl || fromHint) return fromUrl || fromHint
  // These companies also had direct mappings before their boards had directory cards.
  const extraBoards = { ramp: 'ashby:ramp', harvey: 'ashby:harvey', robinhood: 'greenhouse:robinhood',
    discord: 'greenhouse:discord', langchain: 'ashby:langchain', replit: 'ashby:replit' }
  return parseBoardInput(extraBoards[String(company || '').trim().toLowerCase()])
}

function applyDiscoveredUpgrade(next, { company, provider = '', slug = '', careersUrl = '', jobCount = 0, verified = false }) {
  const items = next.discoveredCompanies?.items
  if (!Array.isArray(items) || !items.length) return false
  const cleanCo = String(company || '').trim().toLowerCase()
  const cleanUrl = String(careersUrl || '').trim().toLowerCase()
  let changed = false
  next.discoveredCompanies = {
    ...next.discoveredCompanies,
    items: items.map(item => {
      const hitCompany = cleanCo && String(item?.company || '').trim().toLowerCase() === cleanCo
      const hitUrl = cleanUrl && String(item?.careersUrl || '').trim().toLowerCase() === cleanUrl
      if (!hitCompany && !hitUrl) return item
      changed = true
      return {
        ...item,
        ...(provider ? { provider } : {}),
        ...(slug ? { slug } : {}),
        ...(careersUrl ? { careersUrl } : {}),
        ...(verified ? { verified: true, jobCount: Number(jobCount || item.jobCount || 0) } : {}),
      }
    }),
  }
  return changed
}

function filterAndRankCompanyCandidates(jobs, patrolProfile, hasProfile, loc = 'zh', limit = 10) {
  const indexed = jobs.map((job, idx) => ({ ...job, id: job.id || `preview-${idx}` }))
  if (!hasProfile) {
    return { kept: indexed.slice(0, limit), filteredOut: 0, byId: new Map() }
  }
  const rankedRes = rankPendingOpportunitiesBm25f(indexed, patrolProfile)
  const matched = rankedRes.ranked.filter(entry => {
    if (entry.stage0?.excluded || entry.recallScore <= 0) return false
    const anchors = Array.isArray(entry.matchedAnchors) ? entry.matchedAnchors : []
    if (!anchors.some(a => a.length >= 3 || /[\u4e00-\u9fff]/u.test(a))) return false
    const h = scoreOpportunityHeuristic(entry.job, patrolProfile, loc)
    return Array.isArray(h?.factSignals) && h.factSignals.some(s => s.kind === 'match' && s.key !== 'location')
  })
  return {
    kept: matched.slice(0, limit).map(entry => entry.job),
    filteredOut: Math.max(0, indexed.length - matched.length),
    byId: rankedRes.byId,
  }
}

function serializePreviewCandidate(job, entry, company, inferSite = '') {
  const anchors = Array.isArray(entry?.matchedAnchors) ? entry.matchedAnchors.slice(0, 4) : []
  return {
    id: job.id || '',
    company: job.company || company,
    title: job.title,
    location: job.location || '',
    url: job.url || '',
    jd: job.jd || '',
    jdPreview: Boolean(job.jdPreview || isOpportunityJdIncomplete(job)),
    provider: job.provider || '',
    sourceId: job.sourceId || '',
    externalId: job.externalId || '',
    sourceSite: inferSite || job.provider || '',
    matchedAnchors: anchors,
  }
}

async function hydrateAndSerializeCandidates(kept, byId, company, inferSite = '', { maxHydrate = 6 } = {}) {
  const needHydrate = kept.filter(job => isOpportunityJdIncomplete(job)).slice(0, maxHydrate)
  const hydratedMap = new Map()
  if (needHydrate.length > 0) {
    await Promise.allSettled(needHydrate.map(async job => {
      const detail = await Promise.race([
        fetchOpportunityDetail(job).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
      ])
      if (detail?.jd) hydratedMap.set(job.id, detail)
    }))
  }
  return kept.map(job => {
    const detail = hydratedMap.get(job.id)
    const merged = detail?.jd
      ? { ...job, jd: detail.jd, jdPreview: Boolean(detail.jdPreview) }
      : job
    return serializePreviewCandidate(merged, byId.get(job.id), company, inferSite)
  })
}

function extractAtsPostingToken(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim())
    const fullPath = `${u.pathname}${u.hash || ''}`
    const m = /(?:\/jobs\/(?!search(?:[/?#]|$)|list(?:[/?#]|$)|index(?:[/?#]|$))(\d+|[A-Za-z0-9_-]{3,})|\/position\/(?!search(?:[/?#]|$)|list(?:[/?#]|$)|index(?:[/?#]|$))(\d+|[A-Za-z0-9_-]{3,})|\/detail\/(?!list(?:[/?#]|$))([A-Za-z0-9_-]{4,})|\/job\/(?!list(?:[/?#]|$))([A-Za-z0-9_-]{6,})|\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))/iu.exec(fullPath)
    return m ? (m[1] || m[2] || m[3] || m[4] || m[5] || '') : ''
  } catch {
    return ''
  }
}

/**
 * Orchestrates company discovery, discovery-direction suggestions, SSRF-safe public
 * page fetching, CUA company job searches, and ATS fast-path handovers.
 */
export function createHostDiscovery(deps) {
  const {
    ctx,
    store,
    optionalService,
    getControl,
    isClosed,
    getRevision,
    activeLocale,
    defaultModelRoute,
    defaultTabModelRoute,
    llmCallConfig,
    exclusive,
    commit,
    publish,
    createActivityTracker,
    resumeFor,
    stageOpportunities,
    normalizeOpportunityUrl,
    buildManualOpportunityRecord,
    mergeBoards,
    triage,
    string,
    modelText,
    shortModelName,
    extractReadableExcerpt,
  } = deps

  async function isPublicDnsHost(hostname) {
    const host = String(hostname || '').trim().replace(/^\[|\]$/gu, '')
    if (!host) return false
    if (isIP(host)) return !isPrivateIpAddress(host)
    const lookupFn = typeof ctx?.dnsLookup === 'function' ? ctx.dnsLookup : dnsLookup
    try {
      const records = await Promise.race([
        lookupFn(host, { all: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 2_500)),
      ])
      if (!Array.isArray(records) || records.length === 0) return false
      return records.every(rec => !isPrivateIpAddress(rec?.address))
    } catch (err) {
      if (typeof ctx?.dnsLookup !== 'function' && globalThis.fetch !== NATIVE_FETCH && (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN')) {
        return true
      }
      return false
    }
  }

  async function fetchSafePublicHtml(rawUrl, { web = null, timeoutMs = 5_000, allowRoot = false } = {}) {
    const safeStart = isSafePublicJobPageUrl(rawUrl, { allowRoot })
    if (!safeStart) return null
    if (!allowRoot && web && typeof web.fetch === 'function') {
      try {
        const res = await web.fetch({ url: safeStart }, AbortSignal.timeout(timeoutMs))
        const body = typeof res?.text === 'string' ? res.text : (typeof res?.content === 'string' ? res.content : (typeof res === 'string' ? res : ''))
        if (body) return { html: body.slice(0, 262_144), finalUrl: safeStart, fromWebFetch: true }
      } catch {}
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let currentUrl = safeStart
      let response = null
      for (let hop = 0; hop < 2; hop += 1) {
        if (!(await isPublicDnsHost(new URL(currentUrl).hostname))) return null
        response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; NiumaBroker/1.0)', accept: 'text/html,text/plain;q=0.9' },
        })
        if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get('location')
          const resolved = loc ? isSafePublicJobPageUrl(new URL(loc, currentUrl).href, { allowRoot: true }) : ''
          if (!resolved) return null
          currentUrl = resolved
          continue
        }
        break
      }
      if (!response || !response.ok) return null
      const contentType = String(response.headers.get('content-type') || '').toLowerCase()
      if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) return null
      const html = (await response.text()).slice(0, 262_144)
      return { html, finalUrl: currentUrl, fromWebFetch: false }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchPublicJobPageText(rawUrl, web) {
    const fetched = await fetchSafePublicHtml(rawUrl, { web, timeoutMs: 5_000, allowRoot: false })
    if (!fetched?.html) return ''
    const clean = stripHtmlToText(fetched.html)
    if (fetched.fromWebFetch && clean.length < 100) return ''
    return clean
  }

  async function probeCompanyCareersTarget({ domain = '', careersUrl = '' } = {}) {
    const startUrl = isSafePublicJobPageUrl(careersUrl, { allowRoot: true })
      || (domain ? isSafePublicJobPageUrl(`https://${domain}`, { allowRoot: true }) : '')
    if (!startUrl) return { atsBoard: null, careersUrl: '' }
    const direct = parseBoardInput(startUrl)
    if (direct) return { atsBoard: direct, careersUrl: startUrl }
    const fetched = await fetchSafePublicHtml(startUrl, { timeoutMs: 3_000, allowRoot: true })
    if (!fetched?.html) return { atsBoard: null, careersUrl: '' }
    const fromFinal = parseBoardInput(fetched.finalUrl)
    if (fromFinal) return { atsBoard: fromFinal, careersUrl: fetched.finalUrl }

    const rootDomain = domain || normalizeDomain(new URL(fetched.finalUrl).hostname)
    let bestCareersLink = ''
    const anchorRe = /<a\b[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/giu
    let match
    while ((match = anchorRe.exec(fetched.html)) !== null) {
      const rawHref = String(match[2] || '').trim()
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue
      let resolvedHref = ''
      try { resolvedHref = new URL(rawHref, fetched.finalUrl).href } catch { continue }
      const safeHref = isSafePublicJobPageUrl(resolvedHref, { allowRoot: true })
      if (!safeHref) continue
      const parsedBoard = parseBoardInput(safeHref)
      if (parsedBoard) return { atsBoard: parsedBoard, careersUrl: safeHref }
      if (!bestCareersLink) {
        const anchorText = match[3].replace(/<[^>]+>/gu, ' ').trim()
        const u = new URL(safeHref)
        const host = u.hostname.toLowerCase()
        const sameOrg = rootDomain && (host === rootDomain || host.endsWith(`.${rootDomain}`))
        const looksLikeCareers = /(?:careers?|jobs?|join(?:-us)?|recruit|talent|campus|加入我们|招贤纳士|诚聘|招聘)/iu.test(`${u.pathname} ${anchorText}`)
        if (sameOrg && looksLikeCareers && !(u.pathname === '/' && !u.search && !u.hash)) {
          bestCareersLink = safeHref
        }
      }
    }
    return { atsBoard: null, careersUrl: bestCareersLink || (fetched.finalUrl !== startUrl ? fetched.finalUrl : '') }
  }

  async function loadCompanyMatchContext(explicitScope = '', explicitKeywords = []) {
    const control = getControl()
    const cleanKeywords = Array.isArray(explicitKeywords)
      ? [...new Set(explicitKeywords.map(k => (typeof k === 'string' ? k.trim().slice(0, 60) : '')).filter(Boolean))].slice(0, 8)
      : []
    const rawScope = typeof explicitScope === 'string' ? explicitScope.trim().toLowerCase() : ''
    const effectiveScope = rawScope === 'both'
      ? ''
      : (normalizeHiringScope(rawScope) || normalizeHiringScope(control.config.hiringScope))
    const hasCustomKeywords = cleanKeywords.length > 0
    const core = hasCustomKeywords ? null : await store.summary()
    const latestControl = getControl()
    const primaryResume = core ? resumeFor(core.resumes, undefined, core.defaultMasterTrackId) : null
    const primaryResumeText = String(primaryResume?.text || '').slice(0, 3000)
    const rawGoal = hasCustomKeywords
      ? (effectiveScope === 'campus' ? `${cleanKeywords[0]} 校招` : cleanKeywords[0])
      : String(latestControl.config.goal || '')
    const goal = rawScope === 'experienced'
      ? `${rawGoal} 不要实习 不要校招`.trim()
      : rawGoal
    const patrolProfile = buildPatrolSearchProfile({
      resumeText: primaryResumeText,
      goal,
      searchTerms: hasCustomKeywords ? cleanKeywords : latestControl.config.searchTerms,
      evidence: core ? core.evidence : [],
      feedback: hasCustomKeywords ? {} : (latestControl.jobFeedback ?? {}),
    })
    if (effectiveScope === 'campus' || rawScope === 'both') {
      patrolProfile.wantsIntern = true
      patrolProfile.avoidHints = (patrolProfile.avoidHints || []).filter(a => !/实习|校招|应届|intern|campus|new\s*grad|graduate/i.test(a))
    }
    const hasProfile = Boolean(patrolProfile.expandedQueries.length || patrolProfile.resumeKeywords?.length || primaryResumeText)
    return { core, patrolProfile, hasProfile, effectiveScope }
  }

  async function discoverCompanies(rawQuery, model, operationId, locale, explicitScope) {
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    const tracker = createActivityTracker(operationId, 'discover-companies')
    try {
      const controlStart = getControl()
      const query = string(rawQuery || controlStart.config.goal || controlStart.config.searchTerms.join(' '), 500, '目标公司需求')
      const requestedScope = normalizeHiringScope(explicitScope) || normalizeHiringScope(controlStart.config.hiringScope)
      const queryScopes = hiringScopesFromText(query)
      const effectiveScopes = queryScopes.length
        ? queryScopes
        : (['experienced', 'campus'].includes(requestedScope) ? [requestedScope] : [])
      const scopeHintIntent = queryScopes.length
        ? query
        : (effectiveScopes[0] === 'campus' ? `${query} 校招` : effectiveScopes[0] === 'experienced' ? `${query} 社招` : query)
      const core = await store.summary()
      const resolvedModel = (typeof model === 'string' && model.trim()) || await defaultModelRoute()
      if (!resolvedModel) throw new Error(isEn ? 'Please configure at least one model in DeepSeek Harness settings.' : '请在 DeepSeek Harness 设置中添加至少一个可用模型。')
      const baseId = resumeFor(core.resumes, undefined, core.defaultMasterTrackId)?.id
      const resumeText = baseId ? (await store.exportResume(baseId).catch(() => '')).slice(0, 4000) : ''
      const atRevision = getRevision()
      const control = getControl()
      const config = llmCallConfig(control.config, resolvedModel, { sendToModel: true })
      tracker.update('matching', {
        model: shortModelName(resolvedModel),
        sources: [`${isEn ? 'Query: ' : '需求：'}${query.slice(0, 22)}`, ...(resumeText ? [isEn ? 'Approved Resume' : '已定稿简历'] : [])],
        detail: isEn ? 'Finding matching companies and official domains by track & location…' : '正在按赛道与城市筛选匹配公司及官网域名…',
      })
      const output = await modelJson(ctx.llm, config, `你是候选人的职业经纪人，根据候选人的真实方向、简历背景与行业诉求推荐 6-8 家真实存在的目标公司。
严格约束：
1. 绝不套用固定行业模板，也不盲目只推互联网大厂！严格按候选人的真实行业、城市、职能与简历背景推荐对应赛道的优质公司。
2. 每家公司必须给出真实准确的官网主域名 domain（用于自动拉取官方 LOGO），绝不编造虚假域名。
3. 同一家公司可有独立的社招（experienced）和校招（campus）入口。按用户的招聘类型选择对应入口。如确知其公开 ATS 招聘板（如 *.jobs.feishu.cn、job-boards.greenhouse.io/slug、jobs.ashbyhq.com/slug、jobs.lever.co/slug、Moka 项目或官方社招页），填入 careersUrl、provider 与 slug；不确定 ATS slug 时只填官网或招聘主页 HTTPS 链接，不要乱编 slug。
输出 JSON：{"companies":[{"company":"公司名称","domain":"official-domain.com","industry":"赛道标签(2-8字)","location":"主要城市或Remote","reason":"结合用户简历与需求的1句话推荐理由","careersUrl":"https://...","provider":"公开目录中的 provider 或空字符串","slug":""}]}

${uiLanguageDirective(loc)}`, {
        query,
        goal: control.config.goal,
        ...(requestedScope ? { hiringScope: requestedScope } : {}),
        searchTerms: control.config.searchTerms,
        existingBoards: control.config.boards.map(b => b.company || b.slug),
        verifiedCatalog: CURATED_COMPANIES.flatMap(b => companyHiringBoards(b, effectiveScopes)).map(b => [isEn ? b.companyEn || b.company : b.company, boardPosition(b, loc), b.region, ...(b.hiringScope ? [b.hiringScope] : [])]),
        candidateResume: resumeText,
      }, undefined, {
        onProgress: ({ text: raw, reasoning, chars, reasoningChars }) => {
          const foundCount = (raw.match(/"company"\s*:/gu) || []).length
          tracker.update('matching', {
            chars, reasoningChars,
            detail: foundCount > 0
              ? (isEn ? `Shortlisted ${foundCount} companies, verifying domains & careers pages…` : `已筛选 ${foundCount} 家候选公司，核对官网域名与招聘页…`)
              : (isEn ? 'Analyzing industry tracks and target companies…' : '正在分析行业赛道与候选目标公司…'),
            preview: extractReadableExcerpt(raw, reasoning, loc),
          })
        },
      })

      const rawList = Array.isArray(output?.companies) ? output.companies : []
      const seen = new Set()
      const candidates = []
      for (const row of rawList.slice(0, 10)) {
        const company = modelText(row?.company, 80)
        if (!company || seen.has(company.toLowerCase())) continue
        seen.add(company.toLowerCase())
        let careersUrl = ''
        if (typeof row?.careersUrl === 'string' && row.careersUrl.trim().startsWith('https://')) {
          try {
            const parsed = new URL(row.careersUrl.trim())
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) careersUrl = parsed.href
          } catch {}
        }
        const board = inferBoardFromCareersUrl(careersUrl, row?.provider, row?.slug, company, scopeHintIntent)
        const preset = board && CURATED_BOARDS.find(b => b.provider === board.provider && b.slug === board.slug)
        if (preset) careersUrl = 'https://' + preset.host
        else {
          const named = findNamedCompanyBoards(company)[0]
          if (named && effectiveScopes.length && !companyHiringBoards(named, effectiveScopes).length)
            careersUrl = named.manualHiring?.[effectiveScopes[0]] || 'https://' + named.host
        }
        const domain = preset?.domain || resolveCompanyDomain({ domain: row?.domain, company, slug: row?.slug, url: careersUrl })
        candidates.push({
          company,
          domain,
          industry: modelText(row?.industry, 32, isEn ? 'Target Track' : '目标赛道'),
          location: modelText(row?.location, 48),
          reason: modelText(row?.reason, 200),
          careersUrl: careersUrl || (domain ? `https://${domain}` : ''),
          provider: board?.provider || '',
          slug: board?.slug || '',
          verified: false,
          jobCount: 0,
        })
      }

      // Best-effort bounded homepage probe (max 4 non-ATS companies, 3s hard timeout) to discover hosted ATS portals or real /careers links
      const probeTargets = candidates.filter(c => !c.provider && (c.careersUrl || c.domain)).slice(0, 4)
      if (probeTargets.length > 0) {
        await Promise.allSettled(probeTargets.map(async item => {
          const probed = await probeCompanyCareersTarget({ company: item.company, domain: item.domain, careersUrl: item.careersUrl })
          if (probed.atsBoard) {
            item.provider = probed.atsBoard.provider
            item.slug = probed.atsBoard.slug
            if (probed.careersUrl) item.careersUrl = probed.careersUrl
          } else if (probed.careersUrl) {
            item.careersUrl = probed.careersUrl
          }
        }))
      }

      // Live-verify supported ATS boards (honest status, never fake working boards); logos load on demand via CompanyAvatar
      const boardCandidates = candidates.filter(c => c.provider && c.slug).slice(0, 8)
      tracker.update('verifying', {
        detail: boardCandidates.length > 0
          ? (isEn
              ? `Verifying ${boardCandidates.length} public ${boardCandidates.length === 1 ? 'job board' : 'job boards'}…`
              : `正在核验 ${boardCandidates.length} 家公开招聘板…`)
          : (isEn
              ? `Organizing ${candidates.length} discovered companies (no public boards to verify)…`
              : `正在整理 ${candidates.length} 家候选公司（无公开招聘板需核验）…`),
      })
      const currentControl = getControl()
      const filteredDiscoverKeywords = buildPatrolSearchProfile({
        goal: currentControl.config.goal,
        searchTerms: currentControl.config.searchTerms,
      }).expandedQueries
      const scanRes = boardCandidates.length > 0
        ? await collectOpportunities(
            boardCandidates.map(c => ({ provider: c.provider, slug: c.slug, company: c.company, domain: c.domain })),
            { keywords: filteredDiscoverKeywords },
          ).catch(() => ({ results: [] }))
        : { results: [] }
      const scanMap = new Map((scanRes?.results ?? []).map(r => [r.sourceId, r]))
      for (const item of candidates) {
        if (!item.provider || !item.slug) continue
        const key = `${item.provider}:${item.slug.toLowerCase()}`
        const probe = scanMap.get(key)
        if (probe?.status === 'ok' && probe.count > 0) {
          item.verified = true
          item.jobCount = probe.count
        } else if (!(probe?.status === 'ok' && findCompanyBoard(item.provider, item.slug))) {
          item.provider = ''
          item.slug = ''
          item.verified = false
        }
      }

      const record = { query, updatedAt: new Date().toISOString(), items: candidates }
      const saved = await exclusive(async () => {
        if (isClosed() || atRevision !== getRevision()) throw new Error(isEn ? 'Career settings changed; please rediscover companies.' : '求职设置已变化，请重新发现公司。')
        await commit(next => { next.discoveredCompanies = record })
        publish('companies.discovered', { count: candidates.length })
        return record
      })
      tracker.update('ready', { detail: isEn ? `Prepared ${candidates.length} target companies & official logos` : `已整理 ${candidates.length} 家目标公司与官方 LOGO` })
      return saved
    } catch (error) {
      tracker.update('error', { error: error?.message || (isEn ? 'Company discovery failed' : '寻找公司失败') })
      throw error
    }
  }

  async function suggestDiscoveryDirections(input = {}, signal, locale) {
    const loc = normalizeLocale(locale || activeLocale(null, input), 'zh')
    const isEn = loc === 'en'
    const core = await store.summary()
    const control = getControl()
    const goal = (typeof input?.goal === 'string' && input.goal.trim())
      ? input.goal.trim().slice(0, 400)
      : (control.config.goal || '').trim()
    const searchTerms = Array.isArray(input?.searchTerms)
      ? input.searchTerms.map(t => String(t || '').trim()).filter(Boolean).slice(0, 24)
      : (control.config.searchTerms ?? [])
    const dismissedTerms = Array.isArray(input?.dismissedTerms)
      ? input.dismissedTerms.map(t => String(t || '').trim()).filter(Boolean).slice(0, 48)
      : (control.config.dismissedTerms ?? [])
    const boards = Array.isArray(input?.boards)
      ? input.boards.map(b => String(b?.company || b?.slug || '').trim()).filter(Boolean).slice(0, 20)
      : (control.config.boards ?? []).map(b => b.company || b.slug).filter(Boolean)
    const baseRow = resumeFor(core.resumes, undefined, core.defaultMasterTrackId)
    const resumeText = baseRow ? (await store.exportResume(baseRow.id).catch(() => '')).slice(0, 3200) : ''
    // Strict privacy boundary: NEVER send private (`shareable !== true`) or pending/unapproved evidence to the model.
    const usedEvidence = (core.evidence ?? [])
      .filter(isShareableEvidence)
      .slice(-10)
    const evidenceItems = usedEvidence.map(e => ({ title: e.title, summary: e.summary }))
    const latestControl = getControl()
    const trackedJobs = (latestControl.opportunities ?? [])
      .filter(j => j && !j.closedAt)
      .slice(0, 8)
      .map(j => `${j.company} · ${j.title}${j.location ? ` (${j.location})` : ''}`)

    const hasProfile = Boolean(goal || searchTerms.length || resumeText || evidenceItems.length || boards.length || trackedJobs.length)
    const fingerprint = createHash('sha256').update(JSON.stringify({
      v: 2,
      locale: loc,
      goal,
      searchTerms: [...searchTerms].sort(),
      dismissedTerms: [...dismissedTerms].sort(),
      boards: [...boards].sort(),
      resumeId: baseRow?.id || '',
      resumeLen: resumeText.length,
      evidenceCount: evidenceItems.length,
      topEvidence: evidenceItems.slice(-4).map(e => e.title),
      topJobs: trackedJobs.slice(0, 4),
    })).digest('hex').slice(0, 16)

    if (!hasProfile) {
      return { fingerprint, hasProfile: false, directions: [], keywords: [], updatedAt: new Date().toISOString() }
    }
    const force = input?.force === true
    const cached = latestControl.discoveryDirections
    if (!force && cached && cached.fingerprint === fingerprint && (Array.isArray(cached.directions) && cached.directions.length > 0 || Array.isArray(cached.keywords) && cached.keywords.length > 0)) {
      return cached
    }
    if (latestControl.config.sendToModel !== true && input?.explicitInteractive !== true) {
      return { fingerprint, hasProfile: true, directions: [], keywords: [], updatedAt: new Date().toISOString() }
    }

    const resolvedModel = latestControl.config.tabModel
      || (typeof input?.model === 'string' && input.model.trim())
      || await defaultTabModelRoute()
      || await defaultModelRoute()
    if (!resolvedModel) {
      return { fingerprint, hasProfile: true, directions: [], keywords: [], updatedAt: new Date().toISOString() }
    }

    const previousLabels = force && Array.isArray(cached?.directions)
      ? cached.directions.map(d => d.label).filter(Boolean)
      : []
    const previousKeywords = force && Array.isArray(cached?.keywords)
      ? cached.keywords.filter(Boolean)
      : []
    const atRevision = getRevision()

    const output = await modelJson(ctx.llm, llmCallConfig(getControl().config, resolvedModel, { sendToModel: true }, { kind: 'tab' }), `你是候选人的私人职业经纪人。只根据候选人已有的真实信息（简历、工作成果、求职目标、已选画像词、已关注公司与岗位），为其动态延展 4 个个性化的「目标公司探索方向」和 6–8 个「同工种画像词建议」。
严格规则：
1. 千人千面，绝不套用固定行业模板！每一个方向与关键词都必须直接源于候选人的真实求职目标、已选 searchTerms、简历与工作成果，绝不推荐无关工种。
2. 4 个方向保持层次：2 个贴近当前核心优势的精准延展 + 2 个基于底层能力可自然跨出的高价值相邻细分方向。
3. 每个方向包含：
   - label：${isEn ? '2–3 concise words (<= 24 chars) compact pill label so all 4 pills fit on one line' : '3–6 个中文字（或等价短词）的极简胶囊标签，确保 4 个胶囊能在单行内完整展示'}；
   - query：${isEn ? '8–20 word company discovery query' : '12–36 字的完整找公司检索句（可直接传给「AI 找公司」）'}；
   - basis：${isEn ? '1 concise provenance sentence (e.g., "Based on your observability & cloud-native architecture work")' : '一句 10–24 字的出处说明（例如「基于你的可观测平台与云原生架构经历」）'}。
4. keywords：6–8 个严格锚定候选人已有 goal 与 searchTerms 的同工种精准补充词（中英文常见别名、简称、官网职位常见写法或该工种直接核心技能词）。严禁把辅修修饰词或通用工具词（如 AI、Python、工作流、工具链、平台）发散成其它独立工种（例如用户找「技术美术 / AI 3D / UE5」，绝不能推荐「Agent」「大模型应用」「AI平台」「智能体」「LLM算法」等无关方向）。必须排除已有 searchTerms 与已忽略的 dismissedTerms。
${previousLabels.length || previousKeywords.length ? `5. 用户点击了「换一批」，请换一组不同于 [${[...previousLabels, ...previousKeywords].slice(0, 12).join('、')}] 的新延展角度与补充词。` : ''}
只输出 JSON：{"directions":[{"label":"...","query":"...","basis":"..."}],"keywords":["..."]}

${uiLanguageDirective(loc)}`, {
      goal,
      searchTerms,
      dismissedTerms,
      subscribedCompanies: boards,
      trackedJobs,
      workEvidence: evidenceItems,
      resumeExcerpt: resumeText,
    }, signal)

    const seenLabels = new Set()
    const directions = []
    for (const row of (Array.isArray(output?.directions) ? output.directions : []).slice(0, 6)) {
      const label = modelText(row?.label, isEn ? 28 : 16).replace(/[\r\n]+/gu, ' ').trim()
      const query = modelText(row?.query, 140).replace(/[\r\n]+/gu, ' ').trim()
      const basis = modelText(row?.basis, 100).replace(/[\r\n]+/gu, ' ').trim()
      if (!label || !query || seenLabels.has(label.toLowerCase())) continue
      seenLabels.add(label.toLowerCase())
      directions.push({ label, query, basis })
      if (directions.length >= 4) break
    }
    const avoidHints = buildPatrolSearchProfile({ goal, searchTerms }).avoidHints
    const termSet = new Set([...searchTerms, ...dismissedTerms, ...avoidHints].map(t => t.toLowerCase()))
    const keywords = []
    for (const rawKw of (Array.isArray(output?.keywords) ? output.keywords : []).slice(0, 12)) {
      const kw = modelText(rawKw, 32).replace(/[\r\n]+/gu, ' ').trim()
      const kwLow = kw.toLowerCase()
      if (!kw || termSet.has(kwLow) || avoidHints.some(a => kwLow.includes(String(a).toLowerCase())) || keywords.some(x => x.toLowerCase() === kwLow)) continue
      keywords.push(kw)
      if (keywords.length >= 8) break
    }

    const resumeLinkedEvIds = baseRow?.id ? [...resumeEvidenceIds(core.resumes, baseRow.id)] : []
    const evById = new Map((core.evidence ?? []).map(e => [e.id, e]))
    const usedEvidenceIds = [...new Set([...usedEvidence.map(e => e.id), ...resumeLinkedEvIds])]
    const usedSourceIds = [...new Set([
      ...usedEvidence.map(e => e.sourceId).filter(Boolean),
      ...resumeLinkedEvIds.map(eid => evById.get(eid)?.sourceId).filter(Boolean),
      ...(baseRow?.sourceIds ?? []),
    ])]
    const record = {
      fingerprint,
      goal,
      hasProfile: true,
      directions,
      keywords,
      provenance: {
        resumeId: baseRow?.id || '',
        evidenceIds: usedEvidenceIds,
        sourceIds: usedSourceIds,
      },
      updatedAt: new Date().toISOString(),
    }
    const matchesSavedConfig = () => {
      const ctrl = getControl()
      return goal === (ctrl.config.goal || '').trim()
        && JSON.stringify([...searchTerms].sort()) === JSON.stringify([...(ctrl.config.searchTerms ?? [])].sort())
    }
    if (matchesSavedConfig() && (directions.length > 0 || keywords.length > 0)) {
      await exclusive(async () => {
        if (isClosed() || atRevision !== getRevision() || !matchesSavedConfig()) return
        await commit(next => { next.discoveryDirections = record })
      }).catch(() => {})
    }
    return record
  }

  async function searchCompanyJobs(input, locale) {
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    const previewOnly = input?.previewOnly === true
    const tracker = createActivityTracker(input?.operationId, 'company-jobs')
    try {
      const control = getControl()
      const company = string(input?.company, 120, '公司名称')
      const domain = resolveCompanyDomain({ domain: input?.domain, company, url: input?.careersUrl })
      const careersUrl = typeof input?.careersUrl === 'string' && input.careersUrl.trim().startsWith('https://')
        ? input.careersUrl.trim().slice(0, 500) : (domain ? `https://${domain}` : '')
      const intent = control.discoveredCompanies?.items?.some(item => item.company === company) ? control.discoveredCompanies.query : ''
      const configuredScope = normalizeHiringScope(input?.hiringScope) || normalizeHiringScope(control.config.hiringScope)
      const intentScopes = hiringScopesFromText(intent)
      const scopes = intentScopes.length
        ? intentScopes
        : (['experienced', 'campus'].includes(configuredScope) ? [configuredScope] : [])
      const scopeIntent = intentScopes.length
        ? intent
        : (scopes[0] === 'campus' ? `${intent} 校招`.trim() : scopes[0] === 'experienced' ? `${intent} 社招`.trim() : intent)
      const board = inferBoardFromCareersUrl(careersUrl, input?.provider, input?.slug, company, scopeIntent)
      const named = findNamedCompanyBoards(company)[0]
      if (!board && named && scopes.length && !companyHiringBoards(named, scopes).length) {
        tracker.update('ready', { detail: isEn ? 'Check the company’s careers site for this hiring channel.' : '该招聘渠道暂需到公司官网核对。' })
        return { previewOnly, imported: 0, source: 'official', company, careersUrl, candidates: [] }
      }
      const atRevision = getRevision()
      const { patrolProfile, hasProfile } = await loadCompanyMatchContext(scopes.length === 1 ? scopes[0] : '')
      const filteredCompanyKeywords = patrolProfile.expandedQueries

      // Path 1: Direct verified public ATS board — real structured JDs!
      if (board) {
        const source = validateBoardSource({ ...board, company, ...(domain ? { domain } : {}) })
        tracker.update('matching', {
          sources: [isEn ? `${company} public board` : `${company} 公开招聘板`],
          detail: isEn ? `Fetching & matching live openings from ${company}'s public board…` : `正在直连 ${company} 公开招聘接口并按你的方向筛选…`,
        })
        const collected = await collectOpportunities([source], { keywords: filteredCompanyKeywords })
        const res = collected.results?.[0]
        if (res?.status === 'ok' && collected.opportunities.length > 0) {
          const { kept, filteredOut, byId } = filterAndRankCompanyCandidates(collected.opportunities, patrolProfile, hasProfile, loc, 10)
          if (previewOnly) {
            const needHydrateCount = kept.filter(job => isOpportunityJdIncomplete(job)).slice(0, 6).length
            if (needHydrateCount > 0) {
              tracker.update('verifying', {
                detail: isEn ? `Loading full JDs for ${needHydrateCount} matched roles…` : `正在补全 ${needHydrateCount} 个匹配岗位的完整 JD…`,
              })
            }
            const previewList = await hydrateAndSerializeCandidates(kept, byId, company, board.provider)
            tracker.update('ready', {
              detail: previewList.length > 0
                ? (isEn ? `Found ${previewList.length} matching openings to review` : `筛选出 ${previewList.length} 个对口岗位，请在卡片内勾选导入`)
                : (isEn ? `Found ${collected.opportunities.length} openings, none aligned with your target` : `共 ${collected.opportunities.length} 个公开岗，均与当前方向不符`),
            })
            return {
              previewOnly: true,
              imported: 0,
              source: previewList.length ? 'ats' : 'filtered',
              company,
              careersUrl,
              totalFound: collected.opportunities.length,
              filteredOut,
              candidates: previewList,
              ...(previewList.length ? {} : {
                reason: isEn
                  ? `Found ${collected.opportunities.length} public roles at ${company}, but none matched your resume or target role.`
                  : `在「${company}」共检出 ${collected.opportunities.length} 个公开岗位，但均与你当前简历和求职方向不对口，未直接导入。`,
              }),
            }
          }
          const toCommit = kept.length > 0 ? kept : (hasProfile ? [] : collected.opportunities)
          if (toCommit.length > 0) {
            const id = boardSourceId(source)
            await exclusive(async () => {
              if (isClosed() || atRevision !== getRevision()) return
              await commit(next => {
                // One-off company job fetch MUST NOT subscribe the company to config.boards
                // or alter watch schedule. Tag jobs from unsubscribed boards with oneOff: true
                // so they remain visible in the job list until explicitly subscribed or closed.
                const alreadySubscribed = next.config.boards.some(b => boardSourceId(b) === id)
                const tagged = alreadySubscribed
                  ? toCommit
                  : toCommit.map(job => ({ ...job, oneOff: true }))
                const merged = mergeBoards(next, { ...collected, results: [], opportunities: tagged })
                if (merged.jdChanged) triage.resetCooldown()
              })
              publish('opportunities.updated', { count: toCommit.length })
            })
          }
          tracker.update('ready', { detail: isEn ? `Imported ${toCommit.length} public openings` : `已直连拉取 ${toCommit.length} 个公开岗位` })
          return { previewOnly: false, imported: toCommit.length, source: 'ats', company }
        }
      }

      if (board && (scopes.length || CURATED_BOARDS.find(b => b.provider === board.provider && b.slug === board.slug)?.hiringScope === 'campus')) {
        tracker.update('ready', { detail: isEn ? 'No verified matches in this hiring channel.' : '这个招聘渠道本次没有已核实的匹配岗位。' })
        return { previewOnly, imported: 0, source: 'ats', company, careersUrl, candidates: [] }
      }

      // Path 2: Non-ATS company — DSH web.search + strict relevance filter + real JD hydration
      const web = optionalService('web')
      const resolvedModel = (typeof input?.model === 'string' && input.model.trim()) || await defaultModelRoute()
      const terms = filteredCompanyKeywords.slice(0, 4).join(' ')
      const resumeHints = (patrolProfile.resumeKeywords ?? []).slice(0, 12)
      let webSnippets = []
      if (web && typeof web.search === 'function') {
        tracker.update('matching', {
          model: shortModelName(resolvedModel),
          sources: [company, ...(domain ? [domain] : []), ...(terms ? [terms] : [])],
          detail: isEn ? `Searching open roles at "${company}" matching your direction…` : `正在检索「${company}」与你求职方向匹配的在招岗位…`,
        })
        try {
          const isCnCompany = /[\u4e00-\u9fff]/u.test(company)
          const query = isEn && !isCnCompany
            ? `${company} careers ${terms || 'engineer'} ${domain ? `site:${domain} OR ` : ''}jobs`
            : `${company} 招聘 ${terms || '工程师'} ${domain ? `site:${domain} OR ` : ''}岗位`
          const resp = await web.search({
            query,
            maxResults: 12,
            ...(resolvedModel ? { llmProvider: modelRoute(resolvedModel).provider } : {}),
          }, AbortSignal.timeout(15_000))
          webSnippets = (resp?.sources ?? []).slice(0, 10).map(s => ({
            title: String(s?.title || '').slice(0, 180),
            url: String(s?.url || '').slice(0, 400),
            snippet: String(s?.snippet || s?.content || '').slice(0, 420),
          })).filter(s => s.url.startsWith('https://'))
        } catch {}
      }

      if (webSnippets.length > 0 && resolvedModel) {
        tracker.update('verifying', {
          detail: isEn ? `Filtering & fetching full JDs from ${webSnippets.length} pages…` : `正在按履历过滤并补全 ${webSnippets.length} 条搜索结果的真实 JD…`,
        })
        const latestControl = getControl()
        const config = llmCallConfig(latestControl.config, resolvedModel, { sendToModel: true })
        const output = await modelJson(ctx.llm, config, `你从给定的真实网页搜索结果中提取属于「${company}」且与候选人求职方向高度匹配的公开在招岗位。
严格约束：
1. 只能提取搜索结果中真实出现过的岗位与对应 HTTPS 链接，绝不允许编造不存在的岗位、要求或链接！
2. 必须结合候选人的求职目标、关键词与简历技术栈过滤掉职能明显不对口的岗位（例如候选人是研发/架构/Infra 方向时，必须剔除渠道经理、销售、售前技术顾问、非技术产品经理、客服、行政、HR 等职能不对口的岗位；若均不对口，返回 {"jobs":[]}）。
3. 如果搜索结果只是公司主页/新闻/泛介绍而无具体职位名称，返回 {"jobs":[]}。
输出 JSON：{"jobs":[{"title":"具体岗位名称","location":"城市(无则空)","url":"搜索结果中的真实https链接","jd":"搜索结果中出现的相关职责与要求原文摘要"}]}

${uiLanguageDirective(loc)}`, {
          company,
          candidateGoal: String(latestControl.config.goal || '').trim(),
          searchTerms: filteredCompanyKeywords.slice(0, 8),
          resumeKeywords: resumeHints,
          results: webSnippets,
        })
        const validUrls = new Set(webSnippets.map(s => s.url))
        const seenTitles = new Set()
        const rawExtracted = (Array.isArray(output?.jobs) ? output.jobs : [])
          .map(row => ({
            title: modelText(row?.title, 160),
            location: modelText(row?.location, 80),
            url: typeof row?.url === 'string' && validUrls.has(row.url.trim()) ? row.url.trim() : careersUrl,
            jd: modelText(row?.jd, 4000),
          }))
          .filter(row => {
            if (row.title.length < 2) return false
            const tKey = row.title.toLowerCase()
            if (seenTitles.has(tKey)) return false
            seenTitles.add(tKey)
            return true
          })
          .slice(0, 8)

        const hydratedWebJobs = await Promise.all(rawExtracted.map(async (row, idx) => {
          const fetchedJd = await fetchPublicJobPageText(row.url, web)
          const bestJd = fetchedJd.length >= 100 && fetchedJd.length > row.jd.length ? fetchedJd : row.jd
          return {
            id: `web-${idx}`,
            company,
            title: row.title,
            location: row.location,
            url: row.url,
            jd: bestJd,
            jdPreview: bestJd.length < 100,
          }
        }))

        const { kept, filteredOut, byId } = filterAndRankCompanyCandidates(hydratedWebJobs, patrolProfile, hasProfile, loc, 8)

        if (previewOnly) {
          const previewList = kept.map(job => serializePreviewCandidate(job, byId.get(job.id), company, domain || ''))
          const emptyFiltered = rawExtracted.length > 0 && previewList.length === 0
          tracker.update('ready', {
            detail: previewList.length > 0
              ? (isEn ? `Found ${previewList.length} matched roles for preview` : `筛选出 ${previewList.length} 个匹配岗位，勾选即可导入`)
              : (isEn ? 'No matching roles found on public search; use DSH Computer Use for full site hunt' : '公开网页中暂无匹配岗位，建议直接点「用 DSH 去官网找岗」'),
          })
          return {
            previewOnly: true,
            imported: 0,
            source: previewList.length ? 'web' : (emptyFiltered ? 'filtered' : 'none'),
            company,
            careersUrl,
            totalFound: rawExtracted.length,
            filteredOut,
            candidates: previewList,
            ...(previewList.length ? {} : {
              reason: emptyFiltered
                ? (isEn
                  ? `Found ${rawExtracted.length} public roles at ${company}, but filtered them out because they didn't fit your resume or target role. Use "Hunt on site with DSH" to search inside ${company}'s careers portal.`
                  : `网上搜到「${company}」的 ${rawExtracted.length} 个公开岗位，但均与你当前简历和求职方向不对口已自动过滤。建议直接点击「用 DSH 去官网找岗」进入官网精准搜索。`)
                : (isEn
                  ? `No verified open role pages matched your direction at "${company}". Use "Hunt on site with DSH" to browse ${company}'s portal directly.`
                  : `公开搜索未找到「${company}」与你方向匹配的具体岗位详情页，建议直接点「用 DSH 去官网找岗」去官网筛选抓取。`),
            }),
          }
        }

        if (kept.length > 0) {
          let added = 0
          await exclusive(async () => {
            if (isClosed() || atRevision !== getRevision()) return
            await commit(next => {
              const existingKeys = new Set(next.opportunities.map(o => `${(o.company || '').toLowerCase()}::${(o.title || '').toLowerCase()}`))
              for (const row of kept) {
                const key = `${company.toLowerCase()}::${row.title.toLowerCase()}`
                if (existingKeys.has(key)) continue
                existingKeys.add(key)
                const { job, prior } = buildManualOpportunityRecord({
                  company, title: row.title, location: row.location, url: row.url, jd: row.jd,
                }, next.opportunities)
                if (!prior) {
                  next.opportunities.push(job)
                  added += 1
                }
              }
            })
            if (added > 0) publish('opportunities.updated', { count: added })
          })
          tracker.update('ready', { detail: isEn ? `Added ${added} open roles` : `已入库 ${added} 个在招岗位` })
          return { previewOnly: false, imported: added, matched: kept.length, source: 'web', company }
        }
      }

      tracker.update('ready', { detail: isEn ? 'No standard public ATS board detected; use DSH to hunt on their site or paste a JD' : '该司未开放标准 ATS 接口，推荐直接让 DSH 去官网找岗' })
      return {
        previewOnly,
        imported: 0,
        source: 'none',
        company,
        careersUrl,
        totalFound: 0,
        filteredOut: 0,
        candidates: [],
        reason: isEn
          ? `"${company}" uses a custom or login-gated careers site without a standard public ATS feed. Click "Hunt on site with DSH" to let Computer Use search & filter full JDs on their site, or paste a JD manually.`
          : `「${company}」使用自研或需登录的招聘官网（未开放标准 ATS 接口），推荐点「用 DSH 去官网找岗」让桌面助手直接进官网搜索完整 JD，或点「+ 手动录入岗位」粘贴入库。`,
      }
    } catch (error) {
      tracker.update('error', { error: error?.message || (isEn ? 'Failed to fetch openings' : '抓取岗位失败') })
      throw error
    }
  }

  async function resolveCompanyTarget(input, locale) {
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    const control = getControl()
    const company = string(input?.company, 120, '公司名称')
    const domain = resolveCompanyDomain({ domain: input?.domain, company, url: input?.careersUrl })
    let careersUrl = isSafePublicJobPageUrl(input?.careersUrl, { allowRoot: true }) || (domain ? `https://${domain}` : '')
    const configuredScope = normalizeHiringScope(input?.hiringScope) || normalizeHiringScope(control.config.hiringScope)
    const scopeHint = configuredScope === 'campus' ? `${company} 校招` : configuredScope === 'experienced' ? `${company} 社招` : company

    let board = inferBoardFromCareersUrl(careersUrl, input?.provider, input?.slug, company, scopeHint)
    if (board) {
      const preset = CURATED_BOARDS.find(b => b.provider === board.provider && b.slug === board.slug)
      if (preset?.host) careersUrl = `https://${preset.host}`
    } else {
      const probed = await probeCompanyCareersTarget({ company, domain, careersUrl }).catch(() => ({ atsBoard: null, careersUrl: '' }))
      if (probed.atsBoard) {
        board = probed.atsBoard
        if (probed.careersUrl) careersUrl = probed.careersUrl
      } else if (probed.careersUrl) {
        careersUrl = probed.careersUrl
      }
    }

    if (board) {
      try {
        const source = validateBoardSource({ ...board, company, ...(domain ? { domain } : {}) })
        const { patrolProfile, hasProfile } = await loadCompanyMatchContext(configuredScope)
        let collected = await Promise.race([
          collectOpportunities([source], { keywords: patrolProfile.expandedQueries }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
        ])
        if (collected?.results?.[0]?.status === 'ok' && collected.opportunities.length === 0 && patrolProfile.expandedQueries.length > 0) {
          collected = await Promise.race([
            collectOpportunities([source], { keywords: [] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
          ])
        }
        const probeRes = collected?.results?.[0]
        if (probeRes?.status === 'ok' && collected.opportunities.length > 0) {
          const { kept, filteredOut, byId } = filterAndRankCompanyCandidates(collected.opportunities, patrolProfile, hasProfile, loc, 10)
          const previewList = await hydrateAndSerializeCandidates(kept, byId, company, board.provider)
          await exclusive(async () => {
            await commit(next => {
              applyDiscoveredUpgrade(next, {
                company,
                provider: board.provider,
                slug: board.slug,
                careersUrl,
                verified: true,
                jobCount: collected.opportunities.length,
              })
            })
          }).catch(() => {})
          return {
            resolvedMode: 'ats',
            company,
            provider: board.provider,
            slug: board.slug,
            careersUrl,
            totalFound: collected.opportunities.length,
            filteredOut,
            candidates: previewList,
            ...(previewList.length ? {} : {
              reason: isEn
                ? `Connected directly to ${company}'s ${board.provider} board (${collected.opportunities.length} roles), but none matched your resume or target direction.`
                : `已识别并直连「${company}」的 ${board.provider} 招聘板（共 ${collected.opportunities.length} 岗），但均与你当前简历和求职方向不对口，未直接导入。`,
            }),
          }
        }
      } catch {}
    }

    return {
      resolvedMode: 'cua',
      company,
      careersUrl,
      domain,
    }
  }

  async function registerAtsBoardFromAgent({ url = '', company = '', hiringScope = '', keywords = [], subscribe = false, limit = 6 } = {}, locale = '') {
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    const maxStage = Math.min(10, Math.max(1, Math.floor(Number(limit) || 6)))
    const cleanUrl = isSafePublicJobPageUrl(url, { allowRoot: true })
    const parsed = cleanUrl ? parseBoardInput(cleanUrl) : null
    if (!parsed) {
      return {
        supported: false,
        verified: false,
        stagedCount: 0,
        nextAction: 'continue_cua',
        message: isEn
          ? 'This URL is not a directly supported hosted ATS board; continue browsing with CUA.'
          : '该链接不属于牛马经纪人原生直连的托管招聘平台，请继续使用 CUA 浏览提取。',
      }
    }
    const boardName = parsed.company && parsed.company !== parsed.slug ? parsed.company : (String(company || '').trim() || parsed.company || parsed.slug)
    const domain = parsed.domain || resolveCompanyDomain({ company: boardName, url: cleanUrl })
    try {
      const source = validateBoardSource({ provider: parsed.provider, slug: parsed.slug, company: boardName, ...(domain ? { domain } : {}) })
      const { patrolProfile, hasProfile, effectiveScope } = await loadCompanyMatchContext(hiringScope, keywords)
      let collected = await Promise.race([
        collectOpportunities([source], { keywords: patrolProfile.expandedQueries }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12_000)),
      ])
      if (collected?.results?.[0]?.status === 'ok' && collected.opportunities.length === 0 && patrolProfile.expandedQueries.length > 0) {
        collected = await Promise.race([
          collectOpportunities([source], { keywords: [] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12_000)),
        ])
      }
      const probeRes = collected?.results?.[0]
      if (probeRes?.status !== 'ok' || collected.opportunities.length === 0) {
        return {
          supported: true,
          verified: false,
          stagedCount: 0,
          nextAction: 'continue_cua',
          message: isEn
            ? `Recognized ${parsed.provider} host, but public API returned no openings; continue reading visible postings with CUA.`
            : `识别到 ${parsed.provider} 招聘平台但公开接口未返回在招列表，请继续使用 CUA 浏览当前页面提取。`,
        }
      }

      const postingToken = extractAtsPostingToken(cleanUrl)
      let stagedSourceJobs = []
      if (postingToken) {
        const cleanNorm = normalizeOpportunityUrl(cleanUrl)
        const tokenLow = postingToken.toLowerCase()
        const escapedToken = tokenLow.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        const segmentRe = new RegExp(`/${escapedToken}(?:[/?#]|$)`, 'i')
        const exactJob = collected.opportunities.find(job => {
          if (cleanNorm && normalizeOpportunityUrl(job.url || '') === cleanNorm) return true
          if (job.externalId && String(job.externalId).trim().toLowerCase() === tokenLow) return true
          return Boolean(job.url && segmentRe.test(String(job.url)))
        })
        if (!exactJob) {
          return {
            supported: true,
            verified: false,
            stagedCount: 0,
            nextAction: 'continue_cua',
            message: isEn
              ? `Could not find posting "${postingToken}" in the public ${parsed.provider} feed; keep reading this posting directly with CUA and stage via career_broker_import_opportunity.`
              : `在 ${parsed.provider} 公开列表中未定位到当前具体岗位（${postingToken}），请继续直接读取当前页面并调用 career_broker_import_opportunity 暂存。`,
          }
        }
        stagedSourceJobs = [exactJob]
      }

      const CAMPUS_ROLE_RE = /校招|实习|应届|管培|毕业生|\b(?:intern(?:ship)?|campus|new\s*grad|graduate|entry[\s-]*level|university\s+grad)\b/iu
      const CAMPUS_ORG_RE = /(?:校招|校园招聘|实习生?)\s*(?:hr|招聘|负责|运营|项目|bp)|\bcampus\s+recruit/iu
      const SENIOR_ROLE_RE = /资深|高级|专家|架构师|负责人|总监|社招|\b(?:senior|sr\.?|staff|principal|lead|director|manager|head\s+of|architect)\b/iu
      let scopePool = collected.opportunities
      if (!postingToken) {
        if (effectiveScope === 'campus') {
          const knownBoard = findCompanyBoard(parsed.provider, parsed.slug)
          const campusMatches = collected.opportunities.filter(j => {
            const title = String(j?.title || '')
            return CAMPUS_ROLE_RE.test(title) && !CAMPUS_ORG_RE.test(title) && !SENIOR_ROLE_RE.test(title)
          })
          scopePool = campusMatches.length > 0
            ? campusMatches
            : (knownBoard?.hiringScope === 'campus'
                ? collected.opportunities.filter(j => !SENIOR_ROLE_RE.test(String(j?.title || '')))
                : [])
        } else if (effectiveScope === 'experienced') {
          scopePool = collected.opportunities.filter(j => {
            const title = String(j?.title || '')
            return !(CAMPUS_ROLE_RE.test(title) && !CAMPUS_ORG_RE.test(title))
          })
        }
      }
      const scopeFilteredOut = Math.max(0, collected.opportunities.length - scopePool.length)

      const rankPool = postingToken
        ? { kept: stagedSourceJobs, filteredOut: 0, byId: new Map() }
        : filterAndRankCompanyCandidates(scopePool, patrolProfile, hasProfile, loc, maxStage)
      const { kept, filteredOut: rankFilteredOut, byId } = rankPool
      const filteredOut = scopeFilteredOut + rankFilteredOut
      const hydrated = await hydrateAndSerializeCandidates(kept, byId, boardName, parsed.provider)
      const partialCount = hydrated.filter(row => row.jdPreview).length
      let stagedCount = 0
      if (hydrated.length > 0) {
        const res = await stageOpportunities(hydrated.map(row => ({
          company: row.company || boardName,
          title: row.title,
          location: row.location || '',
          url: row.url || cleanUrl,
          jd: row.jd || '',
          jdPreview: Boolean(row.jdPreview),
          detailProvider: row.provider || '',
          detailSourceId: row.sourceId || '',
          externalId: row.externalId || '',
          sourceSite: parsed.provider,
        })), { captureMode: 'ats-handover' })
        stagedCount = Number(res?.count || 0)
      }

      await exclusive(async () => {
        await commit(next => {
          applyDiscoveredUpgrade(next, {
            company: boardName,
            provider: parsed.provider,
            slug: parsed.slug,
            careersUrl: cleanUrl,
            verified: true,
            jobCount: collected.opportunities.length,
          })
          if (subscribe === true) {
            const merged = mergeSearchBoards(next.config.boards, [source])
            if (merged.length <= MAX_SOURCES) next.config.boards = merged
          }
        })
      }).catch(() => {})

      return {
        supported: true,
        verified: true,
        provider: parsed.provider,
        slug: parsed.slug,
        careersUrl: cleanUrl,
        totalFound: collected.opportunities.length,
        stagedCount,
        partialCount,
        filteredOut,
        nextAction: 'stop',
        message: stagedCount > 0
          ? (isEn
              ? `Switched to native ${parsed.provider} sync (${collected.opportunities.length} found, ${filteredOut} off-target filtered) and staged ${stagedCount} roles into Pending Import${partialCount > 0 ? ` (${partialCount} preview summary/incomplete JDs will load full details on open)` : ' with full JDs'}. Stop CUA browsing now.`
              : `已成功切换为 ${parsed.provider} 原生高速直连（共 ${collected.opportunities.length} 岗，过滤 ${filteredOut} 个不对口岗位），已将 ${stagedCount} 个岗位写入「待确认」抽屉${partialCount > 0 ? `（其中 ${partialCount} 个暂存为摘要预览，点击查看详情时会自动补全完整 JD）` : '（均已补全完整 JD）'}。nextAction=stop，请立即结束桌面浏览并向用户汇报。`)
          : (isEn
              ? `Connected to ${parsed.provider} (${collected.opportunities.length} roles), but all were filtered out as off-target for your criteria. Stop CUA browsing now.`
              : `已直连核验 ${parsed.provider} 招聘板（共 ${collected.opportunities.length} 岗），但与本次筛选方向均不对口，已过滤未写入。nextAction=stop，请结束桌面浏览并告知用户。`),
      }
    } catch {
      return {
        supported: true,
        verified: false,
        stagedCount: 0,
        nextAction: 'continue_cua',
        message: isEn
          ? 'Native ATS handover failed or timed out; continue browsing and extracting with CUA.'
          : '原生招聘接口核验超时或失败，请继续用 CUA 读取页面岗位。',
      }
    }
  }

  return {
    discoverCompanies,
    suggestDiscoveryDirections,
    searchCompanyJobs,
    resolveCompanyTarget,
    registerAtsBoardFromAgent,
  }
}
