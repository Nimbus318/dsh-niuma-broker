import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPatrolSearchProfile, scoreOpportunityHeuristic, triageBatchWithLlm } from '../src/job-triage.mjs'
import { apply } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'
import { rebaseTailoredResume } from '../src/resume-merge.mjs'
import { CareerStore } from '../src/career.mjs'
import { organizeResumeVersions } from '../src/resume-versions.mjs'

const RESUME = `# 林予安
_资深 AI Infra 平台工程师 · 上海_

## 工作经历
### 星火云智 · 高级平台研发工程师（2022.03 – 至今）
- 主导千卡 GPU 异构算力调度平台与 vLLM 推理引擎建设，吞吐提升 2.4 倍。
- 基于 Kubernetes 与 Prometheus 落地多租户配额治理和可观测告警体系。

## 项目经历
### Agent Sandbox 弹性执行沙箱
- 设计轻量容器冷启动池，支撑工具调用与沙箱安全隔离。
`

test('buildPatrolSearchProfile respects user-owned queries without hardcoded buckets and parses avoidHints', () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '找上海或杭州的 Senior AI Infra / 大模型推理平台工程师，不看外包和纯销售',
    searchTerms: ['AI Infra', '推理引擎'],
    evidence: [],
    feedback: {},
  })

  assert.deepEqual(profile.derivedSynonyms, [], 'Must NEVER silently inject hardcoded industry-bucket synonyms')
  assert.deepEqual(profile.activeClusters, [], 'Must NOT classify users into hardcoded industry buckets')
  assert.deepEqual(profile.expandedQueries, ['AI Infra', '推理引擎'], 'Board queries must 100% come from user-confirmed searchTerms')
  assert.ok(profile.resumeKeywords.some(k => /vllm/i.test(k)), 'Dynamic resume extraction should pick up concrete resume terms like vLLM')
  assert.ok(profile.resumeKeywords.some(k => /kubernetes/i.test(k)), 'Dynamic resume extraction should pick up Kubernetes')
  assert.ok(profile.targetCities.includes('上海'))
  assert.ok(profile.targetCities.includes('杭州'))
  assert.ok(profile.avoidHints.includes('外包'))
  assert.ok(profile.avoidHints.includes('销售'))
  assert.equal(profile.isEngineerProfile, true)
})

test('board queries filter out company, city, and hiring channel noise while preserving user specialty terms', () => {
  for (const [searchTerms, expectedFirst] of [
    [['智元机器人', '社招', '人形机器人', '全身运动控制算法', '上海'], '人形机器人'],
    [['智元机器人', '全身运动控制算法', '运控', '社招', '上海'], '全身运动控制算法'],
    [['AGIBOT', 'Shanghai', 'experienced hire', 'whole-body control algorithm engineer'], 'whole-body control algorithm eng'],
  ]) {
    const profile = buildPatrolSearchProfile({ goal: '寻找上海智元机器人的社招岗位', searchTerms })
    assert.equal(profile.expandedQueries[0], expectedFirst)
    assert.ok(profile.expandedQueries.length <= 6)
    assert.ok(!profile.expandedQueries.some(q => /^(?:智元机器人|社招|上海|AGIBOT|Shanghai|experienced hire)$/iu.test(q)))
    assert.deepEqual(profile.derivedSynonyms, [])
  }
  const goalOnly = buildPatrolSearchProfile({ goal: 'Humanoid whole-body control engineer in London' })
  assert.ok(goalOnly.expandedQueries.some(q => /whole-body control/i.test(q)))
})

test('past background in resume or goal never injects unwanted search queries', () => {
  for (const goal of ['找上海的具身多模态算法岗位', '之前做过机器人运动控制，现在想做产品经理', '不做机器人运动控制，想做具身感知算法']) {
    const profile = buildPatrolSearchProfile({ goal, resumeText: '曾为机器人开发全身运动控制算法。' })
    assert.ok(!profile.expandedQueries.some(q => /运动控制/.test(q)), `Past/excluded specialty leaked into queries for "${goal}": ${profile.expandedQueries}`)
  }
})

test('Technical Artist profile is never hijacked into Agent/LLM clusters and caps zero-core-term AI algorithm jobs', () => {
  const taResume = `# 候选人
_资深技术美术 Technical Artist · 上海_
## 专业技能
- UE5、Houdini、MetaHuman、HLSL、Shader、实时渲染、数字人、AI 内容生成管线、Python
## 工作经历
### 某游戏工作室 · 高级技术美术（2021.05 – 至今）
- 搭建 UE5 实时渲染与数字人资产管线，引入 AI 工具链提升贴图与材质制作效率。
`
  const taTerms = ['技术美术', 'Technical Artist', 'TA', 'AI 技术美术', 'AI 3D', '数字人', 'MetaHuman', 'Houdini', 'UE5', '实时渲染', 'AI 内容生成管线', 'AI 工具链']
  const profile = buildPatrolSearchProfile({
    resumeText: taResume,
    goal: '在上海找技术美术 / AI 3D 方向岗位',
    searchTerms: taTerms,
  })

  assert.deepEqual(profile.derivedSynonyms, [])
  assert.ok(!profile.expandedQueries.some(q => /^(?:Agent|大模型应用|AI平台|智能体)$/i.test(q)), 'Must never inject Agent/LLM bucket queries')
  assert.ok(profile.expandedQueries.every(q => taTerms.includes(q)), 'Every query must come from user searchTerms')

  const llmAgentJob = scoreOpportunityHeuristic({
    id: 'noise-1',
    company: '字节跳动',
    title: 'LLM Agent算法工程师 - Commercial AI',
    location: '上海',
    jd: '负责大模型 Agent、LLM 算法研发与商业化应用落地。',
  }, profile)
  const llmPretrainJob = scoreOpportunityHeuristic({
    id: 'noise-2',
    company: '米哈游',
    title: 'LLM预训练数据算法研究员 (Agentic Models) -基模',
    location: '上海',
    jd: '负责大模型预训练数据合成、强化学习与多模态基模研究。',
  }, profile)
  const taDreamJob = scoreOpportunityHeuristic({
    id: 'dream-ta',
    company: '米哈游',
    title: '高级技术美术（UE5 / 实时渲染 / 数字人）',
    location: '上海',
    jd: '负责 UE5 实时渲染管线、Houdini 程序化生成、MetaHuman 数字人与 AI 工具链研发。',
  }, profile)

  assert.ok(llmAgentJob.score <= 48, `Off-topic LLM Agent job must be capped <= 48, got ${llmAgentJob.score}`)
  assert.ok(llmPretrainJob.score <= 48, `Off-topic LLM Pretraining job must be capped <= 48, got ${llmPretrainJob.score}`)
  assert.notEqual(llmAgentJob.tier, 'good')
  assert.notEqual(llmAgentJob.tier, 'top')
  assert.equal(taDreamJob.tier, 'top')
  assert.ok(taDreamJob.score >= 80, `Matched TA role must score >= 80, got ${taDreamJob.score}`)
  const noiseSum = llmAgentJob.breakdown.reduce((acc, row) => acc + row.delta, 0)
  assert.equal(Math.max(5, Math.min(96, noiseSum)), llmAgentJob.score, 'Guardrail breakdown must still sum cleanly to score')
})

