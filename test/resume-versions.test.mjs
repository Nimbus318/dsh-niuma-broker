import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'

import { CareerStore } from '../src/career.mjs'
import { apply } from '../src/host.mjs'
import { proposeIntake, READONLY_INTAKE_KINDS } from '../src/intake.mjs'
import { buildJobResumePickerModel, organizeResumeVersions } from '../src/resume-versions.mjs'
import { extractCustomReceiptEvidence } from '../client/shared.js'

test('organizeResumeVersions folds legacy flat revisions into 1 master track and tracks tailored branch lineage', () => {
  const resumes = [
    { id: 'r1', kind: 'import', title: '基础简历', status: 'approved', createdAt: '2026-11-20T00:37:00.000Z', text: '# Lin\n- A' },
    { id: 'r2', kind: 'tailored', variant: 'conversation', baseId: 'r1', general: true, title: '对话优化稿', status: 'approved', createdAt: '2026-11-20T05:00:00.000Z', text: '# Lin\n- A+' },
    { id: 'r3', kind: 'revised', parentId: 'r2', baseId: 'r2', title: '对话优化稿', status: 'pending', autoSaved: true, createdAt: '2026-11-20T12:10:00.000Z', updatedAt: '2026-11-20T12:15:00.000Z', text: '# Lin\n- A++' },
    { id: 'r4', kind: 'tailored', baseId: 'r1', opportunityId: 'job-1', title: '字节跳动 · AI Infra', status: 'approved', createdAt: '2026-11-20T06:00:00.000Z', text: '# Lin\n- Byte' },
  ]
  const opportunities = [{ id: 'job-1', company: '字节跳动', title: 'AI Infra' }]
  const tree = organizeResumeVersions(resumes, { opportunities })

  assert.equal(tree.masters.length, 1)
  const master = tree.masters[0]
  assert.equal(master.trackId, 'r1')
  assert.equal(master.versionCount, 3)
  assert.deepEqual(master.revisions.map(r => r.versionTag), ['v1', 'v2', 'v3'])
  assert.equal(master.latest.id, 'r3')
  assert.equal(master.latestApproved.id, 'r2')
  assert.equal(master.workingDraft.id, 'r3')
  assert.equal(master.isDefault, true)

  assert.equal(tree.branches.length, 1)
  const branch = tree.branches[0]
  assert.equal(branch.opportunityId, 'job-1')
  assert.equal(branch.latest.sourceTrackId, 'r1')
  assert.equal(branch.latest.sourceBaseVersion, 1)
  assert.equal(branch.latest.masterBehind, true)
})

test('buildJobResumePickerModel exposes autosaved working draft and prioritizes current editor resume', () => {
  const resumes = [
    { id: 'r1', kind: 'import', title: '基础简历', status: 'approved', createdAt: '2026-11-20T00:37:00.000Z', text: '# Base' },
    { id: 'r2', kind: 'tailored', variant: 'conversation', baseId: 'r1', general: true, title: '对话优化稿', status: 'approved', createdAt: '2026-11-20T05:00:00.000Z', text: '# Opt' },
    { id: 'r3', kind: 'revised', parentId: 'r2', baseId: 'r2', title: '对话优化稿', status: 'pending', autoSaved: true, createdAt: '2026-11-20T12:10:00.000Z', updatedAt: '2026-11-20T12:20:00.000Z', text: '# Live Edit' },
  ]
  const picker = buildJobResumePickerModel(resumes, {
    jobId: 'job-2',
    currentEditorResumeId: 'r3',
  })

  // Must include BOTH the live autosaved working draft (r3) and approved head (r2) in masterOptions,
  // and fold r1 into collapsible historyOptions!
  assert.equal(picker.masterOptions.length, 2)
  assert.equal(picker.masterOptions[0].id, 'r3')
  assert.equal(picker.masterOptions[0].isCurrentEditor, true)
  assert.equal(picker.masterOptions[0].versionTag, 'v3')
  assert.equal(picker.masterOptions[1].id, 'r2')
  assert.equal(picker.historyOptions.length, 1)
  assert.equal(picker.historyOptions[0].id, 'r1')
  assert.equal(picker.defaultChoice.id, 'r3')
})

