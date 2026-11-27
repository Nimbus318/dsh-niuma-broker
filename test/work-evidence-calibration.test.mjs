import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  BRICK_TTL_MS,
  buildEvidenceSystem,
  extractEvidence,
  isLowSignalEpisode,
  MAX_EXCLUSION_RULES,
  observedInputs,
  pruneWorkBricks,
  rollupWorkBricks,
} from '../src/watch.mjs'
import { apply } from '../src/host.mjs'

test('observedInputs pairs settled turns with verified tool/assistant delivery receipts and scrubs secrets', () => {
  const now = Date.now()
  const snapshot = {
    session: { id: 'sess-turns' },
    events: [
      // Turn 1: Real completed delivery with tool/result + assistant/message + secret scrubbing
      { type: 'turn/start', seq: 0, time: now - 10_000, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: now - 9000,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把今天网关压测和发版收个尾，跑下全部测试。' }] },
      },
      {
        type: 'tool/result', seq: 2, time: now - 8500,
        data: { message: { toolName: 'bash', isError: false, content: [{ type: 'text', text: 'Token sk-secret1234567890abcd ACCESS_TOKEN: Bearer bearer_tok_987654 PASSWORD="my\'pass#99" DEEPSEEK_API_KEY=ds_live_9876543210; tests 128/128 passed; P99 latency dropped from 420ms to 190ms' }] } },
      },
      {
        type: 'tool/result', seq: 3, time: now - 8200,
        data: { message: { toolName: 'bash', isError: true, content: [{ type: 'text', text: 'Transient stderr warning' }] } },
      },
      {
        type: 'assistant/message', seq: 4, time: now - 8000,
        data: { message: { content: [{ type: 'text', text: '已完成发布合并，128 项测试全部通过。' }] } },
      },
      { type: 'turn/end', seq: 5, time: now - 7900, data: { reason: 'completed' } },

      // Turn 2: Micro-ack low-signal turn -> filtered by isLowSignalEpisode
      { type: 'turn/start', seq: 6, time: now - 5000, data: { turn: 2 } },
      {
        type: 'user/message', seq: 7, time: now - 4900,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] },
      },
      { type: 'turn/end', seq: 8, time: now - 4800, data: { reason: 'completed' } },

      // Turn 3: Aborted turn -> excluded unless user stated completed delivery
      { type: 'turn/start', seq: 9, time: now - 3000, data: { turn: 3 } },
      {
        type: 'user/message', seq: 10, time: now - 2900,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我迁移整个数据库到新集群。' }] },
      },
      { type: 'turn/end', seq: 11, time: now - 2800, data: { reason: 'aborted' } },

      // Turn 4: Structured { kind: 'aborted' } turn with partial passing test receipt -> excluded
      { type: 'turn/start', seq: 12, time: now - 2000, data: { turn: 4 } },
      {
        type: 'user/message', seq: 13, time: now - 1900,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '执行生产集群发布脚本。' }] },
      },
      {
        type: 'tool/result', seq: 14, time: now - 1500,
        data: { message: { toolName: 'bash', isError: false, content: [{ type: 'text', text: 'pre-deploy tests 24/24 passed' }] } },
      },
      { type: 'turn/end', seq: 15, time: now - 1000, data: { reason: { kind: 'aborted' } } },
    ],
  }

  const out = observedInputs(snapshot, -1, 0, 16)
  assert.equal(out.result.length, 2)
  assert.equal(out.through, 15)
  assert.equal(out.result[0].key, 'sess-turns:1')
  assert.match(out.result[0].deliverySummary, /P99 latency dropped from 420ms to 190ms/)
  assert.doesNotMatch(out.result[0].deliverySummary, /sk-secret1234567890abcd/)
  assert.doesNotMatch(out.result[0].deliverySummary, /bearer_tok_987654/)
  assert.doesNotMatch(out.result[0].deliverySummary, /my'pass#99/)
  assert.doesNotMatch(out.result[0].deliverySummary, /ds_live_9876543210/)
  assert.doesNotMatch(out.result[0].deliverySummary, /Transient stderr/)
  assert.equal(isLowSignalEpisode(out.result[0]), false)
  assert.equal(isLowSignalEpisode(out.result[1]), true)
})