test('dynamic resume extraction works for non-internet industries (e.g. Chip Verification) without hardcoded tech dictionaries', () => {
  const chipProfile = buildPatrolSearchProfile({
    resumeText: '# 候选人\n## 专业技能\n- SystemVerilog、UVM、FPGA、RTL 验证、时序收敛、芯片验证\n',
    goal: '上海芯片验证工程师',
    searchTerms: ['芯片验证', 'UVM'],
  })
  assert.ok(chipProfile.resumeKeywords.some(k => /SystemVerilog/i.test(k)))
  assert.ok(chipProfile.resumeKeywords.some(k => /FPGA/i.test(k)))
  const chipJob = scoreOpportunityHeuristic({
    id: 'chip-1',
    company: '某芯片公司',
    title: '高级芯片验证工程师（UVM / SystemVerilog）',
    location: '上海',
    jd: '负责 SoC RTL 级芯片验证，熟练使用 SystemVerilog、UVM 和 FPGA 原型验证。',
  }, chipProfile)
  assert.equal(chipJob.tier, 'top')
  assert.ok(chipJob.score >= 80)
})

test('scoreOpportunityHeuristic elevates true semantic matches (even without literal title match) and filters noise', () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '找上海的 Senior AI Infra / 大模型推理工程师，不看外包',
    searchTerms: ['AI Infra', '上海'],
    evidence: [],
    feedback: {},
  })

  // 1. Semantic match whose title does NOT literally contain "AI Infra" — old engine dropped it!
  const semanticDream = scoreOpportunityHeuristic({
    id: 'job-1',
    company: '字节跳动',
    title: '大模型推理引擎与 GPU 调度专家',
    location: '上海',
    jd: '负责千卡 GPU 集群推理加速、vLLM 引擎优化及 Kubernetes 异构算力调度平台建设。',
  }, profile)

  // 2. Classic noise that used to match literal "上海" + "AI"!
  const noisySales = scoreOpportunityHeuristic({
    id: 'job-2',
    company: '某科技',
    title: 'AI 大客户销售代表',
    location: '上海',
    jd: '负责上海地区 AI 产品销售拓展与大客户商务谈判。',
  }, profile)

  // 3. Intern mismatch for experienced candidate
  const internRole = scoreOpportunityHeuristic({
    id: 'job-3',
    company: '某厂',
    title: 'AI Infra 暑期实习生',
    location: '上海',
    jd: '协助团队维护测试脚本。',
  }, profile)

  assert.equal(semanticDream.tier, 'top')
  assert.ok(semanticDream.score >= 76, `Expected top score >= 76, got ${semanticDream.score}`)
  assert.match(semanticDream.reason, /GPU|推理|上海/)

  assert.equal(noisySales.tier, 'skip')
  assert.ok(noisySales.score < 40, `Expected noise score < 40, got ${noisySales.score}`)

  assert.equal(internRole.tier, 'skip')

  // 4. Transparent score breakdown adds up to clamped score, and pure PM role gets down-ranked for engineer profile
  assert.ok(Array.isArray(semanticDream.breakdown) && semanticDream.breakdown.length >= 5)
  const sum = semanticDream.breakdown.reduce((acc, row) => acc + row.delta, 0)
  assert.equal(Math.max(5, Math.min(96, sum)), semanticDream.score)

  const pmRole = scoreOpportunityHeuristic({
    id: 'job-pm',
    company: '某海外科技',
    title: 'Product Manager - Administration & Governance',
    location: 'Remote',
    jd: 'Lead enterprise administration, governance workflows, AI platform compliance, and roadmap.',
  }, profile)
  assert.ok(pmRole.score < 64, `Expected pure PM role for engineer profile to score below good (<64), got ${pmRole.score}`)
  assert.ok(pmRole.breakdown.some(row => row.key === 'penalty' && row.delta < 0))
})

test('negative user feedback teaches profile to down-rank disliked company and direction', () => {
  const baseProfile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发',
    searchTerms: ['AI Infra'],
    feedback: {},
  })
  const learnedProfile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发',
    searchTerms: ['AI Infra'],
    feedback: {
      'old-job': { status: 'dismissed', reason: 'company', company: '旧东家科技', title: '平台研发', location: '上海' },
    },
  })

  const job = {
    id: 'new-job',
    company: '旧东家科技',
    title: 'AI Infra 平台研发工程师',
    location: '上海',
    jd: '负责 Kubernetes 与 GPU 调度平台研发。',
  }
  const before = scoreOpportunityHeuristic(job, baseProfile)
  const after = scoreOpportunityHeuristic(job, learnedProfile)
  assert.ok(after.score < before.score - 20, `Expected feedback penalty (${before.score} -> ${after.score})`)
  assert.match(after.caution, /暂不看该公司/)
})

test('triageBatchWithLlm merges validated LLM verdicts and falls back cleanly on missing items', async () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra'],
  })
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: [
              { id: 'j1', score: 93, tier: 'top', reason: '和你千卡 GPU 推理经验高度契合', caution: '' },
            ],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }

  const results = await triageBatchWithLlm({
    llm,
    config: { model: 'mock:fast', sendToModel: true },
    profile,
    resumeText: RESUME,
    jobs: [
      { id: 'j1', company: 'MiniMax', title: '推理引擎工程师', location: '上海', jd: 'vLLM / GPU / CUDA' },
      { id: 'j2', company: '测试', title: '行政专员', location: '北京', jd: '前台接待' },
    ],
  })

  const r1 = results.find(r => r.opportunityId === 'j1')
  const r2 = results.find(r => r.opportunityId === 'j2')
  assert.equal(r1.mode, 'llm')
  assert.equal(r1.score, 93)
  assert.equal(r1.tier, 'top')
  assert.equal(r2.mode, 'heuristic')
  assert.equal(r2.tier, 'skip')
})

