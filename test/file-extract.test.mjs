import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { createFetchHarness } from './_fetch-harness.mjs'
import { extractDocxDetails } from '../src/docx-extract.mjs'
import { cleanBaseTitle, extractDocxText, extractHtmlText, extractOdtText, extractResumeFileText, isCorruptedOfficeKitPdfText } from '../src/file-extract.mjs'
import { apply } from '../src/host.mjs'
import { findLocalPdfBrowser, renderLocalResumePdf } from '../src/local-pdf.mjs'

function buildZip(files, { method = 8, overrideUncompSize = null, useDataDescriptor = false } = {}) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const compBuf = method === 8 ? deflateRawSync(rawBuf) : rawBuf
    const uncompSize = overrideUncompSize ?? rawBuf.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(useDataDescriptor ? 0x0008 : 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(useDataDescriptor ? 0 : compBuf.length, 18)
    local.writeUInt32LE(useDataDescriptor ? 0 : uncompSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    localParts.push(local, nameBuf, compBuf)
    let ddLen = 0
    if (useDataDescriptor) {
      const dd = Buffer.alloc(16)
      dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(0, 4)
      dd.writeUInt32LE(compBuf.length, 8)
      dd.writeUInt32LE(uncompSize, 12)
      localParts.push(dd)
      ddLen = dd.length
    }

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(useDataDescriptor ? 0x0008 : 0, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(compBuf.length, 20)
    cd.writeUInt32LE(uncompSize, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    centralParts.push(cd, nameBuf)

    offset += local.length + nameBuf.length + compBuf.length + ddLen
  }
  const cdBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cdBuf, eocd])
}