test('CareerStore supports master track rename, default switch, branchMasterResume, and clears autoSaved on approve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-v014-'))
  try {
    const store = new CareerStore({ file: join(dir, 'career.json') })
    const r1 = await store.importResume({ title: '基础简历', text: '# 候选人\n\n## 经历\n- 搭建分布式推理集群' })
    await store.reviewResume(r1.id, { action: 'approve' })

    const draft = await store.reviseResume(r1.id, { text: '# 候选人\n\n## 经历\n- 搭建分布式推理集群（吞吐 +45%）', autoSaved: true })
    assert.equal(draft.autoSaved, true)
    assert.equal(draft.trackId, r1.id)

    const approved = await store.reviewResume(draft.id, { action: 'approve' })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.autoSaved, undefined)

    await store.renameResumeTrack(draft.id, 'AI Infra 主干简历')
    const branch = await store.branchMasterResume(draft.id, '后端架构方向主干')
    assert.notEqual(branch.trackId, r1.id)
    assert.equal(branch.trackTitle, '后端架构方向主干')
    assert.equal(branch.status, 'approved')

    await store.setDefaultMasterTrack(branch.trackId)
    const summary = await store.summary()
    assert.equal(summary.defaultMasterTrackId, branch.trackId)
    const renamedRow = summary.resumes.find(r => r.id === draft.id)
    assert.equal(renamedRow.trackTitle, 'AI Infra 主干简历')
    assert.ok(Array.isArray(renamedRow.evidenceIds))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('proposeIntake supports natural-language filter, compare, and answer while validating real opportunity IDs', async () => {
  const opportunities = [
    { id: 'opp-byte', company: '字节跳动', title: 'AI Infra 工程师', location: '上海', stage: 'discovered', jdExcerpt: 'vLLM, CUDA, Kubernetes' },
    { id: 'opp-tencent', company: '腾讯', title: '大模型推理架构师', location: '深圳', stage: 'submitted', jdExcerpt: 'TensorRT-LLM, C++' },
  ]
  const mockConfig = { model: 'mock:pro', sendToModel: true }

  const makeLlm = payload => ({
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(payload) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  // 1. Natural-language filter (drops unknown hallucinated IDs!)
  const filterRes = await proposeIntake({
    llm: makeLlm({
      kind: 'filter',
      summary: '已筛出上海 AI Infra 岗位',
      data: {
        label: '上海 · AI Infra',
        opportunityIds: ['opp-byte', 'fake-hallucinated-id'],
        reasons: { 'opp-byte': '地点在上海且匹配你的 vLLM 经验', 'fake-hallucinated-id': 'ignored' },
      },
    }),
    config: mockConfig,
    text: '帮我只要上海的 AI Infra 岗位',
    context: { opportunities },
  })
  assert.equal(filterRes.kind, 'filter')
  assert.ok(READONLY_INTAKE_KINDS.has(filterRes.kind))
  assert.deepEqual(filterRes.data.opportunityIds, ['opp-byte'])
  assert.deepEqual(filterRes.data.reasons, { 'opp-byte': '地点在上海且匹配你的 vLLM 经验' })

  // 2. Natural-language compare
  const compareRes = await proposeIntake({
    llm: makeLlm({
      kind: 'compare',
      summary: '字节更贴合你的上海地点与 K8s 经验',
      data: {
        title: '字节 vs 腾讯推理岗对比',
        recommendation: '优先推进字节跳动，上海本地且 vLLM/K8s 直接命中',
        items: [
          { opportunityId: 'opp-byte', verdict: '最贴合', pros: '上海 + vLLM', cons: '节奏快', fitScore: 92 },
          { opportunityId: 'opp-tencent', verdict: '备选', pros: '已投递', cons: '需去深圳', fitScore: 78 },
        ],
        dimensions: [
          { name: '地点', values: { 'opp-byte': '上海', 'opp-tencent': '深圳' } },
        ],
      },
    }),
    config: mockConfig,
    text: '对比字节和腾讯这两个岗',
    context: { opportunities },
  })
  assert.equal(compareRes.kind, 'compare')
  assert.equal(compareRes.data.items.length, 2)
  assert.equal(compareRes.data.items[0].company, '字节跳动')
  assert.equal(compareRes.data.dimensions[0].values['opp-byte'], '上海')

  // 3. Open-ended personalized Q&A with clickable job references & suggestedFilter
  const answerRes = await proposeIntake({
    llm: makeLlm({
      kind: 'answer',
      summary: '建议优先准备字节跳动一面',
      data: {
        answer: '结合你的简历，字节的 AI Infra 岗位与你的分布式推理经验重合度最高。',
        referencedJobs: [{ opportunityId: 'opp-byte', note: '最高匹配' }],
        suggestedFilter: { label: '高匹配优先', opportunityIds: ['opp-byte'] },
      },
    }),
    config: mockConfig,
    text: '我应该优先投递和准备哪家？',
    context: { opportunities, resumeExcerpt: '# Lin\n- vLLM 分布式推理集群优化' },
  })
  assert.equal(answerRes.kind, 'answer')
  assert.equal(answerRes.data.referencedJobs[0].company, '字节跳动')
  assert.deepEqual(answerRes.data.suggestedFilter.opportunityIds, ['opp-byte'])
})

test('host draft-intake returns ephemeral filter/compare/answer without polluting state.intakes, and manual run works when mode=off', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-host-v014-'))
  const harness = createFetchHarness()
  let dispose
  let sessionScanned = false
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => { sessionScanned = true; return [] },
      readSession: async () => { throw new Error('none') },
    },
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream() {
        yield {
          type: 'block-end', index: 0,
          block: {
            type: 'text',
            text: JSON.stringify({
              kind: 'answer',
              summary: '当前共 1 个岗位',
              data: { answer: '你目前收藏了字节跳动 AI Infra 岗位。' },
            }),
          },
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

  await call('/api/career-agent/action', {
    action: 'job-add',
    job: { company: '字节跳动', title: 'AI Infra 工程师', location: '上海', jd: '负责推理框架优化' },
  })
  const reply = await call('/api/career-agent/action', {
    action: 'draft-intake',
    model: 'mock:pro',
    text: '分析一下我现在的岗位',
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.data.result.kind, 'answer')
  assert.equal(reply.data.result.ephemeral, true)
  const st = (await call('/api/career-agent/state')).data
  assert.equal(st.intakes.length, 0, 'Ephemeral copilot answers must not pollute pending state.intakes')
  assert.equal(sessionScanned, false)
})

test('extractCustomReceiptEvidence strips redundant boilerplate while keeping custom notes', () => {
  assert.equal(extractCustomReceiptEvidence('已完成投递 · 字节跳动', { label: '已完成投递', company: '字节跳动' }), '')
  assert.equal(extractCustomReceiptEvidence('流程未通过 · Stripe', { label: '雇主拒绝', company: 'Stripe' }), '')
  assert.equal(extractCustomReceiptEvidence('已婉拒 Offer · Vercel', { label: '已拒绝 Offer', company: 'Vercel' }), '')
  assert.equal(extractCustomReceiptEvidence('收到一面邀请 · 字节跳动', { label: '收到面试邀请', company: '字节跳动' }), '')
  assert.equal(extractCustomReceiptEvidence('已完成一面 · 字节跳动', { label: '已参加面试', company: '字节跳动' }), '')
  assert.equal(extractCustomReceiptEvidence('雇主已确认收件 · 字节跳动', { label: '雇主确认收件', company: '字节跳动' }), '')
  assert.equal(extractCustomReceiptEvidence('内推码 N7K2，HR 已收件', { label: '已完成投递', company: '字节跳动' }), '内推码 N7K2，HR 已收件')
  assert.equal(extractCustomReceiptEvidence('已完成投递 · 内推链接投递', { label: '已完成投递', company: '字节跳动' }), '内推链接投递')
  assert.equal(extractCustomReceiptEvidence('改期通知：二面', { label: '已接受面试安排', company: '字节跳动' }), '改期通知：二面')
})

test('watchSessions=false independently skips session scans while keeping mode=search intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-sessions-'))
  const harness = createFetchHarness()
  let dispose = () => {}
  let sessionListCalls = 0
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => { sessionListCalls += 1; return [] },
      readSession: async () => ({ session: { id: 's1' }, entries: [] }),
    },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'pro', name: 'Pro' }],
      async *chat() { yield { type: 'finish', reason: { kind: 'stop' } } },
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

  // Authorize session scope + set mode=search + watchSessions=false
  const cfg = await call('/api/career-agent/action', {
    action: 'configure',
    config: {
      mode: 'search',
      watchSessions: false,
      sendToModel: true,
      model: 'mock:pro',
      sources: [{ id: 'dsh-session', projects: ['*'] }],
    },
  })
  assert.equal(cfg.status, 200)
  let st = (await call('/api/career-agent/state')).data
  assert.equal(st.mode, 'search')
  assert.equal(st.config.watchSessions, false)

  // Manual run with watchSessions=false must NOT call listSessions
  await call('/api/career-agent/action', { action: 'run' })
  assert.equal(sessionListCalls, 0, 'scanSessions must be skipped when watchSessions=false')

  // Flip watchSessions=true: mode stays 'search' and session scan runs
  await call('/api/career-agent/action', { action: 'configure', config: { watchSessions: true } })
  st = (await call('/api/career-agent/state')).data
  assert.equal(st.mode, 'search')
  assert.equal(st.config.watchSessions, true)
  await call('/api/career-agent/action', { action: 'run' })
  assert.equal(sessionListCalls, 1, 'scanSessions must run once watchSessions=true')
})

