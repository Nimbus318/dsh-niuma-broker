import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./', import.meta.url))
const destination = resolve(root, process.argv[2] ?? 'artifacts')
const { repository, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const repositoryUrl = new URL(repository.url.replace(/^git\+/, '').replace(/\.git$/, ''))
const tag = `v${version}`
const assets = `https://raw.githubusercontent.com${repositoryUrl.pathname}/${tag}/`
const documents = `${repositoryUrl.href}/blob/${tag}/`

function rewriteReadme(markdown) {
  return markdown
    .replace(/(\b(?:src|href)=["'])\.\//g, (_, prefix) => prefix + (prefix.startsWith('src') ? assets : documents))
    .replace(/(!\[[^\]\n]*\]\()\.\//g, (_, prefix) => prefix + assets)
    .replace(/(\]\()\.\//g, (_, prefix) => prefix + documents)
}

function pack(cwd, ...args) {
  const output = execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', ...args], {
    cwd, encoding: 'utf8',
  })
  return JSON.parse(output)[0]
}

const { files } = pack(root, '--dry-run')
if (!files.some(file => file.path === 'dist/client.js')) {
  throw new Error('Build dist/client.js before packing the release (npm run build).')
}

const staging = await mkdtemp(join(tmpdir(), 'niuma-release-'))
try {
  for (const { path } of files) {
    const target = join(staging, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(root, path), target)
  }
  for (const filename of ['README.md', 'README.en.md']) {
    const target = join(staging, filename)
    await writeFile(target, rewriteReadme(await readFile(target, 'utf8')))
  }

  await mkdir(destination, { recursive: true })
  const { filename } = pack(staging, '--pack-destination', destination)
  console.log(join(destination, filename))
} finally {
  await rm(staging, { recursive: true, force: true })
}
