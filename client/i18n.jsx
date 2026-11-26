import React from 'react'
import {
  createTranslator,
  DEFAULT_LOCALE,
  detectRuntimeLocale,
  normalizeLocale,
  normalizeLocalePreference,
  SUPPORTED_LOCALES,
} from '../src/i18n/index.mjs'

import {
  getActiveProfileKey,
  readProfileLocal,
  removeProfileLocal,
  subscribeProfileChange,
  writeProfileLocal,
} from './profile-storage.js'

const LOCALE_STORAGE_KEY = 'localePref'

const listeners = new Set()
let currentPreference = readStoredPreference()
let currentHostLocale = ''
let hostLocaleBound = false

function readStoredPreference() {
  return normalizeLocalePreference(readProfileLocal(LOCALE_STORAGE_KEY) || 'auto')
}

subscribeProfileChange(() => {
  const next = readStoredPreference()
  if (next !== currentPreference) {
    currentPreference = next
    for (const fn of listeners) fn()
  }
})

export function setHostLocaleBound(bound) {
  const next = Boolean(bound)
  if (next === hostLocaleBound) return
  hostLocaleBound = next
  for (const fn of listeners) fn()
}

export function detectBrowserHostLocale() {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const htmlLang = typeof document !== 'undefined' ? (document.documentElement?.lang || '') : ''
  const navLang = typeof navigator !== 'undefined'
    ? (navigator.language || (Array.isArray(navigator.languages) ? navigator.languages[0] : '') || '')
    : ''
  return detectRuntimeLocale({
    preference: 'auto',
    hostLocale: currentHostLocale,
    htmlLang,
    navigatorLanguage: navLang,
    fallback: DEFAULT_LOCALE,
  })
}

export function getActiveLocale() {
  if (currentPreference !== 'auto') return normalizeLocale(currentPreference, DEFAULT_LOCALE)
  return detectBrowserHostLocale()
}

export function getLocalePreference() {
  return currentPreference
}

export function setActiveHostLocale(hostLocale) {
  const clean = String(hostLocale || '').trim()
  if (clean === currentHostLocale) return
  currentHostLocale = clean
  for (const fn of listeners) fn()
}

export function setActiveLocalePreference(pref, { persist = true } = {}) {
  const next = normalizeLocalePreference(pref)
  if (persist && getActiveProfileKey()) {
    if (next === 'auto') removeProfileLocal(LOCALE_STORAGE_KEY)
    else writeProfileLocal(LOCALE_STORAGE_KEY, next)
  }
  if (next === currentPreference) return
  currentPreference = next
  for (const fn of listeners) fn()
}

export function subscribeLocale(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const I18nContext = React.createContext(null)

export function I18nProvider({ configLocale, hostLocale, children }) {
  const [, bump] = React.useReducer(x => x + 1, 0)
  const isHostBound = hostLocaleBound

  React.useEffect(() => subscribeLocale(bump), [])

  React.useEffect(() => {
    if (hostLocale) setActiveHostLocale(hostLocale)
  }, [hostLocale])

  React.useEffect(() => {
    if (typeof configLocale === 'string' && configLocale.trim()) {
      setActiveLocalePreference(configLocale)
    }
  }, [configLocale])

  // Standalone fallback when DSH ctx.locale is not mounted: watch <html lang="..."> / languagechange
  React.useEffect(() => {
    if (isHostBound || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const observer = new MutationObserver(() => bump())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    const onLangChange = () => bump()
    window.addEventListener('languagechange', onLangChange)
    return () => {
      observer.disconnect()
      window.removeEventListener('languagechange', onLangChange)
    }
  }, [isHostBound])

  const preference = getLocalePreference()
  const locale = getActiveLocale()

  const value = React.useMemo(() => {
    const tr = createTranslator(locale)
    return {
      ...tr,
      preference,
      supportedLocales: SUPPORTED_LOCALES,
      setPreference: setActiveLocalePreference,
    }
  }, [locale, preference])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = React.useContext(I18nContext)
  if (ctx) return ctx
  const locale = getActiveLocale()
  const tr = createTranslator(locale)
  return {
    ...tr,
    preference: getLocalePreference(),
    supportedLocales: SUPPORTED_LOCALES,
    setPreference: setActiveLocalePreference,
  }
}

export function getBrandTitle() {
  return createTranslator(getActiveLocale()).t('brand.name')
}