test('rebaseTailoredResume syncs master delta into drifted branch and clears masterBehind', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-rebase-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new CareerStore({ file: join(dir, 'career.json'), now: () => new Date('2026-11-21T04:00:00.000Z') })
  await store.authorizeSource({ id: 'manual', projects: ['personal'] })
  const { evidence: [ev] } = await store.ingestEvents([{
    id: 'ev-new', sourceId: 'manual', projectId: 'personal', kind: 'manual',
    occurredAt: '2026-11-21T03:30:00.000Z',
    evidence: [{ title: '闲置 GPU 回收', text: '落地闲置 GPU 自动回收机制，月度算力成本降低 22%。' }],
  }], { explicitManual: true })
  await store.reviewEvidence(ev.id, { action: 'approve', shareable: true })

  // Master v1
  const m1 = await store.importResume({ title: '通用简历', text: RESUME })
  await store.reviewResume(m1.id, { action: 'approve' })

  // Job tailored branch based on Master v1
  const branch = await store.proposeTailoredResume({
    baseId: m1.id,
    opportunityId: 'opp-bytedance',
    title: '字节跳动 · AI Infra',
    lines: [{
      source: '- 主导千卡 GPU 异构算力调度平台与 vLLM 推理引擎建设，吞吐提升 2.4 倍。',
      text: '主导千卡 GPU 异构调度与 vLLM 推理引擎重构，吞吐提升 2.4 倍（字节定向突出）。',
      reason: '贴合字节推理集群诉求',
    }],
  })
  await store.reviewResume(branch.id, { action: 'approve' })

  // Master evolves to v2 with new achievement
  const m2Text = RESUME.replace(
    '- 基于 Kubernetes 与 Prometheus 落地多租户配额治理和可观测告警体系。',
    '- 基于 Kubernetes 与 Prometheus 落地多租户配额治理和可观测告警体系。\n- 落地闲置 GPU 自动回收机制，月度算力成本降低 22%。',
  )
  const m2 = await store.proposeResume({
    title: '简历更新',
    baseId: m1.id,
    items: [{ text: ev.text, evidenceIds: [ev.id] }],
    mergedText: m2Text,
  })
  await store.reviewResume(m2.id, { action: 'approve' })

  // Before rebase: branch must be flagged as masterBehind!
  const beforeTree = organizeResumeVersions((await store.summary()).resumes, {
    opportunities: [{ id: 'opp-bytedance', company: '字节跳动', title: 'AI Infra' }],
  })
  assert.equal(beforeTree.branches[0].head.masterBehind, true)

  // Execute rebase (offline structural fallback)
  const rebased = await rebaseTailoredResume({
    llm: null,
    config: {},
    branchMarkdown: await store.exportResume(branch.id),
    latestMasterMarkdown: await store.exportResume(m2.id),
    prevMasterMarkdown: await store.exportResume(m1.id),
    company: '字节跳动',
    jobTitle: 'AI Infra',
  })
  assert.ok(rebased.markdown.includes('字节定向突出'), 'Must preserve JD-specific tailoring!')
  assert.ok(rebased.markdown.includes('落地闲置 GPU 自动回收机制'), 'Must sync new master bullet!')

  const saved = await store.rebaseTailoredResume({
    branchId: branch.id,
    newBaseId: m2.id,
    text: rebased.markdown,
    summary: rebased.summary,
    placements: rebased.placements,
  })
  await store.reviewResume(saved.id, { action: 'approve' })

  const afterTree = organizeResumeVersions((await store.summary()).resumes, {
    opportunities: [{ id: 'opp-bytedance', company: '字节跳动', title: 'AI Infra' }],
  })
  assert.equal(afterTree.branches[0].head.masterBehind, false, 'masterBehind must clear after rebase!')
  assert.equal(afterTree.branches[0].head.changeLabel, '同步主干')
})

test('explicit US search ranks San Francisco above unspecified remote and Singapore', () => {
  for (const goal of ['我想找美国的 GPU 推理岗位', 'GPU inference in the US', 'GPU inference in USA']) {
    const profile = buildPatrolSearchProfile({goal, searchTerms: ['GPU'], resumeText: '', evidence: [], feedback: {}})
    const match = location => scoreOpportunityHeuristic({id: location, company: 'Inferact', title: 'GPU Inference Engineer', location, jd: ''}, profile)
    const results = ['San Francisco', 'Remote', 'Singapore'].map(match)
    assert.deepEqual(results.map(result => result.breakdown.find(row => row.key === 'location').delta), [12, 0, -10])
    assert.ok(results[0].score > results[2].score)
  }
})

test('host exposes empty derivedSynonyms, persists dismissedTerms, and filters opt-in LLM suggestedTerms', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-optin-terms-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const observedPrompts = []
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'fast' }] }],
      resolveModel: () => ({ providerId: 'mock', modelId: 'fast' }),
      async *stream(req) {
        observedPrompts.push(JSON.stringify(req))
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            directions: [{ label: '实时图形引擎', query: '上海 UE5 实时渲染与数字人团队', basis: '基于你的技术美术目标' }],
            keywords: ['着色器', 'HLSL', '技美', '数字人'],
          }),
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
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const getState = async () => (await harness.call('GET', '/api/career-agent/state')).json

  // 1. Configure Technical Artist terms; derivedSynonyms MUST be empty []
  const cfgRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      goal: '上海技术美术 / AI 3D',
      searchTerms: ['技术美术', 'UE5', '数字人'],
    },
  })
  assert.equal(cfgRes.status, 200)
  const s1 = await getState()
  assert.deepEqual(s1.patrolProfile.derivedSynonyms, [])
  assert.deepEqual(s1.patrolProfile.expandedQueries, ['技术美术', 'UE5', '数字人'])
  assert.deepEqual(s1.patrolProfile.suggestedTerms, [], 'No hardcoded suggestions when offline / before opt-in AI call')

  // 2. Opt-in AI suggestion returns LLM-anchored keywords excluding existing searchTerms ("数字人")
  const sugRes = await harness.call('POST', '/api/career-agent/suggest-directions', {
    goal: '上海技术美术 / AI 3D',
    searchTerms: ['技术美术', 'UE5', '数字人'],
    explicitInteractive: true,
    model: 'mock:fast',
  })
  assert.equal(sugRes.status, 200)
  assert.deepEqual(sugRes.json.result.keywords, ['着色器', 'HLSL', '技美'])

  // 3. Dismissing "技美" persists in config.dismissedTerms and removes it from patrolProfile.suggestedTerms
  const dismissRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { dismissedTerms: ['技美'] },
  })
  assert.equal(dismissRes.status, 200)
  const s3 = await getState()
  assert.deepEqual(s3.config.dismissedTerms, ['技美'])
  assert.deepEqual(s3.patrolProfile.suggestedTerms, ['着色器', 'HLSL'])
  assert.deepEqual(s3.patrolProfile.derivedSynonyms, [])

  // 4. Accepting a previously dismissed term into searchTerms removes it from dismissedTerms cleanly
  const acceptRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { searchTerms: ['技术美术', 'UE5', '数字人', '技美'] },
  })
  assert.equal(acceptRes.status, 200)
  const s4 = await getState()
  assert.deepEqual(s4.config.dismissedTerms, [])
  assert.ok(s4.config.searchTerms.includes('技美'))
})

