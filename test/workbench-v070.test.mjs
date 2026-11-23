import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
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
  let route, dispose
  const ctx = {
    profileContext: { dir },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection() { return false } },
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
  const call = async (url, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { method: body ? 'POST' : 'GET', url, headers: { 'x-career-agent': '1', 'content-type': 'application/json' } })
    let status, data
    await route.handler(req, {
      writeHead(code) { status = code; return this },
      end(value) { if (value) data = JSON.parse(value) },
    })
    return { status, data }
  }
  await call('/career-agent/action', { action: 'configure', config: { mode: 'observe', sources: [{ id: 'manual', projects: ['personal'] }] } })
  const imported = (await call('/career-agent/action', {
    action: 'resume-import', title: '通用底稿',
    text: '# 林予安\n\n## 工作经历\n- 优化了告警规则。\n- 维护了监控看板。\n',
  })).data.result
  await call('/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })
  const tailored = (await call('/career-agent/action', {
    action: 'tailor-resume', jd: '需要具备值班与告警经验', resumeId: imported.id, model: 'mock:test',
  })).data.result
  await call('/career-agent/action', { action: 'resume-review', id: tailored.id, decision: 'approve' })
  const jdRevised = (await call('/career-agent/action', {
    action: 'resume-revise', id: tailored.id,
    text: '# 林予安\n\n## 工作经历\n- 重构告警并提升值班效率（岗位定制修订版）。\n- 维护了监控看板。\n',
  })).data.result
  await call('/career-agent/action', { action: 'resume-review', id: jdRevised.id, decision: 'approve' })

  // Now approve new evidence -> resume-generate MUST extend 通用底稿, NOT jdRevised!
  const ing = (await call('/career-agent/action', {
    action: 'ingest',
    event: {
      id: 'm1', sourceId: 'manual', projectId: 'personal', kind: 'manual',
      occurredAt: '2026-11-19T10:00:00.000Z',
      evidence: [{ title: '扩容交付', text: '推动 3 个算力池扩容验收。' }],
    },
  })).data.result
  const rev = (await call('/career-agent/action', {
    action: 'review', id: ing.evidence[0].id, decision: 'approve', shareable: true,
  })).data.result
  assert.ok(rev.resumeId)
  const state = (await call('/career-agent/state')).data
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


test('predictNextPrompt selects lowest reasoning effort via prepareCall and predicts both empty and prefix completions', async () => {
  let chosenControls = null
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async prepareCall(route, _signal, adjust) {
      const info = { provider: route.provider, id: route.model, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
      chosenControls = adjust({ maxTokens: 4096 }, info)
      return {
        model: info,
        async *stream({ system }) {
          const text = system.includes('输入自动补全引擎')
            ? '藏青双栏并紧凑放进一页'
            : '帮我诊断这份简历的硬伤并给出修改建议'
          yield { type: 'text-delta', index: 0, text }
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
    markdown: '# 林予安\n## 工作经历\n- 优化资源池。',
  })
  assert.equal(chosenControls?.reasoningEffort, 'low')
  assert.equal(chosenControls?.maxTokens, 96)
  assert.equal(next.suggestion, '帮我诊断这份简历的硬伤并给出修改建议')
  assert.equal(next.suffix, '帮我诊断这份简历的硬伤并给出修改建议')

  const mid = await predictNextPrompt({
    llm,
    config: { model: 'mock:fast', sendToModel: true },
    surface: 'resume',
    prefix: '帮我换成',
    markdown: '# 林予安',
  })
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
  const disposers = []
  await apply({
    profileContext: { dir },
    webServer: { register(route) { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => null },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    llm,
    logger: { warn() {} },
    get: () => undefined,
    emit() {},
    provide() {},
    on() {},
    effect(fn) { disposers.push(fn()) },
  })
  t.after(async () => { for (const d of disposers) await d?.() })

  async function call(path, payload) {
    const req = payload
      ? Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
      : Readable.from([])
    req.method = payload ? 'POST' : 'GET'
    req.url = path
    req.headers = { 'x-career-agent': '1', ...(payload && { 'content-type': 'application/json' }) }
    let status = 0, raw = ''
    const res = {
      destroyed: false, writableEnded: false,
      writeHead(code) { status = code; return this },
      end(chunk = '') { raw += chunk; this.writableEnded = true },
    }
    await handler(req, res)
    const parsed = JSON.parse(raw)
    assert.equal(status, 200, `Unexpected HTTP ${status}: ${raw}`)
    return parsed
  }

  // 1. Import & approve resume
  const imported = (await call('/career-agent/action', {
    action: 'resume-import', title: '主简历', text: '# 林予安\n## 工作经历\n- 协同研发完成 3 个 GPU 资源池容量与配额核对。',
  })).result
  await call('/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })

  // 2. Add job (both with HTTPS URL and URL-less headhunter/referral external JD)
  const job = (await call('/career-agent/action', {
    action: 'job-add',
    job: { company: 'Linear', title: 'Senior Infra Engineer', location: 'Remote', url: 'https://jobs.ashbyhq.com/linear/abc', jd: 'Own GPU capacity and reliability' },
  })).result
  const referral = (await call('/career-agent/action', {
    action: 'job-add',
    job: { company: 'MiniMax', title: 'AI Infra Tech Lead', location: '上海', url: '', jd: '猎头微信转发 JD，无公开官网链接' },
  })).result
  assert.ok(referral.id.startsWith('manual:'))
  assert.equal(referral.url, '')

  // 3. Tailor preparation materials (works directly without flipping mode!)
  const draft = (await call('/career-agent/action', { action: 'tailor', id: job.id })).result
  assert.match(draft.fit, /资源池/)
  assert.match(draft.message, /简历/)

  // 4. Authorized handoff (never auto-submits)
  const handoff = (await call('/career-agent/action', { action: 'handoff', id: job.id })).result
  assert.equal(handoff.status, 'draft_only')
  assert.equal(handoff.url, 'https://jobs.ashbyhq.com/linear/abc')

  // 5. Receipt chain: submitted -> interview_confirmed -> .ics -> interview_completed -> offer_received
  await call('/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: job.id, type: 'application_submitted', source: 'manual', confirmed: true, evidence: '官网提交回执', material: '主简历' },
  })
  const interview = (await call('/career-agent/action', {
    action: 'receipt',
    receipt: {
      opportunityId: job.id, type: 'interview_confirmed', source: 'manual', confirmed: true,
      evidence: '邮件确认一面', round: '技术一面',
      startsAt: '2026-12-01T14:00:00+08:00', endsAt: '2026-12-01T15:00:00+08:00', location: 'Zoom',
    },
  })).result
  const ics = (await call('/career-agent/action', { action: 'calendar', id: interview.id })).result.text
  assert.match(ics, /BEGIN:VCALENDAR/)
  assert.match(ics, /技术一面/)

  await call('/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: job.id, type: 'interview_completed', source: 'manual', confirmed: true, evidence: '已完成一面', round: '技术一面' },
  })

  // 6. Explicit manual interview debrief works directly with user consent
  const note = (await call('/career-agent/action', {
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
  await call('/career-agent/action', {
    action: 'receipt',
    receipt: {
      opportunityId: job.id, type: 'offer_received', source: 'manual', confirmed: true,
      evidence: '正式书面 Offer 邮件', form: 'written', replyBy: '2026-12-10T18:00:00+08:00',
    },
  })
  const state = await call('/career-agent/state')
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
    let routeHandler = null
    let disposeHost = null
    const ctx = {
      profileContext: { dir },
      connection: { requestRejection: () => 0 },
      webServer: { register: ({ handler }) => { routeHandler = handler; return () => {} } },
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
      get: () => null,
      emit: () => {},
      on: () => () => {},
      provide: () => {},
      logger: { warn: () => {} },
      effect: fn => { disposeHost = fn() },
    }
    const { apply } = await import('../src/host.mjs')
    await apply(ctx)

    const call = async (method, url, body) => {
      const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
      let status = 200
      let raw = ''
      const req = {
        method,
        url,
        headers: { 'x-career-agent': '1', 'content-type': 'application/json' },
        on: () => {},
        async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
      }
      const res = {
        writableEnded: false,
        destroyed: false,
        writeHead: code => { status = code; return res },
        end: text => { raw = String(text ?? ''); res.writableEnded = true },
      }
      await routeHandler(req, res)
      return { status, data: raw ? JSON.parse(raw) : null }
    }

    const imp = await call('POST', '/career-agent/action', {
      action: 'resume-import', title: '基础简历', text: '# 林予安\n## 工作经历\n- 负责千卡 GPU 调度。\n',
    })
    assert.equal(imp.status, 200)
    await call('POST', '/career-agent/action', { action: 'resume-review', id: imp.data.result.id, decision: 'approve' })
    const added = await call('POST', '/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra', jd: '负责大模型集群 GPU 调度与推理网关建设。' },
    })
    const opId = '11111111-2222-4333-8444-555555555555'
    const tailored = await call('POST', '/career-agent/action', {
      action: 'tailor', id: added.data.result.id, operationId: opId,
    })
    assert.equal(tailored.status, 200)
    assert.equal(tailored.data.ok, true)
    assert.match(tailored.data.result.fit, /千卡 GPU 调度/)
    assert.match(tailored.data.result.gaps, /海外合规审计/)
    assert.match(tailored.data.result.resume, /高并发 LLM 推理网关/)

    const actRes = await call('GET', `/career-agent/resume-activity?id=${opId}`)
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
    const ctx = {
      profileContext: { dir },
      webServer: { register: ({ handler }) => { routeHandler = handler; return () => {} } },
      connection: { publish: () => {}, requestRejection: () => null },
      sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
      llm: mockLlm,
      provide: () => {},
      get: () => null,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      on: () => {},
      effect: fn => { disposeHost = fn() },
    }
    await apply(ctx)
    const call = async (method, url, body) => {
      const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
      let status = 200
      let raw = ''
      const req = {
        method, url, headers: { 'x-career-agent': '1', 'content-type': 'application/json' },
        on: () => {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
      }
      const res = {
        writableEnded: false, destroyed: false,
        writeHead: code => { status = code; return res },
        end: text => { raw = String(text ?? ''); res.writableEnded = true },
      }
      await routeHandler(req, res)
      return { status, data: raw ? JSON.parse(raw) : null }
    }

    const added = await call('POST', '/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra Seed Model' },
    })
    const jobId = added.data.result.id
    // Submit + mark started twice -> backend must deduplicate started!
    await call('POST', '/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'application_submitted', source: 'manual', confirmed: true, material: '通用简历', evidence: '官网投递' },
    })
    await call('POST', '/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'started', source: 'manual', confirmed: true, evidence: '误点已入职 1' },
    })
    await call('POST', '/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: jobId, type: 'started', source: 'manual', confirmed: true, evidence: '误点已入职 2' },
    })
    let state = (await call('GET', '/career-agent/state')).data
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
    const drafted = await call('POST', '/career-agent/action', {
      action: 'draft-intake', opportunityId: jobId, model: 'mock:pro', text: '点错了，帮我撤掉已入职',
    })
    assert.equal(drafted.status, 200)
    const accepted = await call('POST', '/career-agent/action', {
      action: 'accept-intake', id: drafted.data.result.id,
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.data.result.removedCount, 1)
    assert.equal(accepted.data.result.stage, 'submitted')

    // Clear all -> restores discovered!
    const cleared = await call('POST', '/career-agent/action', {
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
  let routeHandler = null
  let disposeHost = null
  const ctx = {
    profileContext: { dir },
    webServer: { register: ({ handler }) => { routeHandler = handler; return () => {} } },
    connection: { publish: () => {}, requestRejection: () => null },
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
    llm: mockLlm,
    provide: () => {},
    get: () => null,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: () => {},
    effect: fn => { disposeHost = fn() },
  }
  await apply(ctx)
  const call = async (method, url, body) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    let status = 200
    let raw = ''
    const req = {
      method, url, headers: { 'x-career-agent': '1', 'content-type': 'application/json' },
      on: () => {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    }
    const res = {
      writableEnded: false, destroyed: false,
      writeHead: code => { status = code; return res },
      end: text => { raw = String(text ?? ''); res.writableEnded = true },
    }
    await routeHandler(req, res)
    return { status, data: raw ? JSON.parse(raw) : null }
  }
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
    const j1 = (await call('POST', '/career-agent/action', {
      action: 'job-add', job: { company: 'Linear', title: 'Staff Applied AI', jd: 'Build AI workflows and distributed infra.' },
    })).data.result
    const j2 = (await call('POST', '/career-agent/action', {
      action: 'job-add', job: { company: '字节跳动', title: 'AI Infra Seed Model', jd: 'Large-scale GPU cluster scheduling.' },
    })).data.result
    await call('POST', '/career-agent/action', {
      action: 'receipt', receipt: { opportunityId: j1.id, type: 'offer_received', form: 'written', source: 'manual', confirmed: true, evidence: '书面 Offer', notes: '含远程弹性' },
    })
    const res = await call('POST', '/career-agent/action', {
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
    const imported = (await call('POST', '/career-agent/action', {
      action: 'resume-import', title: '默认主干', text: '# 张三\n\n## 工作经历\n- 负责分布式调度平台建设\n',
    })).data.result
    await call('POST', '/career-agent/action', { action: 'resume-review', id: imported.id, decision: 'approve' })
    const job = (await call('POST', '/career-agent/action', {
      action: 'job-add', job: { company: '腾讯', title: 'Agent Infra', jd: 'Agent sandbox & GPU scheduling' },
    })).data.result
    const tailored = (await call('POST', '/career-agent/action', {
      action: 'tailor-resume', id: job.id, resumeId: imported.id, model: 'mock:pro',
    })).data.result
    await call('POST', '/career-agent/action', { action: 'resume-review', id: tailored.id, decision: 'approve' })
    const masterV2 = (await call('POST', '/career-agent/action', {
      action: 'resume-revise', id: imported.id,
      text: '# 张三\n\n## 工作经历\n- 负责分布式调度平台建设\n- 主导千卡 GPU 调度治理，利用率提升 28%\n', approve: true,
    })).data.result
    assert.ok(masterV2.id)

    const opId = '11111111-2222-4333-8444-555555555555'
    const rebased = await call('POST', '/career-agent/action', {
      action: 'resume-rebase', id: tailored.id, model: 'mock:pro', operationId: opId,
    })
    assert.equal(rebased.status, 200, JSON.stringify(rebased.data))
    assert.equal(rebased.data.result.origin, 'rebase')
    assert.equal(rebased.data.result.baseId, masterV2.id)
    const activity = await call('GET', `/career-agent/resume-activity?id=${opId}`)
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
    const modelsRes = await call('GET', '/career-agent/models')
    assert.equal(modelsRes.status, 200)
    assert.equal(modelsRes.data[0].reasoning?.efforts?.length, 4)
    assert.equal(modelsRes.data[0].reasoning?.defaultEffort, 'high')

    const cfgRes = await call('POST', '/career-agent/action', {
      action: 'configure',
      config: { model: 'deepseek-official:deepseek-v3', reasoningEffort: 'max', tabReasoningEffort: 'low' },
    })
    assert.equal(cfgRes.status, 200)
    const st = await call('GET', '/career-agent/state')
    assert.equal(st.data.config.reasoningEffort, 'max')
    assert.equal(st.data.config.tabReasoningEffort, 'low')

    const job = (await call('POST', '/career-agent/action', {
      action: 'job-add',
      job: { company: 'DeepSeek', title: 'Infra Engineer', jd: 'Build high-throughput inference clusters and GPU scheduling systems.' },
    })).data.result
    const intelRes = await call('POST', '/career-agent/action', { action: 'job-intel', id: job.id })
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
      config: { model: 'deepseek-official:deepseek-v3', tabReasoningEffort: 'low' },
      surface: 'resume',
      markdown: '# Alex',
    })
    assert.equal(seenEfforts[2], 'low')
    await predictNextPrompt({
      llm: mockLlm,
      config: { model: 'deepseek-official:deepseek-v3', tabReasoningEffort: '' },
      surface: 'resume',
      markdown: '# Alex',
    })
    assert.equal(seenEfforts[3], 'off')
    await disposeHost?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('foreground explicit AI flows (suggest, suggest-directions, forced triage-jobs, resume-generate) work when background sendToModel=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-fg-ai-'))
  try {
    let llmCalls = 0
    const mockLlm = {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      resolveModelInfo: async () => ({ provider: 'mock', id: 'fast', name: 'Fast' }),
      prepareCall: async () => ({
        stream: async function* ({ system }) {
          llmCalls += 1
          const sys = String(system || '')
          let text = '{"directions":[{"label":"AI Infra","query":"AI Infra 推理引擎","basis":"基于你的背景"}],"keywords":["vLLM","CUDA"]}'
          if (sys.includes('triage') || sys.includes('scores') || sys.includes('fitScore') || sys.includes('评分')) {
            text = JSON.stringify({ scores: [{ id: 'job-1', score: 86, reason: 'Strong GPU infra fit' }] })
          } else if (sys.includes('Tab') || sys.includes('补全') || sys.includes('predict') || sys.includes('下一步')) {
            text = '把项目经历量化成延迟和吞吐指标'
          } else if (sys.includes('markdown') || sys.includes('merge') || sys.includes('融入') || sys.includes('插入')) {
            text = JSON.stringify({
              markdown: '# Alex\n\n## Experience\n- Built GPU clusters\n- Cut P99 latency by 40%',
              summary: 'Added latency optimization win',
              placements: [{ section: 'Experience', summary: 'Cut P99 latency by 40%' }],
            })
          }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
      stream: async function* () { throw new Error('expected prepareCall') },
    }
    const { call, disposeHost } = await bootMockHost(dir, mockLlm)

    // Fresh default config: mode=off, sendToModel=false
    const st = await call('GET', '/career-agent/state')
    assert.equal(st.data.config.sendToModel, false)

    // 1. Interactive Tab suggest works
    const sug = await call('POST', '/career-agent/suggest', {
      surface: 'resume', prefix: '', markdown: '# Alex\n## Experience\n- Built GPU clusters', explicitInteractive: true,
    })
    assert.equal(sug.status, 200)
    assert.ok(sug.data.suggestion.length > 0, 'interactive Tab suggest must run when explicitInteractive=true')
    const afterSug = llmCalls
    assert.ok(afterSug >= 1)

    // 2. Interactive suggest-directions works
    const dirs = await call('POST', '/career-agent/suggest-directions', {
      goal: 'AI Infra Engineer', explicitInteractive: true,
    })
    assert.equal(dirs.status, 200)
    assert.ok(dirs.data.result.directions.length > 0, 'interactive suggest-directions must run when explicitInteractive=true')
    assert.ok(llmCalls > afterSug)

    // 3. Forced manual triage-jobs runs LLM
    const beforeTriage = llmCalls
    await call('POST', '/career-agent/action', {
      action: 'job-add',
      job: { company: 'Acme', title: 'AI Infra Engineer', jd: 'Build vLLM and CUDA inference serving systems at scale.' },
    })
    const tri = await call('POST', '/career-agent/action', { action: 'triage-jobs', force: true })
    assert.equal(tri.status, 200)
    assert.ok(llmCalls > beforeTriage, 'manual triage-jobs (force=true) must use LLM even when background sendToModel=false')

    await disposeHost?.()
  } finally {
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
