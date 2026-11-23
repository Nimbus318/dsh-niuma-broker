import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanBaseTitle, extractResumeFileText } from '../src/file-extract.mjs'
import { findLocalPdfBrowser, renderLocalResumePdf } from '../src/local-pdf.mjs'

test('cleanBaseTitle strips extension and falls back cleanly', () => {
  assert.equal(cleanBaseTitle('林予安_高级工程师_2026.pdf'), '林予安_高级工程师_2026')
  assert.equal(cleanBaseTitle('resume.docx'), 'resume')
  assert.equal(cleanBaseTitle(''), '导入简历')
})

test('extractResumeFileText reads UTF-8 Markdown and TXT directly without subprocesses', async () => {
  const sample = '# 林予安\n## 工作经历\n- 负责推理网关稳定性建设'
  let execCalled = false
  const out = await extractResumeFileText(
    { filename: 'cv.md', buffer: Buffer.from(sample, 'utf8') },
    { runner: async () => { execCalled = true; return { stdout: '' } } },
  )
  assert.equal(execCalled, false)
  assert.equal(out.method, 'text')
  assert.equal(out.format, 'md')
  assert.equal(out.text, sample)
})

test('extractResumeFileText extracts PDF via macOS PDFKit and falls back to pdftotext', async () => {
  const pdfBuf = Buffer.from('%PDF-1.7\nfake-pdf-bytes')
  const viaKit = await extractResumeFileText(
    { filename: '张三简历.pdf', buffer: pdfBuf },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        if (cmd === '/usr/bin/osascript') {
          return { stdout: JSON.stringify({ method: 'pdfkit', pages: 2, text: '张三\nAI 基础设施工程师' }) }
        }
        throw new Error('unexpected cmd ' + cmd)
      },
    },
  )
  assert.equal(viaKit.method, 'pdfkit')
  assert.equal(viaKit.pages, 2)
  assert.match(viaKit.text, /张三/)

  const viaPdftotext = await extractResumeFileText(
    { filename: 'resume.pdf', buffer: pdfBuf },
    {
      platform: 'linux',
      runner: async (cmd) => {
        if (cmd === 'pdftotext') return { stdout: 'Jane Doe\nStaff Engineer' }
        throw new Error('missing ' + cmd)
      },
    },
  )
  assert.equal(viaPdftotext.method, 'pdftotext')
  assert.match(viaPdftotext.text, /Jane Doe/)
})

test('extractResumeFileText handles Word .docx via textutil and image OCR via Vision', async () => {
  const docx = await extractResumeFileText(
    { filename: '王五.docx', buffer: Buffer.from('PK\x03\x04fake-docx') },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        if (cmd === '/usr/bin/textutil') return { stdout: '王五\n后端架构师\n主导支付核心重构' }
        throw new Error('unexpected cmd ' + cmd)
      },
    },
  )
  assert.equal(docx.method, 'textutil')
  assert.match(docx.text, /支付核心重构/)

  const img = await extractResumeFileText(
    { filename: 'resume-screenshot.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        if (cmd === '/usr/bin/osascript') return { stdout: JSON.stringify({ text: '李四\n前端负责人\nReact + TypeScript' }) }
        throw new Error('unexpected cmd ' + cmd)
      },
    },
  )
  assert.equal(img.method, 'vision-ocr')
  assert.match(img.text, /前端负责人/)
})

test('extractResumeFileText rejects empty, oversized, and unsupported binary files clearly', async () => {
  await assert.rejects(
    () => extractResumeFileText({ filename: 'empty.pdf', buffer: Buffer.alloc(0) }),
    /文件为空/,
  )
  await assert.rejects(
    () => extractResumeFileText({ filename: 'huge.pdf', buffer: Buffer.alloc(16 * 1024 * 1024) }),
    /15 MB/,
  )
  await assert.rejects(
    () => extractResumeFileText({ filename: 'archive.bin', buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]) }),
    /暂不支持直接读取/,
  )
})

test('live macOS PDF extraction round-trips a rendered resume PDF cleanly', async t => {
  if (process.platform !== 'darwin' || !findLocalPdfBrowser()) {
    t.skip('requires macOS and local Chromium PDF renderer')
    return
  }
  const rendered = await renderLocalResumePdf({
    title: '端到端测试简历',
    text: '# 林予安\n上海 · linyuan@example.com\n## 工作经历\n### 字节跳动 · AI Infra 资深工程师\n- 主导推理网关高可用重构，P99 延迟下降 42%。',
    template: 'onyx',
  })
  const extracted = await extractResumeFileText({
    filename: '林予安简历.pdf',
    mimeType: 'application/pdf',
    buffer: rendered.pdf,
  })
  assert.equal(extracted.format, 'pdf')
  assert.ok(['pdfkit', 'pdftotext', 'pdf-ocr'].includes(extracted.method))
  assert.match(extracted.text, /林予安/)
  assert.match(extracted.text, /42%/)
})
