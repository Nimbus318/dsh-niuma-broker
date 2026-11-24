import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject } from '../src/host.mjs'
import { modelJson } from '../src/watch.mjs'

function createHostHarness(dir, {
  agentDefaultModel = null,
  timer = null,
  officeKit = null,
  attachments = null,
  llm = null,
} = {}) {
  const routes = new Map()
  const disposers = []
  const services = {
    agentDefaultModel,
    timer,
    officeKit,
    attachments,
    web: null,
    workspaceRegistry: { list: () => [] },
  }

  const defaultLlm = llm || {
    listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    listModels: async () => [{ id: 'alpha-pro', name: 'Alpha Pro' }],
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '{}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const ctx = {
    profileContext: { dir },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => {
            routes.delete(route.path)
          }
        },
      },
    },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
    },
    llm: defaultLlm,
    get(key) {
      if (Object.hasOwn(services, key)) return services[key]
      throw new Error(`cannot get property "${key}" without inject`)
    },
    provide() {
      return () => {}
    },
    on() {
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    logger: {
      warn() {},
    },
  }

  return {
    ctx,
    services,
    async start() {
      await apply(ctx)
    },
    async stop() {
      for (const dispose of disposers.splice(0).reverse()) {
        await dispose()
      }
    },
    async call(method, path, body = undefined, extraHeaders = {}) {
      const urlPath = path.split('?')[0]
      const route = routes.get(urlPath)
      assert.ok(route, `Expected route registered for ${urlPath}`)
      const headers = new Headers({
        'x-career-agent': '1',
        ...extraHeaders,
      })
      const init = { method, headers }
      if (body !== undefined) {
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
          if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
          init.body = body
        } else {
          if (!headers.has('content-type')) headers.set('content-type', 'application/json')
          init.body = JSON.stringify(body)
        }
      }
      const req = new Request(`https://plugin.local${path}`, init)
      const res = await route.fetch(req)
      const json = await res.json()
      return { status: res.status, json }
    },
  }
}

const VALID_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

function buildEmptyScannedPdf(pages = 6) {
  return Buffer.from(`%PDF-1.4\n% ${pages} blank scanned page placeholder\n%%EOF\n`, 'latin1')
}