test('host summary sorts active lifecycle stages ahead of closed jobs (offer > applied > new > closed)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-order-'))
  const harness = createFetchHarness()
  let dispose = () => {}
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ session: { id: 's1' }, entries: [] }) },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      async *chat() { yield { type: 'finish', reason: { kind: 'stop' } } },
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

  const jClosed = (await call('/api/career-agent/action', { action: 'job-add', job: { company: 'Stripe', title: 'Closed Role' } })).data.result
  const jNew = (await call('/api/career-agent/action', { action: 'job-add', job: { company: 'ByteDance', title: 'New Role' } })).data.result
  const jApplied = (await call('/api/career-agent/action', { action: 'job-add', job: { company: 'Tencent', title: 'Applied Role' } })).data.result
  const jOffer = (await call('/api/career-agent/action', { action: 'job-add', job: { company: 'Linear', title: 'Offer Role' } })).data.result

  // Give the closed role MORE receipts than the active roles to verify stage priority beats receiptCount
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: jClosed.id, type: 'application_submitted', source: 'manual', confirmed: true, evidence: 'submitted', material: 'v1' },
  })
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: jClosed.id, type: 'interview_completed', source: 'manual', confirmed: true, evidence: 'done', round: '一面' },
  })
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: jClosed.id, type: 'rejected', source: 'manual', confirmed: true, evidence: 'rejected' },
  })
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: jApplied.id, type: 'application_submitted', source: 'manual', confirmed: true, evidence: 'submitted', material: 'v1' },
  })
  await call('/api/career-agent/action', {
    action: 'receipt',
    receipt: { opportunityId: jOffer.id, type: 'offer_received', source: 'manual', confirmed: true, evidence: 'written offer', form: 'written' },
  })

  const st = (await call('/api/career-agent/state')).data
  assert.deepEqual(
    st.opportunities.map(j => j.company),
    ['Linear', 'Tencent', 'ByteDance', 'Stripe'],
    'Expected Offer -> Applied -> New -> Closed order so rejected jobs sink to the bottom',
  )

  // Add 105 fresh jobs and verify the closed tracked job (Stripe) is NEVER truncated by the 100-item cap
  for (let i = 0; i < 105; i += 1) {
    await call('/api/career-agent/action', {
      action: 'job-add',
      job: { company: `FreshCo-${i}`, title: `Role ${i}` },
    })
  }
  const stMany = (await call('/api/career-agent/state')).data
  assert.equal(stMany.opportunities.at(-1).company, 'Stripe', 'Closed tracked job must stay retained at the bottom')
  assert.equal(stMany.opportunities[0].company, 'Linear', 'Active Offer job must remain #1 at the top')
})

