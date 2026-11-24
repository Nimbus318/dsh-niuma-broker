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

test('release notes helper enforces checked-in notes and formats gh create args', async t => {
  for (const version of ['0.1.2', '0.1.3']) {
    const { notesPath, content } = await requireReleaseNotesFile(version, ROOT)
    assert.ok(existsSync(notesPath))
    assert.match(content, /^## 中文/m)
    assert.match(content, /^## English/m)
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'niuma-release-notes-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  await mkdir(join(sandbox, '.github', 'release-notes'), { recursive: true })
  await writeFile(join(sandbox, '.github', 'release-notes', 'v0.0.1.md'), '   \n', 'utf8')

  await assert.rejects(
    requireReleaseNotesFile('9.9.9', sandbox),
    /Add \.github\/release-notes\/v9\.9\.9\.md before publishing\./,
  )
  await assert.rejects(
    requireReleaseNotesFile('0.0.1', sandbox),
    /Release notes for v0\.0\.1 are empty\./,
  )

  const args = buildReleaseCreateArgs({
    tag: 'v0.1.3',
    version: '0.1.3',
    repository: 'Nimbus318/dsh-niuma-broker',
    commit: '634964104fdc45f32e62b25bbc4ab79a81268bce',
    notesPath: '/tmp/v0.1.3.md',
  })
  assert.deepEqual(args, [
    'release', 'create', 'v0.1.3', '--repo', 'Nimbus318/dsh-niuma-broker', '--verify-tag',
    '--target', '634964104fdc45f32e62b25bbc4ab79a81268bce',
    '--title', releaseTitleFor('0.1.3'), '--notes-file', '/tmp/v0.1.3.md', '--draft',
  ])
})
