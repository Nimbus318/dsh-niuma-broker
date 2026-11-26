import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPatrolSearchProfile,
  clearBm25fCache,
  evaluateStage0HardFilter,
  isActualInternOrCampusOpening,
  rankOpportunitiesBm25f,
  selectTriageCandidates,
} from '../src/job-triage.mjs'
import { buildBm25fQuery, parseJdSections } from '../src/triage-recall.mjs'
import { apply } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'
import { compareReports, evaluateDataset } from '../scripts/eval/run-eval.mjs'

async function makeHostFixture(t, { jobs = [], goal = '', searchTerms = [], resumeText = '', llmHandler = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-triage-recall-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  const llm = llmHandler
    ? {
        listProviders: () => [{ id: 'mock' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 64_000 }, defaultMaxTokens: 4096 }),
        prepareCall: async () => ({
          model: { provider: 'mock', id: 'fast' },
          stream: llmHandler,
        }),
      }
    : null

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
      sendToModel: true,
      model: 'mock:fast',
      goal,
      searchTerms,
      boards: [{ provider: 'greenhouse', slug: 'acme', company: 'MockCo', label: 'MockCo' }],
    },
  })
  if (resumeText) {
    const r1 = await action({ action: 'resume-import', title: 'Master', text: resumeText })
    await action({ action: 'resume-review', id: r1.id, decision: 'approve' })
  }

  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  if (typeof dispose === 'function') await dispose()
  const ctrl = JSON.parse(readFileSync(controlPath, 'utf8'))
  ctrl.opportunities.push(...jobs)
  writeFileSync(controlPath, JSON.stringify(ctrl, null, 2))
  await apply(ctx)

  return {
    action,
    getState,
    readControl: () => JSON.parse(readFileSync(controlPath, 'utf8')),
    mutateControl: fn => {
      const next = JSON.parse(readFileSync(controlPath, 'utf8'))
      fn(next)
      writeFileSync(controlPath, JSON.stringify(next, null, 2))
    },
    reapply: async () => {
      if (typeof dispose === 'function') await dispose()
      await apply(ctx)
    },
  }
}

test('BM25F respects section duty weighting, whole-doc DF, non-negative small-N IDF, and zero-mutation cache parity', () => {
  clearBm25fCache()
  const profile = buildPatrolSearchProfile({
    goal: '上海 B2B SaaS 产品经理，专注审批流和 CRM',
    searchTerms: ['B2B', 'SaaS', '产品经理', 'CRM', '审批流'],
    resumeText: '主导企业 CRM 权限体系、CPQ报价引擎与低代码表单审批流建设。',
  })

  // Duty section weight (1.35) vs boilerplate (0.35)
  const dutyText = '岗位职责：\n负责企业 CRM 与审批流产品架构设计。'
  const boilerText = '岗位职责：\n负责行政排班。\n公司介绍：\n我司深耕 CRM 与审批流 SaaS。'
  const dutySecs = parseJdSections(dutyText)
  const boilerSecs = parseJdSections(boilerText)
  assert.equal(dutySecs[0].weight, 1.35)
  assert.equal(boilerSecs.find(s => s.text.includes('CRM')).weight, 0.35)

  // Small pool (N = 2 < 5): IDF must stay non-negative and duty-matched role must beat boilerplate role
  const smallPool = [
    { id: 'duty-1', title: '企业流程产品专家', location: '上海', jd: dutyText },
    { id: 'boiler-1', title: '行政助理', location: '上海', jd: boilerText },
  ]
  const resCold = rankOpportunitiesBm25f(smallPool, profile, { useCache: true })
  assert.equal(resCold.activeCount, 2)
  assert.ok(resCold.ranked[0].id === 'duty-1' && resCold.ranked[0].recallScore > resCold.ranked[1].recallScore)
  assert.ok(resCold.ranked[1].bm25fRaw >= 0, 'Small-N IDF smoothing must keep raw BM25F non-negative')

  // Hot cache run must match cold run bit-for-bit
  const resHot = rankOpportunitiesBm25f(smallPool, profile, { useCache: true })
  assert.deepEqual(
    resHot.ranked.map(r => [r.id, r.recallScore, r.bm25fRaw]),
    resCold.ranked.map(r => [r.id, r.recallScore, r.bm25fRaw]),
  )

  // Cache invalidates cleanly via vocabVersion when profile targets change
  const updatedProfile = buildPatrolSearchProfile({
    goal: '上海 行政运营主管',
    searchTerms: ['行政', '办公排班'],
    resumeText: '负责行政排班与资产采购。',
  })
  const resUpdated = rankOpportunitiesBm25f(smallPool, updatedProfile, { useCache: true })
  assert.notEqual(resUpdated.vocabVersion, resCold.vocabVersion)
  assert.equal(resUpdated.ranked[0].id, 'boiler-1', 'Updated profile anchors must recompute tokens cleanly')

  // Anonymous high-DF CJK bigrams drop above 40% (N >= 10), while explicit anchors stay intact
  const q = buildBm25fQuery(profile)
  assert.ok(q.some(item => item.type === 'anchor' && item.term === '产品经理'))
  assert.ok(q.some(item => item.type === 'cjk_bigram' && item.spanGroup.startsWith('resume:')))

  // Repeated title/JD token in one doc increments df once; single-term stuffing saturates sublinearly
  const stuffedDoc = {
    id: 'stuffed',
    title: 'CRM',
    location: '上海',
    jd: Array.from({ length: 20 }, () => 'CRM').join(' '),
  }
  const balancedDoc = {
    id: 'balanced',
    title: 'CRM 审批流 产品经理',
    location: '上海',
    jd: '岗位职责：负责 CRM、审批流与企业权限架构。',
  }
  const satRes = rankOpportunitiesBm25f([stuffedDoc, balancedDoc, smallPool[1]], profile, { useCache: false })
  assert.equal(satRes.ranked[0].id, 'balanced', 'Single saturation k1=1.2 must prevent single-term stuffing from beating broad relevant match')
})

