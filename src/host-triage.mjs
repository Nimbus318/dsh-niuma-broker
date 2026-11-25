import { createHash, randomUUID } from 'node:crypto'
import { organizeResumeVersions } from './resume-versions.mjs'
import { normalizeLocale } from './i18n/index.mjs'
import {
  MATCH_ZONE_RANK,
  TIER_RANK,
  buildMissingJdMatch,
  buildPatrolSearchProfile,
  buildTriageSharedPayload,
  estimateTriageBatchTokens,
  isOpportunityJdIncomplete,
  isStage0HardExcluded,
  jobContentFingerprint,
  normalizeJdForTriage,
  rankPendingOpportunitiesBm25f,
  resolveTriageModelBudget,
  scoreOpportunityHeuristic,
  selectTriageCandidates,
  triageBatchWithLlm,
} from './job-triage.mjs'

export const TRIAGE_PREVIEW_TTL_MS = 5 * 60 * 1000

export function buildEvalBasisMeta(core, primaryResume, loc = 'zh') {
  if (!primaryResume) return { kind: 'goal' }
  const isEn = loc === 'en'
  const tree = organizeResumeVersions(core.resumes, { defaultMasterTrackId: core.defaultMasterTrackId })
  const defaultTrack = tree.masters.find(m => m.isDefault) ?? tree.masters[0] ?? null
  return {
    kind: 'resume',
    id: primaryResume.id,
    title: defaultTrack?.title || primaryResume.trackTitle || primaryResume.title || (isEn ? 'Master Resume' : '通用简历'),
    versionTag: defaultTrack?.latestApproved?.versionTag || '',
    isDefault: Boolean(defaultTrack?.isDefault),
  }
}

export function sortOpportunitiesForView({
  mappedJobs = [],
  patrolProfile,
  feedbackMap = {},
  isTrackedJob,
  isOpenListing,
  stageRank,
} = {}) {
  // Compute BM25F recall order on the exact pending_local ready corpus so list order matches triage queue order.
  const pendingReadyCorpus = mappedJobs.filter(job =>
    !isTrackedJob(job)
    && isOpenListing(job)
    && !job.closedAt
    && job.feedback?.status !== 'dismissed'
    && (job.match?.zone || 'pending_local') === 'pending_local'
    && job.match?.uncertaintyCode !== 'context_window_exceeded'
    && !isOpportunityJdIncomplete(job)
    && !isStage0HardExcluded(job, patrolProfile, feedbackMap).excluded,
  )
  const pendingBm25fRank = rankPendingOpportunitiesBm25f(pendingReadyCorpus, patrolProfile, { feedbackMap })

  return [...mappedJobs].sort((a, b) => {
    const rankDiff = stageRank(b.stage) - stageRank(a.stage)
    if (rankDiff !== 0) return rankDiff
    if (b.receiptCount !== a.receiptCount) return b.receiptCount - a.receiptCount
    const aDismissed = a.feedback?.status === 'dismissed' ? 1 : 0
    const bDismissed = b.feedback?.status === 'dismissed' ? 1 : 0
    if (aDismissed !== bDismissed) return aDismissed - bDismissed
    const aPinned = a.feedback?.status === 'pinned' ? 1 : 0
    const bPinned = b.feedback?.status === 'pinned' ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    const zoneDiff = (MATCH_ZONE_RANK[b.match?.zone] ?? 0) - (MATCH_ZONE_RANK[a.match?.zone] ?? 0)
    if (zoneDiff !== 0) return zoneDiff
    const zone = a.match?.zone || 'pending_local'
    if (zone === 'rubric_v2' || zone === 'legacy_v1') {
      const tierDiff = (TIER_RANK[b.match?.tier] ?? 0) - (TIER_RANK[a.match?.tier] ?? 0)
      if (tierDiff !== 0) return tierDiff
    }
    if (zone === 'pending_local') {
      const aBm = pendingBm25fRank.byId.get(a.id)
      const bBm = pendingBm25fRank.byId.get(b.id)
      const aReady = Boolean(aBm && !aBm.stage0?.excluded)
      const bReady = Boolean(bBm && !bBm.stage0?.excluded)
      if (aReady !== bReady) return bReady ? 1 : -1
      if (aReady && bReady && bBm.recallScore !== aBm.recallScore) {
        return bBm.recallScore - aBm.recallScore
      }
      const aRecency = String(a.verifiedAt ?? a.firstSeenAt ?? '')
      const bRecency = String(b.verifiedAt ?? b.firstSeenAt ?? '')
      if (aReady && bReady) {
        return bRecency.localeCompare(aRecency) || String(a.id).localeCompare(String(b.id))
      }
    }
    if (zone !== 'missing_jd') {
      const scoreDiff = (b.match?.score ?? 0) - (a.match?.score ?? 0)
      if (scoreDiff !== 0) return scoreDiff
    }
    return (b.lastReceiptAt ?? b.verifiedAt ?? '').localeCompare(a.lastReceiptAt ?? a.verifiedAt ?? '')
  })
}

