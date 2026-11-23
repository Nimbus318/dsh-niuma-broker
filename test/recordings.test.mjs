import assert from 'node:assert/strict'
import test from 'node:test'
import {
  interviewTranscript, normalizeRecordingNotice, normalizeRecordingSource, normalizeTranscript, workRecordingInputs,
} from '../src/recordings.mjs'

const makeSource = (id = 'recording-fixture') => normalizeRecordingSource({
  id, name: '示例插件', kinds: ['work', 'interview'], readTranscript() {},
})
const meta = { recordingId: 'local-meeting', kind: 'work', occurredAt: '2026-11-19T19:30:00+08:00' }

test('recording queue keys are stable by connector and keep only normalized metadata', () => {
  const source = makeSource()
  const recording = normalizeRecordingNotice(source, { ...meta, fullTranscript: 'private text' })
  assert.equal(recording.id, normalizeRecordingNotice(source, meta).id)
  assert.notEqual(recording.id, normalizeRecordingNotice(makeSource('other-fixture'), meta).id)
  assert.equal(recording.occurredAt, '2026-11-19T11:30:00.000Z')
  assert.ok(!Object.hasOwn(recording, 'fullTranscript'))
  assert.throws(() => normalizeRecordingNotice(source, { ...meta, occurredAt: '2026-11-19T19:30:00' }), /时区/)
})

test('work extraction passes only candidate speech while confirmed interview retains attribution', () => {
  const source = makeSource()
  const reading = normalizeTranscript({ segments: [
    { speaker: 'candidate', text: '我的处理是核对实际交付结果。' },
    { speaker: 'other', text: '一位同事作出的其他说明。' },
    { speaker: 'unknown', text: '未核实发言人。' },
  ] })
  const recording = normalizeRecordingNotice(source, meta)
  const inputs = workRecordingInputs(recording, source, reading)
  assert.deepEqual(inputs.map(row => row.body), ['我的处理是核对实际交付结果。'])
  assert.equal(inputs[0].key, recording.id + ':0')
  assert.equal(inputs[0].sourceId, 'recording:recording-fixture')
  assert.match(interviewTranscript(reading), /发言人未确认：未核实发言人/)
  assert.throws(() => normalizeTranscript({ segments: [{ speaker: 'surprise', text: '未识别' }] }), /归属/)
})