test('patrol query rotation uses filtered effectiveQueries and never leaks avoidHints to ATS boards across cycles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-avoid-rotation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  const originalFetch = globalThis.fetch
  const observedKeywords = []
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url)
    if (u.endsWith('/csrf/token')) {
      return Response.json({ data: { token: 'mock-csrf' } })
    }
    if (u.includes('/api/v1/search/job/posts')) {
      const body = JSON.parse(String(options.body || '{}'))
      if (typeof body.keyword === 'string') observedKeywords.push(body.keyword)
      return Response.json({ code: 0, data: { job_post_list: [] } })
    }
    return originalFetch(url, options)
  }
  t.after(() => { globalThis.fetch = originalFetch })

  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'fast' }] }],
      resolveModel: () => ({ providerId: 'mock', modelId: 'fast' }),
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            directions: [{ label: '实时渲染', query: '上海 UE5 技术美术', basis: '基于你的目标' }],
            keywords: ['Agent', '着色器', 'HLSL'],
          }),
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
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const eightTerms = ['技术美术', 'UE5', 'Houdini', 'MetaHuman', '数字人', '实时渲染', 'AI 3D', 'Agent']
  const cfg = await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      goal: '上海技术美术，不看 Agent',
      searchTerms: eightTerms,
      boards: [{ provider: 'feishu', slug: 'agibot', company: '智元机器人' }],
    },
  })
  assert.equal(cfg.status, 200)

  const state = (await harness.call('GET', '/api/career-agent/state')).json
  assert.ok(state.patrolProfile.avoidHints.some(h => /agent/i.test(h)))
  assert.equal(state.patrolProfile.effectiveQueries.length, 7)
  assert.ok(!state.patrolProfile.effectiveQueries.some(q => /^agent$/i.test(q)))
  assert.ok(!state.patrolProfile.expandedQueries.some(q => /^agent$/i.test(q)))

  // Run 4 full board patrol cycles so queryRotation steps across the entire filtered tail
  for (let i = 0; i < 4; i += 1) {
    const runRes = await harness.call('POST', '/api/career-agent/action', {
      action: 'run',
      scope: 'boards',
      manual: true,
    })
    assert.equal(runRes.status, 200)
  }

  assert.ok(observedKeywords.length > 0, 'Mock ATS board must have received keyword queries')
  assert.ok(!observedKeywords.some(k => /agent/i.test(k)), `Excluded avoidHint "Agent" must NEVER be sent to ATS board, saw: ${JSON.stringify(observedKeywords)}`)
  assert.ok(observedKeywords.includes('技术美术'), 'Anchor term must be sent')
  assert.ok(observedKeywords.includes('AI 3D'), `7th filtered term "AI 3D" should still rotate into ATS queries, saw: ${JSON.stringify(observedKeywords)}`)

  // Also ensure opt-in AI keyword suggestions never surface an excluded avoidHint
  const sugRes = await harness.call('POST', '/api/career-agent/suggest-directions', {
    goal: '上海技术美术，不看 Agent',
    searchTerms: ['技术美术', 'UE5'],
    explicitInteractive: true,
    model: 'mock:fast',
  })
  assert.equal(sugRes.status, 200)
  assert.ok(!sugRes.json.result.keywords.some(k => /agent/i.test(k)))
  assert.deepEqual(sugRes.json.result.keywords, ['着色器', 'HLSL'])
})

