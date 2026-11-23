import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const upstream = process.argv[2] && resolve(process.argv[2]);
if (!upstream) throw new Error('Provide the Reactive Resume source checkout directory.');
const commit = 'a2ad05181e133f4981fc1d8a2c46811069af4d25';
if (execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit) {
  throw new Error('Use the Reactive Resume v6.1.1 checkout at ' + commit);
}

const require = createRequire(import.meta.url);
const { build } = require(resolve(upstream, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'));
const pdf = resolve(upstream, 'packages/pdf');
await build({
  stdin: {
    sourcefile: 'local-renderer.ts',
    resolveDir: pdf,
    loader: 'ts',
    contents: [
      "export { renderResumeWebPage } from './src/html/web-page.tsx';",
      "export { defaultResumeData, sectionDefaults } from '@reactive-resume/schema/resume/default';",
      "export { templateSchema, templateLayouts } from '@reactive-resume/schema/templates';",
    ].join('\n'),
  },
  outfile: fileURLToPath(new URL('../../src/vendor/reactive-resume-renderer.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    // css-tree's ESM entry uses createRequire for data files. Its CommonJS entry
    // exposes those imports to esbuild, so its data travels with the bundle.
    name: 'bundle-css-tree-data',
    setup(context) {
      context.onResolve({ filter: /^css-tree$/ }, args => ({
        path: createRequire(args.importer).resolve(args.path),
      }));
    },
  }],
  minify: true,
  legalComments: 'linked',
  banner: {
    js: '/* Reactive Resume v6.1.1. See reactive-resume-third-party-licenses.txt. */\n'
      + 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
  },
});
