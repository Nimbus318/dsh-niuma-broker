// Site paths come from the employers' public recruiting sites. A Feishu tenant can
// serve several completely separate boards on the same hostname.
export const ATS_MOKA_PROJECTS = {
  'zhipu-social': { org: 'zphz', project: '148983', kind: 'social-recruitment' },
  'zhipu-campus': { org: 'zphz', project: '148984', kind: 'campus-recruitment' },
  'moonshot-campus': { org: 'moonshot', project: '148507', kind: 'campus-recruitment' },
  'stepfun-campus': { org: 'step', project: '94905', kind: 'campus-recruitment' },
}

export function mokaProjectSlug(slug) {
  return slug === 'deepseek-experienced' || slug === 'deepseek-campus' ? 'deepseek' : slug
}

const feishuSites = [
  // existing source ID, campus source ID, public ATS hostname, experienced site, campus site
  ['poizon','poizon__578078','poizon.jobs.feishu.cn','index','578078'],
  ['minimax','vrfi1sk8a0__379481','vrfi1sk8a0.jobs.feishu.cn','index','379481'],
  ['sensetime','sensetime__edu','hr-jobs.sensetime.com','exp','edu'],
  ['nio','nio__campus','nio.jobs.feishu.cn','index','campus'],
  ['xiaopeng','xiaopeng__campus','xiaopeng.jobs.feishu.cn','index','campus'],
  ['momenta','momenta__campus','momenta.jobs.feishu.cn','talent','campus'],
  ['bambulab','bambulab__campus','bambulab.jobs.feishu.cn','experienced','campus'],
  ['anker-in','anker-in__campushirecn','anker-in.jobs.feishu.cn','index','campushirecn'],
  ['infinigence__infinigence','infinigence__088717','infinigence.jobs.feishu.cn','infinigence','088717'],
  ['modelbest__career','modelbest__campus','modelbest.jobs.feishu.cn','career','campus'],
]

export const ATS_HIRING_CHANNELS = Object.fromEntries(feishuSites.map(([base, campus, host, expSite, campusSite]) => [
  'feishu:' + base, { experienced: { slug: base, host: host + '/' + expSite }, campus: { slug: campus, host: host + '/' + campusSite } },
]))
Object.assign(ATS_HIRING_CHANNELS, {
  'feishu:aisphere__join': { manualHiring: { campus: 'https://aisphere.jobs.feishu.cn/join' }, experienced: { slug: 'aisphere__join', host: 'aisphere.jobs.feishu.cn/join' } },
  'feishu:01ai': {
    all: { host: '01ai.jobs.feishu.cn/index' },
    experienced: { slug: '01ai__experienced', host: '01ai.jobs.feishu.cn/index/position/list', hiringMethod: 'official-fields' },
    campus: { slug: '01ai__newgrad', host: '01ai.jobs.feishu.cn/index/position/list?keywords=%E6%A0%A1%E5%9B%AD%E6%8B%9B%E8%81%98', hiringMethod: 'official-fields' },
  },
  'feishu:zhipu-ai': {
    experienced: { provider: 'moka', slug: 'zhipu-social', host: 'app.mokahr.com/social-recruitment/zphz/148983' },
    campus: { provider: 'moka', slug: 'zhipu-campus', host: 'app.mokahr.com/campus-recruitment/zphz/148984' },
  },
  'moka:moonshot': {
    experienced: { slug: 'moonshot', host: 'app.mokahr.com/apply/moonshot/148506' },
    campus: { slug: 'moonshot-campus', host: 'app.mokahr.com/campus-recruitment/moonshot/148507' },
  },
  'moka:stepfun': {
    experienced: { slug: 'stepfun', host: 'app.mokahr.com/social-recruitment/step/94904' },
    campus: { slug: 'stepfun-campus', host: 'app.mokahr.com/campus-recruitment/step/94905' },
  },
  'moka:deepseek': {
    all: { host: 'talent.deepseek.com' },
    experienced: { slug: 'deepseek-experienced', host: 'app.mokahr.com/social-recruitment/high-flyer/140576', hiringMethod: 'official-fields' },
    campus: { slug: 'deepseek-campus', host: 'talent.deepseek.com', hiringMethod: 'official-fields' },
  },
})

