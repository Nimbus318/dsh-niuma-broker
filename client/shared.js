import { DEFAULT_LOCALE, formatLocalizedDate, translate } from '../src/i18n/index.mjs'
import { findCompanyBoard } from '../src/company-boards.mjs'
import { needsChannelDisambiguation } from '../src/job-view-scope.mjs'

export function boardForSourceId(sourceId) {
  const [provider, slug] = String(sourceId || '').split(':')
  return findCompanyBoard(provider, slug)
}

export function boardChannelLabel(board, t) {
  if (board?.hiringScope === 'all') return t('boards.allRoles')
  if (board?.filterHiringScope || board?.hiringMethod === 'official-fields') return t(board.hiringScope === 'campus' ? 'boards.campusRoles' : 'boards.experiencedRoles')
  if (board?.hiringScope === 'experienced') return t('boards.experiencedChannel')
  if (board?.hiringScope === 'campus') return t('boards.campusChannel')
  return ''
}

export function shortBoardChannelLabel(board, t) {
  if (board?.hiringScope === 'campus') return t('boards.trackShortCampus')
  if (board?.hiringScope === 'experienced') return t('boards.trackShortExperienced')
  if (board?.hiringScope === 'all') return t('boards.trackBothShort')
  return ''
}

export function contextualBoardChannelLabel(board, t, { userScope = 'experienced', boards = [] } = {}) {
  if (!needsChannelDisambiguation(board, { userScope, boards })) return ''
  return shortBoardChannelLabel(board, t)
}

export function hiringScopeLabel(scope, t) {
  if (scope === 'campus') return t('jobs.hiringTrackCampus')
  if (scope === 'experienced') return t('jobs.hiringTrackExperienced')
  return ''
}

export const CN_PROVIDERS = new Set([
  'feishu', 'moka', 'tencent', 'meituan', 'jd', 'netease',
  'alibaba', 'baidu', 'xiaohongshu', 'bilibili', 'trip', 'mihoyo',
])

export const PROVIDER_LABELS = Object.freeze({
  feishu: '飞书招聘',
  tencent: '腾讯官网',
  meituan: '美团官网',
  jd: '京东官网',
  netease: '网易官网',
  alibaba: '阿里官网',
  baidu: '百度官网',
  xiaohongshu: '小红书官网',
  bilibili: 'B站官网',
  trip: '携程官网',
  mihoyo: '米哈游官网',
  moka: 'Moka',
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
})

export const SOURCE_LABELS = Object.freeze({
  'dsh-session': 'DSH 对话',
  manual: '手动录入',
  github: 'GitHub',
  im: '工作消息',
  transcript: '录音转写',
  mail: '邮件',
  memory: '私人记录',
  portal: '招聘平台',
})

export const STAGE_LABELS = Object.freeze({
  pending: '待核对',
  approved: '已确认',
  rejected: '已排除',
  dismissed: '已忽略',
  revoked: '已撤回',
  discovered: '新机会',
  opened: '已查看',
  prepared: '材料已准备',
  contacted: '已打招呼',
  resume_sent: '已发简历',
  submitted: '已投递',
  acknowledged: '已获回执',
  invited: '面试邀请',
  interview_confirmed: '已约面试',
  interview_completed: '面试完成',
  offer_received: '收到 Offer',
  offer_accepted: '已接受 Offer',
  started: '已入职',
  offer_declined: '已拒 Offer',
  withdrawn: '已撤回',
})

const KNOWN_PROVIDERS = new Set([...Object.keys(PROVIDER_LABELS), 'manual'])
const KNOWN_SOURCES = new Set(Object.keys(SOURCE_LABELS))
const KNOWN_STAGES = new Set(Object.keys(STAGE_LABELS))
const KNOWN_RECEIPTS = new Set([
  'contact_sent', 'resume_sent', 'application_submitted', 'application_acknowledged',
  'interview_invited', 'interview_confirmed', 'interview_completed', 'offer_received',
  'offer_accepted', 'offer_declined', 'rejected', 'withdrawn', 'started',
  'discovered', 'opened', 'application_prepared',
])
const KNOWN_DIMENSIONS = new Set(['growth', 'scope', 'compensation', 'workload', 'values', 'direction'])

