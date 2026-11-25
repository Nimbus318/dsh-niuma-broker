import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildMissingJdMatch,
  buildPatrolSearchProfile,
  isOpportunityJdIncomplete,
  jobContentFingerprint,
  scoreOpportunityHeuristic,
  selectTriageCandidates,
  triageBatchWithLlm,
} from '../../src/job-triage.mjs'
import { canFetchOpportunityDetail } from '../../src/opportunities.mjs'
import {
  TIER_RANK,
  compareRunsPaired,
  computeNdcgAtK,
  computePrecisionAtK,
  computeRankStability,
  computeRecallAtK,
  computeTierStats,
  rankRubricOptionA,
  rankRubricOptionB,
} from './metrics.mjs'
import { assertSafeRepoOutputPath, writePrivateJsonFile } from './sample-private-dataset.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(MODULE_DIR, '../..')
export const DEFAULT_REPORTS_DIR = join(REPO_ROOT, 'scripts', 'eval', 'reports')

export const FROZEN_EVAL_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  resumeSentMaxChars: 2200,
  jdMaxChars: 12000,
  batchLimit: 30,
  defaultRounds: 2,
  ndcgGains: [0, 1, 3, 7],
})

function resolveCurrentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle(items, seed) {
  const arr = [...items]
  const rand = mulberry32(seed)
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function buildReceiptsMap(receipts = []) {
  const map = new Map()
  for (const r of receipts || []) {
    if (!r?.opportunityId) continue
    const bucket = map.get(r.opportunityId)
    if (bucket) bucket.push(r)
    else map.set(r.opportunityId, [r])
  }
  return map
}

function resolveActiveBoards(persona, opportunities) {
  if (Array.isArray(persona?.boards)) {
    return new Set(
      persona.boards.map(b => (typeof b === 'string' ? b : `${b.provider}:${b.slug}`)),
    )
  }
  return new Set(opportunities.map(o => o?.sourceId).filter(Boolean))
}

function buildMockLlm(responseMap = {}, callLog = [], { skipIds = new Set() } = {}) {
  return {
    listProviders: () => [{ id: 'eval-mock', name: 'Eval Mock' }],
    resolveModelInfo: async () => ({
      context: { contextWindow: 64_000 },
      defaultMaxTokens: 4096,
    }),
    prepareCall: async () => ({
      model: { provider: 'eval-mock', id: 'deterministic' },
      async *stream(req) {
        const raw = req?.messages?.[0]?.content?.[0]?.text || '{}'
        const payload = JSON.parse(raw)
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
        const items = jobs
          .map(j => {
            if (skipIds.has(j.id)) return null
            const spec = responseMap[j.id]
            if (!spec || spec.failOnce === true && skipIds.has(`failOnce:${j.id}`)) return null
            return spec ? { id: j.id, ...spec } : null
          })
          .filter(Boolean)
        const inTok = Math.max(120, Math.round(raw.length / 3))
        const text = JSON.stringify({ items })
        const outTok = Math.max(30, Math.round(text.length / 3))
        callLog.push({ jobIds: jobs.map(j => j.id), inTok, outTok })
        yield { type: 'text-delta', text }
        yield {
          type: 'usage',
          usage: {
            inputTokens: inTok,
            outputTokens: outTok,
            totalTokens: inTok + outTok,
            reasoningTokens: 0,
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

function sortStage2Results(results = []) {
  return [...results].sort((a, b) => {
    const aLlm = a?.mode === 'llm' ? 1 : 0
    const bLlm = b?.mode === 'llm' ? 1 : 0
    if (bLlm !== aLlm) return bLlm - aLlm
    const aTier = TIER_RANK[a?.tier] ?? 0
    const bTier = TIER_RANK[b?.tier] ?? 0
    if (bTier !== aTier) return bTier - aTier
    return (Number(b?.score) || 0) - (Number(a?.score) || 0)
      || String(a?.opportunityId || '').localeCompare(String(b?.opportunityId || ''))
  })
}

function countValidNumericLabels(labelsById, candidateIds) {
  const valid = new Map()
  if (!labelsById || typeof labelsById !== 'object') return valid
  const idSet = new Set(candidateIds)
  for (const [id, raw] of Object.entries(labelsById)) {
    if (!idSet.has(id)) continue
    const val = typeof raw === 'object' && raw !== null ? raw.label : raw
    if (typeof val === 'number' && Number.isFinite(val)) valid.set(id, val)
  }
  return valid
}

function auditRoundLeaks({
  selected,
  feedbackMap,
  receiptsByOpp,
  activeBoards,
  expectedExplicitExcludeSet,
  hasIndependentExplicitGroundTruth,
  heurMap,
}) {
  let closedLeakCount = 0
  let dismissedLeakCount = 0
  let inactiveBoardLeakCount = 0
  let trackedLeakCount = 0
  let nonHydratableMissingJdLeakCount = 0
  let expectedExplicitExcludeLeakCount = 0
  let heuristicExplicitExcludeTelemetryCount = 0

  for (const job of selected) {
    if (job.closedAt) closedLeakCount += 1
    if (feedbackMap[job.id]?.status === 'dismissed') dismissedLeakCount += 1
    const tracked = job.provider === 'manual'
      || (receiptsByOpp.get(job.id)?.length ?? 0) > 0
      || feedbackMap[job.id]?.status === 'pinned'
    if (tracked) trackedLeakCount += 1
    if (!tracked && job.oneOff !== true && !activeBoards.has(job.sourceId)) inactiveBoardLeakCount += 1
    if (isOpportunityJdIncomplete(job) && !canFetchOpportunityDetail(job)) nonHydratableMissingJdLeakCount += 1
    if (hasIndependentExplicitGroundTruth && expectedExplicitExcludeSet.has(job.id)) {
      expectedExplicitExcludeLeakCount += 1
    }
    const h = heurMap.get(job.id)
    if (h?.breakdown?.some(f => f.explicitExclude === true)) {
      heuristicExplicitExcludeTelemetryCount += 1
    }
  }

  return {
    closedLeakCount,
    dismissedLeakCount,
    inactiveBoardLeakCount,
    trackedLeakCount,
    nonHydratableMissingJdLeakCount,
    expectedExplicitExcludeLeakCount,
    heuristicExplicitExcludeTelemetryCount,
  }
}

async function evaluatePersona(persona, { seed = 42, limit = 30, rounds = FROZEN_EVAL_SNAPSHOT.defaultRounds } = {}) {
  const opportunities = Array.isArray(persona?.opportunities) ? persona.opportunities : []
  const labelsById = persona?.labels || {}
  const feedbackMap = persona?.feedback || {}
  const receiptsByOpp = buildReceiptsMap(persona?.receipts)
  const activeBoards = resolveActiveBoards(persona, opportunities)
  const locale = persona?.locale === 'en' ? 'en' : 'zh'
  const resumeText = String(persona?.resumeText || '')
  const perRoundLimit = Math.min(FROZEN_EVAL_SNAPSHOT.batchLimit, Math.max(1, Math.floor(Number(limit) || 30)))
  const maxRounds = Math.max(1, Math.min(2, Math.floor(Number(rounds) || FROZEN_EVAL_SNAPSHOT.defaultRounds)))
  const currentModel = 'eval-mock:deterministic'

  const profile = buildPatrolSearchProfile({
    resumeText,
    goal: persona?.goal || '',
    searchTerms: persona?.searchTerms || [],
    evidence: persona?.evidence || [],
    feedback: feedbackMap,
  })

  // Build independent hard-exclusion ground truth set without reusing selector predicates blindly
  const expectedExplicitExcludeSet = new Set(Array.isArray(persona?.expectedExplicitExcludeIds) ? persona.expectedExplicitExcludeIds : [])
  if (persona?.expectedHardExclusions && typeof persona.expectedHardExclusions === 'object') {
    for (const [id, reason] of Object.entries(persona.expectedHardExclusions)) {
      if (reason === 'explicit_exclude') expectedExplicitExcludeSet.add(id)
    }
  }
  for (const job of opportunities) {
    if (job?.expectedHardExcludeReason === 'explicit_exclude') expectedExplicitExcludeSet.add(job.id)
  }
  const hasIndependentExplicitGroundTruth = expectedExplicitExcludeSet.size > 0

  // Stage 1 Pool: apply the exact source/open/feedback/hydratable eligibility boundary BEFORE cap=30/round
  const t0 = performance.now()
  const heurMap = new Map()
  const eligiblePoolRows = []
  const initialMissingJdIds = []
  let inactiveBoardCount = 0

  for (const job of opportunities) {
    if (!job?.id) continue
    const h = scoreOpportunityHeuristic(job, profile, locale)
    heurMap.set(job.id, h)
    if (job.closedAt || feedbackMap[job.id]?.status === 'dismissed') continue
    const tracked = job.provider === 'manual'
      || (receiptsByOpp.get(job.id)?.length ?? 0) > 0
      || feedbackMap[job.id]?.status === 'pinned'
    const freshEligible = !tracked && (job.oneOff === true || activeBoards.has(job.sourceId))
    if (!freshEligible) {
      if (!tracked && job.oneOff !== true && !activeBoards.has(job.sourceId)) inactiveBoardCount += 1
      continue
    }
    const incomplete = isOpportunityJdIncomplete(job)
    if (incomplete) initialMissingJdIds.push(job.id)
    const hydratable = incomplete && canFetchOpportunityDetail(job)
    if (incomplete && !hydratable) continue
    if (expectedExplicitExcludeSet.has(job.id) || (!hasIndependentExplicitGroundTruth && h.breakdown?.some(f => f.explicitExclude === true))) {
      continue
    }
    eligiblePoolRows.push({ job, match: h })
  }

  eligiblePoolRows.sort((a, b) => (b.match.score - a.match.score)
    || String(b.job.verifiedAt || b.job.firstSeenAt || '').localeCompare(String(a.job.verifiedAt || a.job.firstSeenAt || ''))
    || String(a.job.id).localeCompare(String(b.job.id)))

  const fullPoolRankedIds = eligiblePoolRows.map(r => r.job.id)
  const initialMissingJdSet = new Set(initialMissingJdIds)

  // Verify sendToModel=false makes zero LLM calls (covers triageBatchWithLlm mock stream boundary)
  const sendFalseCalls = []
  await triageBatchWithLlm({
    llm: buildMockLlm(persona?.mockLlmResponses || {}, sendFalseCalls),
    config: { model: currentModel, sendToModel: false },
    jobs: eligiblePoolRows.slice(0, perRoundLimit).map(r => r.job),
    profile,
    resumeText,
    locale,
  })

  // Replay Round 1..2 using production selectTriageCandidates, offline hydration fixtures, and state carryover
  const workingOpportunities = opportunities.map(o => ({ ...o }))
  const workingOppById = new Map(workingOpportunities.map(o => [o.id, o]))
  const workingMatches = structuredClone(persona?.existingMatches || {})
  const hydrationFixtures = persona?.hydrationFixtures || {}
  const primaryMock = persona?.mockLlmResponses || null
  const hasMockLlm = Boolean(primaryMock && typeof primaryMock === 'object' && Object.keys(primaryMock).length > 0)
  const round1FailOnceIds = new Set(Array.isArray(persona?.round1FailIds) ? persona.round1FailIds : [])

  const roundSummaries = []
  const combinedSelectedIds = []
  const combinedSelectedSeen = new Set()
  const hydratedSuccessIds = []
  const unhydratedIds = []
  const unhydratedFailedIds = []
  const stage2ReadyJobMap = new Map()
  const stage2LatestById = new Map()
  const stage2CallLog = []
  let round1Stage2CallTok = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let retriedFromRound1Count = 0

  const roundLeaksAccum = {
    closedLeakCount: 0,
    dismissedLeakCount: 0,
    inactiveBoardLeakCount: 0,
    trackedLeakCount: 0,
    nonHydratableMissingJdLeakCount: 0,
    expectedExplicitExcludeLeakCount: 0,
    heuristicExplicitExcludeTelemetryCount: 0,
  }

  for (let r = 1; r <= maxRounds; r += 1) {
    const selectionPlan = selectTriageCandidates({
      opportunities: workingOpportunities,
      activeBoards,
      feedbackMap,
      receiptsByOpp,
      existingMatches: workingMatches,
      profile,
      locale,
      limit: perRoundLimit,
      force: false,
      recheck: false,
      currentModel,
    })

    const roundSelected = selectionPlan.needsReviewCandidates || []
    const roundSelectedIds = roundSelected.map(j => j.id)
    if (r === 2) {
      const r1FailedSet = new Set(roundSummaries[0]?.failedRetryableIds || [])
      retriedFromRound1Count = roundSelectedIds.filter(id => r1FailedSet.has(id)).length
    }
    for (const id of roundSelectedIds) {
      if (!combinedSelectedSeen.has(id)) {
        combinedSelectedSeen.add(id)
        combinedSelectedIds.push(id)
      }
    }

    const leaks = auditRoundLeaks({
      selected: roundSelected,
      feedbackMap,
      receiptsByOpp,
      activeBoards,
      expectedExplicitExcludeSet,
      hasIndependentExplicitGroundTruth,
      heurMap,
    })
    for (const key of Object.keys(roundLeaksAccum)) {
      roundLeaksAccum[key] += leaks[key]
    }

    // Offline hydration using deterministic fixtures (never hits live network)
    const hydratedCandidates = roundSelected.map(job => {
      if (!(isOpportunityJdIncomplete(job) && canFetchOpportunityDetail(job))) return job
      const fix = hydrationFixtures[job.id]
      if (fix && !fix.error && typeof fix.jd === 'string') {
        const updated = { ...job, jd: fix.jd, jdPreview: fix.jdPreview === true }
        workingOppById.set(job.id, updated)
        const idx = workingOpportunities.findIndex(o => o.id === job.id)
        if (idx >= 0) workingOpportunities[idx] = updated
        if (!isOpportunityJdIncomplete(updated)) hydratedSuccessIds.push(job.id)
        return updated
      }
      if (fix?.error) {
        return { ...job, _jdHydrationFailed: true }
      }
      return job
    })

    const incompleteCandidates = hydratedCandidates.filter(j => isOpportunityJdIncomplete(j))
    const readyCandidates = hydratedCandidates.filter(j => !isOpportunityJdIncomplete(j))

    for (const job of incompleteCandidates) {
      if (!unhydratedIds.includes(job.id)) unhydratedIds.push(job.id)
      const hydrationFailed = Boolean(job._jdHydrationFailed || hydrationFixtures[job.id]?.error)
      if (hydrationFailed && !unhydratedFailedIds.includes(job.id)) unhydratedFailedIds.push(job.id)
      workingMatches[job.id] = {
        ...buildMissingJdMatch(job, profile, locale, { hydrationFailed }),
        locale,
      }
    }

    let roundMetricsOut = {}
    const failedRetryableIds = []
    let llmSucceededIds = []
    if (hasMockLlm && readyCandidates.length > 0) {
      for (const job of readyCandidates) {
        stage2ReadyJobMap.set(job.id, job)
      }
      const skipSet = r === 1 ? round1FailOnceIds : new Set()
      const roundResults = await triageBatchWithLlm({
        llm: buildMockLlm(primaryMock, stage2CallLog, { skipIds: skipSet }),
        config: { model: currentModel, sendToModel: true },
        jobs: readyCandidates,
        profile,
        resumeText,
        locale,
        metricsOut: roundMetricsOut,
      })
      for (const item of roundResults) {
        stage2LatestById.set(item.opportunityId, item)
        const shouldPersist = item.mode === 'llm'
          || item.uncertaintyCode === 'context_window_exceeded'
          || item.uncertaintyCode === 'missing_jd'
        if (shouldPersist) {
          workingMatches[item.opportunityId] = { ...item, locale }
          if (item.mode === 'llm') llmSucceededIds.push(item.opportunityId)
        } else {
          failedRetryableIds.push(item.opportunityId)
        }
      }
      round1Stage2CallTok = {
        inputTokens: round1Stage2CallTok.inputTokens + (roundMetricsOut.inputTokens || 0),
        outputTokens: round1Stage2CallTok.outputTokens + (roundMetricsOut.outputTokens || 0),
        totalTokens: round1Stage2CallTok.totalTokens + (roundMetricsOut.totalTokens || 0),
      }
    } else if (!hasMockLlm && readyCandidates.length > 0) {
      // Stage-1-only 2-round replay: advance carryover selector state without fabricating Stage 2 results
      for (const job of readyCandidates) {
        workingMatches[job.id] = {
          opportunityId: job.id,
          mode: 'llm',
          score: 60,
          tier: 'stretch',
          fingerprint: profile.fingerprint,
          jobFingerprint: jobContentFingerprint(job),
        }
      }
    }

    roundSummaries.push({
      round: r,
      selectedCount: roundSelectedIds.length,
      selectedIds: roundSelectedIds,
      readyCount: readyCandidates.length,
      unhydratedCount: incompleteCandidates.length,
      llmSucceededCount: llmSucceededIds.length,
      failedRetryableIds,
      tokens: roundMetricsOut.totalTokens || 0,
    })

    if (roundSelectedIds.length === 0) break
  }

  const stage1Ms = Number((performance.now() - t0).toFixed(2))
  const round1SelectedIds = roundSummaries[0]?.selectedIds || []
  const maxRoundSelectedCount = roundSummaries.reduce((m, r) => Math.max(m, r.selectedCount), 0)

  // Fix the gold/judgeable denominator BEFORE round selection using initial complete JDs plus
  // valid pre-registered hydration fixtures (runtime hydration only fills process telemetry).
  const fixedJudgeableSet = new Set()
  for (const r of eligiblePoolRows) {
    const job = r.job
    if (!initialMissingJdSet.has(job.id)) {
      fixedJudgeableSet.add(job.id)
      continue
    }
    if (canFetchOpportunityDetail(job)) {
      const fix = hydrationFixtures[job.id]
      if (fix && !fix.error && typeof fix.jd === 'string'
        && !isOpportunityJdIncomplete({ ...job, jd: fix.jd, jdPreview: fix.jdPreview === true })) {
        fixedJudgeableSet.add(job.id)
      }
    }
  }
  const judgeablePoolIds = fullPoolRankedIds.filter(id => fixedJudgeableSet.has(id))
  const judgedEligibleLabels = countValidNumericLabels(labelsById, judgeablePoolIds)
  const judgedPoolCount = judgedEligibleLabels.size
  const labelCoverage = judgeablePoolIds.length > 0 ? judgedPoolCount / judgeablePoolIds.length : 0
  const labelScope = judgedPoolCount === 0
    ? 'unjudged'
    : (judgedPoolCount === judgeablePoolIds.length ? 'full_pool' : 'sparse_sample')

  const irrelevantCompleteJdIds = []
  for (const [id, rel] of judgedEligibleLabels.entries()) {
    if (rel === 0 && !initialMissingJdSet.has(id)) irrelevantCompleteJdIds.push(id)
  }

  let judgedRelevantTotal = 0
  for (const rel of judgedEligibleLabels.values()) {
    if (rel >= 2) judgedRelevantTotal += 1
  }
  const judgedHitsRound1 = round1SelectedIds.filter(id => (judgedEligibleLabels.get(id) ?? -1) >= 2).length
  const judgedHitsTwoRounds = combinedSelectedIds.filter(id => (judgedEligibleLabels.get(id) ?? -1) >= 2).length
  const p10Raw = computePrecisionAtK(fullPoolRankedIds, judgedEligibleLabels, 10)
  const ndcg10Raw = computeNdcgAtK(fullPoolRankedIds, judgedEligibleLabels, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains })
  const ndcg20Raw = computeNdcgAtK(fullPoolRankedIds, judgedEligibleLabels, 20, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains })

  const heurScores = eligiblePoolRows.map(r => r.match.score)
  const heuristicScoreMax = heurScores.length ? Math.max(...heurScores) : null
  const heuristicTierStats = computeTierStats(
    Object.fromEntries(eligiblePoolRows.map(r => [r.job.id, r.match])),
    judgedEligibleLabels,
  )

  const twoRoundSimulated = maxRounds >= 2 && (roundSummaries.length >= 2 || (roundSummaries.length === 1 && roundSummaries[0].selectedCount < perRoundLimit))
  const stage1Metrics = {
    openPoolCount: eligiblePoolRows.length,
    inactiveBoardCount,
    missingJdCount: initialMissingJdIds.length,
    hydratedCount: hydratedSuccessIds.length,
    unhydratedCount: unhydratedIds.length,
    unhydratedFailedCount: unhydratedFailedIds.length,
    irrelevantCount: irrelevantCompleteJdIds.length,
    round1SelectedCount: round1SelectedIds.length,
    round2SelectedCount: roundSummaries[1]?.selectedCount ?? 0,
    twoRoundSelectedCount: combinedSelectedIds.length,
    maxRoundSelectedCount,
    retriedFromRound1Count,
    labelScope,
    judgedPoolCount,
    labelCoverage,
    judgedRelevantTotal,
    judgedHitsRound1: labelScope === 'unjudged' ? null : judgedHitsRound1,
    judgedHitsTwoRounds: labelScope === 'unjudged' ? null : (twoRoundSimulated ? judgedHitsTwoRounds : null),
    withinJudgedHitRate: (labelScope !== 'unjudged' && judgedRelevantTotal > 0)
      ? (twoRoundSimulated ? judgedHitsTwoRounds : judgedHitsRound1) / judgedRelevantTotal
      : null,
    recallComparable: labelScope === 'full_pool',
    recallAt30Pool: labelScope === 'full_pool' ? computeRecallAtK(fullPoolRankedIds, judgedEligibleLabels, 30).recall : null,
    recallAt60Pool: labelScope === 'full_pool' ? computeRecallAtK(fullPoolRankedIds, judgedEligibleLabels, 60).recall : null,
    selectionRecallAt30: labelScope === 'full_pool' ? computeRecallAtK(round1SelectedIds, judgedEligibleLabels, 30).recall : null,
    selectionRecallAt60: (labelScope === 'full_pool' && twoRoundSimulated)
      ? computeRecallAtK(combinedSelectedIds, judgedEligibleLabels, 60).recall
      : null,
    selectionTopRecallAt60: (labelScope === 'full_pool' && twoRoundSimulated)
      ? computeRecallAtK(combinedSelectedIds, judgedEligibleLabels, 60, { minRel: 3 }).recall
      : null,
    ndcgAt10: labelScope === 'full_pool' ? ndcg10Raw.ndcg : null,
    ndcgAt20: labelScope === 'full_pool' ? ndcg20Raw.ndcg : null,
    precisionAt10: labelScope === 'full_pool' ? p10Raw.precision : null,
    precisionAmongJudgedAt10: labelScope === 'unjudged' ? null : p10Raw.precisionAmongJudged,
    judgedInTop10: p10Raw.judgedInTopK,
    heuristicScoreMax,
    heuristicTierCounts: heuristicTierStats.counts,
    rounds: roundSummaries,
    ...roundLeaksAccum,
    latencyMs: stage1Ms,
  }

  // Stage 2 metrics ONLY over readyCandidates actually consumed in Round 1 + Round 2
  let stage2Metrics = null
  if (hasMockLlm) {
    const primaryResults = sortStage2Results([...stage2LatestById.values()])
    const readyJobs = [...stage2ReadyJobMap.values()]
    const primaryOrder = primaryResults.map(r => r.opportunityId)
    const judgedStage2Labels = countValidNumericLabels(labelsById, primaryOrder)
    const byId = Object.fromEntries(primaryResults.map(r => [r.opportunityId, r]))
    const tierStats = computeTierStats(byId, judgedStage2Labels)

    // Mock Order-Invariance Smoke Test (code determinism only, NOT model stability calibration)
    const smokeOrders = []
    const smokeTierMaps = []
    if (readyJobs.length >= 2) {
      const smokeVariants = [
        readyJobs,
        seededShuffle(readyJobs, seed + 1),
        [...readyJobs].reverse(),
      ]
      for (const variantJobs of smokeVariants) {
        const res = await triageBatchWithLlm({
          llm: buildMockLlm(primaryMock),
          config: { model: currentModel, sendToModel: true },
          jobs: variantJobs,
          profile,
          resumeText,
          locale,
        })
        const sorted = sortStage2Results(res)
        smokeOrders.push(sorted.map(x => x.opportunityId))
        smokeTierMaps.push(Object.fromEntries(sorted.map(x => [x.opportunityId, x.tier])))
      }
    }
    const orderInvariance = smokeOrders.length >= 2 ? computeRankStability(smokeOrders, smokeTierMaps) : null

    const noiseIds = new Set(persona?.noiseIds || [])
    let emptyQuoteOnPositiveCount = 0
    let unverifiedQuoteCount = 0
    let fallbackScoreAcceptedAsLlmCount = 0
    let noiseInTopCount = 0
    for (const r of primaryResults) {
      const rawSpec = primaryMock[r.opportunityId]
      if (r.mode === 'llm' && !r.roleQuote && (r.tier === 'top' || r.tier === 'good')) emptyQuoteOnPositiveCount += 1
      if (r.uncertaintyCode === 'unverified_quote') unverifiedQuoteCount += 1
      if (r.mode === 'llm' && rawSpec && (rawSpec.score == null || !Number.isFinite(Number(rawSpec.score)))) fallbackScoreAcceptedAsLlmCount += 1
      if (r.tier === 'top' && noiseIds.has(r.opportunityId)) noiseInTopCount += 1
    }

    let adversarialDiagnostics = null
    if (persona?.adversarialMockResponses) {
      const advJobs = readyJobs.filter(j => Object.hasOwn(persona.adversarialMockResponses, j.id))
      const advResults = await triageBatchWithLlm({
        llm: buildMockLlm(persona.adversarialMockResponses),
        config: { model: currentModel, sendToModel: true },
        jobs: advJobs,
        profile,
        resumeText,
        locale,
      })
      adversarialDiagnostics = {
        evaluatedCount: advResults.length,
        llmMarkedCount: advResults.filter(r => r.mode === 'llm').length,
        unverifiedQuoteMarkedCount: advResults.filter(r => r.uncertaintyCode === 'unverified_quote').length,
        emptyQuoteAcceptedAsTopOrGoodCount: advResults.filter(r => r.mode === 'llm' && !r.roleQuote && (r.tier === 'top' || r.tier === 'good')).length,
        missingScoreAcceptedAsLlmCount: advResults.filter(r => {
          const spec = persona.adversarialMockResponses[r.opportunityId]
          return r.mode === 'llm' && (spec?.score == null || !Number.isFinite(Number(spec.score)))
        }).length,
        noiseInTopCount: advResults.filter(r => r.tier === 'top' && noiseIds.has(r.opportunityId)).length,
      }
    }

    const s2Ndcg10 = labelScope === 'full_pool'
      ? computeNdcgAtK(primaryOrder, judgedStage2Labels, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
      : null
    const s2Ndcg20 = labelScope === 'full_pool'
      ? computeNdcgAtK(primaryOrder, judgedStage2Labels, 20, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
      : null
    const s2P10 = computePrecisionAtK(primaryOrder, judgedStage2Labels, 10)

    const evaluatedHash = createHash('sha256').update(JSON.stringify([...primaryOrder].sort())).digest('hex').slice(0, 12)

    stage2Metrics = {
      evaluatedCount: primaryResults.length,
      evaluatedHash,
      readyConsumedCount: readyJobs.length,
      twoRoundSimulated,
      ndcgAt10: s2Ndcg10,
      ndcgAt20: s2Ndcg20,
      precisionAt10: labelScope === 'full_pool' ? s2P10.precision : null,
      precisionAmongJudgedAt10: labelScope === 'unjudged' ? null : s2P10.precisionAmongJudged,
      topShare: tierStats.topShare,
      tierEntropy: tierStats.tierEntropy,
      scoreBinEntropy: tierStats.scoreBinEntropy,
      band85To98Share: tierStats.band85To98Share,
      precisionAtTopRel2: labelScope === 'unjudged' ? null : tierStats.precisionAtTopRel2,
      tierCounts: tierStats.counts,
      orderInvarianceSmoke: orderInvariance,
      tokenMode: 'mock_estimated',
      inputTokens: round1Stage2CallTok.inputTokens,
      outputTokens: round1Stage2CallTok.outputTokens,
      totalTokens: round1Stage2CallTok.totalTokens,
      emptyQuoteOnPositiveCount,
      unverifiedQuoteCount,
      fallbackScoreAcceptedAsLlmCount,
      noiseInTopCount,
      adversarialDiagnostics,
    }
  }

  let rubricComparison = null
  if (Array.isArray(persona?.rubricItems) && persona.rubricItems.length > 0 && labelScope !== 'unjudged') {
    const rubricIds = persona.rubricItems.map(x => x.id)
    const rubricLabels = countValidNumericLabels(labelsById, rubricIds)
    const resA = rankRubricOptionA(persona.rubricItems)
    const resB = rankRubricOptionB(persona.rubricItems)
    const statsA = computeTierStats(Object.fromEntries(resA.map(x => [x.id, x])), rubricLabels)
    const statsB = computeTierStats(Object.fromEntries(resB.map(x => [x.id, x])), rubricLabels)
    const ndcgA = computeNdcgAtK(resA.map(x => x.id), rubricLabels, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
    const ndcgB = computeNdcgAtK(resB.map(x => x.id), rubricLabels, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
    rubricComparison = {
      optionA: { ndcgAt10: ndcgA, topShare: statsA.topShare, precisionAtTopRel2: statsA.precisionAtTopRel2, topIds: resA.filter(x => x.tier === 'top').map(x => x.id) },
      optionB: { ndcgAt10: ndcgB, topShare: statsB.topShare, precisionAtTopRel2: statsB.precisionAtTopRel2, topIds: resB.filter(x => x.tier === 'top').map(x => x.id) },
      deltaBMinusANdcg10: (ndcgA != null && ndcgB != null) ? ndcgB - ndcgA : null,
    }
  }

  const poolFingerprint = createHash('sha256').update(JSON.stringify({
    boards: [...activeBoards].sort(),
    opps: opportunities.map(o => `${o.id}@${jobContentFingerprint(o)}`).sort(),
    feedback: Object.keys(feedbackMap).sort().map(k => [k, feedbackMap[k]?.status]),
    labels: Object.keys(labelsById).sort().map(k => [k, labelsById[k]]),
  })).digest('hex').slice(0, 12)

  return {
    personaId: String(persona?.id || 'unknown'),
    locale,
    snapshotFingerprint: profile.fingerprint,
    poolFingerprint,
    sendToModelFalseCalls: sendFalseCalls.length,
    stage1: stage1Metrics,
    stage2: stage2Metrics,
    rubricComparison,
  }
}

function avgFinite(values) {
  const valid = values.filter(v => Number.isFinite(v))
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

/**
 * Evaluate a dataset containing one or more personas without reading any user home directory.
 */
export async function evaluateDataset(dataset, {
  seed = 42,
  limit = 30,
  rounds = FROZEN_EVAL_SNAPSHOT.defaultRounds,
  baselineCommit = null,
} = {}) {
  const personas = Array.isArray(dataset?.personas) ? dataset.personas : (dataset?.opportunities ? [dataset] : [])
  if (!personas.length) {
    throw new TypeError('Dataset must include a non-empty `personas` array or `opportunities` array.')
  }
  const perRoundLimit = Math.min(FROZEN_EVAL_SNAPSHOT.batchLimit, Math.max(1, Math.floor(Number(limit) || 30)))
  const roundCount = Math.max(1, Math.min(2, Math.floor(Number(rounds) || FROZEN_EVAL_SNAPSHOT.defaultRounds)))
  const datasetHash = createHash('sha256').update(JSON.stringify(dataset)).digest('hex').slice(0, 12)

  const results = []
  for (const persona of personas) {
    results.push(await evaluatePersona(persona, { seed, limit: perRoundLimit, rounds: roundCount }))
  }

  const totalHardLeaks = results.reduce((s, r) => s
    + r.stage1.closedLeakCount
    + r.stage1.dismissedLeakCount
    + r.stage1.inactiveBoardLeakCount
    + r.stage1.trackedLeakCount
    + r.stage1.nonHydratableMissingJdLeakCount
    + r.stage1.expectedExplicitExcludeLeakCount, 0)

  const stage1Summary = {
    personaCount: results.length,
    totalOpenPool: results.reduce((s, r) => s + r.stage1.openPoolCount, 0),
    totalMissingJd: results.reduce((s, r) => s + r.stage1.missingJdCount, 0),
    totalIrrelevant: results.reduce((s, r) => s + r.stage1.irrelevantCount, 0),
    avgRecallAt30Pool: avgFinite(results.map(r => r.stage1.recallAt30Pool)),
    avgRecallAt60Pool: avgFinite(results.map(r => r.stage1.recallAt60Pool)),
    avgSelectionRecallAt30: avgFinite(results.map(r => r.stage1.selectionRecallAt30)),
    avgSelectionRecallAt60: avgFinite(results.map(r => r.stage1.selectionRecallAt60)),
    avgWithinJudgedHitRate: avgFinite(results.map(r => r.stage1.withinJudgedHitRate)),
    avgPrecisionAmongJudgedAt10: avgFinite(results.map(r => r.stage1.precisionAmongJudgedAt10)),
    avgNdcgAt10: avgFinite(results.map(r => r.stage1.ndcgAt10)),
    avgNdcgAt20: avgFinite(results.map(r => r.stage1.ndcgAt20)),
    avgPrecisionAt10: avgFinite(results.map(r => r.stage1.precisionAt10)),
    maxPerRoundSelectedCount: Math.max(...results.map(r => r.stage1.maxRoundSelectedCount)),
    maxTwoRoundSelectedCount: Math.max(...results.map(r => r.stage1.twoRoundSelectedCount)),
    maxHeuristicScore: Math.max(...results.map(r => r.stage1.heuristicScoreMax ?? 0)),
    totalHardLeaks,
    sendToModelFalseCalls: results.reduce((s, r) => s + r.sendToModelFalseCalls, 0),
    totalLatencyMs: Number(results.reduce((s, r) => s + r.stage1.latencyMs, 0).toFixed(2)),
  }

  const withStage2 = results.filter(r => r.stage2)
  const stage2Summary = withStage2.length
    ? {
        personaCount: withStage2.length,
        tokenMode: 'mock_estimated',
        avgNdcgAt10: avgFinite(withStage2.map(r => r.stage2.ndcgAt10)),
        avgNdcgAt20: avgFinite(withStage2.map(r => r.stage2.ndcgAt20)),
        avgPrecisionAt10: avgFinite(withStage2.map(r => r.stage2.precisionAt10)),
        avgTopShare: avgFinite(withStage2.map(r => r.stage2.topShare)),
        minOrderInvarianceTauB: Math.min(...withStage2.map(r => r.stage2.orderInvarianceSmoke?.tauBMin ?? 1)),
        totalTokens: withStage2.reduce((s, r) => s + (r.stage2.totalTokens || 0), 0),
      }
    : null

  return {
    snapshot: {
      ...FROZEN_EVAL_SNAPSHOT,
      seed,
      limit: perRoundLimit,
      rounds: roundCount,
      datasetHash,
      evalCommit: resolveCurrentCommitSha(),
      baselineCommit: baselineCommit || null,
      hasStage2: Boolean(stage2Summary),
      personaKeys: results.map(p => `${p.personaId}:${p.snapshotFingerprint}:${p.poolFingerprint}:${p.stage1.labelScope}`),
      generatedAt: new Date().toISOString(),
    },
    stage1Summary,
    stage2Summary,
    personas: results,
  }
}

/**
 * Validate strict experiment identity comparability before emitting paired deltas.
 */
export function checkReportComparability(baselineReport, candidateReport) {
  const reasons = []
  const baseSnap = baselineReport?.snapshot || {}
  const candSnap = candidateReport?.snapshot || {}
  if (!baselineReport || !candidateReport) {
    return { comparable: false, reasons: ['missing baseline or candidate report'] }
  }
  if (baseSnap.datasetHash !== candSnap.datasetHash) {
    reasons.push(`datasetHash mismatch (${baseSnap.datasetHash} vs ${candSnap.datasetHash})`)
  }
  if (baseSnap.seed !== candSnap.seed) {
    reasons.push(`seed mismatch (${baseSnap.seed} vs ${candSnap.seed})`)
  }
  if (baseSnap.limit !== candSnap.limit || baseSnap.rounds !== candSnap.rounds) {
    reasons.push(`budget mismatch (limit=${baseSnap.limit}/rounds=${baseSnap.rounds} vs limit=${candSnap.limit}/rounds=${candSnap.rounds})`)
  }
  const baseHasS2 = Boolean(baselineReport.stage2Summary)
  const candHasS2 = Boolean(candidateReport.stage2Summary)
  if (baseHasS2 !== candHasS2) {
    reasons.push(`stage mismatch (baseline hasStage2=${baseHasS2} vs candidate hasStage2=${candHasS2})`)
  }
  const baseKeys = Array.isArray(baseSnap.personaKeys) ? baseSnap.personaKeys : []
  const candKeys = Array.isArray(candSnap.personaKeys) ? candSnap.personaKeys : []
  if (JSON.stringify(baseKeys) !== JSON.stringify(candKeys)) {
    reasons.push('persona snapshot/pool/labelScope mismatch')
  }
  const basePersonas = Array.isArray(baselineReport.personas) ? baselineReport.personas : []
  const candPersonas = Array.isArray(candidateReport.personas) ? candidateReport.personas : []
  const candById = new Map(candPersonas.map(p => [p.personaId, p]))
  for (const bp of basePersonas) {
    const cp = candById.get(bp.personaId)
    if (!cp) continue
    if (Boolean(bp.stage2) !== Boolean(cp.stage2)) {
      reasons.push(`persona stage mismatch (${bp.personaId}: baseline hasStage2=${Boolean(bp.stage2)} vs candidate hasStage2=${Boolean(cp.stage2)})`)
    }
  }
  return {
    comparable: reasons.length === 0,
    reasons,
    baselineCommit: baseSnap.evalCommit || 'unknown',
    candidateCommit: candSnap.evalCommit || 'unknown',
  }
}

function pairedMetricDiff(pairs, getter) {
  const diffs = []
  for (const [b, c] of pairs) {
    const bv = getter(b)
    const cv = getter(c)
    if (Number.isFinite(bv) && Number.isFinite(cv)) {
      diffs.push(cv - bv)
    }
  }
  return {
    delta: diffs.length > 0 ? diffs.reduce((s, d) => s + d, 0) / diffs.length : null,
    pairs: diffs.length,
  }
}

export function compareReports(baselineReport, candidateReport) {
  const check = checkReportComparability(baselineReport, candidateReport)
  if (!check.comparable) {
    return { ...check, stage1Delta: null, stage2Delta: null }
  }
  const basePersonas = Array.isArray(baselineReport.personas) ? baselineReport.personas : []
  const candById = new Map((Array.isArray(candidateReport.personas) ? candidateReport.personas : []).map(p => [p.personaId, p]))
  const personaPairs = basePersonas
    .map(bp => [bp, candById.get(bp.personaId)])
    .filter(([, cp]) => Boolean(cp))

  const stage1Delta = {
    pairCount: personaPairs.length,
    deltaRecallAt30: pairedMetricDiff(personaPairs, p => p.stage1?.selectionRecallAt30),
    deltaRecallAt60: pairedMetricDiff(personaPairs, p => p.stage1?.selectionRecallAt60),
    deltaRecallAt60Pool: pairedMetricDiff(personaPairs, p => p.stage1?.recallAt60Pool),
    deltaNdcgAt10: pairedMetricDiff(personaPairs, p => p.stage1?.ndcgAt10),
    deltaNdcgAt20: pairedMetricDiff(personaPairs, p => p.stage1?.ndcgAt20),
    deltaPrecisionAt10: pairedMetricDiff(personaPairs, p => p.stage1?.precisionAt10),
    deltaWithinJudgedHitRate: pairedMetricDiff(personaPairs, p => p.stage1?.withinJudgedHitRate),
    deltaPrecisionAmongJudgedAt10: pairedMetricDiff(personaPairs, p => p.stage1?.precisionAmongJudgedAt10),
  }

  const stage2ComparablePairs = []
  const stage2IncompatiblePersonas = []
  for (const [bp, cp] of personaPairs) {
    if (!bp.stage2 && !cp.stage2) continue
    if (!bp.stage2 || !cp.stage2) {
      stage2IncompatiblePersonas.push(bp.personaId)
      continue
    }
    const baseOrderHash = bp.stage2.evaluatedHash || ''
    const candOrderHash = cp.stage2.evaluatedHash || ''
    if (!baseOrderHash || baseOrderHash !== candOrderHash || bp.stage2.evaluatedCount !== cp.stage2.evaluatedCount) {
      stage2IncompatiblePersonas.push(bp.personaId)
      continue
    }
    stage2ComparablePairs.push([bp, cp])
  }

  let stage2Delta = null
  if (stage2IncompatiblePersonas.length > 0) {
    stage2Delta = {
      comparable: false,
      reasons: [`Stage 2 evaluated set or presence differs on: ${stage2IncompatiblePersonas.join(', ')}`],
      pairCount: 0,
    }
  } else if (stage2ComparablePairs.length > 0) {
    const tokenDiff = pairedMetricDiff(stage2ComparablePairs, p => p.stage2?.totalTokens)
    const tokenSumDelta = stage2ComparablePairs.every(([b, c]) => Number.isFinite(b.stage2?.totalTokens) && Number.isFinite(c.stage2?.totalTokens))
      ? stage2ComparablePairs.reduce((s, [b, c]) => s + (c.stage2.totalTokens - b.stage2.totalTokens), 0)
      : null
    stage2Delta = {
      comparable: true,
      pairCount: stage2ComparablePairs.length,
      deltaNdcgAt10: pairedMetricDiff(stage2ComparablePairs, p => p.stage2?.ndcgAt10),
      deltaNdcgAt20: pairedMetricDiff(stage2ComparablePairs, p => p.stage2?.ndcgAt20),
      deltaPrecisionAt10: pairedMetricDiff(stage2ComparablePairs, p => p.stage2?.precisionAt10),
      deltaTopShare: pairedMetricDiff(stage2ComparablePairs, p => p.stage2?.topShare),
      deltaTotalTokens: { delta: tokenSumDelta, pairs: tokenDiff.pairs },
    }
  }

  return { ...check, stage1Delta, stage2Delta }
}

export function formatEvalMarkdown(report, baselineReport = null) {
  const fmt = (val, digits = 3) => (Number.isFinite(val) ? val.toFixed(digits) : 'n/a')
  const fmtPaired = (entry, digits = 4) => (entry && Number.isFinite(entry.delta) ? `${entry.delta.toFixed(digits)} (n=${entry.pairs})` : `n/a (n=${entry?.pairs ?? 0})`)
  const pct = val => (Number.isFinite(val) ? `${(val * 100).toFixed(1)}%` : 'n/a')
  const lines = [
    `# Offline Triage Evaluation Report (${report.snapshot.datasetHash})`,
    '',
    `- Snapshot v${report.snapshot.schemaVersion} | commit=${report.snapshot.evalCommit} | perRoundLimit=${report.snapshot.limit} | rounds=${report.snapshot.rounds} | seed=${report.snapshot.seed}`,
    `- Stage 1 hard leaks: ${report.stage1Summary.totalHardLeaks} | sendToModel=false LLM calls (triageBatchWithLlm mock stream only): ${report.stage1Summary.sendToModelFalseCalls} | latency=${report.stage1Summary.totalLatencyMs}ms`,
    '',
    '| Persona | Scope | Pool | R1/R2 Sel | Recall@60 (Pool) | Sel R@60 | NDCG@10 | JudgedHits (Cov) | MissingJD / Irrel | Leaks |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const p of report.personas) {
    const s = p.stage1
    const leaks = s.closedLeakCount
      + s.dismissedLeakCount
      + s.inactiveBoardLeakCount
      + s.trackedLeakCount
      + s.nonHydratableMissingJdLeakCount
      + s.expectedExplicitExcludeLeakCount
    const judgedDisplay = s.labelScope === 'unjudged'
      ? `0 (${pct(s.labelCoverage)})`
      : `${s.judgedHitsTwoRounds ?? s.judgedHitsRound1 ?? 0}/${s.judgedRelevantTotal} (${pct(s.labelCoverage)})`
    lines.push(
      `| ${p.personaId} | ${s.labelScope} | ${s.openPoolCount} | ${s.round1SelectedCount}/${s.round2SelectedCount} | ${pct(s.recallAt60Pool)} | ${pct(s.selectionRecallAt60)} | ${fmt(s.ndcgAt10)} | ${judgedDisplay} | ${s.missingJdCount} / ${s.irrelevantCount} | ${leaks} |`,
    )
  }

  if (report.stage2Summary) {
    lines.push('', '## Stage 2 Mock Replay Summary', '',
      '| Persona | Eval N | NDCG@10 | P@Top (>=2) | Top Share | Order-Inv Smoke | Mock Est Tokens | Adv MissingQuote->LLM | Adv MissingScore->LLM |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const p of report.personas) {
      if (!p.stage2) continue
      const s2 = p.stage2
      const adv = s2.adversarialDiagnostics
      lines.push(
        `| ${p.personaId} | ${s2.evaluatedCount} | ${fmt(s2.ndcgAt10)} | ${pct(s2.precisionAtTopRel2)} | ${pct(s2.topShare)} | ${fmt(s2.orderInvarianceSmoke?.tauBMin)} | ${s2.totalTokens} | ${adv ? adv.emptyQuoteAcceptedAsTopOrGoodCount : 'n/a'} | ${adv ? adv.missingScoreAcceptedAsLlmCount : 'n/a'} |`,
      )
    }
  }

  if (baselineReport) {
    const cmp = compareReports(baselineReport, report)
    if (!cmp.comparable) {
      lines.push('', '## Paired Delta vs Baseline', '',
        `- Not comparable (${cmp.baselineCommit} -> ${cmp.candidateCommit}): ${cmp.reasons.join('; ')}`)
    } else {
      lines.push('', `## Paired Delta vs Baseline (${cmp.baselineCommit} -> ${cmp.candidateCommit})`, '')
      if (cmp.stage1Delta) {
        lines.push(`- Stage 1: deltaSelR@30=${fmtPaired(cmp.stage1Delta.deltaRecallAt30)} | deltaSelR@60=${fmtPaired(cmp.stage1Delta.deltaRecallAt60)} | deltaNdcg@10=${fmtPaired(cmp.stage1Delta.deltaNdcgAt10)} | deltaP@10=${fmtPaired(cmp.stage1Delta.deltaPrecisionAt10)} | deltaJudgedHitRate=${fmtPaired(cmp.stage1Delta.deltaWithinJudgedHitRate)} | deltaJudgedP@10=${fmtPaired(cmp.stage1Delta.deltaPrecisionAmongJudgedAt10)}`)
      }
      if (cmp.stage2Delta && !cmp.stage2Delta.comparable) {
        lines.push(`- Stage 2: Not comparable: ${cmp.stage2Delta.reasons.join('; ')}`)
      } else if (cmp.stage2Delta) {
        lines.push(`- Stage 2: deltaNdcg@10=${fmtPaired(cmp.stage2Delta.deltaNdcgAt10)} | deltaP@10=${fmtPaired(cmp.stage2Delta.deltaPrecisionAt10)} | deltaTopShare=${fmtPaired(cmp.stage2Delta.deltaTopShare)} | deltaMockTokens=${cmp.stage2Delta.deltaTotalTokens?.delta ?? 'n/a'} (n=${cmp.stage2Delta.deltaTotalTokens?.pairs ?? 0})`)
      }
    }
  }

  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'json' || key === 'help' || key === 'allow-any-out') {
      args[key] = true
    } else if (i + 1 < argv.length) {
      args[key] = argv[i + 1]
      i += 1
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.dataset) {
    console.error('Usage: node scripts/eval/run-eval.mjs --dataset <path> [--compare <baseline.json>] [--out <scripts/eval/reports/report.json>] [--allow-any-out] [--seed 42] [--limit 30] [--rounds 2] [--json]')
    process.exit(args.help ? 0 : 2)
  }
  const datasetPath = resolve(String(args.dataset))
  const raw = JSON.parse(await readFile(datasetPath, 'utf8'))
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 42
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 30
  const rounds = Number.isFinite(Number(args.rounds)) ? Number(args.rounds) : FROZEN_EVAL_SNAPSHOT.defaultRounds
  const baseline = args.compare ? JSON.parse(await readFile(resolve(String(args.compare)), 'utf8')) : null
  const report = await evaluateDataset(raw, {
    seed,
    limit,
    rounds,
    baselineCommit: baseline?.snapshot?.evalCommit || null,
  })

  if (args.out) {
    const outPath = await assertSafeRepoOutputPath(args.out, DEFAULT_REPORTS_DIR, {
      allowAnyOut: Boolean(args['allow-any-out']),
      requireGitIgnored: true,
    })
    await writePrivateJsonFile(outPath, report)
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatEvalMarkdown(report, baseline))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
