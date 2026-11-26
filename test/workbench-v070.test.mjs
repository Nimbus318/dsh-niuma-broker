import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import { CareerStore } from '../src/career.mjs'
import { apply } from '../src/host.mjs'
import { localResumeTemplates, renderLocalResume } from '../src/local-templates.mjs'
import { isValidPdfBuffer, renderLocalResumePdf } from '../src/local-pdf.mjs'
import { applyTailoredSelection, proposeResumeConversation } from '../src/resume-conversation.mjs'
import { accentToThumbFilter, parseStyleDirective } from '../src/resume-style.mjs'
import { predictNextPrompt, streamResumeAgentTurn } from '../src/resume-agent.mjs'
import { collectOpportunities } from '../src/opportunities.mjs'
import { listPersonalTargets } from '../src/personal-schedule.mjs'
import { fetchCompanyLogo } from '../src/company-logos.mjs'

async function storeFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-v070-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return new CareerStore({ file: join(dir, 'career.json') })
}

test('unified rich-text revision preserves evidence lineage, blocks job-specific base reuse, and redacts revoked snapshots in summary', async t => {
  const store = await storeFixture(t)
  await store.setMode('observe')
  await store.authorizeSource({ id: 'dsh-session', projects: ['proj-1'] })
  const { evidence: [ev1, ev2] } = await store.ingestEvents([
    {
      id: 'e1', sourceId: 'dsh-session', projectId: 'proj-1', kind: 'work',
      occurredAt: '2026-11-18T10:00:00.000Z', sourceRef: 'session:proj-1#1',
      evidence: [{ title: '告警规则优化', text: '重构告警规则，将误报率降低 40%。' }],
    },
    {
      id: 'e2', sourceId: 'dsh-session', projectId: 'proj-1', kind: 'work',
      occurredAt: '2026-11-19T10:00:00.000Z', sourceRef: 'session:proj-1#2',
      evidence: [{ title: '值班手册沉淀', text: '整理推理集群值班响应手册。' }],
    },
  ])
  await store.reviewEvidence(ev1.id, { action: 'approve', shareable: true })
  await store.reviewEvidence(ev2.id, { action: 'approve', shareable: true })

  // 1. Generate resume from evidence, then edit via full rich-text Markdown (adding heading & bold)
  const generated = await store.proposeResume({
    title: '个人履历', items: [{ text: ev1.text, evidenceIds: [ev1.id] }],
  })
  await store.reviewResume(generated.id, { action: 'approve' })

  const richEdited = await store.reviseResume(generated.id, {
    text: '# 林予安\n\n## 工作经历\n- 重构告警规则，将误报率降低 **40%**。\n- 补充可观测性看板建设说明。\n',
  })
  assert.equal(richEdited.kind, 'revised')
  assert.equal(richEdited.general, true)
  assert.deepEqual(richEdited.evidenceIds, [ev1.id])
  await store.reviewResume(richEdited.id, { action: 'approve' })
  assert.match(await store.exportResume(richEdited.id), /误报率降低 \*\*40%\*\*/)

  // 2. General revised version can be extended with new evidence without duplicating ev1
  const extended = await store.proposeResume({
    title: '新增成果', baseId: richEdited.id, items: [{ text: ev2.text, evidenceIds: [ev2.id] }],
  })
  await store.reviewResume(extended.id, { action: 'approve' })
  assert.match(await store.exportResume(extended.id), /整理推理集群值班响应手册/)

  // 3. JD-tailored resume WITHOUT opportunityId, revised via rich text, must keep general: false
  const jdTailored = await store.proposeTailoredResume({
    baseId: richEdited.id, title: '岗位定制简历',
    lines: [{ source: '- 重构告警规则，将误报率降低 **40%**。', text: '主导告警规则重构，误报率下降 40%。', reason: '岗位强调可观测性与稳定性' }],
    gaps: '缺少多区域容灾经验。',
  })
  assert.equal(jdTailored.items[0].reason, '岗位强调可观测性与稳定性')
  await store.reviewResume(jdTailored.id, { action: 'approve' })

  const jdRevised = await store.reviseResume(jdTailored.id, {
    text: '# 林予安\n\n## 工作经历\n- 主导告警规则重构，误报率下降 40%（自定义润色）。\n',
  })
  assert.equal(jdRevised.kind, 'revised')
  assert.equal(jdRevised.general, false)
  assert.equal(jdRevised.opportunityId, undefined)
  await store.reviewResume(jdRevised.id, { action: 'approve' })
  await assert.rejects(
    store.proposeResume({ title: '尝试扩展', baseId: jdRevised.id, items: [{ text: ev2.text, evidenceIds: [ev2.id] }] }),
    /job-specific/,
  )

  // 4. Revoking the source must deny preview/export AND redact revised snapshot text from summary()!
  await store.revokeSource('dsh-session')
  await assert.rejects(store.previewResume(richEdited.id), /active human approval/)
  await assert.rejects(store.exportResume(richEdited.id), /active human approval/)
  await assert.rejects(store.previewResume(jdRevised.id), /active human approval/)
  const afterRevoke = await store.summary()
  const leaked = afterRevoke.resumes.filter(row => row.kind === 'revised' && row.text !== undefined)
  assert.deepEqual(leaked, [], 'Revoked revised resumes must not expose text in summary()')
  assert.ok(afterRevoke.resumes.filter(row => row.kind === 'revised').every(row => row.status === 'revoked'))
})

test('host resumeFor never selects a general:false revised JD draft as the general resume', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-host-v070-'))
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readSession: async () => { throw new Error('none') } },
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream() {
        yield {
          type: 'block-end', index: 0,
          block: { type: 'text', text: JSON.stringify({ lines: [{ index: 3, text: '重构告警并提升值班效率。', reason: '贴合岗位值班要求' }], gaps: '' }) },
        }
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
  await call('/api/career-agent/action', { action: 'configure', config: { mode: 'observe', sources: [{ id: 'manual', projects: ['personal'] }] } })
  const imported = (await call('/api/career-agent/action', {
    action: 'resume-import', title: '通用底稿',
    text: '# 林予安\n\n## 工作经历\n- 优化了告警规则。\n- 维护了监控看板。\n',
  })).data.result
  await call('/api/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })
  const tailored = (await call('/api/career-agent/action', {
    action: 'tailor-resume', jd: '需要具备值班与告警经验', resumeId: imported.id, model: 'mock:test',
  })).data.result
  await call('/api/career-agent/action', { action: 'resume-review', id: tailored.id, decision: 'approve' })
  const jdRevised = (await call('/api/career-agent/action', {
    action: 'resume-revise', id: tailored.id,
    text: '# 林予安\n\n## 工作经历\n- 重构告警并提升值班效率（岗位定制修订版）。\n- 维护了监控看板。\n',
  })).data.result
  await call('/api/career-agent/action', { action: 'resume-review', id: jdRevised.id, decision: 'approve' })

  // Now approve new evidence -> resume-generate MUST extend 通用底稿, NOT jdRevised!
  const ing = (await call('/api/career-agent/action', {
    action: 'ingest',
    event: {
      id: 'm1', sourceId: 'manual', projectId: 'personal', kind: 'manual',
      occurredAt: '2026-11-19T10:00:00.000Z',
      evidence: [{ title: '扩容交付', text: '推动 3 个算力池扩容验收。' }],
    },
  })).data.result
  const rev = (await call('/api/career-agent/action', {
    action: 'review', id: ing.evidence[0].id, decision: 'approve', shareable: true,
  })).data.result
  assert.ok(rev.resumeId)
  const state = (await call('/api/career-agent/state')).data
  const merged = state.resumes.find(row => row.id === rev.resumeId)
  assert.equal(merged.baseId, imported.id, 'General resume update must branch from 通用底稿, not general:false jdRevised')
  assert.doesNotMatch(merged.text, /岗位定制修订版/)
})

test('JD-tailored drafts support item-by-item partial selection with client preview parity', async t => {
  const store = await storeFixture(t)
  const baseText = '# 林予安\n\n## 工作经历\n- 第一条旧表述。\n- 第二条旧表述。\n'
  const base = await store.importResume({ title: '底稿', text: baseText })
  await store.reviewResume(base.id, { action: 'approve' })
  const tailored = await store.proposeTailoredResume({
    baseId: base.id, title: '目标岗定制',
    lines: [
      { source: '- 第二条旧表述。', text: '第二条优先改写。', reason: '岗位核心要求' },
      { source: '- 第一条旧表述。', text: '第一条次要改写。' },
    ],
  })
  const previewOne = applyTailoredSelection(baseText.trim(), [tailored.items[0]])
  const accepted = await store.reviewResume(tailored.id, { action: 'approve', selected: [0] })
  const exported = await store.exportResume(accepted.id)
  assert.equal(exported, previewOne)
  assert.match(exported, /- 第二条优先改写。\n- 第一条旧表述。/)
  assert.doesNotMatch(exported, /第一条次要改写/)
})

