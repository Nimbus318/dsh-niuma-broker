import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  buildCuaCollectPrompt,
  compareSemver,
  CUA_PLATFORMS,
  CUA_SUPPORTED_PLATFORMS,
  detectCuaCapability,
  MIN_CUA_DSH_VERSION,
} from '../src/dsh-tools.mjs'
import { apply } from '../src/host.mjs'

test('compareSemver orders stable and prerelease DSH versions accurately', () => {
  assert.equal(compareSemver('0.2.2-rc.5', MIN_CUA_DSH_VERSION) < 0, true)
  assert.equal(compareSemver('0.2.2', MIN_CUA_DSH_VERSION) < 0, true)
  assert.equal(compareSemver('0.2.3-alpha.1', MIN_CUA_DSH_VERSION) < 0, true)
  assert.equal(compareSemver('0.2.3-alpha.2', MIN_CUA_DSH_VERSION), 0)
  assert.equal(compareSemver('0.2.3', MIN_CUA_DSH_VERSION) > 0, true)
  assert.equal(compareSemver('0.2.4', MIN_CUA_DSH_VERSION) > 0, true)
})

test('detectCuaCapability distinguishes ready, disabled, upgrade_required, unsupported_platform, and unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-cua-cap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const unsupported = await detectCuaCapability({ platform: 'linux', ctx: { get: () => null } })
  assert.equal(unsupported.status, 'unsupported_platform')

  const ready = await detectCuaCapability({
    platform: 'darwin',
    optionalService: key => key === 'computerUse'
      ? { providerName: 'macos-cua' }
      : (key === 'pluginInventory'
        ? { list: async () => ({ entries: [{ moduleName: '@deepseek-ai/dsh-base', meta: { version: '0.2.3-alpha.2' } }] }) }
        : null),
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.providerName, 'macos-cua')
  assert.equal(ready.dshVersion, '0.2.3-alpha.2')

  const upgrade = await detectCuaCapability({
    platform: 'darwin',
    optionalService: key => key === 'pluginInventory'
      ? { list: async () => ({ entries: [{ moduleName: '@deepseek-ai/dsh-base', meta: { version: '0.2.2-rc.5' } }] }) }
      : null,
  })
  assert.equal(upgrade.status, 'upgrade_required')
  assert.equal(upgrade.dshVersion, '0.2.2-rc.5')

  const disabled = await detectCuaCapability({
    platform: 'win32',
    optionalService: key => key === 'pluginInventory'
      ? {
        list: async () => ({
          entries: [
            { moduleName: '@deepseek-ai/dsh-base', meta: { version: '0.2.3-alpha.2' } },
            { moduleName: '@deepseek-ai/dsh-cua-bundle', meta: { version: '0.2.3-alpha.2' }, diagnostic: 'disabled in profile' },
          ],
        }),
      }
      : null,
  })
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.cuaBundlePresent, true)
  assert.equal(disabled.diagnostic, 'disabled in profile')

  // Fallback to profileContext/dir package.json when pluginInventory is absent
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@deepseek-ai/dsh-subagent-codex': '0.2.2' },
  }))
  const pkgUpgrade = await detectCuaCapability({ platform: 'darwin', ctx: { profileContext: { dir } } })
  assert.equal(pkgUpgrade.status, 'upgrade_required')

  const unknown = await detectCuaCapability({ platform: 'darwin', ctx: {} })
  assert.equal(unknown.status, 'unknown')
})

