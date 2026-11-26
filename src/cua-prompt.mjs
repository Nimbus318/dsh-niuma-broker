export const MIN_CUA_DSH_VERSION = '0.2.3-alpha.2'
export const MIN_CUA_DSH_LABEL = '0.2.3 (0.2.3-alpha.2+)'

export function buildCuaCollectPrompt({ locale = 'zh', company = '', careersUrl = '' } = {}) {
  const isEn = locale === 'en'
  const target = [company, careersUrl].filter(Boolean).join(' · ')
  if (isEn) {
    return [
      'Please use DeepSeek Harness Computer Use to read the job page I currently have open on screen (BOSS直聘 / Nowcoder / Maimai / Lagou / Liepin / company careers page)',
      ...(target ? [`Target hint: ${target}`] : []),
      'Strict rules:',
      '1. Only read the visible JD or at most 5 visible job cards currently on screen. NEVER auto-paginate, batch crawl, or run background polling.',
      '2. NEVER ask for, inspect, or save passwords, cookies, or login credentials, and NEVER attempt to bypass login walls or slider CAPTCHAs.',
      '3. If you hit a login wall, slider CAPTCHA, unavailable Computer Use / missing permissions, or an empty page, stop immediately and tell me what step I should complete (or ask me to paste the JD manually).',
      '4. Once extracted, call `career_broker_import_opportunity` to stage the role(s) into my "Pending Import" drawer for my review.',
    ].join('\n')
  }
  return [
    '请使用 DeepSeek Harness 的 Computer Use（桌面操控）读取我当前屏幕上已打开的招聘页面（支持 BOSS直聘 / 牛客 / 脉脉 / 拉勾 / 猎聘 / 公司官网）。',
    ...(target ? [`目标线索：${target}`] : []),
    '请严格遵守以下规则：',
    '1. 仅读取当前页面可见的岗位详情，或在列表页读取当前屏幕可见的最多 5 张岗位卡片；严禁自动翻页、批量连抓或后台轮询。',
    '2. 严禁询问、读取或保存账号密码与登录 Cookie；严禁绕过登录墙或滑块验证码。',
    '3. 若遇到未登录/登录墙、滑块验证码、Computer Use 未开启或未授权、或页面无有效 JD，请立即停止并提示我处理（或引导我手动粘贴 JD），不要反复重试或猜测。',
    '4. 读取完成后，调用工具 `career_broker_import_opportunity` 把提取到的岗位信息放入「待确认」抽屉，等我核对后再入库。',
  ].join('\n')
}
