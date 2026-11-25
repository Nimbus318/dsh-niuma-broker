import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  compareRunsPaired,
  computeKendallTauB,
  computeNdcgAtK,
  computePrecisionAtK,
  computeRankStability,
  computeRecallAtK,
  computeTierStats,
  rankRubricOptionA,
  rankRubricOptionB,
} from '../scripts/eval/metrics.mjs'
import { evaluateDataset, formatEvalMarkdown } from '../scripts/eval/run-eval.mjs'
import { samplePrivateDataset } from '../scripts/eval/sample-private-dataset.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve('.')
const BENCHMARK_PATH = join(ROOT, 'test', 'fixtures', 'triage-benchmark', 'synthetic-benchmark.json')

test('eval metrics compute exact Recall@K, NDCG@K (0/1/3/7), Precision@K, and Kendall tau-b', () => {
  const labels = { a: 3, b: 2, c: 1, d: 0, e: 3 }
  const ranked = ['a', 'c', 'b', 'd', 'e']

  const rec3 = computeRecallAtK(ranked, labels, 3)
  assert.equal(rec3.hits, 2)
  assert.equal(rec3.totalRelevant, 3)
  assert.equal(Number(rec3.recall.toFixed(4)), Number((2 / 3).toFixed(4)))

  // Gains [0, 1, 3, 7]: ideal top-3 = [7, 7, 3], actual top-3 = [7, 1, 3]
  const ndcg3 = computeNdcgAtK(ranked, labels, 3)
  const expectedDcg = 7 / Math.log2(2) + 1 / Math.log2(3) + 3 / Math.log2(4)
  const expectedIdcg = 7 / Math.log2(2) + 7 / Math.log2(3) + 3 / Math.log2(4)
  assert.ok(Math.abs(ndcg3.ndcg - expectedDcg / expectedIdcg) < 1e-9)

  const p4 = computePrecisionAtK(ranked, labels, 4)
  assert.equal(p4.hits, 2)
  assert.equal(p4.precision, 0.5)

  // Moving #1 of 12 items to #12 reverses 11/66 pairs -> tau_b = (55 - 11) / 66 = 2/3
  const base12 = Array.from({ length: 12 }, (_, i) => `j${i}`)
  const shifted12 = [...base12.slice(1), base12[0]]
  const tauShift = computeKendallTauB(base12, shifted12)
  assert.equal(tauShift.concordant, 55)
  assert.equal(tauShift.discordant, 11)
  assert.ok(Math.abs(tauShift.tauB - (2 / 3)) < 1e-9)

  // Tie-aware tau-b handles ties properly
  const mapA = new Map([['x', 3], ['y', 3], ['z', 1]])
  const mapB = new Map([['x', 2], ['y', 1], ['z', 0]])
  const tauTie = computeKendallTauB(mapA, mapB)
  assert.equal(tauTie.concordant, 2)
  assert.equal(tauTie.discordant, 0)
  assert.ok(tauTie.tauB > 0.8 && tauTie.tauB < 0.9)

  const stability = computeRankStability(
    [base12, shifted12],
    [
      Object.fromEntries(base12.map((id, i) => [id, i < 4 ? 'top' : 'good'])),
      Object.fromEntries(shifted12.map((id, i) => [id, i < 4 ? 'top' : 'good'])),
    ],
  )
  assert.equal(stability.pairCount, 1)
  assert.equal(stability.maxTop3Displacements, 1)
  assert.ok(stability.minTop10Overlap >= 0.9)
  assert.ok(stability.maxBoundaryFlipRate > 0)

  const paired = compareRunsPaired(
    { recallAt30: 0.6, recallAt60: 0.7, ndcgAt10: 0.72, totalTokens: 1000 },
    { recallAt30: 0.8, recallAt60: 0.9, ndcgAt10: 0.8, totalTokens: 1200 },
  )
  assert.ok(Math.abs(paired.deltaRecallAt60 - 0.2) < 1e-9)
  assert.ok(Math.abs(paired.deltaNdcgAt10 - 0.08) < 1e-9)
  assert.equal(paired.deltaTotalTokens, 200)
  assert.equal(paired.tokensPerNdcg10, 1500)
})

test('rubric Option A (D=3 gate + lexicographical) vs Option B (weighted S) diverge predictably on (3,2,2) vs (2,3,3)', () => {
  const items = [
    { id: 'adj_strong_resume', rubric: { D: 2, E: 3, L: 3 }, recallRank: 1 },
    { id: 'exact_duty_transferable', rubric: { D: 3, E: 2, L: 2 }, recallRank: 2 },
    { id: 'mismatch_good_city', rubric: { D: 0, E: 3, L: 3 }, recallRank: 0 },
  ]
  const outA = rankRubricOptionA(items)
  assert.equal(outA[0].id, 'exact_duty_transferable')
  assert.equal(outA[0].tier, 'top')
  assert.equal(outA[1].id, 'adj_strong_resume')
  assert.equal(outA[1].tier, 'good')
  assert.equal(outA[2].tier, 'skip')

  const outB = rankRubricOptionB(items)
  assert.equal(outB[0].id, 'adj_strong_resume')
  assert.equal(outB[0].tier, 'top')
  assert.equal(outB[1].id, 'exact_duty_transferable')
  assert.equal(outB[1].tier, 'top')
  assert.equal(outB[2].tier, 'skip')

  const tierStats = computeTierStats(
    Object.fromEntries(outA.map(x => [x.id, { ...x, score: x.tier === 'top' ? 92 : 70 }])),
    { exact_duty_transferable: 3, adj_strong_resume: 2, mismatch_good_city: 0 },
  )
  assert.equal(tierStats.precisionAtTopRel2, 1)
  assert.ok(tierStats.tierEntropy > 1)
})

