import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildReleaseCreateArgs,
  releaseTitleFor,
  requireReleaseNotesFile,
  validateBilingualReleaseNotes,
} from '../scripts/ci/release-notes.mjs'
import { getPackManifest } from '../pack-release.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function flattenLeafKeys(value, prefix = '') {
  const keys = []
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      keys.push(...flattenLeafKeys(entry, path))
    } else {
      keys.push(path)
    }
  }
  return keys.sort()
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

function isCoveredByPackageFiles(target, files) {
  const rel = target.replace(/^\.\//, '')
  if (rel === 'package.json') return true
  return files.some(entry => {
    const clean = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    return rel === clean || rel.startsWith(`${clean}/`)
  })
}

test('locale metadata and UI message catalogs maintain exact leaf-key parity', () => {
  for (const [zhPath, enPath] of [
    ['locale/zh.json', 'locale/en.json'],
    ['locale/messages/zh.json', 'locale/messages/en.json'],
  ]) {
    const zhKeys = flattenLeafKeys(readJson(zhPath))
    const enKeys = flattenLeafKeys(readJson(enPath))
    assert.deepEqual(zhKeys, enKeys, `${zhPath} and ${enPath} keys diverged`)
  }
})

test('package.json files entries exist and cover all non-wildcard exports', () => {
  const pkg = readJson('package.json')
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(ROOT, entry)), `Missing package files entry: ${entry}`)
  }
  assert.ok(existsSync(join(ROOT, 'dist', 'client.js')), 'Missing built dist/client.js; run `npm run build`.')

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.equal(typeof target, 'string', `Expected string export target for ${subpath}`)
    if (target.includes('*')) continue
    assert.ok(
      isCoveredByPackageFiles(target, pkg.files),
      `Export ${subpath} -> ${target} is not covered by package.json files`,
    )
  }
})

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'artifacts'])

function walkFilesPosix(dir, baseDir = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && WALK_SKIP_DIRS.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFilesPosix(abs, baseDir))
    } else if (entry.isFile()) {
      out.push(relative(baseDir, abs).replace(/\\/g, '/'))
    }
  }
  return out
}