function buildCidFontPdf({ heading, encoding, ordering, hexPayload }) {
  const streamContent = `BT\n/F1 14 Tf\n72 720 Td\n(${heading}) Tj\n0 -24 Td\n/F2 12 Tf\n<${hexPayload}> Tj\nET\n`
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /${encoding} /DescendantFonts [6 0 R] >>\nendobj\n`,
    `6 0 obj\n<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 4 >> /DW 1000 >>\nendobj\n`,
    `7 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}endstream\nendobj\n`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const o of objs) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += o
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

function toUtf16BeHex(str) {
  return [...str].map(c => c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()).join('')
}

const enoentRunner = async (cmd) => {
  const err = new Error(`spawn ${cmd} ENOENT`)
  err.code = 'ENOENT'
  throw err
}

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

test('extractResumeFileText preserves active Word headers/footers and excludes inactive/orphan headers and hidden text', async () => {
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const docxBuf = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': [
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rIdHdrDefault" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_default.xml"/>',
      '<Relationship Id="rIdHdrFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_first.xml"/>',
      '<Relationship Id="rIdHdrEven" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_even.xml"/>',
      '<Relationship Id="rIdFtrDefault" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer_default.xml"/>',
      '<Relationship Id="rIdFtrFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer_first.xml"/>',
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '</Relationships>',
    ].join(''),
    'word/styles.xml': [
      `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W_NS}>`,
      '<w:style w:type="character" w:styleId="HiddenChar"><w:rPr><w:vanish/></w:rPr></w:style>',
      '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>',
      '</w:styles>',
    ].join(''),
    // Visible normal header (active!) containing current contact info + a hidden run that MUST be stripped
    'word/header_default.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>林予安</w:t><w:tab/><w:t>current.contact@example.com</w:t><w:tab/><w:t>138-0000-1111</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>header.hidden@example.com</w:t></w:r></w:p></w:hdr>`,
    // Inactive first-page header (no <w:titlePg/>) containing old contact info that MUST NOT leak
    'word/header_first.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>OLD_FIRST_PHONE_13999999999</w:t></w:r></w:p></w:hdr>`,
    // Inactive even-page header (no <w:evenAndOddHeaders/>)
    'word/header_even.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>INACTIVE_EVEN_HEADER_UNUSED</w:t></w:r></w:p></w:hdr>`,
    // Unreferenced orphan header in ZIP
    'word/header_orphan.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>ORPHAN_HEADER_STALE</w:t></w:r></w:p></w:hdr>`,
    // Active default footer + inactive first-page footer
    'word/footer_default.xml': `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W_NS}><w:p><w:r><w:t>github.com/linyuan-current</w:t></w:r></w:p></w:ftr>`,
    'word/footer_first.xml': `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W_NS}><w:p><w:r><w:t>OLD_HIDDEN_FOOTER_DRAFT</w:t></w:r></w:p></w:ftr>`,
    'word/document.xml': [
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>`,
      '<w:p><w:r><w:t>工作经历 &#x2014; AI Infra &amp; Systems</w:t></w:r></w:p>',
      // Direct <w:vanish/>, <w:vanish w:val="true"/>, and <w:webHidden/> hidden text MUST NOT appear
      '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden.direct@example.com</w:t></w:r><w:r><w:rPr><w:vanish w:val="true"/></w:rPr><w:t>hidden.true@example.com</w:t></w:r><w:r><w:rPr><w:webHidden/></w:rPr><w:t>hidden.web@example.com</w:t></w:r></w:p>',
      // Style-inherited hidden runs + explicit w:val="0" override back to visible
      '<w:p><w:r><w:rPr><w:rStyle w:val="HiddenChar"/></w:rPr><w:t>hidden.charstyle@example.com</w:t></w:r><w:r><w:rPr><w:rStyle w:val="HiddenChar"/><w:vanish w:val="0"/></w:rPr><w:t>override.visible@example.com</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr><w:r><w:t>hidden.parastyle@example.com</w:t></w:r></w:p>',
      // Word Style Separator (<w:pPr><w:rPr><w:vanish/> on paragraph mark only) MUST NOT hide visible runs inside paragraph!
      '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>样式分隔符段落正文必须保留</w:t></w:r></w:p>',
      '<w:tbl><w:tr>',
      '<w:tc><w:p><w:r><w:t>字节跳动</w:t></w:r></w:p></w:tc>',
      '<w:tc><w:p><w:r><w:t>主导千卡 GPU 调度优化&lt;P99降42%&gt;</w:t><w:br/><w:t>年省成本 1400 万</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden.table@example.com</w:t></w:r></w:p></w:tc>',
      '</w:tr></w:tbl>',
      '<w:p><w:del><w:r><w:delText>已删除草稿句子不应出现</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK "https://hidden"</w:instrText><w:t>保留正式条目</w:t></w:r></w:p>',
      '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdrDefault"/><w:headerReference w:type="first" r:id="rIdHdrFirst"/><w:headerReference w:type="even" r:id="rIdHdrEven"/><w:footerReference w:type="default" r:id="rIdFtrDefault"/><w:footerReference w:type="first" r:id="rIdFtrFirst"/></w:sectPr>',
      '</w:body></w:document>',
    ].join(''),
  })

  for (const platform of ['win32', 'linux', 'darwin']) {
    let subprocessCalled = false
    const out = await extractResumeFileText(
      { filename: '林予安简历.docx', buffer: docxBuf },
      {
        platform,
        runner: async () => { subprocessCalled = true; throw new Error('must not spawn subprocess') },
      },
    )
    assert.equal(subprocessCalled, false, `must not spawn subprocess for valid .docx on ${platform}`)
    assert.equal(out.method, 'docx')
    assert.equal(out.format, 'docx')
    // Active visible header, body, style-separator paragraph, override visible run, and active footer MUST be preserved
    assert.match(out.text, /林予安\tcurrent\.contact@example\.com\t138-0000-1111/)
    assert.match(out.text, /工作经历 — AI Infra & Systems/)
    assert.match(out.text, /override\.visible@example\.com/)
    assert.match(out.text, /样式分隔符段落正文必须保留/)
    assert.match(out.text, /字节跳动/)
    assert.match(out.text, /主导千卡 GPU 调度优化<P99降42%>\n年省成本 1400 万/)
    assert.match(out.text, /保留正式条目/)
    assert.match(out.text, /github\.com\/linyuan-current/)
    // Inactive first/even/orphan headers, inactive footer, deleted text, field codes, and ALL hidden runs MUST be excluded
    assert.doesNotMatch(out.text, /OLD_FIRST_PHONE_13999999999/)
    assert.doesNotMatch(out.text, /INACTIVE_EVEN_HEADER_UNUSED/)
    assert.doesNotMatch(out.text, /ORPHAN_HEADER_STALE/)
    assert.doesNotMatch(out.text, /OLD_HIDDEN_FOOTER_DRAFT/)
    assert.doesNotMatch(out.text, /header\.hidden@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.direct@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.true@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.web@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.charstyle@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.parastyle@example\.com/)
    assert.doesNotMatch(out.text, /hidden\.table@example\.com/)
    assert.doesNotMatch(out.text, /已删除草稿句子不应出现/)
    assert.doesNotMatch(out.text, /HYPERLINK/)
  }

  // Valid .docx with data-descriptor ZIP entries, custom officeDocument part path (word/document2.xml),
  // modern Word Choice-only text box (no VML Fallback), Choice-diverged text box (Choice MUST win over stale Fallback),
  // and hidden text inside a modern Choice text box
  const DRAWING_NS = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"'
  const complexDocxBuf = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml"/></Relationships>',
    'word/document2.xml': [
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS} ${DRAWING_NS}><w:body>`,
      '<w:p><w:r><w:t>自定义主文档路径简历正文</w:t></w:r></w:p>',
      // Choice-only modern DrawingML text box (NO mc:Fallback at all!)
      '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>ChoiceOnlyModernBox</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>',
      // Choice vs Fallback with DIVERGED content: modern Choice MUST win; stale Fallback MUST NOT appear; hidden run in Choice stripped!
      '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Portfolio architecture</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden.textbox@example.com</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Fallback technical writing</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>',
      '</w:body></w:document>',
    ].join(''),
  }, { useDataDescriptor: true })
  const complexOut = await extractResumeFileText(
    { filename: 'wps-export.docx', buffer: complexDocxBuf },
    { platform: 'win32', runner: enoentRunner },
  )
  assert.equal(complexOut.method, 'docx')
  assert.match(complexOut.text, /自定义主文档路径简历正文/)
  assert.match(complexOut.text, /ChoiceOnlyModernBox/, 'Choice-only modern Word text box must be read')
  assert.match(complexOut.text, /Portfolio architecture/, 'modern mc:Choice content must be preferred over legacy mc:Fallback')
  assert.doesNotMatch(complexOut.text, /Fallback technical writing/, 'diverged legacy mc:Fallback must not override mc:Choice')
  assert.doesNotMatch(complexOut.text, /hidden\.textbox@example\.com/)

  // Strict OOXML namespace .docx (ISO/IEC 29500 Strict) works identically
  const STRICT_W = 'xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"'
  const strictDocx = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${STRICT_W}><w:body><w:p><w:r><w:t>StrictOOXML正文</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>strict.hidden@example.com</w:t></w:r></w:p></w:body></w:document>`,
  })
  const strictOut = await extractDocxText(strictDocx)
  assert.match(strictOut, /StrictOOXML正文/)
  assert.doesNotMatch(strictOut, /strict\.hidden@example\.com/)

  // Corrupted / encrypted non-ZIP .docx returns friendly Chinese guidance without leaking JSZip internals
  await assert.rejects(
    () => extractResumeFileText(
      { filename: 'encrypted.docx', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { platform: 'win32', runner: enoentRunner },
    ),
    (err) => {
      assert.doesNotMatch(err.message, /jszip|github\.io|central directory/i)
      assert.match(err.message, /无法解析该 \.docx 文件/)
      return true
    },
  )

  // Valid .docx containing ONLY hidden text must NOT fall back to macOS textutil (which could leak hidden text)
  const hiddenOnlyDocx = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>only.hidden@example.com</w:t></w:r></w:p></w:body></w:document>`,
  })
  let textutilCalled = false
  await assert.rejects(
    () => extractResumeFileText(
      { filename: 'hidden-only.docx', buffer: hiddenOnlyDocx },
      {
        platform: 'darwin',
        runner: async () => { textutilCalled = true; return { stdout: 'only.hidden@example.com' } },
      },
    ),
    /未能从该 \.docx 文档中提取出有效文字/,
  )
  assert.equal(textutilCalled, false, 'valid .docx with only hidden text must not fall back to textutil')

  // Zip-bomb XML header defense rejects oversized claimed XML entry cleanly
  const bombBuf = buildZip({ 'word/document.xml': '<w:document/>' }, { overrideUncompSize: 50 * 1024 * 1024 })
  await assert.rejects(() => extractDocxText(bombBuf), /体积过大/)
})

