const GENERIC_TITLES = new Set(['对话优化稿', '简历更新', '已选改动', '基础简历', '导入简历', '岗位定制简历'])

export function resumeTimestamp(row) {
  return String(row?.updatedAt || row?.reviewedAt || row?.createdAt || '')
}

export function isActiveResume(row) {
  return Boolean(row && !row.archivedAt && (row.status === 'approved' || row.status === 'pending'))
}

export function isArchivedResume(row) {
  return Boolean(row && row.archivedAt && (row.status === 'approved' || row.status === 'pending'))
}

export function isTailoredBranch(row) {
  return Boolean(row && (row.opportunityId || row.general === false || (row.kind === 'tailored' && row.general !== true)))
}

export function revisionKindLabel(row, index) {
  if (!row) return ''
  if (index === 0 && row.kind === 'import') return '导入底稿'
  if (row.origin === 'rebase') return '同步主干'
  if (row.variant === 'conversation' || row.origin === 'resume-conversation') return 'AI 改稿'
  if (row.kind === 'generated' || row.origin === 'evidence') return '并入成果'
  if (row.kind === 'revised') return row.autoSaved && row.status === 'pending' ? '编辑中' : '手动修订'
  if (row.kind === 'tailored' && row.opportunityId) return '岗位定制'
  if (row.kind === 'import') return '导入底稿'
  return '修订'
}

/**
 * Resolves the canonical Master Track ID for any resume record (supports both
 * explicit `trackId` on v0.14+ records and automatic ancestor-chain folding for
 * legacy records without `trackId`).
 */
export function resolveTrackId(row, byId) {
  if (!row) return ''
  if (row.trackId) return row.trackId
  if (row.opportunityId && row.sourceTrackId) return row.sourceTrackId
  const visited = new Set()
  let cursor = row
  let lastGeneral = row.opportunityId ? null : row
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    if (cursor.trackId) return cursor.trackId
    if (!cursor.opportunityId) lastGeneral = cursor
    const nextId = cursor.parentId || cursor.baseId
    if (!nextId || !byId.has(nextId)) break
    cursor = byId.get(nextId)
  }
  return lastGeneral?.id || cursor?.id || row.id
}

function pickTrackTitle(revisions) {
  // Prefer explicit trackTitle (newest wins)
  for (let i = revisions.length - 1; i >= 0; i -= 1) {
    const t = String(revisions[i]?.trackTitle || '').trim()
    if (t) return t
  }
  // Next prefer newest non-generic title
  for (let i = revisions.length - 1; i >= 0; i -= 1) {
    const t = String(revisions[i]?.title || '').trim()
    if (t && !GENERIC_TITLES.has(t)) return t
  }
  // Fall back to root title, then newest title
  for (const row of revisions) {
    const t = String(row?.title || '').trim()
    if (t) return t
  }
  return '主干简历'
}

/**
 * Organizes flat `state.resumes` into the 3-layer model:
 * 1. `masters`: Master Tracks, each holding folded `revisions` (v1 -> v2 -> ... -> vN),
 *    `head` (latest approved or newest), `latest` (newest including working draft),
 *    `workingDraft` (newest pending edit if newer than approved head), `isDefault`.
 * 2. `branches`: Job-tailored branches grouped by `opportunityId`, each knowing its
 *    `sourceTrackId`, `sourceTrackTitle`, `sourceVersionNumber`, and `masterBehind` flag.
 * 3. Lookup maps (`versionNumberById`, `trackById`, `masterByTrackId`) for O(1) UI queries.
 */
