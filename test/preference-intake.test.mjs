import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proposeIntake } from '../src/intake.mjs'
import { preferencePatch } from '../src/preference-intake.mjs'

const config = { model: 'fixture:local', sendToModel: true }
function propose(text, result, context = {}) {
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return proposeIntake({ config, llm, text, context })
}

test('grounds settings values in the user’s words and strips changes to authority or external apps', async () => {
  const data = { intervalMinutes: 120, notificationsEnabled: true, notificationHour: 20, notificationEndHour: 23,
    allowReflections: false, timezone: 'Asia/Shanghai' }
  const proposal = await propose(
    '每两个小时检查一次，开启提醒，提醒时段设为晚上八点到十一点，关闭职业观察。时区改为 Asia/Shanghai。',
    { kind: 'preferences', data: { ...data, mode: 'search', sendToModel: true, model: 'other:provider',
      sources: [{ id: 'dsh-session', projects: ['*'] }], personalSchedule: { calendar: 'work' } } },
  )
  assert.equal(proposal.kind, 'preferences')
  assert.deepEqual(proposal.data, data)
  assert.deepEqual(preferencePatch({ ...data, mode: 'search' }), data)
})

test('asks before applying unsupported, ambiguous or mismatched timing', async () => {
  for (const [text, data] of [
    ['每天检查两次', { intervalMinutes: 1440 }],
    ['每两小时检查一次', { intervalMinutes: 60 }],
    ['提醒改为八点到十一点', { notificationHour: 20, notificationEndHour: 23 }],
    ['提醒改为晚上九点半到十一点', { notificationHour: 21, notificationEndHour: 23 }],
    ['明天联系招聘方', { notificationsEnabled: true }],
    ['使用美国时间', { timezone: 'America/New_York' }],
  ]) {
    const result = await propose(text, { kind: 'preferences', data })
    assert.equal(result.kind, 'clarify', text)
    assert.ok(result.question)
  }
})

test('uses a short clarification reply and retains the confirmed part of a proposal', async () => {
  const pending = await propose(
    '每半小时检查，提醒改到更晚',
    { kind: 'preferences', data: { intervalMinutes: 30, notificationHour: 21, notificationEndHour: 23 } },
  )
  assert.equal(pending.kind, 'clarify')
  assert.equal(pending.data.intervalMinutes, 30)
  const revised = await propose('晚上九点到午夜，21:00 到 24:00', {
    kind: 'preferences', data: { notificationHour: 21, notificationEndHour: 0 },
  }, { prior: pending, timezone: 'Asia/Shanghai' })
  assert.deepEqual(revised.data, { intervalMinutes: 30, notificationHour: 21, notificationEndHour: 0 })
  assert.equal(revised.kind, 'preferences')
})

test('understands natural Chinese patrol cadence phrases like 一天一次, 一天两次, 半天一次, 改成6小时', async () => {
  for (const [text, expectedMinutes] of [
    ['希望定时巡检改成一天一次', 1440],
    ['把巡检频率改成每天一次', 1440],
    ['定时巡检改成一天两次', 720],
    ['盯盘半天拉取一次', 720],
    ['把巡检间隔改成 6 小时', 360],
    ['每周巡检一次就行', 10080],
    ['30 分钟拉取一次', 30],
  ]) {
    const result = await propose(text, { kind: 'preferences', data: { intervalMinutes: expectedMinutes } })
    assert.equal(result.kind, 'preferences', `Expected preferences for "${text}", got ${result.kind}: ${result.question || ''}`)
    assert.equal(result.data.intervalMinutes, expectedMinutes, text)
  }
})