const KNOWN_SITE_HOSTS = [
  { re: /(?:^|\.)zhipin\.com$/iu, label: 'BOSS直聘' },
  { re: /(?:^|\.)nowcoder\.com$/iu, label: '牛客' },
  { re: /(?:^|\.)maimai\.cn$/iu, label: '脉脉' },
  { re: /(?:^|\.)liepin\.com$/iu, label: '猎聘' },
  { re: /(?:^|\.)lagou\.com$/iu, label: '拉勾' },
  { re: /(?:^|\.)linkedin\.com$/iu, label: 'LinkedIn' },
  { re: /(?:^|\.)feishu\.cn$/iu, label: '飞书招聘' },
  { re: /(?:^|\.)mokahr\.com$/iu, label: 'Moka' },
  { re: /(?:^|\.)greenhouse\.io$/iu, label: 'Greenhouse' },
  { re: /(?:^|\.)lever\.co$/iu, label: 'Lever' },
  { re: /(?:^|\.)ashbyhq\.com$/iu, label: 'Ashby' },
]

function inferSiteLabelFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim())
    const host = parsed.hostname.toLowerCase()
    const matched = KNOWN_SITE_HOSTS.find(item => item.re.test(host))
    return matched ? matched.label : ''
  } catch {
    return ''
  }
}

export function providerLabel(provider, t) {
  const key = String(provider || '').trim().toLowerCase()
  if (!key) return ''
  if (KNOWN_PROVIDERS.has(key)) return t ? t(`provider.${key}`) : translate(DEFAULT_LOCALE, `provider.${key}`)
  return String(provider)
}

export function opportunityOriginLabel(item, t) {
  const provider = String(item?.provider || '').trim()
  if (provider && provider !== 'manual') {
    const pLabel = providerLabel(provider, t) || provider
    return /官网|Careers/iu.test(pLabel) ? pLabel : t('jobs.originOfficialBoard', { source: pLabel })
  }
  const site = String(item?.sourceSite || '').trim() || inferSiteLabelFromUrl(item?.url)
  const mode = String(item?.captureMode || '').trim()
  if (mode === 'ats-handover' && site) {
    if (KNOWN_PROVIDERS.has(site.toLowerCase())) {
      const pLabel = providerLabel(site, t)
      return /官网|Careers/iu.test(pLabel) ? pLabel : t('jobs.originOfficialBoard', { source: pLabel })
    }
    return t('jobs.originOfficialBoard', { source: site })
  }
  if (mode === 'dsh-agent' || mode === 'cua') {
    return site ? t('jobs.originBrowserSite', { site }) : t('jobs.originBrowser')
  }
  if (site) {
    if (KNOWN_PROVIDERS.has(site.toLowerCase())) {
      const pLabel = providerLabel(site, t)
      return /官网|Careers/iu.test(pLabel) ? pLabel : t('jobs.originOfficialBoard', { source: pLabel })
    }
    return t('jobs.originSite', { site })
  }
  return t('provider.manual')
}

export function sourceLabel(sourceId, t) {
  const key = String(sourceId || '').trim()
  if (!key) return ''
  if (KNOWN_SOURCES.has(key)) return t ? t(`source.${key}`) : translate(DEFAULT_LOCALE, `source.${key}`)
  return key
}

export function stageLabel(stage, t) {
  const key = String(stage || '').trim()
  if (!key) return t ? t('stage.discovered') : STAGE_LABELS.discovered
  if (KNOWN_STAGES.has(key)) return t ? t(`stage.${key}`) : translate(DEFAULT_LOCALE, `stage.${key}`)
  return key
}

export function receiptLabel(type, t) {
  const key = String(type || '').trim()
  if (!key) return ''
  if (KNOWN_RECEIPTS.has(key)) return t ? t(`receipt.${key}`) : translate(DEFAULT_LOCALE, `receipt.${key}`)
  return key
}

export function dimensionLabel(dim, t) {
  const key = String(dim || '').trim()
  if (!key) return ''
  if (KNOWN_DIMENSIONS.has(key)) return t ? t(`dimension.${key}`) : translate(DEFAULT_LOCALE, `dimension.${key}`)
  return key
}

