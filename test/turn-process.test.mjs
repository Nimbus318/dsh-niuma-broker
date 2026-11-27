import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function loadTurnProcessModule(dir) {
  const outfile = join(dir, 'turn-process.mjs')
  const reactShim = `
    let slots = [], cursor = 0;
    export const __begin = () => { slots = []; cursor = 0; };
    export function useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; }
    export function useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; }
    export function useMemo(fn) { cursor++; return fn(); }
    export function useEffect() { cursor++; }
    export function useContext(ctx) { return ctx?._v; }
    export function createContext(d) { return { _v: d, Provider: ({ children }) => children }; }
    export function createElement(type, props, ...children) {
      const c = children.length === 0 ? props?.children : children.length === 1 ? children[0] : children;
      return { type, props: { ...(props || {}), ...(c !== undefined ? { children: c } : {}) } };
    }
    export const Fragment = Symbol.for('react.fragment');
    export default { useState, useRef, useMemo, useEffect, useContext, createContext, createElement, Fragment };
  `
  const primitivesShim = `
    const tag = name => ({ children, ...rest }) => ({ type: name, props: { ...rest, children } });
    export const DisclosureRow = tag('DisclosureRow');
    export const StateDot = tag('StateDot');
    export const TextShimmer = tag('TextShimmer');
  `
  await esbuild({
    entryPoints: [resolve(ROOT, 'client/TurnProcess.jsx')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    plugins: [{
      name: 'tp-test-shims',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'shim' }))
        b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'prim', namespace: 'shim' }))
        b.onLoad({ filter: /^react$/, namespace: 'shim' }, () => ({ contents: reactShim, loader: 'js' }))
        b.onLoad({ filter: /^prim$/, namespace: 'shim' }, () => ({ contents: primitivesShim, loader: 'js' }))
      },
    }],
  })
  return import(outfile)
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out)
    return out
  }
  if (typeof node.type === 'function') {
    collectNodes(node.type(node.props || {}), pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  if (node.type === 'DisclosureRow' && !node.props?.open) return out
  if (node.props?.children) collectNodes(node.props.children, pred, out)
  return out
}

test('TurnProcess summarizes turn outcomes cleanly and keeps thinking & fold collapsed by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-proc-'))
  try {
    const zh = JSON.parse(await readFile(resolve(ROOT, 'locale/messages/zh.json'), 'utf8'))
    const t = (key, vars = {}) => {
      const [ns, k] = key.split('.')
      let s = zh[ns]?.[k] ?? key
      for (const [vk, vv] of Object.entries(vars)) s = s.replaceAll(`{${vk}}`, String(vv))
      return s
    }

    globalThis.window = { setInterval: () => 1, clearInterval: () => {} }
    const mod = await loadTurnProcessModule(dir)
    const { summarizeTurnProcess, default: TurnProcess, __begin } = mod
    assert.equal(typeof summarizeTurnProcess, 'function')

    assert.equal(summarizeTurnProcess({
      outcome: 'ok',
      elapsedMs: 6200,
      contextItems: [{ kind: 'resume' }, { kind: 'job', label: '快手 · GPU' }],
      steps: [{ name: 'update_resume', state: 'done' }],
      citedEvidenceCount: 2,
    }, t), '已对照简历与 快手 · GPU JD · 更新了简历 · 引用 2 条成果 · 6.2s')

    assert.equal(summarizeTurnProcess({
      outcome: 'stopped',
      elapsedMs: 1800,
      contextItems: [{ kind: 'resume' }],
      steps: [],
    }, t), '已读取当前简历 · 已停止 · 1.8s')

    assert.equal(summarizeTurnProcess({
      outcome: 'interrupted',
      elapsedMs: 4100,
      contextItems: [],
      steps: [],
    }, t), '连接中断 · 4.1s')

    // Live render: thinking row must start collapsed (open === false)
    const liveEl = {
      type: TurnProcess,
      props: {
        streaming: true,
        hasContent: false,
        trace: {
          outcome: 'running',
          contextItems: [{ kind: 'resume', label: '主稿', chars: 1200 }],
          thinkingText: '正在分析高亮重点',
          thinkingStartedAt: Date.now() - 500,
          thinkingMs: 0,
          steps: [{ id: 'c1', kind: 'tool', name: 'update_resume', state: 'ongoing', startedAt: Date.now() - 200 }],
        },
      },
    }
    const liveRows = collectNodes(liveEl, n => n.type === 'DisclosureRow')
    assert.equal(liveRows.length, 3)
    assert.equal(liveRows[1].props.open, false, 'thinking row must start collapsed while streaming')

    // Live TTFT wait after context loaded: must STILL show an ongoing spinner row instead of freezing!
    const waitAfterCtxEl = {
      type: TurnProcess,
      props: {
        streaming: true,
        hasContent: false,
        trace: {
          outcome: 'running',
          startedAt: Date.now() - 1200,
          attemptStartedAt: Date.now() - 1100,
          contextItems: [{ kind: 'resume', label: '主稿', chars: 1200 }],
          thinkingText: '',
          thinkingMs: 0,
          steps: [],
        },
      },
    }
    const waitRows = collectNodes(waitAfterCtxEl, n => n.type === 'DisclosureRow')
    assert.equal(waitRows.length, 2, 'must show context row + live ongoing waiting row during TTFT')
    assert.equal(waitRows[1].props.running, true)

    // Live summarize wait after tools complete (before prose starts): must show ongoing summarize row
    const summarizeWaitEl = {
      type: TurnProcess,
      props: {
        streaming: true,
        hasContent: false,
        trace: {
          outcome: 'running',
          attemptStartedAt: Date.now() - 400,
          contextItems: [{ kind: 'resume', label: '主稿', chars: 1200 }],
          thinkingText: '',
          thinkingMs: 0,
          steps: [{ id: 'c1', kind: 'tool', name: 'update_resume', state: 'done', elapsedMs: 1200 }],
        },
      },
    }
    const summarizeRows = collectNodes(summarizeWaitEl, n => n.type === 'DisclosureRow')
    assert.equal(summarizeRows.length, 3)
    assert.equal(summarizeRows[2].props.running, true)

    // Streaming prose already started: no redundant waiting row
    const streamingProseEl = {
      type: TurnProcess,
      props: {
        streaming: true,
        hasContent: true,
        trace: {
          outcome: 'running',
          attemptStartedAt: Date.now() - 1200,
          contextItems: [{ kind: 'resume', label: '主稿', chars: 1200 }],
          thinkingText: '',
          thinkingMs: 0,
          steps: [],
        },
      },
    }
    const proseRows = collectNodes(streamingProseEl, n => n.type === 'DisclosureRow')
    assert.equal(proseRows.length, 1)

    // Settled render: folds into 1 collapsed DisclosureRow
    const settledEl = {
      type: TurnProcess,
      props: {
        streaming: false,
        trace: {
          outcome: 'ok',
          elapsedMs: 3200,
          modelName: 'DeepSeek V3',
          effort: 'high',
          contextItems: [{ kind: 'resume', label: '主稿', chars: 1200 }],
          thinkingText: '完整思考',
          thinkingMs: 1100,
          steps: [{ id: 'c1', kind: 'tool', name: 'update_resume', state: 'done', summary: '已更新简历正文（共 2 项调整）。' }],
        },
      },
    }
    const settledTopRows = collectNodes(settledEl, n => n.type === 'DisclosureRow')
    assert.equal(settledTopRows.length, 1)
    assert.equal(settledTopRows[0].props.open, false, 'settled turn must auto-fold into 1 summary DisclosureRow')
    assert.equal(settledTopRows[0].props.expandable, true)

    const { normalizeCjkBoldMarkdown } = await import('../src/resume-style.mjs')
    assert.equal(
      normalizeCjkBoldMarkdown('- **LLM 推理网关与性能优化：**主导设计'),
      '- **LLM 推理网关与性能优化**：主导设计',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('- **推理框架（vLLM）**优化吞吐'),
      '- **推理框架（vLLM）** 优化吞吐',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('- **Bold** text and **标题**：正文'),
      '- **Bold** text and **标题**：正文',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('**Python**，以及：**Go**。'),
      '**Python**，以及：**Go**。',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('**Title:**正文 / **技术栈:**Python / **推理框架(vLLM)**GPU / **框架（vLLM）**Engine'),
      '**Title**:正文 / **技术栈**:Python / **推理框架(vLLM)** GPU / **框架（vLLM）** Engine',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('**/dist,**cache and **a)**b'),
      '**/dist,**cache and **a)**b',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('**路径 `/dist，**cache`** 正文'),
      '**路径 `/dist，**cache`** 正文',
    )
    assert.equal(
      normalizeCjkBoldMarkdown('忽略 `**/dist,**cache` 与 fenced:\n```bash\nls **/dist,**cache\n```\n结束'),
      '忽略 `**/dist,**cache` 与 fenced:\n```bash\nls **/dist,**cache\n```\n结束',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