test('local DOCX fallback keeps ordinary resume content and leaves uncertain page headers out', async () => {
  const twoPages = await readFile(new URL('../scripts/ci/fixtures/resume-two-pages.docx', import.meta.url))
  const ordinary = await extractDocxDetails(twoPages)
  for (const content of ['测试候选人', 'candidate@example.com', 'GPU 调度', '第二页项目经历']) {
    assert(ordinary.text.includes(content), `Ordinary DOCX lost ${content}`)
  }

  const alternating = await readFile(new URL('../scripts/ci/fixtures/two-explicit-pages.docx', import.meta.url))
  const result = await extractDocxDetails(alternating)
  assert.match(result.text, /FIRST_HEADER/)
  assert.match(result.text, /FIRST_PAGE_BODY/)
  assert.match(result.text, /SECOND_PAGE_BODY/)
  assert.doesNotMatch(result.text, /EVEN_HEADER|DEFAULT_HEADER/)
  assert.equal(result.visibilityUncertain, true)
})

test('a tracked table-cell deletion keeps Word import on the local path', async () => {
  const buffer = buildZip({
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Current contact</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:cellDel w:id="1" w:author="Synthetic QA"/></w:tcPr><w:p><w:r><w:t>Old contact</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  })
  let rendered = false
  const officeKit = { convert() { rendered = true; throw new Error('Unexpected Office Kit conversion') } }
  const result = await extractResumeFileText({ filename: 'table-revision.docx', buffer }, { officeKit })
  assert.equal(rendered, false)
  assert.equal(result.method, 'docx')
  assert.match(result.text, /Current contact/)
})

