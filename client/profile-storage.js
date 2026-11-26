/**
 * Single client browser-storage gateway scoped by `profileKey`.
 * Ensures drafts, chats, and preferences are strictly isolated per DSH profile on the same origin.
 */

const PROFILE_PREFIX = 'niuma.p.'
const LEGACY_OWNER_KEY = 'niuma.legacyOwner'
const LEGACY_CLAIM_PREFIX = 'niuma.legacyClaim.'
const LEGACY_MIGRATED_KEY = 'legacyMigrated.v1'

let activeProfileKey = ''
let profileGeneration = 0
const migratedProfiles = new Set()
const profileListeners = new Set()
const profileMismatchListeners = new Set()
let migrationQueue = Promise.resolve()

let overrideLocalStorage
let overrideSessionStorage

function defaultLocalStorage() {
  try { return globalThis?.localStorage ?? null } catch { return null }
}

function defaultSessionStorage() {
  try { return globalThis?.sessionStorage ?? null } catch { return null }
}

function resolveAdapter(kind) {
  if (kind === 'local') {
    return overrideLocalStorage !== undefined ? overrideLocalStorage : defaultLocalStorage()
  }
  return overrideSessionStorage !== undefined ? overrideSessionStorage : defaultSessionStorage()
}

function safeGetItem(storage, key) {
  if (!storage || !key) return null
  try {
    const val = storage.getItem(key)
    return typeof val === 'string' ? val : null
  } catch {
    return null
  }
}

function safeSetItem(storage, key, value) {
  if (!storage || !key) return false
  try {
    storage.setItem(key, String(value))
    return true
  } catch {
    return false
  }
}

