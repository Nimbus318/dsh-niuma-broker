import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  buildCuaCollectPrompt,
  compareSemver,
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
  assert.match(buildCuaCollectPrompt({ locale: 'zh', company: '字节跳动' }), /最多 5 张/)

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

  // Rejects batch > 5 items and non-HTTPS URLs
  await assert.rejects(() => importTool.execute({
    jobs: Array.from({ length: 6 }, (_, i) => ({ company: `Co${i}`, title: `Role${i}` })),
  }), /1 至 5/)
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
  assert.deepEqual(toolDisposed.sort(), ['career_broker_import_opportunity', 'career_broker_record_work_win'])
  assert.equal(registeredSkillProvider, null)
})