test('4-dimension worthiness rubric calibrates across 6 professions, level presets, Market Insights gaps, and exclusions', async () => {
  const professions = [
    { role: '后端工程师', level: 'senior', gap: '分布式一致性 Raft', exclusion: '日常依赖小版本升级' },
    { role: '产品经理', level: 'ic', gap: '商业化漏斗定价', exclusion: '例行周会纪要整理' },
    { role: '校园招聘 HR', level: 'campus', gap: '雇主品牌校企联动', exclusion: '常规面试官排期提醒' },
    { role: 'FP&A 财务分析', level: 'senior', gap: '多币种预算建模', exclusion: '日常报销凭证核对' },
    { role: '数据合规与隐私法务', level: 'ic', gap: '跨境传输 PIA 评估', exclusion: '常规 NDA 格式审查' },
    { role: '技术美术 Tech Art', level: 'campus', gap: 'GPU Shader Profiler', exclusion: '单张贴图尺寸微调' },
  ]

  for (const spec of professions) {
    const sys = buildEvidenceSystem({
      locale: 'zh',
      careerLevel: spec.level,
      careerContext: { goal: spec.role, missingSkills: [spec.gap] },
      exclusions: [spec.exclusion],
    })
    assert.match(sys, /四维简历写入标尺/)
    assert.match(sys, new RegExp(spec.gap))
    assert.match(sys, new RegExp(spec.exclusion))
  }

  // Delivery-backed quote verification + brick vs milestone classification
  const episode = {
    key: 'sess-fit:1',
    sourceId: 'dsh-session',
    projectId: 'sess-fit',
    occurredAt: '2026-11-26T10:00:00.000Z',
    body: '按昨天的方案把分布式一致性模块收尾了，看下最后结果。',
    deliverySummary: '[bash] Raft failover integration suite 24/24 passed; failover recovery cut from 12s to 1.4s',
  }
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify({
            records: [{
              key: 'sess-fit:1',
              kind: 'achievement',
              tier: 'milestone',
              quote: 'Raft failover integration suite 24/24 passed; failover recovery cut from 12s to 1.4s',
              title: '落地 Raft 自动切主故障恢复机制',
              text: '完成分布式一致性模块 Raft 自动切主实现与验证，故障恢复耗时从 12s 降至 1.4s。',
              role: '',
              impact: '故障恢复 12s -> 1.4s',
              reasonTag: 'gap',
              reasonText: '补足目标岗缺失的分布式一致性实操闭环，且有量化恢复指标。',
            }],
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const proposals = await extractEvidence(llm, { model: 'mock:fast', sendToModel: true }, [episode], undefined, false, 'zh', {
    careerLevel: 'senior',
    careerContext: { missingSkills: ['分布式一致性 Raft'] },
  })
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].event.evidence[0].reasonTag, 'gap')
  assert.match(proposals[0].event.evidence[0].reasonText, /分布式一致性/)
})

