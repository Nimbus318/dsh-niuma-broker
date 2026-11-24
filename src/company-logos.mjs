// Safe local logo proxy + disk cache for built-in and Agent-discovered companies.
// Strictly validates domains, limits payload size, verifies image MIME types, and caches on disk.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeDomain } from './company-domains.mjs'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LOGO_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 4500

const ALLOWED_TYPES = new Map([
  ['image/png', 'png'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
  ['image/svg+xml', 'svg'],
])

const EXT_TO_MIME = {
  png: 'image/png',
  ico: 'image/x-icon',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
}

const inFlight = new Map()
const negativeCache = new Map()

function cleanMime(header) {
  const raw = String(header || '').split(';')[0].trim().toLowerCase()
  return ALLOWED_TYPES.has(raw) ? raw : ''
}

function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'image/x-icon'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

async function readCachedLogo(cacheDir, domain) {
  let stale = null
  let staleMtime = -Infinity
  for (const [ext, contentType] of Object.entries(EXT_TO_MIME)) {
    const file = join(cacheDir, `${domain}.${ext}`)
    try {
      const info = await stat(file)
      const fresh = Date.now() - info.mtimeMs <= CACHE_TTL_MS
      if (!fresh && stale && info.mtimeMs <= staleMtime) continue
      const buffer = await readFile(file)
      if (buffer.length > 0 && buffer.length <= MAX_LOGO_BYTES) {
        if (fresh) return { buffer, contentType, fresh: true }
        stale = { buffer, contentType }
        staleMtime = info.mtimeMs
      }
    } catch {}
  }
  return stale ? { ...stale, fresh: false } : null
}

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home', '.arpa', '.localdomain']

function isSafeLogoTarget(rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.port && parsed.port !== '443') return null
  const host = parsed.hostname.toLowerCase()
  if (!host || host === 'localhost' || PRIVATE_HOST_SUFFIXES.some(sfx => host.endsWith(sfx))) return null
  if (!normalizeDomain(host)) return null
  return parsed.href
}

async function tryFetchUrl(url, fetchImpl) {
  const safeStart = isSafeLogoTarget(url)
  if (!safeStart) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let currentUrl = safeStart
    let res = null
    for (let hop = 0; hop < 2; hop += 1) {
      res = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          accept: 'image/png,image/webp,image/x-icon,image/*;q=0.8,*/*;q=0.1',
        },
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location || hop >= 1) return null
        let resolved
        try { resolved = new URL(location, currentUrl).href } catch { return null }
        const safeNext = isSafeLogoTarget(resolved)
        if (!safeNext) return null
        currentUrl = safeNext
        continue
      }
      break
    }
    if (!res || !res.ok) return null
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_LOGO_BYTES) return null
    const arr = new Uint8Array(await res.arrayBuffer())
    if (arr.length < 32 || arr.length > MAX_LOGO_BYTES) return null
    const buf = Buffer.from(arr)
    const mime = sniffImageMime(buf) || cleanMime(res.headers.get('content-type'))
    if (!mime || mime === 'image/svg+xml') return null // raster icons only for safe <img> rendering
    return { buffer: buf, contentType: mime }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCompanyLogo(rawDomain, cacheDir, { fetchImpl = globalThis.fetch } = {}) {
  const domain = normalizeDomain(rawDomain)
  if (!domain || !cacheDir) return null

  const cached = await readCachedLogo(cacheDir, domain)
  if (cached?.fresh) return { buffer: cached.buffer, contentType: cached.contentType }
  const stale = cached ? { buffer: cached.buffer, contentType: cached.contentType } : null

  const cacheKey = `${join(cacheDir, '.')}\0${domain}`
  const negAt = negativeCache.get(cacheKey)
  if (negAt && Date.now() - negAt < 10 * 60 * 1000) return stale

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey)

  const job = (async () => {
    try {
      const candidates = [
        ...(domain === 'bytedance.com' || domain === 'jobs.bytedance.com'
          ? ['https://joinbytedance.com/icon.ico']
          : []),
        `https://${domain}/apple-touch-icon.png`,
        `https://${domain}/favicon.ico`,
        ...(!domain.startsWith('www.') ? [
          `https://www.${domain}/apple-touch-icon.png`,
          `https://www.${domain}/favicon.ico`,
        ] : []),
      ]
      for (const url of candidates) {
        const hit = await tryFetchUrl(url, fetchImpl)
        if (!hit) continue
        negativeCache.delete(cacheKey)
        const ext = ALLOWED_TYPES.get(hit.contentType) || 'png'
        try {
          await mkdir(cacheDir, { recursive: true, mode: 0o700 })
          await writeFile(join(cacheDir, `${domain}.${ext}`), hit.buffer, { mode: 0o600 })
        } catch {}
        return hit
      }
      negativeCache.set(cacheKey, Date.now())
      return stale
    } finally {
      inFlight.delete(cacheKey)
    }
  })()

  inFlight.set(cacheKey, job)
  return job
}
