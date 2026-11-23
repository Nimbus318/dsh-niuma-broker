import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdownBlocks } from '../src/markdown-blocks.mjs'

test('parseMarkdownBlocks parses headings, GFM tables, blockquotes, nested lists, code fences, and hr cleanly', () => {
  const md = [
    '### 1. 招聘官视角硬伤诊断',
    '',
    '先给结论：**核心经历含金量高**，但结构需聚焦。',
    '',
    '| 维度 | 现状 | 建议 |',
    '| :--- | :---: | ---: |',
    '| 指标量化 | 已有 41%→69% | 放首屏第一条 |',
    '| 职责边界 | 偏协同描述 | 改用主导动作 |',
    '',
    '> 原句：配合完成配额核对',
    '> 建议：主导 3 个 GPU 资源池配额治理',
    '',
    '1. 优化首屏个人简介',
    '  - 突出千卡集群规模',
    '  - 强调推理 P99 降低 37%',
    '2. 精简早期非核心项目',
    '',
    '---',
    '',
    '```markdown',
    '- **千卡 GPU 调度**：利用率从 41% 提至 69%',
    '```',
  ].join('\n')

  const blocks = parseMarkdownBlocks(md)
  assert.deepEqual(
    blocks.map(b => b.type),
    ['heading', 'paragraph', 'table', 'blockquote', 'list', 'hr', 'code'],
  )
  assert.equal(blocks[0].level, 3)
  assert.equal(blocks[0].text, '1. 招聘官视角硬伤诊断')
  assert.deepEqual(blocks[2].headers, ['维度', '现状', '建议'])
  assert.deepEqual(blocks[2].alignments, ['left', 'center', 'right'])
  assert.equal(blocks[2].rows.length, 2)
  assert.equal(blocks[3].lines.length, 2)
  assert.equal(blocks[4].ordered, true)
  assert.equal(blocks[4].items.length, 2)
  assert.equal(blocks[4].items[0].children.length, 2)
  assert.equal(blocks[6].lang, 'markdown')
  assert.equal(blocks[6].closed, true)
})

test('parseMarkdownBlocks tolerates unclosed streaming code fences without losing text', () => {
  const streaming = '正在给出改写示例：\n\n```markdown\n- 主导千卡 GPU 集群调度'
  const blocks = parseMarkdownBlocks(streaming)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].type, 'code')
  assert.equal(blocks[1].closed, false)
  assert.match(blocks[1].code, /千卡 GPU/)
})