test('packed npm manifest covers all exports (exact and wildcard), assets, zero runtime deps, and excludes examples and dev files', () => {
  const pkg = readJson('package.json')
  const manifest = getPackManifest(ROOT)
  const packedPaths = manifest.files.map(entry => entry.path.replace(/\\/g, '/'))
  const packedSet = new Set(packedPaths)

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const cleanTarget = target.replace(/^\.\//, '')
    if (!cleanTarget.includes('*')) {
      assert.ok(packedSet.has(cleanTarget), `Export ${subpath} -> ${cleanTarget} missing from npm pack manifest`)
      continue
    }
    const prefixBeforeWildcard = cleanTarget.slice(0, cleanTarget.indexOf('*'))
    const lastSlash = prefixBeforeWildcard.lastIndexOf('/')
    const baseDirName = lastSlash >= 0 ? prefixBeforeWildcard.slice(0, lastSlash) : ''
    const searchRoot = baseDirName ? join(ROOT, baseDirName) : ROOT
    const regexStr = `^${cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`
    const matcher = new RegExp(regexStr)
    const repoMatches = walkFilesPosix(searchRoot, ROOT).filter(p => matcher.test(p))
    assert.ok(repoMatches.length > 0, `Wildcard export ${subpath} -> ${cleanTarget} matched 0 source files in repo`)
    for (const candidate of repoMatches) {
      assert.ok(
        packedSet.has(candidate),
        `Wildcard export ${subpath} -> ${cleanTarget} expects ${candidate}, which is missing from npm pack manifest`,
      )
    }
  }

  for (const required of [
    pkg.main?.replace(/^\.\//, ''),
    pkg.icon?.replace(/^\.\//, ''),
    pkg.dsh?.bundle?.patch?.replace(/^\.\//, ''),
    'dist/client.js',
  ].filter(Boolean)) {
    assert.ok(packedSet.has(required), `Required package entry ${required} missing from npm pack manifest`)
  }

  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Plugin must have zero runtime dependencies')
  assert.equal(Object.keys(pkg.optionalDependencies || {}).length, 0, 'Plugin must have zero optionalDependencies')
  assert.deepEqual(Object.keys(pkg.devDependencies || {}).sort(), ['esbuild'], 'Only esbuild is allowed in devDependencies')

  assert.ok(existsSync(join(ROOT, 'examples', 'recording-connector.mjs')), 'Recording example must live under repo-root examples/')
  assert.equal(existsSync(join(ROOT, 'src', 'examples')), false, 'src/examples must be moved out of src/')

  const forbiddenPrefixes = ['src/examples/', 'examples/', 'test/', 'client/', 'scripts/', '.github/']
  const forbiddenExact = new Set(['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'])
  for (const filePath of packedPaths) {
    assert.equal(
      forbiddenPrefixes.some(prefix => filePath.startsWith(prefix)) || forbiddenExact.has(filePath),
      false,
      `Disallowed file in npm pack manifest: ${filePath}`,
    )
  }
})

test('current package version has curated bilingual release notes and fails CI if missing or incomplete', async t => {
  const pkg = readJson('package.json')
  const { notesPath, content } = await requireReleaseNotesFile(pkg.version, ROOT)
  assert.ok(existsSync(notesPath))
  validateBilingualReleaseNotes(content, pkg.version)

  const sandbox = await mkdtemp(join(tmpdir(), 'niuma-release-notes-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  await mkdir(join(sandbox, '.github', 'release-notes'), { recursive: true })
  await writeFile(join(sandbox, '.github', 'release-notes', 'v0.0.1.md'), '   \n', 'utf8')
  await writeFile(join(sandbox, '.github', 'release-notes', 'v0.0.2.md'), '## 中文\n- 仅中文说明\n', 'utf8')
  await writeFile(join(sandbox, '.github', 'release-notes', 'v0.0.3.md'), '## 中文\n- 中文条目\n\n## English\n\n', 'utf8')
  await writeFile(
    join(sandbox, '.github', 'release-notes', 'v0.0.4.md'),
    '## 中文\n- 修复问题\n\n## English\n- Fixed bug.\n',
    'utf8',
  )

  await assert.rejects(
    requireReleaseNotesFile('9.9.9', sandbox),
    /Add \.github\/release-notes\/v9\.9\.9\.md before publishing\./,
  )
  await assert.rejects(
    requireReleaseNotesFile('0.0.1', sandbox),
    /Release notes for v0\.0\.1 are empty\./,
  )
  await assert.rejects(
    requireReleaseNotesFile('0.0.2', sandbox),
    /must include a non-empty "## English" section\./,
  )
  await assert.rejects(
    requireReleaseNotesFile('0.0.3', sandbox),
    /must include a non-empty "## English" section\./,
  )
  const valid = await requireReleaseNotesFile('0.0.4', sandbox)
  assert.match(valid.content, /Fixed bug/)

  const args = buildReleaseCreateArgs({
    tag: `v${pkg.version}`,
    version: pkg.version,
    repository: 'Nimbus318/dsh-niuma-broker',
    commit: '634964104fdc45f32e62b25bbc4ab79a81268bce',
    notesPath,
  })
  assert.deepEqual(args, [
    'release', 'create', `v${pkg.version}`, '--repo', 'Nimbus318/dsh-niuma-broker', '--verify-tag',
    '--target', '634964104fdc45f32e62b25bbc4ab79a81268bce',
    '--title', releaseTitleFor(pkg.version), '--notes-file', notesPath, '--draft',
  ])
})

const LEAK_PATTERNS = [
  { label: 'macOS user home path', re: /\/Users\/[^\s)'"`]+/ },
  { label: 'Linux user home path', re: /\/home\/[^\s)'"`]+/ },
  { label: 'temp directory path', re: /(?:\/private\/tmp\/|\/tmp\/)[^\s)'"`]+/ },
  { label: 'Windows user home path', re: /[A-Za-z]:\\Users\\[^\s)'"`]+/ },
  { label: 'internal finding ID', re: /\b[Ff]0\d+\b/ },
  { label: 'collaboration status marker', re: /\b[Ff]\d+=(?:open|closed|needs-verify|fixed)\b/ },
  { label: 'collaboration block sentinel', re: /<!--\s*END:(?:codex|claude|antigravity|grok)-/ },
]

function findHygieneLeak(text) {
  for (const { label, re } of LEAK_PATTERNS) {
    if (re.test(String(text || ''))) return label
  }
  return ''
}

function collectJsonStrings(value, prefix = '') {
  if (typeof value === 'string') return [{ field: prefix || '(root)', text: value }]
  if (Array.isArray(value)) {
    return value.flatMap((entry, idx) => collectJsonStrings(entry, `${prefix}[${idx}]`))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => collectJsonStrings(v, prefix ? `${prefix}.${k}` : k))
  }
  return []
}

test('checked-in release notes, agent pointer, and packaged metadata contain no local paths or internal tracking markers', () => {
  const pkg = readJson('package.json')
  for (const forbidden of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.github']) {
    assert.ok(
      !pkg.files.some(entry => entry === forbidden || entry.startsWith(`${forbidden}/`)),
      `Governance file ${forbidden} must stay out of package.json files`,
    )
  }

  const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').trim()
  assert.equal(claudeMd, '@AGENTS.md')

  const notesDir = join(ROOT, '.github', 'release-notes')
  for (const file of readdirSync(notesDir).filter(name => /^v.+\.md$/.test(name)).sort()) {
    const content = readFileSync(join(notesDir, file), 'utf8')
    const leak = findHygieneLeak(content)
    assert.equal(leak, '', `Release notes .github/release-notes/${file} leaked ${leak}`)
  }

  for (const [label, parsedValue] of [
    ['package.json#description', pkg.description],
    ['package.json#keywords', pkg.keywords],
    ['locale/en.json', readJson('locale/en.json')],
    ['locale/zh.json', readJson('locale/zh.json')],
  ]) {
    for (const { field, text } of collectJsonStrings(parsedValue, label)) {
      const leak = findHygieneLeak(text)
      assert.equal(leak, '', `${field} leaked ${leak}`)
    }
  }

  assert.equal(findHygieneLeak('status: F08=needs-verify'), 'internal finding ID')
  assert.equal(findHygieneLeak('check /Users/alice/proj/foo.js'), 'macOS user home path')
  assert.equal(findHygieneLeak('check /home/synthetic-user/work'), 'Linux user home path')
  assert.equal(findHygieneLeak('<!-- END:codex-20261125T000000Z-01 -->'), 'collaboration block sentinel')

  const escapedWinJson = JSON.parse('{"label":"C:\\\\Users\\\\synthetic-user\\\\resume"}')
  const escapedWinEntries = collectJsonStrings(escapedWinJson, 'locale/en.json')
  assert.equal(escapedWinEntries.length, 1)
  assert.equal(findHygieneLeak(escapedWinEntries[0].text), 'Windows user home path')

  assert.equal(findHygieneLeak('Use F12 shortcut in temporary draft mode for v0.1.5.'), '')
})

test('PR title workflow is SHA-pinned, read-only, and enforces hygiene patterns', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pr-title.yml'), 'utf8')
  assert.match(workflow, /on:\s*\n\s*pull_request_target:\s*\n\s*types:\s*\n(?:\s*-\s*(?:opened|reopened|edited|synchronize)\s*\n){4}/)
  assert.match(workflow, /permissions:\s*\n\s*pull-requests:\s*read/)
  assert.doesNotMatch(workflow, /actions\/checkout/)
  assert.match(workflow, /amannn\/action-semantic-pull-request@[0-9a-f]{40}\b/)

  const disallowMatch = workflow.match(/^( *)disallowScopes:\s*\|\s*\n((?:\1 +\S.*\n)+)/m)
  assert.ok(disallowMatch, 'pr-title.yml must define disallowScopes')
  const disallowRegexes = disallowMatch[2]
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(pattern => new RegExp(`^${pattern}$`))

  for (const okScope of ['jobs', 'resume', 'repo', 'ci-tools', 'drafts']) {
    assert.equal(
      disallowRegexes.some(re => re.test(okScope)),
      false,
      `Allowed scope "${okScope}" was rejected by disallowScopes`,
    )
  }
  for (const badScope of ['f08', 'F08', 'f1', 'wip', 'temp', 'tmp', 'UI', 'bad/scope']) {
    assert.equal(
      disallowRegexes.some(re => re.test(badScope)),
      true,
      `Disallowed scope "${badScope}" escaped disallowScopes`,
    )
  }

  const subjectMatch = workflow.match(/subjectPattern:\s*(.+)/)
  assert.ok(subjectMatch, 'pr-title.yml must define subjectPattern')
  const subjectRe = new RegExp(subjectMatch[1].trim())

  for (const okSubject of [
    'enforce PR title and release-notes hygiene',
    'release 0.1.6',
    'preserve editor shortcut (F12)',
    'support F12 shortcut in editor',
  ]) {
    assert.equal(subjectRe.test(okSubject), true, `Valid subject "${okSubject}" failed subjectPattern`)
  }
  for (const badSubject of [
    'resolve F08 leak',
    'fix something (F08)',
    'mark F12=closed',
    'bad trailing period.',
    'WIP draft change',
    'WIP: draft change',
    'fixup! old commit',
    'squash! old commit',
    'check /Users/alice/proj',
    'check /home/synthetic-user/proj',
    'check C:\\Users\\synthetic-user\\resume',
    'check /tmp/replay',
  ]) {
    assert.equal(subjectRe.test(badSubject), false, `Invalid subject "${badSubject}" escaped subjectPattern`)
  }
})

test('CI workflow runs Linux DSH smoke on PRs and full 3-OS matrix on main, release branches, and release workflow_call', () => {
  const ciWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const releaseWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')

  assert.match(ciWorkflow, /push:\s*\n\s*branches:\s*\[main,\s*'release\/\*\*'\]/)
  assert.match(ciWorkflow, /\bpull_request:\s*\n/)
  assert.match(ciWorkflow, /\bworkflow_call:\s*\n/)
  assert.match(ciWorkflow, /name:\s*DSH smoke \(\$\{\{\s*matrix\.os\s*\}\}\)/)
  assert.match(ciWorkflow, /needs:\s*verify\b/)

  const smokeBlock = ciWorkflow.slice(ciWorkflow.indexOf('\n  smoke:'))
  const smokeHeader = smokeBlock.slice(0, smokeBlock.indexOf('\n    steps:'))
  assert.doesNotMatch(smokeHeader, /^\s*if:/m, 'smoke job must not be skipped on PRs')

  const matrixOsMatch = smokeBlock.match(/os:\s*\$\{\{\s*github\.event_name == 'pull_request' && fromJson\('([^']+)'\) \|\| fromJson\('([^']+)'\)\s*\}\}/)
  assert.ok(matrixOsMatch, 'smoke job must use dynamic pull_request vs main/release matrix')
  assert.deepEqual(JSON.parse(matrixOsMatch[1]), ['ubuntu-24.04'])
  assert.deepEqual(JSON.parse(matrixOsMatch[2]), ['windows-2025', 'macos-15', 'ubuntu-24.04'])
  assert.match(releaseWorkflow, /uses:\s*\.\/\.github\/workflows\/ci\.yml\b/)
})
