export const TEMPLATE_DISPLAY_NAMES = Object.freeze({
  onyx: Object.freeze({ zh: '极简单栏', en: 'Minimal Single' }),
  lapras: Object.freeze({ zh: '现代卡片', en: 'Modern Card' }),
  porygon: Object.freeze({ zh: '彩顶通栏', en: 'Banner Single' }),
  rhyhorn: Object.freeze({ zh: '经典直线', en: 'Classic Linear' }),
  bronzor: Object.freeze({ zh: '居中衬线', en: 'Centered Serif' }),
  kakuna: Object.freeze({ zh: '居中简约', en: 'Centered Clean' }),
  meowth: Object.freeze({ zh: '学术衬线', en: 'Academic Serif' }),
  persian: Object.freeze({ zh: '典雅人文', en: 'Editorial Classic' }),
  scizor: Object.freeze({ zh: '工程条理', en: 'Structured Grid' }),
  smeargle: Object.freeze({ zh: '清朗单栏', en: 'Crisp Modern' }),
  azurill: Object.freeze({ zh: '居中双栏', en: 'Centered Split' }),
  ditto: Object.freeze({ zh: '顶栏双列', en: 'Banner Split' }),
  ditgar: Object.freeze({ zh: '深色左侧栏', en: 'Bold Left Rail' }),
  gengar: Object.freeze({ zh: '色块左栏', en: 'Accent Left Rail' }),
  glalie: Object.freeze({ zh: '轻灰左侧栏', en: 'Tinted Left Rail' }),
  pikachu: Object.freeze({ zh: '左栏彩标', en: 'Sidebar Banner' }),
  chikorita: Object.freeze({ zh: '色块右栏', en: 'Accent Right Rail' }),
  leafish: Object.freeze({ zh: '通顶右栏', en: 'Header Right Rail' }),
})

export function templateDisplayName(tplOrId, locale = 'zh') {
  const isEn = String(locale || '').toLowerCase().startsWith('en')
  if (tplOrId && typeof tplOrId === 'object') {
    const picked = isEn
      ? (tplOrId.labelEn || TEMPLATE_DISPLAY_NAMES[tplOrId.id]?.en)
      : (tplOrId.labelZh || TEMPLATE_DISPLAY_NAMES[tplOrId.id]?.zh)
    return picked || tplOrId.label || tplOrId.id || ''
  }
  const key = String(tplOrId || '').trim().toLowerCase()
  const names = TEMPLATE_DISPLAY_NAMES[key]
  if (names) return isEn ? names.en : names.zh
  return key ? key[0].toUpperCase() + key.slice(1) : ''
}

export const RESUME_ACCENT_SWATCHES = Object.freeze([
  { id: 'charcoal', label: '炭黑', hex: '#18181b' },
  { id: 'navy', label: '藏青', hex: '#1e3a5f' },
  { id: 'blue', label: '科技蓝', hex: '#2563eb' },
  { id: 'ocean', label: '海洋青', hex: '#0369a1' },
  { id: 'teal', label: '墨绿', hex: '#0f766e' },
  { id: 'indigo', label: '靛紫', hex: '#4f46e5' },
  { id: 'stone', label: '暖褐', hex: '#57534e' },
  { id: 'wine', label: '酒红', hex: '#881337' },
])

export const TEMPLATE_DEFAULT_STYLES = Object.freeze({
  onyx: Object.freeze({ accent: '#18181b', font: 'sans', density: 'balanced' }),
  porygon: Object.freeze({ accent: '#1e3a5f', font: 'sans', density: 'balanced' }),
  rhyhorn: Object.freeze({ accent: '#334155', font: 'sans', density: 'balanced' }),
  bronzor: Object.freeze({ accent: '#1e3a5f', font: 'serif', density: 'balanced' }),
  kakuna: Object.freeze({ accent: '#0f766e', font: 'sans', density: 'balanced' }),
  lapras: Object.freeze({ accent: '#3730a3', font: 'sans', density: 'balanced' }),
  meowth: Object.freeze({ accent: '#57534e', font: 'serif', density: 'balanced' }),
  persian: Object.freeze({ accent: '#881337', font: 'serif', density: 'balanced' }),
  scizor: Object.freeze({ accent: '#0f766e', font: 'sans', density: 'balanced' }),
  smeargle: Object.freeze({ accent: '#4f46e5', font: 'sans', density: 'balanced' }),
  azurill: Object.freeze({ accent: '#0369a1', font: 'sans', density: 'balanced' }),
  chikorita: Object.freeze({ accent: '#0f766e', font: 'sans', density: 'balanced' }),
  ditgar: Object.freeze({ accent: '#1e293b', font: 'sans', density: 'balanced' }),
  ditto: Object.freeze({ accent: '#3730a3', font: 'sans', density: 'balanced' }),
  gengar: Object.freeze({ accent: '#4338ca', font: 'sans', density: 'balanced' }),
  glalie: Object.freeze({ accent: '#334155', font: 'sans', density: 'balanced' }),
  leafish: Object.freeze({ accent: '#166534', font: 'sans', density: 'balanced' }),
  pikachu: Object.freeze({ accent: '#92400e', font: 'sans', density: 'balanced' }),
})

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu
const VALID_FONTS = new Set(['sans', 'serif'])
const VALID_DENSITIES = new Set(['compact', 'balanced', 'airy'])

