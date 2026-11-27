import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateJd, buildDiligencePrompt, buildStudyPrompt, buildUserJdSignals, mergeJdRiskItems } from '../src/jd-highlight.mjs'
import { normalizeDomain, resolveCompanyDomain } from '../src/company-domains.mjs'

test('JD highlighter matches resume/evidence/search terms cleanly with strict ASCII boundaries and translates JD black-talk', () => {
  const jd = [
    '岗位职责：',
    '1. 负责公司大模型与 Agent 平台的 Kubernetes 和 GPU 算力调度系统，通过 email 与 Google 团队同步进展。',
    '2. 从 0 到 1 搭建高可用推理网关，需要极强的抗压能力强与扁平化管理心态。',
    '任职要求：',
    '- 熟悉 Rust、Go 与多区域异地双活架构，具备高并发系统经验。',
  ].join('\n')

  const signals = buildUserJdSignals({
    resumes: [{ status: 'approved', text: '# 林予安\n精通 Kubernetes、GPU 算力调度、Go 与 Agent 平台架构。' }],
    evidence: [{ status: 'approved', title: '千卡级 GPU 调度', text: '主导千卡集群调度与高并发推理网关。' }],
    config: { goal: '上海或远程 AI 基础设施方向', searchTerms: ['AI', '大模型'] },
    job: { company: 'MiniMax', title: 'AI 基础设施工程师', location: '上海', provider: 'feishu', jd },
    tailoredGaps: '简历暂缺「多区域异地双活」与 Rust 经验。',
  })

  const res = annotateJd(jd, signals)
  const matchedTerms = res.summary.matched.map(m => m.term.toLowerCase())
  const riskTerms = res.summary.risks.map(r => r.term)
  const gapTerms = res.summary.gaps.map(g => g.term)

  assert.ok(matchedTerms.includes('kubernetes'))
  assert.ok(matchedTerms.includes('gpu'))
  assert.ok(matchedTerms.includes('go'))
  // Static boilerplate rules no longer fire unsolicited risks before AI deep-read
  assert.equal(riskTerms.length, 0)
  assert.ok(gapTerms.includes('多区域异地双活'))

  // Ensure ASCII boundary check prevents "AI" matching inside "email" and "Go" inside "Google"
  const allHighlightedTexts = res.blocks.flatMap(b =>
    b.type === 'list' ? b.items.flat() : (b.segments || []),
  ).filter(s => s.kind).map(s => s.text.toLowerCase())
  assert.ok(!allHighlightedTexts.includes('ai'))
  const allPlain = res.blocks.flatMap(b =>
    b.type === 'list' ? b.items.flat() : (b.segments || []),
  ).filter(s => !s.kind).map(s => s.text).join(' ')
  assert.match(allPlain, /email/)
  assert.match(allPlain, /Google/)
})

test('buildDiligencePrompt prepares DSH-native web diligence briefs without search-engine links or static boilerplate', async () => {
  const { readFile } = await import('node:fs/promises')
  const jdHighlightSrc = await readFile(new URL('../src/jd-highlight.mjs', import.meta.url), 'utf8')
  const jobDetailSrc = (await Promise.all([
    readFile(new URL('../client/JobDetailSheet.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../client/JobJdWorkbench.jsx', import.meta.url), 'utf8'),
  ])).join('\n')

  assert.doesNotMatch(jdHighlightSrc, /google\.com\/search|bing\.com\/search/)
  assert.doesNotMatch(jobDetailSrc, /google\.com\/search|bing\.com\/search/)

  const prompt = buildDiligencePrompt({
    job: { company: 'MiniMax', title: 'AI Infra Tech Lead', location: '上海', url: 'https://jobs.example.com/minimax-infra' },
    diligence: ['核实推理集群近半年人员变化', '确认 On-Call 轮值频率'],
    risks: [{ term: '抗压能力强' }],
    matched: [{ term: 'Kubernetes' }],
  })
  assert.match(prompt, /MiniMax/)
  assert.match(prompt, /核实推理集群近半年人员变化/)
  assert.match(prompt, /抗压能力强/)
  assert.match(prompt, /Kubernetes/)
})

