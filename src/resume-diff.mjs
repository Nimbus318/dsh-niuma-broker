const SECTION_HEADING_RE = /^#{2,3}\s+(.+?)\s*$/u
const BULLET_PREFIX_RE = /^([ \t]*(?:(?:[-*+]|[1-9]\d?[.)])[ \t]+|(?:[•·▪●○]|[1-9]\d?、)[ \t]*))(.*)$/u

function splitLines(text) {
  const raw = String(text ?? '')
  const sep = raw.includes('\r\n') ? '\r\n' : '\n'
  return { sep, lines: raw.split(/\r?\n/u) }
}

function stripBullet(line = '') {
  return BULLET_PREFIX_RE.exec(line)?.[2]?.trim() ?? String(line || '').trim()
}

function nearestSection(lines, index) {
  let sub = ''
  let main = ''
  for (let i = Math.min(index, lines.length - 1); i >= 0; i -= 1) {
    const raw = String(lines[i] || '').trim()
    if (!sub && /^###\s+/u.test(raw)) sub = raw.replace(/^###\s+/u, '').trim()
    if (/^##\s+/u.test(raw)) {
      main = raw.replace(/^##\s+/u, '').trim()
      break
    }
  }
  return sub && main ? `${main} · ${sub}` : (sub || main || '')
}

function extractTokens(text = '') {
  return [...String(text || '').toLowerCase().matchAll(/[\u4e00-\u9fff]{2,4}|[a-z0-9._+-]{3,}/giu)]
    .map(m => m[0])
    .filter(tok => !['优化', '调整', '补充', '精简', '更新', '结构', '表述', '简历', '经历', '修改', '新增', '删除', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'resume', 'update', 'updated', 'refine', 'edit', 'added', 'line'].includes(tok))
}

function matchModelReason(item, modelChanges, usedIndices, locale = 'zh') {
  const isEn = String(locale || '').toLowerCase().startsWith('en')
  if (Array.isArray(modelChanges) && modelChanges.length > 0) {
    const itemTokens = new Set(extractTokens(`${item.source || ''} ${item.text || ''} ${item.section || ''}`))
    let bestIdx = -1
    let bestScore = -1
    for (let i = 0; i < modelChanges.length; i += 1) {
      const ch = modelChanges[i]
      if (!ch || typeof ch.summary !== 'string' || !ch.summary.trim()) continue
      let score = usedIndices.has(i) ? 0 : 2
      if ((item.kind === 'insert' && ch.kind === 'add')
        || (item.kind === 'delete' && ch.kind === 'delete')
        || (item.kind === 'edit' && (ch.kind === 'edit' || ch.kind === 'reorder'))) {
        score += 2
      }
      const chTokens = extractTokens(ch.summary)
      for (const tok of chTokens) {
        if (itemTokens.has(tok)) score += 3
      }
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestScore >= 2) {
      usedIndices.add(bestIdx)
      return modelChanges[bestIdx].summary.trim()
    }
  }
  if (item.kind === 'insert') return isEn ? 'Add new experience or detail' : '补充新增经历与要点'
  if (item.kind === 'delete') return isEn ? 'Trim redundant wording' : '精简移除冗余表述'
  return isEn ? 'Tighten & clarify wording' : '优化精炼表达'
}

/**
 * Exact LCS-based line diff between two Markdown resumes.
 * Produces deterministic, reversible, hunk-anchored reviewable items with section labels and brief reasons.
 */
export function computeReviewableLineChanges(beforeText, afterText, modelChanges = [], { locale = 'zh' } = {}) {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  if (beforeText === afterText) return []

  const a = before.lines
  const b = after.lines
  // Trim common prefix and suffix to keep DP matrix tiny even on long documents
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const n = midA.length
  const m = midB.length

  // Standard LCS over middle slice (fallback to single hunk if extraordinarily huge > 1200x1200)
  const ops = []
  if (n * m <= 1_440_000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ type: 'eq', bi: prefix + i, ai: prefix + j })
        i += 1
        j += 1
      } else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ type: 'del', bi: prefix + i, ai: prefix + j, line: midA[i] })
        i += 1
      } else {
        ops.push({ type: 'ins', bi: prefix + i, ai: prefix + j, line: midB[j] })
        j += 1
      }
    }
  } else {
    for (let i = 0; i < n; i += 1) ops.push({ type: 'del', bi: prefix + i, ai: prefix, line: midA[i] })
    for (let j = 0; j < m; j += 1) ops.push({ type: 'ins', bi: prefix + n, ai: prefix + j, line: midB[j] })
  }

  // Group contiguous non-equal operations into hunks, then pair lines cleanly inside each hunk
  const items = []
  const usedModelIdx = new Set()
  let idx = 0
  let seq = 0
  while (idx < ops.length) {
    if (ops[idx].type === 'eq') { idx += 1; continue }
    const dels = []
    const ins = []
    while (idx < ops.length && ops[idx].type !== 'eq') {
      if (ops[idx].type === 'del') dels.push(ops[idx])
      else ins.push(ops[idx])
      idx += 1
    }
    const pairCount = Math.min(dels.length, ins.length)
    for (let k = 0; k < pairCount; k += 1) {
      const d = dels[k]
      const insOp = ins[k]
      if (!d.line.trim() && !insOp.line.trim()) continue
      const item = {
        id: `chg-${++seq}`,
        kind: 'edit',
        beforeStart: d.bi,
        beforeEnd: d.bi + 1,
        line: d.bi,
        afterLine: insOp.ai,
        source: d.line,
        text: insOp.line,
        section: nearestSection(a, d.bi) || nearestSection(b, insOp.ai),
      }
      item.reason = matchModelReason(item, modelChanges, usedModelIdx, locale)
      items.push(item)
    }
    // Leftover inserted lines after paired edits
    const insertAnchor = dels.length > 0 ? dels[dels.length - 1].bi + 1 : (ins[0]?.bi ?? prefix)
    for (let k = pairCount; k < ins.length; k += 1) {
      const insOp = ins[k]
      if (!insOp.line.trim()) continue
      // Attach any immediately preceding blank line inside the same hunk so formatting stays crisp
      const leadingBlank = k > pairCount && !ins[k - 1].line.trim()
      const item = {
        id: `chg-${++seq}`,
        kind: 'insert',
        beforeStart: insertAnchor,
        beforeEnd: insertAnchor,
        line: Math.max(0, insertAnchor - 1),
        afterLine: insOp.ai,
        source: '',
        text: insOp.line,
        leadingBlank,
        section: nearestSection(b, insOp.ai) || nearestSection(a, Math.max(0, insertAnchor - 1)),
      }
      item.reason = matchModelReason(item, modelChanges, usedModelIdx, locale)
      items.push(item)
    }
    // Leftover deleted lines after paired edits
    for (let k = pairCount; k < dels.length; k += 1) {
      const d = dels[k]
      if (!d.line.trim()) continue
      const item = {
        id: `chg-${++seq}`,
        kind: 'delete',
        beforeStart: d.bi,
        beforeEnd: d.bi + 1,
        line: d.bi,
        afterLine: ins.length > 0 ? ins[ins.length - 1].ai : d.ai,
        source: d.line,
        text: '',
        section: nearestSection(a, d.bi),
      }
      item.reason = matchModelReason(item, modelChanges, usedModelIdx, locale)
      items.push(item)
    }
  }
  return items
}

