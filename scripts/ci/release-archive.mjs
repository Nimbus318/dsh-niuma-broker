import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))

export async function readVerifiedArchive(directory) {
  const filename = `${pkg.name}-${pkg.version}.tgz`
  const archive = join(resolve(directory), filename)
  const checksum = join(resolve(directory), 'SHA256SUMS.txt')
  const bytes = await readFile(archive)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if ((await readFile(checksum, 'utf8')).trimEnd() !== `${digest}  ${filename}`) {
    throw new Error(`SHA-256 check failed for ${filename}.`)
  }
  return { archive, checksum, bytes }
}

if (import.meta.main) {
  const { archive } = await readVerifiedArchive(process.argv[2])
  console.log(archive)
}
