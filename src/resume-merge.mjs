import { modelJson } from './watch.mjs'
import { detectTextLanguage, resumeEditingLanguageDirective } from './i18n/prompt.mjs'

const WORK_SECTION_RE = /(?:工作经历|职业经历|工作履历|从业经历|任职经历|work\s*experience|professional\s*experience|employment|experience)/i
const PROJECT_SECTION_RE = /(?:项目经历|核心项目|代表项目|主要项目|工程项目|selected\s*projects?|projects?)/i
const ACHIEVEMENT_SECTION_RE = /(?:核心成果|近期工作成果|近期成果|主要业绩|主要成就|个人亮点|简历更新|highlights?|achievements?|accomplishments?)/i
const FOOTER_SECTION_RE = /(?:核心技能|专业技能|技术栈|技能清单|技能|教育背景|教育经历|学历|获奖情况|荣誉|证书|开源|个人评价|自我评价|语言能力|technical\s*skills?|skills?|education|awards?|certifications?|languages?)/i

const STOP_WORDS = new Set([
  '负责', '参与', '完成', '推进', '协同', '配合', '优化', '提升', '实现', '构建', '设计', '开发', '维护',
  '支持', '推动', '主导', '搭建', '落地', '进行', '通过', '基于', '相关', '系统', '平台', '项目', '工作',
  '团队', '业务', '能力', '方案', '流程', '功能', '服务', '数据', '问题', '体验', '效率', '质量',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'across',
])

function cleanInline(text = '') {
  return String(text || '').replace(/[\r\n\u0000-\u001f]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function stripBulletPrefix(text = '') {
  return cleanInline(text).replace(/^[-*+•▪]\s+/, '').trim()
}

function formatEvidenceBullet(item, docIsEn = false) {
  let body = stripBulletPrefix(item?.text || item?.title || '')
  const impact = cleanInline(item?.impact || '')
  if (impact && !body.includes(impact)) {
    const trimmed = body.replace(/[。；;,.，]+$/u, '')
    body = docIsEn ? `${trimmed} — ${impact}` : `${trimmed}，${impact}`
  }
  if (!body) return ''
  return `- ${body}`
}

function tokenize(text = '') {
  const tokens = new Set()
  const lower = String(text || '').toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._+-]{1,24}/g)) {
    const w = m[0]
    if (!STOP_WORDS.has(w) && !/^\d+$/.test(w)) tokens.add(w)
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0]
    for (let i = 0; i <= run.length - 2; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOP_WORDS.has(gram)) tokens.add(gram)
    }
  }
  return tokens
}

function overlapScore(aTokens, bTokens) {
  let score = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      score += /^[a-z0-9]/i.test(token) ? 2 : 1
    }
  }
  return score
}

/**
 * Parse a Markdown resume into level-2 (`## `) sections and nested level-3 (`### `) sub-entries.
 */
function parseResumeStructure(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const sections = []
  let current = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      if (current) current.end = i
      const heading = h2[1].trim()
      current = {
        heading,
        start: i,
        end: lines.length,
        kind: WORK_SECTION_RE.test(heading) ? 'work'
          : PROJECT_SECTION_RE.test(heading) ? 'project'
            : ACHIEVEMENT_SECTION_RE.test(heading) ? 'achievement'
              : FOOTER_SECTION_RE.test(heading) ? 'footer'
                : 'other',
        entries: [],
      }
      sections.push(current)
      continue
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/)
    if (h3 && current) {
      const prev = current.entries.at(-1)
      if (prev) prev.end = i
      current.entries.push({
        heading: h3[1].trim(),
        start: i,
        end: lines.length,
      })
    }
  }
  if (current) current.end = lines.length
  for (const sec of sections) {
    if (sec.entries.length) {
      sec.entries[sec.entries.length - 1].end = sec.end
    }
  }
  return { lines, sections }
}

/**
 * Find the line index immediately after the last non-empty content/bullet line
 * inside [startLine, endLine), so inserted bullets stay visually grouped with existing bullets.
 */
function findInsertIndex(lines, startLine, endLine) {
  let lastBullet = -1
  let lastContent = startLine
  for (let i = startLine + 1; i < endLine; i += 1) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    lastContent = i
    if (/^[-*+•▪]\s+/.test(trimmed)) lastBullet = i
  }
  return (lastBullet >= 0 ? lastBullet : lastContent) + 1
}

