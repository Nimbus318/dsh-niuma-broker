import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

const runFile = promisify(execFile)
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_OUTPUT_CHARS = 100_000
const MAX_ZIP_ENTRIES = 1024
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 25 * 1024 * 1024

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.tex', '.org', '.rst'])
const HTML_EXTS = new Set(['.html', '.htm'])
const LEGACY_TEXTUTIL_EXTS = new Set(['.doc', '.rtf', '.webarchive', '.wordml'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.gif'])

const PDF_MAX_TEXT_PAGES = 100
const PDF_MAX_OCR_PAGES = 20
const PDF_TEXT_PAGE_MIN_CHARS = 20

const PDF_JXA_SCRIPT = String.raw`
ObjC.import("PDFKit");
ObjC.import("Vision");
ObjC.import("AppKit");
ObjC.import("Foundation");

function ocrCGImage(cgImage) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(["zh-Hans", "zh-Hant", "en-US"]);
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cgImage, $.NSDictionary.dictionary);
  const err = Ref();
  handler.performRequestsError($([req]), err);
  const obs = req.results;
  const lines = [];
  if (obs && !obs.isNil()) {
    for (let i = 0; i < obs.count; i++) {
      const top = obs.objectAtIndex(i).topCandidates(1);
      if (top && top.count > 0) lines.push(ObjC.unwrap(top.objectAtIndex(0).string));
    }
  }
  return lines.join("\n");
}

function pageHasRasterImage(page) {
  const data = page.dataRepresentation;
  if (!data || data.isNil()) return false;
  const nsStr = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
  if (!nsStr || nsStr.isNil()) return false;
  const raw = ObjC.unwrap(nsStr);
  return /\/Subtype\s*\/Image\b/.test(raw)
    || /\/ImageMask\s+true\b/.test(raw)
    || /(?:^|[\s\r\n])BI[\s\r\n]+[\s\S]{1,400}?[\s\r\n]ID[\s\r\n]/.test(raw);
}

function normalizeOcrCompare(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[|il1]/g, "l")
    .replace(/[0o]/g, "o")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function boundedEditDistance(a, b, maxDist) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) return maxDist + 1;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charAt(j - 1) ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function isDuplicateOcrLine(normLine, normRaw, rawLineNorms) {
  if (!normRaw) return false;
  if (normRaw.includes(normLine)) return true;
  if (normLine.length >= 10) {
    let hits = 0;
    const total = normLine.length - 2;
    for (let i = 0; i < total; i++) {
      if (normRaw.includes(normLine.slice(i, i + 3))) hits++;
    }
    if (hits / total >= 0.78) return true;
  }
  if (normLine.length >= 6 && normLine.length <= 28) {
    const maxDist = Math.max(1, Math.floor(normLine.length * 0.15));
    for (let i = 0; i < rawLineNorms.length; i++) {
      const rl = rawLineNorms[i];
      if (Math.abs(rl.length - normLine.length) > maxDist) continue;
      if (boundedEditDistance(normLine, rl, maxDist) <= maxDist) return true;
    }
  }
  return false;
}

function mergeNovelOcrLines(rawTxt, ocrText) {
  const normRaw = normalizeOcrCompare(rawTxt);
  const rawLineNorms = String(rawTxt || "")
    .split(/\r?\n/)
    .map(l => normalizeOcrCompare(l))
    .filter(l => l.length >= 4);
  const ocrLines = String(ocrText || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const novelLines = [];
  for (let i = 0; i < ocrLines.length; i++) {
    const line = ocrLines[i];
    const normLine = normalizeOcrCompare(line);
    if (!normLine) continue;
    if (isDuplicateOcrLine(normLine, normRaw, rawLineNorms)) continue;
    novelLines.push(line);
  }
  if (!novelLines.length) return { text: rawTxt, hasNovel: false };
  return {
    text: rawTxt ? (rawTxt + "\n\n" + novelLines.join("\n")) : novelLines.join("\n"),
    hasNovel: true,
  };
}

function ocrPageThumbnail(page) {
  const img = page.thumbnailOfSizeForBox($.NSMakeSize(1654, 2339), $.kPDFDisplayBoxMediaBox);
  const tiff = (img && !img.isNil()) ? img.TIFFRepresentation : null;
  const rep = (tiff && !tiff.isNil()) ? $.NSBitmapImageRep.imageRepWithData(tiff) : null;
  const cg = (rep && !rep.isNil()) ? rep.CGImage : null;
  return cg ? ocrCGImage(cg).trim() : "";
}

function run(argv) {
  const path = argv[0];
  const url = $.NSURL.fileURLWithPath($(path));
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc || doc.isNil()) return JSON.stringify({ error: "无法打开该 PDF 文件。" });
  const pageCount = Number(doc.pageCount);
  const MAX_TEXT_PAGES = ${PDF_MAX_TEXT_PAGES};
  const MAX_OCR_PAGES = ${PDF_MAX_OCR_PAGES};
  const TEXT_PAGE_MIN_CHARS = ${PDF_TEXT_PAGE_MIN_CHARS};
  const limit = Math.min(pageCount, MAX_TEXT_PAGES);
  const chunks = [];
  let textPages = 0;
  let ocrPages = 0;
  let extractedPages = 0;
  let ocrAttempted = 0;
  let skippedPages = Math.max(0, pageCount - MAX_TEXT_PAGES);
  let unreadablePages = 0;

  for (let i = 0; i < limit; i++) {
    const page = doc.pageAtIndex(i);
    if (!page || page.isNil()) {
      unreadablePages++;
      continue;
    }
    const txt = page.string;
    const rawTxt = (txt && !txt.isNil()) ? ObjC.unwrap(txt).trim() : "";
    const compactLen = rawTxt.replace(/\s+/g, "").length;
    const hasImage = pageHasRasterImage(page);

    if (compactLen >= TEXT_PAGE_MIN_CHARS) {
      if (hasImage && ocrAttempted < MAX_OCR_PAGES) {
        ocrAttempted++;
        const ocrText = ocrPageThumbnail(page);
        const merged = ocrText ? mergeNovelOcrLines(rawTxt, ocrText) : { text: rawTxt, hasNovel: false };
        chunks.push(merged.text);
        textPages++;
        if (merged.hasNovel) ocrPages++;
      } else {
        chunks.push(rawTxt);
        textPages++;
      }
      extractedPages++;
      continue;
    }

    if (ocrAttempted < MAX_OCR_PAGES) {
      ocrAttempted++;
      const ocrText = ocrPageThumbnail(page);
      if (ocrText) {
        if (compactLen > 0) {
          const merged = mergeNovelOcrLines(rawTxt, ocrText);
          chunks.push(merged.text);
          textPages++;
          if (merged.hasNovel) ocrPages++;
        } else {
          chunks.push(ocrText);
          ocrPages++;
        }
        extractedPages++;
      } else if (compactLen > 0) {
        chunks.push(rawTxt);
        textPages++;
        extractedPages++;
      } else {
        unreadablePages++;
      }
    } else if (compactLen > 0 && !hasImage) {
      chunks.push(rawTxt);
      textPages++;
      extractedPages++;
    } else {
      if (compactLen > 0) {
        chunks.push(rawTxt);
        textPages++;
      }
      skippedPages++;
    }
  }

  const finalExtractedPages = Math.min(pageCount, extractedPages);
  const method = (textPages > 0 && ocrPages > 0)
    ? "pdf-mixed"
    : (ocrPages > 0 ? "pdf-ocr" : "pdfkit");
  return JSON.stringify({
    method,
    pages: pageCount,
    extractedPages: finalExtractedPages,
    textPages,
    ocrPages,
    skippedPages,
    unreadablePages,
    text: chunks.join("\n\n").trim(),
  });
}
`

const IMAGE_OCR_JXA_SCRIPT = String.raw`
ObjC.import("Vision");
ObjC.import("Foundation");

function run(argv) {
  const url = $.NSURL.fileURLWithPath($(argv[0]));
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(["zh-Hans", "zh-Hant", "en-US"]);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
  const err = Ref();
  handler.performRequestsError($([req]), err);
  const obs = req.results;
  const lines = [];
  if (obs && !obs.isNil()) {
    for (let i = 0; i < obs.count; i++) {
      const top = obs.objectAtIndex(i).topCandidates(1);
      if (top && top.count > 0) lines.push(ObjC.unwrap(top.objectAtIndex(0).string));
    }
  }
  return JSON.stringify({ method: "vision-ocr", text: lines.join("\n").trim() });
}
`

let unpdfModulePromise = null
async function loadUnpdf() {
  if (!unpdfModulePromise) {
    unpdfModulePromise = import('./vendor/unpdf-extract.mjs')
  }
  return unpdfModulePromise
}

let docxModulePromise = null
async function loadDocxExtractor() {
  if (!docxModulePromise) {
    docxModulePromise = import('./docx-extract.mjs')
  }
  return docxModulePromise
}

function sanitizeExtractedTextMeta(raw) {
  const cleaned = String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\u2F00-\u2FD5]/gu, ch => ch.normalize('NFKC'))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  return {
    text: cleaned.slice(0, MAX_OUTPUT_CHARS),
    charTruncated: cleaned.length > MAX_OUTPUT_CHARS,
  }
}