test('symmetric Stage 0 protects campus organizers, compound modifier titles, and explicit outsource exemptions', () => {
  const hrProfile = buildPatrolSearchProfile({
    goal: '上海 校园招聘负责人，不要外包',
    searchTerms: ['校园招聘', '雇主品牌'],
    resumeText: '6年科技公司校园招聘负责人经验。',
  })
  assert.equal(isActualInternOrCampusOpening('校园招聘负责人'), false)
  assert.equal(isActualInternOrCampusOpening('实习生项目经理'), false)
  assert.equal(isActualInternOrCampusOpening('HR 暑期实习生'), true)

  const campusLead = { id: 'hr-1', title: '校园招聘负责人', company: 'A', jd: '统筹秋招与高校关系。' }
  const campusProgram = { id: 'hr-2', title: '实习生项目经理', company: 'A', jd: '管理暑期实习生项目。' }
  const internAvoidProfile = buildPatrolSearchProfile({
    goal: '上海 产品经理，不要实习',
    searchTerms: ['产品经理'],
    resumeText: '5年产品经理。',
  })
  assert.equal(evaluateStage0HardFilter(campusLead, internAvoidProfile, {}).excluded, false)
  assert.equal(evaluateStage0HardFilter(campusProgram, internAvoidProfile, {}).excluded, false)
  assert.equal(evaluateStage0HardFilter({ id: 'i-1', title: '产品暑期实习生', jd: '协助写文档' }, internAvoidProfile, {}).excluded, true)

  const noSalesProfile = buildPatrolSearchProfile({
    goal: '上海 B2B 产品经理，不要销售、不要外包',
    searchTerms: ['B2B', '产品经理'],
    resumeText: '5年 CRM 产品经理。',
  })
  assert.ok(noSalesProfile.avoidHints.includes('销售'))
  assert.ok(noSalesProfile.avoidHints.includes('外包'))
  // Ambiguous / non-sales support titles (even outside brackets) stay eligible; only unambiguous primary sales roles exclude
  for (const safeTitle of ['销售管理系统产品经理', '销售运营产品经理', '产品经理（销售系统）', '销售团队招聘负责人', 'Sales Operations Analyst']) {
    assert.equal(
      evaluateStage0HardFilter({ id: safeTitle, title: safeTitle, jd: '负责招募优秀人才及内部系统落地，不承担销售指标。' }, noSalesProfile, {}).excluded,
      false,
      `${safeTitle} must NOT be excluded under 不要销售`,
    )
  }
  for (const safeNonIntern of ['用户研究普通应届岗', '正式校区安全岗位', 'Campus Security Specialist']) {
    assert.equal(
      evaluateStage0HardFilter({ id: safeNonIntern, title: safeNonIntern, jd: '全职正式编制岗位。' }, internAvoidProfile, {}).excluded,
      false,
      `${safeNonIntern} must NOT be excluded under 不要实习`,
    )
  }
  // Primary sales opening IS excluded
  assert.equal(
    evaluateStage0HardFilter({ id: 'sales-1', title: 'AI SaaS 大客户销售代表', jd: '背负销售业绩指标。' }, noSalesProfile, {}).excluded,
    true,
  )

  // Batch force:true AND batch recheck:true must NOT pull back Stage 0 excluded jobs; ONLY allowStage0Override:true does
  const planBatchForce = selectTriageCandidates({
    opportunities: [
      { id: 'good', oneOff: true, title: '销售管理系统产品经理', jd: '负责 B2B SaaS 审批流设计。' },
      { id: 'bad', oneOff: true, title: '大客户销售代表', jd: '负责大客户商务签约。' },
    ],
    profile: noSalesProfile,
    force: true,
    recheck: false,
  })
  assert.deepEqual(planBatchForce.candidates.map(c => c.id), ['good'])

  const planBatchRecheck = selectTriageCandidates({
    opportunities: [{ id: 'bad', oneOff: true, title: '大客户销售代表', jd: '负责大客户商务签约。' }],
    profile: noSalesProfile,
    force: true,
    recheck: true,
  })
  assert.deepEqual(planBatchRecheck.candidates.map(c => c.id), [], 'Batch recheck:true must NOT bypass Stage 0')

  const planSingleOverride = selectTriageCandidates({
    opportunities: [{ id: 'bad', oneOff: true, title: '大客户销售代表', jd: '负责大客户商务签约。' }],
    profile: noSalesProfile,
    force: true,
    recheck: true,
    allowStage0Override: true,
  })
  assert.deepEqual(planSingleOverride.candidates.map(c => c.id), ['bad'])
})