export function createHostTriageController(deps) {
  const {
    ctx,
    store,
    getControl,
    isClosed,
    getRevision,
    activeLocale,
    defaultModelRoute,
    llmCallConfig,
    ensureOpportunityJd,
    canFetchOpportunityDetail,
    exclusive,
    commit,
    publish,
    resumeFor,
    indexByOpportunity,
    boardSourceId,
  } = deps

  let triageRun = null
  let triageAbort = null
  let triageProgress = null
  let lastTriageAt = 0
  const pendingTriagePreviews = new Map()

  function pruneTriagePreviews() {
    const nowMs = Date.now()
    for (const [tok, row] of pendingTriagePreviews.entries()) {
      if (!row || nowMs - row.createdAt > TRIAGE_PREVIEW_TTL_MS) pendingTriagePreviews.delete(tok)
    }
    while (pendingTriagePreviews.size >= 32) {
      const oldest = pendingTriagePreviews.keys().next().value
      if (!oldest) break
      pendingTriagePreviews.delete(oldest)
    }
  }

  function buildTriageSummary({ visibleFresh = [], patrolProfile, feedbackMap = {}, basisResume = null } = {}) {
    const activeFresh = visibleFresh.filter(j => j.feedback?.status !== 'dismissed')
    const isValidLlmZone = j => j.match?.zone === 'rubric_v2' || j.match?.zone === 'legacy_v1'
    const evaluatedFresh = activeFresh.filter(isValidLlmZone)
    const stage0ExcludedIds = new Set(
      activeFresh
        .filter(j => !isValidLlmZone(j) && isStage0HardExcluded(j, patrolProfile, feedbackMap).excluded)
        .map(j => j.id),
    )
    const eligiblePendingFresh = activeFresh.filter(j => !stage0ExcludedIds.has(j.id))
    const rubricV2Count = activeFresh.filter(j => j.match?.zone === 'rubric_v2').length
    const legacyCount = activeFresh.filter(j => j.match?.zone === 'legacy_v1').length
    const unreviewedCount = eligiblePendingFresh.filter(j => j.match?.zone === 'pending_local').length
    const evaluatedCount = evaluatedFresh.length
    const missingJdCount = eligiblePendingFresh.filter(j => j.match?.zone === 'missing_jd').length
    const eligibleCount = evaluatedCount + unreviewedCount + missingJdCount
    return {
      topCount: evaluatedFresh.filter(j => j.match?.tier === 'top').length,
      goodCount: evaluatedFresh.filter(j => j.match?.tier === 'good').length,
      stretchCount: evaluatedFresh.filter(j => j.match?.tier === 'stretch').length,
      skipCount: evaluatedFresh.filter(j => j.match?.tier === 'skip').length,
      dismissedCount: visibleFresh.filter(j => j.feedback?.status === 'dismissed').length,
      llmTriagedCount: visibleFresh.filter(isValidLlmZone).length,
      rubricV2Count,
      legacyCount,
      unreviewedCount,
      missingJdCount,
      evaluatedCount,
      eligibleCount,
      running: triageRun !== null,
      ...(triageRun !== null && triageProgress ? { progress: triageProgress } : {}),
      fingerprint: patrolProfile.fingerprint,
      basisResume,
    }
  }

  async function previewJobTriage({ id, limit = 30, targetJobIds = null, recheck = false, locale } = {}) {
    if (isClosed() || triageRun) {
      return {
        running: triageRun !== null,
        alreadyRunning: triageRun !== null,
        count: 0,
        confirmToken: '',
        targetJobIds: [],
        jobs: [],
      }
    }
    if (Array.isArray(targetJobIds) && targetJobIds.length === 0) {
      return {
        count: 0,
        missingJdCount: 0,
        hydratedJdCount: 0,
        minTokens: 0,
        maxTokens: 0,
        confirmToken: '',
        targetJobIds: [],
        jobs: [],
      }
    }
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const core = await store.summary()
    const primaryResume = resumeFor(core.resumes, undefined, core.defaultMasterTrackId)
    const primaryResumeText = primaryResume
      ? (await store.exportResume(primaryResume.id).catch(() => '')).slice(0, 4000)
      : ''
    const evalBasis = buildEvalBasisMeta(core, primaryResume, loc)
    const preRouteControl = getControl()
    const profile = buildPatrolSearchProfile({
      resumeText: primaryResumeText,
      goal: preRouteControl.config.goal,
      searchTerms: preRouteControl.config.searchTerms,
      evidence: core.evidence,
      feedback: preRouteControl.jobFeedback ?? {},
    })
    const fastRoute = (typeof getControl().config.model === 'string' && getControl().config.model.trim())
      || (typeof getControl().config.tabModel === 'string' && getControl().config.tabModel.trim())
      || (await defaultModelRoute().catch(() => ''))
    const control = getControl()
    const fastKind = (!control.config.model && control.config.tabModel) ? 'tab' : 'main'
    const activeBoards = new Set(control.config.boards.map(boardSourceId))
    const existing = control.jobMatches ?? {}
    const feedbackMap = control.jobFeedback ?? {}
    const normalizedId = id !== undefined ? String(id || '').trim() : ''
    const targetIdSet = normalizedId
      ? new Set([normalizedId])
      : (Array.isArray(targetJobIds) ? new Set(targetJobIds) : null)
    const effectiveLimit = targetIdSet
      ? Math.min(30, targetIdSet.size)
      : Math.min(30, Math.max(1, Number(limit) || 30))
    const effectiveRecheck = Boolean(normalizedId || recheck)
    const allowStage0Override = Boolean(normalizedId)
    const opportunitiesInput = targetIdSet
      ? control.opportunities.filter(o => o && targetIdSet.has(o.id))
      : control.opportunities
    const plan = selectTriageCandidates({
      opportunities: opportunitiesInput,
      activeBoards,
      feedbackMap,
      receiptsByOpp: indexByOpportunity(control.receipts),
      existingMatches: existing,
      profile,
      locale: loc,
      limit: effectiveLimit,
      force: true,
      recheck: effectiveRecheck,
      allowStage0Override,
      currentModel: fastRoute,
    })
    const candidates = plan.needsReviewCandidates
    const toHydrate = candidates.filter(job => isOpportunityJdIncomplete(job) && canFetchOpportunityDetail(job))
    const hydratedById = new Map()
    let hydratedJdCount = 0
    if (toHydrate.length > 0) {
      let cursor = 0
      const workerCount = Math.min(4, toHydrate.length)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < toHydrate.length && !isClosed()) {
          const job = toHydrate[cursor]
          cursor += 1
          if (!job?.id) continue
          const res = await ensureOpportunityJd(job.id, { strict: false })
          if (isClosed()) break
          if (res?.opportunity) hydratedById.set(job.id, res.opportunity)
          if (res?.changed && !isOpportunityJdIncomplete(res.opportunity)) hydratedJdCount += 1
        }
      }))
    }
    const liveControl = getControl()
    const hydratedCandidates = candidates.map(job => hydratedById.get(job.id) || job)
    const eligibleHydrated = allowStage0Override
      ? hydratedCandidates
      : hydratedCandidates.filter(job => !isStage0HardExcluded(job, profile, liveControl.jobFeedback ?? {}).excluded)
    const incompleteCandidates = eligibleHydrated.filter(job => isOpportunityJdIncomplete(job))
    const readyCandidates = eligibleHydrated.filter(job => !isOpportunityJdIncomplete(job))
    const resolvedBudget = (fastRoute && ctx.llm)
      ? await resolveTriageModelBudget({
          llm: ctx.llm,
          config: llmCallConfig(liveControl.config, fastRoute, { sendToModel: true }, { kind: fastKind }),
        }).catch(() => null)
      : null
    const tokenEst = estimateTriageBatchTokens({
      jobs: readyCandidates,
      profile,
      resumeText: primaryResumeText,
      locale: loc,
      budget: resolvedBudget,
    })
    const sharedPayloadHash = createHash('sha256')
      .update(JSON.stringify(buildTriageSharedPayload(profile, primaryResumeText)))
      .digest('hex')
    pruneTriagePreviews()
    const confirmToken = readyCandidates.length > 0 ? randomUUID() : ''
    if (confirmToken) {
      pendingTriagePreviews.set(confirmToken, {
        createdAt: Date.now(),
        profileFingerprint: profile.fingerprint,
        sharedPayloadHash,
        resumeId: primaryResume?.id || '',
        modelRoute: fastRoute,
        modelKind: fastKind,
        targetJobIds: readyCandidates.map(j => j.id),
        jobFingerprints: Object.fromEntries(readyCandidates.map(j => [j.id, jobContentFingerprint(j)])),
        force: true,
        recheck: effectiveRecheck,
        allowStage0Override,
      })
    }
    return {
      count: readyCandidates.length,
      missingJdCount: incompleteCandidates.length,
      hydratedJdCount,
      minTokens: tokenEst.minTokens,
      maxTokens: tokenEst.maxTokens,
      model: fastRoute,
      basisResume: evalBasis.kind === 'resume' ? evalBasis : null,
      confirmToken,
      targetJobIds: readyCandidates.map(j => j.id),
      jobs: readyCandidates.map(j => ({
        id: j.id,
        title: j.title || '',
        company: j.company || '',
        jdChars: normalizeJdForTriage(j.jd).length,
      })),
    }
  }

  async function runJobTriage({
    force = false,
    limit = 30,
    autoKey = '',
    locale,
    bypassCooldown = false,
    targetJobIds = null,
    recheck = false,
    allowStage0Override = false,
    skipHydration = false,
    disclosedConfirmation = null,
  } = {}) {
    if (isClosed() || triageRun) return { running: triageRun !== null, alreadyRunning: triageRun !== null, triagedCount: 0 }
    if (Array.isArray(targetJobIds) && targetJobIds.length === 0) {
      return { skipped: true, emptyTarget: true, triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0 }
    }
    const controlAtStart = getControl()
    if (!disclosedConfirmation && !controlAtStart.config.sendToModel) {
      return { skipped: true, requiresConfirmation: true, triagedCount: 0, llmScoredCount: 0 }
    }
    if (!force && !bypassCooldown && !disclosedConfirmation && Date.now() - lastTriageAt < 25_000) return { skipped: true, triagedCount: 0 }
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const targetIdSet = Array.isArray(targetJobIds) && targetJobIds.length > 0 ? new Set(targetJobIds) : null
    const effectiveLimit = targetIdSet
      ? Math.min(30, targetIdSet.size)
      : Math.min(30, Math.max(1, Number(limit) || 30))
    const atRevision = getRevision()
    const controller = new AbortController()
    triageAbort = controller
    const jobPromise = (async () => {
      try {
        if (!targetIdSet) lastTriageAt = Date.now()
        const core = await store.summary()
        const controlAfterSummary = getControl()
        const boardsPatrolOn = core.mode === 'search' && (controlAfterSummary.config.boards?.length ?? 0) > 0
        if (!force && !targetIdSet && !disclosedConfirmation && (!controlAfterSummary.config.sendToModel || !boardsPatrolOn)) {
          return { skipped: true, triagedCount: 0, llmScoredCount: 0 }
        }
        const primaryResume = resumeFor(core.resumes, undefined, core.defaultMasterTrackId)
        const primaryResumeText = primaryResume
          ? (await store.exportResume(primaryResume.id).catch(() => '')).slice(0, 4000)
          : ''
        const evalBasis = buildEvalBasisMeta(core, primaryResume, loc)
        const preRouteControl = getControl()
        const profile = buildPatrolSearchProfile({
          resumeText: primaryResumeText,
          goal: preRouteControl.config.goal,
          searchTerms: preRouteControl.config.searchTerms,
          evidence: core.evidence,
          feedback: preRouteControl.jobFeedback ?? {},
        })
        if (disclosedConfirmation) {
          const currentSharedHash = createHash('sha256')
            .update(JSON.stringify(buildTriageSharedPayload(profile, primaryResumeText)))
            .digest('hex')
          if (profile.fingerprint !== disclosedConfirmation.profileFingerprint
            || currentSharedHash !== disclosedConfirmation.sharedPayloadHash
            || (primaryResume?.id || '') !== disclosedConfirmation.resumeId) {
            return { skipped: true, requiresConfirmation: true, staleConfirmation: true, triagedCount: 0, llmScoredCount: 0 }
          }
        }
        const routeCheckControl = getControl()
        const fastRoute = (disclosedConfirmation || routeCheckControl.config.sendToModel === true)
          ? ((typeof routeCheckControl.config.model === 'string' && routeCheckControl.config.model.trim())
            || (typeof routeCheckControl.config.tabModel === 'string' && routeCheckControl.config.tabModel.trim())
            || await defaultModelRoute().catch(() => ''))
          : ''
        const control = getControl()
        const activeBoards = new Set(control.config.boards.map(boardSourceId))
        const existing = control.jobMatches ?? {}
        const feedbackMap = control.jobFeedback ?? {}
        const fastKind = (!control.config.model && control.config.tabModel) ? 'tab' : 'main'
        if (disclosedConfirmation
          && (fastRoute !== disclosedConfirmation.modelRoute || fastKind !== disclosedConfirmation.modelKind)) {
          return { skipped: true, requiresConfirmation: true, staleConfirmation: true, triagedCount: 0, llmScoredCount: 0 }
        }
        let opportunitiesInput = targetIdSet
          ? control.opportunities.filter(o => o && targetIdSet.has(o.id))
          : control.opportunities
        if (disclosedConfirmation) {
          const disclosedFps = disclosedConfirmation.jobFingerprints || {}
          opportunitiesInput = opportunitiesInput.filter(job =>
            job
            && !isOpportunityJdIncomplete(job)
            && Boolean(disclosedFps[job.id])
            && jobContentFingerprint(job) === disclosedFps[job.id])
          if (!opportunitiesInput.length) {
            return { skipped: true, emptyTarget: true, triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0 }
          }
        }
        const plan = selectTriageCandidates({
          opportunities: opportunitiesInput,
          activeBoards,
          feedbackMap,
          receiptsByOpp: indexByOpportunity(control.receipts),
          existingMatches: existing,
          profile,
          locale: loc,
          limit: effectiveLimit,
          force,
          recheck,
          allowStage0Override,
          currentModel: fastRoute,
        })
        const resolvedAutoKey = autoKey || plan.autoTriageKey
        const candidates = plan.needsReviewCandidates

        if (!candidates.length) {
          if (disclosedConfirmation) {
            return { skipped: true, emptyTarget: true, triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0 }
          }
          if (!targetIdSet) {
            await exclusive(async () => {
              if (isClosed() || controller.signal.aborted || atRevision !== getRevision()) return
              await commit(next => {
                next.triageMeta = {
                  ...(next.triageMeta ?? {}),
                  autoKey: resolvedAutoKey,
                  fingerprint: profile.fingerprint,
                  updatedAt: new Date().toISOString(),
                }
              })
            })
          }
          return { triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0, mode: 'cached' }
        }
        const llmUsed = Boolean((disclosedConfirmation || control.config.sendToModel === true) && fastRoute && ctx.llm)
        const toHydrate = skipHydration
          ? []
          : candidates.filter(job => isOpportunityJdIncomplete(job) && canFetchOpportunityDetail(job))
        if (triageRun === jobPromise && (llmUsed || toHydrate.length > 0)) {
          triageProgress = { completed: 0, total: candidates.length }
        }
        const hydratedById = new Map()
        const hydrationFailedIds = new Set()
        let hydratedJdCount = 0
        if (toHydrate.length > 0) {
          let cursor = 0
          const workerCount = Math.min(4, toHydrate.length)
          await Promise.all(Array.from({ length: workerCount }, async () => {
            while (cursor < toHydrate.length && !isClosed() && !controller.signal.aborted && atRevision === getRevision()) {
              const job = toHydrate[cursor]
              cursor += 1
              if (!job?.id) continue
              const res = await ensureOpportunityJd(job.id, { strict: false, signal: controller.signal })
              if (res?.aborted || isClosed() || controller.signal.aborted || atRevision !== getRevision()) break
              if (res?.error) hydrationFailedIds.add(job.id)
              if (res?.opportunity) hydratedById.set(job.id, res.opportunity)
              if (res?.changed && !isOpportunityJdIncomplete(res.opportunity)) hydratedJdCount += 1
            }
          }))
        }
        if (isClosed() || controller.signal.aborted || atRevision !== getRevision()) return { triagedCount: 0, llmScoredCount: 0 }
        const liveControl = getControl()
        const hydratedCandidates = candidates.map(job => hydratedById.get(job.id) || job)
        const stage0HydratedExcluded = []
        const eligibleHydrated = []
        for (const job of hydratedCandidates) {
          const st0 = allowStage0Override ? { excluded: false } : isStage0HardExcluded(job, profile, liveControl.jobFeedback ?? {})
          if (st0.excluded) stage0HydratedExcluded.push(job)
          else eligibleHydrated.push(job)
        }
        const finalAutoKey = autoKey
          || `${profile?.fingerprint || ''}:${hydratedCandidates.map(job => `${job.id}@${jobContentFingerprint(job)}`).sort().join(',')}`
        const incompleteCandidates = eligibleHydrated.filter(job => isOpportunityJdIncomplete(job))
        const readyCandidates = eligibleHydrated.filter(job => !isOpportunityJdIncomplete(job))
        const stage0ExcludedResults = stage0HydratedExcluded.map(job => ({
          ...scoreOpportunityHeuristic(job, profile, loc),
          stage0HydratedExclude: true,
          locale: loc,
        }))
        const missingJdResults = incompleteCandidates.map(job => ({
          ...buildMissingJdMatch(job, profile, loc, { hydrationFailed: hydrationFailedIds.has(job.id) }),
          locale: loc,
        }))

        const metricsOut = {}
        let scoredResults = []
        if (llmUsed && readyCandidates.length > 0) {
          if (triageRun === jobPromise) {
            triageProgress = { completed: incompleteCandidates.length, total: hydratedCandidates.length }
          }
          const scored = await triageBatchWithLlm({
            llm: ctx.llm,
            config: llmCallConfig(liveControl.config, fastRoute, disclosedConfirmation ? { sendToModel: true } : {}, { kind: fastKind }),
            jobs: readyCandidates,
            profile,
            resumeText: primaryResumeText,
            signal: controller.signal,
            locale: loc,
            metricsOut,
            onProgress: p => {
              if (triageRun === jobPromise) {
                triageProgress = {
                  completed: Math.min(hydratedCandidates.length, incompleteCandidates.length + (p?.completed || 0)),
                  total: hydratedCandidates.length,
                }
              }
            },
          })
          scoredResults = scored.map(item => (
            item.mode === 'llm'
              ? { ...item, locale: loc, evalBasis }
              : { ...item, locale: loc }
          ))
        } else if (readyCandidates.length > 0) {
          scoredResults = readyCandidates.map(job => ({ ...scoreOpportunityHeuristic(job, profile, loc), locale: loc }))
        }
        const results = [...stage0ExcludedResults, ...missingJdResults, ...scoredResults]
        if (isClosed() || controller.signal.aborted || atRevision !== getRevision() || !results.length) return { triagedCount: 0, llmScoredCount: 0 }
        const hasFailure = llmUsed && ((metricsOut.failedBatches || 0) > 0 || (metricsOut.failedJobs || 0) > 0)
        let llmScoredCount = 0
        await exclusive(async () => {
          if (isClosed() || controller.signal.aborted || atRevision !== getRevision()) return
          await commit(next => {
            const map = { ...(next.jobMatches ?? {}) }
            const persistedLlmIds = new Set()
            for (const item of results) {
              const shouldPersist = !llmUsed
                || item.mode === 'llm'
                || item.stage0HydratedExclude === true
                || item.uncertaintyCode === 'context_window_exceeded'
                || item.uncertaintyCode === 'missing_jd'
              if (shouldPersist) {
                map[item.opportunityId] = item
                if (item.mode === 'llm') persistedLlmIds.add(item.opportunityId)
              }
            }
            // Trim stale entries for removed opportunities
            const liveIds = new Set(next.opportunities.map(o => o.id))
            for (const key of Object.keys(map)) {
              if (!liveIds.has(key)) {
                delete map[key]
                persistedLlmIds.delete(key)
              }
            }
            llmScoredCount = persistedLlmIds.size
            next.jobMatches = map
            const metricsSummary = (metricsOut.llmCalls > 0 || metricsOut.degradedJobs > 0 || hasFailure)
              ? { lastMetrics: metricsOut }
              : {}
            if (!targetIdSet) {
              next.triageMeta = hasFailure
                ? {
                    ...(next.triageMeta ?? {}),
                    autoKey: '',
                    fingerprint: profile.fingerprint,
                    updatedAt: new Date().toISOString(),
                    lastFailure: {
                      at: new Date().toISOString(),
                      failedBatches: metricsOut.failedBatches || 0,
                      failedJobs: metricsOut.failedJobs || 0,
                      error: metricsOut.lastError || '',
                    },
                    ...metricsSummary,
                  }
                : {
                    autoKey: finalAutoKey,
                    fingerprint: profile.fingerprint,
                    updatedAt: new Date().toISOString(),
                    ...metricsSummary,
                  }
            } else if (hasFailure || metricsOut.llmCalls > 0 || metricsOut.degradedJobs > 0) {
              next.triageMeta = {
                ...(next.triageMeta ?? {}),
                ...(hasFailure ? { autoKey: '' } : {}),
                updatedAt: new Date().toISOString(),
                ...metricsSummary,
              }
            }
          })
          publish('opportunities.updated', { triagedCount: results.length })
        })
        return {
          triagedCount: results.length,
          llmScoredCount,
          hydratedJdCount,
          missingJdCount: missingJdResults.length,
          mode: llmScoredCount > 0 ? 'llm' : 'heuristic',
          ...(hasFailure ? { partialFailure: true } : {}),
          ...(metricsOut.llmCalls > 0 || metricsOut.degradedJobs > 0 || hasFailure ? { metrics: metricsOut } : {}),
        }
      } finally {
        if (triageAbort === controller) triageAbort = null
        if (triageRun === jobPromise) {
          triageRun = null
          triageProgress = null
        }
      }
    })()
    triageRun = jobPromise
    return jobPromise
  }

  function handleTriagePreviewAction(body, loc) {
    const targetIds = Array.isArray(body?.targetJobIds)
      ? body.targetJobIds.map(v => String(v || '').trim()).filter(Boolean).slice(0, 30)
      : undefined
    if (body.id !== undefined) {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) throw new TypeError('Invalid opportunity id.')
      return previewJobTriage({ id, recheck: true, locale: loc })
    }
    if (Array.isArray(body?.targetJobIds) && body.targetJobIds.length === 0) {
      return previewJobTriage({ targetJobIds: [], locale: loc })
    }
    const reqLimit = Math.min(30, Math.max(1, Number(body?.limit) || 30))
    return previewJobTriage({ limit: reqLimit, targetJobIds: targetIds, recheck: body?.recheck === true, locale: loc })
  }

  function handleTriageJobsAction(body, loc) {
    if (isClosed() || triageRun) return { running: triageRun !== null, alreadyRunning: triageRun !== null, triagedCount: 0 }
    if (Array.isArray(body?.targetJobIds) && body.targetJobIds.length === 0) {
      return { skipped: true, emptyTarget: true, triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0 }
    }
    const control = getControl()
    // Explicit confirmation tokens MUST ALWAYS bind to their disclosed scope regardless of whether sendToModel was later toggled ON.
    const isExplicitConfirmRequest = body?.confirmed === true || body?.confirmToken !== undefined
    const sendToModelEnabled = control.config.sendToModel === true
    if (isExplicitConfirmRequest || !sendToModelEnabled) {
      const hasConfirmFlag = body?.confirmed === true
      const rawToken = typeof body?.confirmToken === 'string' ? body.confirmToken.trim() : ''
      const preview = hasConfirmFlag && rawToken ? pendingTriagePreviews.get(rawToken) : null
      if (rawToken) pendingTriagePreviews.delete(rawToken)
      if (!preview || Date.now() - preview.createdAt > TRIAGE_PREVIEW_TTL_MS) {
        return {
          skipped: true,
          requiresConfirmation: true,
          ...(isExplicitConfirmRequest ? { staleConfirmation: true } : {}),
          triagedCount: 0,
          llmScoredCount: 0,
        }
      }
      if (!Array.isArray(preview.targetJobIds) || preview.targetJobIds.length === 0) {
        return { skipped: true, emptyTarget: true, triagedCount: 0, llmScoredCount: 0, hydratedJdCount: 0, missingJdCount: 0 }
      }
      return runJobTriage({
        force: preview.force,
        recheck: preview.recheck,
        allowStage0Override: preview.allowStage0Override === true,
        bypassCooldown: true,
        targetJobIds: preview.targetJobIds,
        skipHydration: true,
        disclosedConfirmation: preview,
        locale: loc,
      })
    }
    const confirmedForce = body?.force === true
    const explicitRecheck = body?.recheck === true
    if (body.id !== undefined) {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) throw new TypeError('Invalid opportunity id.')
      return runJobTriage({ force: true, bypassCooldown: true, targetJobIds: [id], recheck: true, allowStage0Override: true, locale: loc })
    }
    const targetIds = Array.isArray(body?.targetJobIds)
      ? body.targetJobIds.map(v => String(v || '').trim()).filter(Boolean).slice(0, 30)
      : undefined
    const reqLimit = Math.min(30, Math.max(1, Number(body?.limit) || 30))
    return runJobTriage({ force: confirmedForce, recheck: explicitRecheck, allowStage0Override: false, bypassCooldown: true, limit: reqLimit, targetJobIds: targetIds, locale: loc })
  }

  return {
    previewJobTriage,
    runJobTriage,
    buildTriageSummary,
    handleTriagePreviewAction,
    handleTriageJobsAction,
    abort: () => triageAbort?.abort(),
    clearPreviews: () => pendingTriagePreviews.clear(),
    resetCooldown: () => { lastTriageAt = 0 },
    isRunning: () => triageRun !== null,
    whenIdle: () => (triageRun ? Promise.resolve(triageRun).catch(() => {}) : Promise.resolve()),
  }
}