test('brick buffer stays silent below 3, auto-rolls up at >=3, expires after 30d TTL, and respects taste dismissals & level preview', async t => {
  const nowMs = Date.parse('2026-11-27T00:00:00.000Z')
  const staleBrick = {
    id: 'b-stale',
    key: 's:0',
    sourceId: 'dsh-session',
    projectId: 's',
    occurredAt: new Date(nowMs - BRICK_TTL_MS - 3600_000).toISOString(),
    title: '过期日常',
    text: '过期未聚合的日常进展',
    topic: '推理延迟优化',
  }
  assert.equal(pruneWorkBricks([staleBrick], nowMs).length, 0)

  const twoBricks = [
    { id: 'b1', key: 's:1', sourceId: 'dsh-session', projectId: 's', occurredAt: '2026-11-24T10:00:00.000Z', title: '调优批处理大小', text: '完成动态 batch 尺寸调优', impact: '', topic: '推理延迟优化' },
    { id: 'b2', key: 's:2', sourceId: 'dsh-session', projectId: 's', occurredAt: '2026-11-25T10:00:00.000Z', title: '补齐 KV Cache 监控', text: '落地 KV Cache 命中率监控指标', impact: '', topic: '推理延迟优化' },
  ]
  assert.equal(rollupWorkBricks(twoBricks, nowMs, 'zh').rollups.length, 0)

  const threeBricks = [
    ...twoBricks,
    { id: 'b3', key: 's:3', sourceId: 'dsh-session', projectId: 's', occurredAt: '2026-11-26T10:00:00.000Z', title: '上线量化采样路由', text: '上线低延迟采样路由优化', impact: 'TTFT 下降 18%', topic: '推理延迟优化' },
  ]
  const rolled = rollupWorkBricks(threeBricks, nowMs, 'zh')
  assert.equal(rolled.rollups.length, 1)
  assert.equal(rolled.rollups[0].event.evidence[0].reasonTag, 'milestone')
  assert.match(rolled.rollups[0].event.evidence[0].reasonText, /3 条/)

  // Cross-source / cross-project bricks must NEVER merge into a shared rollup
  const crossSourceBricks = [
    ...twoBricks,
    { id: 'b-rec', key: 'r:1', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: '2026-11-26T10:00:00.000Z', title: '会议补充调优', text: '录音提到调优细节', impact: '', topic: '推理延迟优化' },
  ]
  assert.equal(rollupWorkBricks(crossSourceBricks, nowMs, 'zh').rollups.length, 0)

  // Full host end-to-end verification
  const dir = await mkdtemp(join(tmpdir(), 'niuma-calibration-host-'))
  const harness = createFetchHarness()
  const recentMs = Date.now() - 3600_000
  let passIdx = 0
  const snapshots = new Map([
    ['sess-cal', {
      session: { id: 'sess-cal', cwd: '/work' },
      events: [
        { type: 'user/message', seq: 0, time: recentMs - 9000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天先调优了动态 batch 调度参数并已合并 PR。' }] } },
        { type: 'turn/end', seq: 1, time: recentMs - 8500, data: { reason: 'completed' } },
        { type: 'user/message', seq: 2, time: recentMs - 6000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天补全了 KV Cache 分层缓存统计并已发布。' }] } },
        { type: 'turn/end', seq: 3, time: recentMs - 5500, data: { reason: 'completed' } },
        { type: 'user/message', seq: 4, time: recentMs - 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '嗯嗯' }] } },
        { type: 'turn/end', seq: 5, time: recentMs - 2500, data: { reason: 'completed' } },
        { type: 'user/message', seq: 6, time: recentMs - 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '完成了量化推理路由上线，TTFT 降低 22%。' }] } },
        { type: 'turn/end', seq: 7, time: recentMs - 1500, data: { reason: 'completed' } },
      ],
    }],
  ])

  let llmCalls = 0
  let capturedSystem = ''
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [...snapshots.values()].map(({ session }) => ({ header: session })),
      readSession: async id => snapshots.get(id),
    },
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream(options) {
        llmCalls += 1
        capturedSystem = options.system
        const items = JSON.parse(options.messages[0].content[0].text)
        const records = items.map(it => ({
          key: it.key,
          kind: 'achievement',
          tier: (it.key === 'sess-cal:6' || it.key === 'sess-cal:10') && passIdx === 0 ? 'milestone' : 'brick',
          quote: it.text.slice(0, 18),
          title: it.key === 'sess-cal:0' ? '动态 batch 调优上线'
            : it.key === 'sess-cal:2' ? 'KV Cache 监控上线'
              : (passIdx === 1 ? '量化推理路由补齐' : '例行改个环境变量脚本'),
          text: it.key === 'sess-cal:6' && passIdx === 0 ? '调整本地开发脚本变量' : `${it.text}并交付上线。`,
          impact: '',
          topic: '推理延迟优化',
          reasonTag: 'ownership',
          reasonText: '独立交付并合并上线',
        }))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ records }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }

  await apply(ctx)
  t.after(async () => {
    await dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const call = (url, body) => harness.call(body ? 'POST' : 'GET', url, body)
  const action = body => call('/api/career-agent/action', body)
  const state = async () => (await call('/api/career-agent/state')).data

  // Configure session watching (note: historyDays default 30 matches recentMs)
  await action({
    action: 'configure',
    config: { mode: 'observe', model: 'mock:fast', sendToModel: true, watchSessions: true, careerLevel: 'ic', sources: [{ id: 'dsh-session', projects: ['*'] }] },
  })
  await action({ action: 'run' })
  assert.equal(llmCalls, 1)
  // Low-signal turn ('嗯嗯') skipped before LLM, so 2 bricks + 1 pending milestone exist cleanly
  const st1 = await state()
  assert.equal(st1.workBricksSummary.recentWeekCount, 2)
  assert.equal(st1.workBricksSummary.totalBuffered, 2)
  assert.equal(st1.evidence.length, 1)

  // Verify bricks & exclusions live in career.json (CareerStore) and NOT watchdog.json
  const careerBeforeDismiss = JSON.parse(await readFile(join(dir, 'career-broker', 'career.json'), 'utf8'))
  const watchdogBeforeDismiss = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.equal((careerBeforeDismiss.workBricks ?? []).length, 2)
  assert.equal('workBricks' in watchdogBeforeDismiss, false)
  assert.equal('exclusionOrigins' in watchdogBeforeDismiss, false)
  assert.equal('evidenceExclusions' in (watchdogBeforeDismiss.config ?? {}), false)

  // Taste dismissal: rejects pending card & saves exclusion (preserving drafts!)
  const dismissRes = await action({ action: 'evidence-dismiss-taste', id: st1.evidence[0].id })
  assert.equal(dismissRes.status, 200)
  assert.equal(dismissRes.data.result.exclusions.length, 1)
  assert.equal((await state()).evidence[0].status, 'rejected')

  // Verify FIFO cap 12 on evidenceExclusions & atomic remove action
  const many = Array.from({ length: MAX_EXCLUSION_RULES }, (_, i) => `Rule ${i}`)
  await action({ action: 'configure', config: { evidenceExclusions: many } })
  const stCap = await state()
  assert.equal(stCap.config.evidenceExclusions.length, MAX_EXCLUSION_RULES)
  const removeRes = await action({ action: 'evidence-remove-exclusion', rule: 'Rule 11' })
  assert.equal(removeRes.status, 200)
  assert.equal(removeRes.data.result.exclusions.includes('Rule 11'), false)
  assert.equal((await state()).config.evidenceExclusions.length, MAX_EXCLUSION_RULES - 1)

  // Add a 3rd same-topic brick via a follow-up turn -> triggers auto-rollup milestone!
  passIdx = 1
  snapshots.get('sess-cal').events.push(
    { type: 'user/message', seq: 8, time: Date.now() - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天把多机并行采样配置合并发布了。' }] } },
    { type: 'turn/end', seq: 9, time: Date.now() - 500, data: { reason: 'completed' } },
  )
  await action({ action: 'run' })
  assert.match(capturedSystem, /Rule 0/)

  const st2 = await state()
  assert.equal(st2.workBricksSummary.totalBuffered, 0)
  const rollupEv = st2.evidence.find(e => String(e.eventId || '').startsWith('rollup:'))
  assert.ok(rollupEv)
  assert.equal(rollupEv.reasonTag, 'milestone')
  assert.equal(rollupEv.status, 'pending')

  // evidence-source works cleanly on synthesized rollup cards
  const rollupSrc = await action({ action: 'evidence-source', id: rollupEv.id })
  assert.equal(rollupSrc.status, 200)
  assert.match(rollupSrc.data.result.text, /聚合|Aggregated/)

  // Manual exclusion collision: if manual rule matches card title case-insensitively,
  // dismiss-taste rejects card without overwriting manual ownership, while new derived rules purge on forget
  await action({ action: 'configure', config: { evidenceExclusions: ['手动保留规则', rollupEv.title.toUpperCase()] } })
  const manualCollisionDismiss = await action({ action: 'evidence-dismiss-taste', id: rollupEv.id })
  assert.equal(manualCollisionDismiss.status, 200)
  // Create one more pending milestone card, dismiss it with a derived exclusion rule, then forget source
  passIdx = 0
  snapshots.get('sess-cal').events.push(
    { type: 'user/message', seq: 10, time: Date.now() - 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '顺手把开发环境变量检查脚本也合并提交了。' }] } },
    { type: 'turn/end', seq: 11, time: Date.now() - 200, data: { reason: 'completed' } },
  )
  await action({ action: 'run' })
  const extraCard = (await state()).evidence.find(e => e.status === 'pending')
  assert.ok(extraCard)
  await action({ action: 'evidence-dismiss-taste', id: extraCard.id, pattern: '临时推导排除词' })
  const stBeforeForget = await state()
  assert.ok(stBeforeForget.config.evidenceExclusions.includes('临时推导排除词'))
  assert.ok(stBeforeForget.config.evidenceExclusions.includes('手动保留规则'))
  await action({ action: 'forget', source: 'dsh-session', erase: true })
  const stAfterForget = await state()
  assert.equal(stAfterForget.config.evidenceExclusions.includes('临时推导排除词'), false)
  assert.equal(stAfterForget.config.evidenceExclusions.includes(rollupEv.title.toUpperCase()), true)
  assert.equal(stAfterForget.config.evidenceExclusions.includes('手动保留规则'), true)
  const careerAfterForget = JSON.parse(await readFile(join(dir, 'career-broker', 'career.json'), 'utf8'))
  assert.equal((careerAfterForget.workBricks ?? []).filter(b => b.sourceId === 'dsh-session').length, 0)
})