test('conversation optimization preserves sanitized reason notes and templates expose layout metadata', async () => {
  assert.equal(localResumeTemplates.length, 18)
  assert.ok(localResumeTemplates.some(t => t.columns === 2 && t.sidebarSide === 'left'))
  assert.ok(localResumeTemplates.some(t => t.columns === 1 && t.atsSafe === true))

  const { items } = await proposeResumeConversation({
    config: { model: 'fixture:mock', sendToModel: true },
    source: '# 林予安\n## 工作经历\n- 完成了 3 个资源池扩容。\n',
    request: '突出主导作用',
    llm: {
      listProviders: () => [{ id: 'fixture' }],
      async *stream() {
        yield {
          type: 'block-end', index: 0,
          block: {
            type: 'text',
            text: JSON.stringify({
              items: [{ index: 2, text: '主导完成 3 个资源池扩容。', promote: false, reason: '  强化动作动词，\n保留 3 个资源池事实  ' }],
              summary: '强化了动词表述。',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  assert.equal(items[0].reason, '强化动作动词， 保留 3 个资源池事实')
})

test('renderLocalResumePdf validates output artifact even when browser exits non-zero and rejects corrupt artifacts', async () => {
  const validPdf = Buffer.from(`%PDF-1.4\n%${'0'.repeat(90)}\n1 0 obj << /Type /Page >> endobj\n%%EOF\n`, 'latin1')
  assert.equal(isValidPdfBuffer(validPdf), true)
  assert.equal(isValidPdfBuffer(Buffer.from('not a pdf')), false)

  // Simulate Chrome writing a valid PDF and exiting with code 2
  const okResult = await renderLocalResumePdf({
    title: '测试',
    text: '# 林予安\n## 工作经历\n- 示例经历。\n',
    template: 'onyx',
    browserPath: process.execPath,
    runner: async (_cmd, args) => {
      const target = args.find(arg => arg.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length)
      await writeFile(target, validPdf)
      const err = new Error('exit 2')
      err.code = 2
      throw err
    },
  })
  assert.equal(okResult.pages, 1)
  assert.equal(okResult.pdf.equals(validPdf), true)

  // Simulate Chrome failing without producing a valid PDF -> concise user-facing error
  await assert.rejects(
    renderLocalResumePdf({
      title: '测试',
      text: '# 林予安\n## 工作经历\n- 示例经历。\n',
      template: 'onyx',
      browserPath: process.execPath,
      runner: async () => { throw new Error('crash') },
    }),
    /本地 PDF 导出未完成/,
  )
})

test('local templates use curated non-red default palettes, accept custom style, and parse conversational style directives', async () => {
  const onyx = await renderLocalResume({
    title: '测试',
    text: '# 林予安\n## 工作经历\n- 主导算力平台调度升级。\n',
    template: 'onyx',
  })
  assert.doesNotMatch(onyx.css, /#dc2626|220,\s*38,\s*38/i)
  assert.match(onyx.css, /#18181b/i)
  assert.match(onyx.css, /PingFang SC/)

  const custom = await renderLocalResume({
    title: '测试',
    text: '# 林予安\n## 工作经历\n- 主导算力平台调度升级。\n',
    template: 'chikorita',
    style: { accent: '#1e3a5f', font: 'serif', density: 'compact' },
  })
  assert.match(custom.css, /#1e3a5f/i)
  assert.match(custom.css, /Songti SC/)
  assert.equal(custom.style.density, 'compact')

  const pure = parseStyleDirective('换成藏青色，用衬线体，紧凑一点放进一页', localResumeTemplates)
  assert.equal(pure.matched, true)
  assert.equal(pure.pureStyle, true)
  assert.equal(pure.patch.accent, '#1e3a5f')
  assert.equal(pure.patch.font, 'serif')
  assert.equal(pure.patch.density, 'compact')

  const mixed = parseStyleDirective('换成墨绿，顺便把第一条经历精简一下', localResumeTemplates)
  assert.equal(mixed.matched, true)
  assert.equal(mixed.pureStyle, false)
  assert.equal(mixed.patch.accent, '#0f766e')

  const reset = parseStyleDirective('恢复默认样式', localResumeTemplates)
  assert.equal(reset.matched, true)
  assert.equal(reset.pureStyle, true)
  assert.equal(reset.patch.reset, true)

  assert.equal(accentToThumbFilter('#18181b'), 'saturate(0.06)')
  assert.match(accentToThumbFilter('#1e3a5f'), /^hue-rotate\(\d+deg\) saturate\(/)
})

test('streamResumeAgentTurn streams real tool calls (update_resume + update_appearance) and follows up with conversational summary', async () => {
  let callCount = 0
  const events = []
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream({ messages, tools }) {
      callCount++
      if (callCount === 1) {
        assert.equal(tools.length, 2)
        assert.equal(messages.at(-1).role, 'user')
        yield { type: 'reasoning-delta', index: 0, text: '分析用户补充的学历和利用率数据' }
        yield { type: 'tool-call-delta', index: 1, id: 'c1', name: 'update_resume', argumentsDelta: '{' }
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'c1',
            name: 'update_resume',
            arguments: JSON.stringify({
              markdown: '# 林予安\n## 工作经历\n- 将 GPU 资源池利用率从 42% 提升至 68%。\n## 教育背景\n- 复旦大学 · 软件工程本科（2019）',
              changes: [
                { kind: 'edit', summary: '补充 GPU 利用率 42%→68% 量化数据' },
                { kind: 'add', summary: '新增教育背景模块' },
              ],
            }),
          },
        }
        yield {
          type: 'block-end',
          index: 2,
          block: {
            type: 'tool-call',
            id: 'c2',
            name: 'update_appearance',
            arguments: JSON.stringify({ template: 'azurill', accent: '#1e3a5f', density: 'compact' }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { token: 'r1' } }
      } else {
        assert.equal(tools.length, 0)
        const assistantMsg = messages.find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool-call'))
        assert.ok(assistantMsg?.id)
        assert.equal(assistantMsg?.source?.kind, 'model')
        assert.deepEqual(assistantMsg?.source?.replayState, { token: 'r1' })
        const toolMsg = messages.find(m => m.role === 'tool' && m.toolCallId === 'c1')
        assert.ok(toolMsg?.id)
        assert.equal(toolMsg?.source?.kind, 'tool')
        assert.equal(toolMsg?.source?.callId, 'c1')
        yield { type: 'text-delta', index: 0, text: '已把复旦学历和 68% 利用率写进简历，并切换为藏青双栏紧凑排版。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }

  await streamResumeAgentTurn({
    llm,
    config: { model: 'mock:gpt', sendToModel: true },
    markdown: '# 林予安\n## 工作经历\n- 核对资源池。',
    template: 'onyx',
    style: { accent: '#18181b', font: 'sans', density: 'balanced' },
    message: '我 2019 复旦软工，GPU 利用率从 42% 提到 68%，帮我补进去并换双栏藏青紧凑版',
    history: [{ role: 'assistant', content: '可以告诉我学历和具体指标吗？' }],
    evidence: [{ title: '资源池', text: '优化调度策略' }],
    emit: ev => events.push(ev),
  })

  assert.equal(callCount, 2)
  const resumeEv = events.find(e => e.type === 'resume-update')
  const styleEv = events.find(e => e.type === 'appearance-update')
  const textCombined = events.filter(e => e.type === 'text').map(e => e.delta).join('')
  assert.match(resumeEv.markdown, /68%/)
  assert.match(resumeEv.markdown, /教育背景/)
  assert.equal(resumeEv.changes.length, 2)
  assert.equal(styleEv.template, 'azurill')
  assert.equal(styleEv.style.accent, '#1e3a5f')
  assert.equal(styleEv.style.density, 'compact')
  assert.match(textCombined, /藏青双栏/)
  assert.equal(events.at(-1).type, 'done')
})

test('streamResumeAgentTurn injects full attachedJob JD into system prompt and emits context status', async () => {
  let capturedSystem = ''
  const events = []
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream({ system }) {
      capturedSystem = system
      yield { type: 'text-delta', index: 0, text: '已对照小红书 JD 分析完成。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await streamResumeAgentTurn({
    llm,
    config: { model: 'mock:gpt', sendToModel: true },
    markdown: '# 林予安\n## 工作经历\n- 负责千卡 GPU 算力调度。',
    template: 'onyx',
    style: { accent: '#18181b', font: 'sans', density: 'balanced' },
    message: '按这份 JD 重排核心亮点，并标出差距',
    attachedJob: {
      id: 'job-xhs-1',
      company: '小红书',
      title: '大模型 Infra 产品运营',
      location: '上海',
      jd: '岗位职责：负责大模型训练与推理基础设施产品化运营，联动算力平台与算法研发制定 SLA 与资源治理指标。',
    },
    emit: ev => events.push(ev),
  })
  assert.match(capturedSystem, /本轮明确挂载的目标岗位 JD/)
  assert.match(capturedSystem, /大模型训练与推理基础设施产品化运营/)
  const statusEv = events.find(e => e.type === 'status')
  assert.ok(statusEv && /小红书 · 大模型 Infra 产品运营/.test(statusEv.text))
  assert.equal(events.at(-1).type, 'done')
})


test('predictNextPrompt skips blank input and uses the lowest reasoning effort for typed input', async () => {
  let chosenControls = null
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async prepareCall(route, _signal, adjust) {
      const info = { provider: route.provider, id: route.model, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
      chosenControls = adjust({ maxTokens: 4096 }, info)
      return {
        model: info,
        async *stream() {
          yield { type: 'text-delta', index: 0, text: '藏青双栏并紧凑放进一页' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }

  const next = await predictNextPrompt({
    llm,
    config: { model: 'mock:fast', sendToModel: true },
    surface: 'resume',
    prefix: '',
  })
  assert.equal(chosenControls, null)
  assert.deepEqual(next, { suggestion: '', suffix: '' })

  const mid = await predictNextPrompt({
    llm,
    config: { model: 'mock:fast', sendToModel: true },
    surface: 'resume',
    prefix: '帮我换成',
  })
  assert.equal(chosenControls?.reasoningEffort, 'low')
  assert.equal(chosenControls?.maxTokens, 96)
  assert.equal(mid.suggestion, '帮我换成藏青双栏并紧凑放进一页')
  assert.equal(mid.suffix, '藏青双栏并紧凑放进一页')
})

test('collectOpportunities falls back to lightweight Greenhouse listing when ?content=true exceeds 8 MB', async () => {
  const seen = []
  const huge = new Uint8Array(8 * 1024 * 1024 + 16)
  const result = await collectOpportunities(
    [{ provider: 'greenhouse', slug: 'anthropic', company: 'Anthropic' }],
    {
      fetchImpl: async url => {
        seen.push(url)
        if (url.includes('content=true')) {
          return new Response(huge, { headers: { 'content-type': 'application/json' } })
        }
        return Response.json({
          jobs: [{ id: 4242, title: 'Research Engineer, Infra', location: { name: 'San Francisco' } }],
        })
      },
    },
  )
  assert.deepEqual(seen, [
    'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true',
    'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs',
  ])
  assert.equal(result.results[0].status, 'ok')
  assert.equal(result.opportunities.length, 1)
  assert.equal(result.opportunities[0].url, 'https://job-boards.greenhouse.io/anthropic/jobs/4242')
})

test('personal-schedule matches NIUMA_* error codes strictly from stderr, never from osascript command argv', async () => {
  const runner = async () => {
    const err = new Error('Command failed: /usr/bin/osascript -e "...NIUMA_TARGET..."')
    err.stderr = 'execution error: Error: -1743 Not authorized to send Apple events.'
    throw err
  }
  await assert.rejects(
    listPersonalTargets('calendar', { runner, platform: 'darwin' }),
    /系统设置 → 隐私与安全性 → 自动化/,
  )
})

test('full closed-loop host pipeline: job-add -> tailor -> handoff -> receipt chain -> ics -> explicit manual debrief', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-loop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let handler
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ id: 'loop', name: 'Loop' }],
    async *stream({ system }) {
      let body
      if (system.includes('面试转写复盘')) {
        body = { questions: '问了 GPU 配额调度', feedback: '肯定跨团队交付', observations: '先讲结论再展开', next: '准备二面系统设计' }
      } else if (system.includes('生成沟通准备')) {
        body = { fit: '资源池治理高度匹配', gaps: '缺海外双活经验', message: '您好，附上简历期待交流', resume: '置顶资源池配额项目' }
      } else {
        body = { records: [] }
      }
      const text = JSON.stringify(body)
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const harness = createFetchHarness()
  const disposers = []
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    llm,
    logger: { warn() {} },
    get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'loop' }) } : undefined),
    emit() {},
    provide() {},
    on() {},
    effect(fn) { disposers.push(fn()) },
  })
  t.after(async () => { for (const d of disposers) await d?.() })

  async function call(path, payload) {
    const res = await harness.call(payload ? 'POST' : 'GET', path, payload)
    assert.equal(res.status, 200, `Unexpected HTTP ${res.status}: ${res.raw}`)
    return res.data
  }

  // 1. Import & approve resume
  const imported = (await call('/api/career-agent/action', {
    action: 'resume-import', title: '主简历', text: '# 林予安\n## 工作经历\n- 协同研发完成 3 个 GPU 资源池容量与配额核对。',
  })).result
  await call('/api/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })

  // 2. Add job (both with HTTPS URL and URL-less headhunter/referral external JD)
  const job = (await call('/api/career-agent/action', {
    action: 'job-add',
    job: { company: 'Linear', title: 'Senior Infra Engineer', location: 'Remote', url: 'https://jobs.ashbyhq.com/linear/abc', jd: 'Own GPU capacity and reliability' },
  })).result
  const referral = (await call('/api/career-agent/action', {
    action: 'job-add',
    job: { company: 'MiniMax', title: 'AI Infra Tech Lead', location: '上海', url: '', jd: '猎头微信转发 JD，无公开官网链接' },
  })).result
  assert.ok(referral.id.startsWith('manual:'))
  assert.equal(referral.url, '')

  // 3. Tailor preparation materials (works directly without flipping mode!)
  const draft = (await call('/api/career-agent/action', { action: 'tailor', id: job.id })).result
  assert.match(draft.fit, /资源池/)
  assert.match(draft.message, /简历/)

  // 4. Authorized handoff (never auto-submits)
  const handoff = (await call('/api/career-agent/action', { action: 'handoff', id: job.id })).result
  assert.equal(handoff.status, 'draft_only')
  assert.equal(handoff.url, 'https://jobs.ashbyhq.com/linear/abc')

  // 5. Receipt chain: submitted -> interview_confirmed -> .ics -> interview_completed -> offer_received
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: job.id, type: 'application_submitted', source: 'manual', confirmed: true, evidence: '官网提交回执', material: '主简历' },
  })
  const interview = (await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: {
      opportunityId: job.id, type: 'interview_confirmed', source: 'manual', confirmed: true,
      evidence: '邮件确认一面', round: '技术一面',
      startsAt: '2026-12-01T14:00:00+08:00', endsAt: '2026-12-01T15:00:00+08:00', location: 'Zoom',
    },
  })).result
  const ics = (await call('/api/career-agent/action', { action: 'calendar', id: interview.id })).result.text
  assert.match(ics, /BEGIN:VCALENDAR/)
  assert.match(ics, /技术一面/)

  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: job.id, type: 'interview_completed', source: 'manual', confirmed: true, evidence: '已完成一面', round: '技术一面' },
  })

  // 6. Explicit manual interview debrief works directly with user consent
  const note = (await call('/api/career-agent/action', {
    action: 'debrief',
    id: job.id,
    explicitManual: true,
    consent: true,
    round: '技术一面',
    text: '面试官问了我们 3 个 GPU 资源池如何做配额隔离和告警降噪。',
    sourceRef: '本人面试笔记',
  })).result
  assert.match(note.questions, /GPU/)
  assert.match(note.next, /系统设计/)

  // 7. Advance to Offer & inspect state projection
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: {
      opportunityId: job.id, type: 'offer_received', source: 'manual', confirmed: true,
      evidence: '正式书面 Offer 邮件', form: 'written', replyBy: '2026-12-10T18:00:00+08:00',
    },
  })
  const state = await call('/api/career-agent/state')
  const savedJob = state.opportunities.find(o => o.id === job.id)
  assert.equal(savedJob.stage, 'offer_received')
  assert.equal(savedJob.receipts.length, 4)
  assert.equal(savedJob.interviewNotes.length, 1)
})

test('reviseResume autoSaved + inPlace updates a single pending autosave draft without mutating approved parent or spamming versions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-autosave-'))
  try {
    const store = new CareerStore({ file: join(dir, 'career.json') })
    const base = await store.importResume({ title: '主简历', text: '# 林予安\n## 工作经历\n- 原版内容。\n' })
    await store.reviewResume(base.id, { action: 'approve' })

    // First auto-save off an approved version creates ONE new pending autosave draft
    const first = await store.reviseResume(base.id, {
      text: '# 林予安\n## 工作经历\n- AI 改写第一版。\n',
      autoSaved: true,
      inPlace: false,
      variant: 'conversation',
    })
    assert.notEqual(first.id, base.id)
    assert.equal(first.status, 'pending')
    assert.equal(first.autoSaved, true)
    assert.equal(first.variant, 'conversation')

    // Second in-place auto-save updates the SAME pending autosave draft instead of creating a 3rd version
    const second = await store.reviseResume(first.id, {
      text: '# 林予安\n## 工作经历\n- AI 改写第二版（继续微调）。\n',
      autoSaved: true,
      inPlace: true,
    })
    assert.equal(second.id, first.id)
    assert.match(second.text, /继续微调/)

    const summary = await store.summary()
    assert.equal(summary.resumes.length, 2)
    assert.match(summary.resumes[0].text, /原版内容/)
    assert.match(summary.resumes[1].text, /继续微调/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('updateEvidence edits and clears optional fields in place, and deleteEvidence / deleteReflection remove items cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-ev-crud-'))
  try {
    const store = new CareerStore({ file: join(dir, 'career.json') })
    await store.setMode('observe')
    await store.authorizeSource({ id: 'manual', projects: ['personal'] })
    const ingested = await store.ingestEvents([{
      id: 'ev-1', sourceId: 'manual', projectId: 'personal', kind: 'manual',
      occurredAt: '2026-11-20T04:00:00.000Z',
      evidence: [{ title: 'GPU 调度优化', text: '提升了算力利用率。', role: '负责人', impact: '节省 100 万' }],
    }], { explicitManual: true })
    const id = ingested.evidence[0].id

    const updated = await store.updateEvidence(id, {
      title: '千卡级 GPU 调度优化',
      text: '利用率从 41% 提至 69%。',
      role: 'Tech Lead',
      impact: '',
      shareable: true,
    })
    assert.equal(updated.title, '千卡级 GPU 调度优化')
    assert.equal(updated.impact, undefined)
    assert.equal(updated.status, 'approved')
    assert.equal(updated.shareable, true)

    await store.deleteEvidence(id)
    assert.equal((await store.summary()).evidence.length, 0)

    await store.setPreferences({ allowReflections: true })
    const ref = await store.recordReflection({
      id: 'ref-1', occurredAt: '2026-11-20T04:00:00.000Z',
      dimension: 'growth', severity: 'neutral', text: '想更深入大模型推理引擎。',
    }, { explicitManual: true })
    assert.equal((await store.summary()).reflections.length, 1)
    await store.deleteReflection(ref.id)
    assert.equal((await store.summary()).reflections.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tailor tolerates structured array/object fit & gaps from real LLMs and reports live streaming activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-tailor-array-'))
  try {
    const harness = createFetchHarness()
    let disposeHost = null
    const ctx = {
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ session: {}, events: [] }) },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'pro', name: 'Mock Pro' }],
        async *stream() {
          const payload = JSON.stringify({
            fit: ['具备千卡 GPU 调度实战经验', '有高并发推理网关 P99 优化成果'],
            gaps: { summary: '暂缺海外合规审计记录', items: ['需核实多区异地双活经验'] },
            message: '您好，附上针对该岗位整理的简历，期待交流。',
            resume: ['千卡 GPU 调度优化', '高并发 LLM 推理网关'],
          })
          yield { type: 'reasoning-delta', index: 0, text: '先比对简历与 JD 的核心算力调度指标。' }
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: payload.slice(0, 40) }
          yield { type: 'text-delta', index: 0, text: payload.slice(40) }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'pro' }) } : null),
      emit: () => {},
      on: () => () => {},
      provide: () => {},
      logger: { warn: () => {} },
      effect: fn => { disposeHost = fn() },
    }
    const { apply } = await import('../src/host.mjs')
    await apply(ctx)

    const call = (method, url, body) => harness.call(method, url, body)

    const imp = await call('POST', '/api/career-agent/action', {
      action: 'resume-import', title: '基础简历', text: '# 林予安\n## 工作经历\n- 负责千卡 GPU 调度。\n',
    })
    assert.equal(imp.status, 200)
    await call('POST', '/api/career-agent/action', { action: 'resume-review', id: imp.data.result.id, decision: 'approve' })
    const added = await call('POST', '/api/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra', jd: '负责大模型集群 GPU 调度与推理网关建设。' },
    })
    const opId = '11111111-2222-4333-8444-555555555555'
    const tailored = await call('POST', '/api/career-agent/action', {
      action: 'tailor', id: added.data.result.id, operationId: opId,
    })
    assert.equal(tailored.status, 200)
    assert.equal(tailored.data.ok, true)
    assert.match(tailored.data.result.fit, /千卡 GPU 调度/)
    assert.match(tailored.data.result.gaps, /海外合规审计/)
    assert.match(tailored.data.result.resume, /高并发 LLM 推理网关/)

    const actRes = await call('GET', `/api/career-agent/resume-activity?id=${opId}`)
    assert.equal(actRes.data.phase, 'ready')
    assert.equal(actRes.data.model, 'pro')
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('modelJson repairs unescaped newlines & trailing commas and surfaces exact failure reasons', async () => {
  const { modelJson } = await import('../src/watch.mjs')
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    async *stream() {
      const messy = '```json\n{"fit":"第一点：GPU 调度\n第二点：高并发网关","gaps":"暂缺双活经验",}\n```'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: messy }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: messy } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const parsed = await modelJson(llm, { model: 'mock:pro', sendToModel: true }, 'sys', { x: 1 })
  assert.match(parsed.fit, /第一点：GPU 调度\n第二点：高并发网关/)
  assert.equal(parsed.gaps, '暂缺双活经验')

  const failingLlm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limit 429', code: 'RATE_LIMIT' } } }
    },
  }
  await assert.rejects(
    () => modelJson(failingLlm, { model: 'mock:pro', sendToModel: true }, 'sys', { x: 1 }),
    /rate limit 429/,
  )
})

