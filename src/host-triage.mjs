import { createHash, randomUUID } from 'node:crypto'
import { organizeResumeVersions } from './resume-versions.mjs'
import { normalizeLocale } from './i18n/index.mjs'
import {
  MATCH_ZONE_RANK,
  TIER_RANK,
  buildMissingJdMatch,
  buildPatrolSearchProfile,
  buildTriageSharedPayload,
  classifyMatchZone,
  compareRubricOptionA,
  estimateTriageBatchTokens,
  isCompleteRubricV2Match,
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
    if (zone === 'rubric_v2') {
      const rubricCmp = compareRubricOptionA(
        { id: a.id, tier: a.match?.tier, rubric: a.match?.rubric, recallRank: a.match?.recallRank },
        { id: b.id, tier: b.match?.tier, rubric: b.match?.rubric, recallRank: b.match?.recallRank },
      )
      if (rubricCmp !== 0) return rubricCmp
      return (b.lastReceiptAt ?? b.verifiedAt ?? '').localeCompare(a.lastReceiptAt ?? a.verifiedAt ?? '')
    }
    if (zone === 'legacy_v1') {
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
    const isLegacyZone = j => j.match?.zone === 'legacy_v1'
    const isCompleteLlmZone = j => (j.match?.zone === 'rubric_v2' && isCompleteRubricV2Match(j.match, j)) || isLegacyZone(j)
    const completeRubricFresh = activeFresh.filter(j => j.match?.zone === 'rubric_v2' && isCompleteRubricV2Match(j.match, j))
    const legacyFresh = activeFresh.filter(isLegacyZone)
    const incompleteRubricCount = activeFresh.filter(j => j.match?.zone === 'rubric_v2' && !isCompleteRubricV2Match(j.match, j)).length
    const stage0ExcludedIds = new Set(
      activeFresh
        .filter(j => !isCompleteLlmZone(j) && j.match?.zone !== 'rubric_v2' && isStage0HardExcluded(j, patrolProfile, feedbackMap).excluded)
        .map(j => j.id),
    )
    const eligiblePendingFresh = activeFresh.filter(j => !stage0ExcludedIds.has(j.id))
    const rubricV2Count = activeFresh.filter(j => j.match?.zone === 'rubric_v2').length
    const legacyCount = legacyFresh.length
    const unreviewedCount = eligiblePendingFresh.filter(j => j.match?.zone === 'pending_local').length
    const evaluatedCount = completeRubricFresh.length + legacyFresh.length
    const missingJdCount = eligiblePendingFresh.filter(j => j.match?.zone === 'missing_jd').length
    const eligibleCount = evaluatedCount + incompleteRubricCount + unreviewedCount + missingJdCount
    const lastReceipt = getControl()?.triageMeta?.lastReceipt ?? null
    return {
      topCount: completeRubricFresh.filter(j => j.match?.tier === 'top').length,
      goodCount: completeRubricFresh.filter(j => j.match?.tier === 'good').length,
      stretchCount: completeRubricFresh.filter(j => j.match?.tier === 'stretch').length,
      skipCount: completeRubricFresh.filter(j => j.match?.tier === 'skip').length,
      dismissedCount: visibleFresh.filter(j => j.feedback?.status === 'dismissed').length,
      llmTriagedCount: visibleFresh.filter(isCompleteLlmZone).length,
      rubricV2Count,
      completeRubricCount: completeRubricFresh.length,
      incompleteRubricCount,
      legacyCount,
      unreviewedCount,
      missingJdCount,
      evaluatedCount,
      eligibleCount,
      running: triageRun !== null,
      ...(triageRun !== null && triageProgress ? { progress: triageProgress } : {}),
      ...(lastReceipt ? { lastReceipt } : {}),
      fingerprint: patrolProfile.fingerprint,
      basisResume,
    }
  }

  function emptyPreviewResponse() {
    return {
      count: 0,
      emptyTarget: true,
      missingJdCount: 0,
      hydratedJdCount: 0,
      minTokens: 0,
      maxTokens: 0,
      estimatedInputTokens: 0,
      minOutputTokens: 0,
      maxOutputTokens: 0,
      confirmToken: '',
      targetJobIds: [],
      jobs: [],
    }
  }

  function emptyRunResponse() {
    return {
      skipped: true,
      emptyTarget: true,
      triagedCount: 0,
      llmScoredCount: 0,
      hydratedJdCount: 0,
      missingJdCount: 0,
    }
  }

  function normalizeTargetJobIds(rawIds, maxIds = 500) {
    if (!Array.isArray(rawIds)) return undefined
    const seen = new Set()
    const out = []
    for (const raw of rawIds) {
      const id = String(raw || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      if (out.length >= maxIds) break
    }
    return out
  }

  async function previewJobTriage({ id, limit = 30, targetJobIds = null, recheck = false, upgradeLegacy = false, filterScope = '', locale } = {}) {
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
    const normalizedPreviewId = id !== undefined ? String(id || '').trim() : ''
    if (filterScope === 'filtered' && !normalizedPreviewId && (!Array.isArray(targetJobIds) || targetJobIds.length === 0)) {
      return emptyPreviewResponse()
    }
    if (Array.isArray(targetJobIds) && targetJobIds.length === 0) {
      return emptyPreviewResponse()
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
    const maxCap = filterScope === 'filtered' ? 25 : 30
    const normalizedId = id !== undefined ? String(id || '').trim() : ''
    const dedupedTargetIds = normalizedId
      ? [normalizedId]
      : normalizeTargetJobIds(targetJobIds, 500)
    const targetIdSet = dedupedTargetIds ? new Set(dedupedTargetIds) : null
    const effectiveLimit = filterScope === 'filtered'
      ? Math.min(maxCap, targetIdSet ? targetIdSet.size : maxCap)
      : (targetIdSet
          ? Math.min(maxCap, targetIdSet.size)
          : Math.min(maxCap, Math.max(1, Number(limit) || maxCap)))
    const effectiveRecheck = Boolean(normalizedId || recheck)
    const allowStage0Override = Boolean(normalizedId)
    const opportunitiesInput = targetIdSet
      ? control.opportunities.filter(o => o && targetIdSet.has(o.id))
      : control.opportunities
    if (targetIdSet && opportunitiesInput.length === 0) {
      return {
        count: 0,
        emptyTarget: true,
        missingJdCount: 0,
        hydratedJdCount: 0,
        minTokens: 0,
        maxTokens: 0,
        confirmToken: '',
        targetJobIds: [],
        jobs: [],
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
      force: true,
      recheck: effectiveRecheck,
      upgradeLegacy: Boolean(upgradeLegacy),
      allowStage0Override,
      currentModel: fastRoute,
    })
    const candidates = plan.needsReviewCandidates
    if (targetIdSet && candidates.length === 0) {
      return {
        count: 0,
        emptyTarget: true,
        missingJdCount: 0,
        hydratedJdCount: 0,
        minTokens: 0,
        maxTokens: 0,
        confirmToken: '',
        targetJobIds: [],
        jobs: [],
      }
    }
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
        sendToModelAtPreview: liveControl.config.sendToModel === true,
        targetJobIds: readyCandidates.map(j => j.id),
        jobFingerprints: Object.fromEntries(readyCandidates.map(j => [j.id, jobContentFingerprint(j)])),
        force: true,
        recheck: effectiveRecheck,
        upgradeLegacy: Boolean(upgradeLegacy),
        filterScope: filterScope || (normalizedId ? 'single' : 'default'),
        estimated: {
          inputTokens: tokenEst.estimatedInputTokens ?? 0,
          minOutputTokens: tokenEst.minOutputTokens ?? 0,
          maxOutputTokens: tokenEst.maxOutputTokens ?? 0,
          minTokens: tokenEst.minTokens,
          maxTokens: tokenEst.maxTokens,
        },
        allowStage0Override,
      })
    }
    return {
      count: readyCandidates.length,
      ...(targetIdSet && readyCandidates.length === 0 ? { emptyTarget: true } : {}),
      sendToModel: liveControl.config.sendToModel === true,
      missingJdCount: incompleteCandidates.length,
      hydratedJdCount,
      minTokens: tokenEst.minTokens,
      maxTokens: tokenEst.maxTokens,
      estimatedInputTokens: tokenEst.estimatedInputTokens ?? 0,
      minOutputTokens: tokenEst.minOutputTokens ?? 0,
      maxOutputTokens: tokenEst.maxOutputTokens ?? 0,
      degradedCount: tokenEst.degradedCount ?? 0,
      fullJdCount: tokenEst.fullJdCount,
      excerptedJdCount: tokenEst.excerptedJdCount,
      filterScope: filterScope || (normalizedId ? 'single' : 'default'),
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
    upgradeLegacy = false,
    filterScope = '',
    allowStage0Override = false,
    skipHydration = false,
    disclosedConfirmation = null,
  } = {}) {
    if (isClosed() || triageRun) return { running: triageRun !== null, alreadyRunning: triageRun !== null, triagedCount: 0 }
    if (filterScope === 'filtered' && !disclosedConfirmation && (!Array.isArray(targetJobIds) || targetJobIds.length === 0)) {
      return emptyRunResponse()
    }
    if (Array.isArray(targetJobIds) && targetJobIds.length === 0) {
      return emptyRunResponse()
    }
    const controlAtStart = getControl()
    if (!disclosedConfirmation && !controlAtStart.config.sendToModel) {
      return { skipped: true, requiresConfirmation: true, triagedCount: 0, llmScoredCount: 0 }
    }
    if (!force && !bypassCooldown && !disclosedConfirmation && Date.now() - lastTriageAt < 25_000) return { skipped: true, triagedCount: 0 }
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const maxCap = (disclosedConfirmation?.filterScope === 'filtered' || filterScope === 'filtered') ? 25 : 30
    const dedupedTargetIds = normalizeTargetJobIds(targetJobIds, 500)
    const targetIdSet = dedupedTargetIds && dedupedTargetIds.length > 0 ? new Set(dedupedTargetIds) : null
    const effectiveLimit = targetIdSet
      ? Math.min(maxCap, targetIdSet.size)
      : Math.min(maxCap, Math.max(1, Number(limit) || maxCap))
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
          upgradeLegacy: Boolean(disclosedConfirmation ? disclosedConfirmation.upgradeLegacy : upgradeLegacy),
          allowStage0Override,
          currentModel: fastRoute,
        })
        const resolvedAutoKey = autoKey || plan.autoTriageKey
        const candidates = plan.needsReviewCandidates

        if (!candidates.length) {
          if (disclosedConfirmation || targetIdSet) {
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
        let estimatedRange = disclosedConfirmation?.estimated || null
        let scoredResults = []
        if (llmUsed && readyCandidates.length > 0) {
          if (!estimatedRange) {
            const resolvedBudget = ctx.llm
              ? await resolveTriageModelBudget({
                  llm: ctx.llm,
                  config: llmCallConfig(liveControl.config, fastRoute, disclosedConfirmation ? { sendToModel: true } : {}, { kind: fastKind }),
                  signal: controller.signal,
                }).catch(() => null)
              : null
            const tokenEst = estimateTriageBatchTokens({
              jobs: readyCandidates,
              profile,
              resumeText: primaryResumeText,
              locale: loc,
              budget: resolvedBudget,
            })
            estimatedRange = {
              inputTokens: tokenEst.estimatedInputTokens ?? 0,
              minOutputTokens: tokenEst.minOutputTokens ?? 0,
              maxOutputTokens: tokenEst.maxOutputTokens ?? 0,
              minTokens: tokenEst.minTokens,
              maxTokens: tokenEst.maxTokens,
            }
          }
          if (triageRun === jobPromise) {
            triageProgress = { completed: incompleteCandidates.length, total: hydratedCandidates.length }
          }
          const scored = await triageBatchWithLlm({
            llm: ctx.llm,
            config: llmCallConfig(liveControl.config, fastRoute, disclosedConfirmation ? { sendToModel: true } : {}, { kind: fastKind }),
            jobs: readyCandidates,
            profile,
            resumeText: primaryResumeText,
            resumeId: primaryResume?.id || '',
            recallRankById: plan.recallRankById,
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
        const wasAbortedMidRun = Boolean(controller.signal.aborted && !isClosed() && atRevision === getRevision())
        if (isClosed() || atRevision !== getRevision() || (!results.length && !wasAbortedMidRun)) {
          return { triagedCount: 0, llmScoredCount: 0 }
        }
        if (controller.signal.aborted && (!llmUsed || (metricsOut.physicalCalls || 0) === 0)) {
          return { triagedCount: 0, llmScoredCount: 0 }
        }
        const hasFailure = llmUsed && ((metricsOut.failedBatches || 0) > 0 || (metricsOut.failedJobs || 0) > 0)
        const cancelledCount = controller.signal.aborted ? (metricsOut.cancelledJobs || 0) : 0
        const skippedExistingCount = targetIdSet
          ? Math.max(0, targetIdSet.size - readyCandidates.length - incompleteCandidates.length - stage0HydratedExcluded.length)
          : 0
        let llmScoredCount = 0
        let receipt = null
        await exclusive(async () => {
          if (isClosed() || atRevision !== getRevision()) return
          await commit(next => {
            const map = { ...(next.jobMatches ?? {}) }
            const liveOppById = new Map(next.opportunities.filter(o => o?.id).map(o => [o.id, o]))
            const persistedCompleteLlmIds = new Set()
            const persistedIncompleteLlmIds = new Set()
            let protectedUpgradeSkippedOrFailed = 0
            for (const item of results) {
              const id = item?.opportunityId
              const liveOpp = id ? liveOppById.get(id) : null
              const prevMatch = id ? map[id] : null
              const prevZone = prevMatch && liveOpp ? classifyMatchZone(prevMatch, liveOpp) : 'pending_local'
              const hasValidProtected = prevZone === 'legacy_v1'
                || (prevZone === 'rubric_v2' && isCompleteRubricV2Match(prevMatch, liveOpp))
              const isCompleteNew = item.mode === 'llm' && Boolean(liveOpp) && isCompleteRubricV2Match(item, liveOpp)

              // Preserve valid legacy_v1 / complete rubric_v2 cards whenever upgrade fails, degrades, or lacks R evidence.
              if (hasValidProtected && !isCompleteNew) {
                if (item.mode === 'llm' && !controller.signal.aborted) {
                  protectedUpgradeSkippedOrFailed += 1
                }
                continue
              }

              const shouldPersist = controller.signal.aborted
                ? item.mode === 'llm'
                : (!llmUsed
                    || item.mode === 'llm'
                    || item.stage0HydratedExclude === true
                    || item.uncertaintyCode === 'context_window_exceeded'
                    || item.uncertaintyCode === 'missing_jd')
              if (shouldPersist) {
                map[id] = item
                if (isCompleteNew) persistedCompleteLlmIds.add(id)
                else if (item.mode === 'llm') persistedIncompleteLlmIds.add(id)
              }
            }
            // Trim stale entries for removed opportunities
            const liveIds = new Set(next.opportunities.map(o => o.id))
            for (const key of Object.keys(map)) {
              if (!liveIds.has(key)) {
                delete map[key]
                persistedCompleteLlmIds.delete(key)
                persistedIncompleteLlmIds.delete(key)
              }
            }
            llmScoredCount = persistedCompleteLlmIds.size
            next.jobMatches = map
            const effectiveScope = disclosedConfirmation?.filterScope || filterScope || (targetIdSet ? 'scoped' : 'default')
            const failedCount = (llmUsed ? (metricsOut.failedJobs || 0) : 0) + protectedUpgradeSkippedOrFailed
            const degradedSkipped = metricsOut.degradedJobs || 0
            const skippedTotal = skippedExistingCount + degradedSkipped + stage0HydratedExcluded.length
            receipt = (llmUsed || stage0HydratedExcluded.length > 0) ? {
              at: new Date().toISOString(),
              model: fastRoute,
              scope: effectiveScope,
              estimated: estimatedRange || {
                inputTokens: 0,
                minOutputTokens: 0,
                maxOutputTokens: 0,
                minTokens: 0,
                maxTokens: 0,
              },
              usage: {
                reported: Boolean(metricsOut.usageReported),
                complete: Boolean(metricsOut.usageComplete),
                physicalCalls: metricsOut.physicalCalls || 0,
                inputTokens: metricsOut.reportedUncachedInputTokens ?? null,
                cacheReadTokens: metricsOut.reportedCacheReadTokens ?? null,
                cacheWriteTokens: metricsOut.reportedCacheWriteTokens ?? null,
                outputTokens: metricsOut.reportedOutputTokens ?? null,
                reasoningTokens: metricsOut.reportedReasoningTokens ?? null,
                totalTokens: metricsOut.reportedTotalTokens ?? null,
              },
              counts: {
                requested: targetIdSet ? targetIdSet.size : candidates.length,
                written: llmScoredCount,
                incomplete: persistedIncompleteLlmIds.size,
                skipped: skippedTotal,
                failed: failedCount,
                cancelled: cancelledCount,
                missingJd: missingJdResults.length,
              },
            } : null
            const metricsSummary = (metricsOut.llmCalls > 0 || metricsOut.degradedJobs > 0 || hasFailure || receipt)
              ? { lastMetrics: metricsOut, ...(receipt ? { lastReceipt: receipt } : {}) }
              : {}
            if (controller.signal.aborted) {
              if (metricsOut.llmCalls > 0 || receipt) {
                next.triageMeta = {
                  ...(next.triageMeta ?? {}),
                  autoKey: '',
                  updatedAt: new Date().toISOString(),
                  ...metricsSummary,
                }
              }
              return
            }
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
        if (controller.signal.aborted) {
          return {
            triagedCount: llmScoredCount,
            llmScoredCount,
            hydratedJdCount,
            missingJdCount: 0,
            aborted: true,
            mode: llmScoredCount > 0 ? 'llm' : 'heuristic',
            ...(receipt ? { receipt } : {}),
            ...(metricsOut.llmCalls > 0 ? { metrics: metricsOut } : {}),
          }
        }
        return {
          triagedCount: results.length,
          llmScoredCount,
          hydratedJdCount,
          missingJdCount: missingJdResults.length,
          mode: llmScoredCount > 0 ? 'llm' : 'heuristic',
          ...(hasFailure ? { partialFailure: true } : {}),
          ...(receipt ? { receipt } : {}),
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
    const filterScope = body?.filterScope === 'filtered' ? 'filtered' : ''
    const maxCap = filterScope === 'filtered' ? 25 : 30
    const upgradeLegacy = body?.upgradeLegacy === true
    const targetIds = normalizeTargetJobIds(body?.targetJobIds, 500)
    if (body.id !== undefined) {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) throw new TypeError('Invalid opportunity id.')
      return previewJobTriage({ id, recheck: true, locale: loc })
    }
    if ((filterScope === 'filtered' && (!targetIds || targetIds.length === 0))
      || (Array.isArray(body?.targetJobIds) && body.targetJobIds.length === 0)) {
      return previewJobTriage({ targetJobIds: [], filterScope, locale: loc })
    }
    const reqLimit = Math.min(maxCap, Math.max(1, Number(body?.limit) || maxCap))
    return previewJobTriage({ limit: reqLimit, targetJobIds: targetIds, recheck: body?.recheck === true, upgradeLegacy, filterScope, locale: loc })
  }

  function handleTriageJobsAction(body, loc) {
    if (isClosed() || triageRun) return { running: triageRun !== null, alreadyRunning: triageRun !== null, triagedCount: 0 }
    if (Array.isArray(body?.targetJobIds) && body.targetJobIds.length === 0) {
      return emptyRunResponse()
    }
    const control = getControl()
    // Explicit confirmation tokens MUST ALWAYS bind to their disclosed scope regardless of whether sendToModel was later toggled ON,
    // while stale auto-confirmed requests when sendToModel is OFF must be rejected back to explicit dialog confirmation.
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
      if (body?.autoConfirmed === true && (!sendToModelEnabled || preview.sendToModelAtPreview !== true)) {
        return {
          skipped: true,
          requiresConfirmation: true,
          staleConfirmation: true,
          triagedCount: 0,
          llmScoredCount: 0,
        }
      }
      if (!Array.isArray(preview.targetJobIds) || preview.targetJobIds.length === 0) {
        return emptyRunResponse()
      }
      return runJobTriage({
        force: preview.force,
        recheck: preview.recheck,
        upgradeLegacy: preview.upgradeLegacy === true,
        filterScope: preview.filterScope || '',
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
    const upgradeLegacy = body?.upgradeLegacy === true
    const filterScope = body?.filterScope === 'filtered' ? 'filtered' : ''
    const maxCap = filterScope === 'filtered' ? 25 : 30
    if (body.id !== undefined) {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) throw new TypeError('Invalid opportunity id.')
      return runJobTriage({ force: true, bypassCooldown: true, targetJobIds: [id], recheck: true, allowStage0Override: true, locale: loc })
    }
    const targetIds = normalizeTargetJobIds(body?.targetJobIds, 500)
    if (filterScope === 'filtered' && (!targetIds || targetIds.length === 0)) {
      return emptyRunResponse()
    }
    const reqLimit = Math.min(maxCap, Math.max(1, Number(body?.limit) || maxCap))
    return runJobTriage({ force: confirmedForce, recheck: explicitRecheck, upgradeLegacy, filterScope, allowStage0Override: false, bypassCooldown: true, limit: reqLimit, targetJobIds: targetIds, locale: loc })
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
