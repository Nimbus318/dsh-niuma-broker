import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourceRoot = process.argv[2] && resolve(process.argv[2])
if (!sourceRoot) {
  throw new Error('Provide a directory containing node_modules/mammoth@1.13.0.')
}

const mammothPkgPath = join(sourceRoot, 'node_modules/mammoth/package.json')
const mammothPkg = JSON.parse(await readFile(mammothPkgPath, 'utf8'))
if (mammothPkg.version !== '1.13.0') {
  throw new Error(`Expected mammoth@1.13.0, found ${mammothPkg.version}.`)
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const outfile = join(repoRoot, 'src/vendor/mammoth-core.mjs')
const legalFile = join(repoRoot, 'src/vendor/mammoth-core.mjs.LEGAL.txt')

const { metafile } = await build({
  stdin: {
    sourcefile: 'mammoth-core-entry.mjs',
    resolveDir: sourceRoot,
    loader: 'js',
    contents: [
      "export { default as documents } from 'mammoth/lib/documents.js'",
      "export { default as bodyReaderModule } from 'mammoth/lib/docx/body-reader.js'",
      "export { default as contentTypesReader } from 'mammoth/lib/docx/content-types-reader.js'",
      "export { default as documentXmlReaderModule } from 'mammoth/lib/docx/document-xml-reader.js'",
      "export { default as filesModule } from 'mammoth/lib/docx/files.js'",
      "export { default as numberingXml } from 'mammoth/lib/docx/numbering-xml.js'",
      "export { default as relationshipsReader } from 'mammoth/lib/docx/relationships-reader.js'",
      "export { default as stylesReader } from 'mammoth/lib/docx/styles-reader.js'",
      "export { default as promises } from 'mammoth/lib/promises.js'",
      "export { default as unzip } from 'mammoth/lib/unzip.js'",
      "export { default as xml } from 'mammoth/lib/xml/index.js'",
      "export { default as xmlNodes } from 'mammoth/lib/xml/nodes.js'",
      "export { default as zipfile } from 'mammoth/lib/zipfile.js'",
    ].join('\n'),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'linked',
  metafile: true,
  banner: {
    js: '/* Mammoth 1.13.0 primitives. See mammoth-core.mjs.LEGAL.txt and THIRD_PARTY_NOTICES.md. */\n'
      + 'import { createRequire as __mammothCreateRequire } from "node:module"; const require = __mammothCreateRequire(import.meta.url);',
  },
})

const bundledDirs = new Set()
for (const output of Object.values(metafile.outputs)) {
  for (const [modulePath, input] of Object.entries(output.inputs)) {
    if (!input.bytesInOutput || !modulePath.includes('node_modules/')) continue
    const match = /(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(modulePath)
    if (match) bundledDirs.add(match[1])
  }
}

const sections = [
  'Third-party licenses for bundled packages in src/vendor/mammoth-core.mjs.',
  'For dual-licensed packages (e.g. jszip: MIT OR GPL-3.0-or-later), this bundle is distributed under the MIT License.',
]

for (const relDir of [...bundledDirs].sort()) {
  const pkgDir = join(sourceRoot, relDir)
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  const dirEntries = await readdir(pkgDir)
  const licFile = dirEntries.find(name => /^licen[cs]e(?:\.(?:md|txt|markdown))?$/i.test(name))
  let licText = licFile ? (await readFile(join(pkgDir, licFile), 'utf8')).trim() : ''
  if (!licText) {
    const readme = dirEntries.find(name => /^readme(?:\.(?:md|txt))?$/i.test(name))
    if (readme) {
      const m = (await readFile(join(pkgDir, readme), 'utf8')).match(/##?\s*Licen[cs]e[\s\S]*$/i)
      if (m) licText = m[0].trim()
    }
  }
  if (!licText) {
    throw new Error(`Missing license text for ${manifest.name}@${manifest.version}`)
  }
  const licName = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license)
  const repo = typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url || manifest.homepage || '')
  sections.push(
    `\n======================================================================\n\n`
    + `${manifest.name}@${manifest.version} — ${licName}\n`
    + (repo ? `Source: ${repo}\n` : '')
    + `\n${licText}`,
  )
}

await writeFile(legalFile, `${sections.join('\n')}\n`, 'utf8')
console.log(`Built ${outfile} (${bundledDirs.size} bundled packages)`)
