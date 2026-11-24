import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Build the bilingual GitHub Release title for a version. */
export function releaseTitleFor(version) {
  return `牛马经纪人 ${version} · Niuma Broker`
}

/** Return the expected `.github/release-notes/v<version>.md` path for a version. */
export function releaseNotesPathFor(version, rootDir = DEFAULT_ROOT) {
  return join(resolve(rootDir), '.github', 'release-notes', `v${version}.md`)
}

function extractSectionBody(content, headingTitle) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n')
  let inSection = false
  const body = []
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      if (inSection) break
      if (heading[1] === headingTitle) inSection = true
      continue
    }
    if (!inSection) continue
    if (/^\*\*Full Changelog\*\*\s*:/i.test(line.trim())) continue
    body.push(line)
  }
  return { found: inSection, body: body.join('\n').trim() }
}

/** Validate that checked-in release notes contain non-empty `## 中文` and `## English` sections. */
export function validateBilingualReleaseNotes(content, version) {
  const zh = extractSectionBody(content, '中文')
  if (!zh.found || !zh.body) {
    throw new Error(`Release notes .github/release-notes/v${version}.md must include a non-empty "## 中文" section.`)
  }
  const en = extractSectionBody(content, 'English')
  if (!en.found || !en.body) {
    throw new Error(`Release notes .github/release-notes/v${version}.md must include a non-empty "## English" section.`)
  }
}

/** Ensure curated bilingual release notes exist and are valid before publishing. */
export async function requireReleaseNotesFile(version, rootDir = DEFAULT_ROOT) {
  const notesPath = releaseNotesPathFor(version, rootDir)
  let content
  try {
    content = await readFile(notesPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Add .github/release-notes/v${version}.md before publishing.`)
    }
    throw error
  }
  if (!content.trim()) {
    throw new Error(`Release notes for v${version} are empty.`)
  }
  validateBilingualReleaseNotes(content, version)
  return { notesPath, content }
}

/** Build `gh release create` arguments using checked-in release notes. */
export function buildReleaseCreateArgs({ tag, version, repository, commit, notesPath }) {
  return [
    'release', 'create', tag, '--repo', repository, '--verify-tag', '--target', commit,
    '--title', releaseTitleFor(version), '--notes-file', notesPath, '--draft',
  ]
}
