import { createHash, randomUUID } from 'node:crypto'
import { canonicalInterviewRoundKey, interviewGroupKey, projectOpportunityStage, validateReceipt } from './opportunities.mjs'
import { deletePersonalSchedule, writePersonalSchedule } from './personal-schedule.mjs'
import { normalizeLocale } from './i18n/index.mjs'

const MINUTE = 60_000
const SINGULAR_ONCE = new Set(['started', 'offer_accepted', 'offer_declined'])
const SINGULAR_LATEST = new Set(['application_submitted', 'application_acknowledged', 'rejected', 'withdrawn'])
const RECEIPT_STAGE_ORDER = [
  'opened', 'application_prepared', 'contact_sent', 'resume_sent', 'application_submitted',
  'application_acknowledged', 'interview_invited', 'interview_confirmed', 'interview_completed',
  'offer_received', 'offer_accepted', 'started',
]
const TERMINAL_RECEIPTS = new Set(['started', 'offer_declined', 'rejected', 'withdrawn'])

function receiptMeaningfulEqual(a, b) {
  return (a.material || '') === (b.material || '')
    && (a.materialId || '') === (b.materialId || '')
    && (a.materialVersion || '') === (b.materialVersion || '')
    && (a.materialKind || '') === (b.materialKind || '')
    && (a.notes || '') === (b.notes || '')
    && (a.evidence || '') === (b.evidence || '')
}

function isNaturallyEndedCalendarEvent(state, syncedItem) {
  if (!syncedItem || syncedItem.destination !== 'calendar' || syncedItem.kind !== 'interview' || !syncedItem.opportunityId) {
    return false
  }
  const jobReceipts = (state.receipts ?? [])
    .filter(r => r.opportunityId === syncedItem.opportunityId)
    .sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''))
  if (!jobReceipts.length) return false
  const targetKey = syncedItem.roundKey || interviewGroupKey(syncedItem)
  let latestInterview = null
  for (const r of jobReceipts) {
    if (r.type.startsWith('interview_') && interviewGroupKey(r) === targetKey) {
      latestInterview = r
    }
  }
  if (!latestInterview) return false
  const endMs = Date.parse(latestInterview.endsAt || syncedItem.endsAt || '')
  const startMs = Date.parse(latestInterview.startsAt || syncedItem.startsAt || '')
  if (!Number.isFinite(endMs) || endMs > Date.now()) return false
  // If cancelled/withdrawn/rejected BEFORE the interview even started, it is cancelled (not naturally completed history).
  const cancelledBeforeStart = jobReceipts.some(r =>
    (r.type === 'withdrawn' || r.type === 'rejected' || r.type === 'offer_declined')
    && Number.isFinite(startMs)
    && Date.parse(r.occurredAt) < startMs,
  )
  return !cancelledBeforeStart
}

/**
 * Projects upcoming calendar events and todo reminders from confirmed interviews
 * and open offer deadlines in the persisted control state.
 */
