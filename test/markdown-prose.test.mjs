import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { looksLikeResumeSnippet } from '../src/resume-snippet.mjs'

test('looksLikeResumeSnippet recognizes insertable markdown/bullet snippets and skips generic code fences', () => {
  assert.equal(looksLikeResumeSnippet('markdown', '- **千卡 GPU 调度**：利用率从 41% 提至 69%'), true)
  assert.equal(looksLikeResumeSnippet('md', '## 核心技能\n- Kubernetes / vLLM / CUDA'), true)
  assert.equal(looksLikeResumeSnippet('', '## Summary\nBuilt low-latency serving infrastructure'), true)
  assert.equal(looksLikeResumeSnippet('python', '- item inside python block should not match'), false)
  assert.equal(looksLikeResumeSnippet('markdown', '- short'), false)
  assert.equal(looksLikeResumeSnippet('markdown', '普通说明文字没有标题或列表符号'), false)
})

test('client/MarkdownProse.jsx delegates rendering to DSH ui-primitives and src/markdown-blocks.mjs is removed', () => {
  const proseUrl = new URL('../client/MarkdownProse.jsx', import.meta.url)
  const legacyBlocksUrl = new URL('../src/markdown-blocks.mjs', import.meta.url)
  assert.equal(existsSync(legacyBlocksUrl), false, 'hand-rolled src/markdown-blocks.mjs should be removed')
  const src = readFileSync(proseUrl, 'utf8')
  assert.match(src, /MarkdownText/)
  assert.match(src, /MarkdownDelegateProvider/)
  assert.match(src, /FenceCodeBlock/)
  assert.doesNotMatch(src, /markdown-blocks/)
})
