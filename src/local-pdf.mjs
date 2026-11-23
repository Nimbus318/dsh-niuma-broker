import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { buildPrintableResumeHtml, defaultLocalResumeTemplate, renderLocalResume } from './local-templates.mjs'

const runFile = promisify(execFile)
const PDF_TIMEOUT_MS = 25_000

const MAC_CANDIDATES = [
  { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { name: 'Brave Browser', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
]

const LINUX_CANDIDATES = [
  { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
  { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
  { name: 'Chromium', path: '/usr/bin/chromium' },
  { name: 'Chromium', path: '/usr/bin/chromium-browser' },
  { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
]

function windowsCandidates(env = process.env) {
  const pf = env.ProgramFiles || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA || ''
  const out = [
    { name: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Brave Browser', path: join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
  ]
  if (local) {
    out.push(
      { name: 'Google Chrome', path: join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Microsoft Edge', path: join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Brave Browser', path: join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    )
  }
  return out
}

function isUsableExecutable(candidatePath, platform = process.platform) {
  if (!candidatePath || typeof candidatePath !== 'string') return false
  try {
    const info = statSync(candidatePath)
    if (!info.isFile()) return false
    accessSync(candidatePath, platform === 'win32' ? constants.R_OK : constants.X_OK)
    if (platform !== 'win32' && info.size < 4096) {
      const head = readFileSync(candidatePath, 'utf8')
      if (head.startsWith('#!')) {
        const execMatch = head.match(/exec\s+["']?(\/[^"'\s]+)["']?/)
        if (execMatch) return isUsableExecutable(execMatch[1], platform)
      }
    }
    return true
  } catch {
    return false
  }
}

let cachedBrowser
let renderQueue = Promise.resolve()

function enqueueRender(work) {
  const next = renderQueue.then(work, work)
  renderQueue = next.catch(() => {})
  return next
}

export function findLocalPdfBrowser({ env = process.env, platform = process.platform, refresh = false } = {}) {
  if (env.NIUMA_PDF_BROWSER) {
    return isUsableExecutable(env.NIUMA_PDF_BROWSER, platform)
      ? { name: 'Configured Chromium', path: env.NIUMA_PDF_BROWSER }
      : null
  }
  if (!refresh && cachedBrowser !== undefined && env === process.env && platform === process.platform) {
    return cachedBrowser
  }
  const candidates = platform === 'darwin'
    ? MAC_CANDIDATES
    : platform === 'win32'
      ? windowsCandidates(env)
      : LINUX_CANDIDATES
  const found = candidates.find(item => isUsableExecutable(item.path, platform)) ?? null
  if (env === process.env && platform === process.platform) cachedBrowser = found
  return found
}

export function countPdfPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page\b/g)
  return matches ? matches.length : 0
}

export function isValidPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return false
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return false
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1')
  if (!tail.includes('%%EOF')) return false
  return countPdfPages(buffer) >= 1
}

/**
 * Renders a self-contained offline Reactive Resume HTML sheet into a crisp,
 * multi-page selectable-text A4 PDF using a local Chromium binary.
 * Serialized to avoid headless Chrome profile/IPC contention and validates
 * the written PDF artifact even when Chrome exits with a benign shutdown code.
 */
export async function renderLocalResumePdf({
  title,
  text,
  template = defaultLocalResumeTemplate,
  style,
  locale = 'zh',
  browserPath,
  runner = runFile,
} = {}) {
  const isEn = String(locale || '').toLowerCase().startsWith('en')
  const resolvedTitle = title || (isEn ? 'Resume' : '简历')
  const browser = browserPath
    ? (isUsableExecutable(browserPath) ? { name: 'Chromium', path: browserPath } : null)
    : findLocalPdfBrowser()
  if (!browser) {
    throw new Error(isEn
      ? 'No local Chrome / Edge / Chromium browser detected. Please use printable HTML export instead.'
      : '本机未检测到可用的 Chrome / Edge / Chromium，暂时只能导出可打印 HTML。')
  }
  const rendered = await renderLocalResume({ title: resolvedTitle, text, template, style, locale })
  const documentHtml = buildPrintableResumeHtml({ ...rendered, title: resolvedTitle })

  return enqueueRender(async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'niuma-pdf-'))
    try {
      const htmlFile = join(scratch, 'resume.html')
      const pdfFile = join(scratch, 'resume.pdf')
      const profileDir = join(scratch, 'profile')
      await writeFile(htmlFile, documentHtml, { encoding: 'utf8', mode: 0o600 })
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        `--user-data-dir=${profileDir}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfFile}`,
        pathToFileURL(htmlFile).href,
      ]
      let processError = null
      try {
        await runner(browser.path, args, { timeout: PDF_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 })
      } catch (error) {
        processError = error
      }
      // Verify the artifact first: Chrome occasionally finishes writing a valid PDF
      // and then exits with a non-zero shutdown code (e.g. code 2).
      let pdf = null
      try {
        pdf = await readFile(pdfFile)
      } catch {}
      if (!isValidPdfBuffer(pdf)) {
        if (processError?.killed || processError?.code === 'ETIMEDOUT') {
          throw new Error(isEn
            ? 'Local PDF export timed out. Please retry or use the printable HTML export.'
            : '本地 PDF 导出超时，请稍后重试或改用 HTML 打印版。')
        }
        throw new Error(isEn
          ? 'Local PDF export did not complete. Please retry or use the printable HTML export.'
          : '本地 PDF 导出未完成，请稍后重试或改用 HTML 打印版。')
      }
      return {
        pdf,
        pages: countPdfPages(pdf),
        browserName: browser.name,
        html: documentHtml,
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  })
}
