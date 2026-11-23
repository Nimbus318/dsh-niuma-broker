import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { CareerStore } from '../src/career.mjs'
import { apply, hasCompensationSignal, personalScheduleItems } from '../src/host.mjs'
import { buildPatrolSearchProfile, triageBatchWithLlm } from '../src/job-triage.mjs'
import { renderLocalResumePdf } from '../src/local-pdf.mjs'
import { localResumeTemplates, renderLocalResume } from '../src/local-templates.mjs'
import { canonicalInterviewRoundKey } from '../src/opportunities.mjs'
import { streamResumeAgentTurn } from '../src/resume-agent.mjs'
import { mergeEvidenceIntoResume } from '../src/resume-merge.mjs'
import { parseStyleDirective, templateDisplayName } from '../src/resume-style.mjs'
import { buildZonedQuickSlot, toZonedDatetimeInput, zonedLocalToIso } from '../src/timezone.mjs'

async function createMockHost({ dir, llm }) {
  let route
  let dispose
  const ctx = {
    profileContext: { dir },
    webServer: { register(value) { route = value; return () => {} } },
    connection: { requestRejection() { return false } },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm,
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
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
    let headers = {}
    const chunks = []
    const res = {
      writableEnded: false,
      destroyed: false,
      writeHead(code, hdrs = {}) {
        status = code
        headers = hdrs
        return res
      },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        return true
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        res.writableEnded = true
      },
    }
    await route.handler(req, res)
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed = null
    try { parsed = JSON.parse(raw) } catch {}
    return { status, headers, raw, json: parsed }
  }

  async function close() {
    if (typeof dispose === 'function') await dispose()
  }

  return { request, close }
}

