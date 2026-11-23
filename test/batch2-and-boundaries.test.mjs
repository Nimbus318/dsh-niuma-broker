import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply, attributeChatResumeProvenance, personalScheduleItems } from '../src/host.mjs'
import { CareerStore } from '../src/career.mjs'
import { renderLocalResume } from '../src/local-templates.mjs'
import { validateResumeEditLine } from '../src/resume-fact-guard.mjs'
import {
  applyReviewDecisions, buildUnifiedPlaybackSteps, computeReviewableLineChanges, suggestEvidencePlacement,
} from '../src/resume-diff.mjs'

async function startIsolatedHost(profileDir, llm) {
  let route
  let dispose
  await apply({
    profileContext: { dir: profileDir },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection: () => false },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    llm,
    logger: { warn() {} },
    get() {}, on() {}, provide() {}, emit() {},
    effect(fn) { dispose = fn() },
  })
  async function request(method, url, body = null, locale = 'en') {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, {
      method,
      url,
      headers: {
        'x-career-agent': '1',
        'x-career-locale': locale,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    })
    let status = 200
    let raw = ''
    await route.handler(req, {
      writeHead(code) { status = code; return this },
      write(chunk) { raw += String(chunk) },
      end(chunk) { if (chunk) raw += String(chunk) },
    })
    let json = null
    try { json = raw ? JSON.parse(raw) : null } catch {}
    return { status, raw, json }
  }
  return {
    request,
    action: (body, locale = 'en') => request('POST', '/career-agent/action', body, locale),
    state: (locale = 'en') => request('GET', '/career-agent/state', null, locale),
    dispose: () => dispose?.(),
  }
}