/**
 * Reconstructs Markdown by applying ONLY accepted review items onto beforeText.
 * Rejected items remain at their original lines; untouched lines stay byte-for-byte identical.
 */
export function applyReviewDecisions(beforeText, items = [], rejectedIds = new Set()) {
  const rejected = rejectedIds instanceof Set ? rejectedIds : new Set(Array.isArray(rejectedIds) ? rejectedIds : [])
  const { sep, lines } = splitLines(beforeText)
  if (!Array.isArray(items) || !items.length) return beforeText

  const accepted = items.filter(item => item && !rejected.has(item.id))
  if (!accepted.length) return beforeText

  // Index edits/deletes by beforeStart and insertions by anchor index (preserving item order)
  const replaceByLine = new Map()
  const deleteLines = new Set()
  const insertsBefore = new Map()

  for (const item of accepted) {
    if (item.kind === 'edit') {
      replaceByLine.set(item.beforeStart, item.text)
    } else if (item.kind === 'delete') {
      deleteLines.add(item.beforeStart)
    } else if (item.kind === 'insert') {
      const bucket = insertsBefore.get(item.beforeStart) ?? []
      if (item.leadingBlank) bucket.push('')
      bucket.push(item.text)
      insertsBefore.set(item.beforeStart, bucket)
    }
  }

  const out = []
  for (let i = 0; i <= lines.length; i += 1) {
    const added = insertsBefore.get(i)
    if (added) out.push(...added)
    if (i >= lines.length) break
    if (deleteLines.has(i)) continue
    if (replaceByLine.has(i)) out.push(replaceByLine.get(i))
    else out.push(lines[i])
  }
  return out.join(sep)
}

