import { createHash } from 'node:crypto'
import { boardSourceId, collectOpportunities, MAX_SOURCES, validateBoardSource } from './opportunities.mjs'
import {
  extractEvidence, isLowSignalEpisode, modelRoute, observedInputs,
  resolveSessionProjects, SESSION_SOURCE, WORKSPACE_SCOPE_PREFIX,
} from './watch.mjs'
import { DEFAULT_TRIAGE_BATCH_LIMIT } from './job-view-scope.mjs'
import { companyHiringBoards, findNamedCompanyBoards, hiringScopesFromText, parseBoardInput } from './company-boards.mjs'
import { buildPatrolSearchProfile } from './job-triage.mjs'
import { analyzeMarketCorpus, recordMarketHistorySnapshot, shouldAutoRefreshMarketInsight } from './market-insights.mjs'
import {
  normalizeRecordingList, normalizeRecordingNotice, normalizeRecordingSource,
  normalizeTranscript, RECORDING_PREFIX, RECORDING_PROJECT, workRecordingInputs,
} from './recordings.mjs'
import { isShareableEvidence } from './host-provenance.mjs'

const MINUTE = 60_000
export const RUN_SCOPES = new Set(['all', 'boards', 'sessions'])

function boardPatrolConfigKey(cfg) {
  return JSON.stringify({
    goal: String(cfg?.goal || '').trim(),
    searchTerms: Array.isArray(cfg?.searchTerms) ? cfg.searchTerms : [],
    hiringScope: String(cfg?.hiringScope || ''),
    discoverFromWeb: Boolean(cfg?.discoverFromWeb),
    boards: (cfg?.boards ?? []).map(boardSourceId).sort(),
  })
}

function recordingGrant(core, id) {
  return core.sources.find(source =>
    source.id === RECORDING_PREFIX + id && !source.revokedAt && source.projects.includes(RECORDING_PROJECT))
}

function recordingMeta({ id, name, work, interview }) {
  return { id, name, work, interview }
}

/**
 * Coordinates background/manual session distillation, career board patrols,
 * transcript recordings ingestion, and periodic watch cycles.
 */