test('per-profile isolation: clean profile B cannot see profile A data, grants, or goal; profile A persists across restart', async () => {
  assert.ok(!inject.includes('storageDomain'), 'host inject must NOT declare storageDomain')

  const root = await mkdtemp(join(tmpdir(), 'niuma-profile-isolation-unit-'))
  const dirA = join(root, 'profile-a')
  const dirB = join(root, 'profile-b')
  try {
    // 1) Profile A stores config, grant, and approved resume
    const hostA1 = createHostHarness(dirA)
    await hostA1.start()
    const cfgA = await hostA1.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: {
        goal: 'Profile A Confidential Goal',
        sources: [{ id: 'manual', projects: ['personal'] }],
      },
    })
    assert.equal(cfgA.status, 200)
    const impA = await hostA1.call('POST', '/api/career-agent/action', {
      action: 'resume-import',
      title: 'Profile A Resume',
      text: '# Candidate A\nSecret Resume Text A',
    })
    assert.equal(impA.status, 200)
    const revA = await hostA1.call('POST', '/api/career-agent/action', {
      action: 'resume-review',
      id: impA.json.result.id,
      decision: 'approve',
    })
    assert.equal(revA.status, 200)
    await hostA1.stop()

    // Verify per-profile files reside strictly under profile-a directory
    const watchdogA = JSON.parse(await readFile(join(dirA, 'career-broker', 'watchdog.json'), 'utf8'))
    assert.equal(watchdogA.config.goal, 'Profile A Confidential Goal')

    // 2) Clean Profile B must see ZERO resumes, ZERO sources, empty goal
    const hostB = createHostHarness(dirB)
    await hostB.start()
    const stateB = await hostB.call('GET', '/api/career-agent/state')
    assert.equal(stateB.status, 200)
    assert.equal(stateB.json.config.goal, '')
    assert.equal(stateB.json.resumes.length, 0)
    assert.equal(stateB.json.sources.length, 0)
    assert.equal(stateB.json.evidence.length, 0)
    await hostB.stop()

    // 3) Restart Profile A and confirm it still reads its approved resume and config
    const hostA2 = createHostHarness(dirA)
    await hostA2.start()
    const stateA2 = await hostA2.call('GET', '/api/career-agent/state')
    assert.equal(stateA2.status, 200)
    assert.equal(stateA2.json.config.goal, 'Profile A Confidential Goal')
    assert.deepEqual(stateA2.json.resumes.map(r => r.title), ['Profile A Resume'])
    assert.deepEqual(stateA2.json.sources.map(s => s.id), ['manual'])
    await hostA2.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parse-resume-file preserves binary stream & text import while never auto-saving scanned PDF/image bytes to attachments or sending to LLM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-scanned-guard-'))
  try {
    let renderCalls = 0
    let savedImagesCount = 0
    let llmCalls = 0

    const harness = createHostHarness(dir, {
      agentDefaultModel: { currentSelection: () => ({ provider: 'provider-a', model: 'alpha-pro', reasoningEffort: 'low' }) },
      officeKit: {
        async renderImages() {
          renderCalls += 1
          return { images: [{ png: new Uint8Array(VALID_PNG_BYTES), width: 100, height: 140, page: 1 }], pageCount: 6, dpi: 150, missingFonts: [] }
        },
      },
      attachments: {
        async saveImages(inputs) {
          savedImagesCount += inputs.length
          return inputs.map((_, i) => ({ attachmentId: `att-${i}`, mediaType: 'image/png', bytes: 10, width: 100, height: 140 }))
        },
      },
      llm: {
        listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
        listModels: async () => [{ id: 'alpha-pro', name: 'Alpha Pro' }],
        async *stream() {
          llmCalls += 1
          yield {
            type: 'text-delta',
            index: 0,
            text: JSON.stringify({ title: '林予安 · 基础简历', markdown: '# 林予安\n资深后端与基础设施工程师\n## 工作经历\n### 星辰科技 · 高级工程师 (2022 - 2026)\n- 设计千万级并发网关，P99 延迟下降 40%。' }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    })
    await harness.start()

    // 1) Normal binary octet-stream text upload (with Chinese filename & explicit AI formatting) still works cleanly
    const plainText = Buffer.from('林予安\n资深后端与基础设施工程师\n工作经历：设计千万级并发网关，P99 延迟下降 40%。', 'utf8')
    const binRes = await harness.call('POST', '/api/career-agent/parse-resume-file', plainText, {
      'x-resume-filename': encodeURIComponent('林予安_简历_2026.txt'),
      'x-resume-mime': 'text/plain',
      'x-resume-use-ai': '1',
      'x-resume-explicit-ai': '1',
    })
    assert.equal(binRes.status, 200)
    assert.equal(binRes.json.result.method, 'text')
    assert.equal(binRes.json.result.structuredByAi, true)
    assert.equal(renderCalls, 0)
    assert.equal(savedImagesCount, 0)
    assert.equal(llmCalls, 1)

    // 2) Legacy JSON dataBase64 upload compatibility
    const jsonRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
      filename: 'legacy.md',
      mimeType: 'text/markdown',
      dataBase64: Buffer.from('# Legacy Resume\n- Built distributed services.', 'utf8').toString('base64'),
      useAi: false,
    })
    assert.equal(jsonRes.status, 200)
    assert.equal(jsonRes.json.result.method, 'text')

    // 3) Scanned 6-page PDF & unreadable image: MUST NOT save images or invoke LLM or renderImages!
    const llmCallsBefore = llmCalls
    const scannedPdfRes = await harness.call('POST', '/api/career-agent/parse-resume-file', buildEmptyScannedPdf(6), {
      'x-resume-filename': encodeURIComponent('六页扫描件.pdf'),
      'x-resume-mime': 'application/pdf',
      'x-resume-use-ai': '1',
      'x-resume-explicit-ai': '1',
    })
    assert.equal(scannedPdfRes.status, 400)
    assert.equal(renderCalls, 0)
    assert.equal(savedImagesCount, 0)
    assert.equal(llmCalls, llmCallsBefore)

    const blankPngRes = await harness.call('POST', '/api/career-agent/parse-resume-file', Buffer.from(VALID_PNG_BYTES), {
      'x-resume-filename': encodeURIComponent('blank-scan.png'),
      'x-resume-mime': 'image/png',
      'x-resume-use-ai': '1',
      'x-resume-explicit-ai': '1',
    })
    assert.equal(blankPngRes.status, 400)
    assert.equal(renderCalls, 0)
    assert.equal(savedImagesCount, 0)
    assert.equal(llmCalls, llmCallsBefore)

    await harness.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('follow DSH default provider/model/reasoningEffort across two providers, timer disposal, live default swap, outage isolation, and explicit overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-dsh-default-follow-'))
  try {
    const timerCalls = []
    let timerDisposed = false
    const timer = {
      interval(cb, ms) {
        timerCalls.push({ cb, ms })
        return () => { timerDisposed = true }
      },
    }

    let currentDefault = { provider: 'provider-a', model: 'alpha-pro', reasoningEffort: 'high' }
    let failProviderAList = false
    const seenPrepareCalls = []
    const seenDirectStreams = []

    const makeMockLlm = (usePrepareCall = true) => ({
      listProviders: () => [
        { id: 'provider-a', name: 'Provider A' },
        { id: 'provider-b', name: 'Provider B' },
      ],
      async listModels(providerId) {
        if (providerId === 'provider-a') {
          if (failProviderAList) throw new Error('temporary 503 catalog error')
          return [{ id: 'alpha-pro', name: 'Alpha Pro' }]
        }
        return [
          { id: 'beta-fast', name: 'Beta Fast' },
          { id: 'beta-pro', name: 'Beta Pro' },
        ]
      },
      ...(usePrepareCall ? {
        async prepareCall({ provider, model }, _sig, configure) {
          const info = {
            provider,
            id: model,
            name: model,
            maxOutputTokens: 8192,
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'High' },
              ],
              defaultEffort: 'medium',
            },
          }
          const resolvedControls = configure({}, info)
          return {
            model: info,
            config: resolvedControls,
            async *stream() {
              seenPrepareCalls.push({
                provider,
                model,
                reasoningEffort: resolvedControls.reasoningEffort,
                maxTokens: resolvedControls.maxTokens,
              })
              yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdict: 'Fit', highlights: ['Matched'], risks: [], diligence: [] }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        },
      } : {}),
      async *stream(req) {
        seenDirectStreams.push({
          provider: req.provider,
          model: req.model,
          reasoningEffort: req.reasoningEffort,
        })
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdict: 'Fit', highlights: ['Matched'], risks: [], diligence: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })

    // Part A: Cold start during transient provider-a listModels failure MUST still follow DSH default (never failover to provider-b)
    failProviderAList = true
    const harnessColdOutage = createHostHarness(join(dir, 'cold-outage'), {
      timer,
      llm: makeMockLlm(true),
      agentDefaultModel: { currentSelection: () => currentDefault },
    })
    await harnessColdOutage.start()
    assert.equal(timerCalls.length, 1)
    assert.equal(timerCalls[0].ms, 5000)

    const jobOutage = await harnessColdOutage.call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Stripe', title: 'Infra Engineer', jd: 'Distributed systems and Kubernetes inference scheduling.' },
    })
    const intelOutage = await harnessColdOutage.call('POST', '/api/career-agent/action', {
      action: 'job-intel',
      id: jobOutage.json.result.id,
      force: true,
    })
    assert.equal(intelOutage.status, 200)
    assert.deepEqual(seenPrepareCalls.at(-1), {
      provider: 'provider-a',
      model: 'alpha-pro',
      reasoningEffort: 'high',
      maxTokens: 8192,
    })

    // GET /models also preserves provider-a's default row even when listModels('provider-a') failed
    const modelsDuringOutage = await harnessColdOutage.call('GET', '/api/career-agent/models')
    assert.equal(modelsDuringOutage.status, 200)
    const defaultRow = modelsDuringOutage.json.find(r => r.isDefault === true)
    assert.equal(defaultRow?.provider, 'provider-a')
    assert.equal(defaultRow?.id, 'alpha-pro')
    assert.equal(defaultRow?.defaultReasoningEffort, 'high')

    await harnessColdOutage.stop()
    assert.equal(timerDisposed, true)

    // Part B: Mounted live swap + plugin explicit overrides + direct stream fallback without prepareCall
    failProviderAList = false
    const harnessLive = createHostHarness(join(dir, 'live-swap'), {
      llm: makeMockLlm(false), // tests llm.stream path directly
      agentDefaultModel: { currentSelection: () => currentDefault },
    })
    await harnessLive.start()
    const jobLive = await harnessLive.call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Databricks', title: 'Staff Systems', jd: 'Distributed storage and query engine.' },
    })
    const liveJobId = jobLive.json.result.id

    // 1) Initial default provider-a:alpha-pro (high)
    await harnessLive.call('POST', '/api/career-agent/action', { action: 'job-intel', id: liveJobId, force: true })
    assert.deepEqual(seenDirectStreams.at(-1), {
      provider: 'provider-a',
      model: 'alpha-pro',
      reasoningEffort: 'high',
    })

    // 2) Switch DSH default while mounted -> provider-b:beta-pro (medium)
    currentDefault = { provider: 'provider-b', model: 'beta-pro', reasoningEffort: 'medium' }
    await harnessLive.call('POST', '/api/career-agent/action', { action: 'job-intel', id: liveJobId, force: true })
    assert.deepEqual(seenDirectStreams.at(-1), {
      provider: 'provider-b',
      model: 'beta-pro',
      reasoningEffort: 'medium',
    })

    // 3) Plugin explicit model override with auto effort does NOT leak DSH default's effort into overridden model
    await harnessLive.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: { model: 'provider-a:alpha-pro', reasoningEffort: '' },
    })
    await harnessLive.call('POST', '/api/career-agent/action', { action: 'job-intel', id: liveJobId, force: true })
    assert.deepEqual(seenDirectStreams.at(-1), {
      provider: 'provider-a',
      model: 'alpha-pro',
      reasoningEffort: undefined,
    })

    // 4) Plugin explicit model + explicit reasoningEffort both win over DSH default
    await harnessLive.call('POST', '/api/career-agent/action', {
      action: 'configure',
      config: { model: 'provider-b:beta-fast', reasoningEffort: 'low' },
    })
    await harnessLive.call('POST', '/api/career-agent/action', { action: 'job-intel', id: liveJobId, force: true })
    assert.deepEqual(seenDirectStreams.at(-1), {
      provider: 'provider-b',
      model: 'beta-fast',
      reasoningEffort: 'low',
    })

    await harnessLive.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('modelJson follows DSH providerRetryPolicy and providerRetryAfterMs on the exact same route without retrying partial streams or disallowed codes', async () => {
  const baseConfig = { sendToModel: true, model: 'provider-a:alpha-pro' }
  const providers = [{ id: 'provider-a' }]

  // 1) Follows retryableCodes + providerRetryAfterMs on the exact same route
  let attempts1 = 0
  const routes1 = []
  const t0 = Date.now()
  const okRes = await modelJson(
    {
      listProviders: () => providers,
      providerRetryPolicy: p => {
        assert.equal(p, 'provider-a')
        return {
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['RATE_LIMIT'],
          initialDelayMs: 500,
          maxDelayMs: 1000,
          jitterRatio: 0,
        }
      },
      async *stream(req) {
        routes1.push(`${req.provider}:${req.model}`)
        attempts1 += 1
        if (attempts1 === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 30 } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    baseConfig,
    'sys',
    { hello: 'world' },
  )
  const elapsed1 = Date.now() - t0
  assert.equal(attempts1, 2)
  assert.deepEqual(routes1, ['provider-a:alpha-pro', 'provider-a:alpha-pro'])
  assert.deepEqual(okRes, { ok: true })
  assert.ok(elapsed1 < 250, `Expected DSH providerRetryAfterMs (~30ms), took ${elapsed1}ms`)

  // 2) Code excluded from provider's declared retryableCodes MUST NOT retry
  let attempts2 = 0
  await assert.rejects(
    () => modelJson(
      {
        listProviders: () => providers,
        providerRetryPolicy: () => ({
          mode: 'normal',
          maxRetries: 3,
          retryableCodes: ['RATE_LIMIT'], // SERVER intentionally excluded
          initialDelayMs: 10,
          maxDelayMs: 1000,
          jitterRatio: 0,
        }),
        async *stream() {
          attempts2 += 1
          yield { type: 'finish', reason: { kind: 'error', failure: { message: '503 busy', code: 'SERVER' } } }
        },
      },
      baseConfig,
      'sys',
      { q: 1 },
    ),
    err => err.code === 'SERVER',
  )
  assert.equal(attempts2, 1)

  // 3) providerRetryAfterMs exceeding policy maxDelayMs in normal mode MUST NOT retry
  let attempts3 = 0
  await assert.rejects(
    () => modelJson(
      {
        listProviders: () => providers,
        providerRetryPolicy: () => ({
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['RATE_LIMIT'],
          initialDelayMs: 10,
          maxDelayMs: 100,
          jitterRatio: 0,
        }),
        async *stream() {
          attempts3 += 1
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'long backoff', code: 'RATE_LIMIT', providerRetryAfterMs: 500 } } }
        },
      },
      baseConfig,
      'sys',
      { q: 1 },
    ),
    err => err.code === 'RATE_LIMIT',
  )
  assert.equal(attempts3, 1)

  // 4) maxRetries: 0 MUST NOT retry
  let attempts4 = 0
  await assert.rejects(
    () => modelJson(
      {
        listProviders: () => providers,
        providerRetryPolicy: () => ({
          mode: 'normal',
          maxRetries: 0,
          retryableCodes: ['RATE_LIMIT'],
          initialDelayMs: 10,
          maxDelayMs: 1000,
          jitterRatio: 0,
        }),
        async *stream() {
          attempts4 += 1
          const err = new Error('rate limit')
          err.code = 'RATE_LIMIT'
          throw err
        },
      },
      baseConfig,
      'sys',
      { q: 1 },
    ),
    err => err.code === 'RATE_LIMIT',
  )
  assert.equal(attempts4, 1)

  // 5) Partial text already streamed MUST NOT retry
  let attempts5 = 0
  await assert.rejects(
    () => modelJson(
      {
        listProviders: () => providers,
        providerRetryPolicy: () => ({
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['RATE_LIMIT'],
          initialDelayMs: 5,
          maxDelayMs: 1000,
          jitterRatio: 0,
        }),
        async *stream() {
          attempts5 += 1
          yield { type: 'text-delta', index: 0, text: '{"partial":' }
          const err = new Error('mid-stream interrupt')
          err.code = 'RATE_LIMIT'
          throw err
        },
      },
      baseConfig,
      'sys',
      { q: 1 },
    ),
    err => /请稍后再试/.test(err.message) && err.code === 'RATE_LIMIT',
  )
  assert.equal(attempts5, 1)

  // 6) HTTP 429 / RATE_LIMIT WITHOUT providerRetryAfterMs MUST NOT blindly retry and must ask user to retry later
  let attempts6 = 0
  await assert.rejects(
    () => modelJson(
      {
        listProviders: () => providers,
        providerRetryPolicy: () => ({
          mode: 'normal',
          maxRetries: 5,
          retryableCodes: ['RATE_LIMIT'],
          initialDelayMs: 10,
          maxDelayMs: 1000,
          jitterRatio: 0,
        }),
        async *stream() {
          attempts6 += 1
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 429 too many requests', code: 'RATE_LIMIT', status: 429 } } }
        },
      },
      baseConfig,
      'sys',
      { q: 1 },
    ),
    err => /请稍后再试/.test(err.message) && err.code === 'RATE_LIMIT',
  )
  assert.equal(attempts6, 1)
})

