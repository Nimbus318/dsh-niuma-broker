import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFetchHarness } from './_fetch-harness.mjs'
import { apply } from '../src/host.mjs'
import { clearBm25fCache, rankOpportunitiesBm25f } from '../src/job-triage.mjs'

test('state?deferMarket=1 returns immediately on cold profile, hydrates marketRadar on follow-up, and reuses caches cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-startup-perf-'))
  const harness = createFetchHarness()
  let cuaListCalls = 0
  let dispose
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    get: key => (key === 'pluginInventory' ? {
      list: async () => {
        cuaListCalls += 1
        return { entries: [{ moduleName: '@deepseek-ai/dsh-cua-bundle', meta: { version: '0.2.3-alpha.2' } }] }
      },
    } : undefined),
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => {
    await dispose?.()
    await rm(dir, { recursive: true, force: true })
  })

  await harness.call('POST', '/api/career-agent/action', {
    action: 'job-add',
    job: { company: 'AcmeAI', title: 'AI Infra Engineer', location: 'Shanghai', url: 'https://example.com/1', jd: 'Build vLLM and KV Cache distributed runtime with Go and Kubernetes.' },
  })

  // Cold ?deferMarket=1 skips synchronous market corpus build and flags loading: true
  const deferred = await harness.call('GET', '/api/career-agent/state?deferMarket=1')
  assert.equal(deferred.status, 200)
  assert.equal(deferred.data.opportunities.length, 1)
  assert.equal(deferred.data.marketRadar.loading, true)
  assert.equal(deferred.data.marketRadar.target, null)
  const cuaCallsAfterFirst = cuaListCalls

  // Follow-up full /state (or post-warmup ?deferMarket=1) returns hydrated marketRadar and reuses 30s CUA cache
  const hydrated = await harness.call('GET', '/api/career-agent/state')
  assert.equal(hydrated.status, 200)
  assert.equal(hydrated.data.marketRadar.loading, false)
  assert.equal(hydrated.data.marketRadar.target.activeCount, 1)
  assert.equal(cuaListCalls, cuaCallsAfterFirst)

  // Warm ?deferMarket=1 now serves already-warm marketRadar synchronously with loading: false
  const warmDeferred = await harness.call('GET', '/api/career-agent/state?deferMarket=1')
  assert.equal(warmDeferred.status, 200)
  assert.equal(warmDeferred.data.marketRadar.loading, false)
  assert.equal(warmDeferred.data.marketRadar.target.activeCount, 1)

  // Mutation invalidates cachedView + cachedMarket immediately
  await harness.call('POST', '/api/career-agent/action', {
    action: 'job-add',
    job: { company: 'BetaAI', title: 'GPU Kernel Engineer', location: 'Beijing', url: 'https://example.com/2', jd: 'Optimize CUDA GEMM kernels and Triton inference graphs.' },
  })
  const afterMutation = await harness.call('GET', '/api/career-agent/state')
  assert.equal(afterMutation.data.opportunities.length, 2)
  assert.equal(afterMutation.data.marketRadar.target.activeCount, 2)

  // Evidence edit updates marketRadar attribution without stale cache hit
  const ingestRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'ingest',
    event: {
      id: 'ev-perf-1',
      sourceId: 'manual',
      projectId: 'personal',
      kind: 'manual',
      occurredAt: new Date().toISOString(),
      evidence: [{ title: 'Kubernetes service pipeline', text: 'Built Kubernetes Go backend automation', impact: '' }],
    },
  })
  assert.equal(ingestRes.status, 200)
  const evId = ingestRes.data.result.evidence[0].id
  const approveRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'evidence-update',
    id: evId,
    changes: { status: 'approved', shareable: true },
  })
  assert.equal(approveRes.status, 200)
  const beforeRename = await harness.call('GET', '/api/career-agent/state')
  const k8sBefore = beforeRename.data.marketRadar.target.topSkills.find(s => /kubernetes/i.test(s.label))
  const vllmBefore = beforeRename.data.marketRadar.target.topSkills.find(s => /vllm|kv\s*cache/i.test(s.label))
  assert.equal(k8sBefore?.coverage, 'in_work_only')
  assert.equal(vllmBefore?.coverage, 'gap')

  const renameRes = await harness.call('POST', '/api/career-agent/action', {
    action: 'evidence-update',
    id: evId,
    changes: {
      title: 'Rust vLLM runtime optimization',
      text: 'Built vLLM KV Cache runtime in Rust',
    },
  })
  assert.equal(renameRes.status, 200)
  const afterRename = await harness.call('GET', '/api/career-agent/state')
  const k8sAfter = afterRename.data.marketRadar.target.topSkills.find(s => /kubernetes/i.test(s.label))
  const vllmAfter = afterRename.data.marketRadar.target.topSkills.find(s => /vllm|kv\s*cache/i.test(s.label))
  assert.equal(k8sAfter?.coverage, 'gap')
  assert.equal(vllmAfter?.coverage, 'in_work_only')
})

test('BM25F first-char anchor indexing matches full-scan results deterministically across CJK & sub-anchors', () => {
  clearBm25fCache()
  const profile = {
    searchTerms: ['大模型推理优化', '分布式一致性'],
    goalTargets: ['AI Infra架构师'],
    resumeKeywords: ['KV Cache压缩', '数据出境合规'],
    avoidHints: [],
  }
  const jobs = [
    { id: 'j1', title: '大模型推理优化工程师', location: '上海', jd: '负责 vLLM KV Cache 压缩与推理优化，解决数据出境场景稳定性问题。', firstSeenAt: '2026-11-26T00:00:00Z' },
    { id: 'j2', title: '数据出境合规顾问', location: '上海', jd: '负责跨境数据出境审计与 PIA 评估。', firstSeenAt: '2026-11-26T00:00:00Z' },
    { id: 'j3', title: 'Java 业务开发', location: '北京', jd: '负责企业 ERP 日常订单功能开发。', firstSeenAt: '2026-11-26T00:00:00Z' },
  ]
  const res = rankOpportunitiesBm25f(jobs, profile, {
    hasExplicitOutsourceLabel: () => false,
    isOutsourceAvoidHint: () => false,
    hasTerm: (s, t) => s.includes(t),
    matchesCity: (l, c) => l.includes(c.toLowerCase()),
    locationMarkets: [],
    jobContentFingerprint: j => `${j.id}:${j.title.length}:${j.jd.length}`,
  })
  assert.equal(res.ranked[0].id, 'j1')
  assert.ok(res.byId.get('j1').recallScore > res.byId.get('j2').recallScore)
  assert.equal(res.byId.get('j3').recallScore, 0)
})