/**
 * Re-applies accepted review decisions onto a possibly manually-edited `currentText`,
 * preserving user edits while accurately placing unapproved preview items when previewing
 * or explicitly accepting a staged proposal.
 */
export function rebaseReviewDecisions(currentText, originalBaseText, items = [], rejectedIds = new Set()) {
  if (!Array.isArray(items) || !items.length) return currentText
  if (currentText === originalBaseText) return applyReviewDecisions(originalBaseText, items, rejectedIds)

  const rejected = rejectedIds instanceof Set ? rejectedIds : new Set(Array.isArray(rejectedIds) ? rejectedIds : [])
  const accepted = items.filter(item => item && !rejected.has(item.id))
  if (!accepted.length) return currentText

  const { sep, lines } = splitLines(currentText)
  const { lines: origLines } = splitLines(originalBaseText || '')
  const replaceByLine = new Map()
  const deleteLines = new Set()
  const insertsBefore = new Map()

  const findClosestLine = (target, hint) => {
    if (!target) return -1
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === target) {
        const dist = Math.abs(i - hint)
        if (dist < bestDist) { bestDist = dist; best = i }
      }
    }
    return best
  }

  const findSectionEnd = (sectionLabel) => {
    if (!sectionLabel) return -1
    for (let i = 0; i < lines.length; i += 1) {
      const m = SECTION_HEADING_RE.exec(lines[i].trim())
      if (m && m[1].trim() === sectionLabel) {
        let end = i + 1
        while (end < lines.length && !SECTION_HEADING_RE.test(lines[end].trim())) end += 1
        while (end > i + 1 && !lines[end - 1].trim()) end -= 1
        return end
      }
    }
    return -1
  }

  for (const item of accepted) {
    if (item.kind === 'edit') {
      const idx = findClosestLine(item.source, item.beforeStart)
      if (idx >= 0) replaceByLine.set(idx, item.text)
    } else if (item.kind === 'delete') {
      const idx = findClosestLine(item.source, item.beforeStart)
      if (idx >= 0) deleteLines.add(idx)
    } else if (item.kind === 'insert') {
      // Skip if user already manually typed the exact same line
      if (lines.includes(item.text)) continue
      let anchor = -1
      // Try to anchor right after the original preceding non-empty line
      for (let p = Math.min(origLines.length - 1, item.beforeStart - 1); p >= 0; p -= 1) {
        if (!origLines[p]?.trim()) continue
        const found = findClosestLine(origLines[p], p)
        if (found >= 0) { anchor = found + 1; break }
        break
      }
      if (anchor < 0 && item.section) {
        anchor = findSectionEnd(item.section)
      }
      if (anchor < 0) {
        anchor = Math.max(0, Math.min(lines.length, item.beforeStart))
      }
      const bucket = insertsBefore.get(anchor) ?? []
      if (item.leadingBlank) bucket.push('')
      bucket.push(item.text)
      insertsBefore.set(anchor, bucket)
    }
  }

  const out = []
  for (let i = 0; i <= lines.length; i += 1) {
    const added = insertsBefore.get(i)
    if (added) out.push(...added)
    if (i >= lines.length) break
    if (deleteLines.has(i)) continue
    if (replaceByLine.has(i)) out.push(replaceByLine.get(i))
    else out.push(lines[i])
  }
  return out.join(sep)
}

/**
 * Builds step-by-step ResumePlayback frames for any mix of edits, insertions, and deletions,
 * tracking exact shifted line indices so the animated cursor lands on the real modified line every time.
 */
