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

/** Ensure curated release notes exist and are non-empty before publishing. */
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
  return { notesPath, content }
}

/** Build `gh release create` arguments using checked-in release notes. */
export function buildReleaseCreateArgs({ tag, version, repository, commit, notesPath }) {
  return [
    'release', 'create', tag, '--repo', repository, '--verify-tag', '--target', commit,
    '--title', releaseTitleFor(version), '--notes-file', notesPath, '--draft',
  ]
}