export function createHostWatch(deps) {
  const {
    ctx,
    store,
    optionalService,
    resolveProjects,
    getControl,
    isClosed,
    getRevision,
    getCurrentMode,
    getRun,
    setRun,
    getWakeAt,
    setWakeAt,
    pendingTurns,
    recordingSources,
    getMarketInsightRun,
    getLastAutoInsightAttemptAt,
    SOURCES,
    MAX_RECORDINGS,
    defaultHistoryDays,
    canIngest,
    invalidate,
    exclusive,
    commit,
    publish,
    activeLocale,
    defaultModelRoute,
    llmCallConfig,
    triage,
    mergeBoards,
    generateMarketInsight,
    buildMarketSnapshotContext,
    marketMissingSkills,
    resumeFor,
    string,
    bool,
  } = deps

  function recordingSummary(core) {
    const control = getControl()
    const queue = control.recordings ?? []
    const catalog = new Map((control.recordingSources ?? []).map(source => [source.id, source]))
    for (const source of recordingSources.values()) catalog.set(source.id, recordingMeta(source))
    const sources = [...catalog.values()].map(source => {
      const records = queue.filter(row => row.sourceId === source.id)
      return {
        ...source,
        enabled: !!recordingGrant(core, source.id),
        available: recordingSources.has(source.id),
        pendingWork: records.filter(row => row.kind === 'work' && row.status === 'pending').length,
        lastReceivedAt: records.reduce((last, row) => row.receivedAt > last ? row.receivedAt : last, '') || undefined,
      }
    })
    const interviews = queue.filter(row => row.kind === 'interview' && row.status === 'pending' && recordingGrant(core, row.sourceId))
      .sort((first, second) => second.occurredAt.localeCompare(first.occurredAt)).slice(0, 40).map(row => ({
        id: row.id,
        title: row.title,
        occurredAt: row.occurredAt,
        round: row.round,
        status: row.status,
        opportunityId: control.opportunities.some(job => job.id === row.opportunityId) ? row.opportunityId : undefined,
        sourceName: catalog.get(row.sourceId)?.name ?? row.sourceId,
        available: recordingSources.has(row.sourceId),
      }))
    return { sources, interviews }
  }

  async function setRecordingSource(id, enabled) {
    id = string(id, 63, '录音来源')
    bool(enabled, '录音来源')
    const source = recordingSources.get(id)
    const previous = recordingGrant(await store.summary(), id)
    if (enabled && !source) throw new Error('这个录音插件当前未运行。')
    if (enabled === !!previous) return { enabled }
    invalidate()
    if (enabled) await store.authorizeSource({ id: RECORDING_PREFIX + id, projects: [RECORDING_PROJECT] })
    else await store.revokeSource(RECORDING_PREFIX + id)
    await commit(next => {
      if (source) next.recordingSources = [...(next.recordingSources ?? []).filter(item => item.id !== id), recordingMeta(source)]
      if (!enabled) next.drafts = []
    })
    if (enabled && getCurrentMode() !== 'off') setWakeAt(Date.now())
    publish('recording.source-changed', { sourceId: id, enabled })
    return { enabled }
  }

  function appendRecordings(state, records) {
    const entries = state.recordings ??= []
    const known = new Set(entries.map(row => row.id))
    const additions = []
    for (const row of records) {
      if (known.has(row.id) || entries.length >= MAX_RECORDINGS) continue
      const entry = { ...row, status: 'pending', receivedAt: new Date().toISOString() }
      entries.push(entry)
      additions.push(entry)
      known.add(row.id)
    }
    return additions
  }

  function registerTranscriptSource(input) {
    const source = normalizeRecordingSource(input)
    if (recordingSources.has(source.id) || recordingSources.size >= 16) throw new Error('录音插件来源已注册或数量超限。')
    recordingSources.set(source.id, source)
    return Object.freeze({
      publish: notice => exclusive(async () => {
        if (isClosed() || recordingSources.get(source.id) !== source) return { status: 'unavailable' }
        const core = await store.summary()
        if (core.mode === 'off') return { status: 'paused' }
        const grant = recordingGrant(core, source.id)
        if (!grant) return { status: 'unapproved' }
        const row = normalizeRecordingNotice(source, notice)
        if (grant.forgottenAt && row.occurredAt <= grant.forgottenAt) return { status: 'unapproved' }
        const control = getControl()
        const prior = (control.recordings ?? []).find(item => item.id === row.id)
        if (prior) return { id: row.id, status: 'duplicate' }
        if ((control.recordings?.length ?? 0) >= MAX_RECORDINGS) return { status: 'queue-full' }
        await commit(next => { appendRecordings(next, [row]) })
        setWakeAt(Math.min(getWakeAt() ?? Infinity, Date.now() + MINUTE))
        publish('recording.received', { sourceId: source.id, recordingId: row.id, kind: row.kind })
        return { id: row.id, status: 'queued' }
      }),
      dispose: () => {
        if (recordingSources.get(source.id) !== source) return
        recordingSources.delete(source.id)
        invalidate()
      },
    })
  }

  async function consumeEvidence(events, allowReflections) {
    const newBricks = []
    for (const { event, reflection, brick } of events) {
      let evidence
      if (event) {
        const saved = await store.ingestEvents([event])
        evidence = saved.evidence[0] ?? (saved.duplicates
          ? (await store.summary()).evidence.find(row => row.eventId === event.id && row.sourceId === event.sourceId
            && row.projectId === event.projectId && ['pending', 'approved'].includes(row.status))
          : undefined)
        if (saved.accepted) publish('evidence.proposed', { eventId: event.id, count: saved.evidence.length })
      }
      if (brick) newBricks.push(brick)
      if (reflection && allowReflections && (evidence || (reflection.sourceId && reflection.projectId))) {
        const id = createHash('sha256').update(reflection.id).digest('hex')
        await store.recordReflection({
          ...reflection,
          id,
          evidenceIds: evidence ? [evidence.id] : [],
        }, { actor: 'model' })
      }
    }
    if (newBricks.length) {
      const rolled = await store.ingestBricksAndRollup(newBricks, { locale: activeLocale() })
      for (const ev of rolled.rolledUp ?? []) {
        publish('evidence.proposed', { eventId: ev.eventId, count: 1 })
      }
    }
  }

  async function scanSessions(core, current, signal, pending, { explicitManual = false } = {}) {
    if (current.config.watchSessions === false) {
      return { proposals: [], cursors: {}, results: [{ sourceId: SESSION_SOURCE, status: 'skipped', reason: 'disabled' }] }
    }
    const grant = core.sources.find(row => row.id === SESSION_SOURCE && !row.revokedAt)
    if (!grant) {
      return { proposals: [], cursors: {}, results: [{ sourceId: SESSION_SOURCE, status: 'skipped', reason: 'no_scope' }] }
    }
    if (!current.config.sendToModel && !explicitManual) {
      return { proposals: [], cursors: {}, results: [{ sourceId: SESSION_SOURCE, status: 'skipped', reason: 'no_model_auth' }] }
    }
    const effectiveModel = current.config.model || await defaultModelRoute()
    const providerAvailable = (() => {
      if (!effectiveModel) return false
      try {
        const { provider } = modelRoute(effectiveModel)
        const providers = ctx.llm?.listProviders?.()
        return !Array.isArray(providers) || providers.some(item => item.id === provider)
      } catch {
        return false
      }
    })()
    if (!providerAvailable) {
      return {
        proposals: [],
        cursors: {},
        results: [{
          sourceId: SESSION_SOURCE,
          status: 'error',
          error: activeLocale() === 'en' ? 'No available AI model configured.' : '尚未配置可用 AI 模型，无法提炼工作成果。',
        }],
        backlog: false,
        finished: new Set(),
      }
    }
    const all = grant.projects.includes('*')
    const workspaceScoped = grant.projects.some(project => project.startsWith(WORKSPACE_SCOPE_PREFIX))
    const scope = workspaceScoped ? resolveProjects(grant) : new Set(grant.projects)
    const candidates = all || workspaceScoped
      ? (await ctx.sessionQuery.listSessions(signal)).flatMap(({ header }) =>
        !header.origin && (all || scope.has(header.id)) ? [header.id] : [])
      : grant.projects.slice()
    const seen = [], cursors = Object.create(null), results = [], finished = new Set()
    const since = Math.max(current.config.historyDays == null ? 0 : Date.now() - current.config.historyDays * 86_400_000,
      grant.forgottenAt ? Date.parse(grant.forgottenAt) + 1 : 0)
    const cursorValue = id => Object.hasOwn(current.cursors, id) ? current.cursors[id] : -1
    // Least recently checked first so a busy conversation cannot starve others.
    candidates.sort((a, b) => (cursorValue(a)?.checkedAt ?? 0) - (cursorValue(b)?.checkedAt ?? 0))
    const priority = new Set(candidates.filter(id => pending.has(id)).slice(0, 4))
    const ordered = [...priority, ...candidates.filter(id => !priority.has(id))]
    for (const id of ordered.slice(0, 40)) {
      signal.throwIfAborted()
      if (seen.length >= 16) break
      try {
        const snapshot = await ctx.sessionQuery.readSession(id, signal)
        signal.throwIfAborted()
        const after = cursorValue(id)?.seq ?? -1
        if (snapshot.session.origin) {
          cursors[id] = { seq: after, checkedAt: Date.now() }
          finished.add(id)
          continue
        }
        const found = observedInputs(snapshot, after, since, Math.min(priority.has(id) ? 4 : 16, 16 - seen.length))
        seen.push(...found.result)
        cursors[id] = { seq: found.through, checkedAt: Date.now(), more: found.more }
        if (!found.more) finished.add(id)
      } catch {
        signal.throwIfAborted()
        results.push({ sourceId: SESSION_SOURCE, id, status: 'error', error: '无法读取此会话。' })
        cursors[id] = { seq: cursorValue(id)?.seq ?? -1, checkedAt: Date.now() }
        finished.add(id)
      }
    }
    signal.throwIfAborted()
    const latestMembership = workspaceScoped ? resolveProjects(grant) : undefined
    const allowed = all || !latestMembership ? seen : seen.filter(row => latestMembership.has(row.projectId))
    const keptForLlm = allowed.filter(row => !isLowSignalEpisode(row))
    const careerContext = {
      goal: current.config.goal,
      searchTerms: current.config.searchTerms,
      missingSkills: marketMissingSkills(current),
    }
    const proposals = keptForLlm.length && effectiveModel
      ? await extractEvidence(
        ctx.llm,
        llmCallConfig(current.config, effectiveModel, explicitManual ? { sendToModel: true } : {}),
        keptForLlm,
        signal,
        false,
        activeLocale(),
        { careerContext, careerLevel: current.config.careerLevel, exclusions: core.exclusions ?? [] },
      )
      : []
    const backlog = candidates.some(id => (pending.has(id) && !finished.has(id))
      || (cursors[id] ?? cursorValue(id))?.more || !(cursors[id] ?? cursorValue(id))?.checkedAt)
    const achievements = proposals.filter(p => Boolean(p?.event)).length
    const reflections = proposals.filter(p => Boolean(p?.reflection) && !p?.event).length
    results.push({
      sourceId: SESSION_SOURCE,
      status: 'ok',
      count: allowed.length,
      proposed: proposals.length,
      achievements,
      reflections,
    })
    return { proposals, cursors, results, backlog, finished }
  }

  async function scanBoards(config, signal, core = null) {
    const patrolConfigKey = boardPatrolConfigKey(config)
    const sources = config.boards
    let discovered = [], notices = []
    const primaryResume = core ? resumeFor(core.resumes, undefined, core.defaultMasterTrackId) : null
    const primaryResumeText = primaryResume
      ? (await store.exportResume(primaryResume.id).catch(() => '')).slice(0, 3500)
      : ''
    const control = getControl()
    const patrolProfile = buildPatrolSearchProfile({
      resumeText: primaryResumeText,
      goal: config.goal,
      searchTerms: config.searchTerms,
      evidence: core?.evidence ?? [],
      feedback: control.jobFeedback ?? {},
    })
    // 100% filtered user-owned queries (excluding avoidHints, cities, channels, and company names).
    // When >6 filtered terms exist, anchor the top 2 and rotate the remaining filtered pool across patrol cycles.
    const filteredPool = Array.isArray(patrolProfile.effectiveQueries)
      ? patrolProfile.effectiveQueries
      : patrolProfile.expandedQueries
    let queryKeywords = filteredPool.slice(0, 6)
    if (filteredPool.length > 6) {
      const anchors = filteredPool.slice(0, 2)
      const tail = filteredPool.slice(2)
      const rot = Number(control.watch?.queryRotation || 0) % tail.length
      const rotated = [...tail.slice(rot), ...tail.slice(0, rot)].slice(0, 4)
      queryKeywords = [...anchors, ...rotated]
    }
    if (config.discoverFromWeb && !sources.length && queryKeywords.length) {
      const goalAndTerms = `${config.goal || ''} ${queryKeywords.join(' ')}`
      const wantsDomestic = /[\u4e00-\u9fff]|china|shanghai|beijing|shenzhen|hangzhou|guangzhou|chengdu/i.test(goalAndTerms)
      const configuredScopes = ['experienced', 'campus'].includes(config.hiringScope) ? [config.hiringScope] : []
      const goalScopes = hiringScopesFromText(config.goal)
      const effectiveScopes = goalScopes.length ? goalScopes : configuredScopes
      if (wantsDomestic) {
        const seeds = ['字节跳动', '腾讯', '美团', '智谱 AI', 'MiniMax']
        discovered.push(...seeds.flatMap(name => findNamedCompanyBoards(name).flatMap(board => companyHiringBoards(board, effectiveScopes))).map(validateBoardSource))
      }
      const web = optionalService('web')
      const terms = queryKeywords.slice(0, 6).join(' ').slice(0, 200)
      try {
        if (!web) throw new Error('unavailable')
        const effectiveModel = config.model || await defaultModelRoute()
        const response = await web.search({
          query: `${terms} jobs (site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:jobs.feishu.cn OR site:app.mokahr.com)`,
          maxResults: 20, ...(effectiveModel ? { llmProvider: modelRoute(effectiveModel).provider } : {}),
        }, AbortSignal.any([signal, AbortSignal.timeout(18_000)]))
        const candidates = response.sources.flatMap(entry => {
          if (!entry.url?.startsWith('https://')) return []
          const board = parseBoardInput(entry.url)
          if (!board) return []
          return (effectiveScopes.length ? companyHiringBoards(board, effectiveScopes) : [board]).map(validateBoardSource)
        })
        discovered = [...new Map([...discovered, ...candidates].map(source => [boardSourceId(source), source])).values()].slice(0, 8)
        notices = [{ sourceId: 'dsh-web-search', status: 'ok', count: discovered.length }]
      } catch {
        signal.throwIfAborted()
        if (!discovered.length) notices = [{ sourceId: 'dsh-web-search', status: 'error', error: 'DSH 网页搜索未返回可用结果。' }]
      }
    }
    const latestControl = getControl()
    const existingJdIds = new Set(
      (latestControl.opportunities ?? [])
        .filter(job => job?.id && !job.jdPreview && typeof job.jd === 'string' && job.jd.trim().length > 0)
        .map(job => job.id),
    )
    const result = await collectOpportunities([...sources, ...discovered], { keywords: queryKeywords, existingJdIds })
    return { ...result, discovered, patrolProfile, patrolConfigKey, results: [...notices, ...result.results] }
  }

  async function recordingCall(signal, operation) {
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
    deadline.throwIfAborted()
    let abort
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          abort = () => reject(deadline.reason)
          deadline.addEventListener('abort', abort, { once: true })
        }),
        Promise.resolve().then(() => { deadline.throwIfAborted(); return operation(deadline) }),
      ])
    } finally {
      deadline.removeEventListener('abort', abort)
    }
  }

  async function loadRecording(row, source, signal) {
    const content = await recordingCall(signal, deadline => source.readTranscript(row.recordingId, { signal: deadline }))
    return normalizeTranscript(content)
  }

  async function scanRecordings(core, current, signal, { explicitManual = false } = {}) {
    const distillWork = core.mode !== 'off' && current.config.watchSessions !== false
    const approved = [...recordingSources.values()].flatMap(source => {
      const grant = recordingGrant(core, source.id)
      return grant ? [{ source, grant }] : []
    })
    const discovered = [], results = []
    // An unlimited chat scope does not change the recording lookback.
    const historyStart = Date.now() - (current.config.historyDays ?? defaultHistoryDays) * 86_400_000
    await Promise.all(approved.map(async ({ source, grant }) => {
      if (!source.listRecordings) return
      if (!distillWork && !source.interview) return
      const cutoff = Math.max(historyStart, grant.forgottenAt ? Date.parse(grant.forgottenAt) + 1 : 0)
      const since = new Date(cutoff).toISOString()
      try {
        const list = await recordingCall(signal, deadline => source.listRecordings({ since, limit: 40, signal: deadline }))
        discovered.push(
          ...normalizeRecordingList(source, list).filter(row =>
            row.occurredAt >= since && (distillWork || row.kind !== 'work'),
          ),
        )
      } catch {
        signal.throwIfAborted()
        results.push({ sourceId: RECORDING_PREFIX + source.id, status: 'error', error: '录音插件未返回转写清单。' })
      }
    }))
    const approvedIds = new Set(approved.map(({ source }) => source.id))
    const rows = { recordings: (current.recordings ?? []).map(row => ({ ...row })) }
    const additions = appendRecordings(rows, discovered)
    const work = []
    const effectiveModel = current.config.model || await defaultModelRoute()
    if (distillWork && (current.config.sendToModel || explicitManual) && effectiveModel) {
      const queued = rows.recordings.filter(row => row.kind === 'work' && row.status === 'pending' && approvedIds.has(row.sourceId))
        .sort((left, right) => (left.lastAttemptAt ?? '').localeCompare(right.lastAttemptAt ?? '') || left.occurredAt.localeCompare(right.occurredAt))
      for (const row of queued.slice(0, 2)) {
        signal.throwIfAborted()
        try {
          const source = recordingSources.get(row.sourceId)
          if (!source) continue
          const pieces = workRecordingInputs(row, source, await loadRecording(row, source, signal))
          const careerContext = {
            goal: current.config.goal,
            searchTerms: current.config.searchTerms,
            missingSkills: marketMissingSkills(current),
          }
          const proposals = pieces.length
            ? await extractEvidence(
              ctx.llm,
              llmCallConfig(current.config, effectiveModel, explicitManual ? { sendToModel: true } : {}),
              pieces,
              signal,
              true,
              activeLocale(),
              { careerContext, careerLevel: current.config.careerLevel, exclusions: core.exclusions ?? [] },
            )
            : []
          work.push({ id: row.id, proposals })
        } catch {
          signal.throwIfAborted()
          work.push({ id: row.id, proposals: null })
          results.push({ sourceId: RECORDING_PREFIX + row.sourceId, status: 'error', error: '工作转写整理未完成，将在后续检查重试。' })
        }
      }
    }
    return { additions, work, results }
  }

  async function tick(manual = false, { scope = 'all', explicitManual = false } = {}) {
    if (isClosed() || getRun()) return { running: getRun() !== null }
    const control = getControl()
    const runScope = RUN_SCOPES.has(scope) ? scope : 'all'
    const wantSessions = runScope === 'all' || runScope === 'sessions'
    const wantBoards = runScope === 'all' || runScope === 'boards'
    const wantRecordings = runScope === 'all' || runScope === 'sessions'
    const hasBoards = control.config.boards.length > 0
      || (control.config.discoverFromWeb === true && (control.config.searchTerms?.length ?? 0) > 0)
    const modeNow = getCurrentMode()
    if (!manual && modeNow === 'off') return { paused: true }
    if (manual && runScope === 'sessions' && modeNow === 'off') return { paused: true }
    if (manual && runScope === 'boards' && !hasBoards) return { paused: true, results: [] }
    if (manual && runScope === 'all' && modeNow === 'off' && !hasBoards) return { paused: true }
    const due = Math.min(Date.parse(control.watch.nextRun ?? new Date().toISOString()), getWakeAt() ?? Infinity)
    if (!manual && due > Date.now()) return { due: false }
    const pass = await exclusive(async () => {
      if (isClosed() || getRun()) return { running: getRun() !== null }
      const core = await store.summary()
      const ctrl = getControl()
      const boardsNow = ctrl.config.boards.length > 0
        || (ctrl.config.discoverFromWeb === true && (ctrl.config.searchTerms?.length ?? 0) > 0)
      if (!manual && core.mode === 'off') return { paused: true }
      if (manual && runScope === 'sessions' && core.mode === 'off') return { paused: true }
      if (manual && runScope === 'boards' && !boardsNow) return { paused: true, results: [] }
      if (manual && runScope === 'all' && core.mode === 'off' && !boardsNow) return { paused: true }
      const job = { abort: new AbortController(), revision: getRevision(), startedAt: Date.now(), scope: runScope }
      setRun(job)
      if (wantSessions) setWakeAt(null)
      return { core, job, current: structuredClone(ctrl), pending: new Map(pendingTurns) }
    })
    if (!pass.job) return pass
    const { core, job, current, pending } = pass
    const signal = job.abort.signal
    const runSessionScan = wantSessions && core.mode !== 'off'
    const runBoardScan = wantBoards && (core.mode === 'search' || (manual && (current.config.boards.length > 0 || (current.config.discoverFromWeb === true && (current.config.searchTerms?.length ?? 0) > 0))))
    const runRecordingScan = wantRecordings && core.mode !== 'off'
    try {
      const allowExplicitDistill = manual && explicitManual === true && runScope === 'sessions'
      const [session, board, recordings] = await Promise.allSettled([
        runSessionScan ? scanSessions(core, current, signal, pending, { explicitManual: allowExplicitDistill }) : { proposals: [], cursors: {}, results: [], finished: [], backlog: false },
        runBoardScan ? scanBoards(current.config, signal, core) : { opportunities: [], results: [] },
        runRecordingScan ? scanRecordings(core, current, signal, { explicitManual: allowExplicitDistill }) : { additions: [], work: [], results: [] },
      ])
      if (isClosed() || signal.aborted || getRevision() !== job.revision) return { cancelled: true }
      return await exclusive(async () => {
        if (isClosed() || signal.aborted || getRevision() !== job.revision) return { cancelled: true }
        if (runSessionScan && session.status === 'fulfilled') await consumeEvidence(session.value.proposals, core.preferences.allowReflections)
        const recorded = runRecordingScan ? recordings.value : null
        for (const row of recorded?.work ?? []) {
          if (row.proposals) await consumeEvidence(row.proposals, core.preferences.allowReflections)
        }
        let newRecordings = []
        let freshResults = []
        let newJobsCount = 0
        let boardConfigFresh = true
        await commit(next => {
          if (runSessionScan && session.status === 'fulfilled') Object.assign(next.cursors, session.value.cursors)
          if (runBoardScan && board.status === 'fulfilled') {
            boardConfigFresh = !board.value.patrolConfigKey || board.value.patrolConfigKey === boardPatrolConfigKey(next.config)
            if (boardConfigFresh) {
              next.watch.queryRotation = ((Number(next.watch.queryRotation) || 0) + 4) % 1000
              next.config.boards = [...new Map([...next.config.boards, ...(board.value.discovered ?? [])]
                .map(source => [boardSourceId(source), source])).values()].slice(0, MAX_SOURCES)
              const merged = mergeBoards(next, board.value)
              newJobsCount = merged.newCount
              if (merged.jdChanged) triage.resetCooldown()
              if ((board.value.opportunities?.length ?? 0) > 0) {
                const activeBoardSet = new Set(next.config.boards.map(boardSourceId))
                const activeOpps = next.opportunities.filter(o => o && !o.closedAt && (o.provider === 'manual' || o.oneOff === true || activeBoardSet.has(o.sourceId)))
                const cachedMatches = next.jobMatches ?? {}
                const enriched = activeOpps.map(o => ({ ...o, ...(cachedMatches[o.id] ? { match: cachedMatches[o.id] } : {}) }))
                const nowIso = new Date().toISOString()
                const targetSnap = analyzeMarketCorpus({
                  opportunities: enriched,
                  allRawOpportunities: next.opportunities,
                  activeBoardIds: activeBoardSet,
                  goal: next.config.goal,
                  searchTerms: next.config.searchTerms,
                  history: next.marketHistory ?? [],
                  scope: 'target',
                })
                const allSnap = analyzeMarketCorpus({
                  opportunities: enriched,
                  allRawOpportunities: next.opportunities,
                  activeBoardIds: activeBoardSet,
                  goal: next.config.goal,
                  searchTerms: next.config.searchTerms,
                  history: next.marketHistory ?? [],
                  scope: 'all',
                })
                let hist = recordMarketHistorySnapshot(next.marketHistory ?? [], targetSnap, nowIso)
                hist = recordMarketHistorySnapshot(hist, allSnap, nowIso)
                next.marketHistory = hist
              }
            }
          }
          if (recorded) {
            newRecordings = appendRecordings(next, recorded.additions)
            const attempted = new Map(recorded.work.map(row => [row.id, row]))
            for (const row of next.recordings ?? []) {
              const result = attempted.get(row.id)
              if (!result || row.status !== 'pending') continue
              row.lastAttemptAt = new Date().toISOString()
              if (result.proposals) row.status = 'processed'
            }
          }
          const errors = [session, board, recordings].filter(result => result.status === 'rejected').map(result => result.reason.message)
          const sessionResults = runSessionScan && session.status === 'fulfilled' ? session.value.results : []
          const boardResults = runBoardScan && board.status === 'fulfilled' && boardConfigFresh ? board.value.results : []
          const recordingResults = recorded?.results ?? []
          freshResults = [...sessionResults, ...boardResults, ...recordingResults]
          const isSessionRow = row => row?.sourceId === SESSION_SOURCE || String(row?.sourceId || '').startsWith(RECORDING_PREFIX)
          const prevResults = Array.isArray(next.watch?.results) ? next.watch.results : []
          const mergedResults = runScope === 'boards'
            ? (!boardConfigFresh ? prevResults : [...prevResults.filter(isSessionRow), ...boardResults])
            : runScope === 'sessions'
              ? [...sessionResults, ...recordingResults, ...prevResults.filter(row => !isSessionRow(row))]
              : (!boardConfigFresh ? [...sessionResults, ...recordingResults, ...prevResults.filter(row => !isSessionRow(row))] : freshResults)
          const nextRunValue = core.mode === 'off'
            ? null
            : runScope === 'all'
              ? new Date(Date.now() + (session.value?.backlog ? 1 : next.config.intervalMinutes) * MINUTE).toISOString()
              : (runSessionScan && session.value?.backlog)
                ? new Date(Math.min(Date.parse(next.watch?.nextRun || '') || Infinity, Date.now() + MINUTE)).toISOString()
                : (next.watch?.nextRun ?? new Date(Date.now() + next.config.intervalMinutes * MINUTE).toISOString())
          next.watch = {
            lastRun: new Date(job.startedAt).toISOString(),
            nextRun: nextRunValue,
            lastError: errors.join(' / ') || null,
            results: mergedResults,
            queryRotation: Number(next.watch?.queryRotation) || 0,
          }
        })
        if (runSessionScan) {
          for (const id of session.value?.finished ?? []) {
            if (pendingTurns.get(id) === pending.get(id)) pendingTurns.delete(id)
          }
        }
        const postCommitControl = getControl()
        if (recorded?.work.length &&
          (postCommitControl.recordings ?? []).some(row => row.kind === 'work' && row.status === 'pending' && !row.lastAttemptAt
            && recordingSources.has(row.sourceId) && recordingGrant(core, row.sourceId))) {
          setWakeAt(Math.min(getWakeAt() ?? Infinity, Date.now() + MINUTE))
        }
        for (const row of newRecordings) publish('recording.received', { sourceId: row.sourceId, recordingId: row.id, kind: row.kind })
        publish('watch.finished', {
          scope: runScope,
          evidenceCount: (runSessionScan ? (session.value?.proposals.length ?? 0) : 0)
            + (recorded?.work.reduce((count, row) => count + (row.proposals?.length ?? 0), 0) ?? 0),
        })
        let insightStatus = null
        if (runBoardScan && board.status === 'fulfilled' && boardConfigFresh) {
          const hasExistingInsight = Boolean(postCommitControl.marketInsights?.target?.generatedAt)
          const boardsPatrolOn = core.mode === 'search' && (postCommitControl.config.boards?.length ?? 0) > 0
          const activeBoardSet = new Set(postCommitControl.config.boards.map(boardSourceId))
          const hasActiveFreshJobs = (board.value.opportunities?.length ?? 0) > 0
            || (postCommitControl.opportunities ?? []).some(o => o && !o.closedAt && o.provider !== 'manual' && (o.oneOff === true || activeBoardSet.has(o.sourceId)))
          if (!boardsPatrolOn || postCommitControl.config.sendToModel !== true) {
            insightStatus = 'disabled'
          } else {
            const loc = activeLocale()
            if (hasActiveFreshJobs) {
              void triage.runJobTriage({ force: false, limit: DEFAULT_TRIAGE_BATCH_LIMIT, bypassCooldown: true, locale: loc }).catch(() => {})
            }
            if ((board.value.opportunities?.length ?? 0) > 0) {
              const cooldownOk = Date.now() - getLastAutoInsightAttemptAt() >= 30 * MINUTE
              const resolvedModel = postCommitControl.config.model || await defaultModelRoute().catch(() => '')
              const hasProvider = Boolean(resolvedModel && ctx.llm
                && ctx.llm.listProviders().some(item => item.id === modelRoute(resolvedModel).provider))
              let willRefresh = false
              if (!getMarketInsightRun() && cooldownOk && hasProvider) {
                const { activeBoards, resumeText, basisResume, visibleJobs } = await buildMarketSnapshotContext(core, loc)
                const shareableEvidence = (core.evidence ?? []).filter(isShareableEvidence)
                const targetCheckAnalysis = analyzeMarketCorpus({
                  opportunities: visibleJobs,
                  allRawOpportunities: postCommitControl.opportunities,
                  activeBoardIds: activeBoards,
                  resumeText,
                  evidence: shareableEvidence,
                  goal: postCommitControl.config.goal,
                  searchTerms: postCommitControl.config.searchTerms,
                  history: postCommitControl.marketHistory ?? [],
                  scope: 'target',
                  locale: loc,
                  basisResume,
                })
                willRefresh = targetCheckAnalysis.activeCount > 0 && shouldAutoRefreshMarketInsight({
                  existingReport: postCommitControl.marketInsights?.target ?? null,
                  analysis: targetCheckAnalysis,
                  sendToModel: true,
                  mode: core.mode,
                  boardsOn: boardsPatrolOn,
                }).should
              }
              if (willRefresh) {
                insightStatus = 'updating'
                void generateMarketInsight({ scope: 'target', force: false, auto: true, locale: loc }).catch(() => {})
              } else {
                insightStatus = hasExistingInsight ? 'reused' : 'skipped'
              }
            } else {
              insightStatus = hasExistingInsight ? 'reused' : 'skipped'
            }
          }
        }
        return {
          ...getControl().watch,
          scope: runScope,
          results: freshResults,
          ...(runBoardScan && board.status === 'fulfilled' ? { newJobsCount, insightStatus } : {}),
        }
      })
    } catch (error) {
      if (isClosed() || signal.aborted || getRevision() !== job.revision) return { cancelled: true }
      await exclusive(() => commit(next => {
        next.watch.nextRun = getCurrentMode() === 'off'
          ? null
          : (runScope === 'all' || !next.watch.nextRun)
            ? new Date(Date.now() + next.config.intervalMinutes * MINUTE).toISOString()
            : next.watch.nextRun
        next.watch.lastError = error.message
      }))
      return { error: error.message }
    } finally {
      if (getRun() === job) setRun(null)
    }
  }

  async function ingest(event) {
    if (!event || !SOURCES.has(event.sourceId) || event.sourceId === SESSION_SOURCE) {
      throw new Error('请选择已授权的来源。DSH 会话由后台检查读取。')
    }
    if (!canIngest(await store.summary(), event.sourceId, event.projectId)) throw new Error('此来源或范围尚未授权。')
    const result = await store.ingestEvents([event])
    if (result.accepted) publish('evidence.proposed', { eventId: event.id, count: result.evidence.length })
    return result
  }

  return {
    recordingGrant,
    recordingSummary,
    setRecordingSource,
    registerTranscriptSource,
    loadRecording,
    tick,
    ingest,
  }
}
