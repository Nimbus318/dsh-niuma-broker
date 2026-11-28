import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const JS_KEYWORDS = new Set([
  'abstract', 'arguments', 'async', 'await', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'debugger', 'default', 'delete', 'do', 'double', 'else', 'enum', 'eval', 'export', 'extends', 'false',
  'final', 'finally', 'float', 'for', 'from', 'function', 'get', 'goto', 'if', 'implements', 'import', 'in', 'instanceof',
  'int', 'interface', 'let', 'long', 'native', 'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'return',
  'set', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'true', 'try',
  'typeof', 'undefined', 'var', 'void', 'volatile', 'while', 'with', 'yield', 'as', 'target', 'meta',
])
const EXPR_KEYWORDS = new Set(['true', 'false', 'null', 'this', 'super'])

const BROWSER_GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'Float32Array', 'Float64Array',
  'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError',
  'TypeError', 'URIError', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakSet', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'structuredClone', 'queueMicrotask',
  'globalThis', 'window', 'self', 'document', 'navigator', 'location', 'history', 'screen', 'localStorage', 'sessionStorage',
  'console', 'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams', 'Blob',
  'File', 'FileReader', 'FormData', 'Event', 'CustomEvent', 'MessageEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
  'EventTarget', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Document', 'Window', 'Range', 'Selection', 'Text',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'DOMParser', 'XMLSerializer', 'WebSocket', 'EventSource',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'crypto', 'performance', 'atob', 'btoa',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'getComputedStyle', 'alert', 'confirm', 'prompt', 'CSS', 'Image', 'Audio', 'Option', 'ClipboardItem', 'FileList', 'DataTransfer',
  'NodeFilter', 'MutationRecord', 'HTMLLinkElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement',
])

const isIdentStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$'
const isIdentPart = c => isIdentStart(c) || (c >= '0' && c <= '9')

/**
 * Finds non-property, non-keyword, >=3-char unbound identifiers in an IIFE bundle
 * produced with `minifyIdentifiers: true`. Skips method definitions `name(...) {`.
 */