/**
 * Deterministic smart structural placement fallback:
 * Places each new achievement inside the most semantically relevant `###` entry
 * (or the latest/top `###` under `## 工作经历` / `## 项目经历`), and NEVER dumps
 * a dangling `## 简历更新` section below `## 教育背景` or `## 核心技能`.
 */
export function smartPlaceEvidenceIntoResume(baseMarkdown, additions = [], locale = 'zh') {
  const isEn = locale === 'en'
  const normalizedBase = String(baseMarkdown || '').replace(/\r\n?/g, '\n')
  const docIsEn = detectTextLanguage(normalizedBase) === 'en'
  const items = Array.isArray(additions) ? additions : []
  if (!items.length) {
    return { markdown: normalizedBase, summary: '', placements: [], mode: 'structural' }
  }

  let { lines, sections } = parseResumeStructure(normalizedBase)
  const placements = []
  const placedSections = new Set()

  // Process sequentially so multiple additions keep accurate line indices.
  for (const item of items) {
    const bullet = formatEvidenceBullet(item, docIsEn)
    if (!bullet) continue
    const evTokens = tokenize([item.title, item.text, item.role, item.impact, item.projectId].filter(Boolean).join(' '))

    // 1. Score all `###` entries inside work/project sections for keyword overlap.
    let bestTarget = null
    let bestScore = 0
    for (const sec of sections) {
      if (sec.kind !== 'work' && sec.kind !== 'project') continue
      for (const entry of sec.entries) {
        const blockText = lines.slice(entry.start, entry.end).join('\n')
        const score = overlapScore(evTokens, tokenize(blockText))
        if (score > bestScore) {
          bestScore = score
          bestTarget = {
            insertAt: findInsertIndex(lines, entry.start, entry.end),
            section: `${sec.heading} · ${entry.heading}`,
            reason: isEn
              ? `Closely matches "${entry.heading}", placed directly underneath`
              : `内容与「${entry.heading}」高度相关，已就近并入`,
          }
        }
      }
    }

    // 2. If strong overlap found (score >= 3), place directly under that matching `###` entry.
    if (bestTarget && bestScore >= 3) {
      lines.splice(bestTarget.insertAt, 0, bullet)
      placements.push({
        evidenceId: item.id || '',
        section: bestTarget.section,
        bullet: stripBulletPrefix(bullet),
        reason: bestTarget.reason,
      })
      placedSections.add(bestTarget.section)
      ;({ lines, sections } = parseResumeStructure(lines.join('\n')))
      continue
    }

    // 3. Otherwise place into the top (most recent) `###` under `## Experience` / `## 工作经历`.
    const workSec = sections.find(sec => sec.kind === 'work')
    const projectSec = sections.find(sec => sec.kind === 'project')
    const achSec = sections.find(sec => sec.kind === 'achievement')
    const primarySec = workSec || projectSec || achSec

    if (primarySec) {
      const latestEntry = primarySec.entries[0] ?? null
      const insertAt = latestEntry
        ? findInsertIndex(lines, latestEntry.start, latestEntry.end)
        : findInsertIndex(lines, primarySec.start, primarySec.end)
      const sectionLabel = latestEntry ? `${primarySec.heading} · ${latestEntry.heading}` : primarySec.heading
      lines.splice(insertAt, 0, bullet)
      placements.push({
        evidenceId: item.id || '',
        section: sectionLabel,
        bullet: stripBulletPrefix(bullet),
        reason: latestEntry
          ? (isEn ? `Merged into most recent role "${latestEntry.heading}"` : `作为近期产出并入最新一段经历「${latestEntry.heading}」`)
          : (isEn ? `Merged into "${primarySec.heading}" section` : `已归类并入「${primarySec.heading}」板块`),
      })
      placedSections.add(sectionLabel)
      ;({ lines, sections } = parseResumeStructure(lines.join('\n')))
      continue
    }

    // 4. If resume only has footer sections (e.g. Skills / Education), insert Recent Achievements BEFORE them.
    const firstFooter = sections.find(sec => sec.kind === 'footer')
    if (firstFooter) {
      const heading = docIsEn ? 'Recent Achievements' : '近期工作成果'
      const block = [`## ${heading}`, '', bullet, '']
      const insertAt = firstFooter.start
      if (insertAt > 0 && lines[insertAt - 1].trim() !== '') block.unshift('')
      lines.splice(insertAt, 0, ...block)
      placements.push({
        evidenceId: item.id || '',
        section: heading,
        bullet: stripBulletPrefix(bullet),
        reason: isEn
          ? `No Experience/Projects section found; inserted before "${firstFooter.heading}"`
          : `原简历尚无工作/项目经历板块，已置于「${firstFooter.heading}」之前`,
      })
      placedSections.add(heading)
      ;({ lines, sections } = parseResumeStructure(lines.join('\n')))
      continue
    }

    // 5. Bare markdown resume with no `## ` sections at all.
    while (lines.length && lines.at(-1).trim() === '') lines.pop()
    const fallbackHeading = docIsEn ? 'Key Achievements' : '核心工作成果'
    lines.push('', `## ${fallbackHeading}`, '', bullet)
    placements.push({
      evidenceId: item.id || '',
      section: fallbackHeading,
      bullet: stripBulletPrefix(bullet),
      reason: isEn
        ? `No sections found; created "${fallbackHeading}"`
        : '原简历暂无分节，已新建「核心工作成果」板块',
    })
    placedSections.add(fallbackHeading)
    ;({ lines, sections } = parseResumeStructure(lines.join('\n')))
  }

  const markdown = `${lines.join('\n').trimEnd()}\n`
  const targets = [...placedSections].slice(0, 2).join(isEn ? ', ' : '、')
  const summary = isEn
    ? (placements.length === 1
      ? `Merged 1 new achievement into "${targets}"`
      : `Smart-merged ${placements.length} achievements into "${targets}"`)
    : (placements.length === 1
      ? `已将 1 条新成果并入「${targets}」`
      : `已将 ${placements.length} 条新成果智能归类并入「${targets}」`)
  return { markdown, summary, placements, mode: 'structural' }
}