test('responsibility-first scoring ranks genuine target roles above off-role research jobs that only match tool words or partner mentions', () => {
  const taResume = `# 候选人
_资深技术美术 Technical Artist · 上海_
## 专业技能
- UE5、Houdini、MetaHuman、Shader、实时渲染、数字人、AI 3D、Python
## 工作经历
### 某互动娱乐工作室 · 高级技术美术（2021.05 – 至今）
- 主导 UE5 实时渲染管线、Houdini 程序化资产与 MetaHuman 数字人落地。
`
  const profiles = [
    buildPatrolSearchProfile({
      resumeText: taResume,
      goal: '上海技术美术 / AI 3D / UE5',
      searchTerms: ['技术美术', 'Technical Artist', 'TA', 'AI 3D', 'UE5', 'Houdini', 'MetaHuman', 'Shader'],
    }),
    buildPatrolSearchProfile({
      resumeText: taResume,
      goal: '上海技术美术 / AI 3D / UE5',
      searchTerms: [],
    }),
  ]

  for (const profile of profiles) {
    const dreamTa = scoreOpportunityHeuristic({
      id: 'ta-dream',
      company: '某游戏厂',
      title: '高级技术美术（UE5 / 实时渲染 / 数字人）',
      location: '上海',
      jd: '负责 UE5 实时渲染管线、Houdini 程序化工具、MetaHuman 数字人与 AI 3D 工具链研发。',
    }, profile)

    const coreTa = scoreOpportunityHeuristic({
      id: 'ta-core',
      company: '某互动娱乐',
      title: '技术美术工程师',
      location: '上海',
      jd: '负责项目美术管线开发、场景材质效果落地与客户端渲染性能优化。',
    }, profile)

    const llmResearchCollab = scoreOpportunityHeuristic({
      id: 'llm-collab',
      company: '某大模型实验室',
      title: '大模型预训练算法研究员（UE5 / AI 3D 方向）',
      location: '上海',
      jd: '主要职责：负责基础大模型和 AI 3D 生成模型的训练与维护；熟悉 UE5、Houdini、Shader、Python，与技术美术协作验证生成效果。',
    }, profile)

    const llmResearchFamiliar = scoreOpportunityHeuristic({
      id: 'llm-familiar',
      company: '某大模型实验室',
      title: '大模型训练研究员（UE5 / AI 3D）',
      location: '上海',
      jd: '主要职责：负责大模型的训练和维护。任职要求：熟悉 UE5、AI 3D、Houdini，了解技术美术管线者优先。',
    }, profile)

    const llmResearchService = scoreOpportunityHeuristic({
      id: 'llm-service',
      company: '某大模型实验室',
      title: '多模态大模型算法工程师',
      location: '上海',
      jd: '负责多模态大模型训练和维护，使用 UE5 与 MetaHuman 评测数据，为技术美术团队提供模型能力。',
    }, profile)

    assert.equal(dreamTa.tier, 'top')
    assert.ok(dreamTa.score >= 85, `Expected dream TA >= 85, got ${dreamTa.score}`)
    assert.equal(coreTa.tier, 'good')
    assert.ok(coreTa.score >= 64, `Expected core TA >= 64, got ${coreTa.score}`)

    for (const offRole of [llmResearchCollab, llmResearchFamiliar, llmResearchService]) {
      assert.ok(offRole.score <= 54, `Off-role "${offRole.opportunityId}" must stay <= 54, got ${offRole.score}`)
      assert.ok(coreTa.score > offRole.score, `Genuine TA (${coreTa.score}) must outrank off-role "${offRole.opportunityId}" (${offRole.score})`)
      assert.ok(!['top', 'good'].includes(offRole.tier), `Off-role "${offRole.opportunityId}" must not enter top/good, got ${offRole.tier}`)
      const sum = offRole.breakdown.reduce((acc, row) => acc + row.delta, 0)
      assert.equal(Math.max(5, Math.min(96, sum)), offRole.score, `Breakdown must sum cleanly to score for ${offRole.opportunityId}`)
    }
  }

  // User-confirmed 2-word English role shorthand ("Technical Artist" + "TA") also gets primary role credit
  const taAcronym = scoreOpportunityHeuristic({
    id: 'ta-acronym',
    company: '某厂',
    title: '高级 TA（UE5 / 数字人）',
    location: '上海',
    jd: '负责 UE5 数字人与 Shader 效果研发。',
  }, profiles[0])
  assert.equal(taAcronym.tier, 'top')
  assert.ok(taAcronym.score >= 80, `Confirmed TA acronym should score >= 80, got ${taAcronym.score}`)

  // Qualification/experience-requirement mention in an off-role research JD must NOT beat genuine TA
  const heavyResume = 'Unreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation\nUnreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation'
  const qualProfile = buildPatrolSearchProfile({
    goal: '上海技术美术，方向是 AI 3D / UE5',
    searchTerms: ['技术美术', 'UE5', 'AI 3D', '数字人', '着色器'],
    resumeText: heavyResume,
  })
  const qualResearch = scoreOpportunityHeuristic({
    id: 'llm-qual-3yr',
    company: '示例公司',
    title: 'UE5 大模型推理算法研究员（资历版）',
    location: '上海',
    jd: `训练和维护 AI 3D 大语言模型，研发数字人算法。使用 ${heavyResume} 做测试。岗位要求：3年以上技术美术相关工作经验。`,
  }, qualProfile)
  const jdOnlyOffTitle = scoreOpportunityHeuristic({
    id: 'llm-jd-only',
    company: '示例公司',
    title: 'UE5 大模型推理算法研究员',
    location: '上海',
    jd: `训练和维护 AI 3D 大语言模型，研发数字人算法。使用 ${heavyResume} 做测试。参与技术美术流程评测。`,
  }, qualProfile)
  const realTaSimple = scoreOpportunityHeuristic({
    id: 'real-ta-simple',
    company: '示例公司',
    title: '技术美术工程师',
    location: '上海',
    jd: '负责资产验收和实时材质调优。',
  }, qualProfile)
  assert.ok(realTaSimple.score >= 66 && realTaSimple.tier === 'good')
  assert.ok(qualResearch.score <= 54 && !['top', 'good'].includes(qualResearch.tier), `3-year qualification off-role must stay <= 54, got ${qualResearch.score}`)
  assert.ok(jdOnlyOffTitle.score <= 62 && !['top', 'good'].includes(jdOnlyOffTitle.tier), `Title-less JD-only off-role must stay <= 62, got ${jdOnlyOffTitle.score}`)
  assert.ok(realTaSimple.score > qualResearch.score && realTaSimple.score > jdOnlyOffTitle.score)

  // Bilingual city matching ("in Shanghai" matches "上海") and non-tech occupation suffix ("摄影师")
  const enProfile = buildPatrolSearchProfile({
    goal: 'Looking for a Technical Artist role in Shanghai',
    searchTerms: ['Technical Artist', 'TA', 'UE5', 'AI 3D', 'Shader'],
    resumeText: heavyResume,
  })
  const enTaCnCity = scoreOpportunityHeuristic({
    id: 'en-ta-cn-city',
    company: '样本公司',
    title: 'Unreal Engine Technical Artist',
    location: '上海',
    jd: 'Shader development, DCC tools, profiling and game assets.',
  }, enProfile)
  const enResearch3Yr = scoreOpportunityHeuristic({
    id: 'en-res-3yr',
    company: '样本公司',
    title: 'UE5 AI 3D Research Scientist',
    location: '上海',
    jd: 'Train and maintain language models. Required: 3 years of experience as a Technical Artist and experience with UE5 Shader pipelines.',
  }, enProfile)
  assert.ok(enTaCnCity.score >= 75 && ['top', 'good'].includes(enTaCnCity.tier), `Bilingual city match should elevate EN TA in 上海, got ${enTaCnCity.score}`)
  assert.ok(enResearch3Yr.score <= 54 && enTaCnCity.score > enResearch3Yr.score)

  const petProfile = buildPatrolSearchProfile({ goal: '转型宠物摄影师', searchTerms: ['宠物摄影师', '摄影', '修图'] })
  const petPhotog = scoreOpportunityHeuristic({ id: 'pet-1', company: '样本', title: '宠物摄影师', location: '上海', jd: '负责拍摄和图像后期。' }, petProfile)
  const posterDesigner = scoreOpportunityHeuristic({ id: 'pet-2', company: '样本', title: '海报设计师', location: '上海', jd: '制作物料及广告，熟悉摄影和修图。' }, petProfile)
  assert.ok(petPhotog.score >= 66 && petPhotog.score > posterDesigner.score)
})