test('renaming a tailored branch track updates branch.label and revision trackTitle across all versions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-branch-rename-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new CareerStore({ file: join(dir, 'career.json') })
  const base = await store.importResume({ title: '通用主干', text: '# 林予安\n- 主导 GPU 调度' })
  await store.reviewResume(base.id, { action: 'approve' })
  const b1 = await store.proposeTailoredResume({
    baseId: base.id,
    opportunityId: 'tencent:social:9001',
    title: '腾讯 · Agent Harness',
    lines: [{ source: '- 主导 GPU 调度', text: '- 主导 GPU 调度与 Agent 沙箱' }],
  })
  await store.reviewResume(b1.id, { action: 'approve' })
  const b2 = await store.reviseResume(b1.id, {
    text: '# 林予安\n- 主导千卡 GPU 调度与 Agent 沙箱',
  })
  await store.renameResumeTrack(b2.id, '腾讯 AI Infra 冲刺版')
  const summary = await store.summary()
  const tree = organizeResumeVersions(summary.resumes, {
    opportunities: [{ id: 'tencent:social:9001', company: '腾讯', title: 'Agent Harness 工程师' }],
  })
  assert.equal(tree.branches.length, 1)
  assert.equal(tree.branches[0].label, '腾讯 AI Infra 冲刺版')
  assert.ok(tree.branches[0].revisions.every(r => r.trackTitle === '腾讯 AI Infra 冲刺版'))
})
