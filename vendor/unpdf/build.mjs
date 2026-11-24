import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const unpdfRoot = process.argv[2] && resolve(process.argv[2])
const pdfjsRoot = process.argv[3] && resolve(process.argv[3])
if (!unpdfRoot || !pdfjsRoot) {
  throw new Error('Usage: node vendor/unpdf/build.mjs <unpdf@2.2.1-dir> <pdfjs-dist@6.5.438-dir>')
}

const unpdfPkg = JSON.parse(await readFile(join(unpdfRoot, 'package.json'), 'utf8'))
if (unpdfPkg.version !== '2.2.1') {
  throw new Error(`Expected unpdf@2.2.1, found ${unpdfPkg.version}.`)
}
const pdfjsPkg = JSON.parse(await readFile(join(pdfjsRoot, 'package.json'), 'utf8'))
if (pdfjsPkg.version !== '6.5.438') {
  throw new Error(`Expected pdfjs-dist@6.5.438, found ${pdfjsPkg.version}.`)
}

const here = fileURLToPath(new URL('./', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const outfile = join(repoRoot, 'src/vendor/unpdf-extract.mjs')
const legalFile = join(repoRoot, 'src/vendor/unpdf-extract.mjs.LEGAL.txt')
const cmapsTarget = join(repoRoot, 'src/vendor/pdfjs-cmaps')

await rm(cmapsTarget, { recursive: true, force: true })
await cp(join(pdfjsRoot, 'cmaps'), cmapsTarget, { recursive: true })

await build({
  stdin: {
    sourcefile: 'unpdf-entry.mjs',
    resolveDir: unpdfRoot,
    loader: 'js',
    contents: `
import { fileURLToPath } from 'node:url'
import { definePDFJSModule, extractText, getDocumentProxy } from './dist/index.mjs'
import * as pdfjs from './dist/pdfjs.mjs'

let initialized = false
const cMapUrl = \`\${fileURLToPath(new URL('./pdfjs-cmaps/', import.meta.url)).replace(/\\\\/g, '/').replace(/\\/+$/, '')}/\`

export async function extractPdfTextWithUnpdf(bytes) {
  if (!initialized) {
    await definePDFJSModule(() => Promise.resolve(pdfjs))
    initialized = true
  }
  // Single owned copy so PDF.js buffer transfer never detaches the caller's Node Buffer slab.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const doc = await getDocumentProxy(copy, {
    cMapUrl,
    cMapPacked: true,
  })
  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false })
    const pageTexts = Array.isArray(text) ? text.map(p => String(p || '')) : [String(text || '')]
    const joined = pageTexts.join('\\n\\n')
    return { pages: totalPages, text: joined, pageTexts }
  } finally {
    await Promise.resolve(doc?.loadingTask?.destroy?.()).catch(() => {})
  }
}
`,
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  banner: {
    js: '/* unpdf 2.2.1 + PDF.js 6.5.438. See unpdf-extract.mjs.LEGAL.txt and THIRD_PARTY_NOTICES.md. */',
  },
})

const unpdfLicense = (await readFile(join(unpdfRoot, 'LICENSE'), 'utf8')).trim()
const pdfjsLicense = (await readFile(join(pdfjsRoot, 'LICENSE'), 'utf8')).trim()
const openjpegLicense = (await readFile(join(here, 'LICENSE_PDFJS_OPENJPEG.txt'), 'utf8')).trim()
const cmapLicense = (await readFile(join(cmapsTarget, 'LICENSE'), 'utf8')).trim()

const legalText = [
  'unpdf@2.2.1 — MIT License',
  'Source: https://github.com/unjs/unpdf',
  '',
  unpdfLicense,
  '',
  '======================================================================',
  '',
  'Mozilla PDF.js 6.5.438 (bundled inside unpdf) — Apache License 2.0',
  'Source: https://github.com/mozilla/pdf.js',
  '',
  pdfjsLicense,
  '',
  '======================================================================',
  '',
  'PDF.js OpenJPEG wrapper (external/openjpeg/LICENSE_PDFJS_OPENJPEG, v6.5.438) — BSD-2-Clause',
  'Source: https://github.com/mozilla/pdf.js/blob/v6.5.438/external/openjpeg/LICENSE_PDFJS_OPENJPEG',
  '',
  openjpegLicense,
  '',
  '======================================================================',
  '',
  'PDF.js CMap resources (pdfjs-dist@6.5.438/cmaps -> src/vendor/pdfjs-cmaps/) — BSD-3-Clause',
  'Source: https://github.com/mozilla/pdf.js',
  '',
  cmapLicense,
  '',
].join('\n')

await writeFile(legalFile, legalText, 'utf8')
console.log(`Built ${outfile} and synced ${cmapsTarget}`)