test('triage-jobs preserves explicit exclusions and off-role caps after LLM merge while allowing genuine & cross-language elevation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-llm-guardrails-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        const { jobs } = JSON.parse(req.messages[0].content[0].text)
        const items = jobs.map(j => ({
          id: j.id,
          score: j.title === '技术美术工程师' ? 85 : (j.title === 'Unreal Engine Technical Artist' ? 88 : 94),
          tier: 'top',
          reason: '完全对口',
        }))
        yield { type: 'text-delta', text: JSON.stringify({ items }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    llm,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const action = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  const getState = async () => (await harness.call('GET', '/api/career-agent/state')).json

  await action({
    action: 'configure',
    config: {
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海技术美术，方向是 AI 3D / UE5，排除外包',
      searchTerms: ['技术美术', 'UE5', 'AI 3D', '数字人', '着色器'],
    },
  })
  const resume = await action({
    action: 'resume-import',
    title: 'QA Master',
    text: '# QA Synthetic\n\n## Skills\n- Unreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation',
  })
  await action({ action: 'resume-review', id: resume.id, decision: 'approve' })

  for (const job of [
    { title: 'UE5 大模型推理算法研究员', jd: '训练和维护 AI 3D 大语言模型，研发数字人算法。使用 Unreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation 做测试，与技术美术团队合作。' },
    { title: '技术美术工程师', jd: '负责资产验收和实时材质调优。' },
    { title: 'UE5 技术美术工程师', jd: '本岗位为外包驻场' },
    { title: 'Unreal Engine Technical Artist', jd: 'Shader development, DCC tools, profiling and game assets.' },
  ]) {
    await action({ action: 'job-add', job: { ...job, company: '示例公司', location: '上海' } })
  }

  const triageRes = await action({ action: 'triage-jobs' })
  assert.equal(triageRes.mode, 'llm')
  const byTitle = new Map((await getState()).opportunities.map(o => [o.title, o.match]))

  const outsourced = byTitle.get('UE5 技术美术工程师')
  assert.equal(outsourced.tier, 'skip', 'Explicit avoidHint (排除外包) must remain skip after LLM triage')
  assert.ok(outsourced.score <= 39, `Outsourced job must stay <= 39, got ${outsourced.score}`)
  assert.match(outsourced.caution, /外包/)

  const offRole = byTitle.get('UE5 大模型推理算法研究员')
  assert.ok(offRole.score <= 54 && !['top', 'good'].includes(offRole.tier), `Off-role research job must remain capped <= 54 after LLM triage, got ${offRole.score} (${offRole.tier})`)

  const coreTa = byTitle.get('技术美术工程师')
  assert.equal(coreTa.score, 85)
  assert.equal(coreTa.tier, 'top')

  const enTa = byTitle.get('Unreal Engine Technical Artist')
  assert.equal(enTa.score, 88)
  assert.equal(enTa.tier, 'top', 'Genuine cross-language LLM elevation must still be allowed')
})

test('outsourcing exclusion uses conservative offline labels and verifies verbatim AI quotes in the same batched triage call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-outsource-ai-quote-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const observedPayloads = []
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        const payload = JSON.parse(req.messages[0].content[0].text)
        observedPayloads.push(payload)
        const items = payload.jobs.map(j => {
          if (j.title.includes('逗号后接负责')) {
            return {
              id: j.id,
              score: 92,
              tier: 'top',
              reason: '技术栈契合',
              employmentType: 'outsourced',
              employmentQuote: '入职后与第三方公司签订劳动合同',
            }
          }
          if (j.title.includes('外包供应商管理字段')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'direct_hire',
              employmentQuote: '公司直签，非外包',
            }
          }
          if (j.title.includes('派遣用工')) {
            return {
              id: j.id,
              score: 92,
              tier: 'top',
              reason: '技术栈契合',
              employmentType: 'outsourced',
              employmentQuote: '劳务派遣用工',
            }
          }
          if (j.title.includes('代签用工合同职责')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '与外包服务商签订用工合同',
            }
          }
          if (j.title.includes('代表公司签劳动合同')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '与外包服务商签订劳动合同',
            }
          }
          if (j.title.includes('三方劳动合同') || j.title.includes('长JD尾部外包') || j.title.includes('换行列表尾部外包')) {
            return {
              id: j.id,
              score: 92,
              tier: 'top',
              reason: '技术栈契合',
              employmentType: 'outsourced',
              employmentQuote: '本岗位与外包服务商签订劳动合同',
            }
          }
          if (j.title.includes('供应商误引')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '本岗位需要与外包供应商进行沟通', // True vendor-collab quote -> must be rejected!
            }
          }
          if (j.title.includes('截断否定')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '外包', // Clipped from "非外包岗位" -> complete sentence check must reject!
            }
          }
          if (j.title.includes('幻觉引用')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '本岗位为第三方外包', // NOT in JD -> must be rejected!
            }
          }
          if (j.title.includes('否定引用')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '非外包岗位', // Negated quote -> must be rejected!
            }
          }
          if (j.title.includes('无关引用')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'outsourced',
              employmentQuote: '负责 UE5 材质开发', // Unrelated duty quote -> must be rejected!
            }
          }
          if (j.title.includes('证据模糊')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签岗位',
              employmentType: 'unknown',
              employmentQuote: '',
            }
          }
          if (j.title.includes('直签')) {
            return {
              id: j.id,
              score: 90,
              tier: 'top',
              reason: '直签且职责对口',
              employmentType: 'direct_hire',
              employmentQuote: '全职直签，非外包岗位',
            }
          }
          return {
            id: j.id,
            score: 90,
            tier: 'top',
            reason: '直签且实际职责符合目标',
            employmentType: 'unknown',
            employmentQuote: '',
          }
        })
        yield { type: 'text-delta', text: JSON.stringify({ items }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    llm,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const action = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  const getState = async () => (await harness.call('GET', '/api/career-agent/state')).json

  await action({
    action: 'configure',
    config: {
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海技术美术，方向是 AI 3D / UE5，排除外包',
      searchTerms: ['技术美术', 'UE5', 'AI 3D', '数字人', '着色器'],
    },
  })

  const longFiller = '负责 UE5 材质、着色器与实时渲染管线研发，参与数字人资产规范建设与性能剖析。'.repeat(13)
  const longTailJd = `${longFiller}与外包供应商沟通。${'协助推进美术工具链自动化与跨团队研发效率提升。'.repeat(20)} 补充说明：本岗位与外包服务商签订劳动合同。`
  const newlineBulletJd = Array.from({ length: 34 }, (_, i) => `- 负责 UE5 材质、着色器与 3D 美术资产管线，并与研发团队一起优化画面 ${i}`).join('\n') + '\n本岗位与外包服务商签订劳动合同。'

  const dispatchJobs = [
    { title: 'UE5 技术美术工程师（派遣用工字段）', jd: '用工形式：劳务派遣用工。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（派遣用工声明）', jd: '本岗位为劳务派遣用工，与第三方派遣公司签订劳动合同。负责 UE5 材质和着色器。' },
  ]
  const jobs = [
    { title: 'UE5 技术美术工程师（直签）', jd: '全职直签，非外包岗位。负责 UE5 材质、着色器和资产管线。' },
    { title: 'UE5 技术美术工程师（外包供应商管理字段）', jd: '岗位类型：外包供应商管理。公司直签，非外包。负责 UE5 材质、着色器和资产管线。' },
    { title: 'UE5 技术美术工程师（供应商误引）', jd: '本岗位需要与外包供应商进行沟通。本岗位与公司直接签订劳动合同，负责 UE5 资产管线和着色器开发。' },
    { title: 'UE5 技术美术工程师（代签用工合同职责）', jd: '负责为外包人员办理入职，与外包服务商签订用工合同。公司直签，非外包。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（代表公司签劳动合同）', jd: '负责代表公司与外包服务商签订劳动合同。公司直签，非外包。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（截断否定）', jd: '公司直签，非外包岗位。负责 UE5 材质、着色器和 3D 资产管线。' },
    { title: 'UE5 技术美术工程师（客户现场驻场）', jd: '本岗位为公司直签，项目执行期间需到客户现场驻场。负责 UE5 材质、着色器和 3D 资产管线。' },
    { title: 'UE5 技术美术工程师（外包驻场经验）', jd: '具备外包驻场经验。本岗位与公司直接签订劳动合同。负责 UE5 材质、着色器和 3D 资产管线。' },
    { title: 'UE5 技术美术工程师（幻觉引用）', jd: '负责 UE5 材质、着色器和 3D 资产管线。公司正式编制。' },
    { title: 'UE5 技术美术工程师（否定引用）', jd: '全职直签，非外包岗位。负责 UE5 材质开发和着色器。' },
    { title: 'UE5 技术美术工程师（无关引用）', jd: '负责 UE5 材质开发与实时渲染管线。' },
    { title: 'UE5 技术美术工程师（证据模糊）', jd: '负责 UE5 材质、着色器与跨项目交付支持。' },
    { title: 'UE5 技术美术工程师（三方劳动合同）', jd: '本岗位与外包服务商签订劳动合同。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（逗号后接负责）', jd: '入职后与第三方公司签订劳动合同，负责驻场开发。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（长JD尾部外包）', jd: longTailJd },
    { title: 'UE5 技术美术工程师（换行列表尾部外包）', jd: newlineBulletJd },
    { title: 'UE5 技术美术工程师（显式JD标签）', jd: '用工性质：劳务派遣。负责 UE5 材质和着色器。' },
    { title: 'UE5 技术美术工程师（外包）', jd: '负责 UE5 材质和着色器。' },
    ...dispatchJobs,
  ]
  for (const job of jobs) {
    await action({ action: 'job-add', job: { ...job, company: '示例公司', location: '上海' } })
  }

  // 1. Offline / no-model heuristic: conservative explicit labels blocked; prose & direct hires stay eligible
  const before = new Map((await getState()).opportunities.map(o => [o.title, o.match]))
  assert.equal(before.get('UE5 技术美术工程师（显式JD标签）').tier, 'skip')
  assert.equal(before.get('UE5 技术美术工程师（外包）').tier, 'skip')
  for (const { title } of dispatchJobs) {
    assert.equal(before.get(title).tier, 'skip', `${title} must be excluded before AI triage`)
  }
  for (const offlineEligible of [
    'UE5 技术美术工程师（直签）',
    'UE5 技术美术工程师（外包供应商管理字段）',
    'UE5 技术美术工程师（供应商误引）',
    'UE5 技术美术工程师（代签用工合同职责）',
    'UE5 技术美术工程师（代表公司签劳动合同）',
    'UE5 技术美术工程师（截断否定）',
    'UE5 技术美术工程师（客户现场驻场）',
    'UE5 技术美术工程师（外包驻场经验）',
    'UE5 技术美术工程师（三方劳动合同）', // prose left to batched AI with quote verification
    'UE5 技术美术工程师（逗号后接负责）',
    'UE5 技术美术工程师（长JD尾部外包）',
    'UE5 技术美术工程师（换行列表尾部外包）',
  ]) {
    assert.equal(before.get(offlineEligible).tier, 'top', `${offlineEligible} should remain eligible offline`)
  }

  // 2. Reuse existing 10-job batches without a separate employment call.
  const triageRes = await action({ action: 'triage-jobs' })
  assert.equal(triageRes.mode, 'llm')
  const allSentJobs = observedPayloads.flatMap(p => p.jobs)
  assert.equal(observedPayloads.length, Math.ceil(jobs.length / 10), 'Must reuse existing 10-job batches with zero extra model calls')
  assert.equal(allSentJobs.length, jobs.length, 'Each job must be sent exactly once (no second employment-classification pass)')

  // Verify tail-window extraction prioritized the labor-contract sentence in BOTH punctuated and newline-list JDs!
  const sentLongJob = allSentJobs.find(j => j.title.includes('长JD尾部外包'))
  assert.ok(sentLongJob.jd.includes('本岗位与外包服务商签订劳动合同'), `Tail snippet must prioritize labor-contract clause over earlier vendor collab, got: ${sentLongJob.jd}`)
  const sentNewlineJob = allSentJobs.find(j => j.title.includes('换行列表尾部外包'))
  assert.ok(sentNewlineJob.jd.includes('本岗位与外包服务商签订劳动合同'), `Newline-list JD must preserve ending labor-contract clause, got: ${sentNewlineJob.jd}`)

  const after = new Map((await getState()).opportunities.map(o => [o.title, o.match]))

  // Verified AI outsourcing quotes & explicit offline labels MUST be hard-excluded (<=39 / skip)
  for (const blockedTitle of [
    'UE5 技术美术工程师（显式JD标签）',
    'UE5 技术美术工程师（外包）',
    'UE5 技术美术工程师（三方劳动合同）',
    'UE5 技术美术工程师（逗号后接负责）',
    'UE5 技术美术工程师（长JD尾部外包）',
    'UE5 技术美术工程师（换行列表尾部外包）',
    ...dispatchJobs.map(job => job.title),
  ]) {
    const m = after.get(blockedTitle)
    assert.equal(m.tier, 'skip', `${blockedTitle} must be skip after AI triage`)
    assert.ok(m.score <= 39, `${blockedTitle} must be <= 39, got ${m.score}`)
    assert.ok(m.breakdown.some(f => f.hardExclude === true), `${blockedTitle} must mark hardExclude in breakdown`)
  }
  assert.equal(after.get('UE5 技术美术工程师（三方劳动合同）').employment?.type, 'outsourced')
  assert.match(after.get('UE5 技术美术工程师（三方劳动合同）').caution, /本岗位与外包服务商签订劳动合同/)
  assert.equal(after.get('UE5 技术美术工程师（逗号后接负责）').employment?.quote, '入职后与第三方公司签订劳动合同')

  // Direct hires (incl. field "岗位类型：外包供应商管理" & duties processing others' vendor contracts) MUST stay eligible!
  for (const eligibleTitle of [
    'UE5 技术美术工程师（直签）',
    'UE5 技术美术工程师（外包供应商管理字段）',
    'UE5 技术美术工程师（供应商误引）',
    'UE5 技术美术工程师（代签用工合同职责）',
    'UE5 技术美术工程师（代表公司签劳动合同）',
    'UE5 技术美术工程师（截断否定）',
    'UE5 技术美术工程师（客户现场驻场）',
    'UE5 技术美术工程师（外包驻场经验）',
    'UE5 技术美术工程师（幻觉引用）',
    'UE5 技术美术工程师（否定引用）',
    'UE5 技术美术工程师（无关引用）',
    'UE5 技术美术工程师（证据模糊）',
  ]) {
    const m = after.get(eligibleTitle)
    assert.equal(m.tier, 'top', `${eligibleTitle} must stay eligible (top), got ${m.tier} (${m.score})`)
    assert.equal(m.score, 90)
    assert.ok(!m.breakdown.some(f => f.hardExclude === true), `${eligibleTitle} must NOT be hard-excluded`)
  }
  assert.equal(after.get('UE5 技术美术工程师（直签）').employment?.type, 'direct_hire')
  assert.equal(after.get('UE5 技术美术工程师（外包供应商管理字段）').employment?.type, 'direct_hire')
  assert.equal(after.get('UE5 技术美术工程师（幻觉引用）').employment, undefined)
  assert.equal(after.get('UE5 技术美术工程师（供应商误引）').employment, undefined)
  assert.equal(after.get('UE5 技术美术工程师（代签用工合同职责）').employment, undefined)
  assert.equal(after.get('UE5 技术美术工程师（代表公司签劳动合同）').employment, undefined)
  assert.equal(after.get('UE5 技术美术工程师（截断否定）').employment, undefined)

  // 3. Switching UI locale to English preserves skip, hardExclude, employment quote, AND localized avoid reason (0 extra LLM calls!)
  const callsBeforeEn = observedPayloads.length
  const enStateRes = await harness.call('GET', '/api/career-agent/state', undefined, { 'x-career-locale': 'en' })
  assert.equal(enStateRes.status, 200)
  assert.equal(observedPayloads.length, callsBeforeEn, 'Locale switch must not trigger extra LLM calls')
  const enVendorContract = enStateRes.json.opportunities.find(o => o.title === 'UE5 技术美术工程师（三方劳动合同）')?.match
  assert.equal(enVendorContract.tier, 'skip')
  assert.ok(enVendorContract.score <= 39)
  assert.equal(enVendorContract.employment?.quote, '本岗位与外包服务商签订劳动合同')
  assert.ok(enVendorContract.breakdown.some(f => f.hardExclude === true), 'English localized state must preserve hardExclude')
  assert.match(enVendorContract.reason, /avoid filter/i, `English localized skip must preserve avoid reason, got: ${enVendorContract.reason}`)
  assert.match(enVendorContract.caution, /本岗位与外包服务商签订劳动合同/)

  // 4. Editing a job's JD immediately invalidates the stale cached skip & stale quote!
  await action({
    action: 'job-add',
    job: {
      title: 'UE5 技术美术工程师（三方劳动合同）',
      company: '示例公司',
      location: '上海',
      jd: '本岗位与公司直接签订劳动合同，非外包。负责 UE5 材质、着色器与渲染管线。',
    },
  })
  const afterJdFix = (await getState()).opportunities.find(o => o.title === 'UE5 技术美术工程师（三方劳动合同）')?.match
  assert.equal(afterJdFix.mode, 'heuristic', 'Edited JD must invalidate stale LLM cache')
  assert.equal(afterJdFix.tier, 'top', `Corrected direct-hire JD must no longer stay skip, got ${afterJdFix.tier}`)
  assert.equal(afterJdFix.employment, undefined, 'Old outsourcing quote must not survive JD edit')

  // 5. When user does NOT exclude outsourcing, verified AI outsourced employment stays eligible!
  await action({
    action: 'configure',
    config: {
      goal: '上海技术美术，方向是 AI 3D / UE5',
      searchTerms: ['技术美术', 'UE5', 'AI 3D', '数字人', '着色器'],
    },
  })
  await action({ action: 'triage-jobs', force: true })
  const unrestricted = new Map((await getState()).opportunities.map(o => [o.title, o.match]))
  assert.equal(unrestricted.get('UE5 技术美术工程师（长JD尾部外包）').tier, 'top')
  assert.equal(unrestricted.get('UE5 技术美术工程师（长JD尾部外包）').score, 92)
  assert.equal(unrestricted.get('UE5 技术美术工程师（长JD尾部外包）').employment?.type, 'outsourced')
  assert.equal(unrestricted.get('UE5 技术美术工程师（显式JD标签）').tier, 'top')
  for (const { title } of dispatchJobs) {
    assert.equal(unrestricted.get(title).tier, 'top')
    assert.equal(unrestricted.get(title).employment?.quote, '劳务派遣用工')
  }
})

