import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, FETCH_ROUTES } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'

function createCountingStream(chunkSize, totalChunks) {
  let pulled = 0
  const chunk = new Uint8Array(chunkSize).fill(0x61) // 'a'
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled >= totalChunks) {
        controller.close()
        return
      }
      pulled += 1
      controller.enqueue(chunk)
    },
  }, { highWaterMark: 0 })
  return { stream, get pulled() { return pulled } }
}

test('host requires ctx.connection.fetch.register and never registers legacy webServer routes', async t => {
  assert.ok(!inject.includes('webServer'), 'host should not inject webServer')
  assert.ok(inject.includes('connection'), 'host must inject connection')

  const dir = await mkdtemp(join(tmpdir(), 'niuma-require-fetch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let webServerCalled = false
  await assert.rejects(
    apply({
      profileContext: { dir },
      webServer: { register() { webServerCalled = true; return () => {} } },
      connection: { on() {} },
      sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
      llm: { listProviders: () => [] },
      logger: { warn() {} },
      get: () => undefined,
      on() {},
      emit() {},
      provide() {},
      effect() {},
    }),
    /connection\.fetch\.register/,
  )
  assert.equal(webServerCalled, false, 'must never fall back to webServer.register')
})

test('DSH 0.2.2 & 0.2.3 Fetch main path: route modes, owner check, normal POST, PDF, and streaming chat cancel', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-dsh-fetch-'))
  const harness = createFetchHarness()
  let disposeEffect
  let chatAborted = false

  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
    },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'fast', name: 'Fast' }],
      async *stream({ signal }) {
        yield { type: 'text-delta', text: 'First chunk. ' }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 40)
          signal?.addEventListener('abort', () => {
            chatAborted = true
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (signal?.aborted) return
        yield { type: 'text-delta', text: 'Second chunk.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    logger: { warn() {} },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { disposeEffect = fn() },
  }

  await apply(ctx)
  t.after(async () => {
    await disposeEffect?.()
    await rm(dir, { recursive: true, force: true })
  })

  // 1. All 15 routes registered under /api/career-agent/* with GET=buffered, POST=streaming
  assert.equal(harness.routes.size, FETCH_ROUTES.length)
  for (const { slug, methods, requestBody } of FETCH_ROUTES) {
    const entry = harness.routes.get(`/api/career-agent/${slug}`)
    assert.ok(entry, `missing route /api/career-agent/${slug}`)
    assert.deepEqual([...entry.methods], methods)
    assert.equal(entry.requestBody, methods.includes('POST') ? 'streaming' : 'buffered')
    assert.equal(entry.requestBody, requestBody)
  }

  // Legacy /career-agent/* is not mounted
  const legacyRes = await harness.dispatch('/career-agent/state')
  assert.equal(legacyRes.status, 404)

  // Non-owner peer is refused with 403 by the host shared /api channel
  const nonOwnerRes = await harness.dispatch('/api/career-agent/state', {
    peer: { id: 'guest-peer', principal: { kind: 'guest' } },
  })
  assert.equal(nonOwnerRes.status, 403)

  // 2. GET /api/career-agent/state with Fetch Headers locale
  const stRes = await harness.dispatch('/api/career-agent/state', {
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
  })
  assert.equal(stRes.status, 200)
  const st = await stRes.json()
  assert.equal(st.mode, 'off')
  assert.ok(Array.isArray(st.resumes))

  // 3. POST without x-career-agent header is refused (403) without reading body and honors locale
  const unauthStream = createCountingStream(64 * 1024, 4)
  const noHdrEn = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-career-locale': 'en' },
    body: unauthStream.stream,
  })
  assert.equal(noHdrEn.status, 403)
  assert.equal((await noHdrEn.json()).error, 'Only same-origin plugin requests are allowed.')
  assert.equal(unauthStream.pulled, 0, '403 must not consume streaming request body')

  const noHdrZh = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: { 'x-career-locale': 'zh' },
    body: { action: 'configure', config: { goal: 'AI Infra' } },
  })
  assert.equal(noHdrZh.status, 403)
  assert.equal((await noHdrZh.json()).error, '此操作只接受同源插件请求。')

  // 4. Normal streaming POST: import, approve, local-preview, and binary PDF export
  const impRes = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: {
      action: 'resume-import',
      title: 'Alex Chen Master',
      text: '# Alex Chen\n\n## Experience\n- Built low-latency inference cluster.',
    },
  })
  assert.equal(impRes.status, 200)
  const imported = (await impRes.json()).result
  assert.ok(imported?.id)

  const appRes = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: { action: 'resume-review', id: imported.id, decision: 'approve' },
  })
  assert.equal(appRes.status, 200)

  const previewRes = await harness.dispatch('/api/career-agent/local-preview', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: { id: imported.id, template: 'onyx' },
  })
  assert.equal(previewRes.status, 200)
  const previewJson = await previewRes.json()
  assert.equal(previewJson.ok, true)
  assert.ok(typeof previewJson.result?.html === 'string' && previewJson.result.html.includes('Alex Chen'))

  const pdfRes = await harness.dispatch('/api/career-agent/export-pdf', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: { id: imported.id, template: 'onyx' },
  })
  assert.equal(pdfRes.status, 200)
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf')
  const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer())
  assert.equal(Buffer.from(pdfBytes.subarray(0, 5)).toString('ascii'), '%PDF-')

  // 5. Binary/404 GET routes (logo, app-icon)
  const badLogo = await harness.dispatch('/api/career-agent/logo?domain=')
  assert.equal(badLogo.status, 404)
  const badIcon = await harness.dispatch('/api/career-agent/app-icon?destination=unknown')
  assert.equal(badIcon.status, 404)

  // 6. Streaming NDJSON resume-chat completes cleanly and honors AbortSignal
  const chatRes = await harness.dispatch('/api/career-agent/resume-chat', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: {
      message: 'Tighten summary',
      markdown: '# Alex Chen\n\n## Summary\nEngineer.',
      template: 'onyx',
      model: 'mock:fast',
    },
  })
  assert.equal(chatRes.status, 200)
  assert.ok((chatRes.headers.get('content-type') || '').includes('application/x-ndjson'))
  const ndjson = await chatRes.text()
  const lines = ndjson.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(lines.length > 0, 'resume-chat should stream at least one NDJSON event')

  const abortCtrl = new AbortController()
  const abortedRes = await harness.dispatch('/api/career-agent/resume-chat', {
    method: 'POST',
    headers: { 'x-career-agent': '1', 'x-career-locale': 'en' },
    body: {
      message: 'Stream and cancel',
      markdown: '# Alex Chen\n\n## Summary\nEngineer.',
      template: 'onyx',
      model: 'mock:fast',
    },
    signal: abortCtrl.signal,
  })
  const reader = abortedRes.body.getReader()
  await reader.read()
  abortCtrl.abort()
  await reader.cancel().catch(() => {})
  await new Promise(r => setTimeout(r, 20))
  assert.equal(chatAborted, true, 'aborting Fetch request signal must cancel resume-chat generation')

  // 7. Disposal unregisters all 15 routes
  await disposeEffect()
  disposeEffect = null
  assert.equal(harness.routes.size, 0)
  assert.equal(harness.disposedCount, FETCH_ROUTES.length)
})