test('synthetic benchmark enforces zero hard-filter leaks, <=30 selection cap, sendToModel=false silence, and deterministic baseline reporting', async () => {
  const dataset = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8'))
  const run1 = await evaluateDataset(dataset, { seed: 42, limit: 30 })
  const run2 = await evaluateDataset(dataset, { seed: 42, limit: 30 })

  assert.equal(run1.stage1Summary.totalHardLeaks, 0)
  assert.equal(run1.stage1Summary.sendToModelFalseCalls, 0)
  assert.ok(run1.stage1Summary.maxSelectedCount <= 30)
  assert.equal(run1.personas.length, 3)

  // Deterministic repeatability across runs
  assert.deepEqual(run1.stage1Summary, { ...run2.stage1Summary, totalLatencyMs: run1.stage1Summary.totalLatencyMs })
  assert.deepEqual(run1.stage2Summary, run2.stage2Summary)

  // Inspect Stage 2 adversarial diagnostics documenting current baseline gaps (non-mutating audit)
  const aiPersona = run1.personas.find(p => p.personaId === 'synthetic_ai_infra')
  assert.ok(aiPersona.stage2.adversarialDiagnostics)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.emptyQuoteAcceptedAsTopOrGoodCount >= 1)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.missingScoreAcceptedAsLlmCount >= 1)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.unverifiedQuoteMarkedCount >= 1)
  assert.ok(aiPersona.stage2.adversarialDiagnostics.noiseInTopCount >= 1)

  const md = formatEvalMarkdown(run1, run2)
  assert.match(md, /Offline Triage Evaluation Report/)
  assert.match(md, /deltaNdcgAt10/)
})

test('selection cap <= 30 holds even when open pool exceeds 45 jobs', async () => {
  const extraJobs = Array.from({ length: 48 }, (_, i) => ({
    id: `greenhouse:scale-board:job-${i}`,
    sourceId: 'greenhouse:scale-board',
    provider: 'greenhouse',
    externalId: `job-${i}`,
    company: 'ScaleBoard',
    title: 'AI Infra Engineer',
    location: '上海',
    jd: `负责大规模分布式推理与 GPU 调度系统开发，第 ${i} 岗位职责说明。`,
    verifiedAt: `2026-11-24T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
  }))
  const report = await evaluateDataset({
    id: 'scale_check',
    goal: '上海 AI Infra 工程师',
    searchTerms: ['AI Infra', 'GPU'],
    boards: [{ provider: 'greenhouse', slug: 'scale-board' }],
    opportunities: extraJobs,
    labels: Object.fromEntries(extraJobs.slice(0, 10).map(j => [j.id, 3])),
  }, { limit: 60 })
  assert.equal(report.stage1Summary.maxSelectedCount, 30)
})

test('CLI scripts require explicit paths, run clean synthetic JSON output, and reject out-of-scope sampler targets', async t => {
  await assert.rejects(
    () => execFileAsync('node', ['scripts/eval/run-eval.mjs'], { cwd: ROOT }),
    err => err.code === 2,
  )

  const { stdout } = await execFileAsync(
    'node',
    ['scripts/eval/run-eval.mjs', '--dataset', BENCHMARK_PATH, '--json'],
    { cwd: ROOT },
  )
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.stage1Summary.totalHardLeaks, 0)
  assert.equal(parsed.stage1Summary.sendToModelFalseCalls, 0)

  await assert.rejects(
    () => execFileAsync('node', ['scripts/eval/sample-private-dataset.mjs'], { cwd: ROOT }),
    err => err.code === 2,
  )

  // Test stratified local sampler against an explicit isolated temporary state file (never touches home dirs)
  const dir = await mkdtemp(join(tmpdir(), 'eval-sampler-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const watchdogPath = join(dir, 'watchdog.json')
  const syntheticWatchdog = {
    config: { goal: '上海 GPU 调度', searchTerms: ['GPU', 'vLLM'] },
    opportunities: [
      { id: 'gh:a:1', provider: 'greenhouse', sourceId: 'gh:a', externalId: '1', company: 'A', title: 'GPU 调度工程师', location: '上海', jd: '负责 vLLM 调度。' },
      { id: 'gh:a:2', provider: 'greenhouse', sourceId: 'gh:a', externalId: '2', company: 'A', title: '基础平台研发', location: '上海', jd: '负责后端稳定性与监控建设，服务百万日活集群运行，优化资源编排吞吐能力与容灾演练体系并沉淀长期可观测标准。'.repeat(2) },
      { id: 'gh:a:3', provider: 'greenhouse', sourceId: 'gh:a', externalId: '3', company: 'A', title: 'HRBP', location: '上海', jd: '负责招聘。' },
      { id: 'gh:a:4', provider: 'greenhouse', sourceId: 'gh:a', externalId: '4', company: 'A', title: '未知岗位', location: '上海', jd: '' },
    ],
  }
  await writeFile(watchdogPath, JSON.stringify(syntheticWatchdog), 'utf8')
  const sampled = await samplePrivateDataset({ watchdogPath, count: 8, seed: 7 })
  assert.equal(sampled.personas[0].opportunities.length, 4)
  assert.ok(Object.values(sampled.personas[0].labels).every(v => v === null))
})
