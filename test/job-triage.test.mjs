import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMissingJdMatch,
  buildPatrolSearchProfile,
  isOpportunityJdIncomplete,
  jobContentFingerprint,
  localizeCachedMatch,
  planTriageBatches,
  resolveCachedJobMatch,
  scoreOpportunityHeuristic,
  selectTriageCandidates,
  triageBatchWithLlm,
} from '../src/job-triage.mjs'
import { apply } from '../src/host.mjs'
import { collectOpportunities, fetchOpportunityDetail } from '../src/opportunities.mjs'
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
  assert.equal(profile.isEngineerProfile, undefined)
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

  assert.ok(semanticDream.score > noisySales.score, `Expected relevant role (${semanticDream.score}) to outrank excluded sales noise (${noisySales.score})`)
  assert.equal(noisySales.tier, 'skip')
  assert.ok(noisySales.score < 40, `Expected noise score < 40, got ${noisySales.score}`)

  assert.equal(internRole.tier, 'skip')
  assert.ok(semanticDream.score > internRole.score)

  // 4. Transparent score breakdown adds up to clamped score, and symmetric scoring ranks target roles above unrelated PM role without engineer-only blacklists
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
  assert.ok(pmRole.score < 64, `Expected off-target PM role to score below good (<64), got ${pmRole.score}`)
  assert.ok(semanticDream.score > pmRole.score)
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
              { id: 'j1', score: 93, tier: 'top', roleQuote: 'vLLM / GPU / CUDA', reason: '和你千卡 GPU 推理经验高度契合', caution: '' },
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
      assert.ok(offRole.score < 64, `Off-role "${offRole.opportunityId}" must stay below good (<64), got ${offRole.score}`)
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
  assert.ok(qualResearch.score < 64 && !['top', 'good'].includes(qualResearch.tier), `3-year qualification off-role must stay below good (<64), got ${qualResearch.score}`)
  assert.ok(realTaSimple.score > qualResearch.score, `Genuine TA (${realTaSimple.score}) must outrank qualification-only off-role (${qualResearch.score})`)

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
  assert.ok(enResearch3Yr.score < 64 && enTaCnCity.score > enResearch3Yr.score)

  const petProfile = buildPatrolSearchProfile({ goal: '转型宠物摄影师', searchTerms: ['宠物摄影师', '摄影', '修图'] })
  const petPhotog = scoreOpportunityHeuristic({ id: 'pet-1', company: '样本', title: '宠物摄影师', location: '上海', jd: '负责拍摄和图像后期。' }, petProfile)
  const posterDesigner = scoreOpportunityHeuristic({ id: 'pet-2', company: '样本', title: '海报设计师', location: '上海', jd: '制作物料及广告，熟悉摄影和修图。' }, petProfile)
  assert.ok(petPhotog.score >= 66 && petPhotog.score > posterDesigner.score)
})