export function organizeResumeVersions(resumes = [], { defaultMasterTrackId = '', opportunities = [] } = {}) {
  const all = Array.isArray(resumes) ? resumes.filter(Boolean) : []
  const byId = new Map(all.map(r => [r.id, r]))
  const active = all.filter(isActiveResume)
  const oppById = new Map((Array.isArray(opportunities) ? opportunities : []).filter(Boolean).map(o => [o.id, o]))

  const masterGroups = new Map()
  const branchGroups = new Map()

  for (const row of active) {
    if (isTailoredBranch(row)) {
      const oppId = row.opportunityId || `jd:${row.baseId || row.parentId || row.id}`
      if (!branchGroups.has(oppId)) branchGroups.set(oppId, [])
      branchGroups.get(oppId).push(row)
    } else {
      const trackId = resolveTrackId(row, byId)
      if (!masterGroups.has(trackId)) masterGroups.set(trackId, [])
      masterGroups.get(trackId).push(row)
    }
  }

  const versionNumberById = new Map()
  const trackIdByResumeId = new Map()
  const masters = []

  for (const [trackId, group] of masterGroups) {
    const chronological = group.slice().sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || resumeTimestamp(a).localeCompare(resumeTimestamp(b)),
    )
    const title = pickTrackTitle(chronological)
    const revisions = chronological.map((row, idx) => {
      const versionNumber = idx + 1
      versionNumberById.set(row.id, versionNumber)
      trackIdByResumeId.set(row.id, trackId)
      return {
        ...row,
        trackId,
        trackTitle: title,
        versionNumber,
        versionTag: `v${versionNumber}`,
        changeLabel: revisionKindLabel(row, idx),
        sortTime: resumeTimestamp(row),
      }
    })
    const latest = revisions.at(-1)
    const latestApproved = revisions.findLast(r => r.status === 'approved') ?? null
    const workingDraft = latest?.status === 'pending' ? latest : null
    const head = latestApproved ?? latest
    masters.push({
      trackId,
      title,
      revisions,
      latest,
      latestApproved,
      workingDraft,
      head,
      versionCount: revisions.length,
      updatedAt: resumeTimestamp(latest),
      isDefault: false,
    })
  }

  masters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const resolvedDefaultTrackId = (defaultMasterTrackId && masters.some(m => m.trackId === defaultMasterTrackId))
    ? defaultMasterTrackId
    : (masters[0]?.trackId || '')
  for (const m of masters) {
    m.isDefault = m.trackId === resolvedDefaultTrackId
  }
  masters.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt))

  const masterByTrackId = new Map(masters.map(m => [m.trackId, m]))

  const branches = []
  for (const [opportunityId, group] of branchGroups) {
    const chronological = group.slice().sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || resumeTimestamp(a).localeCompare(resumeTimestamp(b)),
    )
    const opp = oppById.get(opportunityId) || null
    const customBranchTitle = chronological.findLast(r => typeof r.trackTitle === 'string' && r.trackTitle.trim())?.trackTitle?.trim() || ''
    const branchLabel = customBranchTitle || (opp ? [opp.company, opp.title].filter(Boolean).join(' · ') : (chronological.at(-1)?.title || '岗位定制'))
    const revisions = chronological.map((row, idx) => {
      const versionNumber = idx + 1
      const sourceTrackId = row.sourceTrackId || resolveTrackId(byId.get(row.baseId || row.parentId), byId) || ''
      const sourceMaster = sourceTrackId ? masterByTrackId.get(sourceTrackId) || null : null
      const sourceBaseVersion = row.baseId ? (versionNumberById.get(row.baseId) ?? null) : null
      const masterLatestRow = sourceMaster?.latestApproved ?? sourceMaster?.latest ?? null
      const masterLatestVersion = masterLatestRow?.versionNumber ?? sourceMaster?.versionCount ?? null
      const masterBehind = Boolean(sourceBaseVersion && masterLatestVersion && masterLatestVersion > sourceBaseVersion)
      const baseRow = row.baseId ? byId.get(row.baseId) : null
      const normBody = rec => {
        if (!rec) return null
        if (typeof rec.previewText === 'string' && rec.previewText.trim()) return rec.previewText.replace(/\r\n/g, '\n').trim()
        if (typeof rec.text === 'string' && rec.text.trim()) return rec.text.replace(/\r\n/g, '\n').trim()
        return null
      }
      const latestMasterBody = normBody(masterLatestRow)
      const baseMasterBody = normBody(baseRow)
      const branchBody = normBody(row)
      const masterHasContentDiff = masterBehind
        ? (latestMasterBody !== null && baseMasterBody !== null
          ? latestMasterBody !== baseMasterBody && (branchBody === null || latestMasterBody !== branchBody)
          : true)
        : false
      versionNumberById.set(row.id, versionNumber)
      return {
        ...row,
        trackTitle: branchLabel,
        versionNumber,
        versionTag: `v${versionNumber}`,
        changeLabel: revisionKindLabel(row, idx),
        sourceTrackId,
        sourceTrackTitle: sourceMaster?.title || '',
        sourceBaseVersion,
        masterLatestVersion,
        masterBehind,
        masterHasContentDiff,
        sortTime: resumeTimestamp(row),
      }
    })
    const latest = revisions.at(-1)
    const latestApproved = revisions.findLast(r => r.status === 'approved') ?? null
    const head = latestApproved ?? latest
    branches.push({
      opportunityId,
      company: opp?.company || '',
      jobTitle: opp?.title || '',
      label: branchLabel,
      revisions,
      latest,
      latestApproved,
      head,
      versionCount: revisions.length,
      updatedAt: resumeTimestamp(latest),
    })
  }
  branches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    masters,
    branches,
    defaultMasterTrackId: resolvedDefaultTrackId,
    masterByTrackId,
    versionNumberById,
    trackIdByResumeId,
  }
}

