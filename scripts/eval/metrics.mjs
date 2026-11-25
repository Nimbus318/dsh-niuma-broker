/**
 * Zero-dependency offline evaluation metrics and rubric ranking helpers
 * for job recall, semantic reranking, calibration, and stability checks.
 */

export const TIER_ORDER = ['top', 'good', 'stretch', 'skip']
export const TIER_RANK = Object.freeze({
  top: 4,
  good: 3,
  stretch: 2,
  skip: 1,
  unreviewed: 0,
})

const DEFAULT_GAINS = [0, 1, 3, 7]

function toLabelMap(labelsById) {
  if (labelsById instanceof Map) return labelsById
  const map = new Map()
  if (labelsById && typeof labelsById === 'object') {
    for (const [id, raw] of Object.entries(labelsById)) {
      const val = typeof raw === 'object' && raw !== null ? raw.label : raw
      if (Number.isFinite(val)) map.set(id, Number(val))
    }
  }
  return map
}

function uniqueOrderedIds(rankedIds) {
  const out = []
  const seen = new Set()
  for (const raw of rankedIds || []) {
    const id = typeof raw === 'string' ? raw : raw?.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Compute Recall@K over judged items meeting `rel >= minRel`.
 */
export function computeRecallAtK(rankedIds, labelsById, k, { minRel = 2 } = {}) {
  const labels = toLabelMap(labelsById)
  const cap = Math.max(0, Math.floor(Number(k) || 0))
  const ordered = uniqueOrderedIds(rankedIds).slice(0, cap)

  let totalRelevant = 0
  for (const rel of labels.values()) {
    if (rel >= minRel) totalRelevant += 1
  }

  let hits = 0
  let judgedInTopK = 0
  for (const id of ordered) {
    if (!labels.has(id)) continue
    judgedInTopK += 1
    if (labels.get(id) >= minRel) hits += 1
  }

  return {
    k: cap,
    recall: totalRelevant > 0 ? hits / totalRelevant : null,
    hits,
    totalRelevant,
    judgedInTopK,
    judgedCoverage: ordered.length > 0 ? judgedInTopK / ordered.length : null,
  }
}

/**
 * Compute NDCG@K using exponential gain (2^rel - 1 -> [0, 1, 3, 7]).
 */
export function computeNdcgAtK(rankedIds, labelsById, k, { gains = DEFAULT_GAINS } = {}) {
  const labels = toLabelMap(labelsById)
  const cap = Math.max(0, Math.floor(Number(k) || 0))
  const ordered = uniqueOrderedIds(rankedIds).slice(0, cap)
  const gainFor = rel => (Number.isFinite(rel) && rel >= 0 ? (gains[Math.round(rel)] ?? (2 ** Math.round(rel) - 1)) : 0)

  let dcg = 0
  let unjudgedInTopK = 0
  for (let i = 0; i < ordered.length; i += 1) {
    const id = ordered[i]
    if (!labels.has(id)) {
      unjudgedInTopK += 1
      continue
    }
    const g = gainFor(labels.get(id))
    if (g > 0) dcg += g / Math.log2(i + 2)
  }

  const idealGains = [...labels.values()]
    .map(gainFor)
    .sort((a, b) => b - a)
    .slice(0, cap)
  let idcg = 0
  for (let i = 0; i < idealGains.length; i += 1) {
    if (idealGains[i] > 0) idcg += idealGains[i] / Math.log2(i + 2)
  }

  return {
    k: cap,
    ndcg: idcg > 0 ? dcg / idcg : null,
    dcg,
    idcg,
    unjudgedInTopK,
  }
}

/**
 * Compute Precision@K overall (treating unjudged as 0) and among judged top-K items.
 */
export function computePrecisionAtK(rankedIds, labelsById, k, { minRel = 2 } = {}) {
  const labels = toLabelMap(labelsById)
  const cap = Math.max(0, Math.floor(Number(k) || 0))
  const ordered = uniqueOrderedIds(rankedIds).slice(0, cap)

  let hits = 0
  let judgedInTopK = 0
  for (const id of ordered) {
    if (!labels.has(id)) continue
    judgedInTopK += 1
    if (labels.get(id) >= minRel) hits += 1
  }

  return {
    k: cap,
    precision: ordered.length > 0 ? hits / ordered.length : null,
    precisionAmongJudged: judgedInTopK > 0 ? hits / judgedInTopK : null,
    hits,
    inspected: ordered.length,
    judgedInTopK,
  }
}

function shannonEntropy(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0)
  if (total <= 0) return 0
  let entropy = 0
  for (const count of counts) {
    if (count <= 0) continue
    const p = count / total
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * Compute tier shares, tier entropy, score spread, and top-tier precision.
 */
export function computeTierStats(resultsById, labelsById) {
  const labels = toLabelMap(labelsById)
  const entries = resultsById instanceof Map
    ? [...resultsById.entries()]
    : Object.entries(resultsById || {})

  const counts = { top: 0, good: 0, stretch: 0, skip: 0, unreviewed: 0 }
  const topIds = []
  const scores = []
  const scoreBins = new Array(10).fill(0)

  for (const [id, item] of entries) {
    const tier = TIER_ORDER.includes(item?.tier) ? item.tier : 'unreviewed'
    counts[tier] += 1
    if (tier === 'top') topIds.push(id)
    if (Number.isFinite(item?.score)) {
      const clamped = Math.max(0, Math.min(100, Number(item.score)))
      scores.push(clamped)
      const bin = Math.min(9, Math.floor(clamped / 10))
      scoreBins[bin] += 1
    }
  }

  const evaluatedTotal = counts.top + counts.good + counts.stretch + counts.skip
  const topJudged = topIds.filter(id => labels.has(id))
  const topHitsRel2 = topJudged.filter(id => labels.get(id) >= 2).length
  const topHitsRel3 = topJudged.filter(id => labels.get(id) >= 3).length

  const sortedScores = [...scores].sort((a, b) => a - b)
  const q = frac => {
    if (!sortedScores.length) return null
    return sortedScores[Math.min(sortedScores.length - 1, Math.floor(sortedScores.length * frac))]
  }
  const band85To98 = scores.filter(s => s >= 85 && s <= 98).length

  return {
    counts,
    evaluatedTotal,
    topShare: evaluatedTotal > 0 ? counts.top / evaluatedTotal : null,
    tierEntropy: shannonEntropy([counts.top, counts.good, counts.stretch, counts.skip]),
    scoreBinEntropy: shannonEntropy(scoreBins),
    precisionAtTopRel2: topJudged.length > 0 ? topHitsRel2 / topJudged.length : null,
    precisionAtTopRel3: topJudged.length > 0 ? topHitsRel3 / topJudged.length : null,
    scoreQuantiles: sortedScores.length
      ? { min: sortedScores[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: sortedScores[sortedScores.length - 1] }
      : null,
    band85To98Share: scores.length > 0 ? band85To98 / scores.length : null,
  }
}

function toRankValueMap(orderOrMap) {
  if (orderOrMap instanceof Map) return orderOrMap
  const map = new Map()
  if (Array.isArray(orderOrMap)) {
    orderOrMap.forEach((raw, idx) => {
      if (typeof raw === 'string') {
        map.set(raw, -idx) // Earlier rank = higher value
      } else if (raw && typeof raw === 'object' && raw.id) {
        map.set(raw.id, Number.isFinite(raw.rankValue) ? Number(raw.rankValue) : -idx)
      }
    })
  } else if (orderOrMap && typeof orderOrMap === 'object') {
    for (const [id, val] of Object.entries(orderOrMap)) {
      if (Number.isFinite(val)) map.set(id, Number(val))
    }
  }
  return map
}

/**
 * Exact tie-aware Kendall's tau-b between two rankings/scores (higher value = ranked earlier).
 */
export function computeKendallTauB(orderA, orderB) {
  const mapA = toRankValueMap(orderA)
  const mapB = toRankValueMap(orderB)
  const common = [...mapA.keys()].filter(id => mapB.has(id))
  const n = common.length
  if (n < 2) {
    return { tauB: null, concordant: 0, discordant: 0, tiesA: 0, tiesB: 0, commonCount: n }
  }

  let concordant = 0
  let discordant = 0
  let tiesA = 0
  let tiesB = 0
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const da = mapA.get(common[i]) - mapA.get(common[j])
      const db = mapB.get(common[i]) - mapB.get(common[j])
      if (da === 0 && db === 0) {
        tiesA += 1
        tiesB += 1
      } else if (da === 0) {
        tiesA += 1
      } else if (db === 0) {
        tiesB += 1
      } else if (da * db > 0) {
        concordant += 1
      } else {
        discordant += 1
      }
    }
  }

  const totalPairs = (n * (n - 1)) / 2
  const denom = Math.sqrt((totalPairs - tiesA) * (totalPairs - tiesB))
  return {
    tauB: denom > 0 ? (concordant - discordant) / denom : null,
    concordant,
    discordant,
    tiesA,
    tiesB,
    commonCount: n,
  }
}

/**
 * Evaluate pairwise stability across multiple runs (e.g. shuffled batch orders).
 */
export function computeRankStability(runOrders = [], tierMaps = []) {
  if (!Array.isArray(runOrders) || runOrders.length < 2) {
    return {
      pairCount: 0,
      tauBMin: null,
      tauBMedian: null,
      tauBMean: null,
      maxTop3Displacements: null,
      minTop10Overlap: null,
      maxBoundaryFlipRate: null,
    }
  }

  const taus = []
  let maxTop3Displacements = 0
  let minTop10Overlap = 1
  let maxBoundaryFlipRate = 0
  let hasBoundary = false

  for (let i = 0; i < runOrders.length; i += 1) {
    const aIds = uniqueOrderedIds(runOrders[i])
    const aTop3 = new Set(aIds.slice(0, 3))
    const aTop10 = new Set(aIds.slice(0, 10))
    const tA = tierMaps[i] ? (tierMaps[i] instanceof Map ? tierMaps[i] : new Map(Object.entries(tierMaps[i]))) : null

    for (let j = i + 1; j < runOrders.length; j += 1) {
      const bIds = uniqueOrderedIds(runOrders[j])
      const { tauB } = computeKendallTauB(aIds, bIds)
      if (tauB != null) taus.push(tauB)

      const bTop3 = new Set(bIds.slice(0, 3))
      const top3Displaced = [...aTop3].filter(id => !bTop3.has(id)).length
      if (top3Displaced > maxTop3Displacements) maxTop3Displacements = top3Displaced

      const denom10 = Math.min(10, aIds.length, bIds.length)
      if (denom10 > 0) {
        const bTop10 = new Set(bIds.slice(0, 10))
        const overlap10 = [...aTop10].filter(id => bTop10.has(id)).length / denom10
        if (overlap10 < minTop10Overlap) minTop10Overlap = overlap10
      }

      if (tA && tierMaps[j]) {
        const tB = tierMaps[j] instanceof Map ? tierMaps[j] : new Map(Object.entries(tierMaps[j]))
        const boundaryIds = aIds.filter(id => ['top', 'good'].includes(tA.get(id)) || ['top', 'good'].includes(tB.get(id)))
        if (boundaryIds.length > 0) {
          hasBoundary = true
          const flips = boundaryIds.filter(id => (tA.get(id) === 'top') !== (tB.get(id) === 'top')).length
          const flipRate = flips / boundaryIds.length
          if (flipRate > maxBoundaryFlipRate) maxBoundaryFlipRate = flipRate
        }
      }
    }
  }

  const sortedTaus = [...taus].sort((a, b) => a - b)
  const medianTau = sortedTaus.length ? sortedTaus[Math.floor(sortedTaus.length / 2)] : null
  const meanTau = sortedTaus.length ? sortedTaus.reduce((s, v) => s + v, 0) / sortedTaus.length : null

  return {
    pairCount: taus.length,
    tauBMin: sortedTaus[0] ?? null,
    tauBMedian: medianTau,
    tauBMean: meanTau,
    maxTop3Displacements,
    minTop10Overlap: runOrders[0]?.length ? minTop10Overlap : null,
    maxBoundaryFlipRate: hasBoundary ? maxBoundaryFlipRate : null,
  }
}

/**
 * Paired single-query difference report (no invalid significance claims).
 */
export function compareRunsPaired(baseline = {}, candidate = {}) {
  const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null)
  const baseNdcg10 = baseline?.ndcgAt10
  const candNdcg10 = candidate?.ndcgAt10
  const candTokens = candidate?.totalTokens
  return {
    deltaRecallAt30: diff(baseline?.recallAt30, candidate?.recallAt30),
    deltaRecallAt60: diff(baseline?.recallAt60, candidate?.recallAt60),
    deltaNdcgAt10: diff(baseNdcg10, candNdcg10),
    deltaNdcgAt20: diff(baseline?.ndcgAt20, candidate?.ndcgAt20),
    deltaPrecisionAt10: diff(baseline?.precisionAt10, candidate?.precisionAt10),
    deltaPrecisionAtTop: diff(baseline?.precisionAtTopRel2, candidate?.precisionAtTopRel2),
    deltaTopShare: diff(baseline?.topShare, candidate?.topShare),
    deltaTotalTokens: diff(baseline?.totalTokens, candTokens),
    tokensPerNdcg10: (Number.isFinite(candTokens) && Number.isFinite(candNdcg10) && candNdcg10 > 0)
      ? Math.round(candTokens / candNdcg10)
      : null,
  }
}

/**
 * Option A (Grok rule): D=3 hard gate for top + lexicographical within-tier ordering (D, E, L, -recallRank).
 */
export function rankRubricOptionA(items = []) {
  return [...items]
    .map((item, idx) => {
      const r = item?.rubric || {}
      const d = Number.isFinite(r.D) ? Number(r.D) : null
      const e = Number.isFinite(r.E) ? Number(r.E) : null
      const l = Number.isFinite(r.L) ? Number(r.L) : null
      const lKnown = l !== null
      let tier = 'unreviewed'
      if (d == null) {
        tier = 'unreviewed'
      } else if (d === 0 || l === 0) {
        tier = 'skip'
      } else if (e == null || (item?.hasExplicitLevelRequirement && !lKnown)) {
        tier = 'stretch'
      } else if (d >= 3 && (e >= 2) && (!lKnown || l >= 2)) {
        tier = 'top'
      } else if (d >= 2 && (e >= 2) && (!lKnown || l >= 1)) {
        tier = 'good'
      } else if (d >= 1) {
        tier = 'stretch'
      } else {
        tier = 'skip'
      }
      return {
        ...item,
        tier,
        _sort: {
          tierRank: TIER_RANK[tier] ?? 0,
          d: d ?? -1,
          e: e ?? -1,
          l: l ?? -1,
          recallRank: Number.isFinite(item?.recallRank) ? item.recallRank : idx,
        },
      }
    })
    .sort((a, b) => (b._sort.tierRank - a._sort.tierRank)
      || (b._sort.d - a._sort.d)
      || (b._sort.e - a._sort.e)
      || (b._sort.l - a._sort.l)
      || (a._sort.recallRank - b._sort.recallRank)
      || String(a.id).localeCompare(String(b.id)))
}

/**
 * Option B (Codex rule): D>=2, E>=2 gate + weighted S=(2D+2E+L)/5 >= 2.4 for top (normalizing out missing L).
 */
export function rankRubricOptionB(items = []) {
  return [...items]
    .map((item, idx) => {
      const r = item?.rubric || {}
      const d = Number.isFinite(r.D) ? Number(r.D) : null
      const e = Number.isFinite(r.E) ? Number(r.E) : null
      const l = Number.isFinite(r.L) ? Number(r.L) : null
      const lKnown = l !== null
      let weightedS = -1
      let tier = 'unreviewed'
      if (d == null || e == null) {
        tier = d == null ? 'unreviewed' : 'stretch'
      } else if (d === 0 || l === 0) {
        weightedS = lKnown ? (2 * d + 2 * e + l) / 5 : (2 * d + 2 * e) / 4
        tier = 'skip'
      } else {
        weightedS = lKnown ? (2 * d + 2 * e + l) / 5 : (2 * d + 2 * e) / 4
        const levelBlocked = item?.hasExplicitLevelRequirement && !lKnown
        if (!levelBlocked && d >= 2 && e >= 2 && weightedS >= 2.4) {
          tier = 'top'
        } else if (d >= 2 && e >= 2 && weightedS >= 1.6) {
          tier = 'good'
        } else if (d >= 1 && weightedS >= 1.6) {
          tier = 'good'
        } else if (d >= 1) {
          tier = 'stretch'
        } else {
          tier = 'skip'
        }
      }
      return {
        ...item,
        tier,
        weightedS,
        _sort: {
          tierRank: TIER_RANK[tier] ?? 0,
          s: weightedS,
          d: d ?? -1,
          recallRank: Number.isFinite(item?.recallRank) ? item.recallRank : idx,
        },
      }
    })
    .sort((a, b) => (b._sort.tierRank - a._sort.tierRank)
      || (b._sort.s - a._sort.s)
      || (b._sort.d - a._sort.d)
      || (a._sort.recallRank - b._sort.recallRank)
      || String(a.id).localeCompare(String(b.id)))
}
