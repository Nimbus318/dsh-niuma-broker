import { isArchivedResume, isTailoredBranch, organizeResumeVersions, revisionKindLabel } from './resume-versions.mjs'

const MASTER_COLORS = [
  '#1c6e51', // Lane 0: Default Master — Deep Spruce-Jade
  '#2e597c', // Secondary Master — Deep Maritime Prussian-Steel
  '#6d597a', // Tertiary Master — Mineral Slate-Plum
  '#9c6c1e', // Quaternary Master — Brushed Champagne-Bronze
]

const BRANCH_COLORS = [
  '#b85d38', // Warm Terracotta
  '#2a7b76', // Deep Mineral Teal
  '#a87528', // Ochre Brass
  '#4c5c8a', // Slate Indigo
  '#5a7346', // Botanical Olive
  '#9e4b5b', // Muted Rosewood
]

function tsKey(row) {
  return String(row?.createdAt || row?.sortTime || row?.updatedAt || '')
}

/**
 * Builds a deterministic vertical Git-Graph DAG layout (newest at row 0, oldest at bottom)
 * from the active resume versions tree.
 *
 * Guarantees:
 * - Lane 0 is always reserved for the Default Master Track (clean unbroken vertical spine).
 * - Every child revision is placed strictly above its `parentId` and `baseId` (no upward-pointing parents).
 * - Non-default tracks & job branches reuse non-overlapping lanes >= 1 via interval compaction.
 * - Produces typed edges: `commit` (same track spine), `fork` (branch-out from source master),
 *   and `rebase` (dashed merge-in curve from newer master commit when `origin === 'rebase'`).
 */
