import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLISH_SCRIPT = join(ROOT, 'scripts/ci/release-publish.mjs')
const PACK_SCRIPT = join(ROOT, 'pack-release.mjs')

test('simulated release publish creates annotated tag, publishes exact archive, and uses checked-in release notes', async t => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const sandbox = await mkdtemp(join(tmpdir(), 'niuma-release-sim-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))

  const originDir = join(sandbox, 'origin.git')
  const workDir = join(sandbox, 'work')
  const candidateDir = join(sandbox, 'candidate')
  const shimDir = join(sandbox, 'bin')
  const statePath = join(sandbox, 'sim-state.json')
  const logPath = join(sandbox, 'sim-calls.jsonl')
  const missingRoot = join(sandbox, 'missing-notes-root')

  await Promise.all([
    mkdir(originDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(candidateDir, { recursive: true }),
    mkdir(shimDir, { recursive: true }),
    mkdir(missingRoot, { recursive: true }),
  ])

  // Pack the real candidate archive + SHA256SUMS.txt into sandbox
  const packedArchivePath = execFileSync(process.execPath, [PACK_SCRIPT, candidateDir], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  const filename = `${pkg.name}-${pkg.version}.tgz`
  const archiveBytes = await readFile(packedArchivePath)
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
  const sha512Integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
  await writeFile(join(candidateDir, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`, 'utf8')

  // Bare git remote + work clone so `git ls-remote origin` exercises real annotated tag resolution
  execFileSync('git', ['init', '--bare', originDir], { stdio: 'ignore' })
  execFileSync('git', ['init', '-b', 'main', workDir], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Sim Tester'], { cwd: workDir })
  execFileSync('git', ['config', 'user.email', 'sim@example.test'], { cwd: workDir })
  await writeFile(join(workDir, 'README.md'), 'sim\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: workDir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir, stdio: 'ignore' })
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }).trim()
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workDir })
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: workDir, stdio: 'ignore' })

  await writeFile(statePath, JSON.stringify({ published: false, release: null }), 'utf8')
  await writeFile(logPath, '', 'utf8')

  // Loopback fake npm registry (supports configurable 404 propagation lag after publish)
  const registry = createServer(async (req, res) => {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (req.url === `/${encodeURIComponent(pkg.name)}/${pkg.version}`) {
      if (!state.published) {
        res.writeHead(404).end('Not Found')
        return
      }
      if ((state.lagPolls ?? 0) > 0) {
        state.lagPolls -= 1
        await writeFile(statePath, JSON.stringify(state), 'utf8')
        res.writeHead(404).end('Propagating')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: pkg.version, dist: { integrity: sha512Integrity } }))
      return
    }
    res.writeHead(404).end()
  })
  registry.listen(0, '127.0.0.1')
  await once(registry, 'listening')
  t.after(() => registry.close())
  const registryBase = `http://127.0.0.1:${registry.address().port}`

  // Shims for `npm` and `gh` capturing exact invocations & stdin payloads
  const ghShim = join(shimDir, 'gh')
  const npmShim = join(shimDir, 'npm')
  await writeFile(ghShim, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
let stdinText = ''
if (args.includes('--input')) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  stdinText = Buffer.concat(chunks).toString('utf8')
}
const statePath = process.env.NIUMA_SIM_STATE
const logPath = process.env.NIUMA_SIM_LOG
const originDir = process.env.NIUMA_SIM_ORIGIN
const state = JSON.parse(readFileSync(statePath, 'utf8'))
appendFileSync(logPath, JSON.stringify({ bin: 'gh', args, stdin: stdinText }) + '\\n')

if (args[0] === 'release' && args[1] === 'view') {
  if (!state.release) {
    process.stderr.write('release not found\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(state.release))
  process.exit(0)
}
if (args[0] === 'api' && args.includes('POST') && args.some(a => a.endsWith('/git/tags'))) {
  const payload = JSON.parse(stdinText)
  const tagObjectText = [
    \`object \${payload.object}\`,
    \`type \${payload.type}\`,
    \`tag \${payload.tag}\`,
    \`tagger \${payload.tagger.name} <\${payload.tagger.email}> 1795500000 +0000\`,
    '',
    payload.message,
    '',
  ].join('\\n')
  const tagSha = execFileSync('git', ['--git-dir', originDir, 'hash-object', '-t', 'tag', '-w', '--stdin'], {
    input: tagObjectText,
    encoding: 'utf8',
  }).trim()
  process.stdout.write(tagSha + '\\n')
  process.exit(0)
}
if (args[0] === 'api' && args.includes('POST') && args.some(a => a.endsWith('/git/refs'))) {
  const refArg = args.find(a => a.startsWith('ref='))?.slice(4)
  const shaArg = args.find(a => a.startsWith('sha='))?.slice(4)
  execFileSync('git', ['--git-dir', originDir, 'update-ref', refArg, shaArg])
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'create') {
  const notesIdx = args.indexOf('--notes-file')
  const titleIdx = args.indexOf('--title')
  state.release = {
    tag: args[2],
    title: titleIdx >= 0 ? args[titleIdx + 1] : '',
    notesFile: notesIdx >= 0 ? args[notesIdx + 1] : '',
    notesText: notesIdx >= 0 ? readFileSync(args[notesIdx + 1], 'utf8') : '',
    isDraft: args.includes('--draft'),
    isPrerelease: false,
    assets: [],
  }
  writeFileSync(statePath, JSON.stringify(state))
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'download') {
  const pattern = args[args.indexOf('--pattern') + 1]
  const dir = args[args.indexOf('--dir') + 1]
  writeFileSync(join(dir, pattern), readFileSync(join(process.env.NIUMA_SIM_CANDIDATE, pattern)))
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'upload') {
  const files = args.slice(3, args.indexOf('--repo'))
  for (const f of files) {
    state.release.assets.push({ name: basename(f), sha256: process.env.NIUMA_EXPECTED_SHA || '' })
  }
  writeFileSync(statePath, JSON.stringify(state))
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'edit' && args.includes('--draft=false')) {
  state.release.isDraft = false
  writeFileSync(statePath, JSON.stringify(state))
  process.exit(0)
}
process.exit(0)
`, 'utf8')

  await writeFile(npmShim, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const statePath = process.env.NIUMA_SIM_STATE
const logPath = process.env.NIUMA_SIM_LOG
const state = JSON.parse(readFileSync(statePath, 'utf8'))
appendFileSync(logPath, JSON.stringify({ bin: 'npm', args }) + '\\n')
if (args[0] === 'publish') {
  state.published = true
  writeFileSync(statePath, JSON.stringify(state))
}
process.exit(0)
`, 'utf8')

  await Promise.all([chmod(ghShim, 0o755), chmod(npmShim, 0o755)])

  const baseEnv = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'Nimbus318/dsh-niuma-broker',
    GITHUB_SHA: commitSha,
    NIUMA_RELEASE_REGISTRY_BASE: registryBase,
    NIUMA_SIM_STATE: statePath,
    NIUMA_SIM_LOG: logPath,
    NIUMA_SIM_ORIGIN: originDir,
    NIUMA_SIM_CANDIDATE: candidateDir,
    NIUMA_EXPECTED_SHA: sha256,
  }

  // 1. Missing release notes must fail BEFORE calling npm publish or gh
  await assert.rejects(
    execFileAsync(process.execPath, [PUBLISH_SCRIPT, candidateDir], {
      cwd: workDir,
      env: { ...baseEnv, NIUMA_RELEASE_ROOT: missingRoot },
      encoding: 'utf8',
    }),
    err => {
      assert.match(err.stderr, new RegExp(`Add \\.github/release-notes/v${pkg.version.replace(/\./g, '\\.')}\\.md before publishing\\.`))
      return true
    },
  )
  assert.equal(await readFile(logPath, 'utf8'), '', 'Missing release notes must fail fast before invoking gh or npm')

  // 2. Full simulated release publish with checked-in bilingual release notes
  await execFileAsync(process.execPath, [PUBLISH_SCRIPT, candidateDir], {
    cwd: workDir,
    env: baseEnv,
    encoding: 'utf8',
  })

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const tagCall = calls.find(c => c.bin === 'gh' && c.args.includes(`repos/Nimbus318/dsh-niuma-broker/git/tags`))
  assert.ok(tagCall, 'Must create an annotated tag object via git/tags API')
  const tagPayload = JSON.parse(tagCall.stdin)
  assert.equal(tagPayload.tag, `v${pkg.version}`)
  assert.equal(tagPayload.type, 'commit')
  assert.equal(tagPayload.object, commitSha)
  assert.equal(tagPayload.message, `Niuma Broker ${pkg.version}`)

  const refCall = calls.find(c => c.bin === 'gh' && c.args.includes(`repos/Nimbus318/dsh-niuma-broker/git/refs`))
  assert.ok(refCall)
  const shaArg = refCall.args.find(a => a.startsWith('sha='))?.slice(4)
  assert.notEqual(shaArg, commitSha, 'Tag ref must point to the annotated tag object SHA, not raw commit SHA')

  // Verify real git ls-remote sees the annotated tag pointing to commitSha
  const lsRemote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${pkg.version}`, `refs/tags/v${pkg.version}^{}`], {
    cwd: workDir,
    encoding: 'utf8',
  })
  assert.match(lsRemote, new RegExp(`${commitSha}\\s+refs/tags/v${pkg.version}\\^\\{\\}`))

  const publishCall = calls.find(c => c.bin === 'npm' && c.args[0] === 'publish')
  assert.ok(publishCall)
  assert.equal(publishCall.args[1], packedArchivePath, 'npm publish must target the exact verified archive')
  assert.ok(publishCall.args.includes('--access') && publishCall.args.includes('public'))

  const releaseState = JSON.parse(await readFile(statePath, 'utf8')).release
  assert.equal(releaseState.title, `牛马经纪人 ${pkg.version} · Niuma Broker`)
  assert.match(releaseState.notesText, /^## 中文/m)
  assert.match(releaseState.notesText, /^## English/m)
  assert.equal(releaseState.isDraft, false)
  assert.deepEqual(releaseState.assets.map(a => a.name).sort(), ['SHA256SUMS.txt', filename].sort())

  // 3. Re-running with the same archive & commit is idempotent and does not re-publish
  await writeFile(logPath, '', 'utf8')
  const replay = await execFileAsync(process.execPath, [PUBLISH_SCRIPT, candidateDir], {
    cwd: workDir,
    env: baseEnv,
    encoding: 'utf8',
  })
  assert.match(replay.stdout, new RegExp(`npm already has the verified ${pkg.name}@${pkg.version} archive\\.`))
  const replayCalls = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(replayCalls.some(c => c.bin === 'npm' && c.args[0] === 'publish'), false)

  // 4. Transient 404 propagation lag after publish recovers cleanly across retry steps
  await writeFile(statePath, JSON.stringify({ published: false, lagPolls: 2, release: null }), 'utf8')
  await writeFile(logPath, '', 'utf8')
  await execFileAsync(process.execPath, [PUBLISH_SCRIPT, candidateDir], {
    cwd: workDir,
    env: { ...baseEnv, NIUMA_RELEASE_POLL_DELAYS: '0,10,10,10' },
    encoding: 'utf8',
  })
  const laggedRelease = JSON.parse(await readFile(statePath, 'utf8')).release
  assert.equal(laggedRelease?.isDraft, false)

  // 5. Exhausted propagation retries throw the actionable timeout error before creating a release
  await writeFile(statePath, JSON.stringify({ published: false, lagPolls: 10, release: null }), 'utf8')
  await assert.rejects(
    execFileAsync(process.execPath, [PUBLISH_SCRIPT, candidateDir], {
      cwd: workDir,
      env: { ...baseEnv, NIUMA_RELEASE_POLL_DELAYS: '0,10,10' },
      encoding: 'utf8',
    }),
    err => {
      assert.match(err.stderr, /npm did not return the published archive integrity yet\. Retry this run\./)
      return true
    },
  )
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).release, null)
})