test('natural Chinese/English avoid phrasings filter Agent and saving a new goal clears stale suggestedTerms', async t => {
  for (const goal of ['Shanghai technical artist, no Agent jobs', '上海技术美术，我不想看 Agent 岗位', '上海技术美术，不考虑 Agent 方向']) {
    const p = buildPatrolSearchProfile({ goal, searchTerms: ['技术美术', 'UE5', 'Agent'] })
    assert.ok(p.avoidHints.some(h => /^agent$/i.test(h)), `Expected avoidHints to contain Agent for "${goal}", got ${JSON.stringify(p.avoidHints)}`)
    assert.ok(!p.effectiveQueries.some(q => /^agent$/i.test(q)), `Agent leaked into effectiveQueries for "${goal}": ${JSON.stringify(p.effectiveQueries)}`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'career-stale-suggestions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'fast' }] }],
      resolveModel: () => ({ providerId: 'mock', modelId: 'fast' }),
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            directions: [{ label: '图形渲染', query: '上海 UE5 技术美术', basis: '基于目标' }],
            keywords: ['着色器', 'HLSL'],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { goal: '上海技术美术', searchTerms: ['技术美术', 'UE5'] },
  })
  const sug = await harness.call('POST', '/api/career-agent/suggest-directions', {
    goal: '上海技术美术',
    searchTerms: ['技术美术', 'UE5'],
    explicitInteractive: true,
    model: 'mock:fast',
  })
  assert.equal(sug.status, 200)
  assert.deepEqual((await harness.call('GET', '/api/career-agent/state')).json.patrolProfile.suggestedTerms, ['着色器', 'HLSL'])

  // Save a brand-new goal ("上海会计") — stale shader suggestions MUST be cleared immediately!
  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { goal: '上海会计', searchTerms: ['会计'] },
  })
  assert.deepEqual((await harness.call('GET', '/api/career-agent/state')).json.patrolProfile.suggestedTerms, [])
})
