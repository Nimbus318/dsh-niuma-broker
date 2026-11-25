import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  EVIDENCE_SYSTEM,
  buildEvidenceSystem,
  extractEvidence,
  isSpeculativeNonAchievement,
} from '../src/watch.mjs'
import { apply } from '../src/host.mjs'
import { predictNextPrompt } from '../src/resume-agent.mjs'

function mockLlmReturning(handler) {
  return {
    listProviders: () => [{ id: 'mock' }],
    async *stream(options) {
      const payload = await handler(options)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(payload) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('EVIDENCE_SYSTEM enforces high resume-worthiness bar, default empty, and achievement vs reflection separation', () => {
  assert.match(EVIDENCE_SYSTEM, /宁缺毋滥/)
  assert.match(EVIDENCE_SYSTEM, /\{"records":\[\]\}/)
  assert.match(EVIDENCE_SYSTEM, /kind="achievement"/)
  assert.match(EVIDENCE_SYSTEM, /kind="reflection"/)
  assert.match(EVIDENCE_SYSTEM, /脑暴|设想|畅想/)
  assert.match(EVIDENCE_SYSTEM, /第三人称转述腔/)

  const recPrompt = buildEvidenceSystem({
    fromRecording: true,
    locale: 'en',
    careerContext: { goal: 'Staff Backend Engineer', searchTerms: ['Distributed Systems', 'Go'] },
  })
  assert.match(recPrompt, /已授权工作录音/)
  assert.match(recPrompt, /Staff Backend Engineer/)
  assert.match(recPrompt, /Distributed Systems \/ Go/)
  assert.match(recPrompt, /English/i)
})

test('extractEvidence rejects speculative product brainstorming including exact future-Agent screenshot case', async () => {
  const sourceBody = '我想基于 DeepSeekHarness 的“一切皆插件”理念做一个未来 Agent：让微信、飞书等主流 IM 都能以插件形式打通，在一个平台内承载工作与生活场景，具备主动感知和提醒；同时打算用卡片向自己补充确认信息，先想清楚再动手。'
  const message = {
    key: 'sess-chat:3',
    sourceId: 'dsh-session',
    projectId: 'sess-chat',
    occurredAt: '2026-11-21T12:48:00.000Z',
    body: sourceBody,
  }

  // Case 1: Model echoes the exact screenshot card verbatim
  const llm1 = mockLlmReturning(() => ({
    records: [{
      key: message.key,
      kind: 'achievement',
      quote: '基于 DeepSeekHarness 的“一切皆插件”理念做一个未来 Agent',
      title: '设想基于插件化 Harness 打通各类应用的未来 Agent',
      text: '用户提出想基于 DeepSeekHarness 的“一切皆插件”理念做一个未来 Agent：让各类应用（含微信、飞书等主流 IM）都能以插件形式打通，并在一个平台内承载工作与生活场景，具备主动感知、合时宜的提醒与建议；同时打算用卡片等交互方式向自己补充确认信息，并先想清楚再动手。',
      role: '提出产品设想与场景方向，规划落地路径',
      impact: '',
    }],
  }))
  const res1 = await extractEvidence(llm1, { model: 'mock:fast', sendToModel: true }, [message])
  assert.deepEqual(res1, [])

  // Case 2: Weak model strips "设想" from title and omits "用户提出想", trying to disguise brainstorm as an achievement
  const llm2 = mockLlmReturning(() => ({
    records: [{
      key: message.key,
      kind: 'achievement',
      quote: '同时打算用卡片向自己补充确认信息，先想清楚再动手',
      title: '插件化全场景 Agent 产品规划',
      text: '基于插件化理念构建覆盖工作与生活场景的智能体平台并设计卡片交互。',
      role: '产品规划',
      impact: '',
    }],
  }))
  const res2 = await extractEvidence(llm2, { model: 'mock:fast', sendToModel: true }, [message])
  assert.deepEqual(res2, [])

  // Case 3: English brainstorming & AI command requests
  assert.equal(isSpeculativeNonAchievement({
    title: 'Brainstorming a plugin-based future Agent',
    text: 'User wants to build a personal assistant across Slack and email before building it.',
    impact: '',
  }), true)
  assert.equal(isSpeculativeNonAchievement({
    title: '编写邮箱正则',
    text: '用户请 AI 写一个匹配邮箱的正则表达式。',
    impact: '',
  }), true)
})

test('extractEvidence keeps genuine shipped work achievements and strips stray third-person prefix', async () => {
  const messages = [
    {
      key: 'sess-work:1',
      sourceId: 'dsh-session',
      projectId: 'sess-work',
      occurredAt: '2026-11-21T10:00:00.000Z',
      body: '这周终于把订单网关迁移完成了并全量上线，P99 延迟降低 40%，故障率为 0。',
    },
    {
      key: 'sess-work:2',
      sourceId: 'dsh-session',
      projectId: 'sess-work',
      occurredAt: '2026-11-21T10:05:00.000Z',
      body: 'Shipped the unified billing retry pipeline in Go, reducing payment dispatch failures by 45%.',
    },
    {
      key: 'sess-work:3',
      sourceId: 'dsh-session',
      projectId: 'sess-work',
      occurredAt: '2026-11-21T10:10:00.000Z',
      body: '之前想做一个灰度回滚机制，这周已经开发完成并上线了，回滚耗时缩短 60%。',
    },
  ]

  const llm = mockLlmReturning(() => ({
    records: [
      {
        key: 'sess-work:1',
        kind: 'achievement',
        quote: '把订单网关迁移完成了并全量上线，P99 延迟降低 40%',
        title: '完成订单网关迁移上线',
        text: '用户提到：独立完成了订单网关迁移并全量上线，P99 延迟降低 40%。',
        role: '',
        impact: 'P99 延迟降低 40%，故障率为 0',
      },
      {
        key: 'sess-work:2',
        // kind intentionally omitted for backward compatibility
        quote: 'Shipped the unified billing retry pipeline in Go',
        title: 'Shipped unified billing retry pipeline',
        text: 'Shipped the unified billing retry pipeline in Go, cutting payment dispatch failures by 45%.',
        role: 'Backend Lead',
        impact: 'Reduced payment dispatch failures by 45%',
      },
      {
        key: 'sess-work:3',
        kind: 'achievement',
        quote: '这周已经开发完成并上线了，回滚耗时缩短 60%',
        title: '上线灰度回滚机制',
        text: '完成灰度回滚机制开发并上线，回滚耗时缩短 60%。',
        role: '',
        impact: '回滚耗时缩短 60%',
      },
    ],
  }))

  const proposals = await extractEvidence(llm, { model: 'mock:fast', sendToModel: true }, messages)
  assert.equal(proposals.length, 3)
  assert.equal(proposals[0].event.evidence[0].text, '独立完成了订单网关迁移并全量上线，P99 延迟降低 40%。')
  assert.equal(proposals[0].event.evidence[0].role, '')
  assert.equal(proposals[1].event.evidence[0].title, 'Shipped unified billing retry pipeline')
  assert.equal(proposals[2].event.evidence[0].title, '上线灰度回滚机制')
})

test('kind="reflection" stays out of work-evidence resume suggestions and is erased on forgetSource', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-watch-reflection-'))
  const capturedSystems = []
  const now = Date.now()
  const snapshots = new Map([
    ['sess-mixed', {
      session: { id: 'sess-mixed', cwd: '/work' },
      events: [
        {
          type: 'user/message', seq: 0, time: now - 3000,
          data: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '我想基于插件化理念做一个未来 Agent，先想清楚再动手。' }],
          },
        },
        {
          type: 'user/message', seq: 1, time: now - 2000,
          data: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '连续三个月高频救火加班，感觉在当前团队成长空间有限，想重新评估方向。' }],
          },
        },
        {
          type: 'user/message', seq: 2, time: now - 1000,
          data: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '今天主导完成了搜索索引重建工具上线，重建耗时从 4 小时降到 35 分钟。' }],
          },
        },
        { type: 'turn/end', seq: 3, time: now - 500 },
      ],
    }],
  ])

  const harness = createFetchHarness()
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
        capturedSystems.push(options.system)
        const records = [
          {
            key: 'sess-mixed:0',
            kind: 'achievement',
            quote: '基于插件化理念做一个未来 Agent，先想清楚再动手',
            title: '设想插件化未来 Agent',
            text: '用户提出想做一个未来 Agent，并打算先想清楚再动手。',
            role: '提出产品设想',
            impact: '',
          },
          {
            key: 'sess-mixed:1',
            kind: 'reflection',
            quote: '连续三个月高频救火加班，感觉在当前团队成长空间有限',
            title: '',
            text: '连续三个月高频救火加班，感到当前团队成长空间有限，开始重新评估职业方向。',
            dimension: 'growth',
            severity: 'concern',
          },
          {
            key: 'sess-mixed:2',
            kind: 'achievement',
            quote: '主导完成了搜索索引重建工具上线，重建耗时从 4 小时降到 35 分钟',
            title: '上线搜索索引重建工具',
            text: '主导完成搜索索引重建工具上线，将重建耗时从 4 小时缩短至 35 分钟。',
            role: '主导负责人',
            impact: '重建耗时从 4 小时降至 35 分钟',
          },
        ]
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

  const request = (url, body) => harness.call(body ? 'POST' : 'GET', url, body)
  const action = body => request('/api/career-agent/action', body)
  const state = async () => (await request('/api/career-agent/state')).data

  await action({
    action: 'configure',
    config: {
      mode: 'observe',
      model: 'mock:fast',
      sendToModel: true,
      watchSessions: true,
      goal: '高级后端架构师',
      searchTerms: ['搜索引擎', '分布式存储'],
      allowReflections: true,
      sources: [{ id: 'dsh-session', projects: ['*'] }],
    },
  })
  await action({ action: 'run' })

  assert.ok(capturedSystems.some(s => s.includes('高级后端架构师') && s.includes('搜索引擎 / 分布式存储')))

  const afterRun = await state()
  // Only the genuine shipped work achievement enters `evidence` (resume suggestions)!
  assert.equal(afterRun.evidence.length, 1)
  assert.equal(afterRun.evidence[0].title, '上线搜索索引重建工具')
  // Pure reflection enters `reflections` without creating a bogus work-evidence card!
  assert.equal(afterRun.reflections.length, 1)
  assert.equal(afterRun.reflections[0].sourceId, 'dsh-session')
  assert.deepEqual(afterRun.reflections[0].evidenceIds, [])
  assert.equal(afterRun.reflections[0].dimension, 'growth')
  assert.equal(afterRun.reflections[0].status, 'pending')

  // User can approve the standalone source-backed reflection
  const approvedRef = await action({ action: 'reflection-review', id: afterRun.reflections[0].id, decision: 'approve' })
  assert.equal(approvedRef.status, 200)
  assert.equal((await state()).reflections[0].status, 'approved')

  // Forgetting & erasing dsh-session wipes BOTH the evidence AND the standalone reflection from disk
  const forgot = await action({ action: 'forget', source: 'dsh-session', erase: true })
  assert.equal(forgot.status, 200)
  const afterForget = await state()
  assert.equal(afterForget.evidence.length, 0)
  assert.equal(afterForget.reflections.length, 0)
  const persisted = await readFile(join(dir, 'career-broker', 'career.json'), 'utf8')
  assert.doesNotMatch(persisted, /搜索索引重建工具|高频救火加班|插件化未来 Agent/)
})