test('triage-jobs enforces explicit exclusions while trusting model primary-duty judgment without heuristic off-role caps', async t => {
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
        const items = jobs.map(j => {
          if (j.title === 'UE5 大模型推理算法研究员') {
            return {
              id: j.id,
              score: 41,
              tier: 'stretch',
              primaryRoleFit: 'mismatch',
              roleQuote: '训练和维护 AI 3D 大语言模型',
              uncertain: false,
              reason: '主责是大模型训练，仅顺带与 TA 团队协作',
            }
          }
          if (j.title === '视觉计算与材质管线工程师') {
            return {
              id: j.id,
              score: 89,
              tier: 'top',
              primaryRoleFit: 'match',
              roleQuote: '负责实时渲染 Shader 与 Houdini 程序化资产管线建设',
              uncertain: false,
              reason: '标题虽未写 TA，主责与渲染/材质管线经历高度契合',
            }
          }
          return {
            id: j.id,
            score: j.title === '技术美术工程师' ? 85 : (j.title === 'Unreal Engine Technical Artist' ? 88 : 94),
            tier: 'top',
            primaryRoleFit: 'match',
            roleQuote: j.jd.slice(0, 28),
            reason: '完全对口',
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
  const resume = await action({
    action: 'resume-import',
    title: 'QA Master',
    text: '# QA Synthetic\n\n## Skills\n- Unreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation',
  })
  await action({ action: 'resume-review', id: resume.id, decision: 'approve' })

  for (const job of [
    { title: 'UE5 大模型推理算法研究员', jd: '训练和维护 AI 3D 大语言模型，研发数字人算法。使用 Unreal Niagara Houdini HLSL shaders Blender rigging rendering material pipeline geometry animation 做测试，与技术美术团队合作。' },
    { title: '视觉计算与材质管线工程师', jd: '负责实时渲染 Shader 与 Houdini 程序化资产管线建设，调优 PBR 材质性能与 DCC 工具链自动化，参与角色光照与数字人画面落地。' },
    { title: '技术美术工程师', jd: '负责资产验收、Shader 开发与实时材质调优，优化 Unreal 渲染管线性能。' },
    { title: 'UE5 技术美术工程师', jd: '本岗位为外包驻场' },
    { title: 'Unreal Engine Technical Artist', jd: 'Shader development, DCC tools, profiling and game assets.' },
  ]) {
    await action({ action: 'job-add', job: { ...job, company: '示例公司', location: '上海' } })
  }

  const unconfirmedForce = await action({ action: 'triage-jobs', force: true })
  assert.equal(unconfirmedForce.skipped, true)
  assert.equal(unconfirmedForce.requiresConfirmation, true)
  const preview = await action({ action: 'triage-preview' })
  // Stage 0 excludes explicit outsource JD ("本岗位为外包驻场") before LLM disclosure/calls
  assert.equal(preview.count, 4)
  assert.ok(preview.confirmToken)
  const triageRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: preview.confirmToken })
  assert.equal(triageRes.mode, 'llm')
  const byTitle = new Map((await getState()).opportunities.map(o => [o.title, o.match]))

  const outsourced = byTitle.get('UE5 技术美术工程师')
  assert.equal(outsourced.tier, 'skip', 'Explicit avoidHint (排除外包) must remain skip after LLM triage')
  assert.ok(outsourced.score <= 39, `Outsourced job must stay <= 39, got ${outsourced.score}`)
  assert.match(outsourced.caution, /外包/)

  const sameTitleDiffDuty = byTitle.get('UE5 大模型推理算法研究员')
  assert.ok(sameTitleDiffDuty.score <= 54 && sameTitleDiffDuty.tier === 'stretch', `Same-title different-duty role must follow model demotion, got ${sameTitleDiffDuty.score} (${sameTitleDiffDuty.tier})`)
  assert.equal(sameTitleDiffDuty.primaryRoleFit, 'mismatch')
  assert.equal(sameTitleDiffDuty.roleQuote, '训练和维护 AI 3D 大语言模型')

  const diffTitleSameDuty = byTitle.get('视觉计算与材质管线工程师')
  assert.equal(diffTitleSameDuty.score, 89, 'Genuine semantic elevation (异名同职责) must NOT be capped by heuristic offRoleCap')
  assert.equal(diffTitleSameDuty.tier, 'top')
  assert.equal(diffTitleSameDuty.primaryRoleFit, 'match')
  assert.ok(diffTitleSameDuty.roleQuote.includes('Houdini'))

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
          const buildRow = () => {
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
          }
          return { roleQuote: j.jd.slice(0, 24), ...buildRow() }
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
  const unconfirmedForce = await action({ action: 'triage-jobs', force: true })
  assert.equal(unconfirmedForce.skipped, true)
  assert.equal(unconfirmedForce.requiresConfirmation, true)
  const expectedLlmEligibleCount = jobs.length - 2 - dispatchJobs.length
  const preview = await action({ action: 'triage-preview' })
  assert.equal(preview.count, expectedLlmEligibleCount, 'Stage 0 explicit outsource labels must be excluded before LLM triage preview')
  assert.ok(preview.confirmToken)
  const triageRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: preview.confirmToken })
  assert.equal(triageRes.mode, 'llm')
  const allSentJobs = observedPayloads.flatMap(p => p.jobs)
  assert.equal(observedPayloads.length, Math.ceil(expectedLlmEligibleCount / 10), 'Must reuse existing 10-job batches with zero extra model calls')
  assert.equal(allSentJobs.length, expectedLlmEligibleCount, 'Each eligible job must be sent exactly once (no second employment-classification pass)')

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
  const prev2 = await action({ action: 'triage-preview' })
  assert.ok(prev2.confirmToken)
  await action({ action: 'triage-jobs', confirmed: true, confirmToken: prev2.confirmToken })
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

test('selectTriageCandidates keeps manual jobs out of fresh queue and reserves discovery slots for low-rule full JDs', () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发，排除外包',
    searchTerms: ['AI Infra', '推理引擎'],
  })
  const activeBoards = new Set(['mockboard:acme'])

  const manualJobs = Array.from({ length: 30 }, (_, i) => ({
    id: `manual:${i}`,
    provider: 'manual',
    sourceId: 'manual',
    company: '手动公司',
    title: 'AI Infra 推理引擎工程师',
    location: '上海',
    jd: '负责 vLLM 推理引擎、CUDA 与千卡调度。'.repeat(4),
    firstSeenAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  const freshHigh = Array.from({ length: 30 }, (_, i) => ({
    id: `board:high-${i}`,
    provider: 'greenhouse',
    sourceId: 'mockboard:acme',
    company: '新招公司',
    title: 'AI Infra 工程师',
    location: '上海',
    jd: '负责 GPU 推理引擎与 Kubernetes 多租户调度平台研发。'.repeat(3),
    verifiedAt: `2026-11-20T00:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  const diffTitleSameDuty = {
    id: 'board:diff-title-discovery',
    provider: 'greenhouse',
    sourceId: 'mockboard:acme',
    company: '星算实验室',
    title: '异构计算运行时专家',
    location: '杭州',
    jd: '主导大模型服务化集群底层的张量并行调度、显存池化与容器冷启动优化，降低千卡训练与在线服务延迟。'.repeat(3),
    verifiedAt: '2026-11-20T12:00:00.000Z',
  }
  assert.ok(scoreOpportunityHeuristic(diffTitleSameDuty, profile).score < 46, 'Fixture should start below heuristic 46 threshold')

  const plan = selectTriageCandidates({
    opportunities: [...manualJobs, ...freshHigh, diffTitleSameDuty],
    activeBoards,
    profile,
    limit: 30,
    force: false,
  })
  assert.equal(plan.candidates.length, 30)
  assert.equal(plan.manualCandidateCount, 0, 'Manual jobs must NEVER crowd out fresh board jobs')
  assert.equal(plan.freshCandidateCount, 30)
  assert.ok(plan.candidates.some(j => j.id === diffTitleSameDuty.id), 'Discovery slots must admit low-rule job with substantive JD')
  assert.ok(!plan.candidates.some(j => j.id.startsWith('manual:')))

  const otherDiscoveryJobs = Array.from({ length: 6 }, (_, index) => ({
    ...diffTitleSameDuty,
    id: `board:discovery-reviewed-${index}`,
  }))
  const existingMatches = Object.fromEntries(otherDiscoveryJobs.map(job => [job.id, {
    mode: 'llm',
    tier: 'top',
    score: 88,
    roleQuote: job.jd.slice(0, 24),
    fingerprint: profile.fingerprint,
    jobFingerprint: jobContentFingerprint(job),
  }]))
  for (const force of [false, true]) {
    const pendingPlan = selectTriageCandidates({
      opportunities: [...freshHigh, ...otherDiscoveryJobs, diffTitleSameDuty],
      activeBoards,
      existingMatches,
      profile,
      force,
    })
    assert.equal(pendingPlan.needsReviewCandidates.length, 30)
    assert.ok(pendingPlan.needsReviewCandidates.includes(diffTitleSameDuty))
    assert.ok(pendingPlan.needsReviewCandidates.every(job => !existingMatches[job.id]))
  }
})

test('planTriageBatches & triageBatchWithLlm send full JDs, run long JDs solo, excerpt only on tight budgets, and aggregate usage metrics', async () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发，排除外包',
    searchTerms: ['AI Infra', '推理引擎'],
  })
  const tailClause = '补充条款：本岗位入职后由第三方外包服务商签订劳动合同。'
  const normalJd = '负责大规模在线推理服务架构设计与集群稳定性治理。'.repeat(28) + tailClause // ~800 chars: full without truncation
  const longSoloJd = Array.from({ length: 56 }, (_, i) => `第${i + 1}段：深入负责分布式 GPU 调度、显存管理、RDMA 通信与服务编排优化工作。`).join('\n\n') + `\n\n${tailClause}` // >= 2400 chars -> solo
  const jobs = [
    { id: 'norm-1', company: '甲公司', title: '系统架构师', location: '上海', jd: normalJd },
    { id: 'norm-2', company: '乙公司', title: '核心研发', location: '上海', jd: '负责云原生执行沙箱与低延迟路由网关建设，持续优化多租户吞吐与可靠性。'.repeat(6) },
    { id: 'long-1', company: '丙公司', title: '长 JD 岗位', location: '上海', jd: longSoloJd },
  ]

  // 1. Spacious DSH model budget: all JDs sent verbatim, long JD in solo batch
  const spaciousPayloads = []
  const metricsSpacious = {}
  const spaciousLlm = {
    listProviders: () => [{ id: 'mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 65_536 }, defaultMaxTokens: 8192 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'large' },
      async *stream(req) {
        const body = JSON.parse(req.messages[0].content[0].text)
        spaciousPayloads.push(body)
        const items = body.jobs.map(j => ({
          id: j.id,
          score: j.id === 'norm-2' ? 88 : 85,
          tier: 'top',
          primaryRoleFit: 'match',
          roleQuote: j.id === 'norm-1'
            ? '负责大规模在线推理服务架构设计与集群稳定性治理'
            : (j.id === 'norm-2' ? '负责云原生执行沙箱与低延迟路由网关建设' : '深入负责分布式 GPU 调度、显存管理'),
          uncertain: false,
          reason: '职责对口',
          employmentType: j.jd.includes('第三方外包服务商签订劳动合同') ? 'outsourced' : 'unknown',
          employmentQuote: j.jd.includes('第三方外包服务商签订劳动合同') ? '第三方外包服务商签订劳动合同' : '',
        }))
        yield { type: 'text-delta', text: JSON.stringify({ items }) }
        yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 180, totalTokens: 1380 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
  const spaciousRes = await triageBatchWithLlm({
    llm: spaciousLlm,
    config: { model: 'mock:large', sendToModel: true },
    jobs,
    profile,
    resumeText: RESUME,
    metricsOut: metricsSpacious,
  })
  assert.equal(spaciousPayloads.length, 2, 'Should split into 1 solo long-JD batch + 1 normal batch')
  const soloBatch = spaciousPayloads.find(b => b.jobs.length === 1)
  assert.ok(soloBatch && soloBatch.jobs[0].id === 'long-1', 'Long JD must run solo first')
  assert.equal(soloBatch.jobs[0].jd.includes('第三方外包服务商签订劳动合同'), true)
  assert.equal(soloBatch.jobs[0].jdTruncated, undefined, 'Spacious budget sends full long JD without excerpting')
  assert.equal(metricsSpacious.llmCalls, 2)
  assert.equal(metricsSpacious.fullJdCount, 3)
  assert.equal(metricsSpacious.excerptedJdCount, 0)
  assert.equal(metricsSpacious.inputTokens, 2400)
  assert.equal(metricsSpacious.outputTokens, 360)
  assert.equal(metricsSpacious.totalTokens, 2760)
  assert.equal(spaciousRes.find(r => r.opportunityId === 'norm-1').tier, 'skip', 'Full-JD tail outsourcing clause caught cleanly')

  // 2. Tight DSH budget (4096 ctx): huge JD must excerpt on paragraph boundary, set jdTruncated=true & uncertain=true
  const hugeBlocks = Array.from({ length: 64 }, (_, i) => `第${i + 1}节职责描述：负责异构基础设施研发、网络加速、容量规划与高可用保障工作，要求扎实的分布式系统功底。`)
  hugeBlocks.push('补充条款：本岗位为劳务派遣外包性质，与第三方签约。')
  const hugeJob = { id: 'huge-1', company: '丁公司', title: '超大 JD 岗位', location: '上海', jd: hugeBlocks.join('\n\n') }
  const { batches: tightBatches } = planTriageBatches({
    jobs: [hugeJob],
    sharedPayload: { candidateGoal: profile.goal },
    systemPrompt: 'system',
    budget: { contextWindow: 4096, maxOutputTokens: 1024 },
  })
  assert.equal(tightBatches.length, 1)
  assert.equal(tightBatches[0].entries[0].truncated, true)
  assert.ok(tightBatches[0].entries[0].item.jd.includes('第三方签约'), 'Paragraph excerption must preserve high-priority tail employment clause')

  const tightRes = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 4096 }, defaultMaxTokens: 1024 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'tiny' },
        async *stream(req) {
          const body = JSON.parse(req.messages[0].content[0].text)
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: body.jobs.map(j => ({
                id: j.id,
                score: 82,
                tier: 'top',
                primaryRoleFit: j.id === 'model-uncertain-1' ? 'uncertain' : 'match',
                roleQuote: j.id === 'badquote-1' ? '原文里完全不存在的职责描述幻觉句子' : (j.id === 'model-uncertain-1' ? '' : '负责异构基础设施研发'),
                uncertain: j.id === 'model-uncertain-1',
                reason: '方向匹配',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:tiny', sendToModel: true },
    jobs: [
      hugeJob,
      { id: 'missing-1', company: '戊公司', title: 'GPU 研发', location: '上海', jd: '' },
      { id: 'model-uncertain-1', company: '庚公司', title: '集群研发', location: '上海', jd: '负责核心基础架构研发与上线。' },
      { id: 'badquote-1', company: '己公司', title: '推理研发', location: '上海', jd: '负责大语言模型服务化集群部署、容器调度与性能监控，与团队协作完成高可用保障。' },
    ],
    profile,
    resumeText: RESUME,
  })
  const hugeEvaluated = tightRes.find(r => r.opportunityId === 'huge-1')
  assert.equal(hugeEvaluated.uncertain, true)
  assert.equal(hugeEvaluated.uncertaintyCode, 'excerpted_jd')
  assert.match(hugeEvaluated.uncertaintyReason, /节选/)

  const missingEvaluated = tightRes.find(r => r.opportunityId === 'missing-1')
  assert.equal(missingEvaluated.uncertain, true)
  assert.equal(missingEvaluated.uncertaintyCode, 'missing_jd')
  assert.match(missingEvaluated.uncertaintyReason, /缺少完整 JD/)

  const modelUncertainEvaluated = tightRes.find(r => r.opportunityId === 'model-uncertain-1')
  assert.equal(modelUncertainEvaluated.uncertain, true)
  assert.equal(modelUncertainEvaluated.uncertaintyCode, 'model_uncertain')

  const badQuoteEvaluated = tightRes.find(r => r.opportunityId === 'badquote-1')
  assert.equal(badQuoteEvaluated.uncertain, true)
  assert.equal(badQuoteEvaluated.uncertaintyCode, 'unverified_quote')
  assert.equal(badQuoteEvaluated.roleQuote, undefined, 'Hallucinated roleQuote must be stripped after verification')
})

test('GET /state never triggers background triage, while board patrol & manual triage enforce <=30/round and JD update re-evaluates once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-unified-retriage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let llmCalls = 0
  const seenIdsPerCall = []
  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        llmCalls += 1
        const payload = JSON.parse(req.messages[0].content[0].text)
        seenIdsPerCall.push(payload.jobs.map(j => j.id))
        const items = payload.jobs.map(j => ({
          id: j.id,
          score: j.jd.includes('千卡') ? 91 : 76,
          tier: j.jd.includes('千卡') ? 'top' : 'good',
          primaryRoleFit: 'match',
          roleQuote: j.jd.includes('千卡') ? '负责千卡 GPU 算力调度与 vLLM 推理平台研发' : j.jd.slice(0, 24),
          uncertain: !j.jd.includes('千卡'),
          reason: j.jd.includes('千卡') ? '补全后确认核心职责高度契合' : '暂按摘要评估',
        }))
        yield { type: 'text-delta', text: JSON.stringify({ items }) }
        yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }

  const previewJd = '岗位摘要：负责计算平台核心后端架构开发与多集群稳定性维护工作，具体业务线职责与更多细节请在详情页加载查看。'
  const fullJd = '完整 JD：负责千卡 GPU 算力调度与 vLLM 推理平台研发，优化容器冷启动与多租户资源隔离能力。'
  const revisedFullJd = '更新后完整 JD：主导大规模分布式计算集群内核调度研发、资源隔离方案落地与核心服务高可用稳定性保障工作。'
  let returnRevised901 = false
  let detailFetchCalls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/901') {
      detailFetchCalls += 1
      return new Response(JSON.stringify({ content: returnRevised901 ? revisedFullJd : fullJd }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) {
      return new Response('transient upstream', { status: 503 })
    }
    if (String(url).includes('boards.greenhouse.io') || String(url).includes('boards-api.greenhouse.io')) {
      throw new Error(`Unexpected external fetch: ${url}`)
    }
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

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
  const getState = async (locHeader) => (await harness.call('GET', '/api/career-agent/state', undefined, locHeader ? { 'x-career-locale': locHeader } : {})).json

  await action({
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'vLLM'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })
  // Seed a manual job + an unreviewed fresh one-off board job while sendToModel is FALSE -> 0 background calls!
  await action({ action: 'job-add', job: { company: '旧公司', title: 'AI Infra 平台架构', location: '上海', jd: '负责 AI Infra 架构设计。' } })
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.watch.nextRun = new Date(Date.now() + 8 * 3600_000).toISOString()
  ctrl.opportunities.push({
    id: 'oneoff:fresh-901',
    externalId: '901',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'MockAcme',
    title: '算力平台专家',
    location: '上海',
    jd: previewJd,
    jdPreview: true,
    oneOff: true,
    firstSeenAt: '2026-11-22T01:00:00.000Z',
    verifiedAt: '2026-11-22T01:00:00.000Z',
  })
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await dispose()
  await apply(ctx)

  const initialState = await getState()
  assert.equal(initialState.triageSummary.running, false)
  assert.equal(llmCalls, 0, 'Unconsented background state must NEVER invoke LLM')

  await action({ action: 'configure', config: { sendToModel: true } })
  await getState()
  await new Promise(r => setTimeout(r, 40))
  await getState()
  assert.equal(llmCalls, 0, 'GET /state refresh/poll MUST trigger 0 LLM calls even when sendToModel is true')

  // Compliant board patrol hydrates preview JD first, then scores the full JD once!
  await action({ action: 'run', scope: 'boards' })
  let s2 = null
  for (let i = 0; i < 40; i += 1) {
    s2 = await getState()
    if (!s2.triageSummary.running && s2.opportunities.find(o => o.id === 'oneoff:fresh-901')?.match?.mode === 'llm') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(detailFetchCalls, 1, 'Preview JD must be hydrated before scoring')
  assert.equal(llmCalls, 1, 'Compliant board patrol triggers exactly 1 background triage call after hydration')
  assert.deepEqual(seenIdsPerCall[0], ['oneoff:fresh-901'], 'Manual job must NOT crowd out or join fresh auto-triage queue')
  assert.ok(s2.watch.lastRun, 'Patrol populates watch.lastRun')

  await new Promise(r => setTimeout(r, 30))
  const s2Repeat = await getState()
  assert.equal(llmCalls, 1, 'Unchanged JD + repeated GET /state must reuse cached triage result with 0 extra calls')
  const hydratedJob = s2Repeat.opportunities.find(o => o.id === 'oneoff:fresh-901')
  assert.equal(hydratedJob?.jdPreview, undefined)
  assert.ok(hydratedJob?.jd.includes('千卡'))
  assert.equal(hydratedJob?.match?.score, 91)
  assert.equal(hydratedJob?.match?.tier, 'top')
  assert.equal(hydratedJob?.match?.uncertain, undefined)

  // Already-hydrated job returns cached from fetch-job-jd with 0 extra fetches or LLM calls
  const fetchRes = await action({ action: 'fetch-job-jd', id: 'oneoff:fresh-901' })
  assert.equal(fetchRes.fetched, false)
  assert.equal(fetchRes.cached, true)
  assert.equal(detailFetchCalls, 1)
  assert.equal(llmCalls, 1)

  // Updating JD content invalidates jobFingerprint and re-evaluates cleanly ONCE
  returnRevised901 = true
  await dispose()
  const ctrlUpdated = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  const row901 = ctrlUpdated.opportunities.find(o => o.id === 'oneoff:fresh-901')
  row901.jd = ''
  row901.jdPreview = true
  await fs.writeFile(controlPath, JSON.stringify(ctrlUpdated, null, 2))
  await apply(ctx)
  const reevalRes = await action({ action: 'fetch-job-jd', id: 'oneoff:fresh-901' })
  assert.equal(reevalRes.fetched, true)
  assert.ok(reevalRes.jd.includes('内核调度'))
  let s3 = null
  for (let i = 0; i < 40; i += 1) {
    s3 = await getState()
    const m = s3.opportunities.find(o => o.id === 'oneoff:fresh-901')?.match
    if (!s3.triageSummary.running && m?.mode === 'llm' && m?.score === 76) break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(llmCalls, 2, 'Updated JD body must trigger exactly 1 re-evaluation')
  const updatedMatch = s3.opportunities.find(o => o.id === 'oneoff:fresh-901')?.match
  assert.equal(updatedMatch?.score, 76)
  assert.equal(updatedMatch?.tier, 'good')

  // Locale switch preserves updated score with 0 extra LLM calls
  const s3En = await getState('en')
  assert.equal(llmCalls, 2)
  assert.equal(s3En.opportunities.find(o => o.id === 'oneoff:fresh-901')?.match?.score, 76)
})

test('61 open jobs: GET /state makes zero calls, while patrol and manual triage each cap at 30/round; 403 batch recovers on next patrol', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-61-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let failOnce = true
  const wireBatches = []

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('boards-api.greenhouse.io/v1/boards/acme/jobs')) {
      return new Response('transient upstream', { status: 503 })
    }
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 65_536 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        const body = JSON.parse(req.messages[0].content[0].text)
        const ids = body.jobs.map(j => j.id)
        wireBatches.push(ids)
        if (failOnce && wireBatches.length === 2) {
          const err = new Error('Forbidden')
          err.status = 403
          throw err
        }
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: body.jobs.map(j => ({
              id: j.id,
              score: 84,
              tier: 'top',
              primaryRoleFit: 'match',
              roleQuote: '负责千卡 GPU 算力调度与实时推理平台研发',
              uncertain: false,
              reason: '匹配核心经验',
            })),
          }),
        }
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
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'GPU'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })
  await dispose()

  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.watch.nextRun = new Date(Date.now() + 8 * 3600_000).toISOString()
  ctrl.opportunities = Array.from({ length: 61 }, (_, i) => ({
    id: `board:q-${i}`,
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: '星火实验室',
    title: 'AI Infra 平台工程师',
    location: '上海',
    jd: '负责千卡 GPU 算力调度与实时推理平台研发，优化分布式集群可靠性与容器冷启动性能。',
    oneOff: true,
    firstSeenAt: '2026-11-22T01:00:00.000Z',
    verifiedAt: '2026-11-22T01:00:00.000Z',
  }))
  const withNotes = ctrl.opportunities.at(-1)
  withNotes.verifiedAt = '2026-11-20T01:00:00.000Z'
  const historyOnly = { ...withNotes, id: 'board:history', oneOff: false, sourceId: 'greenhouse:inactive' }
  ctrl.opportunities.push(historyOnly)
  ctrl.interviewNotes = [
    { id: 'round-1', opportunityId: withNotes.id },
    { id: 'round-2', opportunityId: withNotes.id },
    { id: 'history-note', opportunityId: historyOnly.id },
  ]
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply(ctx)

  // Multiple GET /state polls must make 0 LLM calls and leave watch.lastRun null
  for (let i = 0; i < 4; i += 1) {
    const s = await getState()
    assert.equal(s.watch.lastRun, null)
    assert.equal(s.triageSummary.llmTriagedCount, 0)
  }
  assert.equal(wireBatches.length, 0, 'GET /state polling must never trigger LLM calls')
  const initial = await getState()
  assert.equal(initial.opportunities.at(-2)?.id, withNotes.id, 'Open role with notes must be sorted by fit among fresh roles')
  assert.equal(initial.opportunities.at(-2)?.interviewNotes.length, 2)
  assert.equal(initial.opportunities.at(-2)?.stage, 'discovered')
  assert.equal(initial.opportunities.at(-1)?.id, historyOnly.id, 'Retain notes from inactive sources below open roles')

  // Patrol #1 hits 403 on batch #2 (10 succeeded, 20 failed out of 30 selected)
  await action({ action: 'run', scope: 'boards' })
  for (let i = 0; i < 60; i += 1) {
    const disk = JSON.parse(await fs.readFile(controlPath, 'utf8'))
    if (disk.triageMeta?.lastFailure) break
    await new Promise(r => setTimeout(r, 20))
  }
  const midDisk = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  assert.equal(wireBatches.flat().length, 30, 'Patrol round 1 sends at most 30 jobs')
  assert.equal(midDisk.triageMeta.autoKey, '', 'Failed triage batch must NOT lock autoKey')
  assert.ok(midDisk.triageMeta.lastFailure?.failedBatches >= 1)
  const completedBatch1 = Object.values(midDisk.jobMatches || {}).filter(m => m?.mode === 'llm').length
  assert.equal(completedBatch1, 20, 'Succeeded batches 1 & 3 verdicts must be preserved while only failed batch 2 stays uncached')

  // Provider recovers & host restarts: GET /state still makes 0 calls
  failOnce = false
  wireBatches.length = 0
  await dispose()
  await apply(ctx)
  const afterRestart = await getState()
  assert.equal(afterRestart.triageSummary.llmTriagedCount, 20)
  assert.equal(wireBatches.length, 0, 'Restart + GET /state must make 0 calls')

  // Next compliant automatic patrol retries the 10 failed jobs + 20 more unreviewed (capped at 30), reusing the 20 completed!
  await action({ action: 'run', scope: 'boards' })
  for (let i = 0; i < 60; i += 1) {
    const s = await getState()
    if (!s.triageSummary.running && s.triageSummary.llmTriagedCount >= 50) break
    await new Promise(r => setTimeout(r, 20))
  }
  const retriedIds = wireBatches.flat()
  assert.equal(retriedIds.length, 30, 'Patrol round 2 sends exactly 30 unreviewed/failed jobs')
  for (const alreadyDoneId of Object.keys(midDisk.jobMatches)) {
    assert.ok(!retriedIds.includes(alreadyDoneId), `Already-completed job ${alreadyDoneId} must be reused without redundant calls`)
  }
  const afterRecoveryState = await getState()
  assert.equal(afterRecoveryState.triageSummary.llmTriagedCount, 50)
  wireBatches.length = 0
  const manualRes = await action({ action: 'triage-jobs', limit: 30 })
  assert.equal(manualRes.triagedCount, 11)
  assert.ok(wireBatches.flat().includes(withNotes.id), 'Stored interview notes alone must not make a role ineligible')
  assert.ok(!wireBatches.flat().includes(historyOnly.id), 'An inactive source must not join the queue')
  wireBatches.length = 0
  assert.equal((await action({ action: 'triage-jobs', limit: 30 })).triagedCount, 0)
  assert.equal(wireBatches.length, 0, 'Manual batches must reuse valid verdicts once no pending jobs remain')
  assert.equal((await action({ action: 'triage-jobs', id: withNotes.id })).triagedCount, 1)
  assert.deepEqual(wireBatches.flat(), [withNotes.id], 'Explicit single-role recheck may replace a current verdict')
  assert.equal((await getState()).opportunities.find(job => job.id === withNotes.id)?.interviewNotes.length, 2)
})

test('4096 small context window degrades cleanly with 0 LLM calls instead of emitting max_tokens=1, while 8192 fits with >=500 output', async () => {
  const longResume = '# 合成测试者\n\n## 工作经历\n'
    + Array.from({ length: 40 }, (_, i) => `- 第${i}条测试经历：了解图形引擎的实际落地与故障排查能力，并对接各组推进模块上线。`).join('\n')
  const profile = buildPatrolSearchProfile({
    resumeText: longResume,
    goal: '寻找上海技术美术和实时渲染相关工作',
    searchTerms: ['技术美术', 'UE5', '渲染'],
  })
  const job = {
    id: 'board:qa-small',
    company: '合成实验室',
    title: 'UE5 技术美术工程师',
    location: '上海',
    jd: Array.from({ length: 22 }, (_, i) => `职责${i}：负责 UE5 实时渲染管线、材质开发、着色器性能优化与三维资产工具开发，并建立资产标准和性能监控能力。`).join('\n\n'),
  }

  let calls4k = 0
  const metrics4k = {}
  const res4k = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 4096 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        async *stream() {
          calls4k += 1
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:tiny4k', sendToModel: true },
    jobs: [job],
    profile,
    resumeText: longResume,
    metricsOut: metrics4k,
  })
  assert.equal(calls4k, 0, 'Oversized request on 4096 context window must degrade cleanly with 0 LLM calls')
  assert.equal(res4k[0].mode, 'heuristic')
  assert.equal(res4k[0].uncertain, true)
  assert.equal(res4k[0].uncertaintyCode, 'context_window_exceeded')
  assert.equal(metrics4k.degradedJobs, 1)
  assert.equal(metrics4k.budget.contextInsufficient, true)

  const seenMaxTokens = []
  const metrics8k = {}
  const res8k = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 8192 }, defaultMaxTokens: 4096 }),
      prepareCall: async (_ref, _signal, adjust) => {
        const next = adjust({ maxTokens: 4096 }, { context: { contextWindow: 8192 }, defaultMaxTokens: 4096 })
        seenMaxTokens.push(next.maxTokens)
        return {
          async *stream(req) {
            const payload = JSON.parse(req.messages[0].content[0].text)
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                items: payload.jobs.map(j => ({
                  id: j.id,
                  score: 88,
                  tier: 'top',
                  primaryRoleFit: 'match',
                  roleQuote: '负责 UE5 实时渲染管线、材质开发',
                  uncertain: false,
                  reason: '核心职责匹配',
                })),
              }),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    config: { model: 'mock:win8k', sendToModel: true },
    jobs: [job],
    profile,
    resumeText: longResume,
    metricsOut: metrics8k,
  })
  assert.equal(res8k[0].mode, 'llm')
  assert.equal(seenMaxTokens.length, 1)
  assert.ok(seenMaxTokens[0] >= 500 && seenMaxTokens[0] < 6400, `Expected bounded output tokens >= 500, got ${seenMaxTokens[0]}`)
  assert.ok(metrics8k.batches[0].estimatedInputTokens + seenMaxTokens[0] <= 8192)
})

test('triageBatchWithLlm emits live completed/total progress and host clears triageSummary.progress when done', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-triage-progress-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const progressUpdates = []
  const profile = buildPatrolSearchProfile({ resumeText: RESUME, goal: 'AI Infra 平台研发', searchTerms: ['AI Infra'] })
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: `job-prog-${i + 1}`,
    company: 'SparkCloud',
    title: `AI Infra Engineer ${i + 1}`,
    location: '上海',
    jd: '负责 Kubernetes 与 vLLM 推理服务集群调度及多租户监控建设。',
  }))

  await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream(req) {
        const payload = JSON.parse(req.messages[0].content[0].text)
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: payload.jobs.map(j => ({
              id: j.id, score: 85, tier: 'top', primaryRoleFit: 'match',
              roleQuote: '负责 Kubernetes 与 vLLM 推理服务集群调度', uncertain: false, reason: '职责匹配',
            })),
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs,
    profile,
    resumeText: RESUME,
    maxBatchSize: 2,
    onProgress: p => progressUpdates.push(p),
  })

  assert.deepEqual(progressUpdates, [
    { completed: 0, total: 4 },
    { completed: 2, total: 4 },
    { completed: 4, total: 4 },
  ])

  const batchStarted = Promise.withResolvers()
  const allowFinish = Promise.withResolvers()
  const harness = createFetchHarness()
  let disposeHost = null
  t.after(async () => {
    allowFinish.resolve()
    await disposeHost?.()
  })
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
    llm: {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      async *stream(req) {
        batchStarted.resolve()
        await allowFinish.promise
        const payload = JSON.parse(req.messages[0].content[0].text)
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: payload.jobs.map(j => ({
              id: j.id, score: 84, tier: 'top', primaryRoleFit: 'match',
              roleQuote: '负责 Kubernetes 与 vLLM 推理服务集群调度', uncertain: false, reason: '职责匹配',
            })),
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    provide: () => {},
    get: () => null,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: () => {},
    effect: fn => { disposeHost = fn() },
  })
  await harness.call('POST', '/api/career-agent/action', { action: 'configure', config: { model: 'mock:fast' } })
  await harness.call('POST', '/api/career-agent/action', {
    action: 'job-add',
    job: { company: 'SparkCloud', title: 'AI Infra Engineer', location: '上海', jd: '负责 Kubernetes 与 vLLM 推理服务集群调度。' },
  })

  const triPreview = (await harness.call('POST', '/api/career-agent/action', { action: 'triage-preview' })).data.result
  assert.equal(triPreview.count, 1)
  const triagePromise = harness.call('POST', '/api/career-agent/action', {
    action: 'triage-jobs',
    confirmed: true,
    confirmToken: triPreview.confirmToken,
  })
  await batchStarted.promise
  const during = await harness.call('GET', '/api/career-agent/state')
  assert.equal(during.data.triageSummary.running, true)
  assert.deepEqual(during.data.triageSummary.progress, { completed: 0, total: 1 })

  allowFinish.resolve()
  const finished = await triagePromise
  assert.equal(finished.status, 200)
  const after = await harness.call('GET', '/api/career-agent/state')
  assert.equal(after.data.triageSummary.running, false)
  assert.equal(after.data.triageSummary.progress, undefined)
})

test('A1 unit: structural completeness preserves concise complete JDs, skips empty/preview jobs with 0 LLM calls, and keeps context degradation distinct', async () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发',
    searchTerms: ['AI Infra', 'vLLM'],
  })
  const conciseComplete = { id: 'concise-1', company: '甲公司', title: 'AI Infra 研发', location: '上海', jd: '负责分布式推理服务与集群调度。' }
  const titleOnly = { id: 'title-1', company: '乙公司', title: 'AI Infra 研发', location: '上海', jd: '' }
  const previewOnly = { id: 'preview-1', company: '丙公司', title: 'AI Infra 研发', location: '上海', jd: '列表摘要', jdPreview: true }

  assert.equal(isOpportunityJdIncomplete(conciseComplete), false)
  assert.equal(isOpportunityJdIncomplete(titleOnly), true)
  assert.equal(isOpportunityJdIncomplete(previewOnly), true)
  assert.notEqual(
    jobContentFingerprint({ title: 'T', location: '上海', jd: '列表摘要', jdPreview: true }),
    jobContentFingerprint({ title: 'T', location: '上海', jd: '列表摘要' }),
    'Clearing jdPreview must change content fingerprint even if string is identical',
  )

  const seenIds = []
  const metrics = {}
  const res = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          seenIds.push(...payload.jobs.map(j => j.id))
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: payload.jobs.map(j => ({
                id: j.id, score: 86, tier: 'top', primaryRoleFit: 'match',
                roleQuote: '负责分布式推理服务与集群调度', uncertain: false, reason: '主责对口',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs: [conciseComplete, titleOnly, previewOnly],
    profile,
    resumeText: RESUME,
    metricsOut: metrics,
  })

  assert.deepEqual(seenIds, ['concise-1'], 'Only concise complete JD must reach LLM')
  assert.equal(metrics.llmCalls, 1)
  assert.equal(metrics.missingJdJobs, 2)

  const rConcise = res.find(r => r.opportunityId === 'concise-1')
  const rTitle = res.find(r => r.opportunityId === 'title-1')
  const rPreview = res.find(r => r.opportunityId === 'preview-1')
  assert.equal(rConcise.mode, 'llm')
  assert.equal(rConcise.uncertain, undefined, 'Concise complete JD must not be mislabeled missing_jd by word count')
  assert.equal(rConcise.uncertaintyCode, undefined)
  assert.equal(rTitle.mode, 'heuristic')
  assert.equal(rTitle.missingJd, true)
  assert.equal(rTitle.uncertaintyCode, 'missing_jd')
  assert.equal(rPreview.mode, 'heuristic')
  assert.equal(rPreview.missingJd, true)
  assert.equal(rPreview.uncertaintyCode, 'missing_jd')

  const enLocalized = localizeCachedMatch(rTitle, titleOnly, profile, 'en')
  assert.equal(enLocalized.missingJd, true)
  assert.equal(enLocalized.uncertaintyCode, 'missing_jd')
  assert.match(enLocalized.reason, /Missing full JD/)

  // If ONLY incomplete jobs are passed directly, 0 LLM calls are made
  let emptyLlmCalls = 0
  const allMissingRes = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      prepareCall: async () => {
        emptyLlmCalls += 1
        throw new Error('Should not call LLM')
      },
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs: [titleOnly, previewOnly],
    profile,
    resumeText: RESUME,
  })
  assert.equal(emptyLlmCalls, 0)
  assert.equal(allMissingRes.every(r => r.uncertaintyCode === 'missing_jd'), true)
})

test('A1 e2e: 4 sample types hydrate before scoring, withhold confident AI scores when missing, and recover on later JD completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-a1-4samples-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const llmSeenIds = []
  let failHydrate904 = true
  let detailCalls902 = 0
  let detailCalls904 = 0

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/902') {
      detailCalls902 += 1
      return new Response(JSON.stringify({
        content: '完整职责：负责多卡 GPU 调度平台、vLLM 推理内核优化与 Kubernetes 集群稳定性保障。',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/904') {
      detailCalls904 += 1
      if (failHydrate904) {
        return new Response('upstream unavailable', { status: 503 })
      }
      return new Response(JSON.stringify({
        content: '恢复后职责：负责异构 AI Infra 调度、容器冷启动优化与千卡集群监控。',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('boards-api.greenhouse.io')) {
      throw new Error(`Unexpected external fetch: ${href}`)
    }
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        const payload = JSON.parse(req.messages[0].content[0].text)
        llmSeenIds.push(payload.jobs.map(j => j.id))
        const items = payload.jobs.map(j => ({
          id: j.id,
          score: 88,
          tier: 'top',
          primaryRoleFit: 'match',
          roleQuote: j.jd.slice(0, 24),
          uncertain: false,
          reason: '核心职责匹配',
        }))
        yield { type: 'text-delta', text: JSON.stringify({ items }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const action = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  const getState = async (locHeader) => (await harness.call('GET', '/api/career-agent/state', undefined, locHeader ? { 'x-career-locale': locHeader } : {})).json

  await action({
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'vLLM'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })

  // Sample 2: title-only job added with empty jd
  const addedTitleOnly = await action({
    action: 'job-add',
    job: { company: '无详情公司', title: 'AI Infra 平台架构师', location: '上海', jd: '' },
  })

  // Inject Sample 1 (complete), Sample 3 (hydratable preview), Sample 4 (hydration-failed empty board row)
  await dispose()
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(
    {
      id: 'oneoff:complete-901',
      externalId: '901',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'MockAcme',
      title: 'GPU 平台工程师',
      location: '上海',
      jd: '负责千卡 GPU 计算平台、容器调度系统与分布式训练网络优化。',
      oneOff: true,
      firstSeenAt: '2026-11-24T01:00:00.000Z',
      verifiedAt: '2026-11-24T01:00:00.000Z',
    },
    {
      id: 'oneoff:hydratable-902',
      externalId: '902',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'MockAcme',
      title: '推理平台工程师',
      location: '上海',
      jd: '列表摘要',
      jdPreview: true,
      oneOff: true,
      firstSeenAt: '2026-11-24T01:00:00.000Z',
      verifiedAt: '2026-11-24T01:00:00.000Z',
    },
    {
      id: 'oneoff:failed-904',
      externalId: '904',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'MockAcme',
      title: '集群研发专家',
      location: '上海',
      jd: '',
      oneOff: true,
      firstSeenAt: '2026-11-24T01:00:00.000Z',
      verifiedAt: '2026-11-24T01:00:00.000Z',
    },
  )
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })

  const r1 = await action({ action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(detailCalls902, 1, 'Hydratable preview job fetches detail once before scoring')
  assert.equal(detailCalls904, 1, 'Missing board job attempts detail fetch once before scoring')
  assert.equal(r1.hydratedJdCount, 1)
  assert.equal(r1.llmScoredCount, 2, 'Only complete and successfully hydrated jobs are scored by LLM')
  assert.equal(r1.missingJdCount, 1, 'Only hydratable failed-hydration job counts in batch missingJdCount; unhydratable manual job never consumes batch quota')
  assert.deepEqual(llmSeenIds.flat().sort(), ['oneoff:complete-901', 'oneoff:hydratable-902'])

  const st1 = await getState()
  const oppComplete = st1.opportunities.find(o => o.id === 'oneoff:complete-901')
  const oppHydrated = st1.opportunities.find(o => o.id === 'oneoff:hydratable-902')
  const oppFailed = st1.opportunities.find(o => o.id === 'oneoff:failed-904')
  const oppTitleOnly = st1.opportunities.find(o => o.id === addedTitleOnly.id)

  assert.equal(oppComplete.match.mode, 'llm')
  assert.equal(oppHydrated.jdPreview, undefined)
  assert.ok(oppHydrated.jd.includes('vLLM 推理内核优化'))
  assert.equal(oppHydrated.match.mode, 'llm')

  assert.equal(oppFailed.match.mode, 'heuristic')
  assert.equal(oppFailed.match.missingJd, true)
  assert.equal(oppFailed.match.jdHydrationFailed, true)
  assert.equal(oppFailed.match.uncertaintyCode, 'missing_jd')

  assert.equal(oppTitleOnly.match.mode, 'heuristic')
  assert.equal(oppTitleOnly.match.missingJd, true)
  assert.equal(oppTitleOnly.match.jdHydrationFailed, undefined)
  assert.equal(oppTitleOnly.match.uncertaintyCode, 'missing_jd')

  // Summary counts remain strictly factual: missing-JD roles do not inflate top/good/stretch/skip or evaluatedCount
  assert.equal(st1.triageSummary.evaluatedCount, 2)
  assert.equal(st1.triageSummary.llmTriagedCount, 2)
  assert.equal(st1.triageSummary.missingJdCount, 1, 'Fresh open role count excludes manual job from activeFresh missingJdCount')
  assert.equal(st1.triageSummary.topCount, 2)

  // Locale switch localizes missing-JD state cleanly with 0 extra LLM calls
  const st1En = await getState('en')
  assert.equal(llmSeenIds.length, 1)
  assert.match(st1En.opportunities.find(o => o.id === 'oneoff:failed-904').match.reason, /Missing full JD/)

  // Repeated batch run while unchanged makes 0 redundant detail fetches and 0 LLM calls
  const callsBeforeRepeat = llmSeenIds.length
  const rRepeat = await action({ action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(rRepeat.triagedCount, 0)
  assert.equal(detailCalls902, 1)
  assert.equal(detailCalls904, 1)
  assert.equal(llmSeenIds.length, callsBeforeRepeat)

  // Recover failed hydration job via single-role recheck AND populate title-only manual job -> fingerprint changes & LLM scores cleanly
  failHydrate904 = false
  const rRecheck904 = await action({ action: 'triage-jobs', id: 'oneoff:failed-904' })
  assert.equal(detailCalls904, 2)
  assert.equal(rRecheck904.llmScoredCount, 1)
  assert.equal(rRecheck904.hydratedJdCount, 1)

  await action({
    action: 'job-add',
    job: {
      company: '无详情公司',
      title: 'AI Infra 平台架构师',
      location: '上海',
      jd: '补充后完整职责：主导大规模 GPU 推理基础设施建设与多集群调度。',
    },
  })
  const rBatchRecover = await action({ action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(rBatchRecover.llmScoredCount, 1)

  const st2 = await getState()
  assert.equal(st2.opportunities.find(o => o.id === 'oneoff:failed-904').match.mode, 'llm')
  assert.equal(st2.opportunities.find(o => o.id === 'oneoff:failed-904').match.missingJd, undefined)
  assert.equal(st2.opportunities.find(o => o.id === addedTitleOnly.id).match.mode, 'llm')
  assert.equal(st2.opportunities.find(o => o.id === addedTitleOnly.id).match.missingJd, undefined)
  assert.equal(st2.triageSummary.evaluatedCount, 3)
  assert.equal(st2.triageSummary.missingJdCount, 0)
})

test('A1 UI wiring: MatchScoreBadge omits confident score for missingJd and keeps all A1 i18n keys wired', async () => {
  const { readFile } = await import('node:fs/promises')
  const clientSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  const zhMessages = JSON.parse(await readFile(new URL('../locale/messages/zh.json', import.meta.url), 'utf8'))
  const enMessages = JSON.parse(await readFile(new URL('../locale/messages/en.json', import.meta.url), 'utf8'))

  assert.match(clientSrc, /const isMissingJd = Boolean\(match && match\.mode !== 'llm' && \(match\.missingJd \|\| match\.uncertaintyCode === 'missing_jd'\)\)/)
  assert.match(clientSrc, /isMissingJd \? \(\s*<span className="ca-score-tier">\{t\('jobs\.missingJdBadge'\)\}<\/span>/)
  assert.match(clientSrc, /t\('jobs\.missingJdMode'\)/)
  assert.match(clientSrc, /t\('jobs\.retriageMissingJdToast'\)/)
  assert.match(clientSrc, /t\('jobs\.retriageMissingJdBatchToast'/)
  assert.match(clientSrc, /t\('jobs\.retriageToastWithMissing'/)

  assert.equal(zhMessages.jobs.missingJdBadge, '缺岗位详情')
  assert.equal(enMessages.jobs.missingJdBadge, 'Missing JD')
})

test('legacy profile upgrade replaces stale LLM scores on incomplete JDs and re-queues them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-a1-upgrade-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const llmSeenIds = []
  let detailCalls = 0

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/701') {
      detailCalls += 1
      return new Response(JSON.stringify({
        content: '完整职责：主导大规模 GPU 算力调度、vLLM 推理优化与集群平台研发。',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const llm = {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        const payload = JSON.parse(req.messages[0].content[0].text)
        llmSeenIds.push(...payload.jobs.map(j => j.id))
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: payload.jobs.map(j => ({
              id: j.id,
              score: 91,
              tier: 'top',
              primaryRoleFit: 'match',
              roleQuote: j.jd.slice(0, 18),
              uncertain: false,
              reason: '补全后匹配',
            })),
          }),
        }
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
  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'GPU'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })
  await dispose()

  const profile = buildPatrolSearchProfile({
    resumeText: '',
    goal: '上海 AI Infra 平台研发',
    searchTerms: ['AI Infra', 'GPU'],
  })
  const legacyFull = {
    id: 'oneoff:legacy-full-700',
    externalId: '700',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'MockAcme',
    title: 'AI Infra 平台工程师',
    location: '上海',
    jd: '负责千卡 GPU 计算集群与容器平台研发。',
    oneOff: true,
  }
  const legacyEmptyGh = {
    id: 'oneoff:legacy-empty-701',
    externalId: '701',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'MockAcme',
    title: 'AI Infra 推理架构师',
    location: '上海',
    jd: '',
    oneOff: true,
  }
  const legacyEmptyFeishu = {
    id: 'oneoff:legacy-feishu-702',
    externalId: 'fs-702',
    provider: 'feishu',
    sourceId: 'feishu:acme',
    company: 'FeishuAcme',
    title: 'AI Infra 系统工程师',
    location: '上海',
    jd: '',
    oneOff: true,
  }

  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(legacyFull, legacyEmptyGh, legacyEmptyFeishu)
  ctrl.jobMatches = {
    [legacyFull.id]: {
      opportunityId: legacyFull.id,
      score: 90,
      tier: 'top',
      roleQuote: legacyFull.jd.slice(0, 24),
      reason: '旧版已评完整岗位',
      mode: 'llm',
      locale: 'zh',
      fingerprint: profile.fingerprint,
      jobFingerprint: jobContentFingerprint(legacyFull),
    },
    [legacyEmptyGh.id]: {
      opportunityId: legacyEmptyGh.id,
      score: 90,
      tier: 'top',
      reason: '旧版仅标题打分',
      mode: 'llm',
      locale: 'zh',
      fingerprint: profile.fingerprint,
      jobFingerprint: jobContentFingerprint(legacyEmptyGh),
    },
    [legacyEmptyFeishu.id]: {
      opportunityId: legacyEmptyFeishu.id,
      score: 90,
      tier: 'top',
      reason: '旧版飞书空正文打分',
      mode: 'llm',
      locale: 'zh',
      fingerprint: profile.fingerprint,
      jobFingerprint: jobContentFingerprint(legacyEmptyFeishu),
    },
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply(ctx)
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const stateBefore = (await harness.call('GET', '/api/career-agent/state')).json
  assert.equal(stateBefore.opportunities.find(o => o.id === legacyFull.id).match.mode, 'llm')
  assert.equal(stateBefore.opportunities.find(o => o.id === legacyFull.id).match.score, 90)

  const staleGhView = stateBefore.opportunities.find(o => o.id === legacyEmptyGh.id).match
  const staleFeishuView = stateBefore.opportunities.find(o => o.id === legacyEmptyFeishu.id).match
  assert.equal(staleGhView.mode, 'heuristic')
  assert.equal(staleGhView.missingJd, true)
  assert.equal(staleGhView.uncertaintyCode, 'missing_jd')
  assert.equal(staleFeishuView.mode, 'heuristic')
  assert.equal(staleFeishuView.missingJd, true)
  assert.equal(staleFeishuView.uncertaintyCode, 'missing_jd')
  assert.equal(stateBefore.triageSummary.evaluatedCount, 1)
  assert.equal(stateBefore.triageSummary.missingJdCount, 2)

  // Batch triage must NOT return 'cached' for the legacy empty Greenhouse role; it hydrates and scores it while skipping Feishu & full cached role
  const res = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(res.status, 200)
  assert.equal(detailCalls, 1)
  assert.equal(res.json.result.hydratedJdCount, 1)
  assert.equal(res.json.result.llmScoredCount, 1)
  assert.deepEqual(llmSeenIds, [legacyEmptyGh.id])
})

test('incomplete jobs from non-detail adapters do not consume batch triage quota ahead of full JDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-a1-quota-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const llmSeenIds = []

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          llmSeenIds.push(...payload.jobs.map(j => j.id))
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: payload.jobs.map(j => ({
                id: j.id,
                score: 85,
                tier: 'top',
                primaryRoleFit: 'match',
                roleQuote: '负责 GPU 调度平台研发',
                uncertain: false,
                reason: '方向契合',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'GPU'],
      boards: [
        { provider: 'feishu', slug: 'acme', company: 'FeishuCo', label: 'FeishuCo' },
        { provider: 'greenhouse', slug: 'acme', company: 'GhCo', label: 'GhCo' },
      ],
    },
  })
  await dispose()

  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  for (let i = 0; i < 30; i += 1) {
    ctrl.opportunities.push({
      id: `feishu:acme:no-jd-${i}`,
      externalId: `no-jd-${i}`,
      provider: 'feishu',
      sourceId: 'feishu:acme',
      company: 'FeishuCo',
      title: 'AI Infra 平台研发工程师',
      location: '上海',
      jd: '',
      firstSeenAt: `2026-11-24T01:${String(i).padStart(2, '0')}:00.000Z`,
      verifiedAt: `2026-11-24T01:${String(i).padStart(2, '0')}:00.000Z`,
    })
  }
  for (let i = 0; i < 25; i += 1) {
    ctrl.opportunities.push({
      id: `greenhouse:acme:full-${i}`,
      externalId: `full-${i}`,
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: 'GhCo',
      title: 'AI Infra 平台研发工程师',
      location: '上海',
      jd: '负责 GPU 调度平台研发与集群稳定性建设。',
      firstSeenAt: `2026-11-23T01:${String(i).padStart(2, '0')}:00.000Z`,
      verifiedAt: `2026-11-23T01:${String(i).padStart(2, '0')}:00.000Z`,
    })
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          llmSeenIds.push(...payload.jobs.map(j => j.id))
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: payload.jobs.map(j => ({
                id: j.id,
                score: 85,
                tier: 'top',
                primaryRoleFit: 'match',
                roleQuote: '负责 GPU 调度平台研发',
                uncertain: false,
                reason: '方向契合',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const r1 = (await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })).json.result
  assert.equal(r1.llmScoredCount, 25, 'All 25 full-JD jobs must be evaluated in the first round without waiting behind non-detail jobs')
  assert.equal(llmSeenIds.length, 25)
  assert.ok(llmSeenIds.every(id => id.startsWith('greenhouse:acme:full-')))

  const state = (await harness.call('GET', '/api/career-agent/state')).json
  assert.equal(state.triageSummary.evaluatedCount, 25)
  assert.equal(state.triageSummary.missingJdCount, 30)
})

test('disposed or paused triage stops waiting on hung hydration without overwriting newer state while sharing in-flight fetches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-a1-lifecycle-'))
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')

  let gate = Promise.withResolvers()
  let detailCalls = 0
  let returnedJd = '第一次补全完整 JD：负责千卡集群调度与容器网络研发。'
  const origFetch = globalThis.fetch
  let dispose2
  t.after(async () => {
    try {
      if (typeof dispose2 === 'function') await dispose2()
    } finally {
      gate.resolve()
      globalThis.fetch = origFetch
      await rm(dir, { recursive: true, force: true })
    }
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://boards-api.greenhouse.io/v1/boards/acme/jobs/')) {
      detailCalls += 1
      await gate.promise
      return new Response(JSON.stringify({ content: returnedJd }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, init)
  }

  const makeCtx = harness => ({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: payload.jobs.map(j => ({
                id: j.id,
                score: 86,
                tier: 'top',
                primaryRoleFit: 'match',
                roleQuote: j.jd.slice(0, 12),
                uncertain: false,
                reason: '匹配',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
  })

  // (a) Disposed host must not hang on exit and must never overwrite newer host's goal when slow detail resolves later
  const h1 = createFetchHarness()
  let dispose1
  await apply({ ...makeCtx(h1), effect(fn) { dispose1 = fn() } })
  await h1.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { mode: 'search', sendToModel: true, model: 'mock:fast', goal: '旧目标' },
  })
  await dispose1()

  const ctrl1 = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl1.opportunities.push({
    id: 'oneoff:hang-801',
    externalId: '801',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'MockAcme',
    title: 'AI Infra 研发',
    location: '上海',
    jd: '',
    oneOff: true,
  })
  await fs.writeFile(controlPath, JSON.stringify(ctrl1, null, 2))

  const h1b = createFetchHarness()
  let dispose1b
  await apply({ ...makeCtx(h1b), effect(fn) { dispose1b = fn() } })
  const triage1 = h1b.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  for (let i = 0; i < 30 && detailCalls < 1; i += 1) await new Promise(r => setTimeout(r, 10))
  assert.equal(detailCalls, 1)

  await dispose1b()
  const r1 = await Promise.race([
    triage1,
    new Promise((_, reject) => setTimeout(() => reject(new Error('triage did not exit after dispose')), 1000)),
  ])
  assert.equal(r1.status, 200)
  assert.equal(r1.json.result.triagedCount, 0)

  const h2 = createFetchHarness()
  await apply({ ...makeCtx(h2), effect(fn) { dispose2 = fn() } })
  await h2.call('POST', '/api/career-agent/action', { action: 'configure', config: { goal: '新目标不能被覆盖' } })

  gate.resolve()
  await new Promise(r => setTimeout(r, 50))
  const diskAfterResolve = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  assert.equal(diskAfterResolve.config.goal, '新目标不能被覆盖', 'Stale disposed host must never overwrite newer host config')
  assert.equal(diskAfterResolve.opportunities.find(o => o.id === 'oneoff:hang-801')?.jd || '', '')

  // (b) Pausing mode=off releases hung triage immediately and suppresses disk write when response finishes later
  gate = Promise.withResolvers()
  const triage2 = h2.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  for (let i = 0; i < 30 && detailCalls < 2; i += 1) await new Promise(r => setTimeout(r, 10))
  assert.equal(detailCalls, 2)

  await h2.call('POST', '/api/career-agent/action', { action: 'configure', config: { mode: 'off' } })
  const r2 = await Promise.race([
    triage2,
    new Promise((_, reject) => setTimeout(() => reject(new Error('triage did not exit after pause')), 1000)),
  ])
  assert.equal(r2.json.result.triagedCount, 0)
  assert.equal((await h2.call('GET', '/api/career-agent/state')).json.triageSummary.running, false)

  gate.resolve()
  await new Promise(r => setTimeout(r, 50))
  const diskAfterPause = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  assert.equal(diskAfterPause.opportunities.find(o => o.id === 'oneoff:hang-801')?.jd || '', '', 'Aborted hydration with no active caller must not write JD')

  // (c) Concurrent fetch-job-jd shares the single in-flight upstream fetch and persists JD even after triage aborts
  await h2.call('POST', '/api/career-agent/action', { action: 'configure', config: { mode: 'search', sendToModel: true } })
  gate = Promise.withResolvers()
  returnedJd = '共享请求完整 JD：负责千卡异构训练调度与内核性能调优。'
  const triage3 = h2.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  for (let i = 0; i < 30 && detailCalls < 3; i += 1) await new Promise(r => setTimeout(r, 10))
  assert.equal(detailCalls, 3)

  const detailReq = h2.call('POST', '/api/career-agent/action', { action: 'fetch-job-jd', id: 'oneoff:hang-801' })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(detailCalls, 3, 'Live fetch-job-jd caller must coalesce onto the single in-flight detail fetch')

  await h2.call('POST', '/api/career-agent/action', { action: 'configure', config: { goal: '切换新目标后仅中止 triage' } })
  const r3 = await Promise.race([
    triage3,
    new Promise((_, reject) => setTimeout(() => reject(new Error('triage did not exit after goal change')), 1000)),
  ])
  assert.equal(r3.json.result.triagedCount, 0)

  gate.resolve()
  const detailRes = await detailReq
  assert.equal(detailRes.status, 200)
  assert.equal(detailRes.json.result.fetched, true)
  assert.ok(detailRes.json.result.jd.includes('共享请求完整 JD'))
  const diskAfterShared = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  assert.ok(diskAfterShared.opportunities.find(o => o.id === 'oneoff:hang-801')?.jd.includes('共享请求完整 JD'))
})

test('mihoyo jobSummary preview stays missing_jd across summary-only detail until real description arrives', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-mihoyo-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')

  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let mihoyoDetailMode = 'error'
  let llmCalls = 0
  const mockFetch = async url => {
    const u = String(url)
    if (u.includes('/ats-portal/v1/job/list')) {
      return new Response(JSON.stringify({
        data: {
          list: [{
            id: 701,
            title: 'AI Infra 高级工程师',
            competencyType: '技术类',
            addressDetailList: [{ addressDetail: '上海' }],
            jobSummary: '负责公司 AI 训练与推理平台工程建设。',
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/ats-portal/v1/job/info')) {
      if (mihoyoDetailMode === 'error') {
        return new Response('unavailable', { status: 503 })
      }
      if (mihoyoDetailMode === 'summary_only') {
        return new Response(JSON.stringify({
          data: {
            id: '701',
            jobSummary: '负责公司 AI 训练与推理平台工程建设（接口仍仅返回摘要）。',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        data: {
          id: '701',
          description: '主导千卡 GPU 异构调度与 vLLM 推理性能优化。',
          jobRequire: '熟悉 Kubernetes、分布式系统与 C++/Go/Python。',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected fetch URL: ${u}`)
  }

  const collected = await collectOpportunities(
    [{ provider: 'mihoyo', slug: 'social', company: 'miHoYo' }],
    { fetchImpl: mockFetch },
  )
  assert.equal(collected.opportunities.length, 1)
  const summaryOpp = collected.opportunities[0]
  assert.equal(summaryOpp.jdPreview, true)
  assert.equal(isOpportunityJdIncomplete(summaryOpp), true)

  mihoyoDetailMode = 'summary_only'
  const summaryDetail = await fetchOpportunityDetail(summaryOpp, { fetchImpl: mockFetch })
  assert.deepEqual(summaryDetail, { jd: '负责公司 AI 训练与推理平台工程建设（接口仍仅返回摘要）。', jdPreview: true })

  globalThis.fetch = mockFetch
  const makeCtx = harness => ({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          llmCalls += 1
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [{
                id: summaryOpp.id,
                score: 88,
                tier: 'top',
                primaryRoleFit: 'match',
                roleQuote: '主导千卡 GPU 异构调度',
                uncertain: false,
                reason: '岗位职责与千卡 GPU 平台经历高度契合。',
              }],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
  })

  const h0 = createFetchHarness()
  let dispose0
  await apply({ ...makeCtx(h0), effect(fn) { dispose0 = fn() } })
  await h0.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra'],
      boards: [{ provider: 'mihoyo', slug: 'social', company: 'miHoYo', label: 'miHoYo' }],
    },
  })
  await dispose0()

  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(summaryOpp)
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const harness = createFetchHarness()
  let dispose
  t.after(async () => { if (typeof dispose === 'function') await dispose() })
  await apply({ ...makeCtx(harness), effect(fn) { dispose = fn() } })

  // Summary-only detail must preserve jdPreview and stay missing_jd without calling LLM
  mihoyoDetailMode = 'summary_only'
  const r1 = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(r1.status, 200)
  assert.equal(r1.json.result.hydratedJdCount, 0)
  assert.equal(llmCalls, 0)
  const s1 = (await harness.call('GET', '/api/career-agent/state')).json
  const opp1 = s1.opportunities.find(o => o.id === summaryOpp.id)
  assert.equal(opp1.jdPreview, true)
  assert.equal(opp1.match.uncertaintyCode, 'missing_jd')

  // Real description/jobRequire detail on single-job recheck clears jdPreview and scores once via LLM
  mihoyoDetailMode = 'full'
  const r2 = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', id: summaryOpp.id })
  assert.equal(r2.status, 200)
  assert.equal(r2.json.result.hydratedJdCount, 1)
  assert.equal(llmCalls, 1)
  const s2 = (await harness.call('GET', '/api/career-agent/state')).json
  const opp2 = s2.opportunities.find(o => o.id === summaryOpp.id)
  assert.equal(opp2.jdPreview, undefined)
  assert.ok(opp2.jd.includes('岗位职责'))
  assert.ok(opp2.jd.includes('岗位要求'))
  assert.equal(opp2.match.mode, 'llm')
  assert.equal(opp2.match.score, 88)
})

