import assert from 'node:assert/strict'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

function toRepoRelPosix(absPath, rootDir = ROOT) {
  const canonicalRoot = realpathSync(rootDir)
  let canonicalPath = absPath
  try {
    canonicalPath = realpathSync(absPath)
  } catch {
    canonicalPath = resolve(absPath)
  }
  return relative(canonicalRoot, canonicalPath).split(sep).join(posix.sep)
}
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build as esbuild } from 'esbuild'
import { buildClientBundle } from '../build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APPROVED_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const NODE_BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const FORBIDDEN_SERVER_MODULES = new Set([
  'src/host.mjs',
  'src/career.mjs',
  'src/watch.mjs',
  'src/resume-agent.mjs',
  'src/resume-conversation.mjs',
  'src/resume-fact-guard.mjs',
  'src/job-triage.mjs',
  'src/intake.mjs',
  'src/opportunities.mjs',
  'src/file-extract.mjs',
  'src/local-pdf.mjs',
  'src/market-insights.mjs',
])
const FORBIDDEN_HOST_GLOB = /^src\/host(?:-[^/]+)?\.mjs$/
const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.mjs', '.json', '.svg']

const MAX_CLIENT_RAW_BYTES = 2_100_000
const MAX_CLIENT_GZIP_BYTES = 660_000

function resolveLocalModule(specifier, resolveDir) {
  const base = isAbsolute(specifier) ? specifier : resolve(resolveDir, specifier)
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return realpathSync(candidate)
    }
  }
  return null
}

/**
 * Traverses the pre-tree-shake static ES import cone via esbuild `onResolve` hooks.
 */
async function scanImportCone(entryOptions, { rootDir = ROOT } = {}) {
  const canonicalRoot = realpathSync(rootDir)
  const reachableFiles = new Set()
  const escapedRootImports = []
  const approvedExternals = new Set()
  const nodeBuiltins = []
  const unapprovedExternals = []
  const unresolvedLocals = []

  const recordResolved = (resolved, importerRel) => {
    const relPosix = toRepoRelPosix(resolved, canonicalRoot)
    if (!relPosix || relPosix === '..' || relPosix.startsWith('../') || isAbsolute(relPosix)) {
      escapedRootImports.push({ importer: importerRel, resolved: relPosix })
      return false
    }
    reachableFiles.add(relPosix)
    return true
  }

  await esbuild({
    ...entryOptions,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'transform',
    loader: { '.svg': 'dataurl' },
    define: { __CAREER_AGENT_CSS__: '""' },
    plugins: [{
      name: 'client-import-cone-scanner',
      setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'escaped-entry' }, () => ({ contents: '', loader: 'js' }))
        build.onResolve({ filter: /.*/ }, args => {
          const importerRel = args.importer ? toRepoRelPosix(args.importer, canonicalRoot) : '(entry)'
          if (args.kind === 'entry-point' && !args.importer) {
            if (args.path.startsWith('.') || isAbsolute(args.path)) {
              const resolved = resolveLocalModule(args.path, args.resolveDir || canonicalRoot)
              if (resolved) {
                if (!recordResolved(resolved, importerRel)) {
                  return { path: resolved, namespace: 'escaped-entry' }
                }
                return { path: resolved }
              }
            }
            return null
          }

          if (args.path.startsWith('node:') || NODE_BUILTINS.has(args.path)) {
            nodeBuiltins.push({ importer: importerRel, specifier: args.path })
            return { path: args.path, namespace: 'forbidden-node-builtin', external: true }
          }

          if (!args.path.startsWith('.') && !isAbsolute(args.path)) {
            if (APPROVED_EXTERNALS.has(args.path)) {
              approvedExternals.add(args.path)
              return { path: args.path, external: true }
            }
            unapprovedExternals.push({ importer: importerRel, specifier: args.path })
            return { path: args.path, namespace: 'forbidden-external', external: true }
          }

          const baseDir = args.resolveDir || (args.importer ? dirname(args.importer) : canonicalRoot)
          const resolved = resolveLocalModule(args.path, baseDir)
          if (!resolved) {
            unresolvedLocals.push({ importer: importerRel, specifier: args.path })
            return { path: args.path, namespace: 'missing-local', external: true }
          }
          if (!recordResolved(resolved, importerRel)) {
            return { path: resolved, external: true }
          }
          return { path: resolved }
        })
      },
    }],
  })

  const forbiddenServerModules = [...reachableFiles]
    .filter(rel => FORBIDDEN_SERVER_MODULES.has(rel) || FORBIDDEN_HOST_GLOB.test(rel))
    .sort()

  return {
    reachableFiles: [...reachableFiles].sort(),
    escapedRootImports,
    approvedExternals: [...approvedExternals].sort(),
    nodeBuiltins,
    unapprovedExternals,
    unresolvedLocals,
    forbiddenServerModules,
  }
}

