// Canonical company -> official brand domain registry (browser & Node safe, zero dependencies).
// Covers built-in internet big-tech AND popular cross-industry companies (EV, robotics, chips,
// quant, FinTech, SaaS, biotech, consulting), plus automatic URL/host domain inference.

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/

const IGNORED_ATS_HOSTS = new Set([
  'greenhouse.io', 'ashbyhq.com', 'lever.co', 'feishu.cn', 'mokahr.com', 'zhipin.com',
  'liepin.com', 'lagou.com', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'bosszhipin.com',
])

export const KNOWN_COMPANY_DOMAINS = Object.freeze({
  // Domestic Chinese Big-Tech & AI
  '字节跳动': 'bytedance.com', bytedance: 'bytedance.com',
  '腾讯': 'tencent.com', tencent: 'tencent.com',
  '美团': 'meituan.com', meituan: 'meituan.com',
  '智谱 ai': 'zhipuai.cn', '智谱': 'zhipuai.cn', 'zhipu-ai': 'zhipuai.cn', zhipu: 'zhipuai.cn',
  minimax: 'minimaxi.com', '稀宇科技': 'minimaxi.com',
  '京东': 'jd.com', jd: 'jd.com',
  '网易': '163.com', netease: '163.com',
  '阿里巴巴': 'alibaba.com', '阿里巴巴集团': 'alibaba.com', '阿里云': 'aliyun.com', alibaba: 'alibaba.com', aliyun: 'aliyun.com', '蚂蚁集团': 'antgroup.com',
  '百度': 'baidu.com', baidu: 'baidu.com',
  '华为': 'huawei.com', huawei: 'huawei.com',
  '小米': 'mi.com', xiaomi: 'mi.com',
  '拼多多': 'pinduoduo.com', pdd: 'pinduoduo.com',
  '小红书': 'xiaohongshu.com', xiaohongshu: 'xiaohongshu.com',
  '快手': 'kuaishou.com', kuaishou: 'kuaishou.com',
  '哔哩哔哩': 'bilibili.com', 'b站': 'bilibili.com', bilibili: 'bilibili.com',
  '米哈游': 'mihoyo.com', mihoyo: 'mihoyo.com',
  '滴滴': 'didiglobal.com', didi: 'didiglobal.com',
  '携程': 'trip.com', trip: 'trip.com', ctrip: 'trip.com',
  '得物': 'dewu.com', dewu: 'dewu.com', poizon: 'dewu.com',
  '安克创新': 'anker.com', anker: 'anker.com', 'anker-in': 'anker.com',
  '商汤科技': 'sensetime.com', '商汤': 'sensetime.com', sensetime: 'sensetime.com',
  '库洛游戏': 'kurogames.com', kurogame: 'kurogames.com',
  '月之暗面': 'moonshot.cn', moonshot: 'moonshot.cn', kimi: 'moonshot.cn',
  deepseek: 'deepseek.com', '深度求索': 'deepseek.com',
  '阶跃星辰': 'stepfun.com', stepfun: 'stepfun.com',
  '零一万物': '01.ai', '01ai': '01.ai', '百川智能': 'baichuan-ai.com', '硅基流动': 'siliconflow.cn',
  // Cross-industry: EV / Autonomous Driving / Robotics / Hardware / Chips / Quant / Biotech
  '蔚来': 'nio.com', nio: 'nio.com',
  '理想汽车': 'lixiang.com', '理想': 'lixiang.com', lixiang: 'lixiang.com',
  '小鹏汽车': 'xiaopeng.com', '小鹏': 'xiaopeng.com', xpeng: 'xiaopeng.com',
  '比亚迪': 'byd.com', byd: 'byd.com',
  '宁德时代': 'catl.com', catl: 'catl.com',
  '大疆': 'dji.com', dji: 'dji.com',
  '宇树科技': 'unitree.com', '宇树': 'unitree.com', unitree: 'unitree.com',
  '银河通用': 'galbot.com', galbot: 'galbot.com',
  '智元机器人': 'agibot.com', agibot: 'agibot.com',
  momenta: 'momenta.ai', '地平线': 'horizon.auto', horizon: 'horizon.auto',
  '黑芝麻智能': 'bst.ai', '寒武纪': 'cambricon.com', '摩尔线程': 'mthreads.com',
  '壁仞科技': 'birentech.com', '沐曦': 'metax-tech.com', '影石': 'insta360.com', insta360: 'insta360.com',
  '拓竹科技': 'bambulab.com', bambulab: 'bambulab.com',
  '幻方量化': 'high-flyer.cn', '九坤投资': 'ubiquant.com', '明汯投资': 'minghong.com',
  shein: 'shein.com', '希音': 'shein.com',
  // Global Tech / AI / DevTools / FinTech / Quant / Hardware
  anthropic: 'anthropic.com',
  openai: 'openai.com',
  cursor: 'cursor.com',
  vercel: 'vercel.com',
  linear: 'linear.app',
  stripe: 'stripe.com',
  figma: 'figma.com',
  notion: 'notion.so',
  perplexity: 'perplexity.ai',
  xai: 'x.ai',
  'scale ai': 'scale.com', scaleai: 'scale.com',
  supabase: 'supabase.com',
  poolside: 'poolside.ai',
  primeintellect: 'primeintellect.ai',
  thinkingmachines: 'thinkingmachines.ai',
  databricks: 'databricks.com',
  snowflake: 'snowflake.com',
  cloudflare: 'cloudflare.com',
  nvidia: 'nvidia.com',
  amd: 'amd.com',
  tesla: 'tesla.com',
  waymo: 'waymo.com',
  google: 'google.com',
  meta: 'meta.com',
  apple: 'apple.com',
  microsoft: 'microsoft.com',
  amazon: 'amazon.com',
  airbnb: 'airbnb.com',
  shopify: 'shopify.com',
  doordash: 'doordash.com', doordashusa: 'doordash.com',
  coinbase: 'coinbase.com',
  datadog: 'datadoghq.com',
  mongodb: 'mongodb.com',
  gitlab: 'gitlab.com',
  reddit: 'reddit.com',
  pinterest: 'pinterest.com',
  spotify: 'spotify.com',
  cohere: 'cohere.com',
  elevenlabs: 'elevenlabs.io',
  cognition: 'cognition.ai', 'cognition (devin)': 'cognition.ai',
  harvey: 'harvey.ai',
  ramp: 'ramp.com',
  plaid: 'plaid.com',
  discord: 'discord.com',
  robinhood: 'robinhood.com',
  lyft: 'lyft.com',
  elastic: 'elastic.co',
  okta: 'okta.com',
  brex: 'brex.com',
  affirm: 'affirm.com',
  sierra: 'sierra.ai',
  langchain: 'langchain.com',
  modal: 'modal.com',
  replit: 'replit.com',
  togetherai: 'together.ai', 'together ai': 'together.ai',
  suno: 'suno.com',
  duolingo: 'duolingo.com',
  dropbox: 'dropbox.com',
  zoox: 'zoox.com',
  weride: 'weride.ai', '文远知行': 'weride.ai',
  'jane street': 'janestreet.com',
  citadel: 'citadel.com',
  'two sigma': 'twosigma.com',
  'hrt': 'hudsonrivertrading.com',
  'optiver': 'optiver.com',
})