test('F02 explicit Chinese search term is never swallowed by longer resume term and dropHighDfBigrams defaults off', () => {
  const profile = buildPatrolSearchProfile({
    goal: '上海 数据出境 合规岗位',
    searchTerms: ['数据出境'],
    resumeText: '主导数据出境合规治理与安全评估体系建设。',
  })
  const ranked = rankOpportunitiesBm25f([
    { id: 'assistant', title: '一般合规助理', location: '上海', jd: '岗位职责：\n协助登记数据出境申报台账并整理归档材料。' },
    { id: 'expert', title: '数据出境合规专家', location: '上海', jd: '岗位职责：\n统筹跨国主体隐私合规审查与标准合同落地。' },
  ], profile, { useCache: false })
  assert.equal(ranked.ranked[0].id, 'expert', 'Explicit searchTerms ["数据出境"] must match "数据出境合规专家" title even when resume has "数据出境合规"')

  // Small/medium pool anonymous CJK bigrams stay preserved by default (`dropHighDfBigrams: false`)
  const pBroad = buildPatrolSearchProfile({
    goal: '上海 商业分析经理',
    searchTerms: ['商业分析经理'],
    resumeText: '负责商业分析决策。',
  })
  const pool = Array.from({ length: 12 }, (_, i) => ({
    id: `doc-${i}`,
    title: i === 0 ? '分析专家' : '行政助理',
    location: '上海',
    jd: `岗位职责：\n负责商业统筹与日常分析第${i}号任务。`,
  }))
  const defaultRes = rankOpportunitiesBm25f(pool, pBroad, { useCache: false })
  const dropRes = rankOpportunitiesBm25f(pool, pBroad, { useCache: false, dropHighDfBigrams: true })
  assert.ok(defaultRes.ranked[0].bm25fRaw > 0, 'Default run must preserve high-DF anonymous bigrams (`dropHighDfBigrams` default false)')
  assert.ok(defaultRes.ranked[0].bm25fRaw >= dropRes.ranked[0].bm25fRaw)
})

