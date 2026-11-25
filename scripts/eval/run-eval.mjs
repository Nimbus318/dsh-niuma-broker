import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
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

export const FROZEN_EVAL_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  resumeSentMaxChars: 2200,
  jdMaxChars: 12000,
  batchLimit: 30,
  ndcgGains: [0, 1, 3, 7],
})

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
  if (Array.isArray(persona?.boards) && persona.boards.length > 0) {
    return new Set(
      persona.boards.map(b => (typeof b === 'string' ? b : `${b.provider}:${b.slug}`)),
    )
  }
  return new Set(opportunities.map(o => o?.sourceId).filter(Boolean))
}

function buildMockLlm(responseMap = {}, callLog = []) {
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
            const spec = responseMap[j.id]
            return spec ? { id: j.id, ...spec } : null
          })
          .filter(Boolean)
        const inTok = Math.max(120, Math.round(raw.length / 3))
        const text = JSON.stringify({ items })
        const outTok = Math.max(30, Math.round(text.length / 3))
        callLog.push({ jobIds: jobs.map(j => j.id), inTok, outTok })
        yield { type: 'text-delta', text }
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          usage: {
            inputTokens: inTok,
            outputTokens: outTok,
            totalTokens: inTok + outTok,
            reasoningTokens: 0,
          },
        }
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