test('Scheme B staging drawer, duplicate in-place updates, DSH native tools, and skill registration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-cua-tools-'))
  const harness = createFetchHarness()
  const registeredTools = new Map()
  const toolDisposed = []
  let registeredSkillProvider = null
  let dispose
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ session: { id: 'x' }, events: [] }) },
    llm: { listProviders: () => [] },
    get(key) {
      if (key === 'tools') {
        return {
          register(def) {
            registeredTools.set(def.name, def)
            return () => { toolDisposed.push(def.name) }
          },
        }
      }
      if (key === 'skills') {
        return {
          registerProvider(factory) {
            registeredSkillProvider = factory({ signal: new AbortController().signal, invalidate() {} })
            return () => { registeredSkillProvider = null }
          },
        }
      }
      if (key === 'computerUse') return { providerName: 'macos-cua' }
      return undefined
    },
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
  const action = body => call('/api/career-agent/action', body)
  const state = async () => (await call('/api/career-agent/state')).data

  // Verify CUA capability & tools/skills wiring
  const initState = await state()
  assert.equal(initState.capabilities.cua.status, CUA_SUPPORTED_PLATFORMS.has(process.platform) ? 'ready' : 'unsupported_platform')
  assert.equal(registeredTools.has('career_broker_import_opportunity'), true)
  assert.equal(registeredTools.has('career_broker_record_work_win'), true)
  assert.ok(registeredSkillProvider)
  const listedSkills = await registeredSkillProvider.list({})
  assert.equal(listedSkills[0].name, 'niuma-collect-jobs')
  const loadedSkill = await registeredSkillProvider.get(listedSkills[0], {})
  assert.equal(typeof loadedSkill.content, 'string')
  assert.match(loadedSkill.content, /career_broker_import_opportunity/)
  assert.match(buildCuaCollectPrompt({ locale: 'zh', company: '字节跳动', careersUrl: 'https://jobs.bytedance.com' }), /最多 8 个/)
  assert.match(buildCuaCollectPrompt({ locale: 'zh', mode: 'hunt', platform: 'zhipin', searchTerms: ['AI Infra', 'vLLM'], hiringScope: 'experienced', targetCount: 8, extraNotes: '上海' }), /zhipin\.com[\s\S]*AI Infra[\s\S]*最多 8 个/)
  assert.match(buildCuaCollectPrompt({ locale: 'zh', mode: 'current-page', targetCount: 6 }), /当前屏幕上已打开的招聘页面[\s\S]*最多挑选 6 个[\s\S]*不要只抓 1 个/)
  assert.equal(CUA_PLATFORMS.some(p => p.id === 'zhipin' && p.url.includes('zhipin.com')), true)

  // Add 1 existing role directly to test duplicate detection + in-place update on commit
  const existing = (await action({
    action: 'job-add',
    job: {
      company: 'MiniMax',
      title: 'Agent 平台工程师',
      location: '上海',
      url: 'https://www.zhipin.com/job_detail/abc123.html',
      jd: '旧版 JD 描述',
    },
  })).data.result

  // Invoke native DSH tool career_broker_import_opportunity with 2 roles (1 duplicate URL, 1 new)
  const importTool = registeredTools.get('career_broker_import_opportunity')
  const toolMsg = await importTool.execute({
    jobs: [
      {
        company: 'MiniMax',
        title: 'Agent 平台架构师',
        location: '上海',
        url: 'https://www.zhipin.com/job_detail/abc123.html#from=list',
        jd: '新版完整 JD：负责大模型 Agent 沙盒与分布式调度。',
      },
      {
        company: '月之暗面',
        title: '推理引擎工程师',
        location: '北京',
        url: 'https://www.nowcoder.com/jobs/detail/9988',
        jd: '负责 KV Cache 优化与推理引擎建设。',
      },
    ],
  })
  assert.match(toolMsg, /已暂存 2 个岗位/)

  // Scheme B guarantee: roles MUST land in pendingOpportunities first, NOT opportunities
  const midState = await state()
  assert.equal(midState.pendingOpportunities.length, 2)
  assert.equal(midState.opportunities.length, 1)
  const dupItem = midState.pendingOpportunities.find(i => i.company === 'MiniMax')
  const freshItem = midState.pendingOpportunities.find(i => i.company === '月之暗面')
  assert.equal(dupItem.sourceSite, 'BOSS直聘')
  assert.equal(dupItem.duplicateOpportunityId, existing.id)
  assert.equal(freshItem.sourceSite, '牛客')
  assert.equal(Boolean(freshItem.duplicateOpportunityId), false)

  // Accepts up to 10 roles per call, rejects > 10 items, and rejects non-HTTPS URLs
  const batch8 = Array.from({ length: 8 }, (_, i) => ({
    company: `BatchCo${i}`,
    title: `Infra Engineer ${i}`,
    url: `https://www.zhipin.com/job_detail/batch-${i}.html`,
  }))
  const batchRes = await importTool.execute({ jobs: batch8 })
  assert.match(batchRes, /已暂存 8 个岗位/)
  await action({ action: 'staged-jobs-dismiss', ids: (await state()).pendingOpportunities.filter(i => i.company.startsWith('BatchCo')).map(i => i.id) })

  await assert.rejects(() => importTool.execute({
    jobs: Array.from({ length: 11 }, (_, i) => ({ company: `Co${i}`, title: `Role${i}` })),
  }), /1 至 10/)
  await assert.rejects(() => importTool.execute({
    jobs: [{ company: 'Bad', title: 'Role', url: 'http://insecure.example.com/job' }],
  }), /HTTPS/)

  // Edit staged item before commit
  const updRes = await action({
    action: 'staged-job-update',
    id: freshItem.id,
    changes: { location: '上海 · 徐汇' },
  })
  assert.equal(updRes.status, 200)
  assert.equal(updRes.data.result.location, '上海 · 徐汇')
  const updatedFreshId = updRes.data.result.id

  // Commit both staged items: 1 added, 1 updated in place (keeping total opportunities = 2)
  const commitRes = await action({
    action: 'staged-jobs-commit',
    ids: [dupItem.id, updatedFreshId],
  })
  assert.equal(commitRes.status, 200)
  assert.equal(commitRes.data.result.addedCount, 1)
  assert.equal(commitRes.data.result.updatedCount, 1)

  const afterCommit = await state()
  assert.equal(afterCommit.pendingOpportunities.length, 0)
  assert.equal(afterCommit.opportunities.length, 2)
  const updatedMiniMax = afterCommit.opportunities.find(o => o.id === existing.id)
  assert.equal(updatedMiniMax.title, 'Agent 平台架构师')
  assert.match(updatedMiniMax.jd, /新版完整 JD/)
  assert.equal(updatedMiniMax.sourceSite, 'BOSS直聘')
  assert.equal(updatedMiniMax.captureMode, 'dsh-agent')
  const committedMoonshot = afterCommit.opportunities.find(o => o.company === '月之暗面')
  assert.equal(committedMoonshot.sourceSite, '牛客')
  assert.equal(committedMoonshot.captureMode, 'dsh-agent')

  // Dismiss staged items
  await action({
    action: 'staged-jobs-add',
    job: { company: 'Acme', title: 'Temp Role', url: 'https://maimai.cn/job/1' },
  })
  assert.equal((await state()).pendingOpportunities.length, 1)
  await action({ action: 'staged-jobs-dismiss', all: true })
  assert.equal((await state()).pendingOpportunities.length, 0)

  // P1 regressions:
  // 1) Stale recapture mismatch: recapture replaces row with new content-addressed ID, rejecting old ID commit
  await importTool.execute({
    jobs: [{ company: 'ByteDance', title: 'Old Role V1', url: 'https://jobs.bytedance.com/1' }],
  })
  const firstStagedId = (await state()).pendingOpportunities.find(i => i.company === 'ByteDance').id
  await importTool.execute({
    jobs: [{ company: 'ByteDance', title: 'New Role V2', url: 'https://jobs.bytedance.com/1', jd: 'Changed JD' }],
  })
  const staleCommit = await action({ action: 'staged-jobs-commit', ids: [firstStagedId] })
  assert.equal(staleCommit.status, 400)
  // Stale ID combined with a valid ID must reject atomically with 0 partial commits
  await importTool.execute({
    jobs: [{ company: 'Alibaba', title: 'Valid Co-Item', url: 'https://talent.alibaba.com/1' }],
  })
  const validAlibabaId = (await state()).pendingOpportunities.find(i => i.company === 'Alibaba').id
  const countBeforeAtomicFail = (await state()).opportunities.length
  const atomicFail = await action({ action: 'staged-jobs-commit', ids: [validAlibabaId, firstStagedId] })
  assert.equal(atomicFail.status, 400)
  assert.equal((await state()).opportunities.length, countBeforeAtomicFail)
  assert.ok((await state()).pendingOpportunities.some(i => i.id === validAlibabaId))
  await action({ action: 'staged-jobs-dismiss', all: true })

  // 2) SPA hash-route URLs (#/position/42 vs #/position/43) remain distinct
  await importTool.execute({
    jobs: [
      { company: 'miHoYo', title: 'Engine 42', url: 'https://jobs.mihoyo.com/#/position/42' },
      { company: 'miHoYo', title: 'Engine 43', url: 'https://jobs.mihoyo.com/#/position/43' },
    ],
  })
  const mihoyoStaged = (await state()).pendingOpportunities.filter(i => i.company === 'miHoYo')
  assert.equal(mihoyoStaged.length, 2)
  await action({ action: 'staged-jobs-commit', ids: mihoyoStaged.map(i => i.id) })
  assert.equal((await state()).opportunities.filter(o => o.company === 'miHoYo').length, 2)

  // 3) In-place update preserves oneOff / externalId metadata on untracked board roles
  await writeFile(join(dir, 'career-broker', 'watchdog.json'), JSON.stringify({
    ...JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8')),
    drafts: [{ opportunityId: existing.id, message: 'Keep this outreach draft intact' }],
    opportunities: [
      ...JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8')).opportunities,
      {
        id: 'greenhouse:acme:42',
        provider: 'greenhouse',
        sourceId: 'greenhouse:acme',
        externalId: '42',
        oneOff: true,
        jdPreview: true,
        jdPreviewHash: 'deadbeef',
        closedAt: '2026-11-25T00:00:00.000Z',
        company: 'AcmeOneOff',
        title: 'Staff Systems',
        url: 'https://job-boards.greenhouse.io/acme/jobs/42',
        jd: 'Initial JD',
        firstSeenAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  }))
  // Restart host to load persisted oneOff job & outreach draft
  await dispose()
  toolDisposed.length = 0
  await apply(ctx)
  await registeredTools.get('career_broker_import_opportunity').execute({
    jobs: [{ company: 'AcmeOneOff', title: 'Staff Systems', url: 'https://job-boards.greenhouse.io/acme/jobs/42', jd: 'Updated JD via CUA' }],
  })
  const acmeStaged = (await state()).pendingOpportunities.find(i => i.company === 'AcmeOneOff')
  assert.equal(acmeStaged.duplicateOpportunityId, 'greenhouse:acme:42')
  await action({ action: 'staged-jobs-commit', ids: [acmeStaged.id] })
  const committedAcme = (await state()).opportunities.find(o => o.id === 'greenhouse:acme:42')
  assert.equal(committedAcme.oneOff, true)
  assert.equal(committedAcme.externalId, '42')
  assert.equal(committedAcme.jd, 'Updated JD via CUA')
  assert.equal(committedAcme.jdPreview, undefined)
  assert.equal(committedAcme.jdPreviewHash, undefined)
  assert.equal(committedAcme.closedAt, undefined)

  // Re-capturing identical preview text keeps jdPreview=true intact
  await registeredTools.get('career_broker_import_opportunity').execute({
    jobs: [{ company: 'AcmeOneOff', title: 'Staff Systems', url: 'https://job-boards.greenhouse.io/acme/jobs/42', jd: 'Summary only' }],
  })
  const acmePreviewRow = (await state()).pendingOpportunities.find(i => i.company === 'AcmeOneOff')
  // Prepare a preview row on disk first
  await action({ action: 'staged-jobs-dismiss', ids: [acmePreviewRow.id] })
  await writeFile(join(dir, 'career-broker', 'watchdog.json'), JSON.stringify({
    ...JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8')),
    opportunities: [
      ...JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8')).opportunities,
      {
        id: 'greenhouse:acme:43',
        provider: 'greenhouse',
        sourceId: 'greenhouse:acme',
        externalId: '43',
        oneOff: true,
        jdPreview: true,
        jdPreviewHash: 'beefdead',
        company: 'AcmePreview',
        title: 'Preview Role',
        url: 'https://job-boards.greenhouse.io/acme/jobs/43',
        jd: 'Summary only',
        firstSeenAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  }))
  await dispose()
  toolDisposed.length = 0
  await apply(ctx)
  await registeredTools.get('career_broker_import_opportunity').execute({
    jobs: [{ company: 'AcmePreview', title: 'Preview Role', url: 'https://job-boards.greenhouse.io/acme/jobs/43', jd: 'Summary only' }],
  })
  const samePreviewStaged = (await state()).pendingOpportunities.find(i => i.company === 'AcmePreview')
  await action({ action: 'staged-jobs-commit', ids: [samePreviewStaged.id] })
  assert.equal((await state()).opportunities.find(o => o.id === 'greenhouse:acme:43').jdPreview, true)

  // Editing staged row B to match row A still keeps unique IDs so stale ID C cannot bypass commit check
  await action({ action: 'staged-jobs-add', jobs: [
    { company: 'CoA', title: 'RoleA' },
    { company: 'CoB', title: 'RoleB' },
    { company: 'CoC', title: 'RoleC', url: 'https://jobs.example.com/c' },
  ] })
  const triple = (await state()).pendingOpportunities
  const rowA = triple.find(r => r.company === 'CoA')
  const rowB = triple.find(r => r.company === 'CoB')
  const rowC = triple.find(r => r.company === 'CoC')
  await action({ action: 'staged-job-update', id: rowB.id, changes: { company: 'CoA', title: 'RoleA' } })
  await action({ action: 'staged-jobs-add', job: { company: 'CoC', title: 'RoleC Updated', url: 'https://jobs.example.com/c' } })
  const mixCommit = await action({ action: 'staged-jobs-commit', ids: [rowA.id, rowC.id] })
  assert.equal(mixCommit.status, 400)
  await action({ action: 'staged-jobs-dismiss', all: true })

  // 4) Explicit work-win tool lands in Pending with shareable: false AND preserves existing outreach drafts
  const winTool = registeredTools.get('career_broker_record_work_win')
  const winReply = await winTool.execute({
    title: '重构任务队列将 P99 降至 80ms',
    text: '排查并重写异步重试与限流调度器，上线后任务堆积下降 75%。',
    impact: '堆积下降 75%',
  })
  assert.match(winReply, /待审区/)
  const afterWin = await state()
  assert.equal(afterWin.evidence.length, 1)
  assert.equal(afterWin.evidence[0].status, 'pending')
  assert.equal(afterWin.evidence[0].shareable, false)
  const persistedWatchdog = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'career-broker', 'watchdog.json'), 'utf8'))
  assert.equal(persistedWatchdog.drafts.length, 1)

  // Verify clean teardown disposes registered tools & skills
  await dispose()
  assert.deepEqual(toolDisposed.sort(), [
    'career_broker_import_opportunity',
    'career_broker_record_work_win',
    'career_broker_register_ats_board',
  ])
  assert.equal(registeredSkillProvider, null)
})