test('F03 bounded hydration slice lets high-relevance incomplete preview compete with 30 unrelated complete JDs', () => {
  const profile = buildPatrolSearchProfile({
    goal: '上海 GPU 调度工程师',
    searchTerms: ['GPU', '调度工程师'],
    resumeText: '负责千卡 GPU 算力调度系统开发。',
  })
  const completeNoise = Array.from({ length: 30 }, (_, i) => ({
    id: `noise-${i}`,
    oneOff: true,
    title: `行政文员-${i}`,
    location: '北京',
    jd: `负责日常考勤与办公设备维护第${i}号岗位说明。`,
    verifiedAt: `2026-11-22T09:${String(i).padStart(2, '0')}:00Z`,
  }))
  const gpuPreview = {
    id: 'gpu-prev',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    externalId: '888',
    oneOff: true,
    title: '资深 GPU 调度工程师',
    location: '上海',
    jd: '待补全',
    jdPreview: true,
    verifiedAt: '2026-11-10T09:00:00Z',
  }
  const plan = selectTriageCandidates({
    opportunities: [...completeNoise, gpuPreview],
    profile,
    limit: 30,
    force: false,
  })
  assert.ok(plan.candidates.some(c => c.id === 'gpu-prev'), 'High-relevance hydratable preview must be included in Round 1 within bounded hydration slots')

  // Even when a preview exists, it MUST NOT alter relative BM25F ranking among complete JDs (`GPU Engineer` stays #1 over `Storage Engineer`)
  const parityProfile = buildPatrolSearchProfile({
    goal: 'GPU Storage Engineer',
    searchTerms: ['GPU', 'Storage'],
    resumeText: 'Systems engineer working on GPU and storage.',
  })
  const completeGpu = {
    id: 'gpu-full',
    oneOff: true,
    title: 'GPU Engineer',
    location: 'Shanghai',
    jd: 'Build GPU runtime services.',
    verifiedAt: '2026-11-22T10:00:00Z',
  }
  const completeStorage = {
    id: 'storage-full',
    oneOff: true,
    title: 'Storage Engineer',
    location: 'Shanghai',
    jd: 'Build distributed storage services.',
    verifiedAt: '2026-11-21T10:00:00Z',
  }
  const previewGpu = {
    id: 'gpu-preview',
    provider: 'greenhouse',
    sourceId: 'greenhouse:acme',
    externalId: '889',
    oneOff: true,
    title: 'Senior GPU Scheduler Engineer',
    location: 'Shanghai',
    jd: '待补全',
    jdPreview: true,
    verifiedAt: '2026-11-20T10:00:00Z',
  }
  const withoutPrev = selectTriageCandidates({ opportunities: [completeStorage, completeGpu], profile: parityProfile, limit: 1 })
  const withPrev = selectTriageCandidates({ opportunities: [completeStorage, completeGpu, previewGpu], profile: parityProfile, limit: 1 })
  assert.equal(withoutPrev.candidates[0].id, 'gpu-full')
  assert.equal(withPrev.candidates[0].id, 'gpu-full', 'Preview presence must NEVER flip complete-JD ranking order (`gpu-full` vs `storage-full`)')
})