test('receipt deduplicates singular milestones (started) and supports conversational receipt_reset recovery', async () => {
  const { apply } = await import('../src/host.mjs')
  const { proposeIntake } = await import('../src/intake.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'career-reset-'))
  let routeHandler = null
  let disposeHost = null
  const mockLlm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ id: 'pro', name: 'Pro' }],
    async *stream() {
      const payload = JSON.stringify({
        kind: 'receipt_reset',
        summary: '删除全部「已入职」记录，恢复到之前的状态',
        data: { action: 'remove_type', targetType: 'started' },
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  try {
    const harness = createFetchHarness()
    const ctx = {
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
      llm: mockLlm,
      provide: () => {},
      get: () => null,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      on: () => {},
      effect: fn => { disposeHost = fn() },
    }
    await apply(ctx)
    const call = (method, url, body) => harness.call(method, url, body)

    const added = await call('POST', '/api/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra Seed Model' },
    })
    const jobId = added.data.result.id
    // Submit + mark started twice -> backend must deduplicate started!
    await call('POST', '/api/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'application_submitted', source: 'manual', confirmed: true, material: '通用简历', evidence: '官网投递' },
    })
    await call('POST', '/api/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'started', source: 'manual', confirmed: true, evidence: '误点已入职 1' },
    })
    await call('POST', '/api/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'started', source: 'manual', confirmed: true, evidence: '误点已入职 2' },
    })
    let state = (await call('GET', '/api/career-agent/state')).data
    let job = state.opportunities.find(o => o.id === jobId)
    assert.equal(job.stage, 'started')
    assert.equal(job.receipts.filter(r => r.type === 'started').length, 1, 'started must not duplicate')

    // Direct conversational proposeIntake auto-binds single opportunityId
    const directProp = await proposeIntake({
      llm: mockLlm, config: { model: 'mock:pro', sendToModel: true },
      text: '点错了，其实没入职，帮我撤掉已入职',
      context: { opportunities: [{ id: jobId, title: job.title, company: job.company, stage: job.stage }] },
    })
    assert.equal(directProp.kind, 'receipt_reset')
    assert.equal(directProp.data.opportunityId, jobId)
    assert.equal(directProp.data.action, 'remove_type')
    assert.equal(directProp.data.targetType, 'started')

    // Full host draft-intake -> accept-intake rolls back cleanly from started -> submitted!
    const drafted = await call('POST', '/api/career-agent/action', {
      action: 'draft-intake', opportunityId: jobId, model: 'mock:pro', text: '点错了，帮我撤掉已入职',
    })
    assert.equal(drafted.status, 200)
    const accepted = await call('POST', '/api/career-agent/action', {
      action: 'accept-intake', id: drafted.data.result.id,
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.data.result.removedCount, 1)
    assert.equal(accepted.data.result.stage, 'submitted')

    // Clear all -> restores discovered!
    const cleared = await call('POST', '/api/career-agent/action', {
      action: 'receipt-reset', opportunityId: jobId, mode: 'clear_all',
    })
    assert.equal(cleared.data.result.stage, 'discovered')
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function bootMockHost(dir, mockLlm) {
  const { apply } = await import('../src/host.mjs')
  const harness = createFetchHarness()
  let disposeHost = null
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
    llm: mockLlm,
    provide: () => {},
    get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'fast' }) } : null),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: () => {},
    effect: fn => { disposeHost = fn() },
  }
  await apply(ctx)
  const call = (method, url, body) => harness.call(method, url, body)
  return { call, disposeHost }
}

