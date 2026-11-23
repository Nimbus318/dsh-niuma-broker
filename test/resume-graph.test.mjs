import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CareerStore } from '../src/career.mjs'
import { buildResumeGitGraph } from '../src/resume-graph.mjs'

test('buildResumeGitGraph lays out default master on lane 0 with fork & rebase edges and topological order', () => {
  const resumes = [
    { id: 'm1', trackId: 't-main', title: '通用简历', kind: 'import', status: 'approved', createdAt: '2026-11-18T10:00:00Z' },
    { id: 'm2', trackId: 't-main', parentId: 'm1', title: '通用简历', kind: 'generated', status: 'approved', createdAt: '2026-11-19T10:00:00Z' },
    { id: 'b1', opportunityId: 'opp-linear', baseId: 'm1', sourceTrackId: 't-main', title: 'Linear', kind: 'tailored', general: false, status: 'approved', createdAt: '2026-11-18T12:00:00Z' },
    { id: 'b2', opportunityId: 'opp-linear', parentId: 'b1', baseId: 'm2', sourceTrackId: 't-main', origin: 'rebase', title: 'Linear', kind: 'revised', general: false, status: 'pending', createdAt: '2026-11-20T10:00:00Z' },
    { id: 'b3', opportunityId: 'opp-byte', baseId: 'm1', sourceTrackId: 't-main', title: '字节跳动', kind: 'tailored', general: false, status: 'approved', createdAt: '2026-11-19T08:00:00Z' },
    { id: 'm-pm', trackId: 't-pm', branchedFromId: 'm2', title: '产品运营主干', kind: 'import', status: 'approved', createdAt: '2026-11-21T08:00:00Z' },
    { id: 'old-arch', opportunityId: 'opp-old', baseId: 'm1', title: '旧归档版', kind: 'tailored', general: false, status: 'approved', createdAt: '2026-11-17T08:00:00Z', archivedAt: '2026-11-21T09:00:00Z' },
  ]
  const opportunities = [
    { id: 'opp-linear', company: 'Linear', title: 'Staff AI' },
    { id: 'opp-byte', company: '字节跳动', title: 'AI Infra' },
  ]

  const graph = buildResumeGitGraph(resumes, {
    defaultMasterTrackId: 't-main',
    opportunities,
    currentId: 'b2',
  })

  assert.equal(graph.nodes.length, 6)
  assert.equal(graph.counts.masters, 2)
  assert.equal(graph.counts.branches, 2)
  assert.equal(graph.counts.behind, 1) // opp-byte is still on m1 while t-main is at m2!
  assert.equal(graph.counts.archived, 1)

  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  // Default master stays pinned on lane 0
  assert.equal(byId.get('m1').lane, 0)
  assert.equal(byId.get('m2').lane, 0)
  assert.ok(byId.get('b1').lane >= 1)
  assert.equal(byId.get('b2').lane, byId.get('b1').lane)
  assert.equal(byId.get('b2').isCurrent, true)

  // Every edge flows top -> bottom (fromRow < toRow)
  for (const edge of graph.edges) {
    assert.ok(edge.fromRow < edge.toRow, `edge ${edge.id} must flow from newer (${edge.fromRow}) to older (${edge.toRow})`)
  }

  // Must include fork edges (b1->m1, b3->m1, m-pm->m2 via branchedFromId) AND rebase edge (b2->m2)
  assert.ok(graph.edges.some(e => e.kind === 'fork' && e.fromId === 'b1' && e.toId === 'm1'))
  assert.ok(graph.edges.some(e => e.kind === 'fork' && e.fromId === 'm-pm' && e.toId === 'm2'))
  assert.ok(graph.edges.some(e => e.kind === 'rebase' && e.fromId === 'b2' && e.toId === 'm2'))

  // Behind filter isolates drifted branch + its source master
  const behindGraph = buildResumeGitGraph(resumes, {
    defaultMasterTrackId: 't-main',
    opportunities,
    filter: 'behind',
  })
  const behindIds = new Set(behindGraph.nodes.map(n => n.id))
  assert.ok(behindIds.has('b3'))
  assert.ok(behindIds.has('m1'))
  assert.ok(behindIds.has('m2'))
  assert.ok(!behindIds.has('b2'))
})

test('CareerStore supports safe archive (version/track/older squash), restore, sole-master guard, and safe permanent delete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'career-archive-'))
  try {
    const store = new CareerStore({ file: join(dir, 'career.json') })
    const m1 = await store.importResume({ title: '默认主干', text: '# 林予安\n\n## 工作经历\n- 原始成果 A\n' })
    await store.reviewResume(m1.id, { action: 'approve' })
    const m2 = await store.reviseResume(m1.id, { text: '# 林予安\n\n## 工作经历\n- 原始成果 A\n- 新增成果 B\n' })
    await store.reviewResume(m2.id, { action: 'approve' })

    // Cannot archive sole master track
    await assert.rejects(() => store.archiveResume({ id: m2.id, scope: 'track' }), /至少需要保留 1 份/)

    // Squash older revisions (keeps m2 standalone, archives m1)
    const squashed = await store.archiveResume({ id: m2.id, scope: 'older' })
    assert.deepEqual(squashed.archivedIds, [m1.id])
    const exportedM2 = await store.exportResume(m2.id)
    assert.match(exportedM2, /新增成果 B/)

    // Branch a secondary master track, set default, then archive default -> auto-promotes remaining master
    const mAlt = await store.branchMasterResume(m2.id, '产品方向主干')
    await store.setDefaultMasterTrack(mAlt.trackId)
    const archAlt = await store.archiveResume({ id: mAlt.id, scope: 'track' })
    assert.deepEqual(archAlt.archivedIds, [mAlt.id])
    assert.notEqual(archAlt.defaultMasterTrackId, mAlt.trackId)

    // Restore archived master cleanly
    const restored = await store.restoreResume({ id: mAlt.id, scope: 'track' })
    assert.deepEqual(restored.restoredIds, [mAlt.id])

    // Permanent delete of archived m1 preserves active m2 markdown cleanly
    const del = await store.deleteArchivedResume(m1.id)
    assert.equal(del.deletedId, m1.id)
    const stillValid = await store.exportResume(m2.id)
    assert.match(stillValid, /新增成果 B/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
