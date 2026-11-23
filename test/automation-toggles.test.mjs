import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'
import { translate } from '../src/i18n/index.mjs'
import {
  buildAutoIntelTogglePatch,
  buildBoardsTogglePatch,
  buildScopeSavePatch,
  buildSessionsTogglePatch,
  formatBoardScanToast,
} from '../src/automation-toggles.mjs'

test('board patrol, sessions, and auto-intel toggle patches keep sendToModel and mode consistent across all surfaces', () => {
  const idleState = {
    mode: 'off',
    config: {
      mode: 'off',
      sendToModel: false,
      watchSessions: false,
      autoJobIntel: false,
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme' }],
      sources: [],
    },
  }

  // Enabling board patrol (from Jobs card or Settings drawer) sets mode='search' + sendToModel=true
  assert.deepEqual(buildBoardsTogglePatch(idleState, true), {
    mode: 'search',
    watchSessions: false,
    sendToModel: true,
  })

  // Disabling board patrol when nothing else is active resets mode='off' AND sendToModel=false
  const patrolOnly = {
    mode: 'search',
    config: { ...idleState.config, mode: 'search', sendToModel: true },
  }
  assert.deepEqual(buildBoardsTogglePatch(patrolOnly, false), {
    mode: 'off',
    watchSessions: false,
    sendToModel: false,
  })

  // Disabling board patrol when autoJobIntel is ON preserves mode='observe' (must not kill autoJobIntel)
  const patrolAndAutoIntel = {
    mode: 'search',
    config: { ...idleState.config, mode: 'search', sendToModel: true, autoJobIntel: true },
  }
  assert.deepEqual(buildBoardsTogglePatch(patrolAndAutoIntel, false), {
    mode: 'observe',
    watchSessions: false,
  })

  // Disabling autoJobIntel when nothing else is active resets mode='off' AND sendToModel=false
  const autoIntelOnly = {
    mode: 'observe',
    config: { ...idleState.config, mode: 'observe', sendToModel: true, autoJobIntel: true },
  }
  assert.deepEqual(buildAutoIntelTogglePatch(autoIntelOnly, false), {
    autoJobIntel: false,
    mode: 'off',
    sendToModel: false,
  })

  // Disabling autoJobIntel while board patrol is ON keeps mode='search' intact
  assert.deepEqual(buildAutoIntelTogglePatch(patrolAndAutoIntel, false), {
    autoJobIntel: false,
  })

  // Disabling sessions when nothing else is active resets mode='off' AND sendToModel=false
  const sessionsOnly = {
    mode: 'observe',
    config: {
      ...idleState.config,
      mode: 'observe',
      sendToModel: true,
      watchSessions: true,
      sources: [{ id: 'dsh-session', projects: ['workspace:/tmp/work'] }],
    },
  }
  assert.deepEqual(buildSessionsTogglePatch(sessionsOnly, false), {
    watchSessions: false,
    mode: 'off',
    sendToModel: false,
  })

  // Clearing workspace scope while autoJobIntel is ON preserves observe mode
  const scopeWithAutoIntel = {
    mode: 'observe',
    config: { ...sessionsOnly.config, autoJobIntel: true },
  }
  assert.deepEqual(buildScopeSavePatch(scopeWithAutoIntel, { projects: [], hasSource: false }), {
    projects: [],
    watchSessions: false,
    mode: 'observe',
  })
  // Clearing workspace scope when nothing else is active resets mode='off' AND sendToModel=false
  assert.deepEqual(buildScopeSavePatch(sessionsOnly, { projects: [], hasSource: false }), {
    projects: [],
    watchSessions: false,
    mode: 'off',
    sendToModel: false,
  })
})

test('formatBoardScanToast produces clear zh and en scan summaries for all insight states', () => {
  const tZh = (key, params) => translate('zh', key, params)
  const tEn = (key, params) => translate('en', key, params)

  assert.equal(formatBoardScanToast({ newJobsCount: 12, insightStatus: 'updating' }, tZh), '新增 12 个岗位，正在更新 AI 洞察')
  assert.equal(formatBoardScanToast({ newJobsCount: 0, insightStatus: 'updating' }, tZh), '岗位已更新，正在更新 AI 洞察')
  assert.equal(formatBoardScanToast({ newJobsCount: 3, insightStatus: 'reused' }, tZh), '新增 3 个岗位，沿用上次洞察')
  assert.equal(formatBoardScanToast({ newJobsCount: 0, insightStatus: 'reused' }, tZh), '岗位已更新，沿用上次洞察')
  assert.equal(formatBoardScanToast({ newJobsCount: 5, insightStatus: 'disabled' }, tZh), '新增 5 个岗位（仅拉取，未调用模型）')
  assert.equal(formatBoardScanToast({ newJobsCount: 0, insightStatus: 'disabled' }, tZh), '岗位已更新（仅拉取，未调用模型）')
  assert.equal(formatBoardScanToast({ newJobsCount: 2, insightStatus: 'skipped' }, tZh), '新增 2 个岗位')
  assert.equal(formatBoardScanToast({ newJobsCount: 0, insightStatus: 'skipped' }, tZh), '已完成官网招聘板拉取')

  assert.equal(formatBoardScanToast({ newJobsCount: 12, insightStatus: 'updating' }, tEn), '12 new roles, updating AI insights')
  assert.equal(formatBoardScanToast({ newJobsCount: 0, insightStatus: 'reused' }, tEn), 'Roles refreshed, keeping recent insights')
  assert.equal(formatBoardScanToast({ newJobsCount: 4, insightStatus: 'disabled' }, tEn), '4 new roles (fetch only, no AI used)')
})

