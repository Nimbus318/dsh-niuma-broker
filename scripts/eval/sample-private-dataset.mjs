import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  buildPatrolSearchProfile,
  isOpportunityJdIncomplete,
  scoreOpportunityHeuristic,
} from '../../src/job-triage.mjs'
import { CareerStore } from '../../src/career.mjs'
import { organizeResumeVersions } from '../../src/resume-versions.mjs'

const execFileAsync = promisify(execFile)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(MODULE_DIR, '../..')
export const DEFAULT_LOCAL_DATA_DIR = join(REPO_ROOT, 'scripts', 'eval', 'local-data')

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function takeSample(items, count, seed, takenIds) {
  const eligible = items.filter(item => item?.id && !takenIds.has(item.id))
  const rand = mulberry32(seed)
  for (let i = eligible.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[eligible[i], eligible[j]] = [eligible[j], eligible[i]]
  }
  const picked = eligible.slice(0, count)
  for (const item of picked) takenIds.add(item.id)
  return picked
}

/**
 * Mirror host.mjs resumeFor(resumes, undefined, defaultMasterTrackId) so evaluation
 * picks the approved latest version on the active default master track.
 */
export function selectDefaultApprovedMaster(resumes = [], defaultMasterTrackId = '') {
  const active = (Array.isArray(resumes) ? resumes : []).filter(row => row && !row.archivedAt)
  const tree = organizeResumeVersions(active, { defaultMasterTrackId })
  const preferredMaster = tree.masters.find(m => m.isDefault) ?? tree.masters[0] ?? null
  if (preferredMaster?.latestApproved) {
    const match = active.find(r => r.id === preferredMaster.latestApproved.id)
    if (match) return match
  }
  return active.findLast(row => row.status === 'approved' && !row.opportunityId && row.general !== false) ?? null
}

/**
 * Keep minimal deterministic fields required for offline Stage 1/2 replay without bloated crawl payloads.
 */
export function toMinimalOpportunitySnapshot(job) {
  if (!job || !job.id) return null
  const out = {
    id: job.id,
    sourceId: job.sourceId || '',
    provider: job.provider || '',
    externalId: job.externalId || '',
    company: job.company || '',
    title: job.title || '',
    location: job.location || '',
    url: job.url || '',
    jd: typeof job.jd === 'string' ? job.jd : '',
  }
  if (job.jdPreview === true) out.jdPreview = true
  if (job.closedAt) out.closedAt = job.closedAt
  if (job.oneOff === true) out.oneOff = true
  if (job.verifiedAt) out.verifiedAt = job.verifiedAt
  if (job.firstSeenAt) out.firstSeenAt = job.firstSeenAt
  if (job.salary) out.salary = job.salary
  if (job.employmentType) out.employmentType = job.employmentType
  return out
}

async function resolveWithNearestExistingAncestor(targetPath) {
  const abs = resolve(targetPath)
  const missing = []
  let probe = abs
  while (true) {
    try {
      const real = await realpath(probe)
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return abs
      missing.push(probe.slice(parent.length).replace(/^[/\\]+/, ''))
      probe = parent
    }
  }
}

