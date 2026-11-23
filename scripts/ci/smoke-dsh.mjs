import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [archivePath, runtimeDir] = process.argv.slice(2)
assert(archivePath && runtimeDir, 'Usage: node scripts/ci/smoke-dsh.mjs <package.tgz> <DSH runtime directory>')
const archive = resolve(archivePath)
const cli = resolve(runtimeDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const isWindows = process.platform === 'win32'
const scratch = await mkdtemp(join(tmpdir(), 'niuma-dsh-ci-'))
const home = join(scratch, 'home')
const workspace = join(scratch, 'empty-workspace')
const profile = 'release-smoke'
const profileArgs = ['--profile', profile]
const apiPath = '/api/career-agent/'
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PNPM_HOME|LANG|LC_ALL|LOGNAME|SHELL|USER|CI)$/i.test(key),
))

// Give the host only disposable data directories and the credentials for the loopback mock.
const pathKey = Object.keys(env).find((key) => /^path$/i.test(key)) || 'PATH'
env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter)
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  TMPDIR: join(scratch, 'tmp'),
  TEMP: join(scratch, 'tmp'),
  TMP: join(scratch, 'tmp'),
  NO_COLOR: '1',
  NO_PROXY: 'localhost,127.0.0.1',
  npm_config_registry: 'https://registry.npmjs.org',
  QA_STREAM_TEST_KEY: 'synthetic-key',
})
if (isWindows) {
  env.APPDATA = join(home, 'AppData', 'Roaming')
  env.LOCALAPPDATA = join(home, 'AppData', 'Local')
}

const requestedModelBodies = []
const model = 'qa-local:qa-stream'
const mock = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requestedModelBodies.push(Buffer.concat(chunks).toString('utf8'))
  const content = JSON.stringify({
    title: 'QA mock accepted',
    markdown: '# QA mock accepted\n\n## Experience\n- Synthesized from the intentionally synthetic local fixture.',
  })
  const reply = { id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: 1, model: 'qa-stream' }
  const delta = { index: 0, delta: { role: 'assistant', content }, finish_reason: null }
  const done = { index: 0, delta: {}, finish_reason: 'stop' }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  response.end(`data: ${JSON.stringify({ ...reply, choices: [delta] })}\n\ndata: ${JSON.stringify({ ...reply, choices: [done] })}\n\ndata: [DONE]\n\n`)
})

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const cjkDocx = { name: 'resume-default.docx', mime: docx, visible: ['测试候选人', 'candidate@example.com', 'GPU 调度'] }
const cjkTwoPages = {
  ...cjkDocx, name: 'resume-two-pages.docx', visible: [...cjkDocx.visible, '第二页项目经历'],
}
const revisedDocx = {
  ...cjkDocx, name: 'resume-with-revisions.docx',
  visible: [...cjkDocx.visible, 'CURRENT_RESUME_TEXT'], hidden: ['OUTDATED_RESUME_TEXT'],
}
const pagedDocx = {
  name: 'two-explicit-pages.docx', mime: docx,
  visible: ['FIRST_HEADER', 'EVEN_HEADER', 'FIRST_PAGE_BODY', 'SECOND_PAGE_BODY'], hidden: ['DEFAULT_HEADER'],
}
const pagedDocxFallback = {
  ...pagedDocx, visible: ['FIRST_HEADER', 'FIRST_PAGE_BODY', 'SECOND_PAGE_BODY'], hidden: ['EVEN_HEADER', 'DEFAULT_HEADER'],
}
const conditionalDocx = {
  name: 'word-conditional-row-control.docx', mime: docx,
  visible: ['VISIBLE_BODY', 'ROW_TWO_PUBLIC'],
}
const pdf = { name: 'mixed-gb-resume.pdf', mime: 'application/pdf', visible: ['Experience', '张三', '后端工程师', '项目经历'] }
const txt = { name: 'resume-plain.txt', mime: 'text/plain', visible: ['测试候选人', 'GPU 调度'] }
const legacyRtf = {
  name: 'legacy-hidden.rtf', mime: 'text/rtf', method: 'textutil',
  visible: ['QA_PUBLIC_LINE', 'QA_PUBLIC_NEXT'],
}
const hiddenHtml = {
  name: 'resume-hidden.html', mime: 'text/html', method: 'html', visible: ['Visible Candidate'],
}
const hiddenOdt = {
  name: 'resume-hidden.odt', mime: 'application/vnd.oasis.opendocument.text', method: 'odt', visible: ['Visible Candidate'],
}

const cleanLog = (value) => value.replace(/\u001b\[[0-9;]*m/g, '')
const redact = (value) => cleanLog(value).replace(/(\?token=)[^\s]+/g, '$1[redacted]')

function runCli(args) {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: workspace, env, encoding: 'utf8', timeout: 120_000, windowsHide: true,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    throw new Error(`DSH ${args[0]} failed: ${redact(`${error.stdout || ''}\n${error.stderr || error.message}`).slice(-6000)}`)
  }
}