test('host run(scope:boards) reports accurate newJobsCount and insightStatus across disabled, updating, and reused runs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-patrol-status-'))
  const origFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (!String(url).includes('boards-api.greenhouse.io/v1/boards/acme-status/jobs')) {
      throw new Error(`Unexpected fetch: ${url}`)
    }
    return Response.json({
      jobs: Array.from({ length: 4 }, (_, i) => ({
        id: 8000 + i,
        title: `Staff Go Infra Engineer ${i}`,
        location: { name: 'Remote' },
        absolute_url: `https://job-boards.greenhouse.io/acme-status/jobs/${8000 + i}`,
        updated_at: new Date().toISOString(),
        content: '<p>Build resilient distributed control planes in Go, Kubernetes, and GPU inference.</p>',
      })),
    })
  }
  t.after(() => { globalThis.fetch = origFetch })

  let marketCalls = 0
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('no session') },
    },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      resolveModelInfo: async () => ({ provider: 'mock', id: 'fast', name: 'Fast' }),
      prepareCall: async () => ({
        stream: async function* (request) {
          const raw = JSON.stringify(request)
          const isMarket = raw.includes('recentWorkEvidence')
          if (isMarket) marketCalls += 1
          const text = isMarket
            ? JSON.stringify({ headline: 'synth market', hotTrends: [{ title: 'go infra', heat: 'surging', signal: 'K8s' }], personalAlignment: { verdict: 'ok' } })
            : JSON.stringify({ items: [] })
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }

  await apply(ctx)
  t.after(async () => {
    await dispose?.()
    await rm(dir, { recursive: true, force: true })
  })

  const req = (url, body, method = 'POST') => harness.call(method, url, body)
  const act = body => req('/api/career-agent/action', body)

  await act({
    action: 'configure',
    config: {
      mode: 'off',
      sendToModel: false,
      watchSessions: false,
      autoJobIntel: false,
      model: 'mock:fast',
      boards: [{ provider: 'greenhouse', slug: 'acme-status', company: 'Acme Status' }],
    },
  })

  // 1. Pull while mode=off & sendToModel=false -> pure fetch, 4 new roles, insightStatus='disabled', 0 model calls
  const pull1 = await act({ action: 'run', scope: 'boards' })
  assert.equal(pull1.status, 200)
  assert.equal(pull1.data.result.newJobsCount, 4)
  assert.equal(pull1.data.result.insightStatus, 'disabled')
  await new Promise(r => setTimeout(r, 80))
  assert.equal(marketCalls, 0)

  // 2. Enable patrol using unified helper (same patch for Jobs card & Settings) -> pull triggers initial AI insight
  const st1 = (await req('/api/career-agent/state', null, 'GET')).data
  await act({ action: 'configure', config: buildBoardsTogglePatch(st1, true) })

  const pull2 = await act({ action: 'run', scope: 'boards' })
  assert.equal(pull2.status, 200)
  assert.equal(pull2.data.result.newJobsCount, 0)
  assert.equal(pull2.data.result.insightStatus, 'updating')
  for (let i = 0; i < 40 && marketCalls === 0; i += 1) {
    await new Promise(r => setTimeout(r, 25))
  }
  assert.equal(marketCalls, 1)

  // Wait until marketInsightRun finishes writing report
  for (let i = 0; i < 40; i += 1) {
    const st = (await req('/api/career-agent/state', null, 'GET')).data
    if (st.marketRadar?.reports?.target?.generatedAt && !st.marketRadar?.running) break
    await new Promise(r => setTimeout(r, 25))
  }

  // 3. Immediate 3rd pull with 0 new jobs -> reuses fresh cached insight without calling model again
  const pull3 = await act({ action: 'run', scope: 'boards' })
  assert.equal(pull3.status, 200)
  assert.equal(pull3.data.result.newJobsCount, 0)
  assert.equal(pull3.data.result.insightStatus, 'reused')
  await new Promise(r => setTimeout(r, 80))
  assert.equal(marketCalls, 1)
})