function safeRemoveItem(storage, key) {
  if (!storage || !key) return false
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function safeListAllKeys(storage) {
  if (!storage) return []
  const keys = []
  try {
    if (typeof storage.key !== 'function') return []
    const len = storage.length
    if (!Number.isFinite(len)) return []
    for (let i = 0; i < len; i += 1) {
      const k = storage.key(i)
      if (typeof k === 'string' && k) keys.push(k)
    }
  } catch {}
  return keys
}

function scopedPrefix(profileKey = activeProfileKey) {
  const clean = typeof profileKey === 'string' ? profileKey.trim() : ''
  return clean ? `${PROFILE_PREFIX}${clean}.` : ''
}

function scopedFullKey(key, profileKey = activeProfileKey) {
  const prefix = scopedPrefix(profileKey)
  if (!prefix || !key) return ''
  return `${prefix}${key}`
}

function readScoped(kind, key, { profileKey = activeProfileKey } = {}) {
  const fullKey = scopedFullKey(key, profileKey)
  if (!fullKey) return null
  return safeGetItem(resolveAdapter(kind), fullKey)
}

function writeScoped(kind, key, value, { profileKey = activeProfileKey } = {}) {
  const fullKey = scopedFullKey(key, profileKey)
  if (!fullKey) return false
  return safeSetItem(resolveAdapter(kind), fullKey, value)
}

function removeScoped(kind, key, { profileKey = activeProfileKey } = {}) {
  const fullKey = scopedFullKey(key, profileKey)
  if (!fullKey) return false
  return safeRemoveItem(resolveAdapter(kind), fullKey)
}

function listScopedKeys(kind, keyPrefix = '', { profileKey = activeProfileKey } = {}) {
  const basePrefix = scopedPrefix(profileKey)
  if (!basePrefix) return []
  const fullPrefix = `${basePrefix}${keyPrefix || ''}`
  const storage = resolveAdapter(kind)
  const out = []
  for (const rawKey of safeListAllKeys(storage)) {
    if (rawKey.startsWith(fullPrefix)) {
      out.push(rawKey.slice(basePrefix.length))
    }
  }
  return out
}

function clearScopedPrefix(kind, keyPrefix = '', { profileKey = activeProfileKey } = {}) {
  const basePrefix = scopedPrefix(profileKey)
  if (!basePrefix) return 0
  const fullPrefix = `${basePrefix}${keyPrefix || ''}`
  const storage = resolveAdapter(kind)
  if (!storage) return 0
  const targets = safeListAllKeys(storage).filter(k => k.startsWith(fullPrefix))
  let removed = 0
  for (const fullKey of targets) {
    if (safeRemoveItem(storage, fullKey)) removed += 1
  }
  return removed
}

/**
 * Returns the active profileKey namespace identifier received from the backend host.
 */
export function getActiveProfileKey() {
  return activeProfileKey
}

/**
 * Returns the monotonically increasing profile-switch generation counter.
 */
export function getProfileGeneration() {
  return profileGeneration
}

/**
 * Captures the current profileKey and generation before launching an async operation.
 */
export function captureProfileContext() {
  return { profileKey: activeProfileKey, generation: profileGeneration }
}

/**
 * Returns true only when `ctx` still matches the currently active profile and generation.
 */
export function isProfileContextCurrent(ctx) {
  return Boolean(ctx) && ctx.profileKey === activeProfileKey && ctx.generation === profileGeneration
}

/**
 * Subscribes to profile scope transitions (switch between profiles on the same origin).
 */
export function subscribeProfileChange(listener) {
  if (typeof listener !== 'function') return () => {}
  profileListeners.add(listener)
  return () => { profileListeners.delete(listener) }
}

/**
 * Subscribes to backend HTTP 409 PROFILE_MISMATCH notifications so the workspace can refresh.
 */
export function subscribeProfileMismatch(listener) {
  if (typeof listener !== 'function') return () => {}
  profileMismatchListeners.add(listener)
  return () => { profileMismatchListeners.delete(listener) }
}

/**
 * Broadcasts a profile mismatch signal when a request hits another active backend profile.
 */
export function notifyProfileMismatch(detail = null) {
  for (const fn of profileMismatchListeners) {
    try { fn(detail) } catch {}
  }
}

/**
 * Builds standard plugin headers including the captured or active `x-career-profile-key`.
 */
export function profileRequestHeaders(extraHeaders = {}, ctx = null) {
  const pk = typeof ctx?.profileKey === 'string' && ctx.profileKey.trim()
    ? ctx.profileKey.trim()
    : activeProfileKey
  return {
    'x-career-agent': '1',
    ...(pk ? { 'x-career-profile-key': pk } : {}),
    ...(extraHeaders || {}),
  }
}

/**
 * Inspects a response/payload for HTTP 409 PROFILE_MISMATCH and notifies listeners if matched.
 */
export function checkProfileMismatch(response, payload = null) {
  if (response?.status === 409 && payload?.code === 'PROFILE_MISMATCH') {
    notifyProfileMismatch(payload)
    return true
  }
  return false
}

/**
 * Activates a profile namespace; increments generation and notifies listeners when changed.
 */
export function activateProfileScope(nextKey) {
  const clean = typeof nextKey === 'string' ? nextKey.trim() : ''
  if (clean === activeProfileKey) {
    return { changed: false, profileKey: activeProfileKey, generation: profileGeneration }
  }
  const prev = activeProfileKey
  activeProfileKey = clean
  profileGeneration += 1
  const event = { changed: true, prev, next: clean, profileKey: clean, generation: profileGeneration }
  for (const fn of profileListeners) {
    try { fn(event) } catch {}
  }
  return event
}

export function readProfileLocal(key, opts) { return readScoped('local', key, opts) }
export function writeProfileLocal(key, value, opts) { return writeScoped('local', key, value, opts) }
export function removeProfileLocal(key, opts) { return removeScoped('local', key, opts) }
export function listProfileLocalKeys(prefix, opts) { return listScopedKeys('local', prefix, opts) }
export function clearProfileLocalPrefix(prefix, opts) { return clearScopedPrefix('local', prefix, opts) }

export function readProfileSession(key, opts) { return readScoped('session', key, opts) }
export function writeProfileSession(key, value, opts) { return writeScoped('session', key, value, opts) }
export function removeProfileSession(key, opts) { return removeScoped('session', key, opts) }
export function listProfileSessionKeys(prefix, opts) { return listScopedKeys('session', prefix, opts) }
export function clearProfileSessionPrefix(prefix, opts) { return clearScopedPrefix('session', prefix, opts) }

function normalizeLegacyLocaleToken(raw) {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (clean.startsWith('en')) return 'en'
  if (clean.startsWith('zh')) return 'zh'
  return ''
}

function claimLegacyKey(rawLocal, claimKey, pk) {
  if (!rawLocal || !claimKey || !pk) return false
  const storageKey = `${LEGACY_CLAIM_PREFIX}${claimKey}`
  const existing = safeGetItem(rawLocal, storageKey)
  if (existing && existing !== pk) return false
  if (existing === pk) return true
  if (!safeSetItem(rawLocal, storageKey, pk)) return false
  return safeGetItem(rawLocal, storageKey) === pk
}

/**
 * Conservatively migrates pre-isolation browser keys into the active or explicit target profile namespace
 * without ever deleting legacy keys or claiming keys whose ownership cannot be proven.
 */
export function migrateLegacyStorageForProfile(state, { resolveResumeBaseText, profileKey } = {}) {
  const pk = (typeof profileKey === 'string' && profileKey.trim()) || activeProfileKey
  if (!pk) return false
  const targetOpts = { profileKey: pk }
  if ((!profileKey && migratedProfiles.has(pk)) || readProfileLocal(LEGACY_MIGRATED_KEY, targetOpts) === '1') {
    migratedProfiles.add(pk)
    return false
  }

  const rawLocal = resolveAdapter('local')
  if (!rawLocal || !writeProfileLocal(LEGACY_MIGRATED_KEY, '1', targetOpts)) {
    return false
  }
  migratedProfiles.add(pk)

  const rawSession = resolveAdapter('session')
  const resumes = Array.isArray(state?.resumes) ? state.resumes : []
  const resumeById = new Map(resumes.filter(r => r && typeof r.id === 'string' && r.id).map(r => [r.id, r]))

  // Track 1: Entity keys — only migrate unclaimed keys with verified resume ownership & content parity.
  // Never auto-claim shared job-scoped drafts (`draft.v1:*`), `draftSources.v1:*`, or `resumeChat.v2:default`.
  for (const rawKey of safeListAllKeys(rawLocal)) {
    if (rawKey.startsWith('niuma.resumeDraft.')) {
      const id = rawKey.slice('niuma.resumeDraft.'.length)
      const record = resumeById.get(id)
      if (!record || readProfileLocal(`resumeDraft.${id}`, targetOpts) !== null) continue
      const rawVal = safeGetItem(rawLocal, rawKey)
      if (!rawVal) continue
      try {
        const parsed = JSON.parse(rawVal)
        const expectedBase = typeof resolveResumeBaseText === 'function'
          ? resolveResumeBaseText(record)
          : (record.text ?? '')
        if (parsed && typeof parsed.text === 'string' && typeof parsed.baseText === 'string'
          && parsed.baseText === expectedBase && parsed.text !== expectedBase) {
          if (claimLegacyKey(rawLocal, rawKey, pk)) {
            writeProfileLocal(`resumeDraft.${id}`, rawVal, targetOpts)
          }
        }
      } catch {}
    } else if (rawKey.startsWith('niuma.versionAppearance.')) {
      const id = rawKey.slice('niuma.versionAppearance.'.length)
      if (!id || !resumeById.has(id) || readProfileLocal(`versionAppearance.${id}`, targetOpts) !== null) continue
      const rawVal = safeGetItem(rawLocal, rawKey)
      if (rawVal !== null && claimLegacyKey(rawLocal, rawKey, pk)) {
        writeProfileLocal(`versionAppearance.${id}`, rawVal, targetOpts)
      }
    }
  }
  const legacySelectedId = safeGetItem(rawLocal, 'niuma.selectedResumeId')
  const selectedClaimKey = 'niuma.selectedResumeId'
  if (legacySelectedId && resumeById.has(legacySelectedId) && readProfileLocal('selectedResumeId', targetOpts) === null) {
    if (claimLegacyKey(rawLocal, selectedClaimKey, pk)) {
      writeProfileLocal('selectedResumeId', legacySelectedId, targetOpts)
    }
  }

  if (rawSession) {
    for (const rawKey of safeListAllKeys(rawSession)) {
      if (!rawKey.startsWith('niuma.resumeChat.v2:')) continue
      const scopeId = rawKey.slice('niuma.resumeChat.v2:'.length)
      if (!scopeId || scopeId === 'default' || !resumeById.has(scopeId)) continue
      if (readProfileSession(`resumeChat.v2:${scopeId}`, targetOpts) !== null) continue
      const rawVal = safeGetItem(rawSession, rawKey)
      if (rawVal !== null && claimLegacyKey(rawLocal, `session:${rawKey}`, pk)) {
        writeProfileSession(`resumeChat.v2:${scopeId}`, rawVal, targetOpts)
      }
    }
  }

  // Track 2: Preference keys — single-owner claim via `niuma.legacyOwner`.
  let owner = safeGetItem(rawLocal, LEGACY_OWNER_KEY) || ''
  if (!owner) {
    if (safeSetItem(rawLocal, LEGACY_OWNER_KEY, pk)) {
      owner = safeGetItem(rawLocal, LEGACY_OWNER_KEY) || pk
    }
  }
  if (owner === pk) {
    const localPrefPairs = [
      ['niuma.local.template', 'local.template'],
      ['niuma.local.style', 'local.style'],
      ['niuma.templateStripOpen', 'templateStripOpen'],
      ['niuma.goalGuideDismissed', 'goalGuideDismissed'],
    ]
    for (const [legacyKey, targetKey] of localPrefPairs) {
      if (readProfileLocal(targetKey, targetOpts) !== null) continue
      const rawVal = safeGetItem(rawLocal, legacyKey)
      if (rawVal !== null) writeProfileLocal(targetKey, rawVal, targetOpts)
    }
    if (rawSession) {
      const sessionPrefPairs = [
        ['niuma.activeTab', 'activeTab'],
        ['niuma.insightBriefCollapsed', 'insightBriefCollapsed'],
      ]
      for (const [legacyKey, targetKey] of sessionPrefPairs) {
        if (readProfileSession(targetKey, targetOpts) !== null) continue
        const rawVal = safeGetItem(rawSession, legacyKey)
        if (rawVal !== null) writeProfileSession(targetKey, rawVal, targetOpts)
      }
    }
    const legacyLocale = normalizeLegacyLocaleToken(safeGetItem(rawLocal, 'ca_locale_pref'))
    const serverLocale = normalizeLegacyLocaleToken(state?.config?.locale)
    if (legacyLocale && serverLocale && legacyLocale === serverLocale && readProfileLocal('localePref', targetOpts) === null) {
      writeProfileLocal('localePref', legacyLocale, targetOpts)
    }
  }
  return true
}

/**
 * Serializes legacy migration across concurrent same-origin contexts using Web Locks.
 * Skips migration when cross-tab Web Locks are unavailable so concurrent tabs cannot double-claim.
 */
export function migrateLegacyStorageLocked(state, opts = {}) {
  const explicitProfileKey = typeof opts?.profileKey === 'string' ? opts.profileKey.trim() : ''
  const ctxSnap = explicitProfileKey ? null : captureProfileContext()
  const locks = typeof globalThis !== 'undefined' ? globalThis.navigator?.locks : null
  if (!locks || typeof locks.request !== 'function') {
    return Promise.resolve(false)
  }
  const runTask = () => {
    if (ctxSnap && !isProfileContextCurrent(ctxSnap)) return false
    return locks.request('niuma.legacyMigration', { mode: 'exclusive' }, () => (
      (!ctxSnap || isProfileContextCurrent(ctxSnap)) ? migrateLegacyStorageForProfile(state, opts) : false
    )).catch(() => false)
  }
  const queued = migrationQueue.then(runTask, runTask)
  migrationQueue = queued.then(() => {}, () => {})
  return queued
}

/**
 * Overrides browser storage adapters in unit tests.
 */
export function setStorageAdaptersForTests({ local, session } = {}) {
  if (local !== undefined) overrideLocalStorage = local
  if (session !== undefined) overrideSessionStorage = session
}

/**
 * Resets active profile scope, generation counter, migration cache, and test adapters.
 */
export function resetProfileStorageForTests() {
  const prev = activeProfileKey
  activeProfileKey = ''
  profileGeneration += 1
  migratedProfiles.clear()
  overrideLocalStorage = undefined
  overrideSessionStorage = undefined
  const event = { changed: true, prev, next: '', profileKey: '', generation: profileGeneration }
  for (const fn of profileListeners) {
    try { fn(event) } catch {}
  }
}
