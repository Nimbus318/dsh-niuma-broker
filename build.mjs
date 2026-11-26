import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, transform } from 'esbuild'

const here = new URL('./', import.meta.url)

function isCliEntry(metaUrl) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}

/**
 * Bundles `client/index.jsx` and minified `client/page.css` into the DSH client UMD/loader module.
 */
export async function buildClientBundle({
  outfile = fileURLToPath(new URL('dist/client.js', here)),
  write = true,
} = {}) {
  const { name } = JSON.parse(await readFile(new URL('package.json', here), 'utf8'))
  const rawCss = await readFile(new URL('client/page.css', here), 'utf8')
  const { code: css } = await transform(rawCss, { loader: 'css', minify: true, target: 'chrome120' })
  return build({
    entryPoints: [fileURLToPath(new URL('client/index.jsx', here))],
    outfile,
    bundle: true, format: 'cjs', platform: 'browser', target: 'chrome120',
    minify: true,
    write,
    loader: { '.svg': 'dataurl' },
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
    define: { __CAREER_AGENT_CSS__: JSON.stringify(css) },
    legalComments: 'linked',
    banner: {
      js: `/* ${name} — License: MIT. Third-party notices: THIRD_PARTY_NOTICES.md */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;`,
    },
    footer: { js: 'return module.exports}})' },
  })
}

if (isCliEntry(import.meta.url)) {
  await buildClientBundle()
}