/**
 * Picks the best default resume for a job's submission/preview dropdown:
 * 1. Job's own latest tailored branch (preferring approved, else pending);
 * 2. The user's currently active editor resume if it's a general/master resume (so edits in 简历 tab immediately connect!);
 * 3. Default Master Track's latest revision (including active working draft if newer than approved).
 */
export function buildJobResumePickerModel(resumes = [], {
  jobId = '',
  defaultMasterTrackId = '',
  currentEditorResumeId = '',
  opportunities = [],
} = {}) {
  const tree = organizeResumeVersions(resumes, { defaultMasterTrackId, opportunities })
  const jobBranch = tree.branches.find(b => b.opportunityId === jobId) || null

  const tailoredOptions = jobBranch
    ? jobBranch.revisions.slice().reverse().map((r, idx) => ({
        id: r.id,
        title: r.title || jobBranch.label,
        status: r.status,
        createdAt: r.updatedAt || r.createdAt,
        text: r.previewText || r.text || '',
        isTailored: true,
        isCurrentEditor: r.id === currentEditorResumeId,
        versionTag: r.versionTag,
        lineage: r.sourceTrackTitle
          ? `基于 ${r.sourceTrackTitle}${r.sourceBaseVersion ? ` v${r.sourceBaseVersion}` : ''}`
          : '',
        masterBehind: r.masterBehind,
        isPrimary: idx === 0,
        ...(r.appearance ? { appearance: r.appearance } : {}),
      }))
    : []

  const masterOptions = []
  const historyOptions = []

  for (const master of tree.masters) {
    // Primary selectable item for each master track:
    // If the user is actively editing a working draft in this track (latest is pending),
    // expose BOTH the latest working draft (marked 编辑中) AND the latest approved head (if distinct)
    // so the user ALWAYS sees the exact resume they just wrote!
    const primary = master.latest
    if (primary) {
      masterOptions.push({
        id: primary.id,
        trackId: master.trackId,
        title: master.title,
        status: primary.status,
        createdAt: primary.updatedAt || primary.createdAt,
        text: primary.previewText || primary.text || '',
        isTailored: false,
        isDefaultMaster: master.isDefault,
        isCurrentEditor: primary.id === currentEditorResumeId,
        versionTag: primary.versionTag,
        changeLabel: primary.changeLabel,
        ...(primary.appearance ? { appearance: primary.appearance } : {}),
      })
    }
    if (master.workingDraft && master.latestApproved && master.latestApproved.id !== master.workingDraft.id) {
      const app = master.latestApproved
      masterOptions.push({
        id: app.id,
        trackId: master.trackId,
        title: master.title,
        status: app.status,
        createdAt: app.updatedAt || app.createdAt,
        text: app.previewText || app.text || '',
        isTailored: false,
        isDefaultMaster: master.isDefault,
        isCurrentEditor: app.id === currentEditorResumeId,
        versionTag: app.versionTag,
        changeLabel: '已定稿主干',
        ...(app.appearance ? { appearance: app.appearance } : {}),
      })
    }
    const shownIds = new Set(masterOptions.map(o => o.id))
    for (const rev of master.revisions.slice().reverse()) {
      if (shownIds.has(rev.id)) continue
      historyOptions.push({
        id: rev.id,
        trackId: master.trackId,
        title: master.title,
        status: rev.status,
        createdAt: rev.updatedAt || rev.createdAt,
        text: rev.previewText || rev.text || '',
        isTailored: false,
        isCurrentEditor: rev.id === currentEditorResumeId,
        versionTag: rev.versionTag,
        changeLabel: rev.changeLabel,
        ...(rev.appearance ? { appearance: rev.appearance } : {}),
      })
    }
  }

  // Sort masterOptions: currently edited resume first if it's in masterOptions, then default master, then newest
  masterOptions.sort((a, b) =>
    Number(b.isCurrentEditor) - Number(a.isCurrentEditor)
    || Number(b.isDefaultMaster) - Number(a.isDefaultMaster)
    || String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )

  const allOptions = [...tailoredOptions, ...masterOptions, ...historyOptions]
  const approvedOptions = allOptions.filter(o => o.status === 'approved')
  const defaultApprovedChoice = tailoredOptions.find(o => o.status === 'approved')
    ?? masterOptions.find(o => o.status === 'approved' && o.isCurrentEditor)
    ?? masterOptions.find(o => o.status === 'approved')
    ?? historyOptions.find(o => o.status === 'approved')
    ?? null

  const defaultChoice = tailoredOptions[0]
    ?? masterOptions.find(o => o.isCurrentEditor)
    ?? masterOptions[0]
    ?? historyOptions[0]
    ?? null

  return {
    tree,
    tailoredOptions,
    masterOptions,
    historyOptions,
    allOptions,
    approvedOptions,
    defaultApprovedChoice,
    defaultChoice,
  }
}