async function evaluatePersona(persona, { seed = 42, limit = 30 } = {}) {
  const opportunities = Array.isArray(persona?.opportunities) ? persona.opportunities : []
  const labelsById = persona?.labels || {}
  const feedbackMap = persona?.feedback || {}
  const receiptsByOpp = buildReceiptsMap(persona?.receipts)
  const activeBoards = resolveActiveBoards(persona, opportunities)
  const locale = persona?.locale === 'en' ? 'en' : 'zh'
  const resumeText = String(persona?.resumeText || '')

  const profile = buildPatrolSearchProfile({
    resumeText,
    goal: persona?.goal || '',
    searchTerms: persona?.searchTerms || [],
    evidence: persona?.evidence || [],
    feedback: feedbackMap,
  })

  // Stage 1: score every item cleanly & inspect hard-filter invariants
  const t0 = performance.now()
  const heurMap = new Map()
  const openFullJdRows = []
  for (const job of opportunities) {
    if (!job?.id) continue
    const h = scoreOpportunityHeuristic(job, profile, locale)
    heurMap.set(job.id, h)
    if (job.closedAt || feedbackMap[job.id]?.status === 'dismissed') continue
    if (!isOpportunityJdIncomplete(job)) {
      openFullJdRows.push({ job, match: h })
    }
  }
  openFullJdRows.sort((a, b) => (b.match.score - a.match.score)
    || String(b.job.verifiedAt || b.job.firstSeenAt || '').localeCompare(String(a.job.verifiedAt || a.job.firstSeenAt || ''))
    || String(a.job.id).localeCompare(String(b.job.id)))

  const fullPoolRankedIds = openFullJdRows.map(r => r.job.id)
  const selectionPlan = selectTriageCandidates({
    opportunities,
    activeBoards,
    feedbackMap,
    receiptsByOpp,
    existingMatches: {},
    profile,
    locale,
    limit,
  })
  const stage1Ms = Number((performance.now() - t0).toFixed(2))

  const selected = selectionPlan.needsReviewCandidates || []
  const selectedIds = selected.map(j => j.id)

  let closedLeakCount = 0
  let dismissedLeakCount = 0
  let explicitAvoidLeakCount = 0
  let nonHydratableMissingJdLeakCount = 0
  for (const job of selected) {
    if (job.closedAt) closedLeakCount += 1
    if (feedbackMap[job.id]?.status === 'dismissed') dismissedLeakCount += 1
    const h = heurMap.get(job.id)
    if (h?.breakdown?.some(f => f.explicitExclude === true)) explicitAvoidLeakCount += 1
    if (isOpportunityJdIncomplete(job) && !canFetchOpportunityDetail(job)) nonHydratableMissingJdLeakCount += 1
  }

  const heurScores = openFullJdRows.map(r => r.match.score)
  const heuristicScoreMax = heurScores.length ? Math.max(...heurScores) : null
  const heuristicTierStats = computeTierStats(
    Object.fromEntries(openFullJdRows.map(r => [r.job.id, r.match])),
    labelsById,
  )

  const stage1Metrics = {
    openPoolCount: openFullJdRows.length,
    selectedCount: selectedIds.length,
    recallAt30Pool: computeRecallAtK(fullPoolRankedIds, labelsById, 30).recall,
    recallAt60Pool: computeRecallAtK(fullPoolRankedIds, labelsById, 60).recall,
    selectionRecallAt30: computeRecallAtK(selectedIds, labelsById, 30).recall,
    selectionTopRecallAt30: computeRecallAtK(selectedIds, labelsById, 30, { minRel: 3 }).recall,
    ndcgAt10: computeNdcgAtK(fullPoolRankedIds, labelsById, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg,
    ndcgAt20: computeNdcgAtK(fullPoolRankedIds, labelsById, 20, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg,
    precisionAt10: computePrecisionAtK(fullPoolRankedIds, labelsById, 10).precision,
    heuristicScoreMax,
    heuristicTierCounts: heuristicTierStats.counts,
    closedLeakCount,
    dismissedLeakCount,
    explicitAvoidLeakCount,
    nonHydratableMissingJdLeakCount,
    latencyMs: stage1Ms,
  }

  // Verify sendToModel=false makes zero LLM calls
  const sendFalseCalls = []
  await triageBatchWithLlm({
    llm: buildMockLlm(persona?.mockLlmResponses || {}, sendFalseCalls),
    config: { model: 'eval-mock:deterministic', sendToModel: false },
    jobs: selected,
    profile,
    resumeText,
    locale,
  })

  // Stage 2 replay (normal + shuffled order + optional adversarial audit)
  let stage2Metrics = null
  const replayMaps = []
  if (persona?.mockLlmResponses && Object.keys(persona.mockLlmResponses).length > 0) {
    replayMaps.push({ name: 'primary', map: persona.mockLlmResponses })
  }
  if (persona?.adversarialMockResponses && Object.keys(persona.adversarialMockResponses).length > 0) {
    replayMaps.push({ name: 'adversarial', map: persona.adversarialMockResponses })
  }

  if (replayMaps.length > 0) {
    const primarySpec = replayMaps[0].map
    const baseJobs = openFullJdRows.map(r => r.job).filter(j => Object.hasOwn(primarySpec, j.id))
    const runOrders = []
    const tierMaps = []
    let primaryResults = []
    let primaryMetricsOut = {}

    const variants = [
      baseJobs,
      seededShuffle(baseJobs, seed + 1),
      [...baseJobs].reverse(),
    ]
    for (let v = 0; v < variants.length; v += 1) {
      const mOut = {}
      const results = await triageBatchWithLlm({
        llm: buildMockLlm(primarySpec),
        config: { model: 'eval-mock:deterministic', sendToModel: true },
        jobs: variants[v],
        profile,
        resumeText,
        locale,
        metricsOut: mOut,
      })
      const sorted = sortStage2Results(results)
      runOrders.push(sorted.map(r => r.opportunityId))
      tierMaps.push(Object.fromEntries(sorted.map(r => [r.opportunityId, r.tier])))
      if (v === 0) {
        primaryResults = sorted
        primaryMetricsOut = mOut
      }
    }

    const byId = Object.fromEntries(primaryResults.map(r => [r.opportunityId, r]))
    const primaryOrder = runOrders[0]
    const tierStats = computeTierStats(byId, labelsById)
    const stability = computeRankStability(runOrders, tierMaps)

    // Diagnostics checking quote/fallback/noise leaks under current pipeline
    const noiseIds = new Set(persona?.noiseIds || [])
    let emptyQuoteOnPositiveCount = 0
    let unverifiedQuoteCount = 0
    let fallbackScoreAcceptedAsLlmCount = 0
    let noiseInTopCount = 0
    for (const r of primaryResults) {
      const rawSpec = primarySpec[r.opportunityId]
      if (r.mode === 'llm' && !r.roleQuote && (r.tier === 'top' || r.tier === 'good')) emptyQuoteOnPositiveCount += 1
      if (r.uncertaintyCode === 'unverified_quote') unverifiedQuoteCount += 1
      if (r.mode === 'llm' && rawSpec && (rawSpec.score == null || !Number.isFinite(Number(rawSpec.score)))) fallbackScoreAcceptedAsLlmCount += 1
      if (r.tier === 'top' && noiseIds.has(r.opportunityId)) noiseInTopCount += 1
    }

    let adversarialDiagnostics = null
    if (persona?.adversarialMockResponses) {
      const advJobs = openFullJdRows.map(r => r.job).filter(j => Object.hasOwn(persona.adversarialMockResponses, j.id))
      const advResults = await triageBatchWithLlm({
        llm: buildMockLlm(persona.adversarialMockResponses),
        config: { model: 'eval-mock:deterministic', sendToModel: true },
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

    stage2Metrics = {
      evaluatedCount: primaryResults.length,
      ndcgAt10: computeNdcgAtK(primaryOrder, labelsById, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg,
      ndcgAt20: computeNdcgAtK(primaryOrder, labelsById, 20, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg,
      precisionAt10: computePrecisionAtK(primaryOrder, labelsById, 10).precision,
      topShare: tierStats.topShare,
      tierEntropy: tierStats.tierEntropy,
      scoreBinEntropy: tierStats.scoreBinEntropy,
      band85To98Share: tierStats.band85To98Share,
      precisionAtTopRel2: tierStats.precisionAtTopRel2,
      tierCounts: tierStats.counts,
      stability,
      inputTokens: primaryMetricsOut.inputTokens || 0,
      outputTokens: primaryMetricsOut.outputTokens || 0,
      totalTokens: primaryMetricsOut.totalTokens || 0,
      emptyQuoteOnPositiveCount,
      unverifiedQuoteCount,
      fallbackScoreAcceptedAsLlmCount,
      noiseInTopCount,
      adversarialDiagnostics,
    }
  }

  // Optional Rubric Option A vs Option B comparison on annotated items
  let rubricComparison = null
  if (Array.isArray(persona?.rubricItems) && persona.rubricItems.length > 0) {
    const resA = rankRubricOptionA(persona.rubricItems)
    const resB = rankRubricOptionB(persona.rubricItems)
    const statsA = computeTierStats(Object.fromEntries(resA.map(x => [x.id, x])), labelsById)
    const statsB = computeTierStats(Object.fromEntries(resB.map(x => [x.id, x])), labelsById)
    const orderA = resA.map(x => x.id)
    const orderB = resB.map(x => x.id)
    const ndcgA = computeNdcgAtK(orderA, labelsById, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
    const ndcgB = computeNdcgAtK(orderB, labelsById, 10, { gains: FROZEN_EVAL_SNAPSHOT.ndcgGains }).ndcg
    rubricComparison = {
      optionA: { ndcgAt10: ndcgA, topShare: statsA.topShare, precisionAtTopRel2: statsA.precisionAtTopRel2, topIds: resA.filter(x => x.tier === 'top').map(x => x.id) },
      optionB: { ndcgAt10: ndcgB, topShare: statsB.topShare, precisionAtTopRel2: statsB.precisionAtTopRel2, topIds: resB.filter(x => x.tier === 'top').map(x => x.id) },
      deltaBMinusANdcg10: (ndcgA != null && ndcgB != null) ? ndcgB - ndcgA : null,
    }
  }

  return {
    personaId: String(persona?.id || 'unknown'),
    locale,
    snapshotFingerprint: profile.fingerprint,
    sendToModelFalseCalls: sendFalseCalls.length,
    stage1: stage1Metrics,
    stage2: stage2Metrics,
    rubricComparison,
    itemFingerprints: opportunities.slice(0, 50).map(o => ({ id: o.id, fp: jobContentFingerprint(o) })),
  }
}

function avgFinite(values) {
  const valid = values.filter(v => Number.isFinite(v))
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

/**
 * Evaluate a dataset containing one or more personas without reading any user home directory.
 */
export async function evaluateDataset(dataset, { seed = 42, limit = 30 } = {}) {
  const personas = Array.isArray(dataset?.personas) ? dataset.personas : (dataset?.opportunities ? [dataset] : [])
  if (!personas.length) {
    throw new TypeError('Dataset must include a non-empty `personas` array or `opportunities` array.')
  }
  const datasetHash = createHash('sha256').update(JSON.stringify(dataset)).digest('hex').slice(0, 12)
  const results = []
  for (const persona of personas) {
    results.push(await evaluatePersona(persona, { seed, limit }))
  }

  const stage1Summary = {
    personaCount: results.length,
    totalOpenPool: results.reduce((s, r) => s + r.stage1.openPoolCount, 0),
    avgRecallAt30Pool: avgFinite(results.map(r => r.stage1.recallAt30Pool)),
    avgRecallAt60Pool: avgFinite(results.map(r => r.stage1.recallAt60Pool)),
    avgSelectionRecallAt30: avgFinite(results.map(r => r.stage1.selectionRecallAt30)),
    avgNdcgAt10: avgFinite(results.map(r => r.stage1.ndcgAt10)),
    avgNdcgAt20: avgFinite(results.map(r => r.stage1.ndcgAt20)),
    avgPrecisionAt10: avgFinite(results.map(r => r.stage1.precisionAt10)),
    maxSelectedCount: Math.max(...results.map(r => r.stage1.selectedCount)),
    maxHeuristicScore: Math.max(...results.map(r => r.stage1.heuristicScoreMax ?? 0)),
    totalHardLeaks: results.reduce((s, r) => s
      + r.stage1.closedLeakCount
      + r.stage1.dismissedLeakCount
      + r.stage1.explicitAvoidLeakCount
      + r.stage1.nonHydratableMissingJdLeakCount, 0),
    sendToModelFalseCalls: results.reduce((s, r) => s + r.sendToModelFalseCalls, 0),
    totalLatencyMs: Number(results.reduce((s, r) => s + r.stage1.latencyMs, 0).toFixed(2)),
  }

  const withStage2 = results.filter(r => r.stage2)
  const stage2Summary = withStage2.length
    ? {
        personaCount: withStage2.length,
        avgNdcgAt10: avgFinite(withStage2.map(r => r.stage2.ndcgAt10)),
        avgNdcgAt20: avgFinite(withStage2.map(r => r.stage2.ndcgAt20)),
        avgPrecisionAt10: avgFinite(withStage2.map(r => r.stage2.precisionAt10)),
        avgTopShare: avgFinite(withStage2.map(r => r.stage2.topShare)),
        minStabilityTauB: Math.min(...withStage2.map(r => r.stage2.stability?.tauBMin ?? 1)),
        totalTokens: withStage2.reduce((s, r) => s + (r.stage2.totalTokens || 0), 0),
      }
    : null

  return {
    snapshot: { ...FROZEN_EVAL_SNAPSHOT, seed, limit, datasetHash, generatedAt: new Date().toISOString() },
    stage1Summary,
    stage2Summary,
    personas: results,
  }
}

export function formatEvalMarkdown(report, baselineReport = null) {
  const fmt = (val, digits = 3) => (Number.isFinite(val) ? val.toFixed(digits) : 'n/a')
  const pct = val => (Number.isFinite(val) ? `${(val * 100).toFixed(1)}%` : 'n/a')
  const lines = [
    `# Offline Triage Evaluation Report (${report.snapshot.datasetHash})`,
    '',
    `- Snapshot schema: v${report.snapshot.schemaVersion} | resumeSentMaxChars=${report.snapshot.resumeSentMaxChars} | limit=${report.snapshot.limit} | seed=${report.snapshot.seed}`,
    `- Stage 1 hard leaks: ${report.stage1Summary.totalHardLeaks} | sendToModel=false LLM calls: ${report.stage1Summary.sendToModelFalseCalls} | latency=${report.stage1Summary.totalLatencyMs}ms`,
    '',
    '| Persona | Pool | Sel | Recall@30 (Pool) | Recall@60 (Pool) | Sel Recall@30 | NDCG@10 | P@10 | Max Heur | Leaks |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const p of report.personas) {
    const s = p.stage1
    const leaks = s.closedLeakCount + s.dismissedLeakCount + s.explicitAvoidLeakCount + s.nonHydratableMissingJdLeakCount
    lines.push(
      `| ${p.personaId} | ${s.openPoolCount} | ${s.selectedCount} | ${pct(s.recallAt30Pool)} | ${pct(s.recallAt60Pool)} | ${pct(s.selectionRecallAt30)} | ${fmt(s.ndcgAt10)} | ${pct(s.precisionAt10)} | ${s.heuristicScoreMax ?? 'n/a'} | ${leaks} |`,
    )
  }

  if (report.stage2Summary) {
    lines.push('', '## Stage 2 Mock/Replay Summary', '',
      '| Persona | Eval N | NDCG@10 | P@10 | Top Share | Tau-b Min | Tokens | Adv MissingQuote->LLM | Adv MissingScore->LLM |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const p of report.personas) {
      if (!p.stage2) continue
      const s2 = p.stage2
      const adv = s2.adversarialDiagnostics
      lines.push(
        `| ${p.personaId} | ${s2.evaluatedCount} | ${fmt(s2.ndcgAt10)} | ${pct(s2.precisionAt10)} | ${pct(s2.topShare)} | ${fmt(s2.stability?.tauBMin)} | ${s2.totalTokens} | ${adv ? adv.emptyQuoteAcceptedAsTopOrGoodCount : 'n/a'} | ${adv ? adv.missingScoreAcceptedAsLlmCount : 'n/a'} |`,
      )
    }
  }

  if (baselineReport) {
    const delta = compareRunsPaired(
      {
        recallAt30: baselineReport.stage1Summary?.avgSelectionRecallAt30,
        recallAt60: baselineReport.stage1Summary?.avgRecallAt60Pool,
        ndcgAt10: baselineReport.stage2Summary?.avgNdcgAt10 ?? baselineReport.stage1Summary?.avgNdcgAt10,
        ndcgAt20: baselineReport.stage2Summary?.avgNdcgAt20 ?? baselineReport.stage1Summary?.avgNdcgAt20,
        precisionAt10: baselineReport.stage2Summary?.avgPrecisionAt10 ?? baselineReport.stage1Summary?.avgPrecisionAt10,
        topShare: baselineReport.stage2Summary?.avgTopShare,
        totalTokens: baselineReport.stage2Summary?.totalTokens,
      },
      {
        recallAt30: report.stage1Summary?.avgSelectionRecallAt30,
        recallAt60: report.stage1Summary?.avgRecallAt60Pool,
        ndcgAt10: report.stage2Summary?.avgNdcgAt10 ?? report.stage1Summary?.avgNdcgAt10,
        ndcgAt20: report.stage2Summary?.avgNdcgAt20 ?? report.stage1Summary?.avgNdcgAt20,
        precisionAt10: report.stage2Summary?.avgPrecisionAt10 ?? report.stage1Summary?.avgPrecisionAt10,
        topShare: report.stage2Summary?.avgTopShare,
        totalTokens: report.stage2Summary?.totalTokens,
      },
    )
    lines.push('', '## Paired Delta vs Baseline', '',
      `- deltaSelectionRecallAt30: ${fmt(delta.deltaRecallAt30, 4)} | deltaRecallAt60Pool: ${fmt(delta.deltaRecallAt60, 4)} | deltaNdcgAt10: ${fmt(delta.deltaNdcgAt10, 4)} | deltaPrecisionAt10: ${fmt(delta.deltaPrecisionAt10, 4)} | deltaTokens: ${delta.deltaTotalTokens ?? 'n/a'}`)
  }

  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'json' || key === 'help') {
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
    console.error('Usage: node scripts/eval/run-eval.mjs --dataset <path> [--compare <baseline.json>] [--out <report.json>] [--seed 42] [--limit 30] [--json]')
    process.exit(args.help ? 0 : 2)
  }
  const datasetPath = resolve(String(args.dataset))
  const raw = JSON.parse(await readFile(datasetPath, 'utf8'))
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 42
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 30
  const report = await evaluateDataset(raw, { seed, limit })
  const baseline = args.compare ? JSON.parse(await readFile(resolve(String(args.compare)), 'utf8')) : null

  if (args.out) {
    const outPath = resolve(String(args.out))
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
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