function sanitizeExtractedText(raw) {
  return sanitizeExtractedTextMeta(raw).text
}

function decodeXmlEntities(str) {
  return String(str ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (full, entity) => {
    switch (entity) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return '\''
      case 'nbsp': return ' '
      default: {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
        try { return String.fromCodePoint(code) } catch { return full }
      }
    }
  })
}

export function extractZipEntries(buffer, wantedNameFn) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('无效的压缩文档格式。')
  }
  const minOffset = Math.max(0, buffer.length - 65557)
  let eocdOffset = -1
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('无效的压缩文档结构。')
  }
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const cdSize = buffer.readUInt32LE(eocdOffset + 12)
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error('文档内部条目过多，无法安全解析。')
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new Error('压缩文档目录损坏。')
  }

  const entries = new Map()
  let totalUncompressed = 0
  let pos = cdOffset
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('压缩文档目录条目损坏。')
    }
    const method = buffer.readUInt16LE(pos + 10)
    const compSize = buffer.readUInt32LE(pos + 20)
    const uncompSize = buffer.readUInt32LE(pos + 24)
    const nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30)
    const commentLen = buffer.readUInt16LE(pos + 32)
    const localOffset = buffer.readUInt32LE(pos + 42)
    const entryName = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen

    if (!wantedNameFn(entryName)) continue
    if (uncompSize > MAX_ZIP_ENTRY_BYTES || totalUncompressed + uncompSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('文档解压后体积过大，无法解析。')
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('压缩文档数据头损坏。')
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buffer.length) {
      throw new Error('压缩文档数据截断。')
    }
    const compressed = buffer.subarray(dataStart, dataStart + compSize)
    let raw
    if (method === 0) {
      raw = compressed
    } else if (method === 8) {
      try {
        raw = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES })
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(err?.message || ''))) {
          throw new Error('文档解压后体积过大，无法解析。')
        }
        throw new Error('压缩文档解压失败，文件可能已损坏。')
      }
    } else {
      throw new Error(`不支持的压缩算法 (${method})。`)
    }
    totalUncompressed += raw.byteLength
    if (raw.byteLength > MAX_ZIP_ENTRY_BYTES || totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('文档解压后体积过大，无法解析。')
    }
    entries.set(entryName, raw)
  }
  return entries
}