test('POST /api/career-agent/parse-resume-file keeps local document fallbacks in preview and sends Office Kit output cleanly to LLM', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-parse-docx-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const docxBuf = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDef" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_def.xml"/><Relationship Id="rIdFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_first.xml"/></Relationships>',
    'word/header_def.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>林予安 · visible.current@example.com</w:t></w:r></w:p></w:hdr>`,
    'word/header_first.xml': `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}><w:p><w:r><w:t>disabled.first@example.com</w:t></w:r></w:p></w:hdr>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>资深系统工程师</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret.vanish@example.com</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdDef"/><w:headerReference w:type="first" r:id="rIdFirst"/></w:sectPr></w:body></w:document>`,
  })

  const capturedPrompts = []
  const harness = createFetchHarness()
  let dispose
  let activeOfficeKit = undefined
  const ctx = {
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm: {
      listProviders: () => [{ id: 'mock', models: [{ id: 'mock-model' }] }],
      resolveModel: () => ({ providerId: 'mock', modelId: 'mock-model' }),
      async *stream(req) {
        capturedPrompts.push(JSON.stringify(req))
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            title: '林予安 · 基础简历',
            markdown: '# 林予安\nvisible.current@example.com\n\n## 工作经历\n- 资深系统工程师',
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get: name => (name === 'officeKit' ? activeOfficeKit : undefined),
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  // 1) Without Office Kit (local Word fallback): preserves active header, strips hidden/inactive text,
  //    AND stays strictly in local preview without auto-sending to LLM even when explicitUseAi=true.
  const rawRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: '林予安.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: docxBuf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:mock-model',
  })
  assert.equal(rawRes.status, 200)
  assert.equal(rawRes.json.ok, true)
  assert.equal(rawRes.json.result.method, 'docx')
  assert.equal(rawRes.json.result.structuredByAi, false)
  assert.equal(rawRes.json.result.visibilityUncertain, true)
  assert.match(rawRes.json.result.warning, /本地文本|文字版 PDF/)
  assert.equal(capturedPrompts.length, 0, 'local Word fallback must never auto-send to LLM')
  assert.match(rawRes.json.result.text, /visible\.current@example\.com/)
  assert.match(rawRes.json.result.text, /资深系统工程师/)
  assert.doesNotMatch(rawRes.json.result.text, /disabled\.first@example\.com/)
  assert.doesNotMatch(rawRes.json.result.text, /secret\.vanish@example\.com/)

  // 2) With Office Kit active: layout-rendered PDF text goes through AI structuring cleanly!
  const renderedPdf = buildCidFontPdf({
    heading: 'visible.current@example.com',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('林予安：资深系统工程师'),
  })
  activeOfficeKit = { async convert() { return { pdf: new Uint8Array(renderedPdf), missingFonts: [] } } }
  const aiRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: '林予安.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: docxBuf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:mock-model',
  })
  assert.equal(aiRes.status, 200)
  assert.equal(aiRes.json.ok, true)
  assert.equal(aiRes.json.result.method, 'office-kit')
  assert.equal(aiRes.json.result.structuredByAi, true)
  assert.equal(aiRes.json.result.visibilityUncertain, undefined)
  assert.equal(capturedPrompts.length, 1)
  assert.match(capturedPrompts[0], /visible\.current@example\.com/)
  assert.doesNotMatch(capturedPrompts[0], /disabled\.first@example\.com/)
  assert.doesNotMatch(capturedPrompts[0], /secret\.vanish@example\.com/)

  await t.test('keeps revised Word text local even when Office Kit is available', async () => {
    const revisionFile = await readFile(new URL('../scripts/ci/fixtures/resume-with-revisions.docx', import.meta.url))
    let rendered = false
    activeOfficeKit = { async convert() {
      rendered = true
      throw new Error('Revised documents should not use Office Kit rendering')
    } }
    const before = capturedPrompts.length
    const response = await harness.call('POST', '/api/career-agent/parse-resume-file', {
      filename: 'revised-resume.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      dataBase64: revisionFile.toString('base64'),
      useAi: true,
      explicitUseAi: true,
      model: 'mock:mock-model',
    })
    assert.equal(response.status, 200)
    assert.equal(rendered, false)
    assert.equal(capturedPrompts.length, before)
    const { result } = response.json
    assert.equal(result.method, 'docx')
    assert.equal(result.structuredByAi, false)
    assert.equal(result.visibilityUncertain, true)
    assert.match(result.text, /candidate@example\.com/)
    assert.match(result.text, /CURRENT_RESUME_TEXT/)
    assert.doesNotMatch(result.text, /OUTDATED_RESUME_TEXT/)
  })

  await t.test('keeps macOS RTF textutil output in local preview when AI structuring is requested', { skip: process.platform !== 'darwin' }, async () => {
    activeOfficeKit = undefined
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}\viewkind4\uc1\pard\f0\fs24 Visible Candidate\par \v HIDDEN_TEST_MARKER\v0\par Visible work experience.\par}`
    const promptsBefore = capturedPrompts.length
    const res = await harness.call('POST', '/api/career-agent/parse-resume-file', {
      filename: 'legacy-hidden.rtf',
      mimeType: 'text/rtf',
      dataBase64: Buffer.from(rtf).toString('base64'),
      useAi: true,
      explicitUseAi: true,
      model: 'mock:mock-model',
    }, { 'x-career-locale': 'en' })
    assert.equal(res.status, 200)
    assert.equal(res.json.result.method, 'textutil')
    assert.equal(capturedPrompts.length, promptsBefore, 'textutil output must stay local')
    assert.equal(res.json.result.structuredByAi, false)
    assert.equal(res.json.result.visibilityUncertain, true)
    assert.match(res.json.result.warning, /local preview/)
    assert.match(res.json.result.text, /Visible work experience/)
  })

  const unrenderedDocuments = [
    ['html', 'text/html'],
    ['odt', 'application/vnd.oasis.opendocument.text'],
  ]
  for (const [method, mimeType] of unrenderedDocuments) {
    await t.test(`keeps unrendered ${method.toUpperCase()} in local preview when AI structuring is requested`, async () => {
      const filename = `resume-hidden.${method}`
      const bytes = await readFile(new URL(`../scripts/ci/fixtures/${filename}`, import.meta.url))
      const promptsBefore = capturedPrompts.length
      const res = await harness.call('POST', '/api/career-agent/parse-resume-file', {
        filename,
        mimeType,
        dataBase64: bytes.toString('base64'),
        useAi: true,
        explicitUseAi: true,
        model: 'mock:mock-model',
      }, { 'x-career-locale': 'en' })
      assert.equal(res.status, 200)
      assert.equal(res.json.result.method, method)
      assert.equal(capturedPrompts.length, promptsBefore, `${method} output must stay local`)
      assert.equal(res.json.result.structuredByAi, false)
      assert.equal(res.json.result.visibilityUncertain, true)
      assert.match(res.json.result.warning, /local preview/)
      assert.match(res.json.result.text, /Visible Candidate/)
    })
  }

  // 4) Strict Cordis ctx where office-kit is disabled: ctx.get('officeKit') returns undefined and direct ctx.officeKit THROWS!
  //    DOCX, PDF, and TXT uploads must ALL return 200 without throwing "cannot get property officeKit without inject".
  const strictDir = await mkdtemp(join(tmpdir(), 'niuma-strict-cordis-no-ok-'))
  t.after(() => rm(strictDir, { recursive: true, force: true }))
  const strictHarness = createFetchHarness()
  let strictDispose
  const strictCtx = {
    profileContext: { dir: strictDir },
    connection: strictHarness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('none') },
    },
    llm: ctx.llm,
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { strictDispose = fn() },
  }
  Object.defineProperty(strictCtx, 'officeKit', {
    get() { throw new Error('cannot get property "officeKit" without inject') },
  })
  await apply(strictCtx)
  t.after(async () => { if (typeof strictDispose === 'function') await strictDispose() })

  const strictDocxRes = await strictHarness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'no-ok.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: docxBuf.toString('base64'),
    useAi: false,
  })
  assert.equal(strictDocxRes.status, 200)
  assert.equal(strictDocxRes.json.result.method, 'docx')
  assert.match(strictDocxRes.json.result.text, /visible\.current@example\.com/)

  const strictTxtRes = await strictHarness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'plain.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('林予安\n系统工程师', 'utf8').toString('base64'),
    useAi: false,
  })
  assert.equal(strictTxtRes.status, 200)
  assert.equal(strictTxtRes.json.result.method, 'text')
  assert.match(strictTxtRes.json.result.text, /系统工程师/)

  const strictPdfBuf = buildCidFontPdf({
    heading: 'Experience',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('林予安：系统架构'),
  })
  const strictPdfRes = await strictHarness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'cv.pdf',
    mimeType: 'application/pdf',
    dataBase64: strictPdfBuf.toString('base64'),
    useAi: false,
  })
  assert.equal(strictPdfRes.status, 200)
  assert.match(strictPdfRes.json.result.text, /林予安/)
})

test('extractResumeFileText prioritizes ctx.officeKit.convert() -> unpdf+CMap and falls back cleanly on missing engine or CJK glyph collapse', async () => {
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const docxBuf = buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>林予安 · 主导千卡集群调度优化</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden.secret@example.com</w:t></w:r></w:p></w:body></w:document>`,
  })

  // 1) Primary path: ctx.officeKit.convert() converts DOCX -> CID Chinese PDF -> unpdf + CMap extracts cleanly!
  const convertedPdf = buildCidFontPdf({
    heading: 'Experience',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('林予安：主导千卡集群调度优化'),
  })
  let observedRequest = null
  const mockOfficeKit = {
    async convert(req) {
      observedRequest = req
      assert.equal(req.extension, 'docx')
      assert.equal(req.priority, 'foreground')
      assert.equal(req.source.bytes, docxBuf.byteLength)
      const readRes = await req.source.read(new AbortController().signal, 50 * 1024 * 1024)
      assert.equal(readRes.version, req.source.version)
      assert.equal(readRes.bytes.byteLength, docxBuf.byteLength)
      return { pdf: new Uint8Array(convertedPdf), missingFonts: [] }
    },
  }
  const viaKit = await extractResumeFileText(
    { filename: 'resume.docx', buffer: docxBuf },
    { platform: 'win32', runner: enoentRunner, officeKit: mockOfficeKit },
  )
  assert.ok(observedRequest)
  assert.equal(viaKit.method, 'office-kit')
  assert.equal(viaKit.format, 'docx')
  assert.equal(viaKit.pages, 1)
  assert.match(viaKit.text, /Experience/)
  assert.match(viaKit.text, /林予安：主导千卡集群调度优化/)

  // 2) Missing engine (OfficeKitError code='unavailable') -> cleanly falls back to verified local Mammoth + docx-extract
  const unavailableKit = {
    async convert() {
      const err = new Error('The document converter is unavailable.')
      err.code = 'unavailable'
      throw err
    },
  }
  const viaFallback = await extractResumeFileText(
    { filename: 'resume.docx', buffer: docxBuf },
    { platform: 'linux', runner: enoentRunner, officeKit: unavailableKit },
  )
  assert.equal(viaFallback.method, 'docx')
  assert.match(viaFallback.text, /林予安 · 主导千卡集群调度优化/)
  assert.doesNotMatch(viaFallback.text, /hidden\.secret@example\.com/)

  // 3) Minimal Linux WASM without CJK fonts collapses CJK chars to repeated glyph(s):
  //    single-font, multi-font, AND short 3-char / 2-char Chinese names in English resumes MUST be caught!
  assert.equal(isCorruptedOfficeKitPdfText('林林林 | 林林 | current@example.com\n林林林林林林林林林林'), true)
  assert.equal(isCorruptedOfficeKitPdfText('测测测测测测测测测测测 alpha\n负负负负负负负负负负 beta\n系系系系系系系系系系 gamma'), true)
  assert.equal(isCorruptedOfficeKitPdfText('张张张 / Kai Zhang\nInfrastructure Engineer\nBuilt reliable backend services.'), true)
  assert.equal(isCorruptedOfficeKitPdfText('张小明 / Kai Zhang\nInfrastructure Engineer\nBuilt reliable backend services.'), false)
  assert.equal(isCorruptedOfficeKitPdfText('林予安 | 上海 | current@example.com\n主导千卡集群调度优化'), false)
  const multiFontCorruptedPdf = buildCidFontPdf({
    heading: 'alpha beta gamma',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('测测测测测测测测测测测 负负负负负负负负负负 系系系系系系系系系系'),
  })
  const cjkCollapseKit = {
    async convert() {
      return { pdf: new Uint8Array(multiFontCorruptedPdf), missingFonts: [] }
    },
  }
  const rescued = await extractResumeFileText(
    { filename: 'resume.docx', buffer: docxBuf },
    { platform: 'linux', runner: enoentRunner, officeKit: cjkCollapseKit },
  )
  assert.equal(rescued.method, 'docx', 'must fall back to local Mammoth when Office Kit collapses multi-font CJK glyphs')
  assert.match(rescued.text, /林予安 · 主导千卡集群调度优化/)
  assert.doesNotMatch(rescued.text, /hidden\.secret@example\.com/)

  // 4) Short 3-char & 2-char Chinese names in English resumes:
  //    - "张小明" -> "张张张" caught by both standalone detector and source cross-check
  //    - "张三" -> "张张" caught by source cross-check (without falsely flagging genuine "林林")
  const buildEnglishNameDocx = name => buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>${name} / Kai Zhang</w:t></w:r></w:p><w:p><w:r><w:t>Infrastructure Engineer</w:t></w:r></w:p></w:body></w:document>`,
  })
  const collapsed3Pdf = buildCidFontPdf({
    heading: 'Kai Zhang Infrastructure Engineer',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('张张张'),
  })
  const rescued3 = await extractResumeFileText(
    { filename: 'en-zh-name.docx', buffer: buildEnglishNameDocx('张小明') },
    { platform: 'linux', runner: enoentRunner, officeKit: { async convert() { return { pdf: new Uint8Array(collapsed3Pdf), missingFonts: [] } } } },
  )
  assert.equal(rescued3.method, 'docx')
  assert.match(rescued3.text, /张小明 \/ Kai Zhang/)

  const collapsed2Pdf = buildCidFontPdf({
    heading: 'Kai Zhang Infrastructure Engineer',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('张张'),
  })
  const rescued2 = await extractResumeFileText(
    { filename: 'en-zh-2char.docx', buffer: buildEnglishNameDocx('张三') },
    { platform: 'linux', runner: enoentRunner, officeKit: { async convert() { return { pdf: new Uint8Array(collapsed2Pdf), missingFonts: [] } } } },
  )
  assert.equal(rescued2.method, 'docx', 'source cross-check must rescue 2-char Chinese name collapse')
  assert.match(rescued2.text, /张三 \/ Kai Zhang/)

  const genuineDoublePdf = buildCidFontPdf({
    heading: 'Linlin Infrastructure Engineer',
    encoding: 'UniGB-UTF16-H',
    ordering: 'GB1',
    hexPayload: toUtf16BeHex('林林'),
  })
  const keptGenuine = await extractResumeFileText(
    { filename: 'en-linlin.docx', buffer: buildEnglishNameDocx('林林') },
    { platform: 'linux', runner: enoentRunner, officeKit: { async convert() { return { pdf: new Uint8Array(genuineDoublePdf), missingFonts: [] } } } },
  )
  assert.equal(keptGenuine.method, 'office-kit', 'genuine repeated 2-char Chinese name must stay on office-kit')
  assert.match(keptGenuine.text, /林林/)
})

test('extractResumeFileText supports .odt and .html natively on Windows/Linux and gives clear error for legacy .doc', async () => {
  const odtBuf = buildZip({
    'content.xml': '<office:text><text:h>Alex Chen</text:h><text:p>Staff Infra Engineer &amp; Architect</text:p></office:text>',
  })
  assert.match(extractOdtText(odtBuf), /Alex Chen\nStaff Infra Engineer & Architect/)
  const odtRes = await extractResumeFileText({ filename: 'resume.odt', buffer: odtBuf }, { platform: 'win32', runner: enoentRunner })
  assert.equal(odtRes.method, 'odt')
  assert.match(odtRes.text, /Staff Infra Engineer/)

  const htmlBuf = Buffer.from('<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>张三</h1><p>高级后端工程师 &amp; 架构师</p></body></html>')
  assert.match(extractHtmlText(htmlBuf), /张三\n高级后端工程师 & 架构师/)
  assert.doesNotMatch(extractHtmlText(htmlBuf), /alert/)
  const htmlRes = await extractResumeFileText({ filename: 'resume.html', buffer: htmlBuf }, { platform: 'win32', runner: enoentRunner })
  assert.equal(htmlRes.method, 'html')

  await assert.rejects(
    () => extractResumeFileText({ filename: 'old.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }, { platform: 'win32', runner: enoentRunner }),
    /另存为 \.docx/,
  )
})

test('extractResumeFileText extracts PDF via macOS PDFKit, pure-JS unpdf on Windows/Linux, and never leaks ENOENT', async () => {
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

  // Windows with no pdftotext + scanned empty PDF -> friendly guidance, NEVER raw spawn ENOENT
  await assert.rejects(
    () => extractResumeFileText(
      { filename: 'scanned.pdf', buffer: pdfBuf },
      { platform: 'win32', runner: enoentRunner, pdfExtractor: async () => ({ pages: 1, text: '' }) },
    ),
    (err) => {
      assert.doesNotMatch(err.message, /ENOENT|pdftotext/i)
      assert.match(err.message, /扫描件|纯图片/)
      return true
    },
  )

  // Windows with no pdftotext + encrypted PDF -> clear password message
  await assert.rejects(
    () => extractResumeFileText(
      { filename: 'locked.pdf', buffer: pdfBuf },
      {
        platform: 'win32',
        runner: enoentRunner,
        pdfExtractor: async () => {
          const e = new Error('No password given')
          e.name = 'PasswordException'
          throw e
        },
      },
    ),
    /已加密/,
  )
})

test('extractResumeFileText extracts Chinese+English CID-keyed PDFs (no /ToUnicode) via bundled local CMaps on Windows', async () => {
  const cases = [
    {
      label: 'UniGB-UTF16-H',
      heading: 'Resume - Experience',
      encoding: 'UniGB-UTF16-H',
      ordering: 'GB1',
      hexPayload: toUtf16BeHex('林予安：主导千卡集群调度优化'),
      expectedZh: '林予安：主导千卡集群调度优化',
    },
    {
      label: 'GBK-EUC-H',
      heading: 'Work History',
      encoding: 'GBK-EUC-H',
      ordering: 'GB1',
      hexPayload: 'B9A4D7F7BEADC0FA', // GBK bytes for "工作经历"
      expectedZh: '工作经历',
    },
    {
      label: 'UniCNS-UTF16-H',
      heading: 'Summary',
      encoding: 'UniCNS-UTF16-H',
      ordering: 'CNS1',
      hexPayload: toUtf16BeHex('資深系統架構師'),
      expectedZh: '資深系統架構師',
    },
  ]

  for (const c of cases) {
    const pdfBuf = buildCidFontPdf(c)
    let subprocessCalled = false
    const out = await extractResumeFileText(
      { filename: `${c.label}.pdf`, mimeType: 'application/pdf', buffer: pdfBuf },
      {
        platform: 'win32',
        runner: async () => { subprocessCalled = true; return enoentRunner('pdftotext') },
      },
    )
    assert.equal(subprocessCalled, false, `bundled unpdf + CMaps must handle ${c.label} without spawning pdftotext`)
    assert.equal(out.method, 'unpdf')
    assert.equal(out.format, 'pdf')
    assert.equal(out.pages, 1)
    assert.ok(pdfBuf.byteLength > 0, 'caller PDF Buffer must remain non-detached after single owned copy in unpdf')
    assert.ok(out.text.includes(c.heading), `${c.label} missing English heading`)
    assert.ok(out.text.includes(c.expectedZh), `${c.label} dropped Chinese body text: got ${JSON.stringify(out.text)}`)
  }
})

test('extractResumeFileText never bypasses .docx filters via macOS textutil, supports legacy .doc/Vision on macOS, and rejects non-macOS image OCR cleanly', async () => {
  // Malformed .docx on macOS MUST NOT fall back to /usr/bin/textutil (which ignores OOXML hidden/header filters)
  let docxTextutilCalled = false
  await assert.rejects(
    () => extractResumeFileText(
      { filename: '王五.docx', buffer: Buffer.from('PK\x03\x04fake-docx') },
      {
        platform: 'darwin',
        runner: async (cmd) => {
          docxTextutilCalled = true
          if (cmd === '/usr/bin/textutil') return { stdout: '王五\n不应绕过过滤' }
          throw new Error('unexpected cmd ' + cmd)
        },
      },
    ),
    /无法解析该 \.docx 文件/,
  )
  assert.equal(docxTextutilCalled, false, 'macOS must not fall back to textutil for .docx')

  // Legacy .doc on macOS still uses /usr/bin/textutil
  const legacyDoc = await extractResumeFileText(
    { filename: '王五.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        if (cmd === '/usr/bin/textutil') return { stdout: '王五\n后端架构师\n主导支付核心重构' }
        throw new Error('unexpected cmd ' + cmd)
      },
    },
  )
  assert.equal(legacyDoc.method, 'textutil')
  assert.match(legacyDoc.text, /支付核心重构/)

  const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const imgMac = await extractResumeFileText(
    { filename: 'resume-screenshot.png', buffer: imgBuf },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        if (cmd === '/usr/bin/osascript') return { stdout: JSON.stringify({ text: '李四\n前端负责人\nReact + TypeScript' }) }
        throw new Error('unexpected cmd ' + cmd)
      },
    },
  )
  assert.equal(imgMac.method, 'vision-ocr')
  assert.match(imgMac.text, /前端负责人/)

  // Windows and Linux do not attempt Windows WinRT / PowerShell OCR in 0.1.2; must return clean guidance with zero subprocesses
  for (const platform of ['win32', 'linux']) {
    let subprocessCalled = false
    await assert.rejects(
      () => extractResumeFileText(
        { filename: `resume-${platform}.png`, buffer: imgBuf },
        {
          platform,
          runner: async (cmd) => { subprocessCalled = true; throw new Error(`must not invoke ${cmd}`) },
        },
      ),
      (err) => {
        assert.doesNotMatch(err.message, /ENOENT|powershell/i)
        assert.match(err.message, /暂不支持本地图片 OCR/)
        return true
      },
    )
    assert.equal(subprocessCalled, false, `must not spawn any subprocess for image upload on ${platform}`)
  }
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

test('live cross-platform PDF extraction round-trips a rendered Chinese/English resume PDF on simulated Windows without pdftotext', async t => {
  if (!findLocalPdfBrowser()) {
    t.skip('requires local Chromium PDF renderer')
    return
  }
  const rendered = await renderLocalResumePdf({
    title: '端到端测试简历',
    text: '# 林予安\n上海 · linyuan@example.com\n## 工作经历\n### 字节跳动 · AI Infra 资深工程师\n- 主导推理网关高可用重构，P99 延迟下降 42%。',
    template: 'onyx',
  })

  // Simulate Windows with ZERO external CLI tools (pdftotext unavailable)
  const winExtracted = await extractResumeFileText(
    { filename: '林予安简历.pdf', mimeType: 'application/pdf', buffer: rendered.pdf },
    { platform: 'win32', runner: enoentRunner },
  )
  assert.equal(winExtracted.format, 'pdf')
  assert.equal(winExtracted.method, 'unpdf')
  assert.equal(winExtracted.pages, 1)
  assert.match(winExtracted.text, /林予安/)
  assert.match(winExtracted.text, /工作经历/)
  assert.match(winExtracted.text, /网关高可用/)
  assert.match(winExtracted.text, /42%/)
  assert.doesNotMatch(winExtracted.text, /[\u2F00-\u2FD5]/, 'Kangxi radicals must be normalized to standard CJK ideographs')

  if (process.platform === 'darwin') {
    const macExtracted = await extractResumeFileText({
      filename: '林予安简历.pdf',
      mimeType: 'application/pdf',
      buffer: rendered.pdf,
    })
    assert.equal(macExtracted.format, 'pdf')
    assert.ok(['pdfkit', 'unpdf', 'pdftotext', 'pdf-ocr', 'pdf-mixed'].includes(macExtracted.method))
    assert.match(macExtracted.text, /林予安/)
    assert.match(macExtracted.text, /42%/)
  }
})

function buildMultiPageTextPdf(pageContents = []) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  ]
  const pageIds = []
  const fontId = 3 + pageContents.length * 2
  let body = ''
  for (let i = 0; i < pageContents.length; i += 1) {
    const pageObjId = 3 + i * 2
    const contentObjId = pageObjId + 1
    pageIds.push(`${pageObjId} 0 R`)
    const pageLines = Array.isArray(pageContents[i]) ? pageContents[i] : [pageContents[i]]
    const nonEmptyLines = pageLines.map(l => String(l || '')).filter(Boolean)
    const stream = nonEmptyLines.length
      ? `BT /F1 10 Tf ${nonEmptyLines.map((l, idx) => `1 0 0 1 40 ${740 - idx * 14} Tm (${l.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`
      : ''
    objects.push(`${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`)
    objects.push(`${contentObjId} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`)
  }
  objects.splice(1, 0, `2 0 obj\n<< /Type /Pages /Count ${pageContents.length} /Kids [${pageIds.join(' ')}] >>\nendobj\n`)
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`)
  body = objects.join('')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += obj
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

test('extractResumeFileText extracts all 21 text PDF pages, mixed/partial PDF coverage, and 9/22-page OCR caps cleanly', async () => {
  const twentyOnePages = Array.from({ length: 21 }, (_, i) => `PAGE_${String(i + 1).padStart(2, '0')}_MARKER Synthetic engineering career history block line ${i + 1}.`)
  const pdf21 = buildMultiPageTextPdf(twentyOnePages)

  // Cross-platform unpdf extracts all 21 pages with complete coverage
  const win21 = await extractResumeFileText(
    { filename: 'resume-21p.pdf', mimeType: 'application/pdf', buffer: pdf21 },
    { platform: 'win32', runner: enoentRunner },
  )
  assert.equal(win21.method, 'unpdf')
  assert.equal(win21.pages, 21)
  assert.equal(win21.extractedPages, 21)
  assert.equal(win21.textPages, 21)
  assert.equal(win21.ocrPages, 0)
  assert.equal(win21.unreadablePages, 0)
  assert.equal(win21.partial, false)
  assert.match(win21.text, /PAGE_21_MARKER/, 'Page 21 text must never be truncated at 20')

  if (process.platform === 'darwin') {
    const mac21 = await extractResumeFileText({ filename: 'resume-21p.pdf', mimeType: 'application/pdf', buffer: pdf21 })
    assert.equal(mac21.method, 'pdfkit')
    assert.equal(mac21.pages, 21)
    assert.equal(mac21.extractedPages, 21)
    assert.equal(mac21.partial, false)
    assert.match(mac21.text, /PAGE_21_MARKER/)
  }

  // Blank page 2 in a 2-page PDF yields partial: true and unreadablePages: 1 on unpdf
  const halfBlankPdf = buildMultiPageTextPdf(['Readable Page 1 Senior Distributed Systems Engineer resume summary.', ''])
  const winPartial = await extractResumeFileText(
    { filename: 'half-blank.pdf', mimeType: 'application/pdf', buffer: halfBlankPdf },
    { platform: 'win32', runner: enoentRunner },
  )
  assert.equal(winPartial.pages, 2)
  assert.equal(winPartial.extractedPages, 1)
  assert.equal(winPartial.unreadablePages, 1)
  assert.equal(winPartial.partial, true)

  // macOS JXA unified path reports pdf-mixed, 9-page pdf-ocr, and 22-page capped partial pdf-ocr
  const mixedOut = await extractResumeFileText(
    { filename: 'mixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake') },
    {
      platform: 'darwin',
      runner: async (cmd) => {
        assert.equal(cmd, '/usr/bin/osascript')
        return {
          stdout: JSON.stringify({
            method: 'pdf-mixed',
            pages: 2,
            extractedPages: 2,
            textPages: 1,
            ocrPages: 1,
            skippedPages: 0,
            unreadablePages: 0,
            text: 'Page 1 cover text\n\nPage 2 OCR text',
          }),
        }
      },
    },
  )
  assert.equal(mixedOut.method, 'pdf-mixed')
  assert.equal(mixedOut.pages, 2)
  assert.equal(mixedOut.extractedPages, 2)
  assert.equal(mixedOut.textPages, 1)
  assert.equal(mixedOut.ocrPages, 1)
  assert.equal(mixedOut.partial, false)

  const partialOcrOut = await extractResumeFileText(
    { filename: 'scan-22p.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake') },
    {
      platform: 'darwin',
      runner: async () => ({
        stdout: JSON.stringify({
          method: 'pdf-ocr',
          pages: 22,
          extractedPages: 20,
          textPages: 0,
          ocrPages: 20,
          skippedPages: 2,
          unreadablePages: 0,
          text: 'Scanned content pages 1..20',
        }),
      }),
    },
  )
  assert.equal(partialOcrOut.method, 'pdf-ocr')
  assert.equal(partialOcrOut.pages, 22)
  assert.equal(partialOcrOut.extractedPages, 20)
  assert.equal(partialOcrOut.skippedPages, 2)
  assert.equal(partialOcrOut.partial, true)
})

test('POST /api/career-agent/parse-resume-file keeps partial PDF results in local review with coverage warning and 0 LLM calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-partial-pdf-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const harness = createFetchHarness()
  let dispose
  let llmCalls = 0
  await apply({
    profileContext: { dir },
    connection: harness.connection,
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      async *stream() {
        llmCalls += 1
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            title: 'AI Structured',
            markdown: '# AI Structured Resume\n\n## Experience\n- PAGE_01_MARKER Candidate Name Senior Engineer distributed scheduling experience.\n- PAGE_02_MARKER Publications and open source contributions across systems.',
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get() {},
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  })
  t.after(async () => { if (typeof dispose === 'function') await dispose() })

  const partialPdf = buildMultiPageTextPdf(['Readable page 1 candidate experience summary with enough text.', ''])
  const zhRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'partial-cv.pdf',
    mimeType: 'application/pdf',
    dataBase64: partialPdf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:fast',
  }, { 'x-career-locale': 'zh' })
  assert.equal(zhRes.status, 200)
  assert.equal(llmCalls, 0, 'Partial PDF extraction must stay in local review without calling AI')
  assert.equal(zhRes.json.result.partial, true)
  assert.equal(zhRes.json.result.structuredByAi, false)
  assert.equal(zhRes.json.result.pages, 2)
  assert.equal(zhRes.json.result.extractedPages, 1)
  assert.match(zhRes.json.result.text, /Readable page 1/)
  assert.match(zhRes.json.result.warning, /1\/2/)

  const enRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'partial-cv.pdf',
    mimeType: 'application/pdf',
    dataBase64: partialPdf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:fast',
  }, { 'x-career-locale': 'en' })
  assert.equal(enRes.status, 200)
  assert.equal(llmCalls, 0)
  assert.equal(enRes.json.result.partial, true)
  assert.match(enRes.json.result.warning, /1\/2 pages/)

  // Complete 2-page text PDF DOES allow explicit AI structuring
  const fullPdf = buildMultiPageTextPdf([
    'PAGE_01_MARKER Candidate Name Senior Engineer distributed scheduling experience.',
    'PAGE_02_MARKER Publications and open source contributions across systems.',
  ])
  const fullRes = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'full-2p.pdf',
    mimeType: 'application/pdf',
    dataBase64: fullPdf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:fast',
  })
  assert.equal(fullRes.status, 200)
  assert.equal(fullRes.json.result.partial, undefined)
  assert.equal(fullRes.json.result.pages, 2)
  assert.equal(fullRes.json.result.extractedPages, 2)
  assert.equal(fullRes.json.result.structuredByAi, true)
  assert.equal(llmCalls, 1)

  // Same-page mixed text + large embedded raster image on non-macOS flags partial & stays local (0 LLM calls)
  const mixedObjects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> >>\nendobj\n',
    '4 0 obj\n<< /Length 70 >>\nstream\nBT /F1 12 Tf 72 720 Td (Text header longer than forty selectable chars.) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /XObject /Subtype /Image /Width 1000 /Height 1400 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n0000\nendstream\nendobj\n',
  ]
  let mixedRaw = '%PDF-1.4\n'
  const mixedOffsets = [0]
  for (const obj of mixedObjects) {
    mixedOffsets.push(Buffer.byteLength(mixedRaw, 'latin1'))
    mixedRaw += obj
  }
  const mixedXref = Buffer.byteLength(mixedRaw, 'latin1')
  mixedRaw += `xref\n0 ${mixedOffsets.length}\n0000000000 65535 f \n`
  for (let i = 1; i < mixedOffsets.length; i += 1) {
    mixedRaw += `${String(mixedOffsets[i]).padStart(10, '0')} 00000 n \n`
  }
  mixedRaw += `trailer\n<< /Size ${mixedOffsets.length} /Root 1 0 R >>\nstartxref\n${mixedXref}\n%%EOF\n`
  const mixedSamePageFake = Buffer.from(mixedRaw, 'latin1')
  const winMixedSame = await extractResumeFileText(
    { filename: 'same-page-mixed.pdf', mimeType: 'application/pdf', buffer: mixedSamePageFake },
    { platform: 'win32', runner: enoentRunner },
  )
  assert.equal(winMixedSame.method, 'unpdf')
  assert.equal(winMixedSame.pages, 1)
  assert.equal(winMixedSame.extractedPages, 1)
  assert.equal(winMixedSame.partial, true)
  assert.equal(winMixedSame.embeddedImagesUnrecognized, true)

  if (process.platform === 'darwin') {
    const jxaMixedSame = await extractResumeFileText(
      { filename: 'same-page-mixed.pdf', mimeType: 'application/pdf', buffer: mixedSamePageFake },
      {
        platform: 'darwin',
        runner: async () => ({
          stdout: JSON.stringify({
            method: 'pdf-mixed',
            pages: 1,
            extractedPages: 1,
            textPages: 1,
            ocrPages: 1,
            skippedPages: 0,
            unreadablePages: 0,
            text: 'Text header longer than forty selectable chars.\n\nSynthetic test page JUPITER',
          }),
        }),
      },
    )
    assert.equal(jxaMixedSame.method, 'pdf-mixed')
    assert.equal(jxaMixedSame.pages, 1)
    assert.equal(jxaMixedSame.extractedPages, 1)
    assert.equal(jxaMixedSame.partial, false)
    assert.match(jxaMixedSame.text, /JUPITER/)
  }

  // Over-budget long text (> 32,000 chars): 0 LLM calls, keeps 100% raw text incl. FINAL_EXPERIENCE_MARKER + warning
  const callsBeforeLong = llmCalls
  const overBudgetPages = Array.from({ length: 21 }, (_, p) =>
    Array.from({ length: 42 }, (__, idx) =>
      `P${String(p + 1).padStart(2, '0')} L${String(idx + 1).padStart(2, '0')} Distributed GPU infra scheduling and benchmark notes.${p === 20 && idx === 41 ? ' FINAL_EXPERIENCE_MARKER' : ''}`),
  )
  const long21Pdf = buildMultiPageTextPdf(overBudgetPages)
  const longZh = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'long21.pdf',
    mimeType: 'application/pdf',
    dataBase64: long21Pdf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:fast',
  }, { 'x-career-locale': 'zh' })
  assert.equal(longZh.status, 200)
  assert.equal(llmCalls, callsBeforeLong, 'Over-budget long PDF must NOT call AI with truncated text')
  assert.equal(longZh.json.result.structuredByAi, false)
  assert.equal(longZh.json.result.aiBudgetExceeded, true)
  assert.ok(longZh.json.result.rawLength > 45_000)
  assert.equal(longZh.json.result.text.length, longZh.json.result.rawLength)
  assert.match(longZh.json.result.text, /FINAL_EXPERIENCE_MARKER/)
  assert.match(longZh.json.result.warning, /超出当前模型单次整理预算|未截断/)

  const longEn = await harness.call('POST', '/api/career-agent/parse-resume-file', {
    filename: 'long21.pdf',
    mimeType: 'application/pdf',
    dataBase64: long21Pdf.toString('base64'),
    useAi: true,
    explicitUseAi: true,
    model: 'mock:fast',
  }, { 'x-career-locale': 'en' })
  assert.equal(longEn.status, 200)
  assert.equal(llmCalls, callsBeforeLong)
  assert.equal(longEn.json.result.structuredByAi, false)
  assert.equal(longEn.json.result.aiBudgetExceeded, true)
  assert.match(longEn.json.result.warning, /single-pass formatting budget/i)
})