function extractFreeIdentifiers(code) {
  const found = new Set()
  const len = code.length
  let i = 0
  let prevTok = 'punct'
  const templateDepth = []
  const ternaryStack = [0]

  const isMethodSignature = openParenIdx => {
    let depth = 0
    let p = openParenIdx
    while (p < len) {
      const ch = code[p]
      if (ch === '\'' || ch === '"') {
        p = skipQuoted(ch, p)
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          let k = p + 1
          while (k < len && code[k] <= ' ') k += 1
          return code[k] === '{'
        }
      }
      p += 1
    }
    return false
  }

  const skipQuoted = (quote, idx) => {
    let p = idx + 1
    while (p < len && code[p] !== quote) {
      if (code[p] === '\\') p += 2
      else p += 1
    }
    return p + 1
  }

  while (i < len) {
    const ch = code[i]
    if (ch <= ' ') {
      i += 1
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      i += 2
      while (i < len && code[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '"' || ch === '\'') {
      i = skipQuoted(ch, i)
      prevTok = 'exprEnd'
      continue
    }
    if (ch === '`') {
      i += 1
      while (i < len) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '`') { i += 1; prevTok = 'exprEnd'; break }
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2
          templateDepth.push(0)
          ternaryStack.push(0)
          prevTok = 'punct'
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '{') {
      if (templateDepth.length) templateDepth[templateDepth.length - 1] += 1
      ternaryStack.push(0)
      i += 1
      prevTok = '{'
      continue
    }
    if (ch === '}') {
      if (ternaryStack.length > 1) ternaryStack.pop()
      if (templateDepth.length) {
        if (templateDepth[templateDepth.length - 1] === 0) {
          templateDepth.pop()
          i += 1
          while (i < len) {
            if (code[i] === '\\') { i += 2; continue }
            if (code[i] === '`') { i += 1; prevTok = 'exprEnd'; break }
            if (code[i] === '$' && code[i + 1] === '{') {
              i += 2
              templateDepth.push(0)
              ternaryStack.push(0)
              prevTok = 'punct'
              break
            }
            i += 1
          }
          continue
        }
        templateDepth[templateDepth.length - 1] -= 1
      }
      i += 1
      prevTok = 'exprEnd'
      continue
    }
    if (ch === '(') {
      ternaryStack.push(0)
      i += 1
      prevTok = 'punct'
      continue
    }
    if (ch === ')') {
      if (ternaryStack.length > 1) ternaryStack.pop()
      i += 1
      prevTok = 'exprEnd'
      continue
    }
    if (ch === '/' && prevTok !== 'exprEnd' && prevTok !== 'ident') {
      i += 1
      let inClass = false
      while (i < len) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '[') inClass = true
        else if (code[i] === ']') inClass = false
        else if (code[i] === '/' && !inClass) { i += 1; break }
        i += 1
      }
      while (i < len && isIdentPart(code[i])) i += 1
      prevTok = 'exprEnd'
      continue
    }
    if (isIdentStart(ch)) {
      const start = i
      while (i < len && isIdentPart(code[i])) i += 1
      const word = code.slice(start, i)
      let j = i
      while (j < len && code[j] <= ' ') j += 1
      const nextCh = code[j] || ''
      const isProp = prevTok === '.'
      const inTernary = ternaryStack[ternaryStack.length - 1] > 0
      const isKey = nextCh === ':'
        && code[j + 1] !== ':'
        && !inTernary
        && (prevTok === '{' || prevTok === ',' || prevTok === ';' || prevTok === 'punct')
      const isMethod = nextCh === '(' && isMethodSignature(j)
      if (
        !isProp
        && !isKey
        && !isMethod
        && !JS_KEYWORDS.has(word)
        && !BROWSER_GLOBALS.has(word)
        && word.length >= 3
        && !word.startsWith('__')
      ) {
        found.add(word)
      }
      prevTok = EXPR_KEYWORDS.has(word) ? 'exprEnd' : JS_KEYWORDS.has(word) ? 'punct' : 'ident'
      continue
    }
    if (ch >= '0' && ch <= '9') {
      while (i < len && (isIdentPart(code[i]) || code[i] === '.')) i += 1
      prevTok = 'exprEnd'
      continue
    }
    if (ch === '.' && code[i + 1] === '.' && code[i + 2] === '.') { prevTok = 'punct'; i += 3; continue }
    if (ch === '?') {
      if (code[i + 1] === '.') { prevTok = '.'; i += 2; continue }
      if (code[i + 1] === '?') { prevTok = 'punct'; i += 2; continue }
      ternaryStack[ternaryStack.length - 1] += 1
      prevTok = '?'
      i += 1
      continue
    }
    if (ch === ':') {
      if (ternaryStack[ternaryStack.length - 1] > 0) ternaryStack[ternaryStack.length - 1] -= 1
      prevTok = 'punct'
      i += 1
      continue
    }
    if ((ch === '+' && code[i + 1] === '+') || (ch === '-' && code[i + 1] === '-')) {
      prevTok = 'exprEnd'
      i += 2
      continue
    }
    if (ch === '.') { prevTok = '.'; i += 1; continue }
    if (ch === ']') { prevTok = 'exprEnd'; i += 1; continue }
    if (ch === ',' || ch === ';') { prevTok = ch; i += 1; continue }
    prevTok = 'punct'
    i += 1
  }
  return [...found]
}

