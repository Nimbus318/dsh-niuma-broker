export function deriveAutomationFlags(state = {}) {
  const config = state?.config ?? {}
  const mode = state?.mode ?? config.mode ?? 'off'
  const running = mode !== 'off'
  const sources = Array.isArray(config.sources) ? config.sources : []
  const recordings = Array.isArray(state?.recordings?.sources) ? state.recordings.sources : []

  const hasSessionWork = sources.some(
    s => s?.id === 'dsh-session' && !s.revokedAt && Array.isArray(s.projects) && s.projects.length > 0,
  )
  const hasWorkRecording = recordings.some(s => s?.enabled && s.available && s.work)
  const hasInterviewRecording = recordings.some(s => s?.enabled && s.available && s.interview)
  const hasSavedWorkSource = hasSessionWork || hasWorkRecording

  const sessionsOn = running && config.watchSessions !== false && hasSavedWorkSource
  const boardsOn = mode === 'search' && Array.isArray(config.boards) && config.boards.length > 0
  const autoIntelOn = running && config.sendToModel === true && config.autoJobIntel === true
  const anyAutoOn = sessionsOn || boardsOn || autoIntelOn || (running && hasInterviewRecording)

  return {
    running,
    hasSessionWork,
    hasWorkRecording,
    hasInterviewRecording,
    hasSavedWorkSource,
    sessionsOn,
    boardsOn,
    autoIntelOn,
    anyAutoOn,
  }
}

export function buildBoardsTogglePatch(state, nextOn) {
  const { sessionsOn, autoIntelOn, hasInterviewRecording } = deriveAutomationFlags(state)
  if (nextOn) {
    return {
      mode: 'search',
      watchSessions: sessionsOn,
      sendToModel: true,
    }
  }
  const stayActive = sessionsOn || autoIntelOn || hasInterviewRecording
  return {
    mode: stayActive ? 'observe' : 'off',
    watchSessions: sessionsOn,
    ...(stayActive ? {} : { sendToModel: false }),
  }
}

export function buildSessionsTogglePatch(state, nextOn, { timezone } = {}) {
  const { boardsOn, autoIntelOn, hasInterviewRecording } = deriveAutomationFlags(state)
  if (nextOn) {
    return {
      mode: boardsOn ? 'search' : 'observe',
      watchSessions: true,
      sendToModel: true,
      ...(timezone ? { timezone } : {}),
    }
  }
  const stayActive = boardsOn || autoIntelOn || hasInterviewRecording
  return {
    watchSessions: false,
    mode: boardsOn ? 'search' : (stayActive ? 'observe' : 'off'),
    ...(stayActive ? {} : { sendToModel: false }),
  }
}

export function buildAutoIntelTogglePatch(state, nextOn) {
  const { running, sessionsOn, boardsOn, hasInterviewRecording } = deriveAutomationFlags(state)
  if (nextOn) {
    return {
      autoJobIntel: true,
      sendToModel: true,
      ...(running ? {} : { mode: 'observe', watchSessions: false }),
    }
  }
  const stayActive = sessionsOn || boardsOn || hasInterviewRecording
  return {
    autoJobIntel: false,
    ...(stayActive ? {} : { mode: 'off', sendToModel: false }),
  }
}

export function buildScopeSavePatch(state, { projects = [], hasSource = false } = {}) {
  const { boardsOn, autoIntelOn, hasInterviewRecording } = deriveAutomationFlags(state)
  if (hasSource) return { projects }
  const stayActive = boardsOn || autoIntelOn || hasInterviewRecording
  return {
    projects,
    watchSessions: false,
    mode: boardsOn ? 'search' : (stayActive ? 'observe' : 'off'),
    ...(stayActive ? {} : { sendToModel: false }),
  }
}

export function formatBoardScanToast(result, t) {
  const count = Number.isFinite(Number(result?.newJobsCount)) ? Math.max(0, Math.floor(Number(result.newJobsCount))) : 0
  const status = typeof result?.insightStatus === 'string' ? result.insightStatus : ''
  if (status === 'updating') {
    return count > 0
      ? t('boards.scanDoneNewUpdating', { count })
      : t('boards.scanDoneUpdating')
  }
  if (status === 'reused') {
    return count > 0
      ? t('boards.scanDoneNewReused', { count })
      : t('boards.scanDoneReused')
  }
  if (status === 'disabled') {
    return count > 0
      ? t('boards.scanDoneNewNoModel', { count })
      : t('boards.scanDoneNoModel')
  }
  return count > 0
    ? t('boards.scanDoneNewOnly', { count })
    : t('boards.scanDoneToast')
}