export function buildUnifiedPlaybackSteps(beforeText, items = [], options = {}) {
  if (typeof beforeText !== 'string' || !Array.isArray(items) || !items.length) return []
  const defaultSource = typeof options?.source === 'string' ? options.source.trim() : ''
  const { sep, lines } = splitLines(beforeText)
  const working = [...lines]
  // Track how many lines have been inserted/deleted before each original line index
  let shift = 0
  const steps = []

  // Sort items in document order (beforeStart asc, then edit/delete before insert at same anchor)
  const ordered = [...items].sort((x, y) => {
    if (x.beforeStart !== y.beforeStart) return x.beforeStart - y.beforeStart
    const rank = k => (k === 'edit' ? 0 : k === 'delete' ? 1 : 2)
    return rank(x.kind) - rank(y.kind)
  })

  for (const item of ordered.slice(0, 14)) {
    const pos = Math.max(0, Math.min(working.length, item.beforeStart + shift))
    const stepSource = (typeof item.sourceLabel === 'string' && item.sourceLabel.trim()) || defaultSource
    if (item.kind === 'edit' && pos < working.length) {
      if (working[pos] === item.text) continue
      working[pos] = item.text
      steps.push({ kind: 'rewrite', line: pos, text: working.join(sep), reason: item.reason || '', ...(stepSource ? { source: stepSource } : {}) })
    } else if (item.kind === 'insert') {
      let insertAt = pos
      if (item.leadingBlank) {
        working.splice(insertAt, 0, '')
        insertAt += 1
        shift += 1
      }
      working.splice(insertAt, 0, item.text)
      shift += 1
      steps.push({ kind: 'insert', line: insertAt, text: working.join(sep), reason: item.reason || '', ...(stepSource ? { source: stepSource } : {}) })
    } else if (item.kind === 'delete' && pos < working.length) {
      working.splice(pos, 1)
      shift -= 1
      steps.push({
        kind: 'delete',
        line: Math.max(0, Math.min(pos, working.length - 1)),
        text: working.join(sep),
        reason: item.reason || '',
        ...(stepSource ? { source: stepSource } : {}),
      })
    }
  }
  return steps
}

/**
 * Suggests the best target resume section & insertion line for an unmerged background evidence item,
 * so the user sees the intended destination BEFORE applying and can stage a single-item review diff.
 */
export function suggestEvidencePlacement(resumeText, evidence, locale = 'zh') {
  const isEn = String(locale || '').toLowerCase().startsWith('en')
  const { sep, lines } = splitLines(resumeText || '')
  const headings = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    const m = SECTION_HEADING_RE.exec(trimmed)
    if (m) headings.push({ line: i, level: trimmed.startsWith('###') ? 3 : 2, label: m[1].trim() })
  }

  const evText = `${evidence?.title || ''} ${evidence?.text || ''} ${evidence?.impact || ''} ${evidence?.role || ''}`.trim()
  const evTokens = new Set(extractTokens(evText))
  const expRe = /(?:项目经历|项目经验|工作经历|工作经验|职业经历|experience|projects?|work history|achievements?|highlights?)/iu

  let targetHeading = null
  let bestScore = -1
  for (let hIdx = 0; hIdx < headings.length; hIdx += 1) {
    const h = headings[hIdx]
    const nextLine = headings[hIdx + 1]?.line ?? lines.length
    const blockText = lines.slice(h.line, nextLine).join('\n')
    let score = expRe.test(h.label) ? 4 : 0
    if (h.level === 3) score += 2
    for (const tok of extractTokens(blockText)) {
      if (evTokens.has(tok)) score += 3
    }
    if (score > bestScore) {
      bestScore = score
      targetHeading = { ...h, endLine: nextLine }
    }
  }

  // Build a crisp single-line bullet strictly from the evidence text + impact
  const rawBody = String(evidence?.text || evidence?.title || '').replace(/[\r\n]+/gu, ' ').trim()
  const rawImpact = String(evidence?.impact || '').replace(/[\r\n]+/gu, ' ').trim()
  const bulletBody = rawImpact && !rawBody.toLowerCase().includes(rawImpact.toLowerCase())
    ? `${rawBody.replace(/[。.]$/u, '')}${isEn ? ` — ${rawImpact}` : `；${rawImpact}`}`
    : rawBody
  const bulletLine = `- ${bulletBody}`

  if (!targetHeading) {
    const fallbackHeading = isEn ? 'Experience & Highlights' : '工作与项目成果'
    const appendText = `${String(resumeText || '').trimEnd()}${sep}${sep}## ${fallbackHeading}${sep}${bulletLine}`
    return {
      sectionLabel: fallbackHeading,
      insertAfterLine: Math.max(0, lines.length - 1),
      bulletLine,
      proposedText: appendText,
    }
  }

  // Insert right after the last non-empty line in the chosen heading block
  let insertIndex = targetHeading.endLine
  while (insertIndex > targetHeading.line + 1 && !lines[insertIndex - 1].trim()) {
    insertIndex -= 1
  }
  const nextLines = [...lines]
  nextLines.splice(insertIndex, 0, bulletLine)
  return {
    sectionLabel: targetHeading.label,
    insertAfterLine: insertIndex,
    bulletLine,
    proposedText: nextLines.join(sep),
  }
}

