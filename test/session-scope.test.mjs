import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply } from '../src/host.mjs'

const old = Date.now() - 70 * 86_400_000

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'niuma-scope-'))
  const workspace = { id: 'work-a', title: '工程', path: '/same-cwd', sessionIds: ['existing'] }
  const registry = { get: id => id === workspace.id ? workspace : undefined, list: () => [workspace] }
  const snapshots = new Map()
  const reads = []
  const handlers = new Map()
  let route, dispose
  const ctx = {
    profileContext: { dir: directory },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection() { return false } },
    sessionQuery: {
      listSessions: async () => [...snapshots.values()].map(({ session }) => ({ header: session })),
      readSession: async id => {
        reads.push(id)
        if (!snapshots.has(id)) throw new Error('Session is missing')
        return snapshots.get(id)
      },
    },
    llm: {
      listProviders: () => [{ id: 'test' }],
      async *stream(options) {
        const rows = JSON.parse(options.messages[0].content[0].text)
        const records = rows.slice(0, 8).map(({ key, text }) =>
          ({ key, quote: text, title: '版本验收', text }))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ records }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get: id => id === 'workspaceRegistry' ? registry : undefined,
    on: (name, fn) => handlers.set(name, fn),
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => {
    await dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const add = (id, text, time = Date.now(), origin) => {
    const session = { id, cwd: workspace.path, origin }
    snapshots.set(id, { session, events: !text ? [] : [
      { type: 'user/message', seq: 0, time, data: { source: { kind: 'user' },
        content: [{ type: 'text', text }] } },
      { type: 'turn/end', seq: 1, time },
    ] })
    return session
  }
  const request = async (url, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { method: body ? 'POST' : 'GET', url, headers: {
      'x-career-agent': '1', 'content-type': 'application/json',
    } })
    let status, data
    await route.handler(req, {
      writeHead(code) { status = code; return this },
      end(value) { if (value) data = JSON.parse(value) },
    })
    return { status, data }
  }
  const action = body => request('/career-agent/action', body)
  const state = async () => (await request('/career-agent/state')).data
  const turnEnded = session => handlers.get('session/event')(session, { type: 'turn/end', seq: 1 })
  return { workspace, reads, add, action, request, state, turnEnded }
}

test('workspace grants use registered membership now and when subsequent conversations are attached', async t => {
  const { workspace, reads, add, action, request, state, turnEnded } = await fixture(t)
  add('existing', '我独立验收了旧版本交付。', old)
  const outside = add('same-cwd-but-not-a-member', '我独立验收了其他项目交付。')
  add('child', '这是代理子会话中的测试内容。', Date.now(), 'subagent')
  workspace.sessionIds.push('child')
  assert.deepEqual((await request('/career-agent/workspaces')).data,
    [{ id: 'work-a', title: '工程', path: '/same-cwd', sessionCount: 2 }])
  assert.equal((await action({ action: 'session-scope', projects: ['workspace:unknown'] })).status, 400)
  assert.equal((await action({ action: 'session-scope', projects: ['workspace:work-a'],
    mode: 'observe', model: 'test:mock', sendToModel: true })).status, 200)
  await action({ action: 'run' })
  assert.deepEqual(reads, ['existing'])
  const initial = await state()
  assert.equal(initial.config.historyDays, null)
  assert.deepEqual(initial.config.sources[0].projects, ['workspace:work-a'])
  const [origin] = initial.evidence
  assert.ok(origin)
  assert.equal(origin.projectId, 'existing')
  turnEnded(outside)
  assert.equal((await state()).watch.queued, false)
  const future = add('newly-created', '我这周完成了新的版本验收。')
  workspace.sessionIds.push('newly-created')
  turnEnded(future)
  assert.equal((await state()).watch.queued, true)
  await action({ action: 'run' })
  const updated = await state()
  assert.deepEqual(updated.evidence.map(item => item.projectId), ['existing', 'newly-created'])
  const approved = await action({ action: 'review', id: origin.id, decision: 'approve', shareable: true })
  assert.equal(approved.status, 200)
  const [version] = (await state()).resumes
  assert.equal(approved.data.result.resumeId, version.id)
  assert.equal((await action({ action: 'resume-generate' })).data.result.id, version.id)
  assert.equal((await action({ action: 'resume-review', id: version.id, decision: 'approve' })).status, 200)
  assert.equal((await action({ action: 'evidence-source', id: origin.id })).status, 200)
  workspace.sessionIds = workspace.sessionIds.filter(id => id !== 'existing')
  assert.equal((await action({ action: 'evidence-source', id: origin.id })).status, 400)
  assert.equal((await action({ action: 'export', id: version.id })).status, 400)
  assert.equal((await action({ action: 'session-scope', projects: ['*'] })).status, 200)
  await action({ action: 'run' })
  assert.deepEqual((await state()).evidence.map(item => item.projectId), ['existing', 'newly-created', outside.id])
  assert.equal((await action({ action: 'export', id: version.id })).status, 200)
})

test('all conversations continue past the first forty while an old explicit grant stays scoped', async t => {
  const { reads, add, action, state, turnEnded } = await fixture(t)
  add('existing', '我认为现在的版本已通过验收。')
  for (let index = 0; index < 43; index += 1) add(`archive-${index}`)
  await action({ action: 'configure', config: { sources: [{ id: 'dsh-session', projects: ['existing'] }],
    mode: 'observe', model: 'test:mock', sendToModel: true } })
  await action({ action: 'run' })
  assert.deepEqual(reads, ['existing'])
  await action({ action: 'session-scope', projects: ['*'] })
  await action({ action: 'run' })
  assert.equal(reads.length, 41)
  assert.ok(Date.parse((await state()).watch.nextRun) < Date.now() + 2 * 60_000)
  await action({ action: 'run' })
  assert.ok(reads.includes('archive-42'))
  assert.equal((await state()).evidence.length, 1)
  turnEnded(add('archive-42', '补录历史会话中的新验收结果。'))
  const before = reads.length
  await action({ action: 'run' })
  assert.equal(reads[before], 'archive-42')
  assert.equal((await state()).evidence.length, 2)
})
