export const MIN_CUA_DSH_VERSION = '0.2.3-alpha.2'
export const MIN_CUA_DSH_LABEL = '0.2.3 (0.2.3-alpha.2+)'

export const CUA_PLATFORMS = [
  {
    id: 'zhipin',
    labelZh: 'BOSS直聘',
    labelEn: 'BOSS直聘',
    url: 'https://www.zhipin.com/',
  },
  {
    id: 'nowcoder',
    labelZh: '牛客',
    labelEn: 'Nowcoder',
    url: 'https://www.nowcoder.com/jobs/fulltime/center',
    campusUrl: 'https://www.nowcoder.com/jobs/recommend/campus',
  },
  {
    id: 'maimai',
    labelZh: '脉脉',
    labelEn: 'Maimai',
    url: 'https://maimai.cn/jobs',
  },
  {
    id: 'lagou',
    labelZh: '拉勾',
    labelEn: 'Lagou',
    url: 'https://www.lagou.com/',
  },
  {
    id: 'liepin',
    labelZh: '猎聘',
    labelEn: 'Liepin',
    url: 'https://www.liepin.com/',
  },
  {
    id: 'linkedin',
    labelZh: 'LinkedIn',
    labelEn: 'LinkedIn',
    url: 'https://www.linkedin.com/jobs/',
  },
]

function normalizeTargetCount(raw, fallback = 8) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(12, Math.round(n)))
}

function formatHiringScopeLabel(scope, isEn) {
  if (scope === 'campus') return isEn ? 'Campus / Internships' : '校招 / 实习'
  if (scope === 'experienced') return isEn ? 'Experienced / Full-time' : '社招全职'
  if (scope === 'both') return isEn ? 'Experienced & Campus' : '社招与校招均可'
  return ''
}

function formatCareerLevelLabel(level, isEn) {
  if (level === 'campus') return isEn ? 'Entry / Campus' : '应届 / 校招'
  if (level === 'senior') return isEn ? 'Senior / Staff / Lead' : '资深 / Staff / 管理'
  if (level === 'ic') return isEn ? 'Mid / Senior IC' : '在职进阶 IC'
  return ''
}