test('company-search-jobs previewOnly filters off-target roles, hydrates rich JDs, and never mutates opportunities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-company-preview-'))
  const harness = createFetchHarness()
  let dispose
  const searchResults = [
    {
      title: '智算后端研发工程师 - 青云科技招聘',
      url: 'https://careers.qingcloud.com/jobs/k8s-backend',
      snippet: '负责 Kubernetes 与 GPU 调度后端。',
    },
    {
      title: '渠道经理 - 青云科技招聘',
      url: 'https://careers.qingcloud.com/jobs/channel-mgr',
      snippet: '负责区域渠道代理商拓展与销售回款指标。',
    },
    {
      title: '智算售前技术顾问 - 青云科技招聘',
      url: 'https://careers.qingcloud.com/jobs/presales',
      snippet: '负责政企客户售前宣讲与招投标支持。',
    },
    {
      title: 'AI智算产品经理 - 青云科技招聘',
      url: 'https://careers.qingcloud.com/jobs/ai-pm',
      snippet: '负责智算平台产品规划与商业化运营。',
    },
  ]

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'fixture', models: [{ id: 'm1', name: 'm1' }] }],
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            jobs: [
              { title: '智算后端研发工程师', location: '北京', url: 'https://careers.qingcloud.com/jobs/k8s-backend', jd: '负责 Kubernetes 后端。' },
              { title: '渠道经理', location: '北京', url: 'https://careers.qingcloud.com/jobs/channel-mgr', jd: '负责渠道销售拓展与代理管理。' },
              { title: '智算售前技术顾问', location: '北京', url: 'https://careers.qingcloud.com/jobs/presales', jd: '负责客户售前宣讲与招投标方案。' },
              { title: 'AI智算产品经理', location: '北京', url: 'https://careers.qingcloud.com/jobs/ai-pm', jd: '负责产品 PRD 规划与商业化。' },
            ],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get(key) {
      if (key === 'web') {
        return {
          search: async () => ({ sources: searchResults }),
          fetch: async ({ url }) => {
            if (url === 'https://careers.qingcloud.com/jobs/k8s-backend') {
              return {
                text: '<main><h1>智算后端研发工程师</h1><p>岗位职责：1. 负责青云智算平台 Kubernetes 控制面、GPU 调度引擎与 Go 微服务研发，主导多租户配额隔离、分布式训练集群高可用与性能优化；2. 参与异构算力资源编排、推理服务扩缩容及可观测体系建设。</p><p>任职要求：1. 本科及以上学历，3年以上 Go / Kubernetes / Docker 生产开发经验；2. 熟悉大模型训练推理调度系统与容器网络存储原理，具备大型分布式系统稳定性治理经验。</p></main>',
              }
            }
            return { text: '' }
          },
        }
      }
      return undefined
    },
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => {
    await dispose()
    await rm(dir, { recursive: true, force: true })
  })

  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: {
      model: 'fixture:m1',
      goal: 'AI Infra 后端工程师',
      searchTerms: ['Kubernetes', 'GPU 调度'],
    },
  })

  const previewRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'company-search-jobs',
    company: '青云科技',
    domain: 'qingcloud.com',
    careersUrl: 'https://careers.qingcloud.com',
    previewOnly: true,
  })
  assert.equal(previewRes.status, 200)
  const payload = previewRes.data.result
  assert.equal(payload.previewOnly, true)
  assert.equal(payload.imported, 0)
  assert.equal(payload.filteredOut, 3)
  assert.equal(payload.candidates.length, 1)
  assert.equal(payload.candidates[0].title, '智算后端研发工程师')
  assert.equal(payload.candidates[0].jdPreview, false)
  assert.match(payload.candidates[0].jd, /多租户配额隔离/)

  // Critical guarantee: previewOnly MUST NOT mutate state.opportunities
  const afterPreviewState = (await harness.call('GET', '/api/career-agent/state')).data
  assert.equal(afterPreviewState.opportunities.length, 0)
})