export function personalScheduleItems(state, locale = 'zh') {
  const isEn = normalizeLocale(locale, 'zh') === 'en'
  const targets = state.config.personalSchedule
  if (!targets || !Object.values(targets).some(Boolean)) return []
  const tasks = []
  const add = (destination, key, fields) => {
    const target = targets[destination]
    if (!target) return
    const id = createHash('sha256').update(JSON.stringify([destination, key])).digest('hex').slice(0, 32)
    tasks.push({ ...fields, destination, target, id })
  }
  const addTask = (key, fields) => {
    add('things', key, fields)
    add('reminders', key, fields)
  }
  const inactive = new Set(['started', 'offer_accepted', 'offer_declined', 'rejected', 'withdrawn'])
  for (const job of state.opportunities) {
    const receipts = state.receipts.filter(item => item.opportunityId === job.id)
    if (!receipts.length || inactive.has(projectOpportunityStage(receipts, job.id).stage)) continue
    receipts.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    const rounds = new Map()
    let offer
    for (const item of receipts) {
      if (item.type.startsWith('interview_')) {
        const roundKey = interviewGroupKey(item)
        const previous = rounds.get(roundKey)
        if (item.type === 'interview_invited' && previous?.type === 'interview_confirmed') continue
        rounds.set(roundKey, item)
      }
      if (item.type === 'offer_received') offer = item
    }
    const label = `${job.company} · ${job.title}`
    for (const [roundKey, item] of rounds) {
      if (item.type === 'interview_confirmed' && Date.parse(item.endsAt) > Date.now()) {
        add('calendar', [job.id, roundKey], {
          opportunityId: job.id, round: item.round, roundKey,
          ...(item.interviewId && { interviewId: item.interviewId }),
          kind: 'interview',
          title: `${job.company} · ${item.round}`.slice(0, 170),
          startsAt: item.startsAt, endsAt: item.endsAt, location: item.location,
        })
      } else if (item.type === 'interview_invited') {
        addTask([job.id, roundKey, 'reply'], {
          opportunityId: job.id, round: item.round, roundKey,
          ...(item.interviewId && { interviewId: item.interviewId }),
          kind: 'interview-reply',
          title: `${isEn ? 'Reply to interview invite' : '回复面试邀请'} · ${label}`.slice(0, 170),
        })
      }
    }
    if (offer?.replyBy) addTask([job.id, 'offer-reply'], {
      opportunityId: job.id, kind: 'offer-reply',
      title: `${isEn ? 'Respond to offer' : '答复 Offer'} · ${label}`.slice(0, 170), dueAt: offer.replyBy,
      timezone: state.config.timezone ?? 'Asia/Shanghai',
    })
  }
  return tasks
}

/**
 * Manages application receipts, amendments, rollbacks, and macOS Calendar/Reminders/Things synchronization.
 */