export function buildResumeGitGraph(resumes = [], {
  defaultMasterTrackId = '',
  opportunities = [],
  currentId = '',
  filter = 'all',
} = {}) {
  const tree = organizeResumeVersions(resumes, { defaultMasterTrackId, opportunities })
  const allNodes = []
  const nodeById = new Map()
  const trackMeta = new Map()

  tree.masters.forEach((master, mIdx) => {
    const color = MASTER_COLORS[mIdx % MASTER_COLORS.length]
    const key = `master:${master.trackId}`
    trackMeta.set(key, {
      key,
      kind: 'master',
      trackId: master.trackId,
      title: master.title,
      isDefault: master.isDefault,
      color,
      order: mIdx,
    })
    master.revisions.forEach((rev, rIdx) => {
      const prevInTrack = rIdx > 0 ? master.revisions[rIdx - 1] : null
      const node = {
        id: rev.id,
        trackKey: key,
        isMaster: true,
        isDefaultMaster: master.isDefault,
        trackId: master.trackId,
        trackTitle: master.title,
        branchLabel: master.title,
        company: '',
        jobTitle: '',
        opportunityId: '',
        versionNumber: rev.versionNumber,
        versionTag: rev.versionTag,
        changeLabel: rev.changeLabel,
        status: rev.status,
        origin: rev.origin || '',
        summary: rev.summary || '',
        placements: Array.isArray(rev.placements) ? rev.placements : [],
        sortTime: rev.sortTime || tsKey(rev),
        createdAt: tsKey(rev),
        isHead: rev.id === master.latest?.id,
        isApprovedHead: rev.id === master.latestApproved?.id,
        isCurrent: rev.id === currentId,
        masterBehind: false,
        masterLatestVersion: master.latestApproved?.versionNumber ?? master.versionCount,
        sourceTrackId: rev.sourceTrackId || '',
        sourceTrackTitle: '',
        sourceBaseVersion: null,
        sameTrackParentId: prevInTrack?.id || '',
        rawParentId: rev.parentId || '',
        rawBaseId: rev.baseId || '',
        color,
        raw: rev,
      }
      allNodes.push(node)
      nodeById.set(node.id, node)
    })
  })

  tree.branches.forEach((branch, bIdx) => {
    const color = BRANCH_COLORS[bIdx % BRANCH_COLORS.length]
    const key = `branch:${branch.opportunityId}`
    trackMeta.set(key, {
      key,
      kind: 'branch',
      opportunityId: branch.opportunityId,
      title: branch.label,
      company: branch.company,
      jobTitle: branch.jobTitle,
      isDefault: false,
      color,
      order: tree.masters.length + bIdx,
    })
    branch.revisions.forEach((rev, rIdx) => {
      const prevInBranch = rIdx > 0 ? branch.revisions[rIdx - 1] : null
      const node = {
        id: rev.id,
        trackKey: key,
        isMaster: false,
        isDefaultMaster: false,
        trackId: '',
        trackTitle: branch.label,
        branchLabel: branch.label,
        company: branch.company || '',
        jobTitle: branch.jobTitle || '',
        opportunityId: branch.opportunityId,
        versionNumber: rev.versionNumber,
        versionTag: rev.versionTag,
        changeLabel: rev.changeLabel,
        status: rev.status,
        origin: rev.origin || '',
        summary: rev.summary || '',
        placements: Array.isArray(rev.placements) ? rev.placements : [],
        sortTime: rev.sortTime || tsKey(rev),
        createdAt: tsKey(rev),
        isHead: rev.id === branch.latest?.id,
        isApprovedHead: rev.id === branch.latestApproved?.id,
        isCurrent: rev.id === currentId,
        masterBehind: Boolean(rev.masterBehind),
        masterLatestVersion: rev.masterLatestVersion ?? null,
        sourceTrackId: rev.sourceTrackId || '',
        sourceTrackTitle: rev.sourceTrackTitle || '',
        sourceBaseVersion: rev.sourceBaseVersion ?? null,
        sameTrackParentId: prevInBranch?.id || '',
        rawParentId: rev.parentId || '',
        rawBaseId: rev.baseId || '',
        color,
        raw: rev,
      }
      allNodes.push(node)
      nodeById.set(node.id, node)
    })
  })

  // Resolve master-fork lineage for secondary master tracks created via `branchMasterResume`
  for (const node of allNodes) {
    if (node.isMaster && !node.sameTrackParentId) {
      const anchorId = node.raw?.branchedFromId || node.rawParentId || node.rawBaseId
      const anchor = anchorId ? nodeById.get(anchorId) : null
      if (anchor && anchor.trackKey !== node.trackKey) {
        node.forkFromId = anchor.id
        node.sourceTrackTitle = anchor.trackTitle
        node.sourceBaseVersion = anchor.versionNumber
      }
    } else if (!node.isMaster && !node.sameTrackParentId) {
      const anchorId = node.rawBaseId || node.rawParentId
      const anchor = anchorId ? nodeById.get(anchorId) : null
      if (anchor && anchor.trackKey !== node.trackKey) {
        node.forkFromId = anchor.id
      }
    }
    if (!node.isMaster && node.origin === 'rebase' && node.rawBaseId && nodeById.has(node.rawBaseId)) {
      const prevNode = node.sameTrackParentId ? nodeById.get(node.sameTrackParentId) : null
      if (node.rawBaseId !== prevNode?.rawBaseId) {
        node.rebaseFromId = node.rawBaseId
      }
    }
  }

  // Filter visibility cleanly while preserving relevant lineage anchors
  const behindBranches = new Set(
    tree.branches.filter(b => b.latest?.masterBehind).map(b => `branch:${b.opportunityId}`),
  )
  let visibleNodes = allNodes
  if (filter === 'masters') {
    visibleNodes = allNodes.filter(n => n.isMaster)
  } else if (filter === 'branches') {
    const branchIds = new Set(allNodes.filter(n => !n.isMaster).map(n => n.id))
    const anchorIds = new Set()
    for (const n of allNodes) {
      if (!n.isMaster) {
        if (n.forkFromId) anchorIds.add(n.forkFromId)
        if (n.rebaseFromId) anchorIds.add(n.rebaseFromId)
      }
    }
    visibleNodes = allNodes.filter(n => branchIds.has(n.id) || anchorIds.has(n.id))
  } else if (filter === 'behind') {
    const relevantMasters = new Set(
      tree.branches
        .filter(b => b.latest?.masterBehind && b.latest?.sourceTrackId)
        .map(b => `master:${b.latest.sourceTrackId}`),
    )
    visibleNodes = allNodes.filter(n => behindBranches.has(n.trackKey) || relevantMasters.has(n.trackKey))
  }

  const visibleSet = new Set(visibleNodes.map(n => n.id))

  // Topological + newest-first ordering so children are ALWAYS strictly above their parents/anchors
  const depsOf = node => {
    const deps = []
    if (node.sameTrackParentId && visibleSet.has(node.sameTrackParentId)) deps.push(node.sameTrackParentId)
    if (node.forkFromId && visibleSet.has(node.forkFromId)) deps.push(node.forkFromId)
    if (node.rebaseFromId && visibleSet.has(node.rebaseFromId)) deps.push(node.rebaseFromId)
    return deps
  }

  const childCount = new Map(visibleNodes.map(n => [n.id, 0]))
  const parentsOf = new Map()
  for (const n of visibleNodes) {
    const deps = [...new Set(depsOf(n))]
    parentsOf.set(n.id, deps)
    for (const p of deps) {
      childCount.set(p, (childCount.get(p) || 0) + 1)
    }
  }

  // Kahn's algorithm picking newest available child first (top-down = newest -> oldest)
  const ready = visibleNodes.filter(n => (childCount.get(n.id) || 0) === 0)
  const cmpNewest = (a, b) =>
    b.createdAt.localeCompare(a.createdAt)
    || b.sortTime.localeCompare(a.sortTime)
    || (Number(b.isDefaultMaster) - Number(a.isDefaultMaster))
    || (b.versionNumber - a.versionNumber)
  ready.sort(cmpNewest)

  const ordered = []
  const placed = new Set()
  while (ready.length > 0) {
    const next = ready.shift()
    if (placed.has(next.id)) continue
    placed.add(next.id)
    ordered.push(next)
    for (const pId of parentsOf.get(next.id) || []) {
      const rem = (childCount.get(pId) || 1) - 1
      childCount.set(pId, rem)
      if (rem === 0 && !placed.has(pId)) {
        const pNode = nodeById.get(pId)
        if (pNode) {
          ready.push(pNode)
          ready.sort(cmpNewest)
        }
      }
    }
  }
  // Safety net for any unexpected cycle
  for (const n of visibleNodes.slice().sort(cmpNewest)) {
    if (!placed.has(n.id)) ordered.push(n)
  }

  const rowById = new Map()
  ordered.forEach((node, idx) => {
    node.row = idx
    rowById.set(node.id, idx)
  })

  // Compute vertical spans per trackKey so non-overlapping branches share lanes cleanly
  const spans = new Map()
  for (const node of ordered) {
    const cur = spans.get(node.trackKey) || { key: node.trackKey, top: node.row, bottom: node.row, isDefault: node.isDefaultMaster, isMaster: node.isMaster }
    cur.top = Math.min(cur.top, node.row)
    cur.bottom = Math.max(cur.bottom, node.row)
    if (node.forkFromId && rowById.has(node.forkFromId)) {
      cur.bottom = Math.max(cur.bottom, rowById.get(node.forkFromId))
    }
    spans.set(node.trackKey, cur)
  }

  const laneByTrack = new Map()
  const laneIntervals = [] // array of arrays of [top, bottom]

  const defaultTrackKey = tree.defaultMasterTrackId ? `master:${tree.defaultMasterTrackId}` : ''
  if (defaultTrackKey && spans.has(defaultTrackKey)) {
    laneByTrack.set(defaultTrackKey, 0)
    laneIntervals[0] = [[0, Math.max(0, ordered.length - 1)]]
  }

  const otherSpans = [...spans.values()]
    .filter(s => s.key !== defaultTrackKey)
    .sort((a, b) => Number(b.isMaster) - Number(a.isMaster) || a.top - b.top || (b.bottom - b.top) - (a.bottom - a.top))

  for (const span of otherSpans) {
    let assigned = -1
    const startLane = laneIntervals[0] ? 1 : 0
    for (let lane = startLane; lane < laneIntervals.length; lane += 1) {
      const overlaps = (laneIntervals[lane] || []).some(([t, b]) => !(span.bottom < t || span.top > b))
      if (!overlaps) {
        assigned = lane
        break
      }
    }
    if (assigned < 0) {
      assigned = Math.max(startLane, laneIntervals.length)
      laneIntervals[assigned] = []
    }
    laneByTrack.set(span.key, assigned)
    laneIntervals[assigned].push([span.top, span.bottom])
  }

  for (const node of ordered) {
    node.lane = laneByTrack.get(node.trackKey) ?? 0
  }

  // Build typed DAG edges
  const edges = []
  for (const node of ordered) {
    if (node.sameTrackParentId && rowById.has(node.sameTrackParentId)) {
      const parent = nodeById.get(node.sameTrackParentId)
      edges.push({
        id: `commit:${node.id}->${parent.id}`,
        kind: 'commit',
        fromId: node.id,
        toId: parent.id,
        fromRow: node.row,
        fromLane: node.lane,
        toRow: parent.row,
        toLane: parent.lane,
        color: node.color,
      })
    }
    if (node.forkFromId && rowById.has(node.forkFromId)) {
      const anchor = nodeById.get(node.forkFromId)
      edges.push({
        id: `fork:${node.id}->${anchor.id}`,
        kind: 'fork',
        fromId: node.id,
        toId: anchor.id,
        fromRow: node.row,
        fromLane: node.lane,
        toRow: anchor.row,
        toLane: anchor.lane,
        color: node.color,
      })
    }
    if (node.rebaseFromId && rowById.has(node.rebaseFromId)) {
      const source = nodeById.get(node.rebaseFromId)
      edges.push({
        id: `rebase:${node.id}->${source.id}`,
        kind: 'rebase',
        fromId: node.id,
        toId: source.id,
        fromRow: node.row,
        fromLane: node.lane,
        toRow: source.row,
        toLane: source.lane,
        color: '#1c6e51',
      })
    }
  }

  const laneCount = Math.max(1, ...ordered.map(n => n.lane + 1))

  const oppById = new Map((Array.isArray(opportunities) ? opportunities : []).filter(Boolean).map(o => [o.id, o]))
  const archived = (Array.isArray(resumes) ? resumes : [])
    .filter(isArchivedResume)
    .map(row => {
      const isBranch = isTailoredBranch(row)
      const opp = row.opportunityId ? oppById.get(row.opportunityId) : null
      return {
        id: row.id,
        isMaster: !isBranch,
        title: isBranch
          ? (opp ? [opp.company, opp.title].filter(Boolean).join(' · ') : (row.title || '岗位定向版'))
          : (row.trackTitle || row.title || '主干母版'),
        company: opp?.company || '',
        jobTitle: opp?.title || '',
        status: row.status,
        changeLabel: revisionKindLabel(row, 1),
        archivedAt: row.archivedAt,
        createdAt: tsKey(row),
        summary: row.summary || '',
        raw: row,
      }
    })
    .sort((a, b) => String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')))

  return {
    nodes: ordered,
    edges,
    laneCount,
    archived,
    counts: {
      total: allNodes.length,
      masters: tree.masters.length,
      branches: tree.branches.length,
      behind: behindBranches.size,
      archived: archived.length,
    },
    tree,
  }
}