let host
async function stopHost() {
  if (!host) return
  const child = host
  host = undefined
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (isWindows) {
    const taskkill = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      execFileSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 8_000 })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      else if (error.code !== 'ESRCH') throw error
    }
  } else {
    process.kill(-child.pid, 'SIGTERM')
  }
  if (await Promise.race([exited.then(() => true), delay(6_000, false, { ref: false })])) return
  if (isWindows) child.kill()
  else process.kill(-child.pid, 'SIGKILL')
  assert(await Promise.race([exited.then(() => true), delay(4_000, false, { ref: false })]), 'DSH host did not stop')
}

async function startHost(patch) {
  host = spawn(process.execPath, [cli, ...profileArgs, '--patch', patch, '--no-open', '--port', '0'], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows, windowsHide: true,
  })
  let log = ''
  const append = (chunk) => { log = (log + chunk).slice(-24_000) }
  for (const stream of [host.stdout, host.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', append)
  }
  let launchError
  host.on('error', (error) => { launchError = error })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !launchError && host.exitCode === null && host.signalCode === null) {
    const entry = cleanLog(log).match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s]*\?token=[^\s]+/)?.[0]
    if (entry) {
      const origin = new URL(entry).origin
      const response = await fetch(entry, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      const cookie = response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
      assert(cookie, 'DSH Web did not set a session cookie')
      const landing = response.status === 302 || response.status === 303
        ? await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
        : response
      assert.equal(landing.status, 200, 'DSH Web login')
      assert.match(await landing.text(), /<html/i, 'DSH Web returned no HTML')
      return { origin, cookie }
    }
    await delay(120)
  }
  throw new Error(`DSH Web could not start: ${patch}\n${redact(`${launchError?.message || ''}\n${log}`).slice(-6000)}`)
}

function request({ origin, cookie }, route, data) {
  const headers = { 'x-career-agent': '1', 'x-career-locale': 'en' }
  if (cookie) headers.cookie = cookie
  if (data !== undefined) headers['content-type'] = 'application/json'
  return fetch(origin + apiPath + route, {
    headers, method: data === undefined ? 'GET' : 'POST', body: JSON.stringify(data),
    redirect: 'manual', signal: AbortSignal.timeout(90_000),
  })
}

async function checked(session, route, data) {
  const response = await request(session, route, data)
  const body = await response.text()
  assert.equal(response.status, 200, `${route}: ${redact(body).slice(0, 300)}`)
  return JSON.parse(body)
}

async function upload(session, fixture, useAi = false) {
  const bytes = await readFile(new URL(`./fixtures/${fixture.name}`, import.meta.url))
  return (await checked(session, 'parse-resume-file', {
    filename: fixture.name, mimeType: fixture.mime, dataBase64: bytes.toString('base64'),
    useAi, explicitUseAi: useAi, model,
  })).result
}

function assertVisible(text, fixture) {
  for (const marker of fixture.visible) assert(text.includes(marker), `${fixture.name} lost ${marker}`)
  for (const marker of fixture.hidden || []) assert(!text.includes(marker), `${fixture.name} exposed ${marker}`)
}

const saved = new Map()
async function preview(session, id, fixture) {
  const { result } = await checked(session, 'local-preview', { id, template: 'onyx' })
  assertVisible(result.html, fixture)
}

async function saveAndPreview(session, title, text, fixture) {
  const { result } = await checked(session, 'action', { action: 'resume-import', title, text })
  const id = result.id
  assert(id, `${fixture.name} returned no saved resume ID`)
  assert((await checked(session, 'action', { action: 'resume-review', id, decision: 'approve' })).ok)
  await preview(session, id, fixture)
  saved.set(id, fixture)
}

async function exercise(session, stage, fixture, methods, { localOnly = false, requestAi = localOnly } = {}) {
  const callsBefore = requestedModelBodies.length
  const parsed = await upload(session, fixture, requestAi)
  assert(methods.includes(parsed.method), `${stage} ${fixture.name} returned ${parsed.method}, expected ${methods.join(' or ')}`)
  assertVisible(parsed.text, fixture)
  assert.equal(parsed.structuredByAi, false, `${stage} ${fixture.name} was structured by AI`)
  assert.equal(requestedModelBodies.length, callsBefore, `${stage} ${fixture.name} called the model`)
  if (localOnly) {
    assert.equal(parsed.visibilityUncertain, true, `${fixture.name} did not report visibility limits`)
    assert(parsed.warning, `${fixture.name} did not warn users before saving local text`)
  }
  await saveAndPreview(session, `QA ${stage} ${parsed.title}`, parsed.text, fixture)
  console.log(`${stage}: ${fixture.name}, ${parsed.method}, saved and previewed`)
}