test('predictNextPrompt for the library excludes selected jobs and prior replies', async () => {
  let capturedSystem = ''
  let capturedPrompt = ''
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream(options) {
      capturedSystem = options.system
      capturedPrompt = options.messages[0].content[0].text
      yield { type: 'text-delta', text: '这次部署验收的做法。' }
    },
  }
  const out = await predictNextPrompt({
    llm,
    config: { model: 'mock:fast', sendToModel: true },
    surface: 'library',
    prefix: '我想记录',
    selectedJobs: [
      { id: 'mihoyo:social:1', company: '米哈游', title: '大模型推理平台工程师', stage: 'discovered' },
      { id: 'mihoyo:social:2', company: '米哈游', title: 'AI 网关后端开发', stage: 'discovered' },
    ],
    history: [{ role: 'assistant', content: '上一轮在对比两家招聘公司。' }],
    activeJob: { id: 'mihoyo:social:1', company: '米哈游', title: '大模型推理平台工程师' },
    locale: 'zh',
  })
  assert.equal(out.suggestion, '我想记录这次部署验收的做法。')
  assert.match(capturedPrompt, /我想记录/)
  assert.doesNotMatch(capturedPrompt, /米哈游|大模型推理平台工程师|对比两家招聘公司/)
  assert.match(capturedSystem, /个人履历库与职业记录|绝不提及岗位对比/)
})

