import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { CareerStore } from '../src/career.mjs'
import { apply, personalScheduleItems } from '../src/host.mjs'
import { createInterviewIcs } from '../src/opportunities.mjs'
import { validateResumeEditLine } from '../src/resume-fact-guard.mjs'
import { inspectZonedLocalTime, zonedCalendarDayDelta, zonedLocalToIso } from '../src/timezone.mjs'

async function createHost({ dir, llm }) {
  let route
  let dispose
  const ctx = {
    profileContext: { dir },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection: () => false },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    get() {},
    on() {},
    emit() {},
    provide(key, value) { if (key === 'careerBroker') this.broker = value },
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)

  async function request(method, url, body = null, extraHeaders = {}) {
    const req = Readable.from(body !== null ? [Buffer.from(JSON.stringify(body), 'utf8')] : [])
    Object.assign(req, {
      method,
      url,
      headers: {
        'x-career-agent': '1',
        ...(body !== null ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
    })
    let status = 200
    const chunks = []
    await route.handler(req, {
      writableEnded: false,
      destroyed: false,
      writeHead(code) { status = code; return this },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true },
      end(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true },
    })
    const raw = Buffer.concat(chunks).toString('utf8')
    let json = null
    try { json = JSON.parse(raw) } catch {}
    return { status, raw, json }
  }

  return {
    request,
    action: (actionName, more = {}, hdrs = {}) => request('POST', '/career-agent/action', { action: actionName, ...more }, hdrs),
    broker: ctx.broker,
    close: () => dispose?.(),
  }
}