export function createHostReceipts(deps) {
  const {
    store,
    getControl,
    isClosed,
    getRevision,
    getScheduleRun,
    setScheduleRun,
    getNextSyncAt,
    setNextSyncAt,
    activeLocale,
    exclusive,
    commit,
    publish,
    picked,
    string,
  } = deps

  async function ensureApprovedMaterialIfKnown(record, locale = 'zh') {
    if (!record?.materialId || record.materialKind === 'external') return
    const core = await store.summary()
    const match = (core.resumes ?? []).find(row => row.id === record.materialId)
    if (match && match.status !== 'approved') {
      const isEn = normalizeLocale(locale || activeLocale(), 'zh') === 'en'
      throw new Error(isEn
        ? 'Please approve this resume version before recording it as submitted.'
        : '请先确认定稿该简历版本，再记录为已投递材料。')
    }
  }

  async function receipt(raw, locale) {
    const control = getControl()
    const isNewSession = raw?.isNewSession === true
    let record = validateReceipt({
      ...raw, id: raw?.id ?? randomUUID(), occurredAt: raw?.occurredAt ?? new Date().toISOString(),
    })
    picked(control, record.opportunityId)
    await ensureApprovedMaterialIfKnown(record, locale)
    const prior = control.receipts.find(row => row.id === record.id)
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('回执 ID 已有不同内容。')
    if (prior) return prior
    const existingForJob = control.receipts
      .filter(row => row.opportunityId === record.opportunityId)
      .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''))
    if ((record.type === 'interview_confirmed' || record.type === 'interview_invited') && !record.interviewId) {
      const canonKey = canonicalInterviewRoundKey(record.round)
      const sameDefaultBucket = control.receipts
        .filter(row => row.opportunityId === record.opportunityId
          && !row.interviewId
          && row.type.startsWith('interview_')
          && canonicalInterviewRoundKey(row.round) === canonKey)
        .sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''))
      const latestInBucket = sameDefaultBucket.at(-1)
      const refNow = Math.max(Date.now(), Date.parse(record.occurredAt) || 0)
      let needsIndependentId = isNewSession
      if (!needsIndependentId && latestInBucket) {
        if (record.type === 'interview_confirmed') {
          const prevEnded = latestInBucket.type === 'interview_confirmed'
            && Number.isFinite(Date.parse(latestInBucket.endsAt || ''))
            && Date.parse(latestInBucket.endsAt) <= refNow
          const syncedItem = Object.values(control.personalSync?.items ?? {}).find(si =>
            si?.opportunityId === record.opportunityId
            && si?.destination === 'calendar'
            && si?.roundKey === canonKey
            && !si?.interviewId)
          const syncedEnded = Boolean(syncedItem?.endsAt && Number.isFinite(Date.parse(syncedItem.endsAt)) && Date.parse(syncedItem.endsAt) <= refNow)
          if (latestInBucket.type === 'interview_completed' || prevEnded || syncedEnded) {
            needsIndependentId = true
          }
        } else if (record.type === 'interview_invited') {
          if (latestInBucket.type === 'interview_confirmed' || latestInBucket.type === 'interview_completed') {
            needsIndependentId = true
          }
        }
      }
      if (needsIndependentId) {
        record = validateReceipt({ ...record, interviewId: record.id })
      }
    }
    if (SINGULAR_ONCE.has(record.type)) {
      const dup = existingForJob.find(row => row.type === record.type)
      if (dup) return dup
    }
    if (SINGULAR_LATEST.has(record.type) && existingForJob[0]?.type === record.type) {
      const latest = existingForJob[0]
      // Idempotent guard: identical double-click returns the existing receipt without duplicating.
      if (receiptMeaningfulEqual(latest, record)) return latest
      // Explicit correction/amendment (e.g. changing submitted material v1 -> v2 or adding notes):
      // update the latest receipt in place while keeping traceable amendment history!
      const amendmentEntry = {
        ...(latest.material && { material: latest.material }),
        ...(latest.materialId && { materialId: latest.materialId }),
        ...(latest.materialVersion && { materialVersion: latest.materialVersion }),
        ...(latest.materialKind && { materialKind: latest.materialKind }),
        ...(latest.notes && { notes: latest.notes }),
        occurredAt: latest.amendedAt || latest.occurredAt,
      }
      const amended = validateReceipt({
        ...latest,
        ...(record.material !== undefined ? { material: record.material } : {}),
        materialId: record.materialId,
        materialVersion: record.materialVersion,
        materialKind: record.materialKind,
        ...(record.notes !== undefined ? { notes: record.notes } : {}),
        ...(record.evidence ? { evidence: record.evidence } : {}),
        amendedAt: record.occurredAt,
        amendments: [...(latest.amendments ?? []), amendmentEntry].slice(-20),
      })
      await commit(next => {
        next.receipts = next.receipts.map(row => row.id === latest.id ? amended : row)
      })
      publish('opportunity.receipt', { opportunityId: amended.opportunityId, receiptId: amended.id, amended: true })
      setNextSyncAt(0)
      return amended
    }
    await commit(next => { next.receipts.push(record) })
    publish('opportunity.receipt', { opportunityId: record.opportunityId, receiptId: record.id })
    setNextSyncAt(0)
    return record
  }

  async function updateReceipt(raw, locale) {
    const control = getControl()
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    const cleanId = string(raw?.id, 254, isEn ? 'receipt ID' : '进展记录 ID', false, loc)
    const existing = control.receipts.find(row => row.id === cleanId)
    if (!existing) throw new Error(isEn ? 'This progress record no longer exists.' : '这条进展记录不存在或已撤销。')
    const patch = {
      ...existing,
      ...(typeof raw?.material === 'string' && raw.material.trim() ? { material: raw.material.trim() } : {}),
      ...(Object.hasOwn(raw ?? {}, 'materialId') ? { materialId: raw.materialId || undefined } : {}),
      ...(Object.hasOwn(raw ?? {}, 'materialVersion') ? { materialVersion: raw.materialVersion || undefined } : {}),
      ...(Object.hasOwn(raw ?? {}, 'materialKind') ? { materialKind: raw.materialKind || undefined } : {}),
      ...(Object.hasOwn(raw ?? {}, 'notes') ? { notes: typeof raw.notes === 'string' ? raw.notes.trim() || undefined : undefined } : {}),
      ...(typeof raw?.evidence === 'string' && raw.evidence.trim() ? { evidence: raw.evidence.trim() } : {}),
    }
    const candidate = validateReceipt({
      ...patch,
      amendedAt: new Date().toISOString(),
      amendments: [
        ...(existing.amendments ?? []),
        {
          ...(existing.material && { material: existing.material }),
          ...(existing.materialId && { materialId: existing.materialId }),
          ...(existing.materialVersion && { materialVersion: existing.materialVersion }),
          ...(existing.materialKind && { materialKind: existing.materialKind }),
          ...(existing.notes && { notes: existing.notes }),
          occurredAt: existing.amendedAt || existing.occurredAt,
        },
      ].slice(-20),
    })
    await ensureApprovedMaterialIfKnown(candidate, loc)
    if (receiptMeaningfulEqual(existing, candidate)) return existing
    await commit(next => {
      next.receipts = next.receipts.map(row => row.id === existing.id ? candidate : row)
    })
    publish('opportunity.receipt', { opportunityId: candidate.opportunityId, receiptId: candidate.id, amended: true })
    setNextSyncAt(0)
    return candidate
  }

  async function pruneOrphanedPersonalSync(opportunityId = null) {
    const control = getControl()
    const existingItems = control.personalSync?.items ?? {}
    const entries = Object.entries(existingItems)
    if (!entries.length) return []
    const activeIds = new Set(personalScheduleItems(control).map(task => task.id))
    const toDelete = entries.filter(([id, item]) => {
      if (!item) return true
      if (opportunityId && item.opportunityId !== opportunityId && !id.startsWith(`${opportunityId}:`)) return false
      // Explicit retry of a previously failed deletion
      if (item.pendingDelete === true && !activeIds.has(id)) return true
      if (activeIds.has(id)) return false
      // Preserve naturally ended past Calendar interviews — never delete historical interviews!
      if (isNaturallyEndedCalendarEvent(control, item)) return false
      return true
    })
    if (!toDelete.length) return []
    const deletedIds = []
    const failedDeletes = new Map()
    for (const [id, synced] of toDelete) {
      const needsNativeDelete = Boolean((synced?.verified || synced?.pendingDelete) && synced?.destination && synced?.target)
      if (!needsNativeDelete) {
        deletedIds.push(id)
        continue
      }
      try {
        await deletePersonalSchedule({
          destination: synced.destination,
          id,
          target: synced.target,
          remoteId: synced.remoteId || '',
        })
        deletedIds.push(id)
      } catch (err) {
        failedDeletes.set(id, {
          ...synced,
          pendingDelete: true,
          verified: false,
          error: err?.message || '未能从系统日历/提醒移除该事项，可稍后重试。',
        })
      }
    }
    await commit(next => {
      if (!next.personalSync?.items) return
      for (const id of deletedIds) delete next.personalSync.items[id]
      for (const [id, failedRow] of failedDeletes) next.personalSync.items[id] = failedRow
      const firstFailed = Object.values(next.personalSync.items).find(row => row && (!row.verified || row.pendingDelete))
      next.personalSync.lastError = firstFailed ? (firstFailed.error || '部分日程同步或清理失败，可重试。') : null
    })
    return deletedIds
  }

  function markOrphanedSyncPendingDelete(next, opportunityId) {
    const existingItems = next.personalSync?.items
    if (!existingItems) return
    const activeIds = new Set(personalScheduleItems(next).map(task => task.id))
    for (const [id, synced] of Object.entries(existingItems)) {
      if (!synced) { delete existingItems[id]; continue }
      if (opportunityId && synced.opportunityId !== opportunityId && !id.startsWith(`${opportunityId}:`)) continue
      if (activeIds.has(id)) continue
      if (isNaturallyEndedCalendarEvent(next, synced)) continue
      const needsNativeDelete = Boolean((synced.verified || synced.pendingDelete) && synced.destination && synced.target)
      if (!needsNativeDelete) {
        delete existingItems[id]
      } else {
        existingItems[id] = { ...synced, pendingDelete: true }
      }
    }
  }

  async function removeReceipt(id) {
    const control = getControl()
    const cleanId = string(id, 254, '进展记录 ID')
    const found = control.receipts.find(row => row.id === cleanId)
    if (!found) throw new Error('这条进展记录不存在或已撤销。')
    await commit(next => {
      next.receipts = next.receipts.filter(row => row.id !== cleanId)
      markOrphanedSyncPendingDelete(next, found.opportunityId)
    })
    publish('opportunity.receipt', { opportunityId: found.opportunityId, receiptId: cleanId, removed: true })
    setNextSyncAt(0)
    void pruneOrphanedPersonalSync(found.opportunityId).catch(() => {})
    return { removed: true, id: cleanId, opportunityId: found.opportunityId }
  }

  async function resetReceipts(opportunityId, { action: mode = 'clear_all', targetType = '' } = {}) {
    let control = getControl()
    picked(control, opportunityId)
    const cleanMode = ['undo_last', 'remove_type', 'clear_all', 'rollback_to'].includes(mode) ? mode : 'clear_all'
    const jobReceipts = control.receipts
      .filter(row => row.opportunityId === opportunityId)
      .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''))
    const removeIds = new Set()
    if (cleanMode === 'clear_all' || (cleanMode === 'rollback_to' && targetType === 'discovered')) {
      for (const row of jobReceipts) removeIds.add(row.id)
    } else if (cleanMode === 'undo_last') {
      if (jobReceipts[0]) removeIds.add(jobReceipts[0].id)
    } else if (cleanMode === 'remove_type' && targetType) {
      for (const row of jobReceipts) if (row.type === targetType) removeIds.add(row.id)
    } else if (cleanMode === 'rollback_to' && targetType) {
      const targetIdx = RECEIPT_STAGE_ORDER.indexOf(targetType)
      for (const row of jobReceipts) {
        if (TERMINAL_RECEIPTS.has(row.type) && row.type !== targetType) {
          removeIds.add(row.id)
          continue
        }
        const rowIdx = RECEIPT_STAGE_ORDER.indexOf(row.type)
        if (targetIdx >= 0 && rowIdx > targetIdx) removeIds.add(row.id)
      }
    }
    if (removeIds.size > 0 || cleanMode === 'clear_all') {
      await commit(next => {
        if (removeIds.size > 0) next.receipts = next.receipts.filter(row => !removeIds.has(row.id))
        if (cleanMode === 'clear_all') {
          next.intakes = (next.intakes ?? []).filter(entry => entry.opportunityId !== opportunityId && entry.data?.opportunityId !== opportunityId)
        }
        markOrphanedSyncPendingDelete(next, opportunityId)
      })
      publish('opportunity.receipt', { opportunityId, removedCount: removeIds.size, removed: true })
      setNextSyncAt(0)
      void pruneOrphanedPersonalSync(opportunityId).catch(() => {})
      control = getControl()
    }
    const nextStage = projectOpportunityStage(control.receipts, opportunityId).stage
    return { opportunityId, removedCount: removeIds.size, stage: nextStage }
  }

  async function restoreReceipts(opportunityId, rawReceipts = []) {
    let control = getControl()
    picked(control, opportunityId)
    const incoming = Array.isArray(rawReceipts) ? rawReceipts.slice(0, 120) : []
    const valid = []
    const existingIds = new Set(control.receipts.map(row => row.id))
    for (const item of incoming) {
      if (!item || typeof item !== 'object') continue
      const candidate = validateReceipt({ ...item, opportunityId })
      if (!existingIds.has(candidate.id)) {
        existingIds.add(candidate.id)
        valid.push(candidate)
      }
    }
    if (valid.length > 0) {
      await commit(next => { next.receipts.push(...valid) })
      publish('opportunity.receipt', { opportunityId, restoredCount: valid.length })
      setNextSyncAt(0)
      control = getControl()
    }
    return { opportunityId, restoredCount: valid.length, stage: projectOpportunityStage(control.receipts, opportunityId).stage }
  }

  async function synchronize(force = false, locale) {
    if (isClosed() || getScheduleRun() || (!force && getNextSyncAt() > Date.now())) return
    const loc = normalizeLocale(locale || activeLocale(), 'zh')
    const isEn = loc === 'en'
    await pruneOrphanedPersonalSync(null)
    const control = getControl()
    const tasks = personalScheduleItems(control, loc).flatMap(task => {
      // Exclude localized `title` and `round` display string from change detection so switching UI language
      // or switching between bilingual round names ("一面" / "Round 1") never mutates or breaks bindings.
      const { title: _localizedTitle, round: _localizedRound, ...semanticTask } = task
      const semanticHash = createHash('sha256').update(JSON.stringify(semanticTask)).digest('hex')
      const legacyHash = createHash('sha256').update(JSON.stringify(task)).digest('hex')
      const previous = control.personalSync?.items?.[task.id]
      if (previous?.verified && (previous.semanticHash === semanticHash || previous.hash === legacyHash || previous.hash === semanticHash)) {
        return []
      }
      return [{ task, hash: semanticHash, semanticHash, previous }]
    })
    if (tasks.length === 0) return
    const atRevision = getRevision()
    const work = async () => {
      const results = []
      for (const { task, hash, semanticHash, previous } of tasks.slice(0, 20)) {
        if (isClosed() || atRevision !== getRevision()) break
        const meta = {
          opportunityId: task.opportunityId,
          round: task.round,
          roundKey: task.roundKey,
          ...(task.interviewId && { interviewId: task.interviewId }),
          kind: task.kind,
          title: task.title,
          target: task.target,
          ...(task.startsAt && { startsAt: task.startsAt }),
          ...(task.endsAt && { endsAt: task.endsAt }),
          syncedAt: new Date().toISOString(),
        }
        const sameTarget = Boolean(previous && previous.target === task.target)
        try {
          const applied = await writePersonalSchedule({
            ...task,
            remoteId: sameTarget ? previous?.remoteId : undefined,
          }, { locale: loc })
          // If the user switched to a different target calendar/list, clean up the old future copy best-effort.
          if (previous?.verified && !sameTarget && previous.target && (!previous.endsAt || Date.parse(previous.endsAt) > Date.now())) {
            await deletePersonalSchedule({
              destination: previous.destination || task.destination,
              id: task.id,
              target: previous.target,
              remoteId: previous.remoteId || '',
            }).catch(() => {})
          }
          results.push({ ...meta, ...applied, hash, semanticHash, error: null })
        } catch (err) {
          results.push({ ...meta, id: task.id, destination: task.destination, hash, semanticHash, verified: false, error: err?.message || (isEn ? 'Could not confirm sync.' : '未能确认同步。') })
        }
      }
      if (isClosed() || atRevision !== getRevision() || !results.length) return
      await exclusive(() => commit(next => {
        next.personalSync ??= { items: {} }
        next.personalSync.lastRun = new Date().toISOString()
        for (const result of results) next.personalSync.items[result.id] = result
        const failed = Object.values(next.personalSync.items).find(item => item && (!item.verified || item.pendingDelete))
        next.personalSync.lastError = failed
          ? (failed.error || (isEn ? 'Some items could not be synced. Check macOS Automation permissions and target apps, then retry.' : '有事项未确认同步。检查 macOS 的自动化权限和个人目标后可重试。')) : null
      }))
      for (const result of results) if (result.verified) publish('schedule.synced', {
        scheduleId: result.id, destination: result.destination,
      })
    }
    setNextSyncAt(Date.now() + 10 * MINUTE)
    const runPromise = work()
    setScheduleRun(runPromise)
    try { await runPromise } finally { setScheduleRun(null) }
  }

  return {
    receipt,
    updateReceipt,
    pruneOrphanedPersonalSync,
    markOrphanedSyncPendingDelete,
    removeReceipt,
    resetReceipts,
    restoreReceipts,
    synchronize,
  }
}