export async function assertSafeRepoOutputPath(outArg, protectedDir, { allowAnyOut = false, requireGitIgnored = true } = {}) {
  const target = resolve(String(outArg))
  if (allowAnyOut) return target
  const safeBase = await resolveWithNearestExistingAncestor(protectedDir)
  const realTarget = await resolveWithNearestExistingAncestor(target)
  const rel = relative(safeBase, realTarget)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside gitignored ${relative(REPO_ROOT, protectedDir) || protectedDir}/ unless --allow-any-out is explicitly passed.`)
  }
  if (requireGitIgnored) {
    const repoRel = relative(REPO_ROOT, join(protectedDir, rel))
    try {
      await execFileAsync('git', ['check-ignore', '-q', '--no-index', repoRel], { cwd: REPO_ROOT })
    } catch {
      throw new Error(`Refusing to write to path that is not gitignored in repository: ${repoRel}`)
    }
  }
  return join(safeBase, rel)
}

export async function writePrivateJsonFile(targetPath, payload) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(targetPath, 0o600)
}

/**
 * Build a stratified 0/1/2/3 annotation template from explicitly passed local state files,
 * retaining a minimal full-pool snapshot and tracking metadata for fair offline recall.
 */
export async function samplePrivateDataset({
  watchdogPath,
  careerPath = '',
  count = 40,
  seed = 42,
  personaId = 'local_gold',
} = {}) {
  if (!watchdogPath) {
    throw new TypeError('Explicit --watchdog <path> is required.')
  }
  const control = JSON.parse(await readFile(resolve(String(watchdogPath)), 'utf8'))

  let resumeText = ''
  let evidence = []
  let defaultMasterTrackId = ''
  let resumeMeta = null
  if (careerPath) {
    const store = new CareerStore({ file: resolve(String(careerPath)) })
    const summary = await store.summary()
    defaultMasterTrackId = summary.defaultMasterTrackId || ''
    const master = selectDefaultApprovedMaster(summary.resumes || [], defaultMasterTrackId)
    if (master) {
      resumeText = (await store.exportResume(master.id).catch(() => '')).slice(0, 4000)
      resumeMeta = {
        id: master.id,
        trackId: master.trackId || defaultMasterTrackId || master.id,
        version: master.version ?? null,
        status: master.status,
      }
    }
    evidence = summary.evidence || []
  }

  const feedback = control.jobFeedback || {}
  const receipts = (Array.isArray(control.receipts) ? control.receipts : [])
    .map(r => (r?.opportunityId ? { opportunityId: r.opportunityId } : null))
    .filter(Boolean)
  const boards = Array.isArray(control.config?.boards) ? control.config.boards : []

  const profile = buildPatrolSearchProfile({
    resumeText,
    goal: control.config?.goal || '',
    searchTerms: control.config?.searchTerms || [],
    evidence,
    feedback,
  })

  const minimalOpportunities = (Array.isArray(control.opportunities) ? control.opportunities : [])
    .map(toMinimalOpportunitySnapshot)
    .filter(Boolean)

  const receiptOppIds = new Set(receipts.map(r => r.opportunityId))
  const hasExplicitBoards = Array.isArray(control.config?.boards) && control.config.boards.length > 0
  const activeBoardSet = new Set(
    (Array.isArray(control.config?.boards) ? control.config.boards : [])
      .map(b => (typeof b === 'string' ? b : `${b.provider}:${b.slug}`)),
  )
  const openJobs = minimalOpportunities.filter(job => {
    if (job.closedAt) return false
    if (feedback[job.id]?.status === 'dismissed') return false
    const tracked = job.provider === 'manual' || receiptOppIds.has(job.id) || feedback[job.id]?.status === 'pinned'
    if (tracked) return false
    if (hasExplicitBoards) return job.oneOff === true || activeBoardSet.has(job.sourceId)
    return true
  })
  const annotated = openJobs.map(job => ({
    job,
    heur: scoreOpportunityHeuristic(job, profile, 'zh'),
    incomplete: isOpportunityJdIncomplete(job),
    existingLlm: control.jobMatches?.[job.id]?.mode === 'llm' ? control.jobMatches[job.id] : null,
  }))

  const totalTarget = Math.max(8, Math.min(200, Math.floor(Number(count) || 40)))
  const perStratum = Math.max(2, Math.floor(totalTarget / 4))
  const taken = new Set()

  const highPool = annotated.filter(x => !x.incomplete && x.heur.score >= 46).map(x => x.job)
  const midPool = annotated.filter(x => !x.incomplete && x.heur.score >= 30 && x.heur.score < 46).map(x => x.job)
  const lowFullJdPool = annotated.filter(x => !x.incomplete && x.heur.score < 30 && String(x.job.jd || '').length >= 200).map(x => x.job)
  const trapOrEdgePool = annotated.filter(x => x.incomplete
    || x.heur.breakdown?.some(f => f.explicitExclude || f.hardExclude || f.offRoleCap || f.outsideTargetCountry)
    || (x.existingLlm && x.heur.score < 46 && x.existingLlm.score >= 70)).map(x => x.job)

  const sampled = [
    ...takeSample(highPool, perStratum, seed + 1, taken).map(j => ({ stratum: 'high_heuristic', job: j })),
    ...takeSample(midPool, perStratum, seed + 2, taken).map(j => ({ stratum: 'mid_band', job: j })),
    ...takeSample(lowFullJdPool, perStratum, seed + 3, taken).map(j => ({ stratum: 'low_heuristic_full_jd', job: j })),
    ...takeSample(trapOrEdgePool, totalTarget - taken.size, seed + 4, taken).map(j => ({ stratum: 'edge_or_disagreement', job: j })),
  ]

  if (sampled.length < totalTarget) {
    const remainder = takeSample(openJobs, totalTarget - sampled.length, seed + 5, taken)
    sampled.push(...remainder.map(j => ({ stratum: 'tail_fill', job: j })))
  }

  const labels = {}
  const strata = {}
  const sampleIds = []
  const missingJdSampleIds = []
  for (const row of sampled) {
    sampleIds.push(row.job.id)
    strata[row.job.id] = row.stratum
    if (isOpportunityJdIncomplete(row.job)) {
      missingJdSampleIds.push(row.job.id)
    } else {
      labels[row.job.id] = null
    }
  }

  return {
    schemaVersion: 1,
    privateGoldTemplate: true,
    poolRetention: 'minimal_full_pool',
    note: 'Fill labels with 0 (irrelevant), 1 (stretch), 2 (good), or 3 (top). Missing-JD items are listed separately in missingJdSampleIds. Never commit private data.',
    personas: [
      {
        id: personaId,
        locale: 'zh',
        goal: control.config?.goal || '',
        searchTerms: control.config?.searchTerms || [],
        boards,
        defaultMasterTrackId,
        resumeMeta,
        resumeText,
        evidence,
        feedback,
        receipts,
        opportunities: minimalOpportunities,
        sampleIds,
        missingJdSampleIds,
        labels,
        strata,
      },
    ],
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'allow-any-out' || key === 'help') {
      args[key] = true
    } else if (i + 1 < argv.length) {
      args[key] = argv[i + 1]
      i += 1
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.watchdog || !args.out) {
    console.error('Usage: node scripts/eval/sample-private-dataset.mjs --watchdog <path> [--career <path>] --out <scripts/eval/local-data/gold.json> [--count 40] [--seed 42] [--allow-any-out]')
    process.exit(args.help ? 0 : 2)
  }
  const outPath = await assertSafeRepoOutputPath(args.out, DEFAULT_LOCAL_DATA_DIR, {
    allowAnyOut: Boolean(args['allow-any-out']),
    requireGitIgnored: true,
  })

  const template = await samplePrivateDataset({
    watchdogPath: args.watchdog,
    careerPath: args.career || '',
    count: args.count || 40,
    seed: args.seed || 42,
    personaId: args['persona-id'] || 'local_gold',
  })

  await writePrivateJsonFile(outPath, template)
  const p = template.personas[0]
  console.log(`Sampled ${p.sampleIds.length} stratified items (${Object.keys(p.labels).length} label slots, ${p.missingJdSampleIds.length} missing-JD) over ${p.opportunities.length}-job full pool into ${outPath} (mode 0600)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