async function bundleIifeForIdentifierScan(entryOptions) {
  const res = await esbuild({
    ...entryOptions,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    charset: 'utf8',
    jsx: 'transform',
    loader: { '.svg': 'dataurl' },
    minifyIdentifiers: true,
    minifySyntax: false,
    minifyWhitespace: false,
    define: { __CAREER_AGENT_CSS__: '""', 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'stub-externals-and-vendor',
      setup(build) {
        build.onResolve(
          { filter: /^(react|react\/jsx-runtime|react-dom|react-dom\/client|@deepseek-ai\/dsh-client-ui-primitives)$/ },
          args => ({ path: `${args.path}.cjs`, namespace: 'stub' }),
        )
        build.onResolve({ filter: /vendor\// }, args => ({ path: `${args.path}.cjs`, namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }))
      },
    }],
  })
  return res.outputFiles[0].text
}

test('client production bundle has zero unbound global identifiers and catches split ReferenceError regressions', async () => {
  const prodBundle = await bundleIifeForIdentifierScan({ entryPoints: [join(ROOT, 'client', 'index.jsx')] })
  assert.deepEqual(extractFreeIdentifiers(prodBundle), [])

  const brokenBundle = await bundleIifeForIdentifierScan({
    stdin: {
      contents: `export function brokenDismiss(flag) {
        setHistory([]);
        const spread = { ...missingProps };
        const tern = flag ? !missingFlag : false;
        const msg = \`count: \${true / missingCount}\`;
        return [ACTIVE_TAB_KEY, spread, tern, msg];
      }\n`,
      resolveDir: join(ROOT, 'client'),
      loader: 'jsx',
    },
  })
  const caught = extractFreeIdentifiers(brokenBundle)
  for (const sym of ['setHistory', 'ACTIVE_TAB_KEY', 'missingProps', 'missingFlag', 'missingCount']) {
    assert.ok(caught.includes(sym), `scanner should catch unbound ${sym}`)
  }
})

test('client runtime smoke mounts main panel and exercises LibrarySheet, Evidence request, and Composer dismiss cleanly', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'niuma-client-smoke-'))
  const tempOut = join(tempDir, 'probe.mjs')
  const globalKeys = ['window', 'document', 'sessionStorage', 'localStorage', 'fetch']
  const savedDescriptors = Object.fromEntries(
    globalKeys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  )
  const setGlobal = (key, value) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true })
  }

  const reactShim = `
    const buckets = new Map();
    let activeBucket = 'root';
    let cursor = 0;
    const getSlots = () => {
      if (!buckets.has(activeBucket)) buckets.set(activeBucket, []);
      return buckets.get(activeBucket);
    };
    export const __reset = () => { buckets.clear(); activeBucket = 'root'; cursor = 0; };
    export const __withFrame = (key, fn) => {
      const savedBucket = activeBucket;
      const savedCursor = cursor;
      activeBucket = key;
      cursor = 0;
      try { return fn(); } finally { activeBucket = savedBucket; cursor = savedCursor; }
    };
    const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    export function useState(init) {
      const slots = getSlots();
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    }
    export function useReducer(reducer, init, initArg) {
      const slots = getSlots();
      const i = cursor++;
      if (!(i in slots)) slots[i] = initArg !== undefined ? init(initArg) : init;
      return [slots[i], (action) => { slots[i] = reducer(slots[i], action); }];
    }
    export function useRef(init) {
      const slots = getSlots();
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    }
    export function useMemo(factory, deps) {
      const slots = getSlots();
      const i = cursor++;
      const prev = slots[i];
      if (!prev || !deps || !depsEqual(prev.deps, deps)) slots[i] = { value: factory(), deps };
      return slots[i].value;
    }
    export function useCallback(fn, deps) { return useMemo(() => fn, deps); }
    export function useEffect() { cursor++; }
    export function useLayoutEffect() { cursor++; }
    export function useId() { const slots = getSlots(); const i = cursor++; slots[i] = slots[i] || ('id-' + i); return slots[i]; }
    export function useContext(ctx) { return ctx?._currentValue ?? ctx?.defaultValue ?? undefined; }
    export function useSyncExternalStore(_sub, getSnap) { return getSnap(); }
    export function createContext(defaultValue) {
      const ctx = { defaultValue, _currentValue: defaultValue, Provider: ({ value, children }) => { ctx._currentValue = value; return children; } };
      return ctx;
    }
    export const memo = (c) => c;
    export const forwardRef = (fn) => (props) => fn(props, null);
    export const Fragment = Symbol.for('react.fragment');
    export function isValidElement(x) { return Boolean(x && typeof x === 'object' && 'type' in x); }
    export function createElement(type, props, ...children) {
      const flat = children.length === 0 ? props?.children : children.length === 1 ? children[0] : children;
      return { type, props: { ...(props || {}), ...(flat !== undefined ? { children: flat } : {}) } };
    }
    export default {
      useState, useReducer, useRef, useMemo, useCallback, useEffect, useLayoutEffect,
      useId, useContext, useSyncExternalStore, createContext, memo, forwardRef,
      Fragment, isValidElement, createElement,
    };
  `
  const primitivesShim = `
    const tagComp = (name) => ({ children, ...rest }) => ({ type: name, props: { ...rest, children } });
    export const Button = tagComp('Button');
    export const Checkbox = tagComp('Checkbox');
    export const DisclosureRow = tagComp('DisclosureRow');
    export const FenceCodeBlock = tagComp('FenceCodeBlock');
    export const FishLogo = tagComp('FishLogo');
    export const MarkdownDelegateProvider = tagComp('MarkdownDelegateProvider');
    export const MarkdownText = tagComp('MarkdownText');
    export const SegmentedControl = tagComp('SegmentedControl');
    export const ShortcutKeys = tagComp('ShortcutKeys');
    export const StateDot = tagComp('StateDot');
    export const Switch = tagComp('Switch');
    export const Tag = tagComp('Tag');
    export const TextShimmer = tagComp('TextShimmer');
    export const UserMessageBubble = tagComp('UserMessageBubble');
    export function writeClipboard() {}
    export function useClipboardCopy() { return { copied: false, onCopy: () => {} }; }
    export function useDismissOnOutsidePointer() {}
    export function useModalLayer() { return {}; }
    export function useTheme() { return { theme: 'light' }; }
    export function useLocale() { return 'zh-CN'; }
  `

  try {
    const entrySrc = `
      import { apply } from ${JSON.stringify(join(ROOT, 'client', 'index.jsx'))};
      import { Evidence, LibrarySheet } from ${JSON.stringify(join(ROOT, 'client', 'ResumeLibrary.jsx'))};
      import Composer from ${JSON.stringify(join(ROOT, 'client', 'Composer.jsx'))};
      import { getComposerState, updateComposerStore } from ${JSON.stringify(join(ROOT, 'client', 'draft-store.js'))};
      import { I18nProvider } from ${JSON.stringify(join(ROOT, 'client', 'i18n.jsx'))};
      import * as ReactShim from 'react';
      export { apply, Evidence, LibrarySheet, Composer, getComposerState, updateComposerStore, I18nProvider, ReactShim };
    `

    await esbuild({
      stdin: { contents: entrySrc, resolveDir: ROOT, loader: 'jsx' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      outfile: tempOut,
      loader: { '.svg': 'dataurl' },
      define: { __CAREER_AGENT_CSS__: '""', 'process.env.NODE_ENV': '"test"' },
      plugins: [{
        name: 'shims',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-shim', namespace: 'shim' }))
          build.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom-shim', namespace: 'shim' }))
          build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives-shim', namespace: 'shim' }))
          build.onLoad({ filter: /^react-shim$/, namespace: 'shim' }, () => ({ contents: reactShim, loader: 'js' }))
          build.onLoad({ filter: /^react-dom-shim$/, namespace: 'shim' }, () => ({ contents: 'export function createPortal(c){return c}; export default {createPortal};', loader: 'js' }))
          build.onLoad({ filter: /^primitives-shim$/, namespace: 'shim' }, () => ({ contents: primitivesShim, loader: 'js' }))
        },
      }],
    })

    setGlobal('window', {
      location: { origin: 'http://127.0.0.1:0', pathname: '/', hash: '' },
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
      navigator: { language: 'zh-CN' },
    })
    setGlobal('document', {
      hidden: false,
      documentElement: { style: {} },
      createElement: () => ({ click() {}, setAttribute() {}, style: {} }),
      head: { appendChild() {} },
      getElementById: () => null,
      getElementsByTagName: () => [],
    })
    setGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    setGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })

    const { apply, Evidence, LibrarySheet, Composer, getComposerState, updateComposerStore, I18nProvider, ReactShim } = await import(tempOut)

    const renderTree = (el, keyPath = '0') => {
      if (!el || typeof el !== 'object') return el
      if (Array.isArray(el)) return el.map((child, idx) => renderTree(child, `${keyPath}.${idx}`))
      if (typeof el.type === 'function') {
        const name = el.type.name || 'anon'
        const out = ReactShim.__withFrame(`${keyPath}:${name}`, () => el.type(el.props || {}))
        return renderTree(out, `${keyPath}:${name}`)
      }
      if (el.props && 'children' in el.props) {
        return { ...el, props: { ...el.props, children: renderTree(el.props.children, `${keyPath}.c`) } }
      }
      return el
    }

    const findAll = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        for (const child of node) findAll(child, pred, out)
        return out
      }
      if (pred(node)) out.push(node)
      if (node.props?.children) findAll(node.props.children, pred, out)
      return out
    }

    // 1. Mount main slot and sidebar icon via apply(ctx)
    let mainComp = null
    const registeredSlots = []
    apply({
      workspace: {},
      slots: {
        inject(name, cb) { registeredSlots.push(name); cb() },
        register(spec, comp) { if (spec?.name === 'main') mainComp = comp; return () => {} },
      },
      events: { subscribe: () => () => {} },
      i18n: {},
    })
    assert.deepEqual(registeredSlots, ['main', 'sidebar.panellist'])
    assert.equal(typeof mainComp, 'function')
    assert.ok(renderTree({ type: mainComp, props: {} }))

    // 2. Render LibrarySheet manual ReflectionForm (exercises DIMENSION_IDS)
    const noopAct = async () => ({ ok: true, result: {} })
    noopAct.background = noopAct
    const renderLib = () => renderTree({
      type: LibrarySheet,
      props: {
        evidence: [],
        reflections: [],
        state: { intakes: [], recordings: { sources: [] } },
        config: { sources: [] },
        busy: '',
        act: noopAct,
        onResume() {},
        onClose() {},
      },
    })
    ReactShim.__reset()
    findAll(renderLib(), n => n.type === 'SegmentedControl')[0].props.onChange('reflections')
    const addBtn = findAll(renderLib(), n => n.type === 'Button' && n.props?.icon?.props?.name === 'plus')[0]
    assert.equal(typeof addBtn?.props?.onClick, 'function')
    addBtn.props.onClick()
    const options = findAll(renderLib(), n => n.type === 'option')
    assert.ok(options.length >= 6)

    // 3. Render Evidence excerpt loader (exercises shared request())
    ReactShim.__reset()
    const fetchCalls = []
    setGlobal('fetch', async (url, init) => {
      fetchCalls.push({ url, init })
      return {
        ok: true,
        status: 200,
        async json() { return { ok: true, result: { text: 'Original excerpt', deliverySummary: 'Summary' } } },
      }
    })
    const evTree = renderTree({
      type: Evidence,
      props: {
        item: { id: 'ev-dsh-1', sourceId: 'dsh-session', status: 'approved', title: 'Shipped', text: 'Built' },
        config: { sources: [{ id: 'dsh-session' }] },
        busy: '',
        act: noopAct,
      },
    })
    const detailsEl = findAll(evTree, n => n.type === 'details')[0]
    await detailsEl.props.onToggle({ currentTarget: { open: true } })
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'api/career-agent/action')

    // 4. Dismiss AssistantReplyCard in Composer without ReferenceError: setHistory
    ReactShim.__reset()
    updateComposerStore('jobs', {
      assistantReply: { kind: 'answer', summary: 'Done', data: { answer: 'Detailed reply' } },
      history: [{ role: 'user', text: 'Prior question' }],
    })
    const composerTree = renderTree({
      type: I18nProvider,
      props: {
        children: {
          type: Composer,
          props: {
            config: { sources: [], model: 'deepseek-chat' },
            act: noopAct,
            busy: '',
            opportunities: [],
            surface: 'jobs',
          },
        },
      },
    })
    const dismissBtn = findAll(composerTree, n => n.type === 'button' && n.props?.className === 'ca-copilot-close')[0]
    assert.equal(typeof dismissBtn?.props?.onClick, 'function', 'Composer AssistantReplyCard dismiss button should render')
    dismissBtn.props.onClick()
    assert.equal(getComposerState('jobs').assistantReply, null)
    assert.deepEqual(getComposerState('jobs').history, [])
  } finally {
    for (const key of globalKeys) {
      if (savedDescriptors[key]) Object.defineProperty(globalThis, key, savedDescriptors[key])
      else delete globalThis[key]
    }
    await rm(tempDir, { recursive: true, force: true })
  }
})