test('legacy watchdog.json bricks & exclusions migrate once into CareerStore and scrub legacy fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-legacy-cal-'))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'career-broker'), { recursive: true })
  const nowIso = new Date().toISOString()
  await writeFile(join(dir, 'career-broker', 'career.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'observe',
    sources: [{ id: 'dsh-session', projects: ['*'], authorizedAt: nowIso }],
    preferences: {},
    events: [],
    evidence: [{
      id: 'ev-1',
      eventId: 'sess:1',
      eventKey: 'k1',
      sourceId: 'dsh-session',
      projectId: 'sess-1',
      sourceRef: 'ref',
      kind: 'work-evidence',
      occurredAt: nowIso,
      title: 'Derived Title',
      text: 'Some text',
      createdAt: nowIso,
      status: 'rejected',
      shareable: false,
    }],
    reflections: [],
    resumes: [],
    suggestions: [],
  }))
  await writeFile(join(dir, 'career-broker', 'watchdog.json'), JSON.stringify({
    version: 1,
    config: { mode: 'observe', evidenceExclusions: ['Manual Legacy', 'Derived Title'] },
    workBricks: [{
      id: 'brick-legacy-1',
      key: 'sess-1:2',
      sourceId: 'dsh-session',
      projectId: 'sess-1',
      sourceRef: 'DSH sess-1:2',
      occurredAt: nowIso,
      title: 'Legacy Brick',
      text: 'Completed legacy step',
      topic: 'Legacy Topic',
    }],
    exclusionOrigins: {
      'derived title': { sourceId: 'dsh-session', projectId: 'sess-1', evidenceId: 'ev-1' },
    },
    cursors: {},
    opportunities: [],
    receipts: [],
    drafts: [],
    watch: { lastRun: null, nextRun: null, lastError: null, results: [] },
  }))

  const harness = createFetchHarness()
  let dispose
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => {
    await dispose?.()
    await rm(dir, { recursive: true, force: true })
  })

  const stateRes = await harness.call('GET', '/api/career-agent/state')
  assert.equal(stateRes.data.workBricksSummary.totalBuffered, 1)
  assert.equal('workBricks' in stateRes.data, false)
  assert.equal('exclusions' in stateRes.data, false)
  assert.deepEqual(stateRes.data.config.evidenceExclusions, ['Manual Legacy', 'Derived Title'])

  // Switching mode to off immediately hides buffered brick count (0) without mutating disk bricks
  await harness.call('POST', '/api/career-agent/action', { action: 'configure', config: { mode: 'off' } })
  assert.equal((await harness.call('GET', '/api/career-agent/state')).data.workBricksSummary.totalBuffered, 0)
  await harness.call('POST', '/api/career-agent/action', { action: 'configure', config: { mode: 'observe' } })
  assert.equal((await harness.call('GET', '/api/career-agent/state')).data.workBricksSummary.totalBuffered, 1)

  const careerDisk = JSON.parse(await readFile(join(dir, 'career-broker', 'career.json'), 'utf8'))
  const watchdogDisk = JSON.parse(await readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.equal(careerDisk.legacyCalibrationMigrated, true)
  assert.equal(careerDisk.workBricks.length, 1)
  assert.equal('workBricks' in watchdogDisk, false)
  assert.equal('exclusionOrigins' in watchdogDisk, false)
  assert.equal('evidenceExclusions' in watchdogDisk.config, false)

  // Forget source deletes derived rule while keeping manual legacy rule intact
  await harness.call('POST', '/api/career-agent/action', { action: 'forget', source: 'dsh-session', erase: true })
  const afterForget = await harness.call('GET', '/api/career-agent/state')
  assert.deepEqual(afterForget.data.config.evidenceExclusions, ['Manual Legacy'])
  assert.equal(afterForget.data.workBricksSummary.totalBuffered, 0)
})