export function expandHex(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!HEX_COLOR.test(trimmed)) return ''
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

export function hexToRgba(hex, alpha = 1) {
  const full = expandHex(hex) || '#18181b'
  const r = parseInt(full.slice(1, 3), 16)
  const g = parseInt(full.slice(3, 5), 16)
  const b = parseInt(full.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function defaultStyleForTemplate(template = 'onyx') {
  return TEMPLATE_DEFAULT_STYLES[template] ?? TEMPLATE_DEFAULT_STYLES.onyx
}

export function normalizeResumeStyle(style, template = 'onyx') {
  const base = defaultStyleForTemplate(template)
  if (!style || typeof style !== 'object') return { ...base }
  const accent = expandHex(style.accent) || base.accent
  const font = VALID_FONTS.has(style.font) ? style.font : base.font
  const density = VALID_DENSITIES.has(style.density) ? style.density : base.density
  return { accent, font, density }
}

/**
 * Pure luminance/white/black-preserving CSS filter that remaps the #dc2626 red accent
 * baked into sample WebP thumbnails to any curated hex palette without graying out paper or text.
 */
export function accentToThumbFilter(hex) {
  const full = expandHex(hex) || '#18181b'
  const r = parseInt(full.slice(1, 3), 16) / 255
  const g = parseInt(full.slice(3, 5), 16) / 255
  const b = parseInt(full.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  if (saturation < 0.16) return 'saturate(0.06)'
  let hue = 0
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue = Math.round(hue * 60)
    if (hue < 0) hue += 360
  }
  const satScale = Math.max(0.32, Math.min(0.88, saturation * 0.78))
  return `hue-rotate(${hue}deg) saturate(${satScale.toFixed(2)})`
}

const COLOR_PATTERNS = [
  { re: /(?:炭黑|纯黑|黑白|极简黑|黑色|石墨黑|charcoal|black|monochrome|graphite)/iu, hex: '#18181b', label: '炭黑', labelEn: 'Charcoal' },
  { re: /(?:藏青|海军蓝|深蓝|商务蓝|午夜蓝|navy|dark\s*blue|midnight\s*blue)/iu, hex: '#1e3a5f', label: '藏青', labelEn: 'Navy' },
  { re: /(?:科技蓝|亮蓝|蓝色|宝蓝|天蓝|cobalt|royal\s*blue|blue)/iu, hex: '#2563eb', label: '科技蓝', labelEn: 'Cobalt Blue' },
  { re: /(?:海洋青|湖蓝|青蓝|ocean|cyan|cerulean)/iu, hex: '#0369a1', label: '海洋青', labelEn: 'Ocean Blue' },
  { re: /(?:墨绿|松石|深绿|森林绿|青绿|绿色|teal|emerald|forest\s*green|green)/iu, hex: '#0f766e', label: '墨绿', labelEn: 'Forest Teal' },
  { re: /(?:靛紫|靛蓝|紫色|薰衣草|紫蓝|indigo|purple|violet|plum)/iu, hex: '#4f46e5', label: '靛紫', labelEn: 'Indigo' },
  { re: /(?:暖褐|胡桃|棕色|咖啡|大地色|焦糖|琥珀|brown|stone|amber|bronze|walnut)/iu, hex: '#57534e', label: '暖褐', labelEn: 'Warm Stone' },
  { re: /(?:酒红|勃艮第|暗红|复古红|红棕|burgundy|wine|crimson|maroon)/iu, hex: '#881337', label: '酒红', labelEn: 'Burgundy' },
]

const CONTENT_EDIT_HINTS = /(?:经历|项目|职责|数字|开头|简介|技能|前移|置顶|删除|去掉|删掉|补充|重写|润色|翻译|英文|扩写|合并|量化|突出|强调|描述|岗位|JD|裁员|实习|教育|成果|\b(?:experience|project|projects|bullet|bullets|metric|metrics|summary|skills?|rewrite|polish|translate|quantify|highlight|tailor|remove|delete|add|shorten|tighten|education|internship|job\s+description|jd|wording|phrasing|content)\b)/iu

export function parseStyleDirective(rawText, templates = [], locale = 'zh') {
  const isEn = locale === 'en'
  const text = typeof rawText === 'string' ? rawText.trim() : ''
  if (!text || text.length > 260) return { matched: false }

  const patch = {}
  const labels = []
  let templateId = ''

  if (
    /(?:恢复默认|重置|还原).*(?:样式|外观|颜色|排版|配色)/iu.test(text)
    || /(?:默认样式|默认外观|默认配色)/iu.test(text)
    || /\b(?:reset|restore)\b.*\b(?:style|appearance|colors?|layout|theme|defaults?)\b/iu.test(text)
    || /\bdefault\s+(?:style|appearance|colors?|layout|theme)\b/iu.test(text)
  ) {
    return {
      matched: true,
      pureStyle: !CONTENT_EDIT_HINTS.test(text),
      patch: { reset: true },
      templateId: '',
      summary: isEn ? 'Restored default template appearance' : '已恢复模板默认外观',
    }
  }

  const explicitHex = text.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/iu)?.[0]
  if (explicitHex) {
    patch.accent = expandHex(explicitHex)
    labels.push(isEn ? `Accent ${patch.accent}` : `主题色 ${patch.accent}`)
  } else {
    for (const item of COLOR_PATTERNS) {
      if (item.re.test(text)) {
        patch.accent = item.hex
        labels.push(isEn ? item.labelEn : item.label)
        break
      }
    }
  }

  if (/(?:衬线|宋体|明体|serif|学术风|古典|传统字体)/iu.test(text) && !/无衬线|sans/iu.test(text)) {
    patch.font = 'serif'
    labels.push(isEn ? 'Serif font' : '衬线字体')
  } else if (/(?:无衬线|黑体|现代字体|简洁字体|sans(?:[- ]?serif)?)/iu.test(text)) {
    patch.font = 'sans'
    labels.push(isEn ? 'Sans-serif font' : '无衬线字体')
  }

  if (/(?:紧凑|放进一页|塞进一页|缩到一页|缩成一页|一页纸|省页|字小|小一点|行距紧|边距小|\bcompact\b|\b1[- ]?page\b|\bone[- ]?page\b|\bdense\b|\btight(?:er)?\s+(?:layout|spacing)\b)/iu.test(text)) {
    patch.density = 'compact'
    labels.push(isEn ? 'Compact layout' : '紧凑版面')
  } else if (/(?:舒展|宽松|留白多|大气|松一点|字大|大一点|行距大|间距大|\bairy\b|\bspacious\b|\brelaxed\s+(?:layout|spacing)\b)/iu.test(text)) {
    patch.density = 'airy'
    labels.push(isEn ? 'Airy layout' : '舒展版面')
  } else if (/(?:标准间距|正常间距|标准版面|适中|\bbalanced\b|\bstandard\s+(?:layout|spacing)\b)/iu.test(text)) {
    patch.density = 'balanced'
    labels.push(isEn ? 'Balanced layout' : '标准版面')
  }

  const tplLabel = tpl => (isEn ? (tpl.labelEn || tpl.label) : (tpl.labelZh || tpl.label))
  for (const tpl of templates) {
    if (!tpl?.id) continue
    const idMatch = new RegExp(`\\b${tpl.id}\\b`, 'iu').test(text)
    const zhMatch = tpl.labelZh && text.includes(tpl.labelZh)
    const enMatch = tpl.labelEn && text.toLowerCase().includes(tpl.labelEn.toLowerCase())
    if (idMatch || zhMatch || enMatch) {
      templateId = tpl.id
      labels.push(isEn ? `${tplLabel(tpl)} layout` : `${tplLabel(tpl)}版式`)
      break
    }
  }
  if (!templateId) {
    if (/(?:双栏|两栏|侧边栏|\b(?:two|2)[- ]?col(?:umn)?s?\b)/iu.test(text)) {
      const pick = templates.find(item => item.id === 'azurill') ?? templates.find(item => item.columns === 2)
      if (pick) {
        templateId = pick.id
        labels.push(isEn ? `${tplLabel(pick)} (2-column)` : `${tplLabel(pick)}（双栏）`)
      }
    } else if (/(?:单栏|一栏|通栏|\bATS\b|\b(?:single|one|1)[- ]?col(?:umn)?\b)/iu.test(text)) {
      const pick = templates.find(item => item.id === 'onyx') ?? templates.find(item => item.columns === 1)
      if (pick) {
        templateId = pick.id
        labels.push(isEn ? `${tplLabel(pick)} (1-column)` : `${tplLabel(pick)}（单栏）`)
      }
    }
  }

  const matched = Object.keys(patch).length > 0 || Boolean(templateId)
  if (!matched) return { matched: false }

  const pureStyle = !CONTENT_EDIT_HINTS.test(text)
  return {
    matched: true,
    pureStyle,
    patch,
    templateId,
    summary: isEn ? `Updated: ${labels.join(' · ')}` : `已调整：${labels.join(' · ')}`,
  }
}

/**
 * Normalizes CommonMark CJK emphasis boundaries (e.g. `**标题：**正文` -> `**标题**：正文`)
 * so rich-text Markdown parsers never leave raw `**` markers unparsed.
 */
export function normalizeCjkBoldMarkdown(text = '') {
  if (typeof text !== 'string' || !text.includes('**')) return text
  return text
    .replace(/\*\*([^*\r\n]+?)([：:；;，,、。！？])\*\*(?=[^\s\p{P}])/gu, '**$1**$2')
    .replace(/\*\*([^*\r\n]+?[）)\]】》」』”])\*\*(?=[^\s\p{P}])/gu, '**$1** ')
}