test('Batch 1.1: paused auto-intel skips model, manual intel never sends private/pending evidence, and forget erases intel & chat provenance across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-b1-privacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const privMark = 'SYNTHETIC_PRIVATE_SECRET_41129'
  const pendMark = 'SYNTHETIC_PENDING_SECRET_52210'
  const shareMark = 'SYNTHETIC_SHAREABLE_FEAT_3441'
  const seenPrompts = []
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ system = '', messages = [], tools = [] }) {
      const payload = `${system}\n${JSON.stringify(messages)}`
      seenPrompts.push(payload)
      if (tools.length) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c1',
            name: 'update_resume',
            arguments: JSON.stringify({
              markdown: `# Alex Synthetic\n\n## Experience\n- Built GPU infrastructure at Test Inc.\n- Delivered ${shareMark} with 45% better availability.`,
              changes: [{ kind: 'add', summary: 'Merged approved evidence' }],
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (payload.includes('verdict')) {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            verdict: payload.includes(shareMark) ? `Highlights ${shareMark}` : 'Clean verdict',
            highlights: [],
            riskNotes: [],
            diligence: [],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: 'Done.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const store = new CareerStore({ file: join(dir, 'career-broker', 'career.json') })
  await store.setMode('observe')
  await store.authorizeSource({ id: 'dsh-session', projects: ['synthetic'] })
  const ingested = await store.ingestEvents([{
    id: 'turn-1',
    sourceId: 'dsh-session',
    projectId: 'synthetic',
    kind: 'work',
    occurredAt: '2026-11-21T03:00:00.000Z',
    evidence: [
      { title: 'Private win', text: `Built ${privMark}`, confidentiality: 'private' },
      { title: 'Pending win', text: `Pending ${pendMark}` },
      { title: 'Shareable win', text: `Delivered ${shareMark} with 45% better availability.` },
    ],
  }])
  await store.reviewEvidence(ingested.evidence[0].id, { action: 'approve', shareable: false })
  // Leave evidence[1] pending!
  await store.reviewEvidence(ingested.evidence[2].id, { action: 'approve', shareable: true })

  let host = await createHost({ dir, llm })
  t.after(() => host?.close())

  const jobRes = await host.action('job-add', {
    job: { company: 'Synthetic Inc', title: 'Staff Engineer', location: 'Shanghai', jd: 'Operate GPU serving, C++, Python and CUDA.' },
  })
  const jobId = jobRes.json.result.id

  // 1. Mode is paused (off), even with sendToModel=true & autoJobIntel=true -> auto job-intel MUST NOT call model!
  await host.action('configure', { config: { mode: 'off', model: 'fixture:mock', sendToModel: true, autoJobIntel: true } })
  const autoRes = await host.action('job-intel', { id: jobId, auto: true })
  assert.equal(autoRes.status, 200)
  assert.equal(autoRes.json.result, null)
  assert.equal(seenPrompts.length, 0, 'paused auto job-intel must make 0 LLM calls')

  // 2. Manual job-intel MUST ONLY send approved+shareable evidence (NEVER private or pending!)
  const manualIntel = await host.action('job-intel', { id: jobId })
  assert.equal(manualIntel.status, 200)
  assert.equal(seenPrompts.length, 1)
  assert.equal(seenPrompts[0].includes(privMark), false, 'private evidence must never be sent to model')
  assert.equal(seenPrompts[0].includes(pendMark), false, 'pending evidence must never be sent to model')
  assert.equal(seenPrompts[0].includes(shareMark), true, 'approved shareable evidence is allowed')
  assert.ok(manualIntel.json.result.verdict.includes(shareMark))

  // 3. Independent master + resume-chat merges shareable evidence -> approve -> forgetSource -> restart!
  const baseText = '# Alex Synthetic\n\n## Experience\n- Built GPU infrastructure at Test Inc.'
  const imp = await host.action('resume-import', { title: 'Independent Master', text: baseText })
  const masterId = imp.json.result.id
  await host.action('resume-review', { id: masterId, decision: 'approve' })

  const chat = await host.request('POST', '/career-agent/resume-chat', {
    markdown: baseText,
    message: 'Merge the new approved evidence into my resume',
    model: 'fixture:mock',
    locale: 'en',
  })
  const chatUpdate = chat.raw.trim().split('\n').map(l => JSON.parse(l)).find(e => e.type === 'resume-update')
  assert.ok(chatUpdate?.markdown?.includes(shareMark))
  // Simulate direct caller NOT passing evidenceIds in resume-revise (exact chat-provenance-probe pattern!)
  const revised = await host.action('resume-revise', { id: masterId, text: chatUpdate.markdown, autoSaved: true, variant: 'conversation' })
  assert.equal(revised.status, 200)
  const revisedId = revised.json.result.id
  await host.action('resume-review', { id: revisedId, decision: 'approve' })

  // Forget & erase dsh-session
  const forgot = await host.action('forget', { source: 'dsh-session', erase: true })
  assert.equal(forgot.status, 200)

  // Restart host cleanly from disk
  await host.close()
  host = await createHost({ dir, llm })

  const after = await host.request('GET', '/career-agent/state')
  assert.equal(JSON.stringify(after.json).includes(shareMark), false, 'erased source fingerprint must not remain in state/intel/resumes after restart')
  assert.equal(after.json.opportunities.find(j => j.id === jobId)?.intel, null, 'stale intel citing forgotten source must be purged')

  // Derived chat resume cannot be exported or local-previewed, while original independent master stays readable!
  const expDerived = await host.action('export', { id: revisedId })
  assert.equal(expDerived.status, 400, 'derived resume must not be exportable after forget + restart')
  const previewDerived = await host.request('POST', '/career-agent/local-preview', { id: revisedId, text: 'cached stale text' })
  assert.equal(previewDerived.status, 400, 'local-preview must block revoked/erased resume id even when stale text is supplied')
  const expMaster = await host.action('export', { id: masterId })
  assert.equal(expMaster.status, 200)
  assert.equal(expMaster.json.result.text.trim(), baseText)
})

test('Batch 1.1b: work recordings respect watchSessions=false and recording sources support forget/erase even when offline', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-b1-rec-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let reads = 0
  let modelSaw = false
  const marker = 'SYNTHETIC_RECORDING_71128'
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ messages }) {
      if (JSON.stringify(messages).includes(marker)) modelSaw = true
      yield { type: 'text-delta', text: '{"records":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const host = await createHost({ dir, llm })
  t.after(() => host.close())

  const rec = host.broker.registerTranscriptSource({
    id: 'fixture-recorder',
    name: 'Synthetic Recorder',
    kinds: ['work'],
    async readTranscript() {
      reads += 1
      return { segments: [{ speaker: 'candidate', text: `I built ${marker}` }] }
    },
  })

  await host.action('configure', { config: { mode: 'search', watchSessions: false, sendToModel: true, model: 'fixture:mock' } })
  await host.action('recording-source', { id: 'fixture-recorder', enabled: true })
  const pub = await rec.publish({ recordingId: 'synthetic1', kind: 'work', occurredAt: new Date().toISOString() })
  assert.equal(pub.status, 'queued')

  const runRes = await host.action('run')
  assert.equal(runRes.status, 200)
  assert.equal(reads, 0, 'watchSessions=false must not read work recording transcript')
  assert.equal(modelSaw, false, 'watchSessions=false must not send work recording transcript to LLM')

  // Disconnect recording source (goes offline) and verify forget/erase still succeeds!
  rec.dispose()
  const forgetRec = await host.action('forget', { source: 'recording:fixture-recorder', erase: true })
  assert.equal(forgetRec.status, 200)
  const st = await host.request('GET', '/career-agent/state')
  assert.equal((st.json.recordings?.work ?? []).length, 0)

  // Dual-kind (work + interview) recording source with watchSessions=false MUST still backfill interview history
  // while NOT queuing or reading work recordings!
  const nowIso = new Date().toISOString()
  let dualReads = 0
  const dualRec = host.broker.registerTranscriptSource({
    id: 'feishu-bean',
    name: 'Feishu Recording Bean',
    kinds: ['work', 'interview'],
    async listRecordings() {
      return [
        { recordingId: 'w-hist-1', kind: 'work', title: 'Daily Standup', occurredAt: nowIso },
        { recordingId: 'iv-hist-1', kind: 'interview', title: 'Tencent Round 1', occurredAt: nowIso },
      ]
    },
    async readTranscript() {
      dualReads += 1
      return { segments: [{ speaker: 'candidate', text: 'Discussed GPU scheduling' }] }
    },
  })
  t.after(() => dualRec.dispose())
  await host.action('recording-source', { id: 'feishu-bean', enabled: true })
  await host.action('run')
  const stDual = await host.request('GET', '/career-agent/state')
  const feishuSource = (stDual.json.recordings?.sources ?? []).find(s => s.id === 'feishu-bean')
  assert.equal(dualReads, 0, 'watchSessions=false must not auto-read work transcript from dual-kind source')
  assert.equal((stDual.json.recordings?.interviews ?? []).some(r => r.title === 'Tencent Round 1'), true, 'interview history must still be backfilled when watchSessions=false')
  assert.equal(feishuSource?.pendingWork, 0, 'work recordings must not be queued while watchSessions=false')
})

test('Batch 1.2: tailor-resume rejects fabricated numbers & unsolicited translation while allowing legal unit conversions & valid rewrites', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-b1-fact-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Unit check: legal unit equivalence passes, invented metrics fail, unsolicited translation fails
  assert.equal(validateResumeEditLine({
    original: 'Reduced latency from 2500ms to 1000ms across 10,000 nodes.',
    rewritten: 'Reduced latency from 2.5s to 1s across 10k nodes.',
    resumeLang: 'en',
    locale: 'en',
  }).ok, true, 'legal unit equivalents (2500ms->2.5s, 1000ms->1s, 10,000->10k) must pass')

  assert.equal(validateResumeEditLine({
    original: 'Maintained an internal job scheduler and improved availability.',
    rewritten: 'Reduced cost by 73%, supported 250 engineers, and reached 99.999% availability.',
    resumeLang: 'en',
    locale: 'en',
  }).ok, false, 'fabricated metrics must be rejected')

  assert.equal(validateResumeEditLine({
    original: 'Maintained an internal job scheduler and improved availability.',
    rewritten: '维护内部任务调度器并改善可用性。',
    resumeLang: 'en',
    allowTranslation: false,
    locale: 'en',
  }).ok, false, 'unsolicited Chinese translation on English resume must be rejected')

  assert.equal(validateResumeEditLine({
    original: 'Maintained an internal job scheduler and improved availability.',
    rewritten: '维护内部任务调度器并改善可用性。',
    resumeLang: 'en',
    allowTranslation: true,
    locale: 'en',
  }).ok, true, 'explicit translation must be permitted')

  // End-to-end HTTP route test on `action: 'tailor-resume'`
  const trustedMaster = '# Alex Synthetic\n\n## Experience\n- Maintained an internal job scheduler and improved availability.\n- Wrote operational documentation.'
  const model = {
    output: '',
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ messages }) {
      const payload = JSON.parse(messages.at(-1).content[0].text)
      const original = payload.bullets.find(b => b.original.includes('Maintained an internal job scheduler'))
      const text = JSON.stringify({
        lines: [{ index: original.index, text: this.output, reason: 'Emphasizes reliability.' }],
        gaps: '',
      })
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const host = await createHost({ dir, llm: model })
  t.after(() => host.close())

  await host.action('configure', { config: { mode: 'off', model: 'fixture:testing', sendToModel: true, autoJobIntel: false } })
  const imp = await host.action('resume-import', { title: 'Synthetic English Master', text: trustedMaster })
  const parentId = imp.json.result.id
  await host.action('resume-review', { id: parentId, decision: 'approve' })

  const jobRes = await host.action('job-add', {
    job: { company: 'Synthetic Cloud', title: 'Staff Infra', jd: 'Maintain reliable job scheduler.' },
  })
  const jobId = jobRes.json.result.id

  // 1. Fabricated metrics -> rejected (400), NOT persisted!
  model.output = 'Reduced cost by 73%, supported 250 engineers, and reached 99.999% availability.'
  const factRes = await host.action('tailor-resume', { id: jobId, resumeId: parentId, model: 'fixture:testing' }, { 'x-career-locale': 'en' })
  assert.equal(factRes.status, 400)
  assert.equal(/[\u4e00-\u9fff]/.test(factRes.json.error), false, `expected English error, got: ${factRes.json.error}`)

  // 2. Unsolicited translation -> rejected (400), NOT persisted!
  model.output = '维护内部任务调度器并改善可用性。'
  const langRes = await host.action('tailor-resume', { id: jobId, resumeId: parentId, model: 'fixture:testing' }, { 'x-career-locale': 'en' })
  assert.equal(langRes.status, 400)

  // 3. Valid English rewrite -> accepted (200) & persisted!
  model.output = 'Improved the availability of an internal job scheduler through proactive maintenance.'
  const okRes = await host.action('tailor-resume', { id: jobId, resumeId: parentId, model: 'fixture:testing' }, { 'x-career-locale': 'en' })
  assert.equal(okRes.status, 200)
  assert.ok(okRes.json.result.text.includes(model.output))
})

