import { createHash } from 'node:crypto'

export const RECORDING_PREFIX = 'recording:'
export const RECORDING_PROJECT = 'recording'
const kinds = new Set(['work', 'interview'])
const maxNotices = 40
const maxSegments = 400
const maxTranscript = 24_000

function normalizedText(value, limit, label, optional = false) {
  if (optional && (value === undefined || value === '')) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error(`${label}格式无效。`)
  }
  return value.trim()
}

export function normalizeRecordingSource(input) {
  if (typeof input?.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,62}$/u.test(input.id)) {
    throw new Error('录音插件需要稳定的来源 ID。')
  }
  const name = normalizedText(input.name, 100, '录音插件名称')
  if (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.some(kind => !kinds.has(kind))) {
    throw new Error('录音插件需要声明可交付的转写类型。')
  }
  if (typeof input.readTranscript !== 'function' || (input.listRecordings !== undefined && typeof input.listRecordings !== 'function')) {
    throw new Error('录音插件需要实现按 ID 读取转写。')
  }
  return { id: input.id, name, work: input.kinds.includes('work'), interview: input.kinds.includes('interview'),
    readTranscript: input.readTranscript.bind(input), listRecordings: input.listRecordings?.bind(input) }
}

export function normalizeRecordingNotice(source, input) {
  if (!kinds.has(input?.kind) || !source[input.kind]) throw new Error('录音来源不支持此转写类型。')
  const recordingId = normalizedText(input.recordingId, 180, '录音编号')
  const time = input.occurredAt
  if (typeof time !== 'string' || !/T.*(?:Z|[+\-]\d{2}:\d{2})$/iu.test(time) || !Number.isFinite(Date.parse(time))) {
    throw new Error('录音时间需要包含时区。')
  }
  const id = createHash('sha256').update(JSON.stringify([source.id, recordingId])).digest('hex')
  const link = input.kind === 'interview' ? {
    opportunityId: normalizedText(input.opportunityId, 255, '岗位关联', true),
    round: normalizedText(input.round, 100, '面试轮次', true),
  } : {}
  return { id, sourceId: source.id, recordingId, kind: input.kind, occurredAt: new Date(time).toISOString(),
    title: input.kind === 'interview' ? normalizedText(input.title, 180, '面试标题', true) : undefined, ...link }
}

export function normalizeRecordingList(source, input) {
  if (!Array.isArray(input) || input.length > maxNotices) throw new Error('录音插件每次最多返回 40 个转写索引。')
  return input.map(notice => normalizeRecordingNotice(source, notice))
}

export function normalizeTranscript(input) {
  if (!Array.isArray(input?.segments) || !input.segments.length || input.segments.length > maxSegments) {
    throw new Error('转写需要一组带发言人归属的文本片段。')
  }
  const segments = input.segments.map(segment => {
    if (!['candidate', 'other', 'unknown'].includes(segment?.speaker)) throw new Error('转写片段的发言人归属无效。')
    return { speaker: segment.speaker, text: normalizedText(segment.text, maxTranscript, '转写片段') }
  })
  if (segments.reduce((total, row) => total + row.text.length + 16, 0) > maxTranscript) {
    throw new Error('转写资料过长。录音插件可按谈话片段拆分后再交付。')
  }
  return segments
}

export function workRecordingInputs(recording, source, segments) {
  const sourceId = RECORDING_PREFIX + recording.sourceId
  return segments.filter(row => row.speaker === 'candidate').flatMap(({ text }) => text.match(/[\s\S]{1,2400}/gu) ?? [])
    .map((body, index) => ({
      key: `${recording.id}:${index}`, sourceId, projectId: RECORDING_PROJECT, occurredAt: recording.occurredAt, body,
      sourceRef: `${source.name} · ${recording.recordingId}`,
    }))
}

export function interviewTranscript(segments) {
  const labels = { candidate: '候选人', other: '对方', unknown: '发言人未确认' }
  return segments.map(({ speaker, text }) => `${labels[speaker]}：${text}`).join('\n')
}