test('draft-intake prioritizes selectedOpportunityIds and validates optional followUp inquiry fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-career-followup-'))
  try {
    let seenPayload = null
    const mockLlm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'pro', name: 'Pro' }],
      async *stream(options) {
        seenPayload = JSON.parse(options.messages.at(-1).content[0].text)
        const selected = seenPayload.selectedOpportunityIds || []
        const reply = JSON.stringify({
          kind: 'compare',
          summary: '初步对比完成，补充薪资可做最终决策',
          data: {
            title: 'Offer 横向甄别',
            recommendation: '从阶段与匹配度看 A 领先，但缺少两家薪资总包。',
            items: selected.map((id, idx) => ({
              opportunityId: id,
              verdict: idx === 0 ? '确定性最高' : '成长空间大',
              pros: '核心方向契合',
              cons: '待确认包裹',
              fitScore: 92 - idx * 5,
            })),
            followUp: {
              title: '补充 Offer 薪资与取舍权重',
              reason: '薪资总包会直接决定性价比排序',
              fields: [
                { id: 'comp_a', opportunityId: selected[0], label: 'Linear Offer 薪资', placeholder: '如 60w', options: ['与预期持平', '超预期'] },
                { id: 'comp_b', opportunityId: 'nonexistent-id', label: '字节薪资', options: ['暂未谈薪'] },
                { id: 'empty_label', label: '   ' },
              ],
            },
          },
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const { call, disposeHost } = await bootMockHost(dir, mockLlm)
    const j1 = (await call('POST', '/api/career-agent/action', {
      action: 'job-add', job: { company: 'Linear', title: 'Staff Applied AI', jd: 'Build AI workflows and distributed infra.' },
    })).data.result
    const j2 = (await call('POST', '/api/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra Seed Model', jd: 'Large-scale GPU cluster scheduling.' },
    })).data.result
    await call('POST', '/api/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: j1.id, type: 'offer_received', form: 'written', source: 'manual', confirmed: true, evidence: '书面 Offer', notes: '含远程弹性' },
    })
    const res = await call('POST', '/api/career-agent/action', {
      action: 'draft-intake',
      model: 'mock:pro',
      selectedOpportunityIds: [j1.id, j2.id],
      text: '帮我甄别这两个岗位',
    })
    assert.equal(res.status, 200)
    assert.equal(res.data.result.ephemeral, true)
    assert.equal(res.data.result.kind, 'compare')
    assert.deepEqual(seenPayload.selectedOpportunityIds, [j1.id, j2.id])
    assert.equal(seenPayload.opportunities[0].selected, true)
    assert.equal(seenPayload.opportunities[0].receipts[0].notes, '含远程弹性')
    const followUp = res.data.result.data.followUp
    assert.equal(followUp.title, '补充 Offer 薪资与取舍权重')
    assert.equal(followUp.fields.length, 2, 'drops blank-label fields')
    assert.equal(followUp.fields[0].opportunityId, j1.id)
    assert.equal(followUp.fields[1].opportunityId, undefined, 'strips unknown opportunityId')
    assert.deepEqual(followUp.fields[0].options, ['与预期持平', '超预期'])
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resume-rebase runs outside exclusive lock with live operationId activity tracking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-career-rebase-op-'))
  try {
    const mockLlm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'pro', name: 'Pro' }],
      async *stream(options) {
        const sys = String(options.system || '')
        const payload = JSON.parse(options.messages.at(-1).content[0].text)
        let reply
        if (sys.includes('岗位定制')) {
          const bullets = payload.bullets ?? []
          reply = JSON.stringify({
            lines: bullets.slice(0, 1).map(b => ({ index: b.index, text: `${b.original.replace(/^-\s*/, '')}（腾讯 Agent Infra 定制）`, reason: '对齐岗位要求' })),
            gaps: '',
          })
        } else {
          const baseMd = String(payload.branchMarkdown || '')
          const added = (payload.newMasterBullets || []).map(b => `- ${b}`).join('\n')
          reply = JSON.stringify({
            markdown: `${baseMd}\n${added}\n`,
            summary: '已同步主干新增成果并保留本岗定制',
            placements: [{ section: '工作经历', bullet: '千卡 GPU 调度提效', reason: '同步主干新版亮点' }],
          })
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const { call, disposeHost } = await bootMockHost(dir, mockLlm)
    const imported = (await call('POST', '/api/career-agent/action', {
      action: 'resume-import', title: '默认主干', text: '# 张三\n\n## 工作经历\n- 负责分布式调度平台建设\n',
    })).data.result
    await call('POST', '/api/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })
    const job = (await call('POST', '/api/career-agent/action', {
      action: 'job-add', job: { company: '腾讯', title: 'Agent Infra', jd: 'Agent sandbox & GPU scheduling' },
    })).data.result
    const tailored = (await call('POST', '/api/career-agent/action', {
      action: 'tailor-resume', id: job.id, resumeId: imported.id, model: 'mock:pro',
    })).data.result
    await call('POST', '/api/career-agent/action', { action: 'resume-review', id: tailored.id, decision: 'approve' })
    const masterV2 = (await call('POST', '/api/career-agent/action', {
      action: 'resume-revise', id: imported.id,
      text: '# 张三\n\n## 工作经历\n- 负责分布式调度平台建设\n- 主导千卡 GPU 调度治理，利用率提升 28%\n', approve: true,
    })).data.result
    assert.ok(masterV2.id)

    const opId = '11111111-2222-4333-8444-555555555555'
    const rebased = await call('POST', '/api/career-agent/action', {
      action: 'resume-rebase', id: tailored.id, model: 'mock:pro', operationId: opId,
    })
    assert.equal(rebased.status, 200, JSON.stringify(rebased.data))
    assert.equal(rebased.data.result.origin, 'rebase')
    assert.equal(rebased.data.result.baseId, masterV2.id)
    const activity = await call('GET', `/api/career-agent/resume-activity?id=${opId}`)
    assert.equal(activity.status, 200)
    assert.equal(activity.data.phase, 'ready')
    assert.equal(activity.data.kind, 'resume-rebase')
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reasoningEffort: /models exposes resolveModel efforts, configure persists, and modelJson/resume-chat honor selected effort via prepareCall', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'career-reasoning-'))
  try {
    const seenEfforts = []
    const modelInfo = {
      provider: 'deepseek-official',
      id: 'deepseek-v3',
      name: 'DeepSeek V3',
      maxOutputTokens: 16384,
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    }
    const mockLlm = {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v3', name: 'DeepSeek V3' }],
      resolveModelInfo: async () => modelInfo,
      prepareCall: async (_route, _signal, adjust) => {
        const controls = adjust({ reasoningEffort: 'high', maxTokens: 4096 }, modelInfo)
        seenEfforts.push(controls.reasoningEffort)
        return {
          stream: async function* () {
            const reply = JSON.stringify({ verdict: '契合度高', highlights: ['核心匹配'], risks: [], diligence: [] })
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: reply }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
      async *stream() {
        throw new Error('should use prepareCall when available')
      },
    }
    const { call, disposeHost } = await bootMockHost(dir, mockLlm)
    const modelsRes = await call('GET', '/api/career-agent/models')
    assert.equal(modelsRes.status, 200)
    assert.equal(modelsRes.data[0].reasoning?.efforts?.length, 4)
    assert.equal(modelsRes.data[0].reasoning?.defaultEffort, 'high')

    const cfgRes = await call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: { model: 'deepseek-official:deepseek-v3', reasoningEffort: 'max', tabReasoningEffort: 'low' },
    })
    assert.equal(cfgRes.status, 200)
    const st = await call('GET', '/api/career-agent/state')
    assert.equal(st.data.config.reasoningEffort, 'max')
    assert.equal(st.data.config.tabReasoningEffort, 'low')

    const job = (await call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'DeepSeek', title: 'Infra Engineer', jd: 'Build high-throughput inference clusters and GPU scheduling systems.' },
    })).data.result
    const intelRes = await call('POST', '/api/career-agent/action', { action: 'job-intel', id: job.id })
    assert.equal(intelRes.status, 200)
    assert.equal(seenEfforts[0], 'max')

    // Stream resume agent turn also honors selected reasoningEffort via prepareCall
    const chatEvents = []
    await streamResumeAgentTurn({
      llm: mockLlm,
      config: { model: 'deepseek-official:deepseek-v3', reasoningEffort: 'off' },
      markdown: '# Alex\n\n## Experience\n- Built distributed systems',
      message: 'Review my resume',
      emit: ev => chatEvents.push(ev),
    })
    assert.equal(seenEfforts[1], 'off')

    // predictNextPrompt honors explicit tabReasoningEffort and falls back to cheapest ('off') when unset
    await predictNextPrompt({
      llm: mockLlm,
      config: { model: 'deepseek-official:deepseek-v3', sendToModel: true, tabReasoningEffort: 'low' },
      surface: 'resume',
      prefix: '帮我看看',
    })
    assert.equal(seenEfforts[2], 'low')
    await predictNextPrompt({
      llm: mockLlm,
      config: { model: 'deepseek-official:deepseek-v3', sendToModel: true, tabReasoningEffort: '' },
      surface: 'resume',
      prefix: '帮我看看',
    })
    assert.equal(seenEfforts[3], 'off')
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('automatic Tab suggestions honor tabAutocomplete toggle (default ON, independent of sendToModel) while explicit AI actions still work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-fg-ai-'))
  try {
    let llmCalls = 0
    let tabPrompt = ''
    const mockLlm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      resolveModelInfo: async () => ({ provider: 'mock', id: 'fast', name: 'Fast' }),
      prepareCall: async () => ({
        stream: async function* ({ system, messages }) {
          llmCalls += 1
          const sys = String(system || '')
          let text = '{"directions":[{"label":"AI Infra","query":"AI Infra 推理引擎","basis":"基于你的背景"}],"keywords":["vLLM","CUDA"]}'
          if (sys.includes('triage') || sys.includes('scores') || sys.includes('fitScore') || sys.includes('评分')) {
            text = JSON.stringify({ scores: [{ id: 'job-1', score: 86, reason: 'Strong GPU infra fit' }] })
          } else if (sys.includes('输入自动补全引擎')) {
            tabPrompt = messages[0].content[0].text
            text = '把项目经历量化成延迟和吞吐指标'
          }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
      stream: async function* () { throw new Error('expected prepareCall') },
    }
    const { call, disposeHost } = await bootMockHost(dir, mockLlm)

    // Fresh default config: mode=off, sendToModel=false, tabAutocomplete=true
    const st = await call('GET', '/api/career-agent/state')
    assert.equal(st.data.config.sendToModel, false)
    assert.equal(st.data.config.tabAutocomplete, true)

    const suggest = body => call('POST', '/api/career-agent/suggest', {
      surface: 'resume', markdown: 'PRIVATE_DRAFT', explicitInteractive: true, ...body,
    })

    // Empty / whitespace input triggers 0 calls even when tabAutocomplete=true
    const blankDefault = await suggest({ prefix: '  ' })
    assert.equal(blankDefault.status, 200)
    assert.deepEqual(blankDefault.data, { ok: true, suggestion: '', suffix: '' })
    assert.equal(llmCalls, 0)

    const chat = await call('POST', '/api/career-agent/resume-chat', {
      model: 'mock:fast', message: 'Review this sample resume', markdown: '# QA fixture',
    })
    assert.equal(chat.status, 200)
    const events = chat.raw.trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.type === 'text'))
    assert.ok(events.some(event => event.type === 'done'))
    assert.equal(llmCalls, 1)

    const dirs = await call('POST', '/api/career-agent/suggest-directions', {
      goal: 'AI Infra Engineer', explicitInteractive: true,
    })
    assert.equal(dirs.status, 200)
    assert.ok(dirs.data.result.directions.length > 0, 'interactive suggest-directions must run when explicitInteractive=true')
    assert.ok(llmCalls > 1)

    const beforeTriage = llmCalls
    const selected = await call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: {
        company: 'Acme', title: 'AI Infra Engineer',
        jd: 'Build vLLM and CUDA inference serving systems at scale. ' + 'A'.repeat(480) + 'LONG_JD_TAIL',
      },
    })
    const blockedForce = await call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true })
    assert.equal(blockedForce.data.result.requiresConfirmation, true)
    assert.equal(llmCalls, beforeTriage, 'unconfirmed force=true must not bypass sendToModel=false')
    const triPreview = await call('POST', '/api/career-agent/action', { action: 'triage-preview' })
    assert.equal(triPreview.status, 200)
    assert.equal(triPreview.data.result.count, 1)
    assert.ok(triPreview.data.result.confirmToken)
    assert.equal(llmCalls, beforeTriage, 'triage-preview itself must make 0 LLM calls')
    const tri = await call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      confirmed: true,
      confirmToken: triPreview.data.result.confirmToken,
    })
    assert.equal(tri.status, 200)
    assert.ok(llmCalls > beforeTriage, 'confirmed manual triage-jobs must use LLM even when background sendToModel=false')

    await call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Other Company', title: 'Other role', jd: 'UNSELECTED_JD' },
    })

    // Default tabAutocomplete=true allows typed Tab completion even when background sendToModel=false
    const beforeTab = llmCalls
    const typed = await suggest({ prefix: '帮我', opportunityId: selected.data.result.id })
    assert.equal(typed.status, 200)
    assert.equal(typed.data.suggestion, '帮我把项目经历量化成延迟和吞吐指标')
    assert.equal(llmCalls, beforeTab + 1)
    assert.match(tabPrompt, /Acme[^\n]+AI Infra Engineer/)
    assert.match(tabPrompt, /Build vLLM and CUDA inference/)
    assert.doesNotMatch(tabPrompt, /PRIVATE_DRAFT|UNSELECTED_JD|Other Company|LONG_JD_TAIL/)

    // Turning tabAutocomplete=false blocks Tab completion even if background sendToModel=true
    await call('POST', '/api/career-agent/action', { action: 'configure', config: { sendToModel: true, tabAutocomplete: false } })
    const blocked = await suggest({ prefix: '帮我', opportunityId: selected.data.result.id })
    assert.equal(blocked.status, 200)
    assert.deepEqual(blocked.data, { ok: true, suggestion: '', suffix: '' })
    assert.equal(llmCalls, beforeTab + 1)

    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Tab does not send the prompt when tabAutocomplete is disabled during model lookup', { timeout: 4000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-tab-consent-'))
  const lookupStarted = Promise.withResolvers()
  const models = Promise.withResolvers()
  let modelCalls = 0
  const { call, disposeHost } = await bootMockHost(dir, {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: async () => [{ id: 'fast', name: 'Fast' }],
    async prepareCall() {
      lookupStarted.resolve()
      await models.promise
      return {
        config: { provider: 'mock', model: 'fast' },
        async *stream() {
          modelCalls += 1
          yield { type: 'text-delta', text: '这段经历可以怎么改' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    async *stream() {
      modelCalls += 1
      yield { type: 'text-delta', text: '这段经历可以怎么改' }
    },
  })
  t.after(async () => {
    models.resolve([])
    await disposeHost?.()
    await rm(dir, { recursive: true, force: true })
  })
  const configure = tabAutocomplete => call('POST', '/api/career-agent/action', {
    action: 'configure', config: { tabAutocomplete },
  })
  assert.equal((await configure(true)).status, 200)
  const suggestion = call('POST', '/api/career-agent/suggest', { surface: 'resume', prefix: '帮我看看' })
  assert.equal(await Promise.race([lookupStarted.promise.then(() => true), suggestion.then(() => false)]), true)
  assert.equal((await configure(false)).status, 200)
  models.resolve([{ id: 'fast', name: 'Fast' }])
  const result = await suggestion
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { ok: true, suggestion: '', suffix: '' })
  assert.equal(modelCalls, 0)
})

test('client Tab suggest inputs gate on tabAutocomplete, strip markdown/history, and keep manual draft-intake working', async () => {
  const { readFile } = await import('node:fs/promises')
  const ghostSrc = await readFile(new URL('../client/GhostInput.jsx', import.meta.url), 'utf8')
  const resumeAgentSrc = await readFile(new URL('../client/ResumeAgent.jsx', import.meta.url), 'utf8')
  const composerSrc = await readFile(new URL('../client/Composer.jsx', import.meta.url), 'utf8')
  const jobDetailSrc = await readFile(new URL('../client/JobDetailSheet.jsx', import.meta.url), 'utf8')
  const sourcesSrc = await readFile(new URL('../client/Sources.jsx', import.meta.url), 'utf8')

  assert.equal(ghostSrc.includes('explicitInteractive'), false)
  assert.equal(/\bmarkdown\s*[:=]/.test(ghostSrc), false)
  assert.match(ghostSrc, /if \(!focused \|\| !suggestEnabled \|\| composing \|\| composingRef\.current \|\| !value\.trim\(\)\)/)
  assert.match(ghostSrc, /fallbackSuggestion && tabEnabled/)
  assert.match(ghostSrc, /onBlur=\{\(\) =>/)
  assert.match(resumeAgentSrc, /allowTabSuggest = config\?\.tabAutocomplete !== false/)
  const resumeSuggestBlock = resumeAgentSrc.slice(
    resumeAgentSrc.indexOf('const suggestContext = React.useMemo'),
    resumeAgentSrc.indexOf('const fallbackHint = React.useMemo'),
  )
  assert.equal(/\bmarkdown\b/.test(resumeSuggestBlock), false)
  assert.equal(/\bhistory\b/.test(resumeSuggestBlock), false)
  assert.match(composerSrc, /allowTabSuggest = config\?\.tabAutocomplete !== false/)
  const composerSuggestBlock = composerSrc.slice(
    composerSrc.indexOf('const suggestContext = React.useMemo'),
    composerSrc.indexOf('const fallbackHint = replying'),
  )
  assert.equal(/\bhistory\b/.test(composerSuggestBlock), false)
  assert.match(ghostSrc, /surface === 'jd-study' && Array\.isArray\(suggestContext\.history\)/)
  assert.match(jobDetailSrc, /allowStudySuggest = state\.config\?\.tabAutocomplete !== false/)
  assert.match(sourcesSrc, /tabAutocompleteOn = config\.tabAutocomplete !== false/)
  assert.match(sourcesSrc, /onToggleTabAutocomplete/)

  const dir = await mkdtemp(join(tmpdir(), 'niuma-tab-manual-send-'))
  let disposeHost = null
  try {
    let modelCalls = 0
    const seenSuggestPrompts = []
    const harness = createFetchHarness()
    await apply({
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'fast', name: 'Fast' }],
        async *stream(options) {
          modelCalls += 1
          if (String(options?.system || '').includes('输入自动补全引擎')) {
            seenSuggestPrompts.push(options.messages[0].content[0].text)
            yield { type: 'text-delta', text: '这段表述再精简一下' }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              kind: 'answer',
              summary: '已整理候选回答思路',
              data: { answer: '可从延迟与吞吐双指标拆解。' },
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      provide: () => {},
      get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'fast' }) } : null),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      on: () => {},
      effect: fn => { disposeHost = fn() },
    })
    const state = await harness.call('GET', '/api/career-agent/state')
    assert.equal(state.data.config.sendToModel, false)
    assert.equal(state.data.config.tabAutocomplete, true)

    await harness.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: { tabAutocomplete: false },
    })
    const manualDraft = await harness.call('POST', '/api/career-agent/action', {
      action: 'draft-intake',
      model: 'mock:fast',
      text: '总结下可能问的技术问题',
    })
    assert.equal(manualDraft.status, 200)
    assert.equal(manualDraft.data.result.kind, 'answer')
    assert.equal(modelCalls, 1)

    await harness.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: { tabAutocomplete: true },
    })
    const added = await harness.call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Acme', title: 'AI Infra', jd: 'Build vLLM inference serving.' },
    })
    const oppId = added.data.result.id

    // Resume & Jobs Tab never include assistant history; jd-study keeps history only when scoped to a non-empty topic
    await harness.call('POST', '/api/career-agent/suggest', {
      surface: 'resume',
      prefix: '帮我把',
      history: [{ role: 'assistant', content: 'ASSISTANT_DRAFT_QUOTE' }],
    })
    await harness.call('POST', '/api/career-agent/suggest', {
      surface: 'jobs',
      prefix: '对比',
      opportunityId: oppId,
      history: [{ role: 'assistant', content: 'PRIOR_JOB_HISTORY_LEAK' }],
    })
    await harness.call('POST', '/api/career-agent/suggest', {
      surface: 'jd-study',
      topic: '',
      opportunityId: oppId,
      prefix: '请问',
      history: [{ role: 'assistant', content: 'UNSCOPED_STUDY_REPLY' }],
    })
    await harness.call('POST', '/api/career-agent/suggest', {
      surface: 'jd-study',
      topic: 'vLLM',
      opportunityId: oppId,
      prefix: '请问',
      history: [{ role: 'assistant', content: 'KV_CACHE_STUDY_REPLY' }],
    })

    assert.equal(seenSuggestPrompts.length, 4)
    assert.doesNotMatch(seenSuggestPrompts[0], /ASSISTANT_DRAFT_QUOTE|上一轮回复/)
    assert.doesNotMatch(seenSuggestPrompts[1], /PRIOR_JOB_HISTORY_LEAK|上一轮回复/)
    assert.match(seenSuggestPrompts[1], /Acme · AI Infra/)
    assert.doesNotMatch(seenSuggestPrompts[2], /UNSCOPED_STUDY_REPLY|上一轮回复/)
    assert.match(seenSuggestPrompts[3], /KV_CACHE_STUDY_REPLY/)
  } finally {
    await disposeHost?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('fetchCompanyLogo prioritizes direct domain (no google favicon), uses manual redirects, and blocks SSRF targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-logo-sec-'))
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
  try {
    // 1. SSRF redirect to 127.0.0.1 is blocked and Google is never contacted
    const seenUrls = []
    const blocked = await fetchCompanyLogo('evil-ssrf-test.example', dir, {
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'manual')
        seenUrls.push(url)
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret.png' } })
      },
    })
    assert.equal(blocked, null)
    assert.equal(seenUrls.some(u => u.includes('google.com')), false, 'must not send company domain to google.com')
    assert.equal(seenUrls.some(u => u.includes('127.0.0.1')), false, 'must never follow redirect to loopback')

    // 2. Direct domain succeeds on first hop without third-party proxy
    const okUrls = []
    const hit = await fetchCompanyLogo('safe-direct-test.example', dir, {
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'manual')
        okUrls.push(url)
        return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
      },
    })
    assert.ok(hit && hit.contentType === 'image/png')
    assert.equal(okUrls[0], 'https://safe-direct-test.example/apple-touch-icon.png')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F03 regression: Panel calls all running-indicator Hooks unconditionally without short-circuit operators', async () => {
  const { readFile } = await import('node:fs/promises')
  const indexSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  const panelBlock = indexSrc.slice(
    indexSrc.indexOf('function Panel('),
    indexSrc.indexOf('const runningTabs ='),
  )
  assert.doesNotMatch(panelBlock, /(\|\||&&)\s*use[A-Z]/)
  for (const op of ['tailor-resume', 'resume-rebase', 'job-intel', 'tailor', 'jd-probe', 'discover-companies', 'market-insight']) {
    assert.ok(panelBlock.includes(`useHasTrackedOperation('${op}'`), `missing unconditional hook for ${op}`)
  }
  assert.ok(panelBlock.includes('useHasResumeChatStreaming()'))
  assert.ok(panelBlock.includes("useHasRunningComposer('jobs')"))
})