test('ATS fast-path pre-verify & CUA circuit-breaker handover switch to native sync and fail open cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-ats-handover-'))
  const harness = createFetchHarness()
  const registeredTools = new Map()
  let dispose
  const origFetch = globalThis.fetch
  let ghStatus = 200
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href === 'https://www.acme-ai.com/' || href === 'https://www.acme-ai.com') {
      return new Response('<html><body><a href="/about">About</a><a href="https://job-boards.greenhouse.io/acmeai">加入我们</a></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (href.includes('boards-api.greenhouse.io/v1/boards/acmeai/jobs')) {
      if (ghStatus !== 200) return new Response('not found', { status: ghStatus })
      return new Response(JSON.stringify({
        jobs: [
          {
            id: 1001,
            title: 'Kubernetes GPU 调度工程师',
            location: { name: 'Shanghai' },
            absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/1001',
            content: '<p>Build Kubernetes GPU scheduler, multi-tenant quota isolation, and distributed training infra.</p>',
          },
          {
            id: 1002,
            title: '渠道销售经理',
            location: { name: 'Beijing' },
            absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/1002',
            content: '<p>Responsible for channel reseller sales quotas and enterprise client outreach.</p>',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }
  t.after(async () => {
    globalThis.fetch = origFetch
    await dispose?.()
    await rm(dir, { recursive: true, force: true })
  })

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    llm: {
      listProviders: () => [{ id: 'fixture', models: [{ id: 'm1', name: 'm1' }] }],
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            companies: [{
              company: 'AcmeAI',
              domain: 'acme-ai.com',
              industry: 'AI Infra',
              location: 'Shanghai',
              reason: 'GPU infra match',
              careersUrl: 'https://www.acme-ai.com/',
              provider: '',
              slug: '',
            }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get(key) {
      if (key === 'tools') {
        return {
          register(def) {
            registeredTools.set(def.name, def)
            return () => {}
          },
        }
      }
      if (key === 'computerUse') return { providerName: 'macos-cua' }
      return undefined
    },
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })

  await harness.call('POST', '/api/career-agent/action', {
    action: 'configure',
    config: { model: 'fixture:m1', goal: 'AI Infra Kubernetes', searchTerms: ['Kubernetes', 'GPU'] },
  })

  // 1) Pre-launch verify probes homepage HTML -> detects Greenhouse ATS -> upgrades & previews filtered roles cleanly
  const resolved = await harness.call('POST', '/api/career-agent/action', {
    action: 'company-resolve-target',
    company: 'AcmeAI',
    domain: 'acme-ai.com',
    careersUrl: 'https://www.acme-ai.com/',
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.data.result.resolvedMode, 'ats')
  assert.equal(resolved.data.result.provider, 'greenhouse')
  assert.equal(resolved.data.result.slug, 'acmeai')
  assert.equal(resolved.data.result.candidates.length, 1)
  assert.equal(resolved.data.result.candidates[0].title, 'Kubernetes GPU 调度工程师')
  assert.equal(resolved.data.result.filteredOut, 1)

  // 2) CUA prompt exposes fast-path circuit-breaker instruction across both modes & locales
  assert.match(buildCuaCollectPrompt({ locale: 'zh', mode: 'hunt', company: '无问芯穹', careersUrl: 'https://www.infinigence.com/' }), /career_broker_register_ats_board[\s\S]*nextAction=stop/)
  assert.match(buildCuaCollectPrompt({ locale: 'en', mode: 'current-page' }), /career_broker_register_ats_board[\s\S]*nextAction=stop/)

  // 3) Mid-CUA tool: valid hosted ATS stages matched full JDs into Pending Import and signals nextAction=stop
  const handoverTool = registeredTools.get('career_broker_register_ats_board')
  const okHandover = await handoverTool.execute({ url: 'https://job-boards.greenhouse.io/acmeai', company: 'AcmeAI' })
  assert.match(okHandover, /nextAction=stop/)
  const stAfterHandover = (await harness.call('GET', '/api/career-agent/state')).data
  assert.equal(stAfterHandover.pendingOpportunities.length, 1)
  assert.equal(stAfterHandover.pendingOpportunities[0].title, 'Kubernetes GPU 调度工程师')
  assert.equal(stAfterHandover.pendingOpportunities[0].captureMode, 'ats-handover')

  // 4) Non-ATS portal URL (e.g. BOSS直聘) returns nextAction=continue_cua cleanly
  const nonAtsReply = await handoverTool.execute({ url: 'https://www.zhipin.com/job_detail/123.html' })
  assert.match(nonAtsReply, /continue_cua/)

  // 5) ATS API failure/404 fails open with nextAction=continue_cua without poisoning state
  ghStatus = 404
  const failReply = await handoverTool.execute({ url: 'https://job-boards.greenhouse.io/acmeai', company: 'AcmeAI' })
  assert.match(failReply, /continue_cua/)
  const stAfterFail = (await harness.call('GET', '/api/career-agent/state')).data
  assert.equal(stAfterFail.pendingOpportunities.length, 1)
})