test('host action=run reports structured session counts and skipped reason when sendToModel=false, and suggest isolates surface=library', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-feedback-'))
  const harness = createFetchHarness()
  let dispose = async () => {}
  const suggestPrompts = []
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'sess-1', cwd: '/work' } }],
      readSession: async () => ({
        session: { id: 'sess-1', cwd: '/work' },
        events: [
          {
            type: 'user/message', seq: 0, time: Date.now() - 1000,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看一下这个报错怎么修？' }] },
          },
          { type: 'turn/end', seq: 1, time: Date.now() - 500 },
        ],
      }),
    },
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream(options) {
        if (options.system.includes('履历库')) {
          suggestPrompts.push(options.messages[0].content[0].text)
          yield { type: 'text-delta', text: '上周完成了在线服务耗时优化，记入履历库' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ records: [] }) } }
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

  const req = (url, body) => harness.call(body ? 'POST' : 'GET', url, body)

  // Case 1: sendToModel=false reports skipped reason=no_model_auth
  await req('/api/career-agent/action', {
    action: 'configure',
    config: { mode: 'observe', model: 'mock:fast', sendToModel: false, watchSessions: true, sources: [{ id: 'dsh-session', projects: ['*'] }] },
  })
  const skippedRun = await req('/api/career-agent/action', { action: 'run' })
  assert.equal(skippedRun.status, 200)
  const skippedRow = skippedRun.data.result.results.find(r => r.sourceId === 'dsh-session')
  assert.equal(skippedRow?.status, 'skipped')
  assert.equal(skippedRow?.reason, 'no_model_auth')

  // Case 2: sendToModel=true checks 1 message and returns 0 qualifying achievements cleanly
  await req('/api/career-agent/action', { action: 'configure', config: { sendToModel: true } })
  const okRun = await req('/api/career-agent/action', { action: 'run' })
  const okRow = okRun.data.result.results.find(r => r.sourceId === 'dsh-session')
  assert.equal(okRow?.status, 'ok')
  assert.equal(okRow?.count, 1)
  assert.equal(okRow?.proposed, 0)
  assert.equal(okRow?.achievements, 0)
  assert.equal(okRow?.reflections, 0)

  // Case 3: /api/career-agent/suggest with surface=library strips tracked opportunities
  const addedJob = await req('/api/career-agent/action', {
    action: 'job-add',
    job: { company: '米哈游', title: '大模型推理平台工程师', location: '上海', jd: '负责大模型推理平台' },
  })
  const jobId = addedJob.data.result.id
  const suggestRes = await req('/api/career-agent/suggest', {
    surface: 'library', prefix: '上周我想记下', locale: 'zh', opportunityId: jobId, selectedOpportunityIds: [jobId],
  })
  assert.equal(suggestRes.status, 200)
  assert.equal(suggestRes.data.ok, true)
  assert.equal(suggestPrompts.length, 1)
  assert.match(suggestPrompts[0], /上周我想记下/)
  assert.doesNotMatch(suggestPrompts[0], /米哈游|大模型推理平台工程师/)
})

