import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCuaCollectPrompt, CUA_PLATFORMS, MIN_CUA_DSH_LABEL, MIN_CUA_DSH_VERSION } from './cua-prompt.mjs'

export { buildCuaCollectPrompt, CUA_PLATFORMS, MIN_CUA_DSH_LABEL, MIN_CUA_DSH_VERSION }
export const CUA_SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])

const CUA_PLUGIN_PACKAGES = new Set([
  '@deepseek-ai/dsh-cua-bundle',
  '@deepseek-ai/dsh-cua',
  '@deepseek-ai/dsh-cua-macos',
  '@deepseek-ai/dsh-cua-windows',
])

const KNOWN_SOURCE_HOSTS = [
  { re: /(?:^|\.)zhipin\.com$/iu, label: 'BOSS直聘' },
  { re: /(?:^|\.)nowcoder\.com$/iu, label: '牛客' },
  { re: /(?:^|\.)maimai\.cn$/iu, label: '脉脉' },
  { re: /(?:^|\.)lagou\.com$/iu, label: '拉勾' },
  { re: /(?:^|\.)liepin\.com$/iu, label: '猎聘' },
  { re: /(?:^|\.)linkedin\.com$/iu, label: 'LinkedIn' },
]

export function inferSourceSiteFromUrl(rawUrl, fallback = '') {
  const cleanFallback = typeof fallback === 'string' ? fallback.trim().slice(0, 60) : ''
  if (cleanFallback) return cleanFallback
  try {
    const parsed = URL.parse(String(rawUrl || '').trim())
    if (!parsed?.hostname) return ''
    const matched = KNOWN_SOURCE_HOSTS.find(item => item.re.test(parsed.hostname))
    if (matched) return matched.label
    return parsed.hostname.replace(/^www\./iu, '').slice(0, 60)
  } catch {
    return ''
  }
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(String(version || '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.').map(part => (/^\d+$/u.test(part) ? Number(part) : part)) : [],
  }
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i += 1) {
    if (i >= pa.pre.length) return -1
    if (i >= pb.pre.length) return 1
    const left = pa.pre[i]
    const right = pb.pre[i]
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left - right
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  return 0
}

export async function detectCuaCapability({ ctx = null, optionalService = null, platform = process.platform } = {}) {
  const resolveSvc = key => {
    if (typeof optionalService === 'function') return optionalService(key)
    try {
      return typeof ctx?.get === 'function' ? (ctx.get(key) ?? null) : (ctx?.[key] ?? null)
    } catch {
      return null
    }
  }
  const platformSupported = CUA_SUPPORTED_PLATFORMS.has(platform)
  const computerUse = resolveSvc('computerUse')
  const providerName = typeof computerUse?.providerName === 'string' ? computerUse.providerName.trim() : ''

  let dshVersion = ''
  let cuaBundlePresent = false
  let diagnostic = ''

  const inventory = resolveSvc('pluginInventory')
  if (typeof inventory?.list === 'function') {
    try {
      const snap = await Promise.race([
        Promise.resolve(inventory.list()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 600)),
      ])
      const entries = Array.isArray(snap?.entries) ? snap.entries : []
      for (const entry of entries) {
        const name = String(entry?.moduleName || '')
        const ver = typeof entry?.meta?.version === 'string' ? entry.meta.version.trim() : ''
        if (!dshVersion && (name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh') && parseSemver(ver)) {
          dshVersion = ver
        }
        if (CUA_PLUGIN_PACKAGES.has(name)) {
          cuaBundlePresent = true
          if (!dshVersion && parseSemver(ver)) dshVersion = ver
          if (entry?.diagnostic && !diagnostic) diagnostic = String(entry.diagnostic).slice(0, 240)
        }
      }
      if (!dshVersion) {
        const anyDsh = entries.find(e => String(e?.moduleName || '').startsWith('@deepseek-ai/dsh-') && parseSemver(e?.meta?.version))
        if (anyDsh?.meta?.version) dshVersion = String(anyDsh.meta.version).trim()
      }
    } catch {
      // Ignore slow/unavailable inventory lookup; fall back to runtime metadata or profile package.json.
    }
  }

  if (!dshVersion) {
    const runtimeInfo = resolveSvc('runtimeInfo')
    if (typeof runtimeInfo?.version === 'string' && parseSemver(runtimeInfo.version)) {
      dshVersion = runtimeInfo.version.trim()
    }
  }

  if (!dshVersion && ctx?.profileContext?.dir) {
    try {
      const pkg = JSON.parse(await readFile(join(ctx.profileContext.dir, 'package.json'), 'utf8'))
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
      if (bundles.some(b => CUA_PLUGIN_PACKAGES.has(String(b || '')))) cuaBundlePresent = true
      const depVer = pkg?.dependencies?.['@deepseek-ai/dsh-subagent-codex']
        || pkg?.dependencies?.['@deepseek-ai/dsh-cua-bundle']
        || pkg?.dependencies?.['@deepseek-ai/dsh-base']
      if (typeof depVer === 'string' && parseSemver(depVer)) dshVersion = depVer.trim()
    } catch {}
  }

  const versionCmp = dshVersion ? compareSemver(dshVersion, MIN_CUA_DSH_VERSION) : null
  let status = 'unknown'
  if (!platformSupported) status = 'unsupported_platform'
  else if (providerName) status = 'ready'
  else if (versionCmp !== null && versionCmp < 0) status = 'upgrade_required'
  else if (cuaBundlePresent || computerUse || (versionCmp !== null && versionCmp >= 0)) status = 'disabled'

  return {
    status,
    platform,
    platformSupported,
    providerName,
    dshVersion,
    minDshVersion: MIN_CUA_DSH_VERSION,
    minDshLabel: MIN_CUA_DSH_LABEL,
    cuaBundlePresent,
    ...(diagnostic ? { diagnostic } : {}),
  }
}