export function buildCuaCollectPrompt({
  locale = 'zh',
  mode = 'hunt',
  platform = '',
  platformUrl = '',
  company = '',
  careersUrl = '',
  goal = '',
  searchTerms = [],
  hiringScope = '',
  careerLevel = '',
  targetCount,
  extraNotes = '',
} = {}) {
  const isEn = locale === 'en'
  const cleanMode = mode === 'current-page' && !company && !careersUrl ? 'current-page' : 'hunt'
  const limit = normalizeTargetCount(targetCount, cleanMode === 'hunt' ? 8 : 6)
  const cleanTerms = Array.isArray(searchTerms)
    ? searchTerms.map(s => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : []
  const cleanGoal = String(goal || '').trim()
  const cleanNotes = String(extraNotes || '').trim()
  const scopeLabel = formatHiringScopeLabel(hiringScope, isEn)
  const levelLabel = formatCareerLevelLabel(careerLevel, isEn)

  const selectedPlatform = CUA_PLATFORMS.find(p => p.id === platform)
    || CUA_PLATFORMS.find(p => p.labelZh === platform || p.labelEn === platform)
    || null
  const resolvedPlatformUrl = String(platformUrl || '').trim()
    || (selectedPlatform
      ? (hiringScope === 'campus' && selectedPlatform.campusUrl ? selectedPlatform.campusUrl : selectedPlatform.url)
      : '')
  const resolvedPlatformName = selectedPlatform
    ? (isEn ? selectedPlatform.labelEn : selectedPlatform.labelZh)
    : String(platform || '').trim()

  const prefLines = []
  if (cleanGoal) prefLines.push(isEn ? `- Target direction: ${cleanGoal}` : `- 求职目标方向：${cleanGoal}`)
  if (cleanTerms.length) prefLines.push(isEn ? `- Search keywords: ${cleanTerms.join(', ')}` : `- 搜索关键词：${cleanTerms.join('、')}`)
  if (scopeLabel) prefLines.push(isEn ? `- Track: ${scopeLabel}` : `- 岗位类型：${scopeLabel}`)
  if (levelLabel) prefLines.push(isEn ? `- Seniority level: ${levelLabel}` : `- 预期职级：${levelLabel}`)
  if (cleanNotes) prefLines.push(isEn ? `- Additional filters: ${cleanNotes}` : `- 补充筛选条件：${cleanNotes}`)

  const handoverExtraFields = [
    ...(cleanTerms.length ? [`keywords: ${JSON.stringify(cleanTerms)}`] : []),
    ...(hiringScope && ['campus', 'experienced', 'both'].includes(hiringScope) ? [`hiringScope: ${JSON.stringify(hiringScope)}`] : []),
  ]
  const handoverArgsEn = ['url', ...handoverExtraFields, `limit: ${limit}`].join(', ')
  const handoverHuntArgsEn = ['url', 'company', ...handoverExtraFields, `limit: ${limit}`].join(', ')
  const handoverArgsZh = handoverExtraFields.length ? `，同时传入 ${handoverExtraFields.join('、')}` : ''

  if (cleanMode === 'current-page') {
    if (isEn) {
      return [
        `Please use DeepSeek Harness Computer Use to inspect the recruitment page currently open on my screen (BOSS直聘 / Nowcoder / Maimai / Lagou / Liepin / LinkedIn / company careers site) and extract up to ${limit} matching role(s).`,
        ...(prefLines.length ? ['', 'Match criteria:', ...prefLines] : []),
        '',
        'Workflow & rules:',
        `0. FAST-PATH ATS CIRCUIT BREAKER: If I have a hosted ATS **job list or search** page open (e.g. \`*.jobs.feishu.cn\`, \`job-boards.greenhouse.io\`, \`jobs.ashbyhq.com\`, \`jobs.lever.co\`, \`app.mokahr.com\`) rather than a single job detail page, STOP scrolling or clicking immediately and call \`career_broker_register_ats_board({ ${handoverArgsEn} })\`. If it returns \`nextAction=stop\`, stop CUA immediately and summarize; only continue CUA if it returns \`nextAction=continue_cua\` (or if I am viewing a single job posting, extract that exact posting with \`career_broker_import_opportunity\`).`,
        `1. Whether I have a single job detail page open OR a job search/list/favorites page, inspect the postings on screen and extract matching roles (up to ${limit}).`,
        '2. When viewing a list or search page, click into promising postings one by one so you capture the complete JD text and canonical URL rather than stopping at 1 card or truncated list snippets.',
        '3. NEVER ask for, inspect, or save passwords, cookies, or login credentials, and NEVER attempt to bypass login walls or slider CAPTCHAs. If blocked by login/CAPTCHA or missing permissions, pause immediately and ask me to complete that step.',
        '4. Call `career_broker_import_opportunity` (up to 10 roles per call; use multiple batches if needed) to stage the extracted roles with company, title, location, canonical HTTPS url, full jd, and sourceSite into Niuma Broker\'s "Pending Import" drawer, then give me a short summary.',
      ].join('\n')
    }
    return [
      `请使用 DeepSeek Harness 的 Computer Use（桌面操控）查看我当前屏幕上已打开的招聘页面（支持 BOSS直聘 / 牛客 / 脉脉 / 拉勾 / 猎聘 / 官网），从当前页面最多挑选 ${limit} 个匹配岗位提取并记录到牛马经纪人。`,
      ...(prefLines.length ? ['', '筛选偏好：', ...prefLines] : []),
      '',
      '执行步骤与规则：',
      `0. 【托管招聘平台列表快通道熔断】：如果当前打开的是飞书招聘（\`*.jobs.feishu.cn\`）、Greenhouse（\`job-boards.greenhouse.io\`）、Ashby（\`jobs.ashbyhq.com\`）、Lever（\`jobs.lever.co\`）或 Moka（\`app.mokahr.com\`）等托管平台的**职位列表或搜索结果页**（而非单个岗位详情页），**请立刻停止翻页和逐个点开岗位**，调用工具 \`career_broker_register_ats_board\` 传入当前 URL 与 \`limit: ${limit}\`${handoverArgsZh}；若返回 \`nextAction=stop\`，请立即结束浏览器操作并总结。如果当前页已经是**单个岗位详情页**，直接读取该岗位完整信息并调用 \`career_broker_import_opportunity\` 暂存即可。`,
      `1. 如果当前页是单个岗位详情，直接提取完整信息；如果是岗位列表/搜索/收藏页，请逐个浏览并筛选最多 ${limit} 个高度相关的岗位（不要只抓 1 个就结束）。`,
      '2. 在列表页筛选时，请点进候选岗位详情页读取完整 JD 与准确链接，避免只记录列表页截断摘要。',
      '3. 严禁询问、读取或保存账号密码与登录 Cookie；严禁尝试绕过登录墙或滑块验证码。若遇到需要登录、滑块验证、未开启 Computer Use 或缺少屏幕权限，请立即暂停并提示我完成验证，待我确认后再继续。',
      '4. 调用工具 `career_broker_import_opportunity`（单次可传入 1–10 个岗位，超过可分批调用）把岗位完整写入「待确认」抽屉（含公司、岗位、城市、URL、完整 JD、来源平台），并在回复里简短说明挑了哪些岗位。',
    ].join('\n')
  }

  const cleanCompany = String(company || '').trim()
  const cleanCareersUrl = String(careersUrl || '').trim()
  const targetDesc = cleanCompany || cleanCareersUrl
    ? [cleanCompany, cleanCareersUrl].filter(Boolean).join(' · ')
    : [resolvedPlatformName || (isEn ? 'target recruitment platform' : '主流招聘平台'), resolvedPlatformUrl].filter(Boolean).join(' · ')

  if (isEn) {
    return [
      `Please use DeepSeek Harness Computer Use to actively search and collect up to ${limit} well-matched job postings for me.`,
      `Target site: ${targetDesc}`,
      ...(prefLines.length ? ['', 'My job search preferences:', ...prefLines] : [isEn ? '\n- Pick well-matched engineering/product/operations roles based on the listings you find.' : '']),
      '',
      'Workflow & rules:',
      `0. FAST-PATH ATS CIRCUIT BREAKER: As soon as the site opens or redirects to a hosted ATS portal (\`*.jobs.feishu.cn\`, \`job-boards.greenhouse.io\`, \`jobs.ashbyhq.com\`, \`jobs.lever.co\`, \`app.mokahr.com\`, etc.), **STOP clicking/scrolling immediately** and call \`career_broker_register_ats_board({ ${handoverHuntArgsEn} })\`. If it returns \`nextAction=stop\`, end Computer Use immediately and present the synced results; only continue visual browsing if it returns \`nextAction=continue_cua\`.`,
      resolvedPlatformUrl || cleanCareersUrl
        ? `1. Open my desktop browser and navigate directly to ${cleanCareersUrl || resolvedPlatformUrl} (or reuse an already-open tab on that site).`
        : `1. Open my desktop browser and navigate to the official careers site for ${cleanCompany || 'the target platform'}.`,
      '2. If the site requires login or shows a slider CAPTCHA, pause immediately and tell me so I can log in / verify manually—NEVER ask for passwords or cookies, and NEVER try to bypass anti-bot checks.',
      '3. Use the site search bar and filters according to my keywords, hiring track, and preferences above. Browse through 2–3 pages of search results.',
      `4. Click into promising postings to inspect the full JD and filter out irrelevant or low-match listings (don't stop after reading just 1 posting). Curate up to ${limit} genuinely good matches.`,
      '5. Call `career_broker_import_opportunity` (up to 10 roles per call; batch if needed) to stage all selected roles into Niuma Broker\'s "Pending Import" drawer with full JD, location, URL, and sourceSite, then summarize your picks in chat.',
    ].join('\n')
  }

  return [
    `请使用 DeepSeek Harness 的 Computer Use（桌面操控）主动去对应招聘平台为我搜索、筛选并提取最多 ${limit} 个合适岗位。`,
    `目标站点：${targetDesc}`,
    ...(prefLines.length ? ['', '我的求职筛选条件：', ...prefLines] : []),
    '',
    '执行步骤与规则：',
    `0. 【托管招聘平台快通道熔断】：一旦进入官网或点击「加入我们」后发现跳转到飞书招聘（\`*.jobs.feishu.cn\`）、Greenhouse（\`job-boards.greenhouse.io\`）、Ashby（\`jobs.ashbyhq.com\`）、Lever（\`jobs.lever.co\`）或 Moka（\`app.mokahr.com\`）等托管招聘平台，**请立刻停止 CUA 截图和逐条点开浏览**，第一时间调用工具 \`career_broker_register_ats_board\` 传入 URL、公司名与 \`limit: ${limit}\`${handoverArgsZh}；若返回 \`nextAction=stop\`，说明后端已改为高速直连拉取全量 JD，请立即结束浏览器操作并向用户汇报；只有返回 \`nextAction=continue_cua\` 时才继续下文步骤。`,
    (cleanCareersUrl || resolvedPlatformUrl)
      ? `1. 主动打开桌面浏览器并访问 ${cleanCareersUrl || resolvedPlatformUrl}（如果浏览器里已经打开了该站点标签页，可直接切过去继续操作）。`
      : `1. 主动打开桌面浏览器并搜索进入「${cleanCompany || '目标平台'}」的官方招聘页面。`,
    '2. 如果遇到需要登录或滑块验证码，请立即暂停并提示我手动完成登录/验证，我确认后你再继续；严禁询问、读取或保存账号密码/Cookie，严禁尝试绕过登录墙或验证码。',
    '3. 在网站内按我的求职方向、搜索关键词和补充条件进行搜索与筛选，向下浏览 2–3 页结果列表。',
    `4. 点开有潜力的岗位查看完整 JD，对照条件剔除明显不匹配的岗位（不要只读 1 个就停止），一共精选最多 ${limit} 个真正合适的岗位。`,
    '5. 调用工具 `career_broker_import_opportunity`（每次支持暂存 1–10 个岗位，多于 10 个可分批调用）把选出的岗位写入牛马经纪人「待确认」抽屉（带上完整 JD、城市、链接与来源平台），最后在对话中简述筛选结果与推荐理由。',
  ].join('\n')
}