try {
  await Promise.all([workspace, env.TMPDIR, home, env.APPDATA, env.LOCALAPPDATA].filter(Boolean).map((dir) => mkdir(dir, { recursive: true })))
  const version = runCli(['--version'])
  runCli([...profileArgs, '--from-default-profile', 'web', '--dump-config'])
  runCli(['plugin', ...profileArgs, 'add', archive])
  const manifestPath = 'profiles/release-smoke/node_modules/dsh-niuma-broker/package.json'
  const installed = JSON.parse(await readFile(join(home, manifestPath), 'utf8'))
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(installed.name, packageJson.name)
  assert.equal(installed.version, packageJson.version)
  console.log(`Installed ${installed.name}@${installed.version} via official DSH ${version} (${process.platform})`)

  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const enabled = join(scratch, 'mock.yml')
  const disabled = join(scratch, 'without-office-kit.yml')
  const patch = `- id: llm-pi-ai
  config:
    providers:
      qa-local:
        displayName: QA local mock
        apiKeyEnv: QA_STREAM_TEST_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${mock.address().port}/v1
        models:
          - id: qa-stream
            contextWindow: 40000
            maxTokens: 4096
`
  await Promise.all([
    writeFile(enabled, patch),
    writeFile(disabled, patch + '- id: office-kit\n  disabled: true\n'),
  ])

  let session = await startHost(enabled)
  const unauthenticated = await request({ origin: session.origin }, 'state')
  assert([401, 403].includes(unauthenticated.status), `Unauthenticated state returned ${unauthenticated.status}`)
  await unauthenticated.body?.cancel()
  const models = await checked(session, 'models')
  assert(models.some((item) => item.provider === 'qa-local' && item.id === 'qa-stream'), 'Mock model is unavailable')
  const pdfMethods = process.platform === 'darwin' ? ['pdfkit', 'pdf-ocr', 'unpdf'] : ['unpdf']
  await exercise(session, 'Office Kit enabled', pagedDocx, ['office-kit'])
  // The Windows runner can lack CJK fonts. The English fixture above still requires native Office Kit.
  const cjkMethods = isWindows ? ['office-kit', 'docx'] : ['office-kit']
  await exercise(session, 'Office Kit enabled', cjkDocx, cjkMethods)
  await exercise(session, 'Office Kit enabled', cjkTwoPages, cjkMethods)
  await exercise(session, 'Office Kit enabled', revisedDocx, ['docx'], { localOnly: true })
  await exercise(session, 'Office Kit enabled', pdf, pdfMethods)
  await exercise(session, 'Office Kit enabled', txt, ['text'])
  const aiFixture = isWindows ? pagedDocx : cjkTwoPages
  const aiResult = await upload(session, aiFixture, true)
  assert.equal(aiResult.method, 'office-kit')
  assert.equal(aiResult.structuredByAi, true)
  assert.equal(requestedModelBodies.length, 1, 'Explicit Office Kit AI should call the loopback model once')
  assertVisible(requestedModelBodies[0], aiFixture)
  await saveAndPreview(session, aiResult.title, aiResult.text, {
    name: aiFixture.name, visible: ['QA mock accepted', 'Synthesized from the intentionally synthetic local fixture'],
  })
  requestedModelBodies.length = 0
  console.log('Native DOCX called the loopback model once with visible text only')

  await stopHost()
  session = await startHost(disabled)
  await exercise(session, 'Office Kit disabled', cjkDocx, ['docx'], { localOnly: true })
  await exercise(session, 'Office Kit disabled', cjkTwoPages, ['docx'], { localOnly: true })
  await exercise(session, 'Office Kit disabled', pagedDocxFallback, ['docx'], { localOnly: true })
  await exercise(session, 'Office Kit disabled', conditionalDocx, ['docx'], { localOnly: true })
  await exercise(session, 'Office Kit disabled', pdf, pdfMethods)
  await exercise(session, 'Office Kit disabled', txt, ['text'])
  const localReview = [hiddenHtml, hiddenOdt]
  if (process.platform === 'darwin') localReview.push(legacyRtf)
  for (const fixture of localReview) {
    const parsed = await upload(session, fixture, true)
    assert.equal(parsed.method, fixture.method)
    assert.equal(parsed.visibilityUncertain, true, `${fixture.name} must flag the limits of local extraction`)
    assert.equal(parsed.structuredByAi, false, `${fixture.name} was structured by AI`)
    assert(parsed.warning, `${fixture.name} must ask the user to review the local text`)
    assertVisible(parsed.text, fixture)
    console.log(`${fixture.name} stayed in local review after an explicit AI request`)
  }
  assert.equal(requestedModelBodies.length, 0, 'Local previews called the loopback model')

  await stopHost()
  session = await startHost(enabled)
  const state = await checked(session, 'state')
  for (const [id, fixture] of saved) {
    assert(state.resumes.some((resume) => resume.id === id), `${fixture.name} did not survive DSH restart`)
    await preview(session, id, fixture)
  }
  console.log(`Restarted official DSH Web and re-previewed all ${saved.size} approved resumes`)
} finally {
  try {
    await stopHost()
  } finally {
    if (mock.listening) {
      mock.closeAllConnections()
      await new Promise((resolveClose) => mock.close(resolveClose))
    }
    await rm(scratch, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 })
  }
}