test('unregistered DSH default (missing:approved) never silently falls over to local:valid; request.signal aborts parse-resume-file AI call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-missing-default-'))
  try {
    let validCalls = 0
    const abortController = new AbortController()
    const llm = {
      listProviders: () => [{ id: 'local', name: 'Local' }],
      listModels: async () => [{ id: 'valid', name: 'Valid' }],
      async *stream() {
        validCalls += 1
        abortController.abort(new Error('client cancelled'))
        yield { type: 'text-delta', index: 0, text: '{}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }

    const harnessMissing = createHostHarness(join(dir, 'missing'), {
      llm,
      agentDefaultModel: { currentSelection: () => ({ provider: 'missing', model: 'approved', reasoningEffort: 'high' }) },
    })
    await harnessMissing.start()

    // 1) GET /models does NOT synthesize unavailable missing:approved
    const modelsRes = await harnessMissing.call('GET', '/api/career-agent/models')
    assert.equal(modelsRes.status, 200)
    assert.equal(modelsRes.json.some(r => r.provider === 'missing'), false)

    // 2) parse-resume-file keeps missing:approved -> falls back cleanly to local preview without touching local:valid
    const txt = Buffer.from('Synthetic Candidate\nBuilt reliable systems for distributed workloads.', 'utf8')
    const parseRes = await harnessMissing.call('POST', '/api/career-agent/parse-resume-file', {
      filename: 'candidate.txt',
      mimeType: 'text/plain',
      dataBase64: txt.toString('base64'),
      useAi: true,
      explicitUseAi: true,
    })
    assert.equal(parseRes.status, 200)
    assert.equal(parseRes.json.result.structuredByAi, false)
    assert.equal(validCalls, 0, 'Must NEVER fail over from missing:approved to local:valid')

    // 3) job-intel keeps missing:approved -> returns 400 error mentioning missing without touching local:valid
    const jobRes = await harnessMissing.call('POST', '/api/career-agent/action', {
      action: 'job-add',
      job: { company: 'Acme', title: 'Systems', jd: 'Distributed systems engineering role with Kubernetes.' },
    })
    const intelRes = await harnessMissing.call('POST', '/api/career-agent/action', {
      action: 'job-intel',
      id: jobRes.json.result.id,
      force: true,
    })
    assert.equal(intelRes.status, 400)
    assert.match(intelRes.json.error, /missing/)
    assert.equal(validCalls, 0)
    await harnessMissing.stop()

    // 4) parse-resume-file forwards request.signal to modelJson so abort cancels instead of returning fallback 200
    const routes = new Map()
    const disposers = []
    await apply({
      profileContext: { dir: join(dir, 'abort') },
      connection: { fetch: { register(r) { routes.set(r.path, r); return () => {} } } },
      sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
      llm: {
        listProviders: () => [{ id: 'local', name: 'Local' }],
        listModels: async () => [{ id: 'valid', name: 'Valid' }],
        async *stream(req) {
          assert.ok(req.signal, 'parse-resume-file modelJson must receive request.signal')
          abortController.abort(new DOMException('Aborted', 'AbortError'))
          req.signal.throwIfAborted()
        },
      },
      get: key => (key === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'local', model: 'valid', reasoningEffort: 'low' }) }
        : null),
      provide: () => () => {},
      on: () => () => {},
      effect(fn) { disposers.push(fn()) },
      logger: { warn() {} },
    })
    const abortReq = new Request('https://plugin.local/api/career-agent/parse-resume-file', {
      method: 'POST',
      signal: abortController.signal,
      headers: { 'x-career-agent': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'abort.txt',
        mimeType: 'text/plain',
        dataBase64: txt.toString('base64'),
        useAi: true,
        explicitUseAi: true,
      }),
    })
    const abortRes = await routes.get('/api/career-agent/parse-resume-file').fetch(abortReq)
    assert.equal(abortRes.status, 400)
    const abortJson = await abortRes.json()
    assert.notEqual(abortJson.ok, true)
    for (const d of disposers.reverse()) await d?.()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prepared.stream receives full prepared.config across modelJson, streamResumeAgentTurn, and predictNextPrompt without falling back', async () => {
  const { predictNextPrompt, streamResumeAgentTurn } = await import('../src/resume-agent.mjs')

  const observed = []
  let fallbackStreamCalls = 0

  const strictSdkLlm = {
    listProviders: () => [{ id: 'qa-a', name: 'QA A' }],
    async prepareCall({ provider, model }, _signal, configure) {
      const info = {
        provider,
        id: model,
        name: model,
        maxOutputTokens: 8192,
        reasoning: {
          efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
          defaultEffort: 'medium',
        },
      }
      const next = configure({}, info)
      const resolvedConfig = Object.freeze({
        provider,
        model,
        reasoningEffort: next.reasoningEffort,
        maxTokens: next.maxTokens,
      })
      let dispatched = false
      return Object.freeze({
        config: resolvedConfig,
        stream(options) {
          assert.equal(dispatched, false)
          dispatched = true
          // Mimic real DSH LlmRuntime.callConfigEquals validation
          if (
            options.provider !== resolvedConfig.provider
            || options.model !== resolvedConfig.model
            || options.reasoningEffort !== resolvedConfig.reasoningEffort
            || options.maxTokens !== resolvedConfig.maxTokens
          ) {
            const err = new Error('prepared LLM call config changed before adapter dispatch')
            err.code = 'INVALID_PREPARED_CALL'
            throw err
          }
          observed.push({
            provider: options.provider,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            maxTokens: options.maxTokens,
          })
          return (async function* () {
            const jsonText = JSON.stringify({ suggestion: 'Tailor to Staff role', markdown: '# Done' })
            yield { type: 'text-delta', index: 0, text: jsonText }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      })
    },
    async *stream() {
      fallbackStreamCalls += 1
      throw new Error('must not fall back when prepareCall succeeds')
    },
  }

  await modelJson(
    strictSdkLlm,
    { sendToModel: true, model: 'qa-a:alpha', reasoningEffort: 'high' },
    'sys',
    { k: 1 },
  )
  assert.deepEqual(observed.at(-1), { provider: 'qa-a', model: 'alpha', reasoningEffort: 'high', maxTokens: 8192 })

  await streamResumeAgentTurn({
    llm: strictSdkLlm,
    config: { model: 'qa-a:alpha', reasoningEffort: 'high' },
    markdown: '# Alex\n## Experience\n- Distributed systems',
    message: 'Refine bullets',
    emit() {},
  })
  assert.deepEqual(observed.at(-1), { provider: 'qa-a', model: 'alpha', reasoningEffort: 'high', maxTokens: 8192 })

  const predicted = await predictNextPrompt({
    llm: strictSdkLlm,
    config: { model: 'qa-a:alpha', tabReasoningEffort: 'low' },
    surface: 'resume',
    markdown: '# Alex',
  })
  assert.equal(typeof predicted.suggestion, 'string')
  assert.deepEqual(observed.at(-1), { provider: 'qa-a', model: 'alpha', reasoningEffort: 'low', maxTokens: 96 })
  assert.equal(fallbackStreamCalls, 0)
})