function assertCleanClientCone(cone, label = 'client bundle') {
  assert.deepEqual(cone.nodeBuiltins, [], `${label} must never import Node built-ins`)
  assert.deepEqual(cone.unapprovedExternals, [], `${label} must never import unapproved external packages`)
  assert.deepEqual(cone.unresolvedLocals, [], `${label} has unresolved local imports`)
  assert.deepEqual(cone.escapedRootImports, [], `${label} must not escape repository root via symlinks`)
  assert.deepEqual(cone.forbiddenServerModules, [], `${label} must never transitively reach server-only modules`)
}

test('client/index.jsx pre-tree-shake static import cone isolates browser modules from server/Node dependencies', async () => {
  const cone = await scanImportCone({ entryPoints: [join(ROOT, 'client', 'index.jsx')] })
  assertCleanClientCone(cone, 'client/index.jsx')
  assert.ok(cone.reachableFiles.includes('src/resume-apply.mjs'), 'client cone should import pure src/resume-apply.mjs')
  assert.equal(cone.reachableFiles.includes('src/resume-conversation.mjs'), false)
  assert.equal(cone.reachableFiles.includes('src/watch.mjs'), false)
  assert.equal(cone.reachableFiles.includes('src/resume-fact-guard.mjs'), false)
})

test('negative regressions: pre-tree-shake import cone catches Node built-ins, server modules, and unapproved packages', async () => {
  const clientDir = join(ROOT, 'client')

  const withNodeFs = await scanImportCone({
    stdin: {
      contents: "import { readFileSync } from 'node:fs'; export const x = readFileSync;",
      resolveDir: clientDir,
      loader: 'js',
    },
  })
  assert.throws(() => assertCleanClientCone(withNodeFs), /Node built-ins/)
  assert.equal(withNodeFs.nodeBuiltins[0]?.specifier, 'node:fs')

  const withDirectServer = await scanImportCone({
    stdin: {
      contents: "import { modelJson } from '../src/watch.mjs'; export const x = modelJson;",
      resolveDir: clientDir,
      loader: 'js',
    },
  })
  assert.throws(() => assertCleanClientCone(withDirectServer), /server-only modules/)
  assert.ok(withDirectServer.forbiddenServerModules.includes('src/watch.mjs'))

  // Importing a pure helper from resume-conversation.mjs transitively pulls watch.mjs + resume-fact-guard.mjs
  const withTransitiveServer = await scanImportCone({
    stdin: {
      contents: "import { resumeBullet } from '../src/resume-conversation.mjs'; export const b = resumeBullet;",
      resolveDir: clientDir,
      loader: 'js',
    },
  })
  assert.throws(() => assertCleanClientCone(withTransitiveServer), /server-only modules/)
  assert.ok(withTransitiveServer.forbiddenServerModules.includes('src/resume-conversation.mjs'))
  assert.ok(withTransitiveServer.forbiddenServerModules.includes('src/watch.mjs'))
  assert.ok(withTransitiveServer.forbiddenServerModules.includes('src/resume-fact-guard.mjs'))

  const withBarePkg = await scanImportCone({
    stdin: {
      contents: "import _ from 'lodash'; export const x = _;",
      resolveDir: clientDir,
      loader: 'js',
    },
  })
  assert.throws(() => assertCleanClientCone(withBarePkg), /unapproved external packages/)
  assert.equal(withBarePkg.unapprovedExternals[0]?.specifier, 'lodash')

  // Symlink alias src/browser-watch.mjs -> src/watch.mjs and outside-root symlinks must be canonicalized and caught
  const symRepo = await mkdtemp(join(tmpdir(), 'niuma-symlink-cone-'))
  const outsideFile = join(symRepo, 'outside-secret.mjs')
  const innerRepo = join(symRepo, 'repo')
  try {
    await writeFile(outsideFile, 'export const secret = 1\n')
    await mkdir(join(innerRepo, 'client'), { recursive: true })
    await mkdir(join(innerRepo, 'src'), { recursive: true })
    await writeFile(join(innerRepo, 'src', 'watch.mjs'), 'export const modelJson = () => {}\n')
    await symlink(join(innerRepo, 'src', 'watch.mjs'), join(innerRepo, 'src', 'browser-watch.mjs'))
    await symlink(outsideFile, join(innerRepo, 'client', 'escaped-entry.jsx'))
    await writeFile(join(innerRepo, 'client', 'entry.jsx'), "import { modelJson } from '../src/browser-watch.mjs'; export const x = modelJson;\n")
    const symCone = await scanImportCone({ entryPoints: [join(innerRepo, 'client', 'entry.jsx')] }, { rootDir: innerRepo })
    assert.throws(() => assertCleanClientCone(symCone), /server-only modules/)
    assert.ok(symCone.forbiddenServerModules.includes('src/watch.mjs'))

    const escapedEntryCone = await scanImportCone({ entryPoints: [join(innerRepo, 'client', 'escaped-entry.jsx')] }, { rootDir: innerRepo })
    assert.throws(() => assertCleanClientCone(escapedEntryCone), /escape repository root/)
    assert.equal(escapedEntryCone.escapedRootImports.length, 1)
  } finally {
    await rm(symRepo, { recursive: true, force: true })
  }
})