test('A1: paraphrase-proof chat provenance erases derived paraphrased resumes on forgetSource + restart while keeping parent intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-a1-paraphrase-'))
  try {
    const original = '# Alex Synthetic\n\n## Experience\n- Maintained an internal job scheduler.'
    const paraphrasedLine = '- Built automated sweeping for orphaned compute leases.'
    const model = {
      listProviders: () => [{ id: 'fixture' }],
      async *stream({ tools }) {
        if (tools.length) {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc-1',
              name: 'update_resume',
              arguments: JSON.stringify({
                markdown: `${original}\n${paraphrasedLine}`,
                changes: [{ kind: 'add', summary: 'Added workload cleanup example.' }],
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', text: 'Done.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const store = new CareerStore({ file: join(dir, 'career-broker', 'career.json') })
    await store.setMode('observe')
    await store.authorizeSource({ id: 'dsh-session', projects: ['proj-1'] })
    const ev = await store.ingestEvents([{
      id: 'ev-para-1',
      sourceId: 'dsh-session',
      projectId: 'proj-1',
      kind: 'work-evidence',
      occurredAt: new Date().toISOString(),
      evidence: [{ title: 'Recovery daemon', text: 'Added an internal recovery job to detect abandoned scheduler claims.' }],
    }])
    await store.reviewEvidence(ev.evidence[0].id, { action: 'approve', shareable: true })

    let parentId
    let childId
    const host1 = await startIsolatedHost(dir, model)
    try {
      const imp = await host1.action({ action: 'resume-import', title: 'Clean Parent', text: original })
      parentId = imp.json.result.id
      await host1.action({ action: 'resume-review', id: parentId, decision: 'approve' })

      const chat = await host1.request('POST', '/career-agent/resume-chat', {
        markdown: original,
        model: 'fixture:mock',
        locale: 'en',
        message: 'Include the new approved source achievement.',
      })
      const events = chat.raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
      const upd = events.find(e => e.type === 'resume-update')
      assert.ok(upd?.evidenceIds?.includes(ev.evidence[0].id), 'must conservatively bind injected evidence ID on paraphrase')

      const rev = await host1.action({
        action: 'resume-revise',
        id: parentId,
        text: upd.markdown,
        evidenceIds: upd.evidenceIds,
        variant: 'conversation',
      })
      childId = rev.json.result.id
      await host1.action({ action: 'resume-review', id: childId, decision: 'approve' })
      const preExport = await host1.action({ action: 'export', id: childId })
      assert.equal(preExport.status, 200)
      assert.ok(preExport.json.result.text.includes('orphaned compute leases'))

      await host1.action({ action: 'forget', source: 'dsh-session', erase: true })
    } finally {
      await host1.dispose()
    }

    // Restart host and verify derived paraphrased resume is erased while clean parent remains exportable
    const host2 = await startIsolatedHost(dir, model)
    try {
      const postChild = await host2.action({ action: 'export', id: childId })
      assert.equal(postChild.status, 400)
      const st = await host2.state()
      assert.equal(JSON.stringify(st.json.resumes).includes('orphaned compute leases'), false)
      const postParent = await host2.action({ action: 'export', id: parentId })
      assert.equal(postParent.status, 200)
      assert.equal(postParent.json.result.text, original)
    } finally {
      await host2.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A2: semantic metric anchoring rejects relabeled metric subjects and written-out English numbers while allowing legal rewrites', () => {
  const origEn = '- Maintained an internal job scheduler and reduced manual dispatch errors by 45%.'
  const badWordNums = validateResumeEditLine({
    original: origEn,
    rewritten: 'Reduced infrastructure cost by forty-five percent while leading an operations organization of two hundred fifty engineers.',
    resumeLang: 'en',
    locale: 'en',
  })
  assert.equal(badWordNums.ok, false)
  assert.equal(badWordNums.code, 'metric')

  const badRelabel = validateResumeEditLine({
    original: origEn,
    rewritten: 'Reduced infrastructure cost by 45% with the internal scheduler.',
    resumeLang: 'en',
    locale: 'en',
  })
  assert.equal(badRelabel.ok, false)
  assert.equal(badRelabel.code, 'metric_semantic')

  const validEn = validateResumeEditLine({
    original: origEn,
    rewritten: 'Reduced internal scheduler dispatch errors by 45% through routine maintenance.',
    resumeLang: 'en',
    locale: 'en',
  })
  assert.equal(validEn.ok, true)

  const validWordEquiv = validateResumeEditLine({
    original: origEn,
    rewritten: 'Cut manual dispatch errors by forty-five percent on the internal job scheduler.',
    resumeLang: 'en',
    locale: 'en',
  })
  assert.equal(validWordEquiv.ok, true)

  const origZh = '- 维护内部任务调度器，将手工派发错误降低 45%。'
  const badZhRelabel = validateResumeEditLine({
    original: origZh,
    rewritten: '通过内部调度器将基础设施成本降低 45%。',
    resumeLang: 'zh',
    locale: 'zh',
  })
  assert.equal(badZhRelabel.ok, false)
  assert.equal(badZhRelabel.code, 'metric_semantic')
})

test('A3: second same-label Round 1 after elapsed session or with isNewSession creates independent schedule ID while reschedule reuses ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-a3-calendar-'))
  const origNow = Date.now
  try {
    const host = await startIsolatedHost(dir, { listProviders: () => [] })
    try {
      await host.action({ action: 'configure', config: { mode: 'off', sendToModel: false, personalSchedule: { calendar: 'QA' } } })
      Date.now = () => Date.parse('2030-01-02T08:55:00Z')
      const jobRes = await host.action({ action: 'job-add', job: { company: 'QA Co', title: 'Infra', url: 'https://example.com/a3' } })
      const jobId = jobRes.json.result.id

      // Invite + Confirm Round 1 (future)
      await host.action({
        action: 'receipt',
        receipt: { id: 'inv-1', opportunityId: jobId, type: 'interview_invited', round: '一面', occurredAt: '2030-01-01T10:00:00Z', source: 'manual', confirmed: true, evidence: 'invite' },
      })
      await host.action({
        action: 'receipt',
        receipt: { id: 'conf-1', opportunityId: jobId, type: 'interview_confirmed', round: 'Round 1', occurredAt: '2030-01-01T11:00:00Z', startsAt: '2030-01-02T09:00:00Z', endsAt: '2030-01-02T09:30:00Z', source: 'manual', confirmed: true, evidence: 'confirm' },
      })
      const scheduleFor = st => personalScheduleItems({
        config: st.config,
        opportunities: st.opportunities,
        receipts: st.opportunities.flatMap(o => o.receipts ?? []),
      }, 'en')
      const st1 = (await host.state()).json
      const tasks1 = scheduleFor(st1)
      assert.equal(tasks1.length, 1)
      const firstTaskId = tasks1[0].id

      // Advance clock past first session end; add second Round 1 WITHOUT interviewId
      Date.now = () => Date.parse('2030-01-02T09:31:00Z')
      const r2 = await host.action({
        action: 'receipt',
        receipt: { id: 'conf-2', opportunityId: jobId, type: 'interview_confirmed', round: 'Round 1', occurredAt: '2030-01-02T09:31:00Z', startsAt: '2030-01-02T10:00:00Z', endsAt: '2030-01-02T10:30:00Z', source: 'manual', confirmed: true, evidence: 'confirm 2' },
      })
      assert.equal(r2.json.result.interviewId, 'conf-2', 'second Round 1 after elapsed session must auto-assign independent interviewId')
      const st2 = (await host.state()).json
      const tasks2 = scheduleFor(st2)
      assert.equal(tasks2.length, 1)
      assert.notEqual(tasks2[0].id, firstTaskId, 'second independent Round 1 must have a distinct Calendar task ID')

      // Adding a 3rd future Round 1 explicitly marked isNewSession=true must ALSO get a distinct ID
      const r3 = await host.action({
        action: 'receipt',
        receipt: { id: 'conf-3', opportunityId: jobId, type: 'interview_confirmed', round: 'Round 1', isNewSession: true, occurredAt: '2030-01-02T09:32:00Z', startsAt: '2030-01-02T11:00:00Z', endsAt: '2030-01-02T11:30:00Z', source: 'manual', confirmed: true, evidence: 'confirm 3' },
      })
      assert.equal(r3.json.result.interviewId, 'conf-3')
      const st3 = (await host.state()).json
      const tasks3 = scheduleFor(st3)
      assert.equal(tasks3.length, 2)
      assert.equal(new Set(tasks3.map(t => t.id)).size, 2)
    } finally {
      await host.dispose()
    }
  } finally {
    Date.now = origNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('A4: plain-text English and Chinese resumes preserve first-line candidate name instead of filename resume_2026_final', async () => {
  const plainEn = [
    'Alex Synthetic',
    'Staff Infrastructure Engineer',
    'San Francisco, CA | alex@synthetic.invalid',
    '',
    'Professional Experience',
    '- Maintained an internal job scheduler and reduced dispatch errors by 45%.',
    '',
    'Skills & Certifications',
    '- Python, Go, Kubernetes',
  ].join('\n')
  const rendered = await renderLocalResume({ text: plainEn, title: 'resume_2026_final', template: 'onyx', locale: 'en' })
  assert.equal(rendered.lang, 'en-US')
  assert.ok(rendered.html.includes('Alex Synthetic'), 'must render candidate name from line 0')
  assert.equal(rendered.html.includes('resume_2026_final'), false, 'must never overwrite candidate name with filename')
  assert.ok(rendered.html.includes('Professional Experience'))
  assert.ok(rendered.html.includes('Skills &amp; Certifications'))

  const plainZh = [
    '林予安',
    '高级基础架构工程师',
    '邮箱：yuan.lin@example.invalid',
    '工作经历',
    '- 负责推理网关调度优化。',
  ].join('\n')
  const renderedZh = await renderLocalResume({ text: plainZh, title: 'resume_2026_final', template: 'onyx', locale: 'zh' })
  assert.equal(renderedZh.lang, 'zh-CN')
  assert.ok(renderedZh.html.includes('林予安'))
  assert.equal(renderedZh.html.includes('resume_2026_final'), false)
})

test('B1: unified review diff engine supports multi-project edits + new win + long doc with selective accept/reject & playback steps', () => {
  const filler = Array.from({ length: 18 }, (_, i) => `- Legacy maintenance note ${i + 1} kept untouched.`).join('\n')
  const before = [
    '# Alex Synthetic',
    '',
    '## Experience',
    '### Project Alpha · Scheduler',
    '- Maintained an internal job scheduler for batch jobs.',
    '- Wrote runbooks for operators.',
    '',
    '### Project Beta · Gateway',
    '- Built HTTP routing proxy for internal APIs.',
    filler,
  ].join('\n')

  const after = [
    '# Alex Synthetic',
    '',
    '## Experience',
    '### Project Alpha · Scheduler',
    '- Maintained an internal batch job scheduler with improved dispatch reliability.',
    '- Wrote runbooks for operators.',
    '- Shipped automated stale-claim cleanup across worker queues.',
    '',
    '### Project Beta · Gateway',
    '- Built low-overhead HTTP routing proxy serving internal APIs.',
    filler,
  ].join('\n')

  const items = computeReviewableLineChanges(before, after, [
    { kind: 'edit', summary: 'Clarify Alpha scheduler reliability focus' },
    { kind: 'add', summary: 'Add new stale-claim cleanup win under Alpha' },
    { kind: 'edit', summary: 'Tighten Beta gateway bullet' },
  ], { locale: 'en' })

  assert.equal(items.length, 3)
  assert.deepEqual(items.map(i => i.kind), ['edit', 'insert', 'edit'])
  assert.match(items[0].section, /Project Alpha/)
  assert.match(items[2].section, /Project Beta/)

  // Accept item 0 and item 1, REJECT item 2 (Project Beta)
  const partial = applyReviewDecisions(before, items, [items[2].id])
  assert.ok(partial.includes('improved dispatch reliability'), 'accepted edit 0 applied')
  assert.ok(partial.includes('stale-claim cleanup'), 'accepted insert 1 applied')
  assert.ok(partial.includes('- Built HTTP routing proxy for internal APIs.'), 'rejected edit 2 preserved original wording')
  assert.equal(partial.includes('low-overhead'), false, 'rejected edit 2 must not leak')
  assert.ok(partial.includes('- Legacy maintenance note 18 kept untouched.'), 'long document untouched lines preserved')

  // Rejecting all returns exact original; accepting all returns exact after
  assert.equal(applyReviewDecisions(before, items, items.map(i => i.id)), before)
  assert.equal(applyReviewDecisions(before, items, []), after)

  // Playback steps cover all 3 items with accurate shifted line indices
  const steps = buildUnifiedPlaybackSteps(before, items)
  assert.equal(steps.length, 3)
  assert.equal(steps[0].kind, 'rewrite')
  assert.equal(steps[1].kind, 'insert')
  assert.equal(steps[2].kind, 'rewrite')
  assert.equal(steps[2].text, after)

  // Evidence placement targets the best matching section
  const placement = suggestEvidencePlacement(before, {
    title: 'Scheduler recovery',
    text: 'Added scheduler claim recovery checks',
  }, 'en')
  assert.match(placement.sectionLabel, /Project Alpha|Experience/)
  assert.ok(placement.proposedText.includes('- Added scheduler claim recovery checks'))
})

test('B1b & B2: per-version template/style persistence + inheritance across restart AND lossless receipt-reset/restore undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-b1b2-'))
  try {
    let masterId
    let branchId
    let jobId
    let savedReceipts
    const host1 = await startIsolatedHost(dir, { listProviders: () => [] })
    try {
      const imp = await host1.action({ action: 'resume-import', title: 'Master A', text: '# Alex\n## Experience\n- Built scheduler.' })
      masterId = imp.json.result.id
      await host1.action({ action: 'resume-review', id: masterId, decision: 'approve' })
      await host1.action({ action: 'resume-appearance', id: masterId, template: 'azurill', style: { accent: '#1e3a5f', density: 'compact' } })

      // Branch inherits appearance, then switches to its own template independently
      const br = await host1.action({ action: 'resume-branch-master', id: masterId, title: 'Master B' })
      branchId = br.json.result.id
      assert.equal(br.json.result.appearance?.template, 'azurill')
      await host1.action({ action: 'resume-appearance', id: branchId, template: 'pikachu', style: { accent: '#0f766e', font: 'serif' } })

      // Receipt reset + lossless restore
      const jobRes = await host1.action({ action: 'job-add', job: { company: 'UndoCo', title: 'Engineer', url: 'https://example.com/undo' } })
      jobId = jobRes.json.result.id
      await host1.action({
        action: 'receipt',
        receipt: { id: 'sub-1', opportunityId: jobId, type: 'application_submitted', material: 'Master A v1', materialId: masterId, materialKind: 'resume', occurredAt: '2026-11-20T10:00:00Z', source: 'manual', confirmed: true, evidence: 'applied' },
      })
      const stBefore = (await host1.state()).json
      savedReceipts = stBefore.opportunities.find(o => o.id === jobId).receipts
      assert.equal(savedReceipts.length, 1)

      await host1.action({ action: 'receipt-reset', opportunityId: jobId, mode: 'clear_all' })
      const stCleared = (await host1.state()).json
      assert.equal(stCleared.opportunities.find(o => o.id === jobId).receipts.length, 0)

      await host1.action({ action: 'receipt-restore', opportunityId: jobId, receipts: savedReceipts })
      const stRestored = (await host1.state()).json
      const restored = stRestored.opportunities.find(o => o.id === jobId).receipts
      assert.equal(restored.length, 1)
      assert.equal(restored[0].id, 'sub-1')
      assert.equal(restored[0].materialId, masterId)
    } finally {
      await host1.dispose()
    }

    // Verify per-version template/style survived restart independently!
    const host2 = await startIsolatedHost(dir, { listProviders: () => [] })
    try {
      const st = (await host2.state()).json
      const m = st.resumes.find(r => r.id === masterId)
      const b = st.resumes.find(r => r.id === branchId)
      assert.equal(m.appearance?.template, 'azurill')
      assert.equal(m.appearance?.style?.accent, '#1e3a5f')
      assert.equal(b.appearance?.template, 'pikachu')
      assert.equal(b.appearance?.style?.font, 'serif')
    } finally {
      await host2.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('A1b: mixed-source chat provenance attributes per change item, blocks DSH paraphrase even when GitHub quote matches, and preserves partial selection & pure/manual edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-a1b-mixed-'))
  try {
    const original = [
      '# Alex Synthetic',
      '',
      '## Experience',
      '- Wrote operational documentation for the infrastructure team.',
      '- Maintained the internal job scheduler and improved availability.',
    ].join('\n')
    const dshEvidenceText = 'Added an internal recovery job to detect abandoned scheduler claims. SYNTHETIC_SHAREABLE_FEAT_3441'
    const ghEvidenceText = 'I shipped a new wiki page for release notes. SYNTHETIC_RELEASE_DOC_2334'
    const dshParaphraseLine = '- Created automatic cleanup for stale workload reservations.'
    const ghExactLine = `- ${ghEvidenceText}`
    const mixedMarkdown = `${original}\n${dshParaphraseLine}\n${ghExactLine}`
    const pureTightenMarkdown = original
      .replace('Wrote operational documentation for the infrastructure team.', 'Documented operating procedures for the infrastructure team.')
      .replace('Maintained the internal job scheduler and improved availability.', 'Improved the availability of the internal job scheduler through maintenance.')

    // Unit check: pure editing of existing text does NOT spuriously bind DSH/GitHub,
    // while mixed quote + paraphrase binds per change item and same-line mixed catches both.
    const fakeEv = [
      { id: 'ev-dsh', sourceId: 'dsh-session', title: 'Recovery check', text: dshEvidenceText },
      { id: 'ev-gh', sourceId: 'github', title: 'Release notes', text: ghEvidenceText },
    ]
    const pureAttr = attributeChatResumeProvenance({
      injectedEvidence: fakeEv,
      beforeMarkdown: original,
      afterMarkdown: pureTightenMarkdown,
      userMessage: 'Tighten existing bullets.',
      locale: 'en',
    })
    assert.deepEqual(pureAttr.evidenceIds, [], 'pure tightening of existing lines must not falsely bind granted sources')

    const mixedAttr = attributeChatResumeProvenance({
      injectedEvidence: fakeEv,
      beforeMarkdown: original,
      afterMarkdown: mixedMarkdown,
      explicitUsedIds: ['ev-gh'],
      userMessage: 'Include approved achievements.',
      locale: 'en',
    })
    assert.ok(mixedAttr.evidenceIds.includes('ev-dsh'), 'must bind DSH evidence even when GitHub is quoted and explicitly listed')
    assert.ok(mixedAttr.evidenceIds.includes('ev-gh'))
    const paraProv = mixedAttr.changeProvenance.find(c => c.text === dshParaphraseLine)
    const ghProv = mixedAttr.changeProvenance.find(c => c.text === ghExactLine)
    assert.ok(paraProv?.evidenceIds.includes('ev-dsh'), 'paraphrase item must conservatively bind DSH')
    assert.deepEqual(ghProv?.evidenceIds, ['ev-gh'], 'exact GitHub quote item must only bind GitHub')

    const sameLineAttr = attributeChatResumeProvenance({
      injectedEvidence: fakeEv,
      beforeMarkdown: original,
      afterMarkdown: `${original}\n- ${ghEvidenceText} Also created automatic cleanup for stale workload reservations.`,
      userMessage: 'Include achievements.',
      locale: 'en',
    })
    assert.ok(sameLineAttr.evidenceIds.includes('ev-dsh'), 'same-line quote + paraphrase must still bind DSH')
    assert.ok(sameLineAttr.evidenceIds.includes('ev-gh'))

    // Full host round-trip with restart
    let mode = 'mixed'
    const model = {
      listProviders: () => [{ id: 'fixture' }],
      async *stream({ tools }) {
        if (tools.length) {
          const md = mode === 'tighten' ? pureTightenMarkdown : mixedMarkdown
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `tc-${mode}`,
              name: 'update_resume',
              arguments: JSON.stringify({
                markdown: md,
                changes: [{ kind: mode === 'tighten' ? 'edit' : 'add', summary: 'Update resume.' }],
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', text: 'Updated.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const store = new CareerStore({ file: join(dir, 'career-broker', 'career.json') })
    await store.setMode('observe')
    await store.authorizeSource({ id: 'dsh-session', projects: ['proj-1'] })
    await store.authorizeSource({ id: 'github', projects: ['repo-1'] })
    const evDsh = await store.ingestEvents([{
      id: 'ev-mixed-dsh', sourceId: 'dsh-session', projectId: 'proj-1', kind: 'work-evidence',
      occurredAt: new Date().toISOString(),
      evidence: [{ title: 'Recovery daemon', text: dshEvidenceText }],
    }])
    const evGh = await store.ingestEvents([{
      id: 'ev-mixed-gh', sourceId: 'github', projectId: 'repo-1', kind: 'work-evidence',
      occurredAt: new Date().toISOString(),
      evidence: [{ title: 'Release notes', text: ghEvidenceText }],
    }])
    await store.reviewEvidence(evDsh.evidence[0].id, { action: 'approve', shareable: true })
    await store.reviewEvidence(evGh.evidence[0].id, { action: 'approve', shareable: true })

    let parentId
    let mixedFullId
    let onlyDshPartialId
    let onlyGhPartialId
    let pureTightenId
    let manualEditId

    const host1 = await startIsolatedHost(dir, model)
    try {
      parentId = (await host1.action({ action: 'resume-import', title: 'Clean Parent', text: original })).json.result.id
      await host1.action({ action: 'resume-review', id: parentId, decision: 'approve' })

      // 1. Mixed-source chat proposal
      mode = 'mixed'
      const chatMixed = await host1.request('POST', '/career-agent/resume-chat', {
        markdown: original, model: 'fixture:mock', locale: 'en', resumeId: parentId,
        message: 'Include the new approved source achievements.',
      })
      const updMixed = chatMixed.raw.split('\n').filter(Boolean).map(JSON.parse).find(e => e.type === 'resume-update')
      assert.ok(updMixed?.evidenceIds?.includes(evDsh.evidence[0].id))
      assert.ok(updMixed?.evidenceIds?.includes(evGh.evidence[0].id))

      // 1a. Accept full mixed proposal
      mixedFullId = (await host1.action({
        action: 'resume-revise', id: parentId, text: updMixed.markdown,
        evidenceIds: updMixed.evidenceIds, autoSaved: true, variant: 'conversation',
      })).json.result.id
      await host1.action({ action: 'resume-review', id: mixedFullId, decision: 'approve' })

      // 1b. Single-line partial selection: accept ONLY paraphrased DSH line (even without passing evidenceIds)
      const diffItems = computeReviewableLineChanges(original, updMixed.markdown, updMixed.changes, { locale: 'en' })
      const ghItem = diffItems.find(it => it.text === ghExactLine)
      const dshItem = diffItems.find(it => it.text === dshParaphraseLine)
      assert.ok(ghItem && dshItem)
      const onlyDshText = applyReviewDecisions(original, diffItems, [ghItem.id])
      onlyDshPartialId = (await host1.action({
        action: 'resume-revise', id: parentId, text: onlyDshText, autoSaved: true, variant: 'conversation',
      })).json.result.id
      await host1.action({ action: 'resume-review', id: onlyDshPartialId, decision: 'approve' })

      // 1c. Single-line partial selection: accept ONLY GitHub exact quote (rejecting DSH paraphrase)
      const onlyGhText = applyReviewDecisions(original, diffItems, [dshItem.id])
      const ghItemProv = updMixed.changeProvenance.find(c => c.text === ghExactLine)
      onlyGhPartialId = (await host1.action({
        action: 'resume-revise', id: parentId, text: onlyGhText,
        evidenceIds: ghItemProv.evidenceIds, autoSaved: true, variant: 'conversation',
      })).json.result.id
      await host1.action({ action: 'resume-review', id: onlyGhPartialId, decision: 'approve' })

      // 2. Pure tightening of existing lines while approved DSH + GitHub exist
      mode = 'tighten'
      const chatTighten = await host1.request('POST', '/career-agent/resume-chat', {
        markdown: original, model: 'fixture:mock', locale: 'en', resumeId: parentId,
        message: 'Tighten existing bullets.',
      })
      const updTighten = chatTighten.raw.split('\n').filter(Boolean).map(JSON.parse).find(e => e.type === 'resume-update')
      assert.equal(updTighten?.evidenceIds?.length ?? 0, 0)
      pureTightenId = (await host1.action({
        action: 'resume-revise', id: parentId, text: updTighten.markdown, autoSaved: true, variant: 'conversation',
      })).json.result.id
      await host1.action({ action: 'resume-review', id: pureTightenId, decision: 'approve' })

      // 3. Manual edit after chat proposals (must NOT inherit rejected chat provenance)
      manualEditId = (await host1.action({
        action: 'resume-revise', id: parentId, text: `${original}\n- Led weekly incident review meetings.`, autoSaved: true,
      })).json.result.id
      await host1.action({ action: 'resume-review', id: manualEditId, decision: 'approve' })

      // Clear DSH source and restart
      await host1.action({ action: 'forget', source: 'dsh-session', erase: true })
    } finally {
      await host1.dispose()
    }

    const host2 = await startIsolatedHost(dir, model)
    try {
      // Full mixed & DSH-only partial must be blocked and absent from public readback
      assert.equal((await host2.action({ action: 'export', id: mixedFullId })).status, 400)
      assert.equal((await host2.action({ action: 'export', id: onlyDshPartialId })).status, 400)
      const st = (await host2.state()).json
      assert.equal(JSON.stringify(st.resumes).includes('stale workload reservations'), false)

      // Independent parent, GitHub-only partial, pure tightening, and manual edit MUST stay exportable!
      assert.equal((await host2.action({ action: 'export', id: parentId })).status, 200)
      const ghOnlyExport = await host2.action({ action: 'export', id: onlyGhPartialId })
      assert.equal(ghOnlyExport.status, 200)
      assert.ok(ghOnlyExport.json.result.text.includes('SYNTHETIC_RELEASE_DOC_2334'))
      assert.equal(ghOnlyExport.json.result.text.includes('stale workload reservations'), false)
      assert.equal((await host2.action({ action: 'export', id: pureTightenId })).status, 200)
      assert.equal((await host2.action({ action: 'export', id: manualEditId })).status, 200)

      // Clearing GitHub must now revoke the GitHub-only partial too!
      await host2.action({ action: 'forget', source: 'github', erase: true })
      assert.equal((await host2.action({ action: 'export', id: onlyGhPartialId })).status, 400)
      assert.equal((await host2.action({ action: 'export', id: manualEditId })).status, 200)
    } finally {
      await host2.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
