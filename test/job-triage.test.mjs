import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPatrolSearchProfile, scoreOpportunityHeuristic, triageBatchWithLlm } from '../src/job-triage.mjs'
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

test('buildPatrolSearchProfile expands synonyms from goal + resume and parses avoidHints', () => {
  const profile = buildPatrolSearchProfile({
    resumeText: RESUME,
    goal: '找上海或杭州的 Senior AI Infra / Agent 平台工程师，不看外包和纯销售',
    searchTerms: ['AI Infra'],
    evidence: [],
    feedback: {},
  })

  assert.ok(profile.expandedQueries.includes('AI Infra'))
  assert.ok(profile.expandedQueries.length >= 3, 'Should expand beyond single literal term for better patrol recall')
  assert.ok(profile.targetCities.includes('上海'))
  assert.ok(profile.targetCities.includes('杭州'))
  assert.ok(profile.avoidHints.includes('外包'))
  assert.ok(profile.avoidHints.includes('销售'))
  assert.equal(profile.isEngineerProfile, true)
})

test('the four board queries carry the requested specialty even when a model puts company and hiring channel first', () => {
  for (const searchTerms of [
    ['智元机器人', '社招', '人形机器人', '全身运动控制算法', '上海'],
    ['智元机器人', '机器人运动控制', '人形机器人', '全身运动控制算法', '上海'],
    ['AGIBOT', 'Shanghai', 'experienced hire', 'whole-body control algorithm engineer'],
  ]) {
    const profile = buildPatrolSearchProfile({goal: '寻找上海智元机器人的社招岗位', searchTerms})
    assert.equal(profile.expandedQueries[0], '运动控制')
    assert.ok(profile.expandedQueries.includes('全身控制'))
    assert.ok(profile.expandedQueries.includes('运控'))
    assert.ok(profile.expandedQueries.length <= 4)
    assert.ok(!profile.expandedQueries.some(q => /^(?:智元机器人|社招|上海|AGIBOT|Shanghai|experienced hire)$/iu.test(q)))
    assert.deepEqual(profile.roleFocuses.map(focus => focus.id), ['robot-motion-control', 'whole-body-control'])
  }
  const overseas = buildPatrolSearchProfile({goal: 'Humanoid whole-body control engineer in London'})
  assert.deepEqual(overseas.expandedQueries.slice(0, 2), ['motion control', 'whole-body control'])
})

test('robotics background and broad research interests alone do not imply a motion-control target', () => {
  for (const goal of ['找上海的具身多模态算法岗位', '之前做过机器人运动控制，现在想做产品经理', '不做机器人运动控制，想做具身感知算法']) {
    const profile = buildPatrolSearchProfile({goal, resumeText: '曾为机器人开发全身运动控制算法。'})
    assert.deepEqual(profile.roleFocuses, [])
    assert.ok(!profile.expandedQueries.includes('运动控制'))
  }
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