test('streaming POST enforces 500,000-byte JSON cap, 22 MiB resume-import cap, early stop, and mid-upload abort', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-post-limits-'))
  const harness = createFetchHarness()
  let disposeEffect

  await apply({
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    llm: { listProviders: () => [] },
    logger: { warn() {} },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { disposeEffect = fn() },
  })
  t.after(async () => {
    await disposeEffect?.()
    await rm(dir, { recursive: true, force: true })
  })

  const postHeaders = { 'x-career-agent': '1', 'content-type': 'application/json' }

  // 1. Normal JSON POST right under 500,000 bytes (chunked stream) succeeds
  const validPayload = JSON.stringify({ action: 'configure', config: { goal: 'AI Infra', searchTerms: ['Kubernetes'] } })
  const chunkedValid = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(validPayload.slice(0, 20)))
      controller.enqueue(enc.encode(validPayload.slice(20)))
      controller.close()
    },
  })
  const okRes = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: postHeaders,
    body: chunkedValid,
  })
  assert.equal(okRes.status, 200)
  assert.equal((await okRes.json()).ok, true)

  // 2. Declared Content-Length > 500,000 on /action rejects immediately without pulling any chunks
  const declaredOver = createCountingStream(64 * 1024, 16)
  const declaredRes = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: { ...postHeaders, 'content-length': String(500_001) },
    body: declaredOver.stream,
  })
  assert.equal(declaredRes.status, 400)
  assert.equal((await declaredRes.json()).error, '提交的数据过大。')
  assert.equal(declaredOver.pulled, 0, 'oversize Content-Length must reject without reading stream')

  // 3. Chunked stream WITHOUT Content-Length exceeding 500,000 bytes stops immediately after crossing limit
  //    8 chunks * 64 KiB = 524,288 > 500,000; stream has 40 total chunks (2.5 MiB)
  const chunkedOverAction = createCountingStream(64 * 1024, 40)
  const chunkedActionRes = await harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: postHeaders,
    body: chunkedOverAction.stream,
  })
  assert.equal(chunkedActionRes.status, 400)
  assert.equal((await chunkedActionRes.json()).error, '提交的数据过大。')
  assert.ok(chunkedOverAction.pulled <= 9, `expected early stop around 8 chunks, got ${chunkedOverAction.pulled}`)

  // 4. parse-resume-file ALLOWS payloads > 500,000 bytes (up to 22 MiB)
  const resumeText = '# Alex Chen\n\n## Experience\n' + '- Built high-throughput distributed services.\n'.repeat(11_000)
  const largeResumeJson = JSON.stringify({
    filename: 'alex-resume.md',
    mimeType: 'text/markdown',
    dataBase64: Buffer.from(resumeText, 'utf8').toString('base64'),
    useAi: false,
  })
  assert.ok(Buffer.byteLength(largeResumeJson) > 500_000, 'test payload must exceed 500 KB normal JSON cap')
  assert.ok(Buffer.byteLength(largeResumeJson) < 22 * 1024 * 1024)
  const parseOkRes = await harness.dispatch('/api/career-agent/parse-resume-file', {
    method: 'POST',
    headers: postHeaders,
    body: largeResumeJson,
  })
  assert.equal(parseOkRes.status, 200)
  const parseOkData = await parseOkRes.json()
  assert.equal(parseOkData.ok, true)
  assert.ok(parseOkData.result.text.includes('Alex Chen'))

  // 5. parse-resume-file rejects declared Content-Length > 22 MiB with 0 chunks pulled
  const declaredOverResume = createCountingStream(1024 * 1024, 30)
  const declaredResumeRes = await harness.dispatch('/api/career-agent/parse-resume-file', {
    method: 'POST',
    headers: { ...postHeaders, 'content-length': String(22 * 1024 * 1024 + 1) },
    body: declaredOverResume.stream,
  })
  assert.equal(declaredResumeRes.status, 400)
  assert.equal((await declaredResumeRes.json()).error, '提交的数据过大。')
  assert.equal(declaredOverResume.pulled, 0)

  // 6. parse-resume-file chunked stream > 22 MiB stops early (23 * 1 MiB > 22 MiB out of 35 total MiB)
  const chunkedOverResume = createCountingStream(1024 * 1024, 35)
  const chunkedResumeRes = await harness.dispatch('/api/career-agent/parse-resume-file', {
    method: 'POST',
    headers: postHeaders,
    body: chunkedOverResume.stream,
  })
  assert.equal(chunkedResumeRes.status, 400)
  assert.equal((await chunkedResumeRes.json()).error, '提交的数据过大。')
  assert.ok(chunkedOverResume.pulled <= 24, `expected early stop around 23 chunks, got ${chunkedOverResume.pulled}`)

  // 7. Mid-upload AbortSignal cancels pending streaming POST body read promptly
  const uploadAbort = new AbortController()
  const pendingRead = Promise.withResolvers()
  let uploadCancelled = false
  let firstChunkSent = false
  const stalledStream = new ReadableStream({
    pull(controller) {
      if (!firstChunkSent) {
        firstChunkSent = true
        controller.enqueue(new TextEncoder().encode('{"action":"configure",'))
        return
      }
      pendingRead.resolve()
    },
    cancel() {
      uploadCancelled = true
    },
  }, { highWaterMark: 0 })

  const uploadResponse = harness.dispatch('/api/career-agent/action', {
    method: 'POST',
    headers: postHeaders,
    body: stalledStream,
    signal: uploadAbort.signal,
  })
  await pendingRead.promise
  uploadAbort.abort()
  const abortedUploadRes = await uploadResponse
  assert.equal(abortedUploadRes.status, 400)
  assert.equal((await abortedUploadRes.json()).error, '请求已取消。')
  assert.equal(uploadCancelled, true, 'aborting request signal must cancel in-flight POST upload stream')
})