export function cleanBulletDisplay(line = '') {
  return stripBullet(line)
}

const GENERIC_EVIDENCE_HEADING_RE = /^##\s+(?:工作与项目成果|Experience & Highlights)\s*$/u

/**
 * Attaches per-item provenance (evidenceIds, sourceLabel, preserved reason) to diff items
 * produced by computeReviewableLineChanges when staging a new or stacked review proposal.
 * Preserves earlier items' provenance across sequential evidence previews so selecting
 * item A and rejecting item B persists only A's evidence binding.
 */
export function attachStagedReviewProvenance(rawItems = [], {
  changeProvenance = null,
  previousItems = [],
  fallbackEvidenceIds = [],
  sourceLabel = '',
  sourceKind = 'chat',
  newItemReason = '',
} = {}) {
  const provList = Array.isArray(changeProvenance) && changeProvenance.length ? changeProvenance : null
  const prevList = Array.isArray(previousItems) && previousItems.length ? previousItems : null
  const fallback = Array.isArray(fallbackEvidenceIds) ? [...new Set(fallbackEvidenceIds.filter(Boolean))] : []
  const nextSourceLabel = typeof sourceLabel === 'string' ? sourceLabel.trim() : ''
  const nextReason = typeof newItemReason === 'string' ? newItemReason.trim() : ''
  const isEvidence = sourceKind === 'evidence'
  const usedProvIdx = new Set()
  const usedPrevIdx = new Set()

  const findUnusedMatch = (list, used, row) => {
    if (!list) return -1
    let idx = list.findIndex((p, i) => !used.has(i) && p?.kind === row.kind && p?.text === row.text && p?.source === row.source)
    if (idx < 0) {
      idx = list.findIndex((p, i) => !used.has(i) && p?.kind !== 'delete' && p?.text === row.text)
    }
    return idx
  }

  return (Array.isArray(rawItems) ? rawItems : []).map(row => {
    if (row.kind === 'delete') return { ...row, evidenceIds: [] }
    if (provList) {
      const matchIdx = findUnusedMatch(provList, usedProvIdx, row)
      if (matchIdx >= 0) {
        usedProvIdx.add(matchIdx)
        const matched = provList[matchIdx]
        return {
          ...row,
          evidenceIds: Array.isArray(matched.evidenceIds) ? [...matched.evidenceIds] : [],
          ...(typeof matched.sourceLabel === 'string' && matched.sourceLabel.trim()
            ? { sourceLabel: matched.sourceLabel.trim() }
            : nextSourceLabel ? { sourceLabel: nextSourceLabel } : {}),
        }
      }
    }
    if (prevList) {
      const prevIdx = findUnusedMatch(prevList, usedPrevIdx, row)
      if (prevIdx >= 0) {
        usedPrevIdx.add(prevIdx)
        const prev = prevList[prevIdx]
        if (Array.isArray(prev.evidenceIds)) {
          return {
            ...row,
            evidenceIds: [...prev.evidenceIds],
            ...(prev.reason ? { reason: prev.reason } : {}),
            ...(typeof prev.sourceLabel === 'string' && prev.sourceLabel.trim() ? { sourceLabel: prev.sourceLabel.trim() } : {}),
          }
        }
      }
    }
    if (isEvidence && row.kind === 'insert' && GENERIC_EVIDENCE_HEADING_RE.test(String(row.text || '').trim())) {
      return {
        ...row,
        evidenceIds: [],
        ...(nextReason ? { reason: nextReason } : {}),
      }
    }
    return {
      ...row,
      evidenceIds: [...fallback],
      ...(nextReason ? { reason: nextReason } : {}),
      ...(nextSourceLabel ? { sourceLabel: nextSourceLabel } : {}),
    }
  })
}

export function resolveAcceptedReviewEvidenceIds(items = [], rejectedIds = [], fallbackEvidenceIds = []) {
  const rejected = rejectedIds instanceof Set ? rejectedIds : new Set(Array.isArray(rejectedIds) ? rejectedIds : [])
  const fallback = Array.isArray(fallbackEvidenceIds) ? fallbackEvidenceIds : []
  const accepted = (Array.isArray(items) ? items : []).filter(row => row && !rejected.has(row.id))
  if (!accepted.length) return []
  return [...new Set(accepted.flatMap(row => (Array.isArray(row.evidenceIds) ? row.evidenceIds : fallback)).filter(Boolean))]
}
