import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_OUTPUT_CHARS = 100_000

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.tex', '.org', '.rst'])
const TEXTUTIL_EXTS = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm', '.webarchive', '.wordml'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.gif'])

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

function run(argv) {
  const path = argv[0];
  const url = $.NSURL.fileURLWithPath($(path));
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc || doc.isNil()) return JSON.stringify({ error: "无法打开该 PDF 文件。" });
  const pageCount = Number(doc.pageCount);
  const pages = [];
  for (let i = 0; i < Math.min(pageCount, 20); i++) {
    const page = doc.pageAtIndex(i);
    if (!page || page.isNil()) continue;
    const txt = page.string;
    if (txt && !txt.isNil()) pages.push(ObjC.unwrap(txt));
  }
  const directText = pages.join("\n\n").trim();
  if (directText.replace(/\s+/g, "").length >= 40) {
    return JSON.stringify({ method: "pdfkit", pages: pageCount, text: directText });
  }
  // Scanned / image-based PDF fallback: render pages & run native macOS Vision OCR
  const ocrPages = [];
  for (let i = 0; i < Math.min(pageCount, 8); i++) {
    const page = doc.pageAtIndex(i);
    if (!page || page.isNil()) continue;
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(1654, 2339), $.kPDFDisplayBoxMediaBox);
    if (!img || img.isNil()) continue;
    const tiff = img.TIFFRepresentation;
    if (!tiff || tiff.isNil()) continue;
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!rep || rep.isNil()) continue;
    const cg = rep.CGImage;
    if (!cg) continue;
    const text = ocrCGImage(cg).trim();
    if (text) ocrPages.push(text);
  }
  const ocrText = ocrPages.join("\n\n").trim();
  return JSON.stringify({ method: ocrText ? "pdf-ocr" : "pdfkit", pages: pageCount, text: ocrText || directText });
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

function sanitizeExtractedText(raw) {
  return String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_OUTPUT_CHARS)
}

function inferExtension(filename = '', mimeType = '') {
  const ext = extname(String(filename || '').trim()).toLowerCase()
  if (ext) return ext
  const mime = String(mimeType || '').toLowerCase()
  if (mime.includes('pdf')) return '.pdf'
  if (mime.includes('wordprocessingml')) return '.docx'
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

export async function extractResumeFileText(
  { filename = '', mimeType = '', buffer },
  { runner = runFile, platform = process.platform } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('上传的文件为空，请重新选择。')
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error('文件超过 15 MB 上限，请压缩后再试。')
  }
  const ext = inferExtension(filename, mimeType)

  if (TEXT_EXTS.has(ext) || (String(mimeType || '').toLowerCase().startsWith('text/') && ext !== '.html' && ext !== '.htm')) {
    const text = sanitizeExtractedText(buffer.toString('utf8'))
    if (!text) throw new Error('文本文件中没有可读内容。')
    return { text, method: 'text', format: ext.replace(/^\./, '') || 'txt' }
  }

  const dir = await mkdtemp(join(tmpdir(), 'niuma-import-'))
  const filePath = join(dir, `upload${ext || '.bin'}`)
  try {
    await writeFile(filePath, buffer)

    if (ext === '.pdf') {
      if (platform === 'darwin') {
        try {
          const out = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_JXA_SCRIPT, '--', filePath], {
            encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
          })
          const parsed = JSON.parse(String(out?.stdout || '{}'))
          if (parsed?.error) throw new Error(parsed.error)
          const text = sanitizeExtractedText(parsed?.text)
          if (text) return { text, method: parsed.method || 'pdfkit', format: 'pdf', pages: parsed.pages }
        } catch (err) {
          // Try pdftotext fallback if installed
          try {
            const out = await runner('pdftotext', ['-layout', filePath, '-'], {
              encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
            })
            const text = sanitizeExtractedText(out?.stdout)
            if (text) return { text, method: 'pdftotext', format: 'pdf' }
          } catch {}
          throw err instanceof Error ? err : new Error('暂时无法读取该 PDF 内容。')
        }
      } else {
        const out = await runner('pdftotext', ['-layout', filePath, '-'], {
          encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
        })
        const text = sanitizeExtractedText(out?.stdout)
        if (text) return { text, method: 'pdftotext', format: 'pdf' }
      }
      throw new Error('未能从该 PDF 中识别出有效文字，请确认未加密或尝试导出为图片/Word。')
    }

    if (TEXTUTIL_EXTS.has(ext)) {
      if (platform !== 'darwin') {
        throw new Error(`当前系统暂不支持直接解析 ${ext}，建议导出为 PDF 或 Markdown。`)
      }
      const out = await runner('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
        encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      })
      const text = sanitizeExtractedText(out?.stdout)
      if (!text) throw new Error('未能从该文档中提取出有效文字。')
      return { text, method: 'textutil', format: ext.replace(/^\./, '') }
    }

    if (IMAGE_EXTS.has(ext) || String(mimeType || '').toLowerCase().startsWith('image/')) {
      if (platform !== 'darwin') {
        throw new Error('本地图片 OCR 识别需要 macOS。')
      }
      const out = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', IMAGE_OCR_JXA_SCRIPT, '--', filePath], {
        encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      })
      const parsed = JSON.parse(String(out?.stdout || '{}'))
      const text = sanitizeExtractedText(parsed?.text)
      if (!text) throw new Error('未在图片中识别出可读文字，请上传更清晰的简历截图。')
      return { text, method: 'vision-ocr', format: ext.replace(/^\./, '') || 'image' }
    }

    // Generic fallback: if it looks like UTF-8 text without NUL bytes, read it directly
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
    const hasNull = sample.includes(0)
    if (!hasNull) {
      const text = sanitizeExtractedText(buffer.toString('utf8'))
      if (text) return { text, method: 'text', format: ext.replace(/^\./, '') || 'file' }
    }
    throw new Error(`暂不支持直接读取 ${ext || '该格式'} 二进制文件，建议上传 PDF、Word (.docx/.doc)、图片截图 (PNG/JPG/HEIC) 或 Markdown/TXT。`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