test('Batch 1.3 & 1.4: DST gap/ambiguous detection, FollowUps bilingual/distinct rounds & DST tomorrow, ICS stable UID, and receipt materialId binding + amendment', async t => {
  // DST spring-forward gap: America/New_York 2027-03-14 02:30 does not exist -> flagged nonexistent & shifts forward to 03:30 (NEVER 01:30!)
  const gap = inspectZonedLocalTime('2027-03-14T02:30', 'America/New_York')
  assert.equal(gap.status, 'nonexistent')
  assert.equal(gap.suggestedLocal, '2027-03-14T03:30')
  assert.equal(zonedLocalToIso('2027-03-14T02:30', 'America/New_York'), gap.suggestedIso)

  // DST fall-back repeated hour: America/New_York 2026-11-01 01:30 occurs twice (EDT and EST)
  const amb = inspectZonedLocalTime('2026-11-01T01:30', 'America/New_York')
  assert.equal(amb.status, 'ambiguous')
  assert.equal(amb.options.length, 2)
  assert.notEqual(amb.options[0].iso, amb.options[1].iso)
  assert.equal(zonedLocalToIso('2026-11-01T01:30', 'America/New_York', { disambiguation: 'earlier' }), amb.options[0].iso)
  assert.equal(zonedLocalToIso('2026-11-01T01:30', 'America/New_York', { disambiguation: 'later' }), amb.options[1].iso)

  // DST-safe calendar-day delta (America/Los_Angeles spring-forward 2027-03-14):
  // 2027-03-14T07:30:00Z is Mar 13 23:30 PST!
  // -> Mar 14 13:00 PDT (2027-03-14T20:00:00Z) is Tomorrow (delta 1, even though < 24h!)
  // -> Mar 15 13:00 PDT (2027-03-15T20:00:00Z) is Day after tomorrow (delta 2 — old +86400s bug mislabeled it as Tomorrow!)
  assert.equal(zonedCalendarDayDelta(Date.parse('2027-03-14T20:00:00Z'), Date.parse('2027-03-14T07:30:00Z'), 'America/Los_Angeles'), 1)
  assert.equal(zonedCalendarDayDelta(Date.parse('2027-03-15T20:00:00Z'), Date.parse('2027-03-14T07:30:00Z'), 'America/Los_Angeles'), 2)

  // FollowUps.jsx self-contained logic: 一面 invite + Round 1 confirm -> 1 interview (no reply reminder), AND synced badge matches across languages!
  const fuText = await readFile(new URL('../client/FollowUps.jsx', import.meta.url), 'utf8')
  const from = fuText.indexOf('const closedStages')
  const to = fuText.indexOf('export default function FollowUps')
  const { followUps, formatDateParts, matchingSyncBadges } = runInNewContext(
    fuText.slice(from, to) + '\n;({ followUps, formatDateParts, matchingSyncBadges })',
  )
  const tFn = key => key
  const opp = {
    id: 'opp-fu',
    company: 'Fixture Cloud',
    title: 'Staff Engineer',
    stage: 'interview_confirmed',
    receipts: [
      { id: 'i1', opportunityId: 'opp-fu', type: 'interview_invited', round: '一面', source: 'manual', confirmed: true, evidence: 'Invite', occurredAt: '2026-11-21T01:00:00Z' },
      { id: 'c1', opportunityId: 'opp-fu', type: 'interview_confirmed', round: 'Round 1', source: 'manual', confirmed: true, evidence: 'Confirm', occurredAt: '2026-11-21T02:00:00Z', startsAt: '2026-11-23T06:00:00Z', endsAt: '2026-11-23T07:00:00Z' },
      { id: 'c2', opportunityId: 'opp-fu', type: 'interview_confirmed', round: '技术一面', source: 'manual', confirmed: true, evidence: 'Tech', occurredAt: '2026-11-21T03:00:00Z', startsAt: '2026-11-24T06:00:00Z', endsAt: '2026-11-24T07:00:00Z' },
      { id: 'c3', opportunityId: 'opp-fu', type: 'interview_confirmed', round: '业务一面', source: 'manual', confirmed: true, evidence: 'Biz', occurredAt: '2026-11-21T04:00:00Z', startsAt: '2026-11-24T09:00:00Z', endsAt: '2026-11-24T10:00:00Z' },
    ],
  }
  const rows = followUps([opp], Date.parse('2026-11-22T21:00:00Z'), tFn)
  assert.deepEqual(Array.from(rows, r => r.kind), ['interview', 'interview', 'interview'], '一面+Round 1 merged, 技术一面 & 业务一面 kept separate')
  const badges = matchingSyncBadges(rows[0], { items: { s1: { opportunityId: 'opp-fu', kind: 'interview', round: '一面', verified: true, destination: 'calendar' } } }, { calendar: 'Test' })
  assert.equal(badges[0].verified, true, 'sync badge matches across 一面 / Round 1 language change')
  const dstTom = formatDateParts(Date.parse('2027-03-14T20:00:00Z'), 'America/Los_Angeles', Date.parse('2027-03-14T07:30:00Z'), { bcp47: 'en-US', isZh: false, t: tFn })
  assert.equal(dstTom.rel, 'followups.tomorrowAt')
  const dstAfterTom = formatDateParts(Date.parse('2027-03-15T20:00:00Z'), 'America/Los_Angeles', Date.parse('2027-03-14T07:30:00Z'), { bcp47: 'en-US', isZh: false, t: tFn })
  assert.equal(dstAfterTom.rel, 'followups.afterTomorrowAt')

  // ICS stable UID across reschedules
  const ics1 = createInterviewIcs(opp.receipts[1], opp, { sequence: 0 })
  const ics2 = createInterviewIcs({ ...opp.receipts[1], id: 'c1-resched', round: '一面', startsAt: '2026-11-25T06:00:00Z', endsAt: '2026-11-25T07:00:00Z' }, opp, { sequence: 1 })
  const uid1 = ics1.match(/^UID:(.+)$/m)?.[1]
  const uid2 = ics2.match(/^UID:(.+)$/m)?.[1]
  assert.ok(uid1 && uid1 === uid2, 'rescheduled ICS must reuse stable UID')
  assert.match(ics2, /^SEQUENCE:1$/m)

  // Receipt materialId binding, pending draft rejection, idempotent double-click, and correction/amendment!
  const dir = await mkdtemp(join(tmpdir(), 'niuma-b1-receipt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const host = await createHost({ dir, llm: { listProviders: () => [], async *stream() {} } })
  t.after(() => host.close())

  const job = (await host.action('job-add', { job: { company: 'Fixture Cloud', title: 'Staff Engineer', url: 'https://example.com/jobs/staff' } })).json.result
  const pending = (await host.action('resume-import', { title: 'Engineering Master', text: '# Alex\n\n## Experience\n- v1 work' })).json.result

  // Pending resume cannot be submitted via materialId
  const badSub = await host.action('receipt', {
    receipt: {
      id: 'r-pending',
      opportunityId: job.id,
      type: 'application_submitted',
      source: 'manual',
      occurredAt: '2026-11-21T01:00:00Z',
      confirmed: true,
      evidence: 'Attempt pending',
      material: 'Engineering Master v1',
      materialId: pending.id,
    },
  })
  assert.equal(badSub.status, 400, 'pending resume must be rejected for submission binding')

  // Approve v1, create & approve v2
  await host.action('resume-review', { id: pending.id, decision: 'approve' })
  const v2 = (await host.action('resume-revise', { id: pending.id, text: '# Alex\n\n## Experience\n- v2 work', approve: true })).json.result

  // Submit v1
  const sub1 = await host.action('receipt', {
    receipt: {
      id: 'r-orig',
      opportunityId: job.id,
      type: 'application_submitted',
      source: 'manual',
      occurredAt: '2026-11-21T01:00:00Z',
      confirmed: true,
      evidence: 'Submitted v1',
      material: 'Engineering Master v1',
      materialId: pending.id,
      materialVersion: 'v1',
    },
  })
  assert.equal(sub1.status, 200)
  assert.equal(sub1.json.result.materialId, pending.id)

  // Identical double-click -> idempotent!
  const dup = await host.action('receipt', {
    receipt: {
      id: 'r-dup',
      opportunityId: job.id,
      type: 'application_submitted',
      source: 'manual',
      occurredAt: '2026-11-21T01:01:00Z',
      confirmed: true,
      evidence: 'Submitted v1',
      material: 'Engineering Master v1',
      materialId: pending.id,
      materialVersion: 'v1',
    },
  })
  assert.equal(dup.json.result.id, sub1.json.result.id)
  assert.equal(dup.json.result.amendments, undefined)

  // Correct to v2 + notes -> updates in place with traceable amendment history!
  const amended = await host.action('receipt', {
    receipt: {
      id: 'r-corr',
      opportunityId: job.id,
      type: 'application_submitted',
      source: 'manual',
      occurredAt: '2026-11-21T01:10:00Z',
      confirmed: true,
      evidence: 'Submitted v1',
      material: 'Engineering Master v2',
      materialId: v2.id,
      materialVersion: 'v2',
      notes: 'Correcting which file was uploaded',
    },
  })
  assert.equal(amended.status, 200)
  assert.equal(amended.json.result.id, sub1.json.result.id)
  assert.equal(amended.json.result.material, 'Engineering Master v2')
  assert.equal(amended.json.result.materialId, v2.id)
  assert.equal(amended.json.result.notes, 'Correcting which file was uploaded')
  assert.equal(amended.json.result.amendments?.length, 1)
  assert.equal(amended.json.result.amendments[0].materialId, pending.id)

  // Read back state and confirm persisted!
  const st = await host.request('GET', '/career-agent/state')
  const savedRec = st.json.opportunities.find(o => o.id === job.id).receipts.find(r => r.id === sub1.json.result.id)
  assert.equal(savedRec.materialId, v2.id)
  assert.equal(savedRec.notes, 'Correcting which file was uploaded')
})