function hasLazyTrailingUpdateHeading(baseMarkdown, mergedMarkdown) {
  if (/^##\s*简历更新\s*$/m.test(baseMarkdown)) return false
  return /^##\s*简历更新\s*$/m.test(mergedMarkdown)
}

function validateMergedMarkdown(baseMarkdown, candidateMarkdown) {
  if (typeof candidateMarkdown !== 'string') return null
  const clean = candidateMarkdown.replace(/\r\n?/g, '\n').trim()
  if (!clean || clean.length > 100_000 || clean.includes('\0')) return null
  const baseTrim = String(baseMarkdown || '').replace(/\r\n?/g, '\n').trim()
  if (clean === baseTrim) return null
  // Prevent accidental severe truncation of existing resume content.
  if (baseTrim.length >= 120 && clean.length < Math.floor(baseTrim.length * 0.72)) return null
  // Preserve H1 title if base resume had one.
  const baseH1 = baseTrim.match(/^#\s+(.+)$/m)
  if (baseH1 && !/^#\s+/m.test(clean)) return null
  // Reject lazy trailing `## 简历更新` dump when the original resume didn't have one.
  if (hasLazyTrailingUpdateHeading(baseTrim, clean)) return null
  // Preserve original resume body language (never allow silent cross-language corruption).
  const baseLang = detectTextLanguage(baseTrim)
  const nextLang = detectTextLanguage(clean)
  if ((baseLang === 'en' || baseLang === 'zh') && nextLang !== 'unknown' && nextLang !== baseLang) return null
  return `${clean}\n`
}

const MERGE_SYSTEM_PROMPT = `你是资深技术简历编辑，负责把求职者新核对的工作成果智能并入既有主干简历的合适位置。

## 核心规则（必须严格遵守）
1. **找准最自然的归属位置**：
   - 仔细通读既有简历的板块结构（如 \`## 工作经历\`、\`## 项目经历\`、\`### 公司 · 职位\`、\`## 核心技能\`、\`## 教育背景\`）。
   - 根据技术栈、项目语境和职责判断每条新成果应归属哪段经历或项目；若是近期日常产出且未提及特定过往公司，默认并入最新一段（第一条 \`###\`）工作经历或对应的核心项目下。
   - **严禁在简历末尾（尤其是教育背景/核心技能之后）新建 \`## 简历更新\` 来机械追加！**
2. **自然融入原文风格**：
   - 将零散或口语化的原始成果润色为高信息密度的简历要点（\`- 强动词 + 行动与范围 + 量化结果\`），与上下文条目的句式、精炼度保持一致。
   - 若简历中已有高度重合的旧条目，可就地补充融合或紧邻放置，避免生硬重复；若新成果包含明确的新技术关键词，可按需顺手补入 \`## 核心技能\`（不删原有技能）。
3. **绝对诚实与完整保留**：
   - 严禁编造原简历和「新核对成果」中未出现的公司名、时间段、职级、学历或任何新数字。
   - 必须完整保留原简历的姓名标题、联系方式、其他工作/项目经历、技能和教育背景，不得删减无关内容。
4. **返回严格 JSON 对象**（不要输出 Markdown 代码围栏之外的废话）：
{"markdown":"完整合并后的 Markdown 简历正文","summary":"一句话中文摘要，说明把新成果并入了哪个板块/经历（12–60字）","placements":[{"evidenceId":"对应成果 id","section":"并入的板块与经历名（如 工作经历 · 某公司）","bullet":"并入后的具体条目文案","reason":"放在此处的简短理由（8–32字）"}]}`

/**
 * Intelligently merges newly approved work evidence into an existing master resume.
 * Uses the configured LLM when available; validates output against truncation and lazy appends;
 * gracefully falls back to `smartPlaceEvidenceIntoResume` whenever offline or LLM fails.
 */
export async function mergeEvidenceIntoResume({ llm, config, baseMarkdown, baseTitle = '', additions = [], locale = 'zh' }) {
  const isEn = locale === 'en'
  const baseText = String(baseMarkdown || '')
  if (!baseText.trim() || !Array.isArray(additions) || !additions.length) {
    return null
  }

  const evidencePayload = additions.map(item => ({
    id: item.id,
    title: cleanInline(item.title || ''),
    text: cleanInline(item.text || ''),
    ...(item.role ? { role: cleanInline(item.role) } : {}),
    ...(item.impact ? { impact: cleanInline(item.impact) } : {}),
    ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
  }))

  if (llm && config?.model && config?.sendToModel !== false) {
    try {
      const prompt = `${MERGE_SYSTEM_PROMPT}\n\n${resumeEditingLanguageDirective({ uiLocale: locale, resumeText: baseText })}`
      const output = await modelJson(
        llm,
        { ...config, sendToModel: true },
        prompt,
        {
          baseTitle: cleanInline(baseTitle),
          baseMarkdown: baseText.slice(0, 24_000),
          newEvidence: evidencePayload,
        },
      )
      const validMarkdown = validateMergedMarkdown(baseText, output?.markdown)
      if (validMarkdown) {
        const rawPlacements = Array.isArray(output?.placements) ? output.placements : []
        const placements = rawPlacements.slice(0, 40).flatMap(row => {
          if (!row || typeof row !== 'object') return []
          const section = cleanInline(row.section || '').slice(0, 120)
          const bullet = stripBulletPrefix(row.bullet || '').slice(0, 600)
          const reason = cleanInline(row.reason || '').slice(0, 160)
          const evidenceId = cleanInline(row.evidenceId || '').slice(0, 128)
          if (!bullet && !section) return []
          return [{ evidenceId, section: section || (isEn ? 'Master Resume' : '主干简历'), bullet, ...(reason && { reason }) }]
        })
        const summary = cleanInline(output?.summary || '').slice(0, 240)
          || (placements[0]?.section
            ? (isEn ? `Smart-merged ${additions.length} achievement(s) into "${placements[0].section}"` : `已智能润色并将 ${additions.length} 条新成果并入「${placements[0].section}」`)
            : (isEn ? `Smart-merged ${additions.length} achievement(s) into master resume` : `已将 ${additions.length} 条新成果智能并入主干简历`))
        return {
          markdown: validMarkdown,
          summary,
          placements,
          mode: 'llm',
        }
      }
    } catch {
      // Fall through cleanly to deterministic smart structural placement.
    }
  }

  return smartPlaceEvidenceIntoResume(baseText, additions, locale)
}

function extractBullets(markdown = '') {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => /^\s*[-*+•▪]\s+/.test(line))
    .map(line => stripBulletPrefix(line))
    .filter(b => b.length >= 6)
}

const REBASE_SYSTEM_PROMPT = `你是资深技术简历编辑，负责把「主干母版简历」最新演进出的新成果/新亮点，智能同步（Rebase）到一份「岗位定向简历」中。

## 核心规则（必须严格遵守）
1. **保留岗位定向定制成果**：原「岗位定向简历」中已针对目标岗位 JD 调整过的排序、措辞和重点必须完整保留，不可倒退回泛化表述。
2. **只同步有价值的新增变化**：把主干母版相较旧版新增的工作成果、量化数据或核心技能，按目标岗位 JD 的视角润色并精准并入「岗位定向简历」最匹配的经历或项目板块中。
3. **严禁草率追加**：绝不在简历末尾新建「## 简历更新」板块堆砌。
4. **绝对诚实**：绝不编造两份简历与新增条目中未提及的公司、时间、职级或数字。
5. 返回严格 JSON 对象：
{"markdown":"同步后的完整 Markdown 岗位定向简历","summary":"一句话中文摘要说明同步了什么新内容到哪里（12–60字）","placements":[{"section":"同步落位的板块与经历名","bullet":"同步后的具体条目文案","reason":"简短理由（8–30字）"}]}`

/**
 * Intelligently rebases a drifted job-tailored resume branch onto the latest approved Master Resume,
 * weaving newly added Master achievements into the branch without losing prior JD tailoring.
 */
export async function rebaseTailoredResume({
  llm,
  config,
  branchMarkdown,
  latestMasterMarkdown,
  prevMasterMarkdown = '',
  jobTitle = '',
  company = '',
  jd = '',
  onProgress,
  locale = 'zh',
}) {
  const isEn = locale === 'en'
  const branchText = String(branchMarkdown || '').replace(/\r\n?/g, '\n').trim()
  const latestMaster = String(latestMasterMarkdown || '').replace(/\r\n?/g, '\n').trim()
  const prevMaster = String(prevMasterMarkdown || '').replace(/\r\n?/g, '\n').trim()
  if (!branchText || !latestMaster) return null

  const prevSet = new Set(extractBullets(prevMaster).map(b => b.toLowerCase()))
  const branchBullets = extractBullets(branchText).map(b => b.toLowerCase())
  const branchLower = branchText.toLowerCase()
  const deltaBullets = extractBullets(latestMaster).filter(bullet => {
    const key = bullet.toLowerCase()
    if (prevSet.has(key)) return false
    const head = key.slice(0, 18)
    if (branchBullets.some(existing => existing === key || (head.length >= 10 && existing.includes(head)))) return false
    if (head.length >= 12 && branchLower.includes(head)) return false
    return true
  })

  if (llm && config?.model) {
    try {
      const prompt = `${REBASE_SYSTEM_PROMPT}\n\n${resumeEditingLanguageDirective({ uiLocale: locale, resumeText: branchText, targetText: jd })}`
      const output = await modelJson(
        llm,
        { ...config, sendToModel: true },
        prompt,
        {
          targetJob: { company: cleanInline(company), title: cleanInline(jobTitle), jd: cleanInline(jd).slice(0, 2400) },
          branchMarkdown: branchText.slice(0, 16_000),
          latestMasterMarkdown: latestMaster.slice(0, 16_000),
          newMasterBullets: deltaBullets.slice(0, 12),
        },
        undefined,
        { timeoutMs: 60_000, ...(typeof onProgress === 'function' ? { onProgress } : {}) },
      )
      const validMarkdown = validateMergedMarkdown(branchText, output?.markdown)
      if (validMarkdown) {
        const placements = (Array.isArray(output?.placements) ? output.placements : []).slice(0, 20).flatMap(row => {
          if (!row || typeof row !== 'object') return []
          const section = cleanInline(row.section || '').slice(0, 120)
          const bullet = stripBulletPrefix(row.bullet || '').slice(0, 600)
          const reason = cleanInline(row.reason || '').slice(0, 160)
          if (!section && !bullet) return []
          return [{ section: section || (isEn ? 'Tailored branch' : '岗位定向版'), bullet, ...(reason && { reason }) }]
        })
        const summary = cleanInline(output?.summary || '').slice(0, 240)
          || (isEn
            ? `Synced master updates into tailored resume for "${cleanInline(company || jobTitle || 'this role')}"`
            : `已同步主干新版成果到「${cleanInline(company || jobTitle || '本岗位')}」定向简历`)
        return { markdown: validMarkdown, summary, placements, mode: 'llm' }
      }
    } catch {
      // Fall through cleanly to structural rebase fallback.
    }
  }

  if (deltaBullets.length > 0) {
    const placed = smartPlaceEvidenceIntoResume(
      branchText,
      deltaBullets.slice(0, 8).map((text, idx) => ({ id: `rebase-${idx}`, title: text.slice(0, 24), text })),
      locale,
    )
    return {
      markdown: placed.markdown,
      summary: isEn
        ? `Synced ${placed.placements.length} new master bullet(s) into this tailored branch`
        : `已将主干新增的 ${placed.placements.length} 条成果同步并入本岗位定向版`,
      placements: placed.placements,
      mode: 'structural',
    }
  }

  return {
    markdown: `${branchText}\n`,
    summary: isEn
      ? 'Aligned baseline with latest master—this tailored branch already covers all core updates'
      : '已与最新主干版本对齐基线，当前定向版已包含全部核心内容',
    placements: [],
    mode: 'structural',
  }
}