const MAX_DOCX_ZIP_ENTRIES = 4096
const MAX_DOCX_XML_ENTRY_BYTES = 25 * 1024 * 1024
const MAX_DOCX_XML_TOTAL_BYTES = 50 * 1024 * 1024

// Best-effort pre-check for declared XML zip bombs without rejecting ZIP64 or unusual valid archives.
function assertSafeDocxZipCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return
  const minOffset = Math.max(0, buffer.length - 65557)
  let eocdOffset = -1
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) return
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const cdSize = buffer.readUInt32LE(eocdOffset + 12)
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
  // Defer ZIP64 archives to JSZip/Mammoth instead of rejecting them
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return
  if (totalEntries > MAX_DOCX_ZIP_ENTRIES) {
    throw new Error('文档内部条目过多，无法安全解析。')
  }
  if (cdOffset + cdSize > buffer.length) return

  let totalXmlBytes = 0
  let pos = cdOffset
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) return
    const uncompSize = buffer.readUInt32LE(pos + 24)
    const nameLen = buffer.readUInt16LE(pos + 28)
    const extraLen = buffer.readUInt16LE(pos + 30)
    const commentLen = buffer.readUInt16LE(pos + 32)
    if (pos + 46 + nameLen > buffer.length) return
    const entryName = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen
    if (uncompSize === 0xffffffff) continue
    if (/\.(?:xml|rels)$/i.test(entryName)) {
      if (uncompSize > MAX_DOCX_XML_ENTRY_BYTES || totalXmlBytes + uncompSize > MAX_DOCX_XML_TOTAL_BYTES) {
        throw new Error('文档解压后体积过大，无法解析。')
      }
      totalXmlBytes += uncompSize
    }
  }
}