test('F05 regression: legacy upgraded profiles preserve sendToModel=false as tabAutocomplete=false while preserving true', async () => {
  for (const legacySendToModel of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), `niuma-legacy-${legacySendToModel ? 'on' : 'off'}-`))
    let disposeHost = null
    try {
      await mkdir(join(dir, 'career-broker'), { recursive: true })
      await writeFile(join(dir, 'career-broker', 'watchdog.json'), JSON.stringify({
        version: 1,
        config: {
          intervalMinutes: 360,
          historyDays: 30,
          sendToModel: legacySendToModel,
          watchSessions: true,
          autoJobIntel: false,
          model: '',
          boards: [],
        },
        cursors: {},
        opportunities: [],
        receipts: [],
        drafts: [],
        watch: { lastRun: null, nextRun: null, lastError: null, results: [] },
      }))

      let modelCalls = 0
      const harness = createFetchHarness()
      await apply({
        profileContext: { dir },
        connection: harness.connection,
        sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
        llm: {
          listProviders: () => [{ id: 'mock', name: 'Mock' }],
          listModels: async () => [{ id: 'fast', name: 'Fast' }],
          async *stream() {
            modelCalls += 1
            yield { type: 'text-delta', text: '把项目量化一下' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
        provide: () => {},
        get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'fast' }) } : null),
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        on: () => {},
        effect: fn => { disposeHost = fn() },
      })

      const state = await harness.call('GET', '/api/career-agent/state')
      assert.equal(state.status, 200)
      assert.equal(state.data.config.tabAutocomplete, legacySendToModel)
      const suggest = await harness.call('POST', '/api/career-agent/suggest', {
        surface: 'resume',
        prefix: '帮我修改',
      })
      assert.equal(suggest.status, 200)
      assert.equal(modelCalls, legacySendToModel ? 1 : 0)
    } finally {
      await disposeHost?.()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('F05 regression: real GhostInput blocks /suggest on prefill/restored edits (including head+tail tweaks & IME cancel) until cleared, and Sources renders subtle info tip', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const esbuild = await import('esbuild')
  const { setTimeout: wait } = await import('node:timers/promises')

  const sourcesSrc = await readFile(new URL('../client/Sources.jsx', import.meta.url), 'utf8')
  const tabRowSlice = sourcesSrc.slice(
    sourcesSrc.indexOf("t('sources.tabModelTitle')"),
    sourcesSrc.indexOf('<Switch', sourcesSrc.indexOf("t('sources.tabModelTitle')")),
  )
  assert.match(tabRowSlice, /className="ca-info-tip"/)
  assert.match(tabRowSlice, /t\('sources\.tabAutocompleteNote'\)/)

  // Minimal React hook runtime to mount the real GhostInput.jsx component without external React installed.
  const hookRuntime = `
    let slots = [];
    let cursor = 0;
    let effects = [];
    let rerender = null;
    export const __reset = (cb) => {
      for (const eff of effects) { try { eff.cleanup?.() } catch {} }
      slots = []; cursor = 0; effects = []; rerender = cb;
    };
    export const __beginRender = () => { cursor = 0; };
    export const __flushEffects = () => {
      for (const eff of effects) {
        if (eff.pending) {
          eff.pending = false;
          try { eff.cleanup?.() } catch {}
          eff.cleanup = eff.create() || undefined;
        }
      }
    };
    export const __unmount = () => {
      for (const eff of effects) { try { eff.cleanup?.() } catch {} }
      effects = [];
    };
    const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    export function useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      const setState = (next) => {
        const prev = slots[i];
        const val = typeof next === 'function' ? next(prev) : next;
        if (!Object.is(val, prev)) {
          slots[i] = val;
          rerender?.();
        }
      };
      return [slots[i], setState];
    }
    export function useRef(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    }
    export function useEffect(create, deps) {
      const i = cursor++;
      const prev = slots[i];
      if (!prev || !deps || !depsEqual(prev.deps, deps)) {
        const rec = prev || { cleanup: undefined, deps: undefined, create, pending: false };
        rec.create = create;
        rec.deps = deps;
        rec.pending = true;
        slots[i] = rec;
        if (!prev) effects.push(rec);
      }
    }
    export const useLayoutEffect = useEffect;
    export const Fragment = Symbol.for('react.fragment');
    export function createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    }
    export default { useState, useRef, useEffect, useLayoutEffect, Fragment, createElement };
  `

  const testEntry = await esbuild.build({
    stdin: {
      contents: `import * as R from 'react'; import GhostInput from ${JSON.stringify(fileURLToPath(new URL('../client/GhostInput.jsx', import.meta.url)))}; export { R, GhostInput };`,
      resolveDir: fileURLToPath(new URL('../client', import.meta.url)),
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'transform',
    plugins: [{
      name: 'ghost-test-shims',
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'shim' }))
        build.onResolve({ filter: /\.\/i18n\.jsx$/ }, () => ({ path: 'i18n', namespace: 'shim' }))
        build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'shim' }))
        build.onLoad({ filter: /.*/, namespace: 'shim' }, args => {
          if (args.path === 'react') return { contents: hookRuntime, loader: 'js' }
          if (args.path === 'i18n') return { contents: 'export const getActiveLocale = () => "zh"; export const useI18n = () => ({ locale: "zh" });', loader: 'js' }
          return { contents: 'export const ShortcutKeys = () => null;', loader: 'js' }
        })
      },
    }],
  })
  const { R, GhostInput: RealGhostInput } = await import(
    `data:text/javascript;base64,${Buffer.from(testEntry.outputFiles[0].text, 'utf8').toString('base64')}`
  )

  const findTextarea = node => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'textarea') return node
    const children = Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]
    for (const child of children) {
      const hit = findTextarea(child)
      if (hit) return hit
    }
    return null
  }

  const prevWindow = globalThis.window
  const prevFetch = globalThis.fetch
  const fetchCalls = []
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: true }),
  }
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, body: JSON.parse(init?.body || '{}') })
    return { ok: true, json: async () => ({ ok: true, suggestion: '帮我润色这段项目指标' }) }
  }

  try {
    let currentValue = ''
    let lastTextarea = null
    const renderComponent = () => {
      R.__beginRender()
      const tree = RealGhostInput({
        value: currentValue,
        onChange: next => { currentValue = next },
        onSubmit: () => {},
        surface: 'resume',
        suggestContext: { enabled: true, tabEnabled: true, key: 'ctx1', model: 'mock:fast' },
      })
      R.__flushEffects()
      lastTextarea = findTextarea(tree)
      assert.ok(lastTextarea)
    }

    // 1. Inject Chinese debrief prefill (「带复盘要点去改简历」), focus, prepend 「请」, and replace trailing 「。」 with 「!」
    R.__reset(() => renderComponent())
    renderComponent()
    const debriefPrefill = '结合 Acme AI Infra 面试复盘要点修改简历：重点考察了 vLLM 显存管理与 CUDA 推理延迟优化。'
    currentValue = debriefPrefill
    renderComponent()
    lastTextarea.props.onFocus()
    renderComponent()

    currentValue = `请${debriefPrefill}`
    lastTextarea.props.onChange({ target: { value: currentValue } })
    renderComponent()

    currentValue = `请${debriefPrefill.slice(0, -1)}!`
    lastTextarea.props.onChange({ target: { value: currentValue } })
    renderComponent()

    lastTextarea.props.onCompositionStart({ currentTarget: { value: currentValue } })
    lastTextarea.props.onCompositionEnd({ currentTarget: { value: currentValue } })
    renderComponent()

    await wait(420)
    assert.equal(fetchCalls.length, 0, 'head/tail edits or IME cancel on debrief prefill must trigger 0 /suggest calls')

    // 2. Mount directly with restored draft -> edit head/tail + IME cancel -> 0 calls
    R.__reset(() => renderComponent())
    const restoredDraft = '这是恢复的历史草稿内容，请勿在未清空前自动外发。'
    currentValue = restoredDraft
    renderComponent()
    lastTextarea.props.onFocus()
    renderComponent()
    lastTextarea.props.onChange({ target: { value: `请${restoredDraft.slice(0, -1)}!` } })
    renderComponent()
    lastTextarea.props.onCompositionStart({ currentTarget: { value: currentValue } })
    lastTextarea.props.onCompositionEnd({ currentTarget: { value: currentValue } })
    renderComponent()

    await wait(420)
    assert.equal(fetchCalls.length, 0, 'restored draft edits + IME cancel must trigger 0 /suggest calls')

    // 3. Explicitly clear the input, then type fresh text -> /suggest resumes normally
    lastTextarea.props.onChange({ target: { value: '' } })
    renderComponent()
    lastTextarea.props.onChange({ target: { value: '帮我润色' } })
    renderComponent()

    await wait(420)
    assert.equal(fetchCalls.length, 1, 'clearing and typing new text must resume /suggest')
    assert.equal(fetchCalls[0].url, 'api/career-agent/suggest')
    assert.equal(fetchCalls[0].body.prefix, '帮我润色')
  } finally {
    R.__unmount()
    globalThis.window = prevWindow
    globalThis.fetch = prevFetch
  }
})