test('Release Gate 1: zero unauthorized LLM calls when sendToModel=false across state, locale switch, parse, suggest, triage, legacy cache & auto-intel', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-gate1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let llmCalls = 0
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      llmCalls += 1
      yield { type: 'text-delta', text: '{"items":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    prepareCall: async () => {
      llmCalls += 1
      return {
        model: { provider: 'mock', id: 'fast' },
        async *stream() {
          yield { type: 'text-delta', text: '{"items":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }

  const host = await createMockHost({ dir, llm })
  t.after(() => host.close())

  // Explicitly ensure paused mode, sendToModel=false, autoJobIntel=false
  const cfgRes = await host.request('POST', '/career-agent/action', {
    action: 'configure',
    config: { mode: 'off', sendToModel: false, autoJobIntel: false, model: 'mock:fast', locale: 'zh' },
  })
  assert.equal(cfgRes.status, 200)

  // Import and approve a resume with synthetic contact info
  const impRes = await host.request('POST', '/career-agent/action', {
    action: 'resume-import',
    title: 'Synthetic Master',
    text: '# Alex Synthetic\n13900001234 | alex.synthetic@example.test\n\n## Experience\n- Built vLLM GPU inference clusters with 99.95% availability',
  })
  assert.equal(impRes.status, 200)
  const resumeId = impRes.json.result.id
  await host.request('POST', '/career-agent/action', { action: 'resume-review', id: resumeId, decision: 'approve' })

  // Add a matching job
  const addRes = await host.request('POST', '/career-agent/action', {
    action: 'job-add',
    job: {
      company: 'MiniMax',
      title: 'Senior AI Infra Engineer',
      location: 'Shanghai',
      jd: 'Build high-throughput vLLM and CUDA GPU inference serving clusters.',
    },
  })
  assert.equal(addRes.status, 200)
  const jobId = addRes.json.result.id

  // 1. Open state page in Chinese
  const stateZh = await host.request('GET', '/career-agent/state', null, { 'x-career-locale': 'zh' })
  assert.equal(stateZh.status, 200)
  assert.equal(llmCalls, 0, 'opening state in zh must not call LLM')

  // 2. Switch UI language to English and reload state
  const switchEn = await host.request('POST', '/career-agent/action', {
    action: 'configure',
    config: { locale: 'en' },
  })
  assert.equal(switchEn.status, 200)
  const stateEn = await host.request('GET', '/career-agent/state', null, { 'x-career-locale': 'en' })
  assert.equal(stateEn.status, 200)
  assert.equal(llmCalls, 0, 'switching locale and loading state in en must not call LLM')

  // Verify English view shows English reason (never raw Chinese fallback) while keeping score
  const jobEn = stateEn.json.opportunities.find(o => o.id === jobId)
  assert.ok(jobEn?.match?.reason, 'opportunity has match reason')
  assert.equal(/[\u4e00-\u9fff]/.test(jobEn.match.reason), false, `expected English match reason, got: ${jobEn.match.reason}`)

  // 3. Parse resume file without sendToModel
  const parseRes = await host.request('POST', '/career-agent/parse-resume-file', {
    filename: 'plain.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('Alex Synthetic\nProfessional Experience\nAcme Corp - Staff Engineer\nBuilt GPU inference pipelines.').toString('base64'),
  }, { 'x-career-locale': 'en' })
  assert.equal(parseRes.status, 200)
  assert.equal(parseRes.json.result.structuredByAi, false)
  assert.equal(llmCalls, 0, 'parse-resume-file must not call LLM when sendToModel=false')

  // 4. Autocomplete /suggest
  const sugRes = await host.request('POST', '/career-agent/suggest', {
    surface: 'resume',
    prefix: 'Tighten',
    markdown: '# Alex Synthetic\n13900001234',
  })
  assert.equal(sugRes.status, 200)
  assert.equal(sugRes.json.suggestion, '')
  assert.equal(llmCalls, 0, '/suggest must not call LLM when sendToModel=false')

  // 5. Discovery directions
  const dirRes = await host.request('POST', '/career-agent/suggest-directions', { goal: 'AI Infra' })
  assert.equal(dirRes.status, 200)
  assert.equal(llmCalls, 0, '/suggest-directions must not call LLM when sendToModel=false')

  // 6. Auto job-intel
  const autoIntel = await host.request('POST', '/career-agent/action', {
    action: 'job-intel',
    id: jobId,
    auto: true,
  })
  assert.equal(autoIntel.status, 200)
  assert.equal(autoIntel.json.result, null)
  assert.equal(llmCalls, 0, 'auto job-intel must not call LLM when sendToModel=false')

  // 7. Manual run (tick)
  const tickRes = await host.request('POST', '/career-agent/action', { action: 'run' })
  assert.equal(tickRes.status, 200)
  assert.equal(llmCalls, 0, 'run/tick must not call LLM when sendToModel=false')

  // 8. Ingest & approve shareable evidence (triggers generateResume locally without LLM)
  const ingRes = await host.request('POST', '/career-agent/action', {
    action: 'ingest',
    event: {
      id: 'ev-manual-1',
      sourceId: 'manual',
      projectId: 'personal',
      kind: 'manual',
      occurredAt: '2026-11-21T04:00:00.000Z',
      evidence: [{ title: 'Cut inference latency', text: 'Cut P99 serving latency by 41% across 256 GPUs.' }],
    },
  })
  assert.equal(ingRes.status, 200)
  const evId = ingRes.json.result.evidence[0].id
  const revRes = await host.request('POST', '/career-agent/action', {
    action: 'review',
    id: evId,
    decision: 'approve',
    shareable: true,
  })
  assert.equal(revRes.status, 200)
  assert.equal(llmCalls, 0, 'evidence review + resume merge must not call LLM when sendToModel=false')

  // 9. English route validation error returns English message (no Chinese leaked)
  const badPreview = await host.request('POST', '/career-agent/local-preview', { text: '' }, { 'x-career-locale': 'en' })
  assert.equal(badPreview.status, 400)
  assert.equal(/[\u4e00-\u9fff]/.test(badPreview.json?.error || ''), false, `expected English error, got: ${badPreview.json?.error}`)

  // 10. Direct triageBatchWithLlm with sendToModel=false
  const profile = buildPatrolSearchProfile({ resumeText: 'vLLM GPU CUDA', goal: 'AI Infra' })
  const batch = await triageBatchWithLlm({
    llm,
    config: { model: 'mock:fast', sendToModel: false },
    profile,
    resumeText: 'vLLM GPU CUDA',
    jobs: [{ id: 'x1', company: 'Test', title: 'AI Infra Engineer', jd: 'vLLM GPU' }],
  })
  assert.equal(batch[0].mode, 'heuristic')
  assert.equal(llmCalls, 0, 'triageBatchWithLlm must never call LLM when sendToModel=false')
})

test('Release Gate 1b: legacy pre-v0.22 cached Chinese jobMatches show localized English reason while keeping cached score with 0 LLM calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-gate1b-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let llmCalls = 0
  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() { llmCalls += 1 },
    prepareCall: async () => { llmCalls += 1; throw new Error('must not call llm') },
  }

  // First boot host to create a job and get its profile fingerprint
  const host1 = await createMockHost({ dir, llm })
  await host1.request('POST', '/career-agent/action', {
    action: 'configure',
    config: { mode: 'off', sendToModel: false, autoJobIntel: false, model: 'mock:fast', locale: 'en' },
  })
  const imp = await host1.request('POST', '/career-agent/action', {
    action: 'resume-import',
    title: 'Master',
    text: '# Alex\n\n## Experience\n- Built vLLM CUDA GPU clusters.',
  })
  await host1.request('POST', '/career-agent/action', { action: 'resume-review', id: imp.json.result.id, decision: 'approve' })
  const added = await host1.request('POST', '/career-agent/action', {
    action: 'job-add',
    job: {
      company: 'MiniMax',
      title: 'AI Infra Engineer',
      location: 'Shanghai',
      jd: 'vLLM GPU CUDA serving infrastructure',
    },
  })
  const jobId = added.json.result.id
  const s1 = await host1.request('GET', '/career-agent/state', null, { 'x-career-locale': 'en' })
  const fp = s1.json.triageSummary.fingerprint
  await host1.close()

  // Inject a legacy pre-v0.22 Chinese LLM cache entry (no `locale` property, Chinese reason, score 91)
  const controlPath = join(dir, 'career-broker', 'watchdog.json')
  const { readFile } = await import('node:fs/promises')
  const ctrl = JSON.parse(await readFile(controlPath, 'utf8'))
  ctrl.jobMatches = {
    [jobId]: {
      opportunityId: jobId,
      score: 91,
      tier: 'top',
      reason: '和你千卡 GPU 推理集群经验高度匹配',
      caution: '需确认团队规模',
      mode: 'llm',
      fingerprint: fp,
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  }
  await writeFile(controlPath, JSON.stringify(ctrl, null, 2))

  // Reboot host in English and verify cached score=91 / tier=top is preserved while Chinese reason is NOT leaked!
  const host2 = await createMockHost({ dir, llm })
  t.after(() => host2.close())
  const s2 = await host2.request('GET', '/career-agent/state', null, { 'x-career-locale': 'en' })
  const opp = s2.json.opportunities.find(o => o.id === jobId)
  assert.equal(opp.match.score, 91, 'cached score preserved')
  assert.equal(opp.match.tier, 'top', 'cached tier preserved')
  assert.equal(/[\u4e00-\u9fff]/.test(opp.match.reason), false, `legacy Chinese reason must not leak into English view: ${opp.match.reason}`)
  assert.equal(/[\u4e00-\u9fff]/.test(opp.match.caution || ''), false)
  assert.equal(llmCalls, 0, 'legacy cache localization must make 0 LLM calls')
})

test('Release Gate 2: forgetSource erases derived text across copy/archive/restore and parent deletion even after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-gate2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fileA = join(dir, 'career-a.json')

  // --- Path A: copy master -> archive -> restore -> forgetSource -> restart ---
  {
    const store = new CareerStore({ file: fileA, now: () => new Date('2026-11-21T04:00:00.000Z') })
    await store.setMode('observe')
    await store.authorizeSource({ id: 'dsh-session', projects: ['work'] })
    const { evidence: [ev] } = await store.ingestEvents([{
      id: 'ev-a1',
      sourceId: 'dsh-session',
      projectId: 'work',
      kind: 'work',
      occurredAt: '2026-11-21T03:00:00.000Z',
      sourceRef: 'session:work#1',
      evidence: [{
        title: 'Project 9911',
        text: 'Built SECRET_SYNTHETIC_PROJECT_9911 achieving 3x throughput.',
        role: 'Tech Lead',
        impact: '3x throughput',
      }],
    }])
    await store.reviewEvidence(ev.id, { action: 'approve', shareable: true })
    const gen = await store.proposeResume({
      title: 'Generated Master',
      items: [{ text: ev.text, evidenceIds: [ev.id] }],
      mergedText: '# Alex\n\n## Experience\n- Built SECRET_SYNTHETIC_PROJECT_9911 achieving 3x throughput.',
    })
    await store.reviewResume(gen.id, { action: 'approve' })

    const copied = await store.branchMasterResume(gen.id, 'Copied Master')
    assert.equal(copied.status, 'approved')

    await store.archiveResume({ id: copied.id, scope: 'version' })
    await store.restoreResume({ id: copied.id, scope: 'version' })

    await store.forgetSource('dsh-session')

    // Simulate full restart with fresh CareerStore reading from disk
    const restarted = new CareerStore({ file: fileA, now: () => new Date('2026-11-21T05:00:00.000Z') })
    const summary = await restarted.summary()
    assert.equal(JSON.stringify(summary).includes('SECRET_SYNTHETIC_PROJECT_9911'), false, 'copied master text must be absent after forget + restart')
    const copiedRow = summary.resumes.find(r => r.id === copied.id)
    assert.equal(copiedRow, undefined, 'copied master must be completely erased on forgetSource')
    await assert.rejects(() => restarted.exportResume(copied.id))
    await assert.rejects(() => restarted.restoreResume({ id: copied.id }))
  }

  // --- Path B: tailor branch -> archive master -> deleteArchivedResume(master) -> forgetSource -> restart ---
  const fileB = join(dir, 'career-b.json')
  {
    const store = new CareerStore({ file: fileB, now: () => new Date('2026-11-21T04:00:00.000Z') })
    await store.setMode('observe')
    await store.authorizeSource({ id: 'dsh-session', projects: ['work'] })
    const { evidence: [ev] } = await store.ingestEvents([{
      id: 'ev-b1',
      sourceId: 'dsh-session',
      projectId: 'work',
      kind: 'work',
      occurredAt: '2026-11-21T03:00:00.000Z',
      sourceRef: 'session:work#2',
      evidence: [{
        title: 'Cost Reduction 7722',
        text: 'Delivered SECRET_SYNTHETIC_METRIC_7722 reducing cost by 45%.',
        role: 'Staff Engineer',
        impact: '-45% cost',
      }],
    }])
    await store.reviewEvidence(ev.id, { action: 'approve', shareable: true })
    const gen = await store.proposeResume({
      title: 'Evidence Master',
      items: [{ text: ev.text, evidenceIds: [ev.id] }],
      mergedText: '# Alex\n\n## Experience\n- Delivered SECRET_SYNTHETIC_METRIC_7722 reducing cost by 45%.',
    })
    await store.reviewResume(gen.id, { action: 'approve' })

    // Add an independent second master so we can archive & permanently delete the first master
    const otherMaster = await store.importResume({ title: 'Clean Backup Master', text: '# Alex\n\n## Summary\nIndependent clean bio.' })
    await store.reviewResume(otherMaster.id, { action: 'approve' })

    // Create tailored branch from evidence-backed master
    const tailored = await store.proposeTailoredResume({
      baseId: gen.id,
      opportunityId: 'job-b1',
      title: 'Tailored for Job B1',
      lines: [{
        source: '- Delivered SECRET_SYNTHETIC_METRIC_7722 reducing cost by 45%.',
        text: 'Delivered SECRET_SYNTHETIC_METRIC_7722 cutting inference cost by 45%.',
      }],
      gaps: '',
    })
    await store.reviewResume(tailored.id, { action: 'approve' })

    // Archive and permanently delete the parent master
    await store.archiveResume({ id: gen.id, scope: 'version' })
    await store.deleteArchivedResume(gen.id)

    // Forget the source
    await store.forgetSource('dsh-session')

    // Reload from disk (simulate restart)
    const restarted = new CareerStore({ file: fileB, now: () => new Date('2026-11-21T05:00:00.000Z') })
    const summary = await restarted.summary()
    assert.equal(JSON.stringify(summary).includes('SECRET_SYNTHETIC_METRIC_7722'), false, 'tailored branch must lose forgotten source material after parent deletion + restart')
    const tailoredRow = summary.resumes.find(r => r.id === tailored.id)
    assert.equal(tailoredRow, undefined, 'tailored branch must be completely erased on forgetSource even after parent deletion')
    await assert.rejects(() => restarted.exportResume(tailored.id))
  }
})

test('Release Gate 3: switching UI language never aborts or rejects an in-flight tailor operation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'career-gate3-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let notifyStarted
  const llmStarted = new Promise(resolve => { notifyStarted = resolve })
  let resolveGate
  const gate = new Promise(resolve => { resolveGate = resolve })

  const llm = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      notifyStarted()
      await gate
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify({
            text: '# Alex Chen\n\n## Experience\n- Led distributed vLLM inference clusters at scale (99.95% SLA).',
            fit: 'Strong distributed systems match.',
            gaps: 'Highlight multi-region failover.',
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const host = await createMockHost({ dir, llm })
  t.after(() => host.close())

  await host.request('POST', '/career-agent/action', {
    action: 'configure',
    config: { mode: 'off', sendToModel: true, model: 'mock:slow', locale: 'zh' },
  })
  const imp = await host.request('POST', '/career-agent/action', {
    action: 'resume-import',
    title: 'Master EN',
    text: '# Alex Chen\n\n## Experience\n- Led distributed vLLM inference clusters at scale.',
  })
  await host.request('POST', '/career-agent/action', { action: 'resume-review', id: imp.json.result.id, decision: 'approve' })
  const job = await host.request('POST', '/career-agent/action', {
    action: 'job-add',
    job: {
      company: 'OpenAI',
      title: 'Staff Inference Engineer',
      jd: 'Design distributed GPU inference infrastructure.',
    },
  })

  // Start slow tailor request
  const tailorPromise = host.request('POST', '/career-agent/action', {
    action: 'tailor',
    id: job.json.result.id,
    model: 'mock:slow',
  })

  await llmStarted

  // While tailor is actively running, switch UI language zh -> en
  const langRes = await host.request('POST', '/career-agent/action', {
    action: 'configure',
    config: { locale: 'en' },
  })
  assert.equal(langRes.status, 200)

  // Release the LLM response and assert tailor succeeds cleanly!
  resolveGate()
  const tailorRes = await tailorPromise
  assert.equal(tailorRes.status, 200, `expected in-flight tailor to complete cleanly, got: ${tailorRes.raw}`)
  assert.equal(tailorRes.json.ok, true)
  assert.ok(tailorRes.json.result?.id, 'tailored resume created')
})

test('Release Gate 4: anti-silent cross-language overwrite guard + diff synthesis in resume agent & merge', async () => {
  const englishResume = [
    '# Alex Chen',
    'alex@example.com | San Francisco, CA',
    '',
    '## Summary',
    'Staff infrastructure engineer focused on high-throughput LLM serving and distributed systems.',
    '',
    '## Experience',
    '### CloudScale · Staff Systems Engineer (2022 – Present)',
    '- Architected multi-node vLLM inference gateway serving 45k QPS at 99.95% availability.',
    '- Reduced P99 tail latency by 38% via continuous batching and KV-cache routing.',
  ].join('\n')

  const chineseRewrite = [
    '# 陈亚历克斯',
    'alex@example.com | 旧金山',
    '',
    '## 个人简介',
    '专注高吞吐大模型推理与分布式系统的资深基础设施工程师。',
    '',
    '## 工作经历',
    '### CloudScale · 资深系统工程师 (2022 – 至今)',
    '- 主导设计多节点推理网关，支撑 45k QPS，可用性 99.95%。',
    '- 通过连续批处理与 KV 缓存路由将 P99 尾延迟降低 38%。',
  ].join('\n')

  // Case A: Chinese UI, user says "把这段写简洁" (not asking to translate).
  // Turn 1 model returns Chinese rewrite + empty changes -> rejected; Turn 2 model self-corrects to English + empty changes -> accepted with synthesized diff!
  let turn = 0
  const llmRecover = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      turn += 1
      if (turn === 1) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c1',
            name: 'update_resume',
            arguments: { markdown: chineseRewrite, summary: '已精简表述', changes: [] },
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (turn === 2) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c2',
            name: 'update_resume',
            arguments: {
              markdown: englishResume.replace(
                '- Architected multi-node vLLM inference gateway serving 45k QPS at 99.95% availability.',
                '- Architected multi-node vLLM inference gateway (45k QPS, 99.95% SLA).',
              ),
              summary: '已按原英文精简工作经历',
              changes: [],
            },
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', text: '已保留英文正文并精简了关键条目。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const eventsA = []
  await streamResumeAgentTurn({
    llm: llmRecover,
    config: { model: 'mock:chat' },
    message: '把这段写简洁',
    markdown: englishResume,
    locale: 'zh',
    emit: e => eventsA.push(e),
  })
  const updatesA = eventsA.filter(e => e.type === 'resume-update')
  assert.equal(updatesA.length, 1, 'only corrected English update should be emitted')
  assert.equal(/[\u4e00-\u9fff]/.test(updatesA[0].markdown), false, 'emitted markdown must stay English')
  assert.ok(Array.isArray(updatesA[0].changes) && updatesA[0].changes.length > 0, 'verifiable diff changes must be synthesized when model omits changes')

  // Case B: Model refuses to keep English even after retry -> ZERO resume-update emitted!
  const llmStubborn = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'stub1',
          name: 'update_resume',
          arguments: { markdown: chineseRewrite, summary: '改写', changes: [] },
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
  const eventsB = []
  await streamResumeAgentTurn({
    llm: llmStubborn,
    config: { model: 'mock:chat' },
    message: '把这段写简洁',
    markdown: englishResume,
    locale: 'zh',
    emit: e => eventsB.push(e),
  })
  assert.equal(eventsB.filter(e => e.type === 'resume-update').length, 0, 'silent cross-language overwrite must be blocked')

  // Case C: User explicitly asks to translate -> allowed!
  let translateTurn = 0
  const llmTranslate = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      translateTurn += 1
      if (translateTurn === 1) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 't1',
            name: 'update_resume',
            arguments: { markdown: chineseRewrite, summary: '已翻译为中文版简历', changes: [] },
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', text: '已翻译完成。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const eventsC = []
  await streamResumeAgentTurn({
    llm: llmTranslate,
    config: { model: 'mock:chat' },
    message: '请帮我把这份英文简历翻译成中文',
    markdown: englishResume,
    locale: 'zh',
    emit: e => eventsC.push(e),
  })
  assert.equal(eventsC.filter(e => e.type === 'resume-update').length, 1, 'explicit translation request must be allowed')

  // Case D: mergeEvidenceIntoResume rejects LLM output that flips English resume to Chinese
  const mergeRes = await mergeEvidenceIntoResume({
    llm: {
      listProviders: () => [{ id: 'mock' }],
      async *stream() {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ markdown: chineseRewrite, summary: '合并' }) } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    config: { model: 'mock:merge', sendToModel: true },
    baseMarkdown: englishResume,
    additions: [{ id: 'e1', title: 'GPU autoscaler', text: 'Shipped predictive GPU autoscaler cutting idle spend by 29%.' }],
  })
  assert.equal(mergeRes.mode, 'structural', 'cross-language LLM merge must be rejected in favor of local English merge')
  assert.equal(/[\u4e00-\u9fff]/.test(mergeRes.markdown), false)

  // Case E: English UI editing Chinese resume with "Tighten this bullet" -> silent English overwrite must be blocked!
  const llmFlipToEn = {
    listProviders: () => [{ id: 'mock' }],
    async *stream() {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'flip-en',
          name: 'update_resume',
          arguments: { markdown: englishResume, summary: 'Tightened bullets', changes: [] },
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
  const eventsE = []
  await streamResumeAgentTurn({
    llm: llmFlipToEn,
    config: { model: 'mock:chat' },
    message: 'Tighten this bullet without changing language',
    markdown: chineseRewrite,
    locale: 'en',
    emit: e => eventsE.push(e),
  })
  assert.equal(eventsE.filter(e => e.type === 'resume-update').length, 0, 'silent zh->en overwrite in English UI must be blocked')
})

test('Release Gate 5: timezone conversion, canonical bilingual interview rounds, global comp signals, plain-text EN templates, HTML lang, localized PDF errors & layout names', async () => {
  // 5.1 Timezone: 2026-11-23 14:00 in Asia/Shanghai MUST always map to 2026-11-23T06:00:00.000Z
  const shanghaiIso = zonedLocalToIso('2026-11-23T14:00', 'Asia/Shanghai')
  assert.equal(shanghaiIso, '2026-11-23T06:00:00.000Z')
  assert.equal(toZonedDatetimeInput(shanghaiIso, 'Asia/Shanghai'), '2026-11-23T14:00')
  // Verify DST summer & winter in America/Los_Angeles
  const laSummer = zonedLocalToIso('2026-07-15T09:30', 'America/Los_Angeles')
  assert.equal(laSummer, '2026-07-15T16:30:00.000Z')
  assert.equal(toZonedDatetimeInput(laSummer, 'America/Los_Angeles'), '2026-07-15T09:30')
  const quick = buildZonedQuickSlot(1, 14, 0, 60, 'Asia/Shanghai', new Date('2026-11-22T20:00:00.000Z'))
  // 2026-11-22T20:00Z is 2026-11-23 04:00 in Shanghai -> +1 day = 2026-11-24 14:00..15:00
  assert.equal(quick.startsAt, '2026-11-24T14:00')
  assert.equal(quick.endsAt, '2026-11-24T15:00')

  // 5.2 Canonical bilingual interview rounds merge "一面" invite + "Round 1" confirmation into 1 event,
  // while keeping distinct qualified tracks ("技术一面" vs "业务一面") separate!
  assert.equal(canonicalInterviewRoundKey('一面'), 'round:1')
  assert.equal(canonicalInterviewRoundKey('Round 1'), 'round:1')
  assert.equal(canonicalInterviewRoundKey('技术一面'), 'round:1:tech')
  assert.equal(canonicalInterviewRoundKey('Technical Round 1'), 'round:1:tech')
  assert.equal(canonicalInterviewRoundKey('业务一面'), 'round:1:business')
  assert.notEqual(canonicalInterviewRoundKey('技术一面'), canonicalInterviewRoundKey('业务一面'))
  assert.equal(canonicalInterviewRoundKey('终面'), 'round:final')
  assert.equal(canonicalInterviewRoundKey('Final Round'), 'round:final')
  assert.equal(canonicalInterviewRoundKey('HR面'), 'round:hr')
  assert.equal(canonicalInterviewRoundKey('Recruiter Screen'), 'round:hr')

  const controlMock = {
    config: { personalSchedule: { calendar: 'Work', reminders: 'Jobs' } },
    opportunities: [{ id: 'opp-1', company: 'Stripe', title: 'Staff Engineer' }],
    receipts: [
      { id: 'r1', opportunityId: 'opp-1', type: 'interview_invited', source: 'manual', confirmed: true, evidence: '一面邀约', round: '一面', occurredAt: '2026-11-21T01:00:00.000Z' },
      {
        id: 'r2',
        opportunityId: 'opp-1',
        type: 'interview_confirmed',
        source: 'manual',
        confirmed: true,
        evidence: 'Round 1 confirmed',
        round: 'Round 1',
        startsAt: '2026-11-23T06:00:00.000Z',
        endsAt: '2026-11-23T07:00:00.000Z',
        occurredAt: '2026-11-21T02:00:00.000Z',
      },
    ],
  }
  const itemsZh = personalScheduleItems(controlMock, 'zh')
  const itemsEn = personalScheduleItems(controlMock, 'en')
  assert.equal(itemsZh.length, 1, '一面 invite + Round 1 confirm must leave only 1 scheduled interview (no lingering invite reminder)')
  assert.equal(itemsEn.length, 1)
  assert.equal(itemsZh[0].kind, 'interview')
  assert.equal(itemsZh[0].id, itemsEn[0].id, 'task ID must remain stable across zh/en')
  // Verify rescheduling with Chinese round label ("一面") produces the EXACT same task ID (updates same event)
  const rescheduledMock = {
    ...controlMock,
    receipts: [
      ...controlMock.receipts,
      {
        id: 'r3',
        opportunityId: 'opp-1',
        type: 'interview_confirmed',
        source: 'manual',
        confirmed: true,
        evidence: '一面改期',
        round: '一面',
        startsAt: '2026-11-24T06:00:00.000Z',
        endsAt: '2026-11-24T07:00:00.000Z',
        occurredAt: '2026-11-21T03:00:00.000Z',
      },
    ],
  }
  const itemsRescheduled = personalScheduleItems(rescheduledMock, 'zh')
  assert.equal(itemsRescheduled.length, 1, 'rescheduling Round 1 as 一面 must update the same single event')
  assert.equal(itemsRescheduled[0].id, itemsZh[0].id, 'rescheduled event keeps exact same canonical task ID')
  assert.equal(itemsRescheduled[0].startsAt, '2026-11-24T06:00:00.000Z')

  // 5.3 Global compensation signal detection
  assert.equal(hasCompensationSignal('Offer is £120,000 base plus bonus'), true)
  assert.equal(hasCompensationSignal('CAD 165,000 total comp'), true)
  assert.equal(hasCompensationSignal('€95k base salary'), true)
  assert.equal(hasCompensationSignal('$240,000 TC'), true)
  assert.equal(hasCompensationSignal('年包 85w + 期权'), true)
  assert.equal(hasCompensationSignal('Current role requires 3 months notice period before joining'), false)
  assert.equal(hasCompensationSignal('Probation is 6 months with two technical rounds'), false)

  // 5.4 English plain-text resume section structure & accurate HTML lang despite "中国" in address
  const plainEn = [
    'Jordan Lee',
    'jordan@example.com | Shanghai, 中国',
    '',
    'Professional Experience',
    'Acme Cloud | Staff Systems Engineer | 2022 - Present',
    '- Scaled distributed inference platform to 60k RPS.',
    '',
    'Skills & Certifications',
    '- Go, Rust, Kubernetes, CUDA, AWS Solutions Architect',
  ].join('\n')
  const rendered = await renderLocalResume({ text: plainEn, template: 'onyx', locale: 'en' })
  assert.equal(rendered.lang, 'en-US', 'English resume with "中国" in location must still export lang="en-US"')
  assert.match(rendered.html, /Professional Experience/i)
  assert.match(rendered.html, /Skills &amp; Certifications/i)

  // 5.5 Localized PDF error message in English when browser export fails
  await assert.rejects(
    () => renderLocalResumePdf({
      text: plainEn,
      template: 'onyx',
      locale: 'en',
      browser: { name: 'MockChrome', path: '/nonexistent/chrome-bin' },
      runner: async () => { throw new Error('spawn failed') },
    }),
    err => {
      assert.equal(/[\u4e00-\u9fff]/.test(err.message), false, `expected English PDF error, got: ${err.message}`)
      return true
    },
  )

  // 5.6 Human-readable bilingual template layout names (no Pokémon names)
  const pokemonRe = /\b(onyx|lapras|porygon|rhyhorn|bronzor|kakuna|meowth|persian|scizor|smeargle|azurill|ditto|ditgar|gengar|glalie|pikachu|chikorita|leafish)\b/i
  for (const tpl of localResumeTemplates) {
    const zhName = templateDisplayName(tpl, 'zh')
    const enName = templateDisplayName(tpl, 'en')
    assert.ok(zhName && zhName.length >= 2)
    assert.ok(enName && enName.length >= 4)
    assert.equal(pokemonRe.test(zhName), false, `template ${tpl.id} zh name should not be a Pokémon name: ${zhName}`)
    assert.equal(pokemonRe.test(enName), false, `template ${tpl.id} en name should not be a Pokémon name: ${enName}`)
  }
  const dirZh = parseStyleDirective('帮我换成现代卡片模板', localResumeTemplates, 'zh')
  assert.equal(dirZh?.templateId, 'lapras')
  const dirEn = parseStyleDirective('switch to Bold Left Rail layout', localResumeTemplates, 'en')
  assert.equal(dirEn?.templateId, 'ditgar')
})
