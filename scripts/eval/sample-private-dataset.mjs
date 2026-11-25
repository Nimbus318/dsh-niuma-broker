import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildPatrolSearchProfile,
  isOpportunityJdIncomplete,
  scoreOpportunityHeuristic,
} from '../../src/job-triage.mjs'
import { CareerStore } from '../../src/career.mjs'

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
 * Build a stratified 0/1/2/3 annotation template from explicitly passed local state files.
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
  if (careerPath) {
    const store = new CareerStore({ file: resolve(String(careerPath)) })
    const summary = await store.summary()
    const general = (summary.resumes || []).find(r => r.id === summary.defaultMasterTrackId)
      || (summary.resumes || []).find(r => r.kind !== 'tailored')
      || summary.resumes?.[0]
    if (general) {
      resumeText = (await store.exportResume(general.id).catch(() => '')).slice(0, 4000)
    }
    evidence = summary.evidence || []
  }

  const feedback = control.jobFeedback || {}
  const profile = buildPatrolSearchProfile({
    resumeText,
    goal: control.config?.goal || '',
    searchTerms: control.config?.searchTerms || [],
    evidence,
    feedback,
  })

  const openJobs = (control.opportunities || []).filter(job => job && !job.closedAt)
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
  for (const row of sampled) {
    labels[row.job.id] = null
    strata[row.job.id] = row.stratum
  }

  return {
    schemaVersion: 1,
    privateGoldTemplate: true,
    note: 'Fill labels with 0 (irrelevant), 1 (stretch), 2 (good), or 3 (top). Never commit private data.',
    personas: [
      {
        id: personaId,
        locale: 'zh',
        goal: control.config?.goal || '',
        searchTerms: control.config?.searchTerms || [],
        boards: control.config?.boards || [],
        resumeText,
        evidence,
        feedback,
        opportunities: sampled.map(row => row.job),
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
  const outPath = resolve(String(args.out))
  const safeBase = resolve('scripts/eval/local-data')
  const rel = relative(safeBase, outPath)
  if (!args['allow-any-out'] && (!rel || rel.startsWith('..'))) {
    throw new Error('Refusing to write outside gitignored scripts/eval/local-data/ unless --allow-any-out is explicitly passed.')
  }

  const template = await samplePrivateDataset({
    watchdogPath: args.watchdog,
    careerPath: args.career || '',
    count: args.count || 40,
    seed: args.seed || 42,
    personaId: args['persona-id'] || 'local_gold',
  })

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  const oppCount = template.personas[0].opportunities.length
  console.log(`Sampled ${oppCount} stratified opportunities into ${outPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(1)
  })
}
