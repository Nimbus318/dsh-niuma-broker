import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pkg, readVerifiedArchive } from './release-archive.mjs'
import { buildReleaseCreateArgs, requireReleaseNotesFile } from './release-notes.mjs'

const {
  GITHUB_EVENT_NAME: event, GITHUB_REF: branch, GITHUB_REPOSITORY: repository, GITHUB_SHA: commit,
} = process.env
if (event !== 'workflow_dispatch' || branch !== 'refs/heads/main' ||
    !/^[a-f\d]{40}$/.test(commit) || typeof repository !== 'string') {
  throw new Error('Run this script from the manual release workflow on main.')
}

const tag = `v${pkg.version}`
const { notesPath } = await requireReleaseNotesFile(pkg.version, process.env.NIUMA_RELEASE_ROOT || undefined)
const { archive, checksum, bytes } = await readVerifiedArchive(process.argv[2])
const ref = `refs/tags/${tag}`
const expectedIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const registryBase = (process.env.NIUMA_RELEASE_REGISTRY_BASE || 'https://registry.npmjs.org').replace(/\/+$/, '')
const registryVersion = `${registryBase}/${encodeURIComponent(pkg.name)}/${pkg.version}`

async function isPublished() {
  const response = await fetch(registryVersion, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`npm version lookup returned HTTP ${response.status}.`)

  const { dist } = await response.json()
  if (dist?.integrity !== expectedIntegrity) {
    throw new Error(`npm already has ${pkg.name}@${pkg.version} with different bytes.`)
  }
  return true
}

function releaseInfo() {
  try {
    return JSON.parse(execFileSync('gh', [
      'release', 'view', tag, '--repo', repository, '--json', 'assets,isDraft,isPrerelease',
    ], { encoding: 'utf8' }))
  } catch (error) {
    if (error.status === 1 && error.stderr?.trim() === 'release not found') return null
    throw error
  }
}

async function missingAssets(release) {
  const files = [archive, checksum]
  if (!release) return files
  if (release.isPrerelease) throw new Error(`GitHub already has a prerelease for ${tag}.`)

  const missing = []
  const downloaded = await mkdtemp(join(tmpdir(), 'niuma-release-assets-'))
  try {
    for (const file of files) {
      const name = basename(file)
      if (!release.assets.some(asset => asset.name === name)) {
        missing.push(file)
        continue
      }
      execFileSync('gh', [
        'release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', downloaded,
      ], { stdio: 'inherit' })
      if (!(await readFile(join(downloaded, name))).equals(await readFile(file))) {
        throw new Error(`GitHub Release ${tag} already has different bytes for ${name}.`)
      }
    }
  } finally {
    await rm(downloaded, { recursive: true, force: true })
  }
  return missing
}

const published = await isPublished()
const release = releaseInfo()
const assetsToUpload = await missingAssets(release)

const tagLines = execFileSync('git', ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`], {
  encoding: 'utf8',
}).trim()
if (tagLines) {
  const tags = new Map(tagLines.split('\n').map(line => line.split('\t').reverse()))
  if ((tags.get(`${ref}^{}`) ?? tags.get(ref)) !== commit) {
    throw new Error(`GitHub tag ${tag} already points to a different commit.`)
  }
} else {
  // The packed README links to the source and media at this tag.
  const tagSha = execFileSync('gh', [
    'api', '--method', 'POST', `repos/${repository}/git/tags`, '--input', '-', '--jq', '.sha',
  ], {
    encoding: 'utf8',
    input: JSON.stringify({
      tag,
      message: `Niuma Broker ${pkg.version}`,
      object: commit,
      type: 'commit',
      tagger: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
        date: new Date().toISOString(),
      },
    }),
  }).trim()
  execFileSync('gh', [
    'api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=${ref}`, '-f', `sha=${tagSha}`,
  ], { stdio: 'inherit' })
}

if (published) {
  console.log(`npm already has the verified ${pkg.name}@${pkg.version} archive.`)
} else {
  execFileSync('npm', ['publish', archive, '--access', 'public', '--ignore-scripts'], { stdio: 'inherit' })
  // A registry read can lag a successful publish.
  for (const delay of [0, 2_000, 4_000, 8_000, 16_000]) {
    await setTimeout(delay)
    if (await isPublished()) break
    if (delay === 16_000) throw new Error('npm did not return the published archive integrity yet. Retry this run.')
  }
}

if (!release) {
  execFileSync('gh', buildReleaseCreateArgs({
    tag, version: pkg.version, repository, commit, notesPath,
  }), { stdio: 'inherit' })
}
if (assetsToUpload.length) {
  execFileSync('gh', [
    'release', 'upload', tag, ...assetsToUpload, '--repo', repository,
  ], { stdio: 'inherit' })
}
if (!release || release.isDraft) {
  execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false'], { stdio: 'inherit' })
}