export function registerBrokerDshTools({
  ctx,
  optionalService,
  exclusive,
  stageOpportunities,
  registerAtsBoard,
  store,
  ensureManualAuthorized,
  publish,
}) {
  const disposers = []
  const toolsSvc = optionalService?.('tools')
  if (typeof toolsSvc?.register === 'function') {
    const makeStringOutput = () => ({
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    })

    const importTool = {
      name: 'career_broker_import_opportunity',
      description: 'Stage 1..10 curated job opportunities found via active browsing or an open recruitment tab into Niuma Broker Pending Import drawer for user review (may be called in batches; never overwrites without confirmation).',
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            maxItems: 10,
            description: 'Up to 10 curated job postings with full details (call again in another batch if more).',
            items: {
              type: 'object',
              properties: {
                company: { type: 'string', description: 'Company name' },
                title: { type: 'string', description: 'Role title' },
                location: { type: 'string', description: 'City or remote' },
                url: { type: 'string', description: 'Canonical https:// posting URL if visible' },
                jd: { type: 'string', description: 'Full visible job description text' },
                sourceSite: { type: 'string', description: 'Source platform name (always pass when known, e.g. 牛客, BOSS直聘, 脉脉, 猎聘, LinkedIn, 官网)' },
              },
              required: ['company', 'title'],
            },
          },
          company: { type: 'string', description: 'Single job shortcut: company name (when jobs[] is omitted)' },
          title: { type: 'string', description: 'Single job shortcut: role title (when jobs[] is omitted)' },
          location: { type: 'string', description: 'Single job shortcut: location' },
          url: { type: 'string', description: 'Single job shortcut: https:// URL' },
          jd: { type: 'string', description: 'Single job shortcut: JD body' },
          sourceSite: { type: 'string', description: 'Single job shortcut: source platform name (always pass when known, e.g. 牛客, BOSS直聘, 脉脉, 猎聘, LinkedIn, 官网)' },
        },
      },
      output: makeStringOutput(),
      execute: async (rawArgs = {}) => exclusive(async () => {
        const items = Array.isArray(rawArgs?.jobs)
          ? rawArgs.jobs
          : (rawArgs?.company || rawArgs?.title ? [rawArgs] : [])
        const { count } = await stageOpportunities(items, { captureMode: 'dsh-agent' })
        return `已暂存 ${count} 个岗位到牛马经纪人「待确认」抽屉（含完整字段与来源标记），请前往牛马经纪人「岗位机会」页核对后点击入库。`
      }),
    }

    const workWinTool = {
      name: 'career_broker_record_work_win',
      description: 'Record a completed work achievement as a Pending work-win card ONLY when the user explicitly asks to log/remember it (e.g. "记一笔", "记录成果", "record this work win"). NEVER call passively or for brainstorms.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise factual achievement title (8-30 chars)' },
          text: { type: 'string', description: 'Factual description of what was delivered/resolved (first-person or neutral resume style, no third-person narration)' },
          role: { type: 'string', description: 'Your explicit ownership role if stated' },
          impact: { type: 'string', description: 'Verified outcome or quantified metric if any' },
          reasonTag: { type: 'string', enum: ['impact', 'gap', 'milestone', 'ownership'], description: 'Optional reason tag' },
          reasonText: { type: 'string', description: 'Optional 1-sentence reason why this belongs on the resume' },
        },
        required: ['title', 'text'],
      },
      output: makeStringOutput(),
      execute: async (rawArgs = {}) => exclusive(async () => {
        const title = String(rawArgs?.title || '').trim().slice(0, 180)
        const text = String(rawArgs?.text || '').trim().slice(0, 6000)
        if (!title || !text) throw new Error('记录工作成果需要非空的标题和事实描述。')
        await ensureManualAuthorized?.('dsh-agent')
        const eventId = `win-${randomUUID()}`
        const ev = {
          id: eventId,
          sourceId: 'manual',
          projectId: 'dsh-agent',
          kind: 'work-evidence',
          occurredAt: new Date().toISOString(),
          sourceRef: 'DSH 对话主动记录',
          evidence: [{
            title,
            text,
            ...(typeof rawArgs?.role === 'string' && rawArgs.role.trim() ? { role: rawArgs.role.trim().slice(0, 1200) } : {}),
            ...(typeof rawArgs?.impact === 'string' && rawArgs.impact.trim() ? { impact: rawArgs.impact.trim().slice(0, 2000) } : {}),
            ...(typeof rawArgs?.reasonTag === 'string' && ['impact', 'gap', 'milestone', 'ownership'].includes(rawArgs.reasonTag) ? { reasonTag: rawArgs.reasonTag } : {}),
            ...(typeof rawArgs?.reasonText === 'string' && rawArgs.reasonText.trim() ? { reasonText: rawArgs.reasonText.trim().slice(0, 240) } : {}),
          }],
        }
        const saved = await store.ingestEvents([ev], { explicitManual: true })
        if (saved.accepted) publish?.('evidence.proposed', { eventId, count: saved.evidence.length })
        return `已将工作成果「${title}」放入牛马经纪人待审区（默认仅本地可见，经你确认「写入简历」后才会用于简历生成）。`
      }),
    }

    const registerBoardTool = {
      name: 'career_broker_register_ats_board',
      description: 'Hand over a supported hosted ATS recruitment URL (e.g. *.jobs.feishu.cn, job-boards.greenhouse.io, jobs.ashbyhq.com, jobs.lever.co, app.mokahr.com) discovered during browsing so Niuma Broker switches to fast native API sync, filters matching full JDs into Pending Import, and returns nextAction ("stop" or "continue_cua"). Call this immediately before clicking through postings on hosted ATS portals.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Observed https:// recruitment portal URL (e.g. https://infinigence.jobs.feishu.cn/infinigence)' },
          company: { type: 'string', description: 'Optional company name for matching and display' },
          subscribe: { type: 'boolean', description: 'Optional boolean to subscribe this board for patrol updates' },
        },
        required: ['url'],
      },
      output: makeStringOutput(),
      execute: async (rawArgs = {}) => {
        if (typeof registerAtsBoard !== 'function') {
          return 'nextAction: continue_cua — 当前环境未启用原生招聘板移交，请继续使用 CUA 读取页面岗位。'
        }
        const res = await registerAtsBoard({
          url: rawArgs?.url,
          company: rawArgs?.company,
          subscribe: rawArgs?.subscribe === true,
        })
        return `${res?.message || ''}${res?.nextAction ? ` [nextAction=${res.nextAction}]` : ''}`.trim()
      },
    }

    try {
      const off1 = toolsSvc.register(importTool)
      if (typeof off1 === 'function') disposers.push(off1)
      else if (typeof off1?.dispose === 'function') disposers.push(() => off1.dispose())
    } catch {}
    try {
      const off2 = toolsSvc.register(workWinTool)
      if (typeof off2 === 'function') disposers.push(off2)
      else if (typeof off2?.dispose === 'function') disposers.push(() => off2.dispose())
    } catch {}
    try {
      const off3 = toolsSvc.register(registerBoardTool)
      if (typeof off3 === 'function') disposers.push(off3)
      else if (typeof off3?.dispose === 'function') disposers.push(() => off3.dispose())
    } catch {}
  }

  const skillsSvc = optionalService?.('skills')
  if (typeof skillsSvc?.registerProvider === 'function') {
    const candidate = {
      name: 'niuma-collect-jobs',
      description: 'Proactively hunt matching job postings on recruitment platforms or company career sites via DSH Computer Use, handing off supported hosted ATS portals (*.jobs.feishu.cn, Greenhouse, Ashby, Lever, Moka) via career_broker_register_ats_board for instant zero-CUA sync.',
      whenToUse: 'Use when the user asks DSH to find/search matching jobs on recruitment sites OR extract jobs from an open job/listing tab into Niuma Broker.',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'bundled',
      provider: 'niuma-broker',
      rank: 600,
      locator: 'niuma-collect-jobs',
    }
    try {
      const offSkill = skillsSvc.registerProvider(() => ({
        name: 'niuma-broker',
        list: async () => [candidate],
        get: async (requested) => requested?.name === candidate.name
          ? { ...candidate, content: buildCuaCollectPrompt({ locale: 'zh', mode: 'hunt' }) }
          : undefined,
      }))
      if (typeof offSkill === 'function') disposers.push(offSkill)
      else if (typeof offSkill?.dispose === 'function') disposers.push(() => offSkill.dispose())
    } catch {}
  }

  return () => {
    for (const off of disposers.splice(0)) {
      try { off() } catch {}
    }
  }
}

export function createStagingSeed({ company, title, location = '', url = '' }) {
  const href = String(url || '').trim()
  const seed = href || `${String(company || '').toLowerCase()}\0${String(title || '').toLowerCase()}\0${String(location || '').toLowerCase()}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 24)
}