async function extractDocxResult(buffer, { docxExtractor = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('无效的 .docx 文档。')
  }
  assertSafeDocxZipCentralDirectory(buffer)
  if (docxExtractor) {
    const out = await docxExtractor(buffer)
    if (out && typeof out === 'object' && 'text' in out) {
      return {
        text: sanitizeExtractedText(out.text),
        visibilityUncertain: Boolean(out.visibilityUncertain),
        visibilityReasons: Array.isArray(out.visibilityReasons) ? out.visibilityReasons : [],
      }
    }
    return { text: sanitizeExtractedText(out), visibilityUncertain: false, visibilityReasons: [] }
  }
  const { extractDocxDetails } = await loadDocxExtractor()
  const details = await extractDocxDetails(buffer)
  return {
    text: sanitizeExtractedText(details?.text),
    visibilityUncertain: Boolean(details?.visibilityUncertain),
    visibilityReasons: Array.isArray(details?.visibilityReasons) ? details.visibilityReasons : [],
  }
}

export async function extractDocxText(buffer, { docxExtractor = null } = {}) {
  const { text } = await extractDocxResult(buffer, { docxExtractor })
  return text
}

export function extractOdtText(buffer) {
  const entries = extractZipEntries(buffer, name => name === 'content.xml')
  if (!entries.has('content.xml')) {
    throw new Error('无效的 .odt 文档（缺少正文内容）。')
  }
  const xml = entries.get('content.xml').toString('utf8')
    .replace(/<text:tab\b[^>]*\/>/gi, ' ')
    .replace(/<text:line-break\b[^>]*\/>/gi, '\n')
    .replace(/<\/text:(?:p|h)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return sanitizeExtractedText(decodeXmlEntities(xml))
}

export function extractHtmlText(buffer) {
  const html = buffer.toString('utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return sanitizeExtractedText(decodeXmlEntities(html))
}

function inferExtension(filename = '', mimeType = '') {
  const ext = extname(String(filename || '').trim()).toLowerCase()
  if (ext) return ext
  const mime = String(mimeType || '').toLowerCase()
  if (mime.includes('pdf')) return '.pdf'
  if (mime.includes('wordprocessingml')) return '.docx'
  if (mime.includes('opendocument.text')) return '.odt'
  if (mime.includes('msword')) return '.doc'
  if (mime.includes('rtf')) return '.rtf'
  if (mime.includes('html')) return '.html'
  if (mime.includes('png')) return '.png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('heic')) return '.heic'
  if (mime.startsWith('text/')) return '.txt'
  return ''
}

export function cleanBaseTitle(filename = '') {
  const base = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]{1,12}$/, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
  return base.slice(0, 120) || '导入简历'
}

async function withTempUploadFile(buffer, ext, work) {
  const dir = await mkdtemp(join(tmpdir(), 'niuma-import-'))
  const filePath = join(dir, `upload${ext || '.bin'}`)
  try {
    await writeFile(filePath, buffer)
    return await work(filePath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function tryPdfWithUnpdf(buffer, pdfExtractor) {
  const fn = pdfExtractor ?? (await loadUnpdf()).extractPdfTextWithUnpdf
  // unpdf-extract.mjs creates a single owned Uint8Array copy so caller Buffers are never detached.
  const out = await fn(buffer)
  const rawPageTexts = Array.isArray(out?.pageTexts) ? out.pageTexts.map(p => String(p || '')) : null
  const pages = typeof out?.pages === 'number' ? out.pages : (rawPageTexts ? rawPageTexts.length : undefined)
  const meta = sanitizeExtractedTextMeta(rawPageTexts ? rawPageTexts.join('\n\n') : out?.text)
  let textPages = pages
  let unreadablePages = 0
  if (rawPageTexts) {
    textPages = rawPageTexts.filter(p => sanitizeExtractedText(p).length > 0).length
    unreadablePages = Math.max(0, (pages ?? rawPageTexts.length) - textPages)
  }
  const extractedPages = textPages
  const partial = Boolean(
    meta.charTruncated
    || (pages != null && extractedPages != null && extractedPages < pages)
    || unreadablePages > 0,
  )
  return {
    pages,
    text: meta.text,
    extractedPages,
    textPages,
    ocrPages: 0,
    skippedPages: 0,
    unreadablePages,
    charTruncated: meta.charTruncated,
    partial,
  }
}

async function tryPdfWithPdftotext(buffer, runner) {
  return withTempUploadFile(buffer, '.pdf', async (filePath) => {
    const out = await runner('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    })
    return sanitizeExtractedText(out?.stdout)
  })
}

/**
 * Detects LibreOffice/WASM missing-CJK-font `.notdef` glyph collapse (whether 1 font collapses to one
 * repeated character like "林林林林..." or multiple fonts each collapse to separate repeated runs like
 * "测测测... 负负负... 系系系...") or heavy replacement-character corruption.
 */
export function isCorruptedOfficeKitPdfText(text) {
  const str = String(text || '')
  if (!str) return false
  const compactLen = str.replace(/\s+/g, '').length
  const replacementCount = (str.match(/[\uFFFD\u25A1]/gu) || []).length
  if (replacementCount >= 4 && replacementCount / Math.max(1, compactLen) >= 0.15) {
    return true
  }
  const cjkChars = str.match(/[\u3400-\u9FFF\uF900-\uFAFF]/gu)
  if (cjkChars && cjkChars.length >= 3) {
    const counts = new Map()
    let maxCount = 0
    let adjacentSame = 0
    for (let i = 0; i < cjkChars.length; i += 1) {
      const ch = cjkChars[i]
      const next = (counts.get(ch) || 0) + 1
      counts.set(ch, next)
      if (next > maxCount) maxCount = next
      if (i > 0 && cjkChars[i - 1] === ch) adjacentSame += 1
    }
    // Single collapsed glyph across all CJK chars (e.g. 3-char Chinese name "张小明" -> "张张张" in an English resume)
    if (counts.size === 1) return true
    // Short multi-font CJK collapse (e.g. "张小明" + "上海" -> "张张张" + "上上")
    if (cjkChars.length >= 5 && adjacentSame / (cjkChars.length - 1) >= 0.5 && counts.size <= Math.floor(cjkChars.length / 2)) {
      return true
    }
    if (cjkChars.length >= 8 && adjacentSame / (cjkChars.length - 1) >= 0.35) return true
    if (cjkChars.length >= 8 && maxCount / cjkChars.length >= 0.45 && counts.size <= Math.max(2, Math.floor(cjkChars.length * 0.12))) {
      return true
    }
    const repeatedRuns = str.match(/([\u3400-\u9FFF\uF900-\uFAFF])\1{3,}/gu) || []
    const repeatedRunChars = repeatedRuns.reduce((sum, run) => sum + run.length, 0)
    if (repeatedRunChars >= 8 && (repeatedRunChars / cjkChars.length >= 0.25 || (repeatedRuns.length >= 2 && repeatedRunChars >= 10))) {
      return true
    }
  }
  return false
}

/**
 * Cross-checks repeated CJK runs in an Office Kit PDF against the source .docx visible text so even
 * 2-char Chinese names ("张三" -> "张张") or single-font partial collapses are caught with zero false positives
 * on genuine repeated characters like "林林" or "滴滴".
 */
function hasInventedRepeatedCjkRuns(pdfText, sourceText) {
  const pdfStr = String(pdfText || '')
  const repeatedRuns = pdfStr.match(/([\u3400-\u9FFF\uF900-\uFAFF])\1+/gu)
  if (!repeatedRuns || repeatedRuns.length === 0) return false
  const srcCompact = String(sourceText || '').replace(/\s+/g, '')
  const pdfCjkTotal = (pdfStr.match(/[\u3400-\u9FFF\uF900-\uFAFF]/gu) || []).length
  let inventedChars = 0
  for (const run of repeatedRuns) {
    if (!srcCompact.includes(run)) {
      if (run.length >= 3) return true
      inventedChars += run.length
    }
  }
  return pdfCjkTotal > 0 && inventedChars / pdfCjkTotal >= 0.25
}

function createOfficeKitMemorySource(buffer) {
  const digest = createHash('sha256').update(buffer).digest('hex')
  return {
    key: `dsh-niuma-broker:upload:${digest}`,
    version: digest,
    bytes: buffer.byteLength,
    async read(readSignal, maxBytes) {
      readSignal?.throwIfAborted?.()
      if (buffer.byteLength > maxBytes) {
        const over = new Uint8Array(maxBytes + 1)
        over.set(buffer.subarray(0, maxBytes + 1))
        return { bytes: over, version: digest }
      }
      const copy = new Uint8Array(buffer.byteLength)
      copy.set(buffer)
      return { bytes: copy, version: digest }
    },
  }
}

async function tryOfficeKitToPdfText(buffer, extension, { officeKit, pdfExtractor, signal } = {}) {
  if (!officeKit || typeof officeKit.convert !== 'function') return null
  const converted = await officeKit.convert({
    extension,
    priority: 'foreground',
    source: createOfficeKitMemorySource(buffer),
  }, signal)
  const pdfBytes = converted?.pdf
  if (!pdfBytes || pdfBytes.byteLength === 0) return null
  const viaUnpdf = await tryPdfWithUnpdf(pdfBytes, pdfExtractor)
  if (!viaUnpdf.text || isCorruptedOfficeKitPdfText(viaUnpdf.text)) {
    return null
  }
  return {
    text: viaUnpdf.text,
    pages: viaUnpdf.pages,
    missingFonts: Array.isArray(converted?.missingFonts) ? converted.missingFonts : [],
  }
}

export async function extractResumeFileText(
  { filename = '', mimeType = '', buffer },
  { runner = runFile, platform = process.platform, pdfExtractor = null, docxExtractor = null, officeKit = null, signal = undefined } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('上传的文件为空，请重新选择。')
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error('文件超过 15 MB 上限，请压缩后再试。')
  }
  const ext = inferExtension(filename, mimeType)

  if (TEXT_EXTS.has(ext)) {
    const text = sanitizeExtractedText(buffer.toString('utf8'))
    if (!text) throw new Error('文本文件中没有可读内容。')
    return { text, method: 'text', format: ext.replace(/^\./, '') || 'txt' }
  }

  if (ext === '.pdf') {
    let unpdfError = null
    let parsedEmptyPdf = false

    if (platform === 'darwin') {
      try {
        const result = await withTempUploadFile(buffer, '.pdf', async (filePath) => {
          const out = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_JXA_SCRIPT, '--', filePath], {
            encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
          })
          const parsed = JSON.parse(String(out?.stdout || '{}'))
          if (parsed?.error) throw new Error(parsed.error)
          const meta = sanitizeExtractedTextMeta(parsed?.text)
          if (!meta.text) return null
          const method = parsed.method || 'pdfkit'
          const pages = typeof parsed.pages === 'number' ? parsed.pages : undefined
          const extractedPages = typeof parsed.extractedPages === 'number' ? parsed.extractedPages : pages
          const textPages = typeof parsed.textPages === 'number' ? parsed.textPages : (method === 'pdf-ocr' ? 0 : extractedPages)
          const ocrPages = typeof parsed.ocrPages === 'number' ? parsed.ocrPages : (method === 'pdf-ocr' ? extractedPages : 0)
          const skippedPages = Number(parsed.skippedPages) || 0
          const unreadablePages = Number(parsed.unreadablePages) || 0
          const partial = Boolean(
            meta.charTruncated
            || (pages != null && extractedPages != null && extractedPages < pages)
            || skippedPages > 0
            || unreadablePages > 0,
          )
          return {
            text: meta.text,
            method,
            format: 'pdf',
            ...(pages != null ? { pages } : {}),
            ...(extractedPages != null ? { extractedPages } : {}),
            ...(textPages != null ? { textPages } : {}),
            ocrPages,
            skippedPages,
            unreadablePages,
            charTruncated: meta.charTruncated,
            partial,
          }
        })
        if (result) return result
      } catch {
        // Fall through to cross-platform unpdf / pdftotext fallbacks
      }
    }

    // Cross-platform pure-JS PDF extraction (no pdftotext or native binary required)
    try {
      const viaUnpdf = await tryPdfWithUnpdf(buffer, pdfExtractor)
      if (viaUnpdf.text) {
        return {
          text: viaUnpdf.text,
          method: 'unpdf',
          format: 'pdf',
          ...(viaUnpdf.pages != null ? { pages: viaUnpdf.pages } : {}),
          ...(viaUnpdf.extractedPages != null ? { extractedPages: viaUnpdf.extractedPages } : {}),
          ...(viaUnpdf.textPages != null ? { textPages: viaUnpdf.textPages } : {}),
          ocrPages: 0,
          skippedPages: 0,
          unreadablePages: viaUnpdf.unreadablePages || 0,
          charTruncated: Boolean(viaUnpdf.charTruncated),
          partial: Boolean(viaUnpdf.partial),
        }
      }
      if (viaUnpdf.pages && viaUnpdf.pages > 0) parsedEmptyPdf = true
    } catch (err) {
      unpdfError = err
    }

    // Optional pdftotext CLI fallback when installed
    try {
      const rawCli = await tryPdfWithPdftotext(buffer, runner)
      if (rawCli) {
        const meta = sanitizeExtractedTextMeta(rawCli)
        return {
          text: meta.text,
          method: 'pdftotext',
          format: 'pdf',
          charTruncated: meta.charTruncated,
          partial: meta.charTruncated,
        }
      }
    } catch {
      // Never leak raw `spawn pdftotext ENOENT` to users
    }

    const errMsg = String(unpdfError?.name || '') + ' ' + String(unpdfError?.message || '')
    if (/password|encrypted/i.test(errMsg)) {
      throw new Error('该 PDF 已加密，请先取消密码保护后再导入，或复制简历文字粘贴到下方正文框。')
    }
    if (parsedEmptyPdf) {
      throw new Error('该 PDF 可能是扫描件或纯图片，暂未能直接提取文字；建议使用文字版 PDF / .docx，或复制简历文字粘贴到下方正文框。')
    }
    throw new Error('未能从该 PDF 中识别出有效文字，请确认文件未损坏且未加密，或尝试上传 .docx / 粘贴简历文字。')
  }

  if (ext === '.docx') {
    if (buffer.length >= 22) {
      assertSafeDocxZipCentralDirectory(buffer)
    }
    let cachedDocxResult = null
    const getDocxFallback = async () => {
      if (!cachedDocxResult) {
        cachedDocxResult = await extractDocxResult(buffer, { docxExtractor })
      }
      return cachedDocxResult
    }
    // Office Kit can include tracked deletions in its PDF. Use its layout for documents without tracked edits.
    try {
      if (typeof officeKit?.convert === 'function') {
        const { hasDocxTrackedText } = await loadDocxExtractor()
        const viaKit = await hasDocxTrackedText(buffer)
          ? null
          : await tryOfficeKitToPdfText(buffer, 'docx', { officeKit, pdfExtractor, signal })
        if (viaKit?.text) {
          let collapsedAgainstSource = false
          if (/([\u3400-\u9FFF\uF900-\uFAFF])\1+/u.test(viaKit.text)) {
            try {
              const sourceDocx = await getDocxFallback()
              if (sourceDocx?.text && hasInventedRepeatedCjkRuns(viaKit.text, sourceDocx.text)) {
                collapsedAgainstSource = true
              }
            } catch {
              // If source cross-check fails, retain Office Kit output
            }
          }
          if (!collapsedAgainstSource) {
            return {
              text: viaKit.text,
              method: 'office-kit',
              format: 'docx',
              ...(viaKit.pages ? { pages: viaKit.pages } : {}),
            }
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err
      // The local preview remains available if we cannot inspect or render the document.
    }

    let docxErr = null
    try {
      const res = await getDocxFallback()
      if (res.text) {
        return {
          text: res.text,
          method: 'docx',
          format: 'docx',
          ...(res.visibilityUncertain
            ? { visibilityUncertain: true, visibilityReasons: res.visibilityReasons }
            : {}),
        }
      }
    } catch (err) {
      docxErr = err
      if (/体积过大|条目过多/.test(String(err?.message || ''))) throw err
    }
    // Never fall back to macOS textutil for .docx: textutil bypasses OOXML hidden-text and inactive-header filtering.
    const errMsg = String(docxErr?.message || '')
    if (/无效的|end of central directory|not a valid|main document part|corrupt|invalid|encrypted|password|zip/i.test(errMsg)) {
      throw new Error('无法解析该 .docx 文件，请确认文件未加密且未损坏，或在 Word / WPS 中另存为 .docx / 文字版 PDF 后再试。')
    }
    throw new Error('未能从该 .docx 文档中提取出有效文字，建议检查内容或直接复制粘贴到下方正文框。')
  }

  if (ext === '.odt') {
    try {
      const text = extractOdtText(buffer)
      if (text) return { text, method: 'odt', format: 'odt' }
    } catch (err) {
      if (/体积过大|条目过多/.test(String(err?.message || ''))) throw err
    }
    if (platform === 'darwin') {
      const text = await withTempUploadFile(buffer, '.odt', async (filePath) => {
        const out = await runner('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
          encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
        })
        return sanitizeExtractedText(out?.stdout)
      })
      if (text) return { text, method: 'textutil', format: 'odt' }
    }
    throw new Error('未能从该 .odt 文档中提取出有效文字，建议另存为 .docx、PDF 或 Markdown 后再试。')
  }

  if (HTML_EXTS.has(ext)) {
    const text = extractHtmlText(buffer)
    if (text) return { text, method: 'html', format: ext.replace(/^\./, '') }
    throw new Error('未能从该 HTML 文件中提取出有效文字。')
  }

  if (LEGACY_TEXTUTIL_EXTS.has(ext)) {
    if (ext === '.doc' && officeKit && typeof officeKit.convert === 'function') {
      try {
        const viaKit = await tryOfficeKitToPdfText(buffer, 'doc', { officeKit, pdfExtractor, signal })
        if (viaKit?.text) {
          return {
            text: viaKit.text,
            method: 'office-kit',
            format: 'doc',
            // Legacy binary Word cannot use the DOCX revision check.
            visibilityUncertain: true,
            ...(viaKit.pages ? { pages: viaKit.pages } : {}),
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err
      }
    }
    if (platform !== 'darwin') {
      throw new Error(`当前系统暂不支持直接解析旧版 ${ext} 格式，请在 Word / WPS 中另存为 .docx、文字版 PDF 或 Markdown 后再导入。`)
    }
    const text = await withTempUploadFile(buffer, ext, async (filePath) => {
      const out = await runner('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
        encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      })
      return sanitizeExtractedText(out?.stdout)
    })
    if (!text) throw new Error('未能从该文档中提取出有效文字。')
    return { text, method: 'textutil', format: ext.replace(/^\./, '') }
  }

  if (IMAGE_EXTS.has(ext) || String(mimeType || '').toLowerCase().startsWith('image/')) {
    if (platform === 'darwin') {
      const text = await withTempUploadFile(buffer, ext || '.png', async (filePath) => {
        const out = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', IMAGE_OCR_JXA_SCRIPT, '--', filePath], {
          encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
        })
        const parsed = JSON.parse(String(out?.stdout || '{}'))
        return sanitizeExtractedText(parsed?.text)
      })
      if (!text) throw new Error('未在图片中识别出可读文字，请上传更清晰的简历截图。')
      return { text, method: 'vision-ocr', format: ext.replace(/^\./, '') || 'image' }
    }
    throw new Error('当前系统暂不支持本地图片 OCR，建议直接上传 .docx / 文字版 PDF / Markdown，或复制简历文字粘贴到下方正文框。')
  }

  // Known document formats take precedence over browser MIME hints such as text/rtf.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  const isTextMime = String(mimeType || '').toLowerCase().startsWith('text/')
  if (isTextMime || !sample.includes(0)) {
    const text = sanitizeExtractedText(buffer.toString('utf8'))
    if (text) return { text, method: 'text', format: ext.replace(/^\./, '') || 'file' }
    if (isTextMime) throw new Error('文本文件中没有可读内容。')
  }
  throw new Error(`暂不支持直接读取 ${ext || '该格式'} 二进制文件，建议上传 PDF、Word (.docx)、图片截图 (PNG/JPG) 或 Markdown/TXT。`)
}
