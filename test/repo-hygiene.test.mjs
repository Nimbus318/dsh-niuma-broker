import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildReleaseCreateArgs,
  releaseTitleFor,
  requireReleaseNotesFile,
  validateBilingualReleaseNotes,
} from '../scripts/ci/release-notes.mjs'

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
    if (entry === 'dist') continue
    assert.ok(existsSync(join(ROOT, entry)), `Missing package files entry: ${entry}`)
  }

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.equal(typeof target, 'string', `Expected string export target for ${subpath}`)
    if (target.includes('*')) continue
    assert.ok(
      isCoveredByPackageFiles(target, pkg.files),
      `Export ${subpath} -> ${target} is not covered by package.json files`,
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
