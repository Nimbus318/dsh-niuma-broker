import zhCatalog from '../../locale/messages/zh.json' with { type: 'json' }
import enCatalog from '../../locale/messages/en.json' with { type: 'json' }

export const DEFAULT_LOCALE = 'zh'

/**
 * Extensible locale registry.
 * To add a new language in the future (e.g. Japanese `ja`):
 *   1. Add `locale/messages/ja.json` (and `locale/ja.json` for DSH manifest metadata)
 *   2. Register it in `CATALOGS` and `SUPPORTED_LOCALES` below
 *   3. Run `npm test` — `test/i18n.test.mjs` automatically verifies 100% key & placeholder parity.
 */
export const SUPPORTED_LOCALES = [
  {
    code: 'zh',
    bcp47: 'zh-CN',
    nativeLabel: '简体中文',
    englishName: 'Simplified Chinese',
    brandTitle: '牛马经纪人',
    promptLanguage: 'Simplified Chinese (简体中文)',
  },
  {
    code: 'en',
    bcp47: 'en-US',
    nativeLabel: 'English',
    englishName: 'English',
    brandTitle: 'Niuma Broker',
    promptLanguage: 'English',
  },
]

export const CATALOGS = {
  zh: zhCatalog,
  en: enCatalog,
}

const SUPPORTED_BY_CODE = new Map(SUPPORTED_LOCALES.map(entry => [entry.code, entry]))

export function isSupportedLocale(code) {
  return SUPPORTED_BY_CODE.has(String(code || '').trim().toLowerCase())
}

export function normalizeLocalePreference(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/_/g, '-').split('.')[0]
  if (!clean || clean === 'auto' || clean === 'system') return 'auto'
  if (SUPPORTED_BY_CODE.has(clean)) return clean
  const base = clean.split('-')[0]
  if (SUPPORTED_BY_CODE.has(base)) return base
  if (base === 'zh' || clean.includes('hans') || clean.includes('hant')) return 'zh'
  return 'auto'
}

/**
 * Maps arbitrary BCP-47 / POSIX locale strings (e.g. "en-GB", "zh_Hans_CN", "en_US.UTF-8")
 * onto a supported catalog code. Unknown non-Chinese locales fall back to English when
 * `fallback` is `'en'` (used for runtime auto-detection), or `DEFAULT_LOCALE` otherwise.
 */
export function normalizeLocale(raw, fallback = DEFAULT_LOCALE) {
  const clean = String(raw || '').trim().toLowerCase().replace(/_/g, '-').split('.')[0]
  if (!clean || clean === 'auto' || clean === 'system' || clean === 'c' || clean === 'posix') {
    return SUPPORTED_BY_CODE.has(fallback) ? fallback : DEFAULT_LOCALE
  }
  if (SUPPORTED_BY_CODE.has(clean)) return clean
  const base = clean.split('-')[0]
  if (SUPPORTED_BY_CODE.has(base)) return base
  if (base === 'zh' || clean.includes('hans') || clean.includes('hant')) return 'zh'
  return SUPPORTED_BY_CODE.has(fallback) ? fallback : 'en'
}

export function detectRuntimeLocale({
  preference = 'auto',
  hostLocale = '',
  htmlLang = '',
  navigatorLanguage = '',
  envLang = '',
  fallback = DEFAULT_LOCALE,
} = {}) {
  const pref = normalizeLocalePreference(preference)
  if (pref !== 'auto') return pref
  for (const candidate of [hostLocale, htmlLang, navigatorLanguage, envLang]) {
    const clean = String(candidate || '').trim()
    if (!clean) continue
    const lower = clean.toLowerCase().replace(/_/g, '-').split('.')[0]
    if (lower === 'c' || lower === 'posix' || lower === 'auto') continue
    return normalizeLocale(clean, 'en')
  }
  return SUPPORTED_BY_CODE.has(fallback) ? fallback : DEFAULT_LOCALE
}

export function localeMeta(locale) {
  const code = normalizeLocale(locale, DEFAULT_LOCALE)
  return SUPPORTED_BY_CODE.get(code) ?? SUPPORTED_LOCALES[0]
}

function lookupPath(catalog, key) {
  if (!catalog || typeof key !== 'string') return undefined
  if (Object.hasOwn(catalog, key)) return catalog[key]
  const parts = key.split('.')
  let cur = catalog
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined
    cur = cur[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

export function interpolate(template, params, locale = DEFAULT_LOCALE) {
  if (typeof template !== 'string') return ''
  if (!params || typeof params !== 'object') return template
  const withPlurals = template.replace(
    /\{([a-zA-Z0-9_]+)\s*,\s*plural\s*,\s*((?:[a-zA-Z0-9_=]+\s*\{[^{}]*\}\s*)+)\}/g,
    (match, name, body) => {
      if (!Object.hasOwn(params, name) || params[name] == null) return match
      const num = Number(params[name])
      const forms = new Map()
      for (const m of body.matchAll(/([a-zA-Z0-9_=]+)\s*\{([^{}]*)\}/g)) {
        forms.set(m[1], m[2])
      }
      let picked = forms.get(`=${num}`)
      if (picked === undefined) {
        let category = num === 1 ? 'one' : 'other'
        try {
          category = new Intl.PluralRules(localeMeta(locale).bcp47).select(num)
        } catch {}
        picked = forms.get(category) ?? forms.get('other') ?? ''
      }
      return picked.replace(/#/g, String(params[name]))
    },
  )
  return withPlurals.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name) || params[name] == null) return match
    return String(params[name])
  })
}

export function translate(locale, key, params) {
  const code = normalizeLocale(locale, DEFAULT_LOCALE)
  const raw = lookupPath(CATALOGS[code], key)
    ?? lookupPath(CATALOGS.en, key)
    ?? lookupPath(CATALOGS.zh, key)
    ?? key
  return interpolate(raw, params, code)
}

export function formatLocalizedDate(value, locale = DEFAULT_LOCALE, { timezone, ...options } = {}) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return String(value)
  const bcp47 = localeMeta(locale).bcp47
  const opts = Object.keys(options).length
    ? options
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  try {
    return new Intl.DateTimeFormat(bcp47, timezone ? { ...opts, timeZone: timezone } : opts).format(date)
  } catch {
    try {
      return new Intl.DateTimeFormat(bcp47, opts).format(date)
    } catch {
      return date.toLocaleString()
    }
  }
}

export function formatShortDateTime(value, locale = DEFAULT_LOCALE, timezone) {
  return formatLocalizedDate(value, locale, {
    timezone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatClockTime(value, locale = DEFAULT_LOCALE, timezone) {
  return formatLocalizedDate(value, locale, {
    timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function createTranslator(locale = DEFAULT_LOCALE) {
  const meta = localeMeta(locale)
  const t = (key, params) => translate(meta.code, key, params)
  return {
    locale: meta.code,
    bcp47: meta.bcp47,
    meta,
    isZh: meta.code === 'zh',
    isEn: meta.code === 'en',
    t,
    formatDate: (value, options) => formatLocalizedDate(value, meta.code, options),
    formatShortDate: (value, timezone) => formatShortDateTime(value, meta.code, timezone),
    formatClock: (value, timezone) => formatClockTime(value, meta.code, timezone),
  }
}

/**
 * Flatten nested catalog JSON into dot-separated key -> string map (used for test parity checks).
 */
export function flattenCatalog(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenCatalog(v, full, out)
    } else if (typeof v === 'string') {
      out[full] = v
    }
  }
  return out
}
