import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./', import.meta.url))

function isCliEntry(metaUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}

function resolveNpmCli() {
  const envExec = process.env.npm_execpath
  if (envExec && existsSync(envExec) && /\.(?:c|m)?js$/i.test(envExec)) return envExec
  const execDir = dirname(process.execPath)
  const candidates = [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  if (process.platform === 'win32') {
    try {
      const found = execFileSync('where.exe', ['npm'], { encoding: 'utf8' }).split(/\r?\n/u).map(s => s.trim()).filter(Boolean)
      for (const binPath of found) {
        const binDir = dirname(binPath)
        candidates.push(
          join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          resolve(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        )
      }
    } catch {}
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function rewriteReadme(markdown, assets, documents) {
  return markdown
    .replace(/(\b(?:src|href)=["'])\.\//g, (_, prefix) => prefix + (prefix.startsWith('src') ? assets : documents))
    .replace(/(!\[[^\]\n]*\]\()\.\//g, (_, prefix) => prefix + assets)
    .replace(/(\]\()\.\//g, (_, prefix) => prefix + documents)
}

function pack(cwd, ...args) {
  const npmArgs = ['pack', '--offline', '--ignore-scripts', '--json', ...args]
  const npmCli = resolveNpmCli()
  const output = npmCli
    ? execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd, encoding: 'utf8' })
    : process.platform === 'win32'
      ? execFileSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', ['npm', ...npmArgs].join(' ')],
          { cwd, encoding: 'utf8' },
        )
      : execFileSync('npm', npmArgs, { cwd, encoding: 'utf8' })
  return JSON.parse(output)[0]
}

/**
 * Returns the dry-run npm pack manifest (`files`, `size`, etc.) without mutating disk or creating a tarball.
 */
export function getPackManifest(cwd = root) {
  return pack(cwd, '--dry-run')
}

/**
 * Packs the release tarball after rewriting README relative asset links for npmjs/GitHub rendering.
 */
export async function packRelease({ cwd = root, destination = resolve(root, 'artifacts') } = {}) {
  const resolvedCwd = resolve(cwd)
  const resolvedDestination = resolve(destination)
  const { repository, version } = JSON.parse(await readFile(join(resolvedCwd, 'package.json'), 'utf8'))
  const repositoryUrl = new URL(repository.url.replace(/^git\+/, '').replace(/\.git$/, ''))
  const tag = `v${version}`
  const assets = `https://raw.githubusercontent.com${repositoryUrl.pathname}/${tag}/`
  const documents = `${repositoryUrl.href}/blob/${tag}/`

  const { files } = getPackManifest(resolvedCwd)
  if (!files.some(file => file.path === 'dist/client.js')) {
    throw new Error('Build dist/client.js before packing the release (npm run build).')
  }

  const staging = await mkdtemp(join(tmpdir(), 'niuma-release-'))
  try {
    for (const { path } of files) {
      const target = join(staging, path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(resolvedCwd, path), target)
    }
    for (const filename of ['README.md', 'README.en.md']) {
      const target = join(staging, filename)
      await writeFile(target, rewriteReadme(await readFile(target, 'utf8'), assets, documents))
    }

    const { filename } = pack(staging, '--pack-destination=.')
    await mkdir(resolvedDestination, { recursive: true })
    const outputPath = join(resolvedDestination, filename)
    await copyFile(join(staging, filename), outputPath)
    return outputPath
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (isCliEntry(import.meta.url)) {
  const destination = resolve(root, process.argv[2] ?? 'artifacts')
  console.log(await packRelease({ cwd: root, destination }))
}
