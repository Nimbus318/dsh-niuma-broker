import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { filterMokaHiringRows, mokaProjectSlug } from './ats-hiring.mjs'
import { MOKA_PROJECTS } from './company-boards.mjs'

const runFile = promisify(execFile)
const readerPath = fileURLToPath(new URL('./moka-webkit.js', import.meta.url))
const websiteHost = 'https://app.mokahr.com'
const MAX_PAGE_BYTES = 2 * 1024 * 1024

export function mokaBoardUrl(slug) {
  if (!Object.hasOwn(MOKA_PROJECTS, mokaProjectSlug(slug))) throw new TypeError('Unknown Moka project')
  const { kind, org, project } = MOKA_PROJECTS[mokaProjectSlug(slug)]
  return websiteHost + '/' + [kind, org, project].join('/')
}

async function renderPublicPage(input) {
  const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', readerPath, JSON.stringify(input)], {
    timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

async function limitedHtml(response) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    await response.body?.cancel()
    throw new Error('Moka project homepage unavailable')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_PAGE_BYTES) throw new Error('Moka page exceeded the byte limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Moka bootstraps its public homepage with a first page of jobs. This narrower
// feed is usable on hosts without WebKit and must never invalidate older jobs.
async function readHomepage(slug, fetchImpl) {
  const base = mokaBoardUrl(slug)
  const settings = { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'text/html' } }
  let response = await fetchImpl(base, settings)
  if (response.status === 302 && new URL(response.headers.get('location') || '/', base).href === base) {
    const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0])
    await response.body?.cancel()
    response = await fetchImpl(base, { ...settings, headers: { ...settings.headers, Cookie: cookies.join('; ') } })
  }
  const html = await limitedHtml(response)
  const tag = html.match(/<input\b[^>]*\bid=["']init-data["'][^>]*>/i)?.[0]
  const encoded = tag?.match(/\bvalue=(["'])([\s\S]*?)\1/i)?.[2]
  if (!encoded) throw new Error('Moka public job list unavailable')
  const entities = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', '#39': "'", '#34': '"' }
  const data = JSON.parse(encoded.replace(/&(quot|apos|amp|lt|gt|#39|#34);/g, (_, key) => entities[key]))
  const project = MOKA_PROJECTS[mokaProjectSlug(slug)]
  if (data.org?.id !== project.org || String(data.siteId) !== project.project || !Array.isArray(data.jobs)) {
    throw new Error('Moka returned a different public project')
  }
  return data.jobs.filter(job => job?.orgId === project.org && job.status === 'open').map(job => ({
    id: job.id,
    title: job.title,
    location: (job.locations || []).map(place => place.cityName || place.city).filter(city => typeof city === 'string').join(' / '),
    jd: '',
  }))
}

export async function readMokaJobs(slug, queries, fetchImpl, render = defaultRenderer(fetchImpl)) {
  const base = mokaBoardUrl(slug)
  if (render) {
    try {
      const page = await render({ base, queries: slug === 'deepseek-campus' ? [''] : queries })
      // A SPA may paint a zero counter before populating its first page. The
      // employer's server-rendered first page can independently confirm that state.
      if (Array.isArray(page.jobs) && page.jobs.length) {
        return { jobs: filterMokaHiringRows(slug, page.jobs), coverage: 'searched-pages' }
      }
    } catch {
      // The native renderer is optional. A failed render still has a public
      // index fallback, with its limited coverage carried into the scan result.
    }
  }
  const home = await readHomepage(slug, fetchImpl)
  if (slug === 'deepseek-campus' && !home.some(row => row.jd)) throw new Error('Official graduate eligibility requires the full posting descriptions')
  return { jobs: filterMokaHiringRows(slug, home), coverage: 'homepage-only' }
}

export async function readMokaDetail(slug, id, fetchImpl, render = defaultRenderer(fetchImpl)) {
  if (!render) return ''
  const data = await render({ base: mokaBoardUrl(slug), detailId: id })
  return data.jd || ''
}

function defaultRenderer(fetchImpl) {
  return process.platform === 'darwin' && fetchImpl === globalThis.fetch ? renderPublicPage : null
}