export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.trim().toLowerCase()
  if (!s) return ''
  if (s.includes('://')) {
    try { s = new URL(s).hostname.toLowerCase() } catch { return '' }
  } else {
    s = s.split('/')[0].split('?')[0].split('#')[0]
  }
  s = s.replace(/^www\./, '').replace(/\.$/, '')
  if (!DOMAIN_RE.test(s)) return ''
  if (s === 'localhost' || s.endsWith('.local') || s.endsWith('.internal')) return ''
  return s
}

function rootRegistrableHost(hostname) {
  const parts = hostname.split('.')
  if (parts.length <= 2) return hostname
  const lastTwo = parts.slice(-2).join('.')
  if (['com.cn', 'org.cn', 'net.cn', 'gov.cn', 'co.uk', 'co.jp', 'com.hk', 'com.sg', 'com.au'].includes(lastTwo)) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}

export function resolveCompanyDomain({ domain, company, slug, url } = {}) {
  const explicit = normalizeDomain(domain)
  if (explicit) return explicit

  const keys = [company, slug]
    .map(v => typeof v === 'string' ? v.trim().toLowerCase() : '')
    .filter(Boolean)

  for (const key of keys) {
    if (KNOWN_COMPANY_DOMAINS[key]) return KNOWN_COMPANY_DOMAINS[key]
  }
  for (const key of keys) {
    for (const [known, host] of Object.entries(KNOWN_COMPANY_DOMAINS)) {
      if (known.length >= 2 && (key.includes(known) || known.includes(key))) return host
    }
  }

  if (typeof url === 'string' && url.startsWith('https://')) {
    try {
      const host = normalizeDomain(new URL(url).hostname)
      if (host) {
        const root = rootRegistrableHost(host)
        if (!IGNORED_ATS_HOSTS.has(root)) return root
      }
    } catch {}
  }

  return ''
}
