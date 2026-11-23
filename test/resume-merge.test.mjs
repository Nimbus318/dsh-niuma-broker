import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CareerStore, resumeEvidenceIds } from '../src/career.mjs'
import { mergeEvidenceIntoResume, smartPlaceEvidenceIntoResume } from '../src/resume-merge.mjs'

const SAMPLE_RESUME = `# 林予安
_AI Infra 平台研发工程师 · 算力调度与高可用推理_

## 工作经历

### 星火云智 · 高级平台研发工程师（2023.03 – 至今）
- 主导 GPU 异构算力调度平台重构，支撑千卡规模弹性扩缩容。
- 优化多租户配额治理与告警降噪，核心链路 MTTR 下降 38%。

### 极光数据 · 后端研发工程师（2020.07 – 2023.02）
- 负责实时日志采集与检索链路建设，日均吞吐 40TB。

## 项目经历

### Agent Sandbox 弹性执行沙箱
- 设计轻量容器冷启动池，将工具调用启动延迟压低至 180ms。

## 核心技能
- Go / Python / Kubernetes / CUDA / Prometheus

## 教育背景
- 浙江大学 · 计算机科学与技术（本科，2016 – 2020）
`

function mockLlmReturning(jsonObj) {
  const raw = JSON.stringify(jsonObj)
  return {
    listProviders: () => [{ id: 'mock' }],
    resolveModel: async () => ({ provider: 'mock', id: 'test' }),
    prepareCall: async () => ({
      model: { provider: 'mock', id: 'test' },
      async *stream() {
        yield { type: 'text-delta', text: raw }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

test('smartPlaceEvidenceIntoResume places overlapping evidence into matching ### block, never after Education', () => {
  const result = smartPlaceEvidenceIntoResume(SAMPLE_RESUME, [
    {
      id: 'ev-sandbox',
      title: 'Agent Sandbox 镜像预热优化',
      text: '实现 Agent Sandbox 分层镜像预热与快照复用，将容器冷启动 P99 延迟从 180ms 压降至 65ms。',
    },
  ])

  assert.equal(result.mode, 'structural')
  assert.doesNotMatch(result.markdown, /## 简历更新/)
  const sandboxIdx = result.markdown.indexOf('### Agent Sandbox 弹性执行沙箱')
  const bulletIdx = result.markdown.indexOf('实现 Agent Sandbox 分层镜像预热与快照复用')
  const skillsIdx = result.markdown.indexOf('## 核心技能')
  const eduIdx = result.markdown.indexOf('## 教育背景')
  assert.ok(sandboxIdx >= 0 && bulletIdx > sandboxIdx && bulletIdx < skillsIdx && skillsIdx < eduIdx,
    'Evidence must land inside the matching Agent Sandbox section before Skills and Education')
  assert.equal(result.placements.length, 1)
  assert.match(result.placements[0].section, /Agent Sandbox/)
})

test('smartPlaceEvidenceIntoResume places recent work output into the latest ### role under 工作经历', () => {
  const result = smartPlaceEvidenceIntoResume(SAMPLE_RESUME, [
    {
      id: 'ev-recent',
      title: '季度成本治理专项',
      text: '完成闲置算力自动回收机制落地',
      impact: '月度集群成本降低 22%',
    },
  ])

  assert.doesNotMatch(result.markdown, /## 简历更新/)
  const latestRoleIdx = result.markdown.indexOf('### 星火云智')
  const olderRoleIdx = result.markdown.indexOf('### 极光数据')
  const bulletIdx = result.markdown.indexOf('完成闲置算力自动回收机制落地，月度集群成本降低 22%')
  assert.ok(bulletIdx > latestRoleIdx && bulletIdx < olderRoleIdx,
    'Recent work achievement without specific old-project match must land under the latest role')
})

test('smartPlaceEvidenceIntoResume inserts before Skills/Education when resume lacks work/project headings', () => {
  const minimal = `# 张三

## 核心技能
- TypeScript / Node.js

## 教育背景
- 复旦大学 · 软件工程
`
  const result = smartPlaceEvidenceIntoResume(minimal, [
    { id: 'ev-1', title: '性能优化', text: '重构首屏打包与路由懒加载，首屏加载耗时下降 45%。' },
  ])
  const newSecIdx = result.markdown.indexOf('## 近期工作成果')
  const skillsIdx = result.markdown.indexOf('## 核心技能')
  const eduIdx = result.markdown.indexOf('## 教育背景')
  assert.ok(newSecIdx >= 0 && newSecIdx < skillsIdx && skillsIdx < eduIdx)
})

test('mergeEvidenceIntoResume uses validated LLM merge output and rejects lazy trailing ## 简历更新 or truncation', async () => {
  const polishedMd = SAMPLE_RESUME.replace(
    '- 优化多租户配额治理与告警降噪，核心链路 MTTR 下降 38%。',
    '- 优化多租户配额治理与告警降噪，核心链路 MTTR 下降 38%。\n- 设计并落地闲置 GPU 自动回收与分时复用策略，月度算力成本降低 22%。',
  )
  const goodLlm = mockLlmReturning({
    markdown: polishedMd,
    summary: '已将算力成本治理成果润色并入「工作经历 · 星火云智」',
    placements: [
      {
        evidenceId: 'ev-gpu',
        section: '工作经历 · 星火云智',
        bullet: '设计并落地闲置 GPU 自动回收与分时复用策略，月度算力成本降低 22%。',
        reason: '与当前公司 GPU 算力调度职责一致',
      },
    ],
  })

  const merged = await mergeEvidenceIntoResume({
    llm: goodLlm,
    config: { model: 'mock:test' },
    baseMarkdown: SAMPLE_RESUME,
    baseTitle: '林予安 · 通用简历',
    additions: [{ id: 'ev-gpu', title: 'GPU 回收', text: '做了闲置 GPU 回收，月度成本省了 22%。' }],
  })
  assert.equal(merged.mode, 'llm')
  assert.equal(merged.placements[0].section, '工作经历 · 星火云智')
  assert.ok(merged.markdown.includes('设计并落地闲置 GPU 自动回收与分时复用策略'))

  // Guardrail 1: reject lazy trailing `## 简历更新` dump and fall back cleanly to structural placement
  const lazyLlm = mockLlmReturning({
    markdown: `${SAMPLE_RESUME.trimEnd()}\n\n## 简历更新\n\n- 做了闲置 GPU 回收。\n`,
    summary: '追加到了最后',
    placements: [],
  })
  const rescuedLazy = await mergeEvidenceIntoResume({
    llm: lazyLlm,
    config: { model: 'mock:test' },
    baseMarkdown: SAMPLE_RESUME,
    additions: [{ id: 'ev-gpu', title: 'GPU 回收', text: '实现闲置 GPU 自动回收机制，月度算力成本降低 22%。' }],
  })
  assert.equal(rescuedLazy.mode, 'structural')
  assert.doesNotMatch(rescuedLazy.markdown, /## 简历更新/)
  assert.ok(rescuedLazy.markdown.indexOf('实现闲置 GPU 自动回收机制') < rescuedLazy.markdown.indexOf('## 教育背景'))

  // Guardrail 2: reject severely truncated LLM output
  const truncatedLlm = mockLlmReturning({
    markdown: '# 林予安\n\n- 只剩一行\n',
    summary: '截断了',
    placements: [],
  })
  const rescuedTruncated = await mergeEvidenceIntoResume({
    llm: truncatedLlm,
    config: { model: 'mock:test' },
    baseMarkdown: SAMPLE_RESUME,
    additions: [{ id: 'ev-gpu', title: 'GPU 回收', text: '实现闲置 GPU 自动回收机制。' }],
  })
  assert.equal(rescuedTruncated.mode, 'structural')
  assert.ok(rescuedTruncated.markdown.includes('浙江大学'))
})

test('CareerStore.proposeResume preserves smart mergedText while enforcing full evidence provenance and revocation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-merge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new CareerStore({ file: join(dir, 'career.json'), now: () => new Date('2026-11-21T03:00:00.000Z') })
  await store.authorizeSource({ id: 'manual', projects: ['personal'] })
  const { evidence: [ev] } = await store.ingestEvents([{
    id: 'ev-1', sourceId: 'manual', projectId: 'personal', kind: 'manual',
    occurredAt: '2026-11-21T02:00:00.000Z',
    evidence: [{ title: '闲置算力回收', text: '主导闲置 GPU 回收体系建设，月度集群成本降低 22%。' }],
  }], { explicitManual: true })
  await store.reviewEvidence(ev.id, { action: 'approve', shareable: true })

  const base = await store.importResume({ title: '通用简历', text: SAMPLE_RESUME })
  await store.reviewResume(base.id, { action: 'approve' })

  const smart = smartPlaceEvidenceIntoResume(SAMPLE_RESUME, [ev])
  const merged = await store.proposeResume({
    title: '简历更新',
    baseId: base.id,
    items: [{ text: ev.text, evidenceIds: [ev.id] }],
    mergedText: smart.markdown,
    summary: smart.summary,
    placements: smart.placements,
    mergeMode: smart.mode,
  })
  await store.reviewResume(merged.id, { action: 'approve' })

  const exported = await store.exportResume(merged.id)
  assert.equal(exported, smart.markdown)
  assert.doesNotMatch(exported, /## 简历更新/)
  assert.ok(exported.indexOf('主导闲置 GPU 回收体系建设') < exported.indexOf('## 教育背景'))
  assert.deepEqual([...resumeEvidenceIds((await store.summary()).resumes, merged.id)], [ev.id])

  // Revoking evidence privacy must invalidate export and redact mergedText from summary!
  await store.reviewEvidence(ev.id, { action: 'approve', shareable: false })
  await assert.rejects(store.exportResume(merged.id), /human-approved|external use/)
  const afterSummary = await store.summary()
  const redactedRow = afterSummary.resumes.find(r => r.id === merged.id)
  assert.equal(redactedRow.status, 'revoked')
  assert.equal(redactedRow.mergedText, undefined)
  assert.equal(redactedRow.placements, undefined)
})