test('concurrent triage-jobs invocation signals alreadyRunning instead of enqueuing duplicate run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-triage-busy-'))
  let disposeHost = null
  const firstRunGate = Promise.withResolvers()
  const firstRunStarted = Promise.withResolvers()
  try {
    const harness = createFetchHarness()
    await apply({
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'fast', name: 'Fast' }],
        async *stream() {
          firstRunStarted.resolve()
          await firstRunGate.promise
          yield { type: 'text-delta', text: JSON.stringify({ items: [{ id: added.data.result.id, score: 88, tier: 'top', roleQuote: 'Build distributed systems', reason: 'Fit', caution: '' }] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      provide: () => {},
      get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'fast' }) } : null),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      on: () => {},
      effect: fn => { disposeHost = fn() },
    })
    const added = await harness.call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Acme', title: 'Systems Engineer', jd: 'Build distributed systems and compilers.' },
    })
    const preview = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-preview',
      id: added.data.result.id,
    })
    assert.ok(preview.data.result.confirmToken)
    const first = harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      confirmed: true,
      confirmToken: preview.data.result.confirmToken,
    })
    await firstRunStarted.promise
    const second = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      force: true,
      id: added.data.result.id,
    })
    assert.equal(second.data.result.running, true)
    assert.equal(second.data.result.alreadyRunning, true)
    firstRunGate.resolve()
    await first
  } finally {
    firstRunGate.resolve()
    await disposeHost?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('F06 regression: DSH session launcher preserves existing drafts (whenDraftExists=keep) and exposes CopyButton fallback', async () => {
  const { readFile } = await import('node:fs/promises')
  const indexSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  const jobDetailSrc = await readFile(new URL('../client/JobDetailSheet.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(indexSrc, /whenDraftExists:\s*['"]replace['"]/)
  assert.match(indexSrc, /ws\.startSession\(undefined,\s*\{\s*prompt:\s*text,\s*whenDraftExists:\s*['"]keep['"]\s*\}/)
  assert.match(jobDetailSrc, /openDshDiligence[\s\S]{0,200}<CopyButton text=\{diligencePrompt\}/)
  assert.match(jobDetailSrc, /openDshStudy[\s\S]{0,200}<CopyButton text=\{activeStudyPrompt\}/)
})

test('F07 regression: triageSummary exposes factual evaluatedCount & eligibleCount without inferred pendingCount or failed-item inflation', async () => {
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises')
  const indexSrc = await rf(new URL('../client/index.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(indexSrc, /evaluatedCount\s*\+\s*Number\(triage\?\.progress\?\.completed/)
  assert.doesNotMatch(indexSrc, /\bpendingCount\b|\bretriageAllDone\b|\btriagingProgressWithTotal\b/)

  const dir = await mkdtemp(join(tmpdir(), 'niuma-triage-summary-'))
  let disposeHost = null
  const seenBatches = []
  let failNextBatch = false
  try {
    const harness = createFetchHarness()
    const hostCtx = {
      profileContext: { dir },
      connection: harness.connection,
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'fast', name: 'Fast' }],
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
          seenBatches.push(jobs.map(j => j.id))
          if (failNextBatch) {
            throw new Error('upstream 502 simulated batch failure')
          }
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: jobs.map(j => ({
                id: j.id,
                D: 2,
                E: 2,
                L: null,
                jdIds: [(String(j.jdSegments || '').match(/^\[(J\d+(?:_\d+)?)\]/m)?.[1] || 'J1_1')],
                resumeIds: ['R1'],
                uncertain: false,
                reason: 'Match',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      provide: () => {},
      get: key => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'fast' }) } : null),
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      on: () => {},
      effect: fn => { disposeHost = fn() },
    }
    await apply(hostCtx)
    const impW = await harness.call('POST', '/api/career-agent/action', {
      action: 'resume-import',
      title: 'Master',
      text: '# Candidate\n\n## Core\n- Built distributed vLLM inference clusters.',
    })
    await harness.call('POST', '/api/career-agent/action', {
      action: 'resume-review',
      id: impW.data.result.id,
      decision: 'approve',
    })
    await harness.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: {
        mode: 'search',
        sendToModel: true,
        model: 'mock:fast',
        goal: 'AI Infra 平台研发',
        searchTerms: ['AI Infra', 'vLLM'],
        boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme', label: 'Acme' }],
      },
    })
    await disposeHost?.()
    disposeHost = null

    const controlPath = join(dir, 'career-broker', 'watchdog.json')
    const ctrl = JSON.parse(await rf(controlPath, 'utf8'))
    ctrl.watch.nextRun = new Date(Date.now() + 8 * 3600_000).toISOString()
    ctrl.opportunities = ['b-1', 'b-2', 'b-3'].map(id => ({
      id: `greenhouse:acme:${id}`,
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'Acme',
      title: `AI Infra Engineer ${id}`,
      location: 'Shanghai',
      jd: 'Build distributed vLLM inference clusters and GPU scheduling runtime.',
      oneOff: true,
      firstSeenAt: '2026-11-22T01:00:00.000Z',
      verifiedAt: '2026-11-22T01:00:00.000Z',
    }))
    await wf(controlPath, JSON.stringify(ctrl, null, 2))
    await apply(hostCtx)

    const before = await harness.call('GET', '/api/career-agent/state')
    assert.equal(before.data.triageSummary.eligibleCount, 3)
    assert.equal(before.data.triageSummary.evaluatedCount, 0)
    assert.equal(before.data.triageSummary.pendingCount, undefined)

    // Failing round must leave evaluatedCount strictly at persisted 0 (never inflated mid-run or after)
    failNextBatch = true
    const failedRun = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      force: true,
      limit: 2,
    })
    assert.equal(failedRun.data.result.partialFailure, true)
    assert.equal(failedRun.data.result.mode, 'heuristic')
    assert.equal(failedRun.data.result.llmScoredCount, 0)
    const afterFailed = await harness.call('GET', '/api/career-agent/state')
    assert.equal(afterFailed.data.triageSummary.evaluatedCount, 0)
    assert.equal(afterFailed.data.triageSummary.eligibleCount, 3)
    assert.equal(afterFailed.data.triageSummary.pendingCount, undefined)

    failNextBatch = false
    seenBatches.length = 0
    const round1 = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      force: true,
      limit: 2,
    })
    assert.equal(round1.data.result.triagedCount, 2)
    assert.equal(round1.data.result.llmScoredCount, 2)

    const afterRound1 = await harness.call('GET', '/api/career-agent/state')
    assert.equal(afterRound1.data.triageSummary.eligibleCount, 3)
    assert.equal(afterRound1.data.triageSummary.evaluatedCount, 2)
    assert.equal(afterRound1.data.triageSummary.pendingCount, undefined)

    const round2 = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      force: true,
      limit: 2,
    })
    assert.equal(round2.data.result.triagedCount, 1)
    assert.equal(round2.data.result.llmScoredCount, 1)

    const afterRound2 = await harness.call('GET', '/api/career-agent/state')
    assert.equal(afterRound2.data.triageSummary.eligibleCount, 3)
    assert.equal(afterRound2.data.triageSummary.evaluatedCount, 3)
    assert.equal(afterRound2.data.triageSummary.pendingCount, undefined)
    assert.equal(new Set(seenBatches.flat()).size, 3, 'round 2 must skip already scored jobs')

    const round3 = await harness.call('POST', '/api/career-agent/action', {
      action: 'triage-jobs',
      force: true,
      limit: 2,
    })
    assert.equal(round3.data.result.triagedCount, 0)
    assert.equal(round3.data.result.llmScoredCount, 0)
    assert.equal(round3.data.result.mode, 'cached')

    const freshIndexSrc = await rf(new URL('../client/index.jsx', import.meta.url), 'utf8')
    const jobDetailSrc = await rf(new URL('../client/JobDetailSheet.jsx', import.meta.url), 'utf8')
    const resumeAgentSrc = await rf(new URL('../client/ResumeAgent.jsx', import.meta.url), 'utf8')
    const marketInsightsSrc = await rf(new URL('../client/MarketInsights.jsx', import.meta.url), 'utf8')
    assert.match(freshIndexSrc, /r\?\.llmScoredCount[\s\S]{0,300}jobs\.retriageNoNewScores/)
    assert.doesNotMatch(freshIndexSrc, /jobs\.retriageWithCount/)
    assert.match(jobDetailSrc, /onResumeWithPrompt\(\{\s*text:\s*prompt,\s*sourceIds:\s*\[...new Set\(noteSourceIds\)\]\s*\}\)/)
    assert.match(resumeAgentSrc, /setText\(seedText,\s*\{\s*sourceIds:\s*seedSources\s*\}\)/)
    assert.doesNotMatch(marketInsightsSrc, /report\?\.provenance\?\.sourceIds/)
    assert.match(marketInsightsSrc, /reportEntry\?\.provenance\?\.sourceIds/)
    assert.match(marketInsightsSrc, /evidenceSourceById\.get\(leadEvidence\.id\)/)
  } finally {
    await disposeHost?.()
    await rm(dir, { recursive: true, force: true })
  }
})
