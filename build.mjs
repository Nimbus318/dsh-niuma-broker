import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = new URL('./', import.meta.url)
const { name } = JSON.parse(await readFile(new URL('package.json', here), 'utf8'))
const css = await readFile(new URL('client/page.css', here), 'utf8')
await build({
  entryPoints: [fileURLToPath(new URL('client/index.jsx', here))],
  outfile: fileURLToPath(new URL('dist/client.js', here)),
  bundle: true, format: 'cjs', platform: 'browser', target: 'chrome120',
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
