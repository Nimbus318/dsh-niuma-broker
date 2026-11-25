import { isActualInternOrCampusOpening } from './triage-recall.mjs'

export function tierForScore(score) {
  if (score >= 78) return 'top'
  if (score >= 64) return 'good'
  if (score >= 46) return 'stretch'
  return 'skip'
}

/**
 * Deterministic industry-agnostic job triage (0ms, runs offline and as instant baseline before LLM).
 * Zero hardcoded industry buckets or asymmetric caps: weights user searchTerms + explicit goal targets
 * + dynamic resume overlap + location/avoid/feedback constraints.
 */
export function scoreOpportunityHeuristicWithDeps(job, profile, locale = 'zh', deps = {}) {
  const {
    maxJdChars = 12_000,
    hasTerm,
    isPeripheralRoleMention,
    locationMarkets = [],
    matchesCity,
    cleanStr,
    isStage0HardExcluded,
    extractFactSignals,
    jobContentFingerprint,
  } = deps

  const isEn = locale === 'en'
  const title = String(job?.title || '')
  const company = String(job?.company || '')
  const location = String(job?.location || '')
  const jd = String(job?.jd || '')
  const titleLower = title.toLowerCase()
  const locLower = location.toLowerCase()
  const jdLower = jd.slice(0, maxJdChars).toLowerCase()

  const basePts = 18
  const matchedTitleSpecific = []
  const matchedJdSpecific = []
  const matchedTitleBroad = []
  const matchedJdBroad = []
  const namedRoleTitleHits = []
  const namedRoleJdCoreHits = []
  const namedRoleJdCollabHits = []
  const skillTitleHits = []
  const skillJdHits = []
  const cautions = []
  const penaltyNotes = []

  // 1. Responsibility-first, tool-second matching (industry-agnostic, zero hardcoded buckets!):
  //    Separate named occupations (e.g. 技术美术, Compliance Analyst, 大模型推理工程师) from tool/topic terms (UE5, AI 3D, GPU).
  const groups = Array.isArray(profile.targetGroups) ? profile.targetGroups : []
  const hasRoleTargets = groups.some(g => !g.isBroad && g.isNamedRole)

  let broadScore = 0
  for (const group of groups) {
    if (group.isBroad) {
      if (hasTerm(titleLower, group.term)) {
        broadScore += 4
        matchedTitleBroad.push(group.term)
      } else if (hasTerm(jdLower, group.term)) {
        broadScore += 1.5
        matchedJdBroad.push(group.term)
      }
      continue
    }

    const titleAlias = group.aliases.find(alias => hasTerm(titleLower, alias))
    if (titleAlias) {
      if (!matchedTitleSpecific.includes(titleAlias)) matchedTitleSpecific.push(titleAlias)
      if (group.isNamedRole) {
        if (!namedRoleTitleHits.includes(titleAlias)) namedRoleTitleHits.push(titleAlias)
      } else if (!skillTitleHits.includes(titleAlias)) {
        skillTitleHits.push(titleAlias)
      }
      continue
    }
    const jdAlias = group.aliases.find(alias => hasTerm(jdLower, alias))
    if (jdAlias) {
      if (!matchedJdSpecific.includes(jdAlias)) matchedJdSpecific.push(jdAlias)
      if (group.isNamedRole) {
        if (isPeripheralRoleMention(jdLower, jdAlias)) {
          if (!namedRoleJdCollabHits.includes(jdAlias)) namedRoleJdCollabHits.push(jdAlias)
        } else if (!namedRoleJdCoreHits.includes(jdAlias)) {
          namedRoleJdCoreHits.push(jdAlias)
        }
      } else if (!skillJdHits.includes(jdAlias)) {
        skillJdHits.push(jdAlias)
      }
    }
  }

  const namedRoleJdHits = [...namedRoleJdCoreHits, ...namedRoleJdCollabHits]
  const hasPrimaryRoleFit = !hasRoleTargets || namedRoleTitleHits.length > 0 || namedRoleJdCoreHits.length > 0
  const roleOnlyCollaborative = hasRoleTargets && namedRoleTitleHits.length === 0 && namedRoleJdCoreHits.length === 0 && namedRoleJdCollabHits.length > 0

  let rolePts = 0
  let termPts = 0
  if (hasRoleTargets) {
    // Primary occupation match carries primary weight; peripheral/collaborative/qualification JD mentions get minimal credit.
    if (namedRoleTitleHits.length > 0) {
      rolePts = namedRoleTitleHits.length > 1 ? 40 : 36
    } else if (namedRoleJdCoreHits.length > 0) {
      rolePts = 14
    } else if (namedRoleJdCollabHits.length > 0) {
      rolePts = 2
    }
    // Tool / skill / topic keywords add bonus after primary responsibility is judged.
    const rawSkillPts = skillTitleHits.length * 10 + Math.min(12, skillJdHits.length * 5) + Math.min(4, broadScore)
    const skillCap = namedRoleTitleHits.length > 0 ? 22 : 14
    termPts = Math.round(Math.min(skillCap, rawSkillPts))
  } else {
    // No named occupation specified (e.g. pure stack/topic searchTerms like ["GPU", "CUDA"]):
    // user's specific searchTerms act directly as the primary target signal.
    let specificScore = 0
    if (skillTitleHits.length >= 1) specificScore += 28
    if (skillTitleHits.length >= 2) specificScore += 10
    if (skillTitleHits.length >= 3) specificScore += 6
    if (skillJdHits.length >= 1) specificScore += Math.min(14, skillJdHits.length * 6)
    termPts = Math.round(Math.min(46, specificScore + Math.min(6, broadScore)))
  }

  // 2. Dynamic Resume Keyword overlap (extracted from user's own resume & approved evidence — zero TECH_TERMS!)
  const resumeCandidates = Array.isArray(profile.resumeKeywords) ? profile.resumeKeywords : []
  const resumeTitleHits = []
  const resumeJdHits = []
  for (const kw of resumeCandidates) {
    if (hasTerm(titleLower, kw)) {
      resumeTitleHits.push(kw)
    } else if (hasTerm(jdLower, kw)) {
      resumeJdHits.push(kw)
    }
  }
  const resumeHits = [...resumeTitleHits, ...resumeJdHits]
  const resumeRawPts = resumeTitleHits.length * 6 + resumeJdHits.length * 3.5
  const resumeCap = (!hasRoleTargets || namedRoleTitleHits.length > 0) ? 20 : 10
  const resumePts = Math.round(Math.min(resumeCap, resumeRawPts))

  // 3. City & Region affinity
  let cityHit = ''
  let cityPts = 0
  let cityDetail = isEn ? 'No location restriction set' : '未限制具体工作地点'
  const statedMarkets = (profile.targetMarkets || []).map(index => locationMarkets[index]).filter(Boolean)
  const countryHit = statedMarkets.some(market => market.locations.test(location))
  const cityHitInListing = profile.targetCities.find(city => matchesCity(locLower, city))
  const listedTargetCity = cityHitInListing && !['remote', '远程', '居家办公'].includes(cityHitInListing)
  const worldwide = /\b(?:worldwide|anywhere in the world|global remote)\b|全球远程/iu.test(location)
  const elsewhere = statedMarkets.length > 0 && !countryHit && !listedTargetCity && !worldwide
    && locationMarkets.some(market => market.locations.test(location))
  if (elsewhere) {
    cityPts = -10
    cityDetail = isEn ? 'Listed location is outside your target country' : '官网所列地点在目标国家以外'
    cautions.push(cityDetail)
  } else if (countryHit && !profile.targetCities.length) {
    cityPts = 12
    cityDetail = isEn ? 'Listed location matches your target country' : '官网所列地点符合目标国家'
  } else if (statedMarkets.length && !profile.targetCities.length) {
    cityDetail = isEn ? 'Country eligibility is unspecified' : '官网未注明是否接受目标国家的候选人'
  } else if (profile.targetCities.length > 0) {
    const matchedCity = profile.targetCities.find(city => matchesCity(locLower, city) || matchesCity(titleLower, city))
    if (matchedCity) {
      cityPts = 12
      cityHit = matchedCity
      cityDetail = isEn ? `Matches target city "${matchedCity}"` : `命中目标城市「${matchedCity}」`
    } else if (locLower.includes('remote') || locLower.includes('远程')) {
      cityPts = 8
      cityHit = isEn ? 'Remote' : '远程'
      cityDetail = isEn ? 'Remote-friendly role' : '支持远程办公'
    } else if (locLower) {
      cityPts = -10
      const shortLoc = cleanStr(location.split(/[·,/]/)[0], 14)
      cityDetail = isEn ? `Based in ${shortLoc} (outside target cities)` : `地点在 ${shortLoc}（不在目标城市内）`
      cautions.push(isEn ? `Located in ${cleanStr(location.split(/[·,/]/)[0], 12)}` : `地点在 ${cleanStr(location.split(/[·,/]/)[0], 12)}`)
    } else {
      cityDetail = isEn ? 'City not specified on listing' : '官网未注明工作城市'
    }
  } else {
    const isCnJob = /[\u4e00-\u9fff]/.test(`${company} ${title} ${location}`)
    if (profile.wantsDomestic && isCnJob) {
      cityPts = 6
      cityDetail = isEn ? 'Matches domestic market preference' : '符合国内岗位偏好'
    } else if (profile.wantsGlobal && !isCnJob) {
      cityPts = 6
      cityDetail = isEn ? 'Matches international/global preference' : '符合海外 / 国际团队偏好'
    }
  }

  // 4. Symmetric Stage 0 avoid-hint exclusions & soft intern down-rank
  let penaltyPts = 0
  let roleMismatch = false
  let explicitExclude = false
  const stage0 = isStage0HardExcluded(job, profile, {})
  if (stage0.excluded && stage0.reason === 'avoid_hint') {
    const posSum = basePts + termPts + rolePts + resumePts + cityPts
    penaltyPts = Math.min(-44, 39 - posSum)
    roleMismatch = true
    explicitExclude = true
    cautions.unshift(isEn ? `Matches avoid filter "${stage0.avoidTerm}"` : `命中避雷词「${stage0.avoidTerm}」`)
    penaltyNotes.push(isEn ? `Avoid filter "${stage0.avoidTerm}"` : `命中避雷词「${stage0.avoidTerm}」`)
  } else if (!profile.wantsIntern && (profile.experienceYears ?? 0) >= 2 && isActualInternOrCampusOpening(title)) {
    penaltyPts -= 22
    cautions.unshift(isEn ? 'Intern / Campus role' : '实习/校招岗位')
    penaltyNotes.push(isEn ? 'Intern / Campus' : '实习/校招岗')
  }

  // 5. Implicit Negative Feedback learning
  const hiddenCompany = Boolean(company && profile.dislikedCompanies.has(company.trim().toLowerCase()))
  if (hiddenCompany) {
    penaltyPts -= 36
    cautions.unshift(isEn ? 'Company previously hidden' : '你曾标记暂不看该公司')
    penaltyNotes.push(isEn ? 'Hidden company' : '曾标记暂不看该公司')
  }
  if (profile.dislikedCities.size > 0 && [...profile.dislikedCities].some(c => matchesCity(locLower, c))) {
    penaltyPts -= 22
    cautions.push(isEn ? 'City previously skipped' : '你曾忽略该城市')
    penaltyNotes.push(isEn ? 'Skipped city' : '曾忽略该城市')
  }
  if (profile.dislikedTitleTokens.size > 0 && matchedTitleSpecific.length === 0) {
    const hitDisliked = [...profile.dislikedTitleTokens].find(tok => hasTerm(titleLower, tok))
    if (hitDisliked) {
      penaltyPts -= 18
      penaltyNotes.push(isEn ? 'Similar to skipped direction' : '与曾忽略方向接近')
    }
  }

  // 6. Final score aggregation (no hardcoded zero-core or off-role hard caps)
  if (roleOnlyCollaborative && !cautions.length) {
    cautions.push(isEn ? 'Target role only mentioned peripherally' : '仅在协作或资格要求中提及目标职能')
  }

  const rawTotal = basePts + termPts + rolePts + resumePts + cityPts + penaltyPts
  const score = Math.max(5, Math.min(elsewhere ? 59 : 96, Math.round(rawTotal)))
  const tier = roleMismatch ? 'skip' : tierForScore(score)

  const fmtTerm = t => (t.length <= 4 && /^[a-z0-9]+$/i.test(t) ? t.toUpperCase() : t)
  const dedupeTerms = arr => {
    const seen = new Set()
    const out = []
    for (const raw of arr) {
      const formatted = fmtTerm(raw)
      const low = formatted.toLowerCase()
      if (!formatted || seen.has(low)) continue
      seen.add(low)
      out.push(formatted)
    }
    return out
  }
  const matchedTermLabels = hasRoleTargets
    ? dedupeTerms([...skillTitleHits, ...skillJdHits, ...matchedTitleBroad, ...matchedJdBroad])
    : dedupeTerms([...matchedTitleSpecific, ...matchedJdSpecific, ...matchedTitleBroad, ...matchedJdBroad])

  const breakdown = [
    { key: 'base', label: isEn ? 'Active Listing Base' : '在招基准分', delta: basePts, detail: isEn ? 'Baseline for active official board opening' : '官网实时在招岗位基础分' },
    ...(rolePts ? [{
      key: 'role',
      label: isEn ? 'Requested role' : '目标职能',
      delta: rolePts,
      max: 40,
      detail: (namedRoleTitleHits.length ? (isEn ? 'Job title' : '岗位名称') : (isEn ? 'Job description' : '岗位描述'))
        + ' · ' + (namedRoleTitleHits.length ? namedRoleTitleHits : namedRoleJdHits).join(' / '),
    }] : []),
    {
      key: 'terms',
      label: hasRoleTargets ? (isEn ? 'Tools & Keywords' : '工具与技能词') : (isEn ? 'Target Keywords' : '求职画像词'),
      delta: termPts,
      max: hasRoleTargets ? 22 : 46,
      detail: matchedTermLabels.length
        ? (isEn ? `Matched ${matchedTermLabels.slice(0, 3).join(' / ')}` : `命中 ${matchedTermLabels.slice(0, 3).join(' / ')}`)
        : (isEn ? 'No saved search keywords matched' : '未命中已设画像词'),
    },
    {
      key: 'resume',
      label: isEn ? 'Resume Keywords' : '简历专有词',
      delta: resumePts,
      max: 20,
      detail: resumeHits.length
        ? (isEn ? `Overlap: ${dedupeTerms(resumeHits).slice(0, 4).join(' / ')}` : `重合 ${dedupeTerms(resumeHits).slice(0, 4).join(' / ')}`)
        : (isEn ? 'No master resume keywords matched' : '未命中主干简历核心词'),
    },
    {
      key: 'location',
      label: isEn ? 'Location Fit' : '地点偏好',
      delta: cityPts,
      ...(elsewhere ? { outsideTargetCountry: true } : {}),
      max: 12,
      detail: cityDetail,
    },
    ...(penaltyPts !== 0 ? [{
      key: 'penalty',
      label: isEn ? 'Role & Filter Adjustments' : '职能与偏好修正',
      delta: penaltyPts,
      ...(explicitExclude ? { explicitExclude: true } : {}),
      ...(roleMismatch ? { hardExclude: true } : {}),
      ...(hiddenCompany ? { hiddenCompany: true } : {}),
      detail: penaltyNotes.join(' · '),
    }] : []),
  ]

  const highlightTerms = hasPrimaryRoleFit
    ? dedupeTerms([...namedRoleTitleHits, ...skillTitleHits, ...resumeTitleHits, ...namedRoleJdCoreHits, ...skillJdHits, ...resumeJdHits]).slice(0, 3)
    : dedupeTerms([...skillTitleHits, ...skillJdHits, ...resumeTitleHits]).slice(0, 3)

  let reason = ''
  if (roleMismatch) {
    reason = cautions[0]
      ? (isEn ? `${cautions[0]} — outside target goal` : `${cautions[0]}，与当前目标不符`)
      : (isEn ? 'Role misaligned with your resume and goal' : '岗位方向与当前简历和目标不符')
  } else if (roleOnlyCollaborative) {
    reason = highlightTerms.length
      ? (isEn ? `Mentions ${highlightTerms.slice(0, 2).join(' / ')}, but primary role differs` : `提及 ${highlightTerms.slice(0, 2).join(' / ')}，但主职责非目标职能`)
      : (isEn ? 'Target role only mentioned peripherally' : '仅在协作或背景中提及目标职能')
  } else if (highlightTerms.length >= 2) {
    reason = isEn
      ? `Matches your ${highlightTerms.join(' / ')} background${cityHit ? ` · ${cityHit}` : ''}`
      : `契合你的 ${highlightTerms.join(' / ')} 背景${cityHit ? ` · ${cityHit}` : ''}`
  } else if (highlightTerms.length === 1) {
    reason = isEn
      ? `Matches "${highlightTerms[0]}"${cityHit ? ` · ${cityHit}` : ''}`
      : `命中方向「${highlightTerms[0]}」${cityHit ? ` · ${cityHit}` : ''}`
  } else if (cityHit) {
    reason = isEn
      ? `In target location (${cityHit}) — open JD to verify`
      : `位于目标城市 ${cityHit}，可展开查看具体 JD`
  } else {
    reason = jd.length > 60
      ? (isEn ? 'Lower overlap with current career focus' : '与当前求职方向关联度偏弱')
      : (isEn ? 'Title-only listing — open to inspect details' : '官网仅公布标题，可展开查看详情')
  }

  return {
    opportunityId: job.id,
    score,
    tier,
    reason: cleanStr(reason, 64),
    caution: cleanStr(cautions[0] || '', 36),
    breakdown,
    factSignals: extractFactSignals(breakdown),
    fingerprint: profile.fingerprint,
    jobFingerprint: jobContentFingerprint(job),
    mode: 'heuristic',
    updatedAt: new Date().toISOString(),
  }
}