const CHANGE_LABEL_TO_KEY = {
  导入底稿: 'version.originImport',
  岗位定制: 'version.originTailored',
  同步主干: 'version.originRebase',
  并入成果: 'version.originMerge',
  'AI 改稿': 'version.originChat',
  自动保存: 'version.originAutoSave',
  手动修订: 'version.originManual',
  新主干分支: 'version.originBranch',
  已定稿主干: 'version.originApprovedMaster',
  版本草稿: 'version.originDraft',
}

export function localizeChangeLabel(rawLabel, t) {
  const clean = String(rawLabel || '').trim()
  if (!clean) return ''
  const mapped = CHANGE_LABEL_TO_KEY[clean]
  if (mapped && t) return t(mapped)
  return clean
}

export function isCnBoard(board) {
  if (!board) return false
  if (board.region === 'cn') return true
  if (board.region === 'global') return false
  if (CN_PROVIDERS.has(String(board.provider || '').toLowerCase())) return true
  if (String(board.domain || '').toLowerCase().endsWith('.cn')) return true
  return /[\u4e00-\u9fff]/u.test(String(board.company || ''))
}

export function readableDate(value, timezone, locale = DEFAULT_LOCALE) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return formatLocalizedDate(date, locale, {
    timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

const BOILERPLATE_RECEIPT_EXACT = new Set([
  '已完成投递',
  '雇主已确认收件',
  '雇主确认收件',
  '已打招呼 / 发起内推',
  '在招聘平台已打招呼',
  '已在招聘平台打招呼',
  '已发送简历',
  '已发简历',
  '已接受 Offer',
  '已婉拒 Offer',
  '已拒绝 Offer',
  '已入职',
  '流程未通过',
  '雇主拒绝',
  '本人主动放弃',
  '已撤回申请',
  '本人确认更新',
  '收到 Offer',
  '收到书面 Offer',
  '收到口头 Offer',
  'Applied',
  'Employer acknowledged',
  'Reached out / referred',
  'Resume sent',
  'Offer accepted',
  'Offer declined',
  'Started role',
  'Not moving forward',
  'Withdrawn',
  'Confirmed update',
  'Written offer received',
  'Verbal offer received',
])

const BOILERPLATE_RECEIPT_PATTERNS = [
  /^收到[^，。,;；\n]{0,16}(?:邀请|Offer)$/u,
  /^已约定[^，。,;；\n]{0,16}时间$/u,
  /^已完成[^，。,;；\n]{0,16}面(?:试)?$/u,
  /^[^,.\n]{1,24}\s+(?:invite received|scheduled|completed)$/i,
]

export function extractCustomReceiptEvidence(evidence, { label = '', company = '' } = {}) {
  let text = String(evidence || '').trim()
  if (!text) return ''
  const companyClean = String(company || '').trim()
  const labelClean = String(label || '').trim()
  const suffixCandidates = [companyClean, '目标公司', 'Target company'].filter(Boolean)
  for (const suffix of suffixCandidates) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`\\s*[·:：\\-–—]\\s*${escaped}$`, 'iu'), '').trim()
  }
  if (!text) return ''
  if (BOILERPLATE_RECEIPT_EXACT.has(text)) return ''
  if (labelClean && text.toLowerCase() === labelClean.toLowerCase()) return ''
  if (companyClean && text.toLowerCase() === companyClean.toLowerCase()) return ''
  if (BOILERPLATE_RECEIPT_PATTERNS.some(re => re.test(text))) return ''
  if (labelClean && text.startsWith(labelClean)) {
    const stripped = text.slice(labelClean.length).replace(/^[\s·:：\-–—]+/u, '').trim()
    if (!stripped) return ''
    if (companyClean && stripped.toLowerCase() === companyClean.toLowerCase()) return ''
    if (BOILERPLATE_RECEIPT_EXACT.has(stripped)) return ''
    if (BOILERPLATE_RECEIPT_PATTERNS.some(re => re.test(stripped))) return ''
    return stripped
  }
  return text
}