test('dist/client.js respects dual raw/gzip ceilings and matches fresh build byte-for-byte', async t => {
  const distFile = join(ROOT, 'dist', 'client.js')
  assert.ok(existsSync(distFile), 'Missing dist/client.js; run `npm run build` before running tests.')

  const distBytes = await readFile(distFile)
  assert.ok(distBytes.length > 0, 'dist/client.js must not be empty')
  assert.ok(
    distBytes.length <= MAX_CLIENT_RAW_BYTES,
    `dist/client.js raw size ${distBytes.length} exceeds ${MAX_CLIENT_RAW_BYTES} bytes`,
  )

  const gzipBytes = gzipSync(distBytes, { level: 9 })
  assert.ok(
    gzipBytes.length <= MAX_CLIENT_GZIP_BYTES,
    `dist/client.js gzip-9 size ${gzipBytes.length} exceeds ${MAX_CLIENT_GZIP_BYTES} bytes`,
  )

  const scratchDir = await mkdtemp(join(tmpdir(), 'niuma-build-parity-'))
  t.after(() => rm(scratchDir, { recursive: true, force: true }))
  // Keep outfile basename as client.js so esbuild legalComments: 'linked' output matches identically.
  const rebuiltPath = join(scratchDir, 'client.js')
  await buildClientBundle({ outfile: rebuiltPath })
  const rebuiltBytes = await readFile(rebuiltPath)
  assert.equal(
    Buffer.compare(distBytes, rebuiltBytes),
    0,
    'dist/client.js is out of sync with client sources; run `npm run build`',
  )
})