test('same-timestamp distinct-topic rollups both emit milestones and locale-flipped replay still deduplicates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-dual-topic-rollup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { CareerStore } = await import('../src/career.mjs')
  const store = new CareerStore({ file: join(dir, 'career.json') })
  await store.setMode('observe')
  await store.authorizeSource({ id: 'recording:rec-1', projects: ['rec-1'] })
  const ts = new Date().toISOString()
  const bricks = [
    { key: 'rec-1:a1', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题A1', text: '完成模块重构并上线验收', topic: '网关限流' },
    { key: 'rec-1:a2', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题A2', text: '完成压力测试与稳定性验证', topic: '网关限流' },
    { key: 'rec-1:a3', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题A3', text: '完成灰度发布与监控告警', topic: '网关限流' },
    { key: 'rec-1:b1', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题B1', text: '完成模块重构并上线验收', topic: '计费对账' },
    { key: 'rec-1:b2', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题B2', text: '完成压力测试与稳定性验证', topic: '计费对账' },
    { key: 'rec-1:b3', sourceId: 'recording:rec-1', projectId: 'rec-1', occurredAt: ts, title: '主题B3', text: '完成灰度发布与监控告警', topic: '计费对账' },
  ]
  const first = await store.ingestBricksAndRollup(bricks, { locale: 'zh' })
  assert.equal(first.rolledUp.length, 2)

  // Reset promotedAt to simulate crash after event save, then replay under 'en' locale -> must NOT duplicate
  await store.transact(state => {
    state.workBricks = state.workBricks.map(b => ({ ...b, promotedAt: undefined }))
  })
  const replayEn = await store.ingestBricksAndRollup([], { locale: 'en' })
  assert.equal(replayEn.rolledUp.length, 0)
  assert.equal((await store.summary()).evidence.length, 2)
})

test('passive inspection tool output on low-signal turns never leaks into deliverySummary or LLM extraction', async () => {
  const now = Date.now()
  const snapshot = {
    session: { id: 'sess-privacy' },
    events: [
      { type: 'turn/start', seq: 0, time: now - 5000, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: now - 4500,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] },
      },
      {
        type: 'tool/result', seq: 2, time: now - 4000,
        data: { message: { toolName: 'read_file', isError: false, content: [{ type: 'text', text: 'Customer ACME_INTERNAL_9981 contract details at https://internal.corp.local/deal/42' }] } },
      },
      {
        type: 'assistant/message', seq: 3, time: now - 3500,
        data: { message: { content: [{ type: 'text', text: '客户 ACME_INTERNAL_9981 的合同审批还没有通过，我先继续核对。' }] } },
      },
      { type: 'turn/end', seq: 4, time: now - 3000, data: { reason: 'completed' } },
    ],
  }
  const out = observedInputs(snapshot, -1, 0, 16)
  assert.equal(out.result.length, 1)
  assert.equal(out.result[0].deliverySummary || '', '')
  assert.equal(isLowSignalEpisode(out.result[0]), true)
})
