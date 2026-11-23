import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const cwd = fileURLToPath(new URL('./', import.meta.url))
const { metafile } = await build({
  absWorkingDir: cwd,
  entryPoints: ['editor.js'],
  outfile: 'editor.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  loader: { '.css': 'text' },
  minify: true,
  legalComments: 'inline',
  metafile: true,
  banner: { js: '/* Reactive Resume editor preset and dependencies. See LICENSE and THIRD_PARTY_LICENSES.txt. */' },
})

const npmPackages = new Set()
for (const output of Object.values(metafile.outputs)) {
  for (const [modulePath, input] of Object.entries(output.inputs)) {
    if (!input.bytesInOutput || !modulePath.includes('node_modules/')) continue
    const match = /^(\S*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(modulePath)
    if (match) npmPackages.add(match[1])
  }
}

const notices = []
for (const packagePath of [...npmPackages].sort()) {
  const directory = new URL(`${packagePath}/`, import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'))
  const licenseName = (await readdir(directory)).find(name => /^licen[sc]e(?:\.|$)/i.test(name))
  if (!licenseName) throw new Error(`Missing license for ${manifest.name}@${manifest.version}`)
  const license = await readFile(new URL(licenseName, directory), 'utf8')
  notices.push(`${manifest.name}@${manifest.version}\n${license.trim()}`)
}
await writeFile(new URL('THIRD_PARTY_LICENSES.txt', import.meta.url), notices.join('\n\n') + '\n')