test('scanSessions does not advance cursors when sendToModel=true but no AI model is available yet', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-nomodel-'))
  const harness = createFetchHarness()
  let dispose = async () => {}
  let modelReady = false
  let sessionReads = 0
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'sess-hist', cwd: '/work' } }],
      readSession: async () => {
        sessionReads += 1
        return {
          session: { id: 'sess-hist', cwd: '/work' },
          events: [
            {
              type: 'user/message', seq: 0, time: Date.now() - 1000,
              data: { source: { kind: 'user' }, content: [{ type: 'text', text: '本周上线了 GPU 弹性调度器，集群利用率从 41% 提升到 69%。' }] },
            },
            { type: 'turn/end', seq: 1, time: Date.now() - 500 },
          ],
        }
      },
    },
    llm: {
      listProviders: () => (modelReady ? [{ id: 'mock' }] : []),
      listModels: async () => (modelReady ? [{ id: 'fast' }] : []),
      async *stream() {
        const records = [{
          key: 'sess-hist:0',
          kind: 'achievement',
          quote: '上线了 GPU 弹性调度器，集群利用率从 41% 提升到 69%',
          title: '上线 GPU 弹性调度器',
          text: '主导上线 GPU 弹性调度器，将集群利用率从 41% 提升至 69%。',
          role: '核心负责人',
          impact: '利用率 41% -> 69%',
        }]
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

  const req = (url, body) => harness.call(body ? 'POST' : 'GET', url, body)

  // Run 1: sendToModel=true, but NO model provider is available yet
  await req('/api/career-agent/action', {
    action: 'configure',
    config: { mode: 'observe', model: '', sendToModel: true, watchSessions: true, sources: [{ id: 'dsh-session', projects: ['*'] }] },
  })
  const firstRun = await req('/api/career-agent/action', { action: 'run' })
  assert.equal(firstRun.status, 200)
  const firstRow = firstRun.data.result.results.find(r => r.sourceId === 'dsh-session')
  assert.equal(firstRow?.status, 'error')
  assert.equal(sessionReads, 0, 'Must not read sessions or advance cursors when no model is available')

  // Run 2: Model becomes available -> historical message MUST NOT have been skipped!
  modelReady = true
  await req('/api/career-agent/action', { action: 'configure', config: { model: 'mock:fast' } })
  const secondRun = await req('/api/career-agent/action', { action: 'run' })
  const secondRow = secondRun.data.result.results.find(r => r.sourceId === 'dsh-session')
  assert.equal(secondRow?.status, 'ok')
  assert.equal(secondRow?.count, 1)
  assert.equal(secondRow?.proposed, 1)
  const st = (await req('/api/career-agent/state')).data
  assert.equal(st.evidence.length, 1)
  assert.equal(st.evidence[0].title, '上线 GPU 弹性调度器')
})