export const ATS_FEISHU_TARGETS = {}
for (const [exp, campus, host, expPath, campusPath] of feishuSites) {
  for (const [slug, site, scope] of [[exp, expPath, 'experienced'], [campus, campusPath, 'campus']]) {
    ATS_FEISHU_TARGETS[slug] = { origin: 'https://' + host, websitePath: site, detailPrefix: site + '/position', scope,
      // Momenta does not publish recruit_type. Its dedicated campus portal publishes process_type instead.
      ...(scope === 'campus' && exp !== 'momenta' ? { recruitmentGroups: [['201'], ['202']] } : {}),
    }
  }
}
ATS_FEISHU_TARGETS.aisphere__join = { origin: 'https://aisphere.jobs.feishu.cn', websitePath: 'join', detailPrefix: 'join/position', scope: 'experienced' }
for (const [slug, scope] of [['01ai', 'all'], ['01ai__newgrad', 'campus'], ['01ai__experienced', 'experienced']]) {
  ATS_FEISHU_TARGETS[slug] = { origin: 'https://01ai.jobs.feishu.cn', websitePath: 'index', detailPrefix: 'index/position', scope, mixed: true }
}

const newGradTitle = /校园招聘|校招|(?:20)?\d{2}\s*届(?:毕业生)?|应届(?:生|毕业生)/u
const internship = /实习|intern(?:ship)?\b/iu
// An internship on a graduate portal may be a general rolling internship. Use
// the employer's cohort, conversion program or explicit student eligibility.
function isStudentPlacement(title, subject, requirement) {
  if (/日常实习|社招实习|rolling internship/iu.test(subject + ' ' + title)) return false
  return newGradTitle.test(title + ' ' + subject)
    || /暑期|暑假|寒假|寒期|转正实习|实习生转正|研究型实习生项目|campus intern|summer intern/iu.test(title + ' ' + subject)
    || /在校(?:本科生|研究生|大学生|学生|生)|(?:本科|硕士|博士|研究生|本科生)(?:及以上|及以上学历)?在读|在读(?:本科|硕士|博士|研究生)|currently (?:enrolled|pursuing)|在校期间/iu.test(requirement)
}

export function acceptFeishuHiringRow(target, row) {
  if (target.scope !== 'campus' && target.scope !== 'experienced') return true
  const title = String(row?.title || '')
  const type = row?.recruit_type
  const campus = newGradTitle.test(title) && !/往届校招|校园招聘运营|校园招聘经理|校招招聘/u.test(title)
  const process = Number(row?.process_type || type?.parent?.id || 0)
  if (target.mixed) return target.scope === 'campus' ? campus : process === 1 && !campus && !internship.test(title) && !internship.test(type?.name || '')
  if (target.scope === 'experienced') return process !== 2 && !campus && !internship.test(type?.name || '') && !internship.test(title)
  const subject = row?.job_subject?.name?.zh_cn || ''
  if (process === 1 || /日常实习|社招实习/u.test(subject + ' ' + title)) return false
  if (String(type?.id ?? '') === '201') return true
  if (String(type?.id ?? '') === '202' || internship.test(title + ' ' + subject)) {
    return isStudentPlacement(title, subject, row?.requirement || '')
  }
  return !target.recruitmentGroups && process === 2
}

export function filterMokaHiringRows(slug, rows) {
  if (slug === 'deepseek-campus') return rows.filter(row => {
    if (newGradTitle.test(row.title) && !/招聘经理|招聘运营/u.test(row.title)) return true
    return /(?<!不)(?:欢迎|面向|接受|支持|招收|招募)(?:优秀的?)?(?:[\d、至～~-]{1,12}届)?应届(?:生|毕业生)/u.test(row.jd)
  })
  if (['deepseek-experienced', 'zhipu-social', 'moonshot', 'stepfun'].includes(slug)) {
    return rows.filter(row => !internship.test(row.title) && !newGradTitle.test(row.title))
  }
  if (['zhipu-campus', 'moonshot-campus', 'stepfun-campus'].includes(slug)) {
    return rows.filter(row => !internship.test(row.title) || isStudentPlacement(row.title, '', row.jd || ''))
  }
  return rows
}

// Some 0.29.4 Feishu sources used a tenant root as the JD prefix. Repair exclusively
// URLs emitted by that implementation. A stable external ID never changes.
export function repairAtsPostingUrl(job) {
  if (job?.provider !== 'feishu' || !/^\d+$/u.test(String(job.externalId))) return job?.url
  const slug = String(job.sourceId || '').replace(/^feishu:/u, '')
  const target = Object.hasOwn(ATS_FEISHU_TARGETS, slug) && ATS_FEISHU_TARGETS[slug]
  if (!target || job.id !== 'feishu:' + slug + ':' + job.externalId || job.sourceId !== 'feishu:' + slug) return job.url
  const oldHost = slug + '.jobs.feishu.cn'
  if (job.url !== 'https://' + oldHost + '/position/' + job.externalId + '/detail') return job.url
  return target.origin + '/' + target.detailPrefix + '/' + job.externalId + '/detail'
}