test('host pending_local display order equals selectTriageCandidates order and post-hydration Stage 0 blocks hidden outsource JDs', async t => {
  const jobs = [
    {
      id: 'oneoff:job-b2b-1',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: '企业甲',
      title: '企业流程平台产品专家',
      location: '上海',
      jd: '岗位职责：\n主导企业 CRM、多级审批流与 SaaS 权限矩阵研发规划，支撑 B2B 客户落地。',
      oneOff: true,
      verifiedAt: '2026-11-20T09:00:00Z',
    },
    {
      id: 'oneoff:job-b2b-2',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: '企业乙',
      title: '行政后勤专员',
      location: '上海',
      jd: '岗位职责：\n负责办公物业对接。\n公司介绍：\n我司拥有领先的 B2B SaaS 与 CRM 平台。',
      oneOff: true,
      verifiedAt: '2026-11-21T09:00:00Z',
    },
    {
      id: 'oneoff:job-b2b-3',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: '企业丙',
      title: 'SaaS 客户成功平台产品经理',
      location: '上海',
      jd: '岗位职责：\n负责 B2B SaaS 客户续约审批流与 CRM 主数据看板设计。',
      oneOff: true,
      verifiedAt: '2026-11-19T09:00:00Z',
    },
  ]
  const hostGoal = '上海 B2B SaaS 产品经理，专注 CRM 与审批流，不要外包'
  const hostTerms = ['B2B', 'SaaS', '产品经理', 'CRM', '审批流']
  const hostResume = '6年 B2B SaaS 产品经理，负责 CRM 与审批流系统。'
  const fx = await makeHostFixture(t, {
    jobs,
    goal: hostGoal,
    searchTerms: hostTerms,
    resumeText: hostResume,
  })
  const state = await fx.getState()
  const pendingOrder = state.opportunities
    .filter(j => (j.match?.zone || 'pending_local') === 'pending_local')
    .map(j => j.id)
  const ctrl = fx.readControl()
  const profile = buildPatrolSearchProfile({
    goal: hostGoal,
    searchTerms: hostTerms,
    resumeText: hostResume,
    feedback: ctrl.jobFeedback,
  })
  const queueOrder = selectTriageCandidates({
    opportunities: ctrl.opportunities,
    activeBoards: new Set(['greenhouse:acme']),
    feedbackMap: ctrl.jobFeedback,
    existingMatches: ctrl.jobMatches,
    profile,
  }).candidates.map(c => c.id)
  assert.deepEqual(pendingOrder, queueOrder, 'Host pending_local order MUST exactly match selectTriageCandidates BM25F queue order')
  assert.notEqual(pendingOrder[0], 'oneoff:job-b2b-2', 'Boilerplate noise job must rank last, behind duty-matched roles')

  // Post-hydration Stage 0 guard: preview & batch run block freshly hydrated outsource JDs before LLM calls
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/901') {
      return new Response(JSON.stringify({
        content: '岗位职责：负责 B2B CRM 需求设计。\n用工性质：外包驻场',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, init)
  }
  t.after(() => { globalThis.fetch = origFetch })

  let llmCallCount = 0
  const hydFx = await makeHostFixture(t, {
    jobs: [{
      id: 'oneoff:hyd-901',
      externalId: '901',
      provider: 'greenhouse',
      sourceId: 'greenhouse:acme',
      company: '示例公司',
      title: '高级产品经理',
      location: '上海',
      jd: '待补全',
      jdPreview: true,
      oneOff: true,
      verifiedAt: '2026-11-22T09:00:00Z',
    }],
    goal: '上海 B2B 产品经理，不要外包',
    searchTerms: ['产品经理'],
    resumeText: '5年 B2B 产品经理经验。',
    llmHandler: async function *() {
      llmCallCount += 1
      yield { type: 'text-delta', text: '{"items":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const preview = await hydFx.action({ action: 'triage-preview' })
  assert.equal(preview.count, 0, 'Post-hydration Stage 0 guard must exclude newly revealed outsource job from preview')
  assert.equal(preview.hydratedJdCount, 1)
  assert.equal(preview.confirmToken, '')

  // Batch triage-preview with recheck:true MUST NOT bypass Stage 0 explicit outsource; only single id override can.
  hydFx.mutateControl(next => {
    next.opportunities[0].jd = '待补全'
    next.opportunities[0].jdPreview = true
  })
  await hydFx.reapply()
  const batchRecheckPreview = await hydFx.action({ action: 'triage-preview', recheck: true })
  assert.equal(batchRecheckPreview.count, 0, 'Batch triage-preview recheck:true must NOT disclose Stage 0 excluded outsource job')
  assert.equal(batchRecheckPreview.confirmToken, '')

  // Reset job back to preview state and test batch runJobTriage direct invocation (`sendToModel: true`, no `confirmed`, even recheck:true)
  hydFx.mutateControl(next => {
    next.opportunities[0].jd = '待补全'
    next.opportunities[0].jdPreview = true
  })
  await hydFx.reapply()
  const runRes = await hydFx.action({ action: 'triage-jobs', force: true, recheck: true })
  assert.notEqual(runRes.skipped, true)
  assert.equal(llmCallCount, 0, 'Post-hydration Stage 0 guard + batch recheck:true must send 0 LLM calls for revealed outsource job')
  const hydState = await hydFx.getState()
  const afterHyd = hydState.opportunities.find(o => o.id === 'oneoff:hyd-901')?.match
  assert.equal(afterHyd?.tier, 'skip')
  assert.ok((afterHyd?.score ?? 100) <= 39)

  // triageSummary unreviewedCount / eligibleCount must exclude Stage 0 hard-excluded items matching batch preview
  const summaryFx = await makeHostFixture(t, {
    jobs: [
      { id: 'oneoff:s-ready', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: '甲', title: 'B2B 产品经理', location: '上海', jd: '负责企业 CRM 权限系统建设。', oneOff: true },
      { id: 'oneoff:s-miss', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: '乙', title: 'SaaS 产品经理', location: '上海', jd: '', jdPreview: true, oneOff: true },
      { id: 'oneoff:s-sales', provider: 'greenhouse', sourceId: 'greenhouse:acme', company: '丙', title: 'AI 大客户销售代表', location: '上海', jd: '负责大客户签约回款。', oneOff: true },
    ],
    goal: '上海 B2B 产品经理，不要销售',
    searchTerms: ['B2B', '产品经理'],
    resumeText: '5年 B2B 产品经理经验。',
  })
  const sumState = await summaryFx.getState()
  assert.equal(sumState.triageSummary.unreviewedCount, 1)
  assert.equal(sumState.triageSummary.missingJdCount, 1)
  assert.equal(sumState.triageSummary.eligibleCount, 2, 'triageSummary.eligibleCount must exclude Stage 0 blocked sales job')
})

test('F04 eval harness preserves fixed denominator, blocks post-hydration Stage 0 before mock LLM, and meets benchmark gate', async () => {
  // 1. Fixed denominator test: falsely excluding 1 of 2 labeled positives must drop recall to 0.5, NOT 1.0
  const fixedDenomDataset = {
    personas: [{
      id: 'denom_check',
      goal: '上海 产品经理，不要测试和外包',
      searchTerms: ['产品经理'],
      resumeText: '5年产品经理。',
      boards: ['b1', 'greenhouse:acme'],
      opportunities: [
        { id: 'pos-1', sourceId: 'b1', title: '核心产品经理', location: '上海', jd: '负责核心产品设计。' },
        { id: 'pos-2', sourceId: 'b1', title: '测试经理', location: '上海', jd: '负责核心产品设计与交付。' },
        { id: 'hyd-ex', provider: 'greenhouse', externalId: '777', sourceId: 'greenhouse:acme', title: '资深产品总监', location: '上海', jd: '待补全', jdPreview: true, expectedPostHydrationExclude: true },
      ],
      labels: { 'pos-1': 3, 'pos-2': 3 },
      hydrationFixtures: { 'hyd-ex': { jd: '用工性质：外包驻场\n负责产品规划。' } },
      mockLlmResponses: {
        'pos-1': { score: 90, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责核心产品设计', reason: 'match' },
        'hyd-ex': { score: 85, tier: 'top', primaryRoleFit: 'match', roleQuote: '负责产品规划', reason: 'should never be called' },
      },
    }],
  }
  const denomRep = await evaluateDataset(fixedDenomDataset, { limit: 30, rounds: 2 })
  assert.equal(denomRep.personas[0].stage1.judgedRelevantTotal, 2, 'Denominator must include BOTH labeled positives despite Stage 0 exclusion of pos-2')
  assert.equal(denomRep.personas[0].stage1.selectionRecallAt60, 0.5, 'False exclusion of pos-2 must drop recall to 50%, not stay 100%')
  assert.equal(denomRep.personas[0].stage1.postHydrationBlockedCount, 1)
  assert.equal(denomRep.personas[0].stage1.postHydrationMockCallCount, 0, 'Offline eval replay must block post-hydration Stage 0 excludes BEFORE mock LLM')
  assert.equal(denomRep.stage1Summary.totalHardLeaks, 0)

  // 2. Full >60 unique deduplicated postings benchmark across 6 professions (dev + holdout)
  const raw = JSON.parse(readFileSync(new URL('./fixtures/triage-benchmark/multi-profession-benchmark.json', import.meta.url), 'utf8'))
  const ablation = await evaluateDataset(raw, { selector: 'legacy_stage0_ablation', limit: 30, rounds: 2 })
  const bm25f = await evaluateDataset(raw, { selector: 'bm25f', limit: 30, rounds: 2 })
  const cmp = compareReports(ablation, bm25f)

  assert.equal(cmp.comparable, true, `Reports must be comparable: ${(cmp.reasons || []).join('; ')}`)
  assert.equal(bm25f.stage1Summary.totalHardLeaks, 0)
  assert.equal(bm25f.stage1Summary.sendToModelFalseCalls, 0)
  assert.equal(bm25f.stage1Summary.avgScarceRecall, 1, 'Zero scarce-term losses permitted')

  for (let i = 0; i < raw.personas.length; i += 1) {
    const rawPersona = raw.personas[i]
    const evalPersona = bm25f.personas[i]
    const profile = buildPatrolSearchProfile({
      goal: rawPersona.goal,
      searchTerms: rawPersona.searchTerms,
      resumeText: rawPersona.resumeText,
      feedback: rawPersona.feedback || {},
    })
    const survivingUniqueTexts = new Set(
      rawPersona.opportunities
        .filter(o => !o.closedAt && o.sourceId === 'board-main' && rawPersona.feedback?.[o.id]?.status !== 'dismissed'
          && !rawPersona.expectedExplicitExcludeIds?.includes(o.id)
          && !o.expectedPostHydrationExclude
          && !evaluateStage0HardFilter(o, profile, rawPersona.feedback || {}).excluded)
        .map(o => `${String(o.title || '').trim()}\n${String(o.jd || '').trim()}`),
    )
    assert.ok(evalPersona.stage1.openPoolCount > 60, `Persona ${evalPersona.personaId} openPoolCount must be >60, got ${evalPersona.stage1.openPoolCount}`)
    assert.ok(survivingUniqueTexts.size > 60, `Persona ${evalPersona.personaId} must have >60 unique (title+jd) after Stage 0, got ${survivingUniqueTexts.size}`)
  }

  // Assert zero duty/requirement template overlap between dev and holdout distractors
  const extractDutyReqCore = jd => String(jd || '')
    .replace(/^(?:公司介绍|团队概况)：[\s\S]*$/mu, '')
    .replace(/\d+/gu, '#')
    .trim()
  const devCoreSet = new Set(
    raw.personas.filter(p => p.split === 'dev').flatMap(p =>
      p.opportunities.filter(o => o.id.includes('-noise-')).map(o => extractDutyReqCore(o.jd)),
    ),
  )
  for (const hp of raw.personas.filter(p => p.split === 'holdout')) {
    const holdoutCores = hp.opportunities.filter(o => o.id.includes('-hnoise-')).map(o => extractDutyReqCore(o.jd))
    const uniqueHoldoutCores = new Set(holdoutCores)
    assert.equal(uniqueHoldoutCores.size, holdoutCores.length, `Holdout ${hp.id} distractors must each have unique duty/requirement prose`)
    assert.equal(holdoutCores.filter(c => devCoreSet.has(c)).length, 0, `Holdout ${hp.id} must have 0 duty/requirement template overlap with dev`)
  }

  // Verify compareReports omits head metrics when headMetricScope differs (e.g. legacy pool vs queue head)
  const poolScopeSim = structuredClone(ablation)
  delete poolScopeSim.snapshot.headMetricScope
  const scopeCmp = compareReports(poolScopeSim, bm25f)
  assert.equal(scopeCmp.comparable, true)
  assert.equal(scopeCmp.stage1Delta.sameHeadScope, false)
  assert.equal(scopeCmp.stage1Delta.deltaNdcgAt10.delta, null)

  const deltaOverall = cmp.stage1Delta.deltaRecallAt60.delta
  const deltaDev = bm25f.splitSummaries.dev.avgSelectionRecallAt60 - ablation.splitSummaries.dev.avgSelectionRecallAt60
  const deltaHoldout = bm25f.splitSummaries.holdout.avgSelectionRecallAt60 - ablation.splitSummaries.holdout.avgSelectionRecallAt60
  assert.ok(deltaOverall >= 0.05, `Expected paired deltaSelR@60 >= +5pp overall, got ${(deltaOverall * 100).toFixed(2)}pp`)
  assert.ok(deltaDev >= 0.05, `Expected dev split deltaSelR@60 >= +5pp, got ${(deltaDev * 100).toFixed(2)}pp`)
  assert.ok(deltaHoldout >= 0.05, `Expected holdout split deltaSelR@60 >= +5pp, got ${(deltaHoldout * 100).toFixed(2)}pp`)
})


test('BM25F prevents city softBonus leak at zero text overlap and attenuates mixed compound CJK fragments', () => {
  clearBm25fCache()
  const profile = buildPatrolSearchProfile({
    goal: '上海 / 北京 AI 基础设施资深工程师',
    searchTerms: ['GPU调度', 'Kubernetes'],
    resumeText: '负责 GPU 调度与 Kubernetes 基础设施建设。',
  })

  const unrelatedInTargetCity = { id: 'noise-city', title: '买手', location: '北京', jd: '负责服饰品类选品与供应链管理。' }
  const fragmentOnly = { id: 'frag-only', title: '调度主管', location: '上海', jd: '负责站点骑手排班调度与运力管理。' }
  const compoundMatch = { id: 'compound-hit', title: 'GPU调度系统研发工程师', location: '北京', jd: '负责大规模 GPU 集群调度与 Kubernetes 资源编排。' }

  const res = rankOpportunitiesBm25f([unrelatedInTargetCity, fragmentOnly, compoundMatch], profile, { useCache: false })
  const noiseRow = res.byId.get('noise-city')
  const fragRow = res.byId.get('frag-only')
  const hitRow = res.byId.get('compound-hit')

  assert.equal(noiseRow.bm25fRaw, 0)
  assert.equal(noiseRow.recallScore, 0, 'Target-city softBonus must NOT leak non-zero recallScore when bm25fRaw is 0')
  assert.ok(hitRow.recallScore > fragRow.recallScore * 2, 'Full compound match must strongly outscore trailing CJK fragment match')
})

test('BM25F retains 7-8 char Chinese resume phrases and resolves symmetric bilingual role aliases without noise pollution', () => {
  clearBm25fCache()

  // 1. 7-8 char Chinese resume phrase regression (e.g. "现金流预测模型" in FP&A resume)
  const finProfile = buildPatrolSearchProfile({
    goal: '上海或深圳 资深 FP&A 财务分析与业财融合经理',
    searchTerms: ['财务分析', 'FP&A', '业财融合', '预算管理', '经营分析'],
    resumeText: '主导集团滚动预算编制、管理会计损益表拆解、毛利率波动归因、现金流预测模型搭建。',
  })
  assert.ok(finProfile.resumeKeywords.includes('现金流预测模型'), 'Must retain 7-char domain anchor from resume')
  assert.ok(finProfile.resumeKeywords.includes('集团滚动预算编制'), 'Must retain 8-char domain anchor from resume')

  const backgroundNoise = Array.from({ length: 8 }, (_, i) => ({
    id: `noise-ops-${i}`,
    title: `行政与后勤专员-${i}`,
    location: '北京',
    jd: `负责日常办公用品采购与行政接待协调第${i}号任务。`,
  }))
  const finRes = rankOpportunitiesBm25f([
    ...backgroundNoise,
    { id: 'noise-sales', title: '企业级大客户销售代表', location: '深圳', jd: '负责企业客户商业化拓展与回款签约。' },
    { id: 'fin-model', title: '商业决策财务建模专家', location: '深圳', jd: '岗位职责：\n搭建多维 现金流预测模型 与敏感性情景模拟工具。' },
  ], finProfile, { useCache: false })
  assert.equal(finRes.ranked[0].id, 'fin-model')
  assert.equal(finRes.byId.get('noise-sales').bm25fRaw, 0)
  assert.ok(finRes.byId.get('fin-model').bm25fRaw > 1.5, '7-char resume anchor match must lift bm25fRaw strongly in realistic pool')

  // 2. Bilingual role alias + negative guard (HR Chinese terms -> English University Relations / Campus Recruiting role)
  const hrProfile = buildPatrolSearchProfile({
    goal: '负责校园招聘与雇主品牌建设',
    searchTerms: ['校招运营', '雇主品牌', '高校关系', 'constructor', 'toString'],
    resumeText: '主导校招运营与高校雇主品牌活动策划。',
  })
  assert.ok(hrProfile.targetGroups.some(g => g.aliases.includes('campus recruiting') || g.aliases.includes('university relations')))
  const hrRes = rankOpportunitiesBm25f([
    { id: 'reception', title: 'Corporate Receptionist', location: 'Shanghai', jd: 'Front desk greeting and visitor badge management.' },
    { id: 'campus-sec', title: 'Campus Security Specialist', location: 'Shanghai', jd: 'Manage campus physical access control and patrol shifts.' },
    { id: 'uni-rec', title: 'University Recruiting Program Lead', location: 'Shanghai', jd: 'Lead annual campus recruiting strategy, university relations, and internship conversion.' },
  ], hrProfile, { useCache: false })
  assert.equal(hrRes.ranked[0].id, 'uni-rec')
  assert.ok(hrRes.byId.get('uni-rec').bm25fRaw > hrRes.byId.get('campus-sec').bm25fRaw * 2)
  assert.equal(hrRes.byId.get('reception').bm25fRaw, 0)

  // 3. Blind fresh cases (Procurement / Supply Chain + Privacy Legal Compliance)
  const procProfile = buildPatrolSearchProfile({
    goal: '战略寻源与采购成本优化',
    searchTerms: ['战略寻源', '供应链管理'],
    resumeText: '主导电子元器件战略寻源，搭建采购成本核算矩阵与供应链降本模型。',
  })
  assert.ok(procProfile.resumeKeywords.includes('采购成本核算矩阵'))
  assert.ok(procProfile.resumeKeywords.includes('供应链降本模型'))
  const procRes = rankOpportunitiesBm25f([
    { id: 'wh-guard', title: 'Warehouse Guard', location: 'Suzhou', jd: 'Night shift gate check.' },
    { id: 'sourcing-mgr', title: 'Strategic Sourcing Manager', location: 'Suzhou', jd: 'Own strategic sourcing and global supply chain management.' },
  ], procProfile, { useCache: false })
  assert.equal(procRes.ranked[0].id, 'sourcing-mgr')
  assert.equal(procRes.byId.get('wh-guard').bm25fRaw, 0)

  const legalProfile = buildPatrolSearchProfile({
    goal: '隐私合规与法务合规专家',
    searchTerms: ['法务合规', '隐私合规'],
    resumeText: '主导跨境业务，完成数据隐私保护评估与隐私合规审计。',
  })
  assert.ok(legalProfile.resumeKeywords.includes('数据隐私保护评估'))
  const legalRes = rankOpportunitiesBm25f([
    { id: 'admin-rec', title: 'Office Front Desk Reception', location: 'Beijing', jd: 'Receive guests and order office supplies.' },
    { id: 'privacy-counsel', title: 'Privacy Compliance Counsel', location: 'Beijing', jd: 'Advise product teams on global privacy compliance and regulatory filings.' },
  ], legalProfile, { useCache: false })
  assert.equal(legalRes.ranked[0].id, 'privacy-counsel')
  assert.equal(legalRes.byId.get('admin-rec').bm25fRaw, 0)
})