test('JD highlighter flags uncovered technical skills and bonus items as learnable topics and resolves cross-industry domains', () => {
  const jd = [
    '岗位职责：',
    '- 负责基于 Kubernetes 与 SGLang 的大模型推理集群建设。',
    '加分项：',
    '- 有 FP8 量化或 RDMA 网络调优经验优先。',
  ].join('\n')
  const signals = buildUserJdSignals({
    resumes: [{ status: 'approved', text: '# 林予安\n熟悉 Kubernetes 与 Go。' }],
    config: { searchTerms: ['大模型'] },
    job: { company: '宇树科技', title: 'AI 基础设施工程师', jd },
  })
  const res = annotateJd(jd, signals)
  const learnTerms = res.summary.learn
  assert.ok(learnTerms.some(l => l.term === 'SGLang'))
  const fp8 = learnTerms.find(l => l.term === 'FP8')
  assert.ok(fp8 && fp8.isBonus === true)
  const studyPrompt = buildStudyPrompt({ job: { company: '宇树科技', title: 'AI 基础设施工程师' }, term: 'FP8', isBonus: true, matched: res.summary.matched })
  assert.match(studyPrompt, /FP8/)
  assert.match(studyPrompt, /加分项/)

  assert.equal(resolveCompanyDomain({ company: '宇树科技' }), 'unitree.com')
  assert.equal(resolveCompanyDomain({ company: '理想汽车' }), 'lixiang.com')
  assert.equal(resolveCompanyDomain({ domain: 'https://www.databricks.com/company/careers' }), 'databricks.com')
  assert.equal(normalizeDomain('localhost'), '')
})

test('JD highlighter annotates AI intel.riskNotes directly onto JD spans so locate-in-JD always finds real marks', () => {
  const jd = [
    '岗位职责：',
    '- 负责大模型开发机平台的架构设计与核心研发。',
    '- 推进 GPU 共享及碎片治理，建立线上故障应急处置机制。',
  ].join('\n')
  const signals = buildUserJdSignals({
    resumes: [{ status: 'approved', text: '# 林予安\n熟悉 GPU 配额评估。' }],
    job: {
      company: '字节跳动',
      title: 'AI Infra',
      jd,
      intel: {
        riskNotes: [
          { term: '架构设计与核心研发', meaning: '需要亲自写系统', question: '前三个月交付哪些模块？' },
          { term: 'GPU 共享及碎片治理', meaning: '偏底层资源治理', question: '目前上线到什么程度？' },
          { term: '应急处置机制', meaning: '可能含 On-Call', question: '夜间值班频率？' },
        ],
      },
    },
  })
  const res = annotateJd(jd, signals)
  const riskTerms = res.summary.risks.map(r => r.term)
  assert.ok(riskTerms.includes('架构设计与核心研发'))
  assert.ok(riskTerms.includes('GPU 共享及碎片治理'))
  assert.ok(riskTerms.includes('应急处置机制'))
  const allSegs = res.blocks.flatMap(b => b.type === 'list' ? b.items.flat() : (b.segments ?? []))
  assert.ok(allSegs.some(s => s?.kind === 'risk' && s.text === 'GPU 共享及碎片治理'))
})

test('mergeJdRiskItems reflects AI-detected context risks cleanly without noisy static boilerplate false positives', () => {
  const jd = '岗位要求：\n1. 良好的学习和自我驱动能力，具备良好的跨团队沟通协作能力。\n2. 负责多业务线协同落地与稳定性治理。'
  // Before AI runs: polite boilerplate like "自我驱动" must NOT flash as a false-positive risk
  const preSignals = buildUserJdSignals({
    resumes: [],
    job: { company: '阿里云', title: 'AI 平台研发', jd },
  })
  const preAnnotated = annotateJd(jd, preSignals)
  assert.equal(preAnnotated.summary.risks.length, 0)
  assert.equal(mergeJdRiskItems([], preAnnotated.summary.risks).length, 0)

  // After AI deep-read detects real structural risk: binds cleanly onto JD span and appears in riskItems
  const aiRisks = [
    { term: '多业务线协同落地', meaning: '可能存在多方需求拉扯与优先级冲突', question: '团队如何排优先级？' },
  ]
  const signals = buildUserJdSignals({
    resumes: [],
    job: { company: '阿里云', title: 'AI 平台研发', jd, intel: { riskNotes: aiRisks } },
  })
  const annotated = annotateJd(jd, signals)
  const merged = mergeJdRiskItems(aiRisks, annotated.summary.risks)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].term, '多业务线协同落地')
  assert.equal(merged[0].locateTerm, '多业务线协同落地')
})