test('greenhouse empty HTML detail normalizes to blank string and stays missing_jd', async t => {
  const detail = await fetchOpportunityDetail(
    { provider: 'greenhouse', sourceId: 'greenhouse:acme', externalId: '901' },
    {
      fetchImpl: async url => {
        assert.match(String(url), /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/901/)
        return new Response(JSON.stringify({ content: '<p>&nbsp;</p><div>  \n</div>' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  )
  assert.deepEqual(detail, { jd: '' })

  const dir = await mkdtemp(join(tmpdir(), 'career-gh-blank-html-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let llmCalls = 0
  globalThis.fetch = async url => {
    assert.match(String(url), /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/901/)
    return new Response(JSON.stringify({ content: '<p>&nbsp;</p><div>  \n</div>' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const makeCtx = harness => ({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          llmCalls += 1
          yield { type: 'text-delta', text: '{"items":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
  })

  const h0 = createFetchHarness()
  let dispose0
  await apply({ ...makeCtx(h0), effect(fn) { dispose0 = fn() } })
  await h0.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'GhCo', label: 'GhCo' }],
    },
  })
  await dispose0()

  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push({
    id: 'greenhouse:acme:901',
    externalId: '901',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    company: 'GhCo',
    title: 'AI Infra Engineer',
    location: 'Shanghai',
    jd: '',
    firstSeenAt: '2026-11-24T01:00:00.000Z',
    verifiedAt: '2026-11-24T01:00:00.000Z',
  })
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const harness = createFetchHarness()
  let dispose
  t.after(async () => { if (typeof dispose === 'function') await dispose() })
  await apply({ ...makeCtx(harness), effect(fn) { dispose = fn() } })

  const r = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(r.status, 200)
  assert.equal(r.json.result.hydratedJdCount, 0)
  assert.equal(llmCalls, 0)
  const s = (await harness.call('GET', '/api/career-agent/state')).json
  const opp = s.opportunities.find(o => o.id === 'greenhouse:acme:901')
  assert.equal(opp.jd, '')
  assert.equal(opp.match.uncertaintyCode, 'missing_jd')
})

test('legacy mihoyo jobSummary record upgrades to jdPreview on refresh while legacy full JD keeps score', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-mihoyo-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const legacySummaryOpp = {
    id: 'mihoyo:social:711',
    sourceId: 'mihoyo:social',
    provider: 'mihoyo',
    externalId: '711',
    company: 'miHoYo',
    title: 'AI 平台研发工程师',
    location: '上海 · 技术类',
    jd: '负责公司 AI 基础设施与算力平台建设。',
    url: 'https://jobs.mihoyo.com/#/position/711',
    firstSeenAt: '2026-11-20T01:00:00.000Z',
    verifiedAt: '2026-11-20T01:00:00.000Z',
  }
  const legacyFullOpp = {
    id: 'mihoyo:social:712',
    sourceId: 'mihoyo:social',
    provider: 'mihoyo',
    externalId: '712',
    company: 'miHoYo',
    title: 'GPU 调度资深工程师',
    location: '上海 · 技术类',
    jd: '岗位职责\n主导大规模 GPU 调度系统研发。\n\n岗位要求\n熟悉 Go 与 Kubernetes。',
    url: 'https://jobs.mihoyo.com/#/position/712',
    firstSeenAt: '2026-11-20T01:00:00.000Z',
    verifiedAt: '2026-11-20T01:00:00.000Z',
  }

  let detailMode = 'error'
  const detailFetchedIds = []
  const llmSeenIds = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/ats-portal/v1/job/list')) {
      return new Response(JSON.stringify({
        data: {
          list: [
            {
              id: 711,
              title: legacySummaryOpp.title,
              competencyType: '技术类',
              addressDetailList: [{ addressDetail: '上海' }],
              jobSummary: '负责公司 AI 基础设施与算力平台建设。',
            },
            {
              id: 712,
              title: legacyFullOpp.title,
              competencyType: '技术类',
              addressDetailList: [{ addressDetail: '上海' }],
              jobSummary: 'GPU 调度平台摘要（列表简述）',
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/ats-portal/v1/job/info')) {
      const reqBody = JSON.parse(String(init?.body || '{}'))
      detailFetchedIds.push(String(reqBody.id))
      if (detailMode === 'error') {
        return new Response('unavailable', { status: 503 })
      }
      return new Response(JSON.stringify({
        data: {
          id: String(reqBody.id),
          description: '主导大模型训练集群作业调度与弹性容错建设。',
          jobRequire: '精通 Go、Kubernetes 与分布式系统调度。',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected fetch URL: ${u}`)
  }

  const makeCtx = harness => ({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          llmSeenIds.push(...payload.jobs.map(j => j.id))
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: payload.jobs.map(j => ({
                id: j.id,
                score: 90,
                tier: 'top',
                primaryRoleFit: 'match',
                roleQuote: j.jd.slice(0, 12),
                uncertain: false,
                reason: '完整 JD 补全后深度契合。',
              })),
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get() {},
    on() {},
    emit() {},
    provide() {},
  })

  const h0 = createFetchHarness()
  let dispose0
  await apply({ ...makeCtx(h0), effect(fn) { dispose0 = fn() } })
  await h0.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI'],
      boards: [{ provider: 'mihoyo', slug: 'social', company: 'miHoYo', label: 'miHoYo' }],
    },
  })
  await dispose0()

  const profile = buildPatrolSearchProfile({ goal: '上海 AI Infra 平台研发', searchTerms: ['AI'] })
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(legacySummaryOpp, legacyFullOpp)
  ctrl.jobMatches = {
    [legacySummaryOpp.id]: {
      opportunityId: legacySummaryOpp.id,
      score: 88,
      tier: 'top',
      mode: 'llm',
      reason: '旧版误把摘要当正文打分',
      fingerprint: profile.fingerprint,
      jobFingerprint: jobContentFingerprint(legacySummaryOpp),
      evaluatedAt: '2026-11-20T01:05:00.000Z',
    },
    [legacyFullOpp.id]: {
      opportunityId: legacyFullOpp.id,
      score: 82,
      tier: 'good',
      roleQuote: legacyFullOpp.jd.slice(0, 24),
      mode: 'llm',
      reason: '旧版完整 JD 已确认评估结果',
      fingerprint: profile.fingerprint,
      jobFingerprint: jobContentFingerprint(legacyFullOpp),
      evaluatedAt: '2026-11-20T01:05:00.000Z',
    },
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  const harness = createFetchHarness()
  let dispose
  t.after(async () => { if (typeof dispose === 'function') await dispose() })
  await apply({ ...makeCtx(harness), effect(fn) { dispose = fn() } })

  // Board refresh while detail fails: legacy summary row marks jdPreview & clears stale 88, full row stays intact with 82
  const refreshRes = await harness.call('POST', '/api/career-agent/action', { action: 'run', scope: 'boards' })
  assert.equal(refreshRes.status, 200)
  assert.deepEqual(detailFetchedIds, [])

  const sAfterRefresh = (await harness.call('GET', '/api/career-agent/state')).json
  const refreshed711 = sAfterRefresh.opportunities.find(o => o.id === legacySummaryOpp.id)
  const refreshed712 = sAfterRefresh.opportunities.find(o => o.id === legacyFullOpp.id)
  assert.equal(refreshed711.jdPreview, true)
  assert.equal(refreshed711.match.uncertaintyCode, 'missing_jd')
  assert.equal(refreshed712.jdPreview, undefined)
  assert.equal(refreshed712.jd, legacyFullOpp.jd)
  assert.equal(refreshed712.match.mode, 'llm')
  assert.equal(refreshed712.match.score, 82)

  // Triage while detail still 503 must not send 711 to LLM
  await harness.call('POST', '/api/career-agent/action', { action: 'configure', config: { sendToModel: true } })
  const rFailed = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(rFailed.status, 200)
  assert.equal(rFailed.json.result.hydratedJdCount, 0)
  assert.deepEqual(detailFetchedIds, ['711'])
  assert.deepEqual(llmSeenIds, [])

  // Once detail recovers, single-job recheck hydrates 711, clears jdPreview, and scores only 711 while keeping 712 at 82
  detailMode = 'full'
  const rRecovered = await harness.call('POST', '/api/career-agent/action', { action: 'triage-jobs', id: legacySummaryOpp.id })
  assert.equal(rRecovered.status, 200)
  assert.equal(rRecovered.json.result.hydratedJdCount, 1)
  assert.deepEqual(llmSeenIds, [legacySummaryOpp.id])

  const sFinal = (await harness.call('GET', '/api/career-agent/state')).json
  const final711 = sFinal.opportunities.find(o => o.id === legacySummaryOpp.id)
  const final712 = sFinal.opportunities.find(o => o.id === legacyFullOpp.id)
  assert.equal(final711.jdPreview, undefined)
  assert.ok(final711.jd.includes('岗位职责'))
  assert.equal(final711.match.mode, 'llm')
  assert.equal(final711.match.score, 90)
  assert.equal(final712.match.mode, 'llm')
  assert.equal(final712.match.score, 82)
})

test('PR2 write-path guard: rejects missing score, empty positive roleQuote, and unverified quotes from mode:llm while stripping heuristic breakdown', async () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '上海 AI Infra 平台研发',
    searchTerms: ['AI Infra', 'vLLM'],
  })
  const jobs = [
    { id: 'valid-1', company: '甲公司', title: 'AI Infra 研发', location: '上海', jd: '负责大规模 vLLM 推理引擎与 GPU 调度系统建设。' },
    { id: 'empty-quote-top', company: '乙公司', title: 'AI Infra 研发', location: '上海', jd: '负责 GPU 异构调度与容器平台研发。' },
    { id: 'bad-quote-top', company: '丙公司', title: 'AI Infra 研发', location: '上海', jd: '负责分布式训练网络与内核性能优化。' },
    { id: 'missing-score-null', company: '丁公司', title: 'AI Infra 研发', location: '上海', jd: '负责多机多卡推理集群稳定性保障。' },
  ]
  const metrics = {}
  const results = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                { id: 'valid-1', score: 91, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模 vLLM 推理引擎与 GPU 调度系统建设', reason: '主责匹配' },
                { id: 'empty-quote-top', score: 90, tier: 'top', primaryRoleFit: 'match', roleQuote: '', reason: '无引文高分' },
                { id: 'bad-quote-top', score: 89, tier: 'top', primaryRoleFit: 'match', roleQuote: '原文中根本不存在的捏造句段', reason: '幻觉引文' },
                { id: 'missing-score-null', score: null, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责多机多卡推理集群稳定性保障', reason: '缺分字段' },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:fast', sendToModel: true },
    profile,
    resumeText: RESUME,
    jobs,
    metricsOut: metrics,
  })

  assert.equal(metrics.failedJobs, 3)
  const validRes = results.find(r => r.opportunityId === 'valid-1')
  assert.equal(validRes.mode, 'llm')
  assert.deepEqual(validRes.breakdown, [], 'Valid LLM match must not attach heuristic numeric breakdown')
  assert.ok(Array.isArray(validRes.factSignals) && validRes.factSignals.length > 0)

  for (const rejectedId of ['empty-quote-top', 'bad-quote-top', 'missing-score-null']) {
    const r = results.find(x => x.opportunityId === rejectedId)
    assert.equal(r.mode, 'heuristic', `${rejectedId} must stay heuristic on fallback`)
    assert.equal(r.uncertain, true)
  }
  assert.equal(results.find(x => x.opportunityId === 'missing-score-null').uncertaintyCode, 'missing_score')
  assert.equal(results.find(x => x.opportunityId === 'bad-quote-top').roleQuote, undefined)
})

test('PR2 read/queue parity, 4-zone sort, clean triageSummary, emptyTarget, and Option B sendToModel=false auth guard', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-pr2-zones-auth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let llmCalls = 0

  const llm = {
    listProviders: () => [{ id: 'mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        llmCalls += 1
        const payload = JSON.parse(req.messages[0].content[0].text)
        const items = payload.jobs.map(j => ({
          id: j.id,
          score: 88,
          tier: 'top',
          primaryRoleFit: 'match',
          roleQuote: j.jd.slice(0, 24),
          reason: 'Confirmed AI match',
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
  const getState = async (loc = 'zh') => (await harness.call('GET', '/api/career-agent/state', undefined, { 'x-career-locale': loc })).json

  await action({
    action: 'configure',
    config: {
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海 AI Infra 平台研发',
      searchTerms: ['AI Infra', 'GPU'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })

  const profile = buildPatrolSearchProfile({ goal: '上海 AI Infra 平台研发', searchTerms: ['AI Infra', 'GPU'] })
  const rubricV2Job = {
    id: 'oneoff:rubric-v2', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'A',
    title: '算力研发', location: '上海', jd: '负责 GPU 集群分布式推理服务与容器调度优化。', oneOff: true, verifiedAt: '2026-11-24T01:00:00.000Z',
  }
  const legacyValidSameScoreJob = {
    id: 'oneoff:legacy-valid', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'B',
    title: '底层运行时工程师', location: '北京', jd: '负责分布式系统内存池与服务化框架设计研发。', oneOff: true, verifiedAt: '2026-11-24T02:00:00.000Z',
  }
  const legacyInvalidEmptyQuoteJob = {
    id: 'oneoff:legacy-invalid', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'C',
    title: 'AI Infra GPU 调度专家', location: '上海', jd: '负责 AI Infra GPU vLLM 高吞吐推理集群与核心架构设计研发。', oneOff: true, verifiedAt: '2026-11-24T03:00:00.000Z',
  }
  const pendingHighHeurJob = {
    id: 'oneoff:pending-high', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'D',
    title: 'AI Infra GPU 研发', location: '上海', jd: '负责 AI Infra GPU 容器集群与推理服务优化。', oneOff: true, verifiedAt: '2026-11-24T04:00:00.000Z',
  }
  const missingJdJob = {
    id: 'oneoff:missing-jd', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'E',
    title: 'AI Infra 架构师', location: '上海', jd: '', oneOff: true, verifiedAt: '2026-11-24T05:00:00.000Z',
  }

  const sameScore = scoreOpportunityHeuristic(legacyValidSameScoreJob, profile, 'zh').score
  await dispose()
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrl.opportunities.push(rubricV2Job, legacyValidSameScoreJob, legacyInvalidEmptyQuoteJob, pendingHighHeurJob, missingJdJob)
  ctrl.jobMatches = {
    [rubricV2Job.id]: {
      opportunityId: rubricV2Job.id, mode: 'llm', protocolVersion: 'rubric-v2', tier: 'good', score: 75,
      roleQuote: '负责 GPU 集群分布式推理服务与容器调度优化', reason: '主责契合且有可迁移经历',
      fingerprint: profile.fingerprint, jobFingerprint: jobContentFingerprint(rubricV2Job),
    },
    [legacyValidSameScoreJob.id]: {
      opportunityId: legacyValidSameScoreJob.id, mode: 'llm', tier: 'stretch', score: sameScore, heuristicScore: sameScore,
      roleQuote: '负责分布式系统内存池与服务化框架设计研发', reason: 'Previously evaluated LLM reason',
      fingerprint: profile.fingerprint, jobFingerprint: jobContentFingerprint(legacyValidSameScoreJob),
    },
    [legacyInvalidEmptyQuoteJob.id]: {
      opportunityId: legacyInvalidEmptyQuoteJob.id, mode: 'llm', tier: 'top', score: 95,
      roleQuote: '', reason: 'Pre-PR2 corrupt unquoted row',
      fingerprint: profile.fingerprint, jobFingerprint: jobContentFingerprint(legacyInvalidEmptyQuoteJob),
    },
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply(ctx)

  // Verify 4-zone ordering, read downgrade of empty-quote legacy row, preservation of equal-score legacy row, and clean triageSummary
  const st = await getState('zh')
  assert.deepEqual(st.opportunities.map(o => o.id), [
    rubricV2Job.id,
    legacyValidSameScoreJob.id,
    pendingHighHeurJob.id,
    legacyInvalidEmptyQuoteJob.id,
    missingJdJob.id,
  ].map(id => st.opportunities.find(o => o.id === id).id))
  const orderedIds = st.opportunities.map(o => o.id)
  assert.equal(orderedIds[0], rubricV2Job.id)
  assert.equal(orderedIds[1], legacyValidSameScoreJob.id)
  assert.equal(orderedIds[4], missingJdJob.id)
  assert.ok(orderedIds.indexOf(legacyValidSameScoreJob.id) < orderedIds.indexOf(pendingHighHeurJob.id), 'Valid legacy_v1 must outrank higher-scoring pending_local')

  const invalidView = st.opportunities.find(o => o.id === legacyInvalidEmptyQuoteJob.id).match
  assert.equal(invalidView.mode, 'heuristic')
  assert.equal(invalidView.zone, 'pending_local')

  const validLegacyView = st.opportunities.find(o => o.id === legacyValidSameScoreJob.id).match
  assert.equal(validLegacyView.mode, 'llm')
  assert.equal(validLegacyView.zone, 'legacy_v1')
  assert.deepEqual(validLegacyView.breakdown, [])

  // Cross-locale read must preserve cached LLM reason rather than overwriting with local heuristic prose
  const stEn = await getState('en')
  assert.equal(stEn.opportunities.find(o => o.id === legacyValidSameScoreJob.id).match.reason, 'Previously evaluated LLM reason')
  assert.equal(stEn.opportunities.find(o => o.id === legacyValidSameScoreJob.id).match.roleQuote, '负责分布式系统内存池与服务化框架设计研发')

  // Clean triageSummary: only 2 valid LLM roles counted; pendingCount must remain undefined
  assert.equal(st.triageSummary.evaluatedCount, 2)
  assert.equal(st.triageSummary.rubricV2Count, 1)
  assert.equal(st.triageSummary.legacyCount, 1)
  assert.equal(st.triageSummary.unreviewedCount, 2)
  assert.equal(st.triageSummary.missingJdCount, 1)
  assert.equal(st.triageSummary.topCount, 0)
  assert.equal(st.triageSummary.goodCount, 1)
  assert.equal(st.triageSummary.stretchCount, 1)
  assert.equal(st.triageSummary.pendingCount, undefined)

  // Empty targetJobIds must short-circuit with 0 LLM calls
  const emptyRes = await action({ action: 'triage-jobs', force: true, targetJobIds: [] })
  assert.equal(emptyRes.emptyTarget, true)
  assert.equal(emptyRes.triagedCount, 0)
  assert.equal(llmCalls, 0)

  // Option B auth guard when sendToModel=false: unconfirmed calls (including bare force:true) skip with 0 LLM calls
  const unconfirmedBatch = await action({ action: 'triage-jobs', limit: 30 })
  assert.equal(unconfirmedBatch.skipped, true)
  assert.equal(unconfirmedBatch.requiresConfirmation, true)
  const unconfirmedForceBatch = await action({ action: 'triage-jobs', force: true, limit: 30 })
  assert.equal(unconfirmedForceBatch.skipped, true)
  assert.equal(unconfirmedForceBatch.requiresConfirmation, true)
  const unconfirmedSingle = await action({ action: 'triage-jobs', id: pendingHighHeurJob.id })
  assert.equal(unconfirmedSingle.skipped, true)
  assert.equal(unconfirmedSingle.requiresConfirmation, true)
  const unconfirmedSingleForce = await action({ action: 'triage-jobs', id: pendingHighHeurJob.id, force: true })
  assert.equal(unconfirmedSingleForce.skipped, true)
  assert.equal(unconfirmedSingleForce.requiresConfirmation, true)
  assert.equal(llmCalls, 0)

  // Confirmed triage-preview + confirmToken evaluates both pending jobs once and leaves sendToModel=false untouched
  const confirmedPreview = await action({
    action: 'triage-preview',
    targetJobIds: [pendingHighHeurJob.id, legacyInvalidEmptyQuoteJob.id],
  })
  assert.equal(confirmedPreview.count, 2)
  assert.ok(confirmedPreview.confirmToken)
  assert.equal(llmCalls, 0)
  const confirmed = await action({
    action: 'triage-jobs',
    confirmed: true,
    confirmToken: confirmedPreview.confirmToken,
  })
  assert.equal(confirmed.llmScoredCount, 2)
  assert.equal(llmCalls, 1)
  assert.equal((await getState()).config.sendToModel, false)
})

test('PR2 UI wiring: removes /100 scores & meters across index & Composer and wires server-backed preview + Option B TriageConfirmDialog', async () => {
  const { readFile } = await import('node:fs/promises')
  const indexSrc = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8')
  const composerSrc = await readFile(new URL('../client/Composer.jsx', import.meta.url), 'utf8')
  const cssSrc = await readFile(new URL('../client/page.css', import.meta.url), 'utf8')
  const zhMessages = JSON.parse(await readFile(new URL('../locale/messages/zh.json', import.meta.url), 'utf8'))
  const enMessages = JSON.parse(await readFile(new URL('../locale/messages/en.json', import.meta.url), 'utf8'))

  assert.doesNotMatch(indexSrc, /<span>\/ 100<\/span>|<strong>\{match\.score\}<\/strong>/)
  assert.doesNotMatch(indexSrc, /ca-score-meter|ca-score-bars|ca-score-num|ca-score-row-bar|llmCalibration|tierLegendTop/)
  assert.doesNotMatch(composerSrc, /composer\.scoreUnit/)
  assert.match(indexSrc, /function TriageConfirmDialog/)
  assert.match(indexSrc, /t\('jobs\.pendingLocalBadge'\)/)
  assert.match(indexSrc, /t\('jobs\.legacyAiBadge'\)/)
  assert.match(indexSrc, /t\('jobs\.matchBasisUnknown'\)/)
  assert.match(indexSrc, /match\.evalBasis/)
  assert.match(indexSrc, /act\.background\('triage-preview'/)
  assert.match(indexSrc, /confirmed: true, confirmToken:/)
  assert.match(indexSrc, /isFresh && isEvaluated && match\?\.tier === 'skip'/)
  assert.match(indexSrc, /data-fit-tier=\{isEvaluated \? \(match\?\.tier \|\| ''\) : ''\}/)
  assert.match(indexSrc, /data-match-zone=\{matchZone\}/)
  assert.match(cssSrc, /\.ca-triage-confirm-dialog/)
  assert.doesNotMatch(cssSrc.slice(cssSrc.indexOf('.ca-triage-confirm-dialog')), /backdrop-filter/)
  assert.ok(zhMessages.jobs.matchBasisUnknown)
  assert.ok(enMessages.jobs.matchBasisUnknown)
})

test('PR2 hardening: triage-preview/confirm parity (hydration before disclosure, cancel, stale tab), atomic per-batch LLM validation, and cache/basis consistency', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-pr2-hardening-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let llmCalls = 0
  const sentBatches = []

  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/801' || href === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/802') {
      return new Response(JSON.stringify({
        content: `完整补全详情：负责大规模分布式模型推理系统开发与性能优化，包含服务调度、缓存管理与可观测性建设。${'x'.repeat(1450)}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('boards-api.greenhouse.io')) throw new Error(`Unexpected fetch: ${href}`)
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

  const llm = {
    listProviders: () => [{ id: 'mock' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'fast' },
      async *stream(req) {
        llmCalls += 1
        const payload = JSON.parse(req.messages[0].content[0].text)
        sentBatches.push(payload.jobs.map(j => j.id))
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: payload.jobs.map(j => ({
              id: j.id,
              score: 88,
              tier: 'top',
              primaryRoleFit: 'match',
              roleQuote: j.jd.slice(0, 24),
              uncertain: false,
              reason: '主责契合',
            })),
          }),
        }
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
  const getState = async (loc = 'zh') => (await harness.call('GET', '/api/career-agent/state', undefined, { 'x-career-locale': loc })).json

  // Seed resume > 2200 chars to test 1400-char fingerprint sensitivity + evalBasis persistence
  const head1200 = `Header ${'A'.repeat(1193)}`
  const mid1400 = `MID_TOKEN_ALPHA_${'B'.repeat(284)}`
  const tailRest = `Tail ${'C'.repeat(900)}`
  const r1 = await action({
    action: 'resume-import',
    title: 'Core Track',
    text: `# Candidate\n\n${head1200}${mid1400}${tailRest}`,
  })
  await action({ action: 'resume-review', id: r1.id, decision: 'approve' })

  await action({
    action: 'configure',
    config: {
      sendToModel: false,
      model: 'mock:fast',
      goal: '上海 AI Infra',
      searchTerms: ['AI Infra'],
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' }],
    },
  })

  // Inject 1 concise complete job (51 chars) + 2 hydratable preview jobs + 1 legacy quoted without jobFingerprint + 1 context degraded record
  const fs = await import('node:fs/promises')
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  await dispose()
  const st0Profile = buildPatrolSearchProfile({
    resumeText: `# Candidate\n\n${head1200}${mid1400}${tailRest}`.slice(0, 4000),
    goal: '上海 AI Infra',
    searchTerms: ['AI Infra'],
  })
  const ctrl = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  const complete51 = {
    id: 'oneoff:c51', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'MockAcme',
    title: 'AI Infra 研发', location: '上海', jd: '负责分布式大模型推理服务架构设计与核心引擎性能优化，支撑千卡高可用在线部署。', oneOff: true, verifiedAt: '2026-11-24T05:00:00.000Z',
  }
  const prev801 = {
    id: 'oneoff:p801', externalId: '801', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'MockAcme',
    title: 'AI Infra 平台工程师', location: '上海', jd: '待补全', jdPreview: true, oneOff: true, verifiedAt: '2026-11-24T04:00:00.000Z',
  }
  const prev802 = {
    id: 'oneoff:p802', externalId: '802', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'MockAcme',
    title: 'AI Infra 调度架构师', location: '上海', jd: '待补全', jdPreview: true, oneOff: true, verifiedAt: '2026-11-24T03:00:00.000Z',
  }
  const legacyNoFp = {
    id: 'oneoff:legacy-nofp', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'LegacyCo',
    title: '分布式推理专家', location: '上海', jd: '主导高性能推理框架与 GPU 资源编排系统核心研发工作。', oneOff: true, verifiedAt: '2026-11-24T02:00:00.000Z',
  }
  const ctxDeg = {
    id: 'oneoff:ctx-deg', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'TinyCo',
    title: '超长岗位研发', location: '上海', jd: '负责超大规模计算平台、异构集群运维与内核调度架构设计研发。', oneOff: true, verifiedAt: '2026-11-24T01:00:00.000Z',
  }
  ctrl.opportunities.push(complete51, prev801, prev802, legacyNoFp, ctxDeg)
  ctrl.jobMatches = {
    [legacyNoFp.id]: {
      opportunityId: legacyNoFp.id, mode: 'llm', tier: 'top', score: 89,
      roleQuote: '主导高性能推理框架与 GPU 资源编排系统核心研发工作', reason: '历史引文可核验',
      fingerprint: st0Profile.fingerprint, updatedAt: '2026-11-20T00:00:00.000Z',
    },
    [ctxDeg.id]: {
      opportunityId: ctxDeg.id, mode: 'heuristic', uncertaintyCode: 'context_window_exceeded',
      uncertain: true, degradedModel: 'mock:fast',
      fingerprint: st0Profile.fingerprint, jobFingerprint: jobContentFingerprint(ctxDeg), updatedAt: '2026-11-20T00:00:00.000Z',
    },
  }
  await fs.writeFile(controlPath, JSON.stringify(ctrl, null, 2))
  await apply(ctx)

  // Read/queue parity check: legacyNoFp is valid legacy_v1 AND NOT re-queued; ctxDeg keeps uncertaintyCode across locales AND NOT re-queued
  const stZh = await getState('zh')
  const stEn = await getState('en')
  assert.equal(stZh.opportunities.find(o => o.id === legacyNoFp.id).match.zone, 'legacy_v1')
  assert.equal(stZh.opportunities.find(o => o.id === legacyNoFp.id).match.evalBasis, undefined)

  // Legacy cf0bd62 cache (1200-char fingerprint for a 1465+ char resume, no evalBasis): must remain valid legacy_v1 AND stay unqueued
  assert.notEqual(st0Profile.legacyFingerprint1200, st0Profile.fingerprint)
  const legacy1200Opp = {
    id: 'oneoff:legacy-1200', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: 'UpgradeCo',
    title: '大模型推理内核专家', location: '上海', jd: '负责推理运行时性能优化与 GPU 并行通信调度开发。', oneOff: true, verifiedAt: '2026-11-24T00:30:00.000Z',
  }
  const legacy1200Matches = {
    ...ctrl.jobMatches,
    [legacy1200Opp.id]: {
      opportunityId: legacy1200Opp.id, mode: 'llm', tier: 'top', score: 90,
      roleQuote: '负责推理运行时性能优化与 GPU 并行通信调度开发', reason: '旧版已评估保留',
      fingerprint: st0Profile.legacyFingerprint1200, jobFingerprint: jobContentFingerprint(legacy1200Opp),
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  }
  const resolvedUpgrade = resolveCachedJobMatch(legacy1200Matches[legacy1200Opp.id], legacy1200Opp, st0Profile, 'zh', { currentModel: 'mock:fast' })
  assert.equal(resolvedUpgrade.zone, 'legacy_v1')
  assert.equal(resolvedUpgrade.needsReview, false)
  assert.equal(resolvedUpgrade.match.evalBasis, undefined)
  assert.equal(resolvedUpgrade.match.roleQuote, '负责推理运行时性能优化与 GPU 并行通信调度开发')
  const upgradeQueue = selectTriageCandidates({
    opportunities: [legacy1200Opp],
    activeBoards: new Set(['greenhouse:acme']),
    existingMatches: legacy1200Matches,
    profile: st0Profile,
    locale: 'zh',
    currentModel: 'mock:fast',
  })
  assert.equal(upgradeQueue.candidates.length, 0)
  const ctxMatchZh = stZh.opportunities.find(o => o.id === ctxDeg.id).match
  const ctxMatchEn = stEn.opportunities.find(o => o.id === ctxDeg.id).match
  assert.equal(ctxMatchZh.zone, 'pending_local')
  assert.equal(ctxMatchZh.uncertaintyCode, 'context_window_exceeded')
  assert.ok(ctxMatchZh.uncertaintyReason)
  assert.equal(ctxMatchEn.uncertaintyCode, 'context_window_exceeded')
  assert.match(ctxMatchEn.uncertaintyReason, /context or output window/i)
  const queueCheck = selectTriageCandidates({
    opportunities: [complete51, legacyNoFp, ctxDeg],
    activeBoards: new Set(['greenhouse:acme']),
    existingMatches: ctrl.jobMatches,
    profile: st0Profile,
    locale: 'zh',
    currentModel: 'mock:fast',
  })
  assert.deepEqual(queueCheck.candidates.map(j => j.id), [complete51.id])

  // Cancel path on 1 complete + 2 hydratable previews: preview discloses all 3 post-hydration, cancel -> 0 LLM calls
  const batchPreview = await action({ action: 'triage-preview', limit: 30 })
  assert.equal(batchPreview.count, 3)
  assert.equal(batchPreview.hydratedJdCount, 2)
  assert.ok(batchPreview.confirmToken)
  assert.equal(llmCalls, 0)

  // Stale tab {id, force:true} or {force:true} while sendToModel=false MUST NOT trigger LLM
  const staleSingle = await action({ action: 'triage-jobs', id: complete51.id, force: true })
  assert.equal(staleSingle.requiresConfirmation, true)
  const staleSingleRecheck = await action({ action: 'triage-jobs', id: complete51.id, recheck: true })
  assert.equal(staleSingleRecheck.requiresConfirmation, true)
  assert.equal(llmCalls, 0)

  // Single-role confirm scopes ONLY the 1 disclosed job and binds evalBasis
  const singlePrev = await action({ action: 'triage-preview', id: complete51.id })
  assert.equal(singlePrev.count, 1)
  assert.deepEqual(singlePrev.targetJobIds, [complete51.id])
  assert.equal(singlePrev.basisResume?.id, r1.id)
  const singleConfirm = await action({ action: 'triage-jobs', confirmed: true, confirmToken: singlePrev.confirmToken })
  assert.equal(singleConfirm.llmScoredCount, 1)
  assert.deepEqual(sentBatches, [[complete51.id]])
  const stAfterSingleZh = await getState('zh')
  const stAfterSingleEn = await getState('en')
  assert.equal(stAfterSingleZh.opportunities.find(o => o.id === complete51.id).match.evalBasis?.id, r1.id)
  assert.equal(stAfterSingleEn.opportunities.find(o => o.id === complete51.id).match.evalBasis?.id, r1.id)
  assert.equal(llmCalls, 1)

  // Replay of single-use confirmToken is rejected
  const replayRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: singlePrev.confirmToken })
  assert.equal(replayRes.requiresConfirmation, true)
  assert.equal(llmCalls, 1)

  // Cross-tab race: preview opened while sendToModel=false, another tab turns ON sendToModel + adds extra board -> old confirmToken NEVER expands to newly enabled board B
  const extraBoardJob = {
    id: 'oneoff:extra-board-b', provider: 'greenhouse', sourceId: 'greenhouse:extra', company: 'ExtraCo',
    title: 'AI Infra Extra B', location: '上海', jd: '负责多机多卡分布式推理调度平台研发。', oneOff: false, verifiedAt: '2026-11-24T06:00:00.000Z',
  }
  await dispose()
  const ctrlExtra = JSON.parse(await fs.readFile(controlPath, 'utf8'))
  ctrlExtra.opportunities.push(extraBoardJob)
  await fs.writeFile(controlPath, JSON.stringify(ctrlExtra, null, 2))
  await apply(ctx)
  const crossTabPreview = await action({ action: 'triage-preview', targetJobIds: [prev801.id] })
  assert.equal(crossTabPreview.count, 1)
  assert.deepEqual(crossTabPreview.targetJobIds, [prev801.id])
  await action({
    action: 'configure',
    config: {
      mode: 'search',
      sendToModel: true,
      boards: [
        { provider: 'greenhouse', slug: 'acme', company: 'MockAcme', label: 'MockAcme' },
        { provider: 'greenhouse', slug: 'extra', company: 'ExtraCo', label: 'ExtraCo' },
      ],
    },
  })
  const staleCrossTabConfirm = await action({
    action: 'triage-jobs',
    confirmed: true,
    confirmToken: crossTabPreview.confirmToken,
  })
  assert.equal(staleCrossTabConfirm.skipped, true)
  assert.equal(staleCrossTabConfirm.requiresConfirmation, true)
  assert.equal(staleCrossTabConfirm.staleConfirmation, true)
  assert.equal(llmCalls, 1)
  await action({ action: 'configure', config: { mode: 'off', sendToModel: false } })

  // Editing resume at ~1400 chars invalidates fingerprint, voids pending confirmToken, and queues old LLM row
  const r2 = await action({
    action: 'resume-revise',
    id: r1.id,
    text: `# Candidate\n\n${head1200}MID_TOKEN_BETA_${'B'.repeat(285)}${tailRest}`,
  })
  await action({ action: 'resume-review', id: r2.id, decision: 'approve' })
  const staleConfirmRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: batchPreview.confirmToken })
  assert.equal(staleConfirmRes.requiresConfirmation, true)
  assert.equal(staleConfirmRes.staleConfirmation, true)
  assert.equal(llmCalls, 1)
  const stAfterResumeEdit = await getState('zh')
  assert.equal(stAfterResumeEdit.opportunities.find(o => o.id === complete51.id).match.zone, 'pending_local')

  // Unit tests for strict per-batch validation: cross-batch ID injection, duplicate IDs, non-integer scores, unsent excerpt quotes
  const batchProfile = buildPatrolSearchProfile({ resumeText: '# Eng', goal: 'AI Infra', searchTerms: ['AI Infra'] })
  const jobA = { id: 'job-a', title: 'Eng A', location: '上海', jd: '负责 GPU 集群推理调度与容器平台研发优化工作。' }
  const omittedQuote = '这是模型从未在节选文本里收到过的隐藏后缀段落职责描述'
  const jobB = {
    id: 'job-b',
    title: 'Eng B',
    location: '上海',
    jd: [
      '岗位职责\n负责前端性能与核心调度。',
      '先导背景介绍。'.repeat(60),
      '团队研发文化介绍。'.repeat(60),
      '日常协作流程说明。'.repeat(60),
      '系统稳定性演进历程。'.repeat(60),
      `延伸工作：${omittedQuote}，并承担跨部门长周期研发协同任务。`.repeat(6),
    ].join('\n\n'),
  }
  const jobBadTypes = ['false', 'arr', 'ws', 'gt100'].map(k => ({
    id: `job-${k}`, title: `Role ${k}`, location: '上海', jd: '负责大规模推理服务平台与基础设施核心研发工作。',
  }))

  // 1) Cross-batch ID injection + duplicate ID within batch + invalid score types + unsent excerpt quote
  const observedAtomicBatches = []
  const atomicMetrics = {}
  const atomicRes = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 3800 }, defaultMaxTokens: 2048 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'small' },
        async *stream(req) {
          const payload = JSON.parse(req.messages[0].content[0].text)
          const idx = observedAtomicBatches.length
          observedAtomicBatches.push(payload.jobs)
          const items = idx === 0
            ? [
                { id: 'job-a', score: 92, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责 GPU 集群推理调度与容器平台研发优化工作', reason: 'cross' },
                { id: 'job-b', score: 91, tier: 'top', primaryRoleFit: 'match', roleQuote: omittedQuote, reason: 'omitted' },
              ]
            : [
                { id: 'job-a', score: 90, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责 GPU 集群推理调度与容器平台研发优化工作', reason: 'dup1' },
                { id: 'job-a', tier: 'top', primaryRoleFit: 'match', roleQuote: '', reason: 'dup2' },
                { id: 'job-false', score: false, tier: 'stretch', reason: 'bool' },
                { id: 'job-arr', score: [95], tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模推理服务平台与基础设施核心研发工作', reason: 'arr' },
                { id: 'job-ws', score: '   ', tier: 'stretch', reason: 'ws' },
                { id: 'job-gt100', score: 999, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模推理服务平台与基础设施核心研发工作', reason: 'gt100' },
              ]
          yield { type: 'text-delta', text: JSON.stringify({ items }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:small', sendToModel: true },
    jobs: [jobA, jobB, ...jobBadTypes.slice(0, 2)],
    profile: batchProfile,
    resumeText: '# Eng',
    metricsOut: atomicMetrics,
  })
  assert.equal(observedAtomicBatches[0].length, 1)
  assert.equal(observedAtomicBatches[0][0].id, 'job-b')
  assert.equal(observedAtomicBatches[0][0].jdTruncated, true)
  assert.equal(observedAtomicBatches[0][0].jd.includes(omittedQuote), false)
  assert.equal(atomicMetrics.batches.length, 2)
  assert.equal(atomicRes.every(r => r.mode === 'heuristic'), true, 'Every cross-batch, duplicate, unsent-quote, or invalid-score result must stay heuristic')
  assert.equal(atomicRes.find(r => r.opportunityId === 'job-b').uncertaintyCode, 'unverified_quote')
  assert.equal(atomicMetrics.failedBatches, 2)
  assert.equal(atomicMetrics.failedJobs, 4)
  // Verify whitespace & out-of-range scores directly as well
  const extraBadRes = await triageBatchWithLlm({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
      prepareCall: async () => ({
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              items: [
                { id: 'job-ws', score: '   ', tier: 'stretch', reason: 'ws' },
                { id: 'job-gt100', score: 999, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责大规模推理服务平台与基础设施核心研发工作', reason: 'gt100' },
              ],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    },
    config: { model: 'mock:fast', sendToModel: true },
    jobs: jobBadTypes.slice(2),
    profile: batchProfile,
    resumeText: '# Eng',
  })
  assert.equal(extraBadRes.every(r => r.mode === 'heuristic' && r.uncertaintyCode === 'missing_score'), true)
})

test('PR2 model destination binding: default DSH provider switch invalidates pending confirmToken with 0 calls until re-previewed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-pr2-model-bind-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let activeDefaultProvider = 'prov-a'
  const calledProviders = []

  const llm = {
    listProviders: () => [
      { id: 'prov-a', name: 'Provider A' },
      { id: 'prov-b', name: 'Provider B' },
    ],
    listModels: async () => [{ id: 'model-1', name: 'Model 1' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
    prepareCall: async ({ provider, model }) => ({
      model: { provider, id: model },
      async *stream(req) {
        calledProviders.push(`${provider}:${model}`)
        const payload = JSON.parse(req.messages[0].content[0].text)
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            items: payload.jobs.map(j => ({
              id: j.id,
              score: 88,
              tier: 'top',
              primaryRoleFit: 'match',
              roleQuote: j.jd.slice(0, 24),
              uncertain: false,
              reason: '匹配',
            })),
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    get: key => (key === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: activeDefaultProvider, model: 'model-1' }) }
      : null),
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const action = async body => {
    const r = await harness.call('POST', '/api/career-agent/action', body)
    assert.equal(r.status, 200)
    return r.json.result
  }
  const imp = await action({ action: 'resume-import', title: 'Master', text: '# Candidate\n\n## Experience\n- Built AI Infra GPU serving clusters.' })
  await action({ action: 'resume-review', id: imp.id, decision: 'approve' })
  // Inherit default DSH model (`model: ''`) while sendToModel is off
  await action({ action: 'configure', config: { sendToModel: false, model: '', goal: 'AI Infra', searchTerms: ['AI Infra'] } })
  const job = await action({
    action: 'job-add',
    job: { company: 'ModelBindCo', title: 'AI Infra Engineer', location: '上海', jd: '负责大模型推理引擎与 GPU 调度核心研发工作。' },
  })

  // Open single-role confirm while DSH default resolves to prov-a
  const prevA = await action({ action: 'triage-preview', id: job.id })
  assert.equal(prevA.count, 1)
  assert.ok(prevA.model.startsWith('prov-a:'))
  assert.ok(prevA.confirmToken)

  // Switch DSH default provider to prov-b BEFORE confirming -> old token must be rejected with 0 calls
  activeDefaultProvider = 'prov-b'
  const staleRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: prevA.confirmToken })
  assert.equal(staleRes.skipped, true)
  assert.equal(staleRes.requiresConfirmation, true)
  assert.equal(staleRes.staleConfirmation, true)
  assert.deepEqual(calledProviders, [])

  // Re-preview binds prov-b cleanly and succeeds once confirmed
  const prevB = await action({ action: 'triage-preview', id: job.id })
  assert.ok(prevB.model.startsWith('prov-b:'))
  const okRes = await action({ action: 'triage-jobs', confirmed: true, confirmToken: prevB.confirmToken })
  assert.equal(okRes.llmScoredCount, 1)
  assert.equal(calledProviders.length, 1)
  assert.ok(calledProviders[0].startsWith('prov-b:'))
})
