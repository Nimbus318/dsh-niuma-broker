import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild, transform as esbuildTransform } from 'esbuild'
import { apply } from '../src/host.mjs'
import { createFetchHarness } from './_fetch-harness.mjs'
import {
  activateProfileScope,
  captureProfileContext,
  checkProfileMismatch,
  clearProfileLocalPrefix,
  getActiveProfileKey,
  isProfileContextCurrent,
  listProfileLocalKeys,
  listProfileSessionKeys,
  migrateLegacyStorageForProfile,
  migrateLegacyStorageLocked,
  profileRequestHeaders,
  readProfileLocal,
  readProfileSession,
  removeProfileLocal,
  resetProfileStorageForTests,
  setStorageAdaptersForTests,
  subscribeProfileMismatch,
  writeProfileLocal,
  writeProfileSession,
} from '../client/profile-storage.js'
import {
  getComposerState,
  getDraft,
  getResumeChatState,
  hasAnyResumeChatStreaming,
  hasRunningComposer,
  invalidateDraftsBySource,
  registerResumeChatCallbacks,
  resetDraftStoreForTests,
  resetResumeChatStore,
  runComposerTask,
  setDraft,
  setResumeChatState,
  startResumeChatStream,
} from '../client/draft-store.js'

const i18nBundle = await esbuild({
  entryPoints: [fileURLToPath(new URL('../client/i18n.jsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'transform',
  plugins: [{
    name: 'i18n-test-shims',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'shim' }))
      build.onResolve({ filter: /^\.\/profile-storage\.js$/ }, () => ({
        path: pathToFileURL(fileURLToPath(new URL('../client/profile-storage.js', import.meta.url))).href,
        external: true,
      }))
      build.onResolve({ filter: /^\.\.\/src\/i18n\/index\.mjs$/ }, () => ({
        path: pathToFileURL(fileURLToPath(new URL('../src/i18n/index.mjs', import.meta.url))).href,
        external: true,
      }))
      build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        contents: [
          'export const createContext = () => ({ Provider: () => null });',
          'export const useContext = () => ({});',
          'export const useEffect = () => {};',
          'export const useState = init => [typeof init === "function" ? init() : init, () => {}];',
          'export const createElement = () => null;',
          'export const Fragment = Symbol("Fragment");',
          'export default { createContext, useContext, useEffect, useState, createElement, Fragment };',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }],
})

const {
  getActiveLocale,
  getLocalePreference,
  setActiveHostLocale,
  setActiveLocalePreference,
} = await import(
  `data:text/javascript;base64,${Buffer.from(i18nBundle.outputFiles[0].text, 'utf8').toString('base64')}`
)

function createMemoryStorage() {
  const backing = new Map()
  return {
    backing,
    get length() { return backing.size },
    key: idx => Array.from(backing.keys())[idx] ?? null,
    getItem: key => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, val) => { backing.set(key, String(val)) },
    removeItem: key => { backing.delete(key) },
    clear: () => { backing.clear() },
  }
}

function installIsolatedStorages(t) {
  const local = createMemoryStorage()
  const session = createMemoryStorage()
  resetProfileStorageForTests()
  resetDraftStoreForTests()
  setStorageAdaptersForTests({ local, session })
  setActiveHostLocale('zh')
  setActiveLocalePreference('auto', { persist: false })
  t.after(() => {
    resetDraftStoreForTests()
    resetProfileStorageForTests()
    setActiveLocalePreference('auto', { persist: false })
  })
  return { local, session }
}

test('isolates localStorage, sessionStorage, draft-store, and localePref across profiles A -> B -> A', t => {
  const { local, session } = installIsolatedStorages(t)

  activateProfileScope('profileA0001')
  assert.equal(getActiveProfileKey(), 'profileA0001')

  setDraft('debrief:greenhouse:acme:123:text', 'Profile A debrief draft')
  setDraft('add-job', { company: 'Acme', title: 'Systems', location: '', url: '', jd: '' })
  writeProfileLocal('resumeDraft.res-1', JSON.stringify({ baseText: 'Base A', text: 'Draft A' }))
  writeProfileLocal('local.template', 'modern')
  writeProfileSession('insightBriefCollapsed', 'true')
  setActiveLocalePreference('en')
  setResumeChatState('res-1', () => ({
    messages: [{ id: 'a1', role: 'assistant', content: 'Chat A reply' }],
    streaming: false,
    pendingEffects: [],
  }))

  // Switch to Profile B: zero reads leak from A
  activateProfileScope('profileB0002')
  assert.equal(getActiveProfileKey(), 'profileB0002')
  assert.equal(getDraft('debrief:greenhouse:acme:123:text'), '')
  assert.deepEqual(getDraft('add-job', null), null)
  assert.equal(readProfileLocal('resumeDraft.res-1'), null)
  assert.equal(readProfileLocal('local.template'), null)
  assert.equal(readProfileSession('insightBriefCollapsed'), null)
  assert.equal(getLocalePreference(), 'auto')
  assert.equal(getResumeChatState('res-1').messages.length, 0)

  // Write Profile B data under the exact same entity IDs
  setDraft('debrief:greenhouse:acme:123:text', 'Profile B debrief draft')
  setDraft('add-job', { company: 'Beta', title: 'Platform', location: '', url: '', jd: '' })
  writeProfileLocal('resumeDraft.res-1', JSON.stringify({ baseText: 'Base B', text: 'Draft B' }))
  writeProfileLocal('local.template', 'classic')
  writeProfileSession('insightBriefCollapsed', 'false')
  setActiveLocalePreference('zh')
  setResumeChatState('res-1', () => ({
    messages: [{ id: 'b1', role: 'assistant', content: 'Chat B reply' }],
    streaming: false,
    pendingEffects: [],
  }))

  // Switch back to Profile A: A's state and storage remain intact and isolated from B
  activateProfileScope('profileA0001')
  assert.equal(getDraft('debrief:greenhouse:acme:123:text'), 'Profile A debrief draft')
  assert.equal(getDraft('add-job').company, 'Acme')
  assert.equal(JSON.parse(readProfileLocal('resumeDraft.res-1')).text, 'Draft A')
  assert.equal(readProfileLocal('local.template'), 'modern')
  assert.equal(readProfileSession('insightBriefCollapsed'), 'true')
  assert.equal(getLocalePreference(), 'en')
  assert.equal(getActiveLocale(), 'en')
  assert.equal(getResumeChatState('res-1').messages[0]?.content, 'Chat A reply')

  // Verify backing keys are strictly namespaced per profile
  assert.equal(local.backing.get('niuma.p.profileB0002.local.template'), 'classic')
  assert.equal(local.backing.get('niuma.p.profileB0002.localePref'), 'zh')
  assert.equal(JSON.parse(session.backing.get('niuma.p.profileB0002.draft.v1:debrief:greenhouse:acme:123:text')), 'Profile B debrief draft')
})

test('drops late async runComposerTask and startResumeChatStream results after profile switch', async t => {
  const { session } = installIsolatedStorages(t)

  activateProfileScope('profileA0001')
  const ctxA = captureProfileContext()
  assert.equal(isProfileContextCurrent(ctxA), true)

  const deferredComposer = Promise.withResolvers()
  const composerPromise = runComposerTask('jobs', {
    label: 'Filtering in A...',
    nextText: 'Find infra roles',
    runnerFn: () => deferredComposer.promise,
  })
  assert.equal(hasRunningComposer('jobs'), true)

  const encoder = new TextEncoder()
  let streamController = null
  let capturedProfileHeader = null
  const callbacksB = []
  const callbacksRefA = { current: { resumeId: 'res-1', onStageProposal: p => callbacksB.push(p) } }

  const chatPromise = startResumeChatStream({
    fetchImpl: async (_url, opts) => {
      capturedProfileHeader = new Headers(opts?.headers).get('x-career-profile-key')
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            streamController = controller
          },
        }),
      }
    },
    resumeId: 'res-1',
    baseVersion: 'v1',
    requestId: 'req-A',
    requestBody: { message: 'Tighten summary' },
    userMsg: { id: 'u-A', role: 'user', content: 'Tighten summary' },
    assistantMsg: { id: 'a-A', role: 'assistant', content: '', beforeMarkdown: '# Base A', streaming: true, status: 'Thinking...' },
    trimmedInput: 'Tighten summary',
    callbacksRef: callbacksRefA,
    labels: { sourceChatLabel: 'Chat edit' },
  })

  await Promise.resolve()
  assert.equal(capturedProfileHeader, 'profileA0001')
  assert.equal(hasAnyResumeChatStreaming(), true)

  // Switch to Profile B while both async tasks from A are still pending
  activateProfileScope('profileB0002')
  assert.equal(isProfileContextCurrent(ctxA), false)
  assert.equal(hasRunningComposer('jobs'), false)
  assert.equal(hasAnyResumeChatStreaming(), false)

  const unregisterB = registerResumeChatCallbacks('res-1', {
    resumeId: 'res-1',
    onStageProposal: p => callbacksB.push(p),
    onApplyDirect: p => callbacksB.push(p),
  })

  // Resolve A's composer task and finish A's stream late
  deferredComposer.resolve({
    ok: true,
    result: {
      ephemeral: true,
      kind: 'filter',
      summary: 'Stale A filter result',
      data: { label: 'Stale A', opportunityIds: ['job-A'], reasons: { 'job-A': 'match' } },
    },
  })

  if (streamController) {
    try {
      streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'text', delta: 'Leaked A delta' })}\n`))
      streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'resume-update', markdown: '# Leaked A', changes: [] })}\n`))
      streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`))
      streamController.close()
    } catch {}
  }

  await Promise.allSettled([composerPromise, chatPromise])
  unregisterB()

  // Profile B sees zero leaked composer results, zero callbacks, zero chat messages, zero session writes
  assert.equal(hasRunningComposer('jobs'), false)
  assert.equal(getComposerState('jobs').assistantReply, null)
  assert.equal(getComposerState('jobs').history.length, 0)
  assert.deepEqual(callbacksB, [])
  assert.equal(getResumeChatState('res-1').messages.length, 0)
  assert.equal(listProfileSessionKeys('', { profileKey: 'profileB0002' }).length, 0)
  assert.equal(session.backing.has('niuma.p.profileB0002.resumeChat.v2:res-1'), false)
})

test('rejects cross-profile POST mutations with HTTP 409 PROFILE_MISMATCH without mutating disk state', async t => {
  const dirB = await mkdtemp(join(tmpdir(), 'niuma-pr2-host-'))
  const harness = createFetchHarness()
  let dispose
  const ctx = {
    profileContext: { dir: dirB },
    connection: harness.connection,
    sessionQuery: {
      listSessions: async () => [],
      readSession: async () => { throw new Error('missing') },
    },
    llm: { listProviders: () => [], async *stream() {} },
    get: () => undefined,
    on() {},
    emit() {},
    provide() {},
    effect(fn) { dispose = fn() },
  }
  await apply(ctx)
  t.after(async () => {
    await dispose()
    await rm(dirB, { recursive: true, force: true })
  })

  const stateRes = await harness.call('GET', '/api/career-agent/state')
  assert.equal(stateRes.status, 200)
  const pkB = stateRes.data?.profileKey
  assert.match(String(pkB || ''), /^[a-f0-9]{12}$/)

  const filesBefore = (await readdir(dirB)).sort()

  // Header mismatch (simulates mounted SPA from Profile A posting into switched Profile B host)
  const headerMismatch = await harness.call(
    'POST',
    '/api/career-agent/action',
    { action: 'session-scope', projects: ['workspace:unknown'] },
    { 'x-career-profile-key': 'aaaaaaaaaaaa' },
  )
  assert.equal(headerMismatch.status, 409)
  assert.equal(headerMismatch.data?.code, 'PROFILE_MISMATCH')

  // Non-state GET endpoints (e.g., workspaces) also reject mismatched profile headers, while /state stays reachable
  const wsMismatch = await harness.call('GET', '/api/career-agent/workspaces', null, { 'x-career-profile-key': 'aaaaaaaaaaaa' })
  assert.equal(wsMismatch.status, 409)
  assert.equal(wsMismatch.data?.code, 'PROFILE_MISMATCH')
  const stateWithOldHeader = await harness.call('GET', '/api/career-agent/state', null, { 'x-career-profile-key': 'aaaaaaaaaaaa' })
  assert.equal(stateWithOldHeader.status, 200)
  assert.equal(stateWithOldHeader.data?.profileKey, pkB)

  // Body mismatch (simulates unmount navigator.sendBeacon/keepalive payload carrying stale profileKey)
  const bodyMismatch = await harness.call(
    'POST',
    '/api/career-agent/action',
    { action: 'session-scope', projects: ['workspace:unknown'], profileKey: 'bbbbbbbbbbbb' },
  )
  assert.equal(bodyMismatch.status, 409)
  assert.equal(bodyMismatch.data?.code, 'PROFILE_MISMATCH')

  const filesAfter = (await readdir(dirB)).sort()
  assert.deepEqual(filesAfter, filesBefore)

  // Matching profileKey passes the profile guard and reaches action validation
  const matchingRes = await harness.call(
    'POST',
    '/api/career-agent/action',
    { action: 'session-scope', projects: ['workspace:unknown'], profileKey: pkB },
    { 'x-career-profile-key': pkB },
  )
  assert.equal(matchingRes.status, 400)
})

test('targeted clears and forget operations in Profile B never delete Profile A or unowned legacy keys', t => {
  const { local, session } = installIsolatedStorages(t)

  // Seed legacy unowned keys
  local.setItem('niuma.resumeDraft.res-1', JSON.stringify({ baseText: 'Legacy', text: 'Legacy edit' }))
  local.setItem('niuma.local.template', 'legacy-tpl')
  session.setItem('niuma.draft.v1:debrief:job-legacy:text', 'legacy debrief')
  session.setItem('niuma.resumeChat.v2:res-1', JSON.stringify({ messages: [{ id: 'l1', role: 'user', content: 'old' }] }))

  // Populate Profile A
  activateProfileScope('profileA0001')
  writeProfileLocal('resumeDraft.res-1', JSON.stringify({ baseText: 'A', text: 'A draft' }))
  setDraft('debrief:job-A:text', 'Draft A', { sourceIds: ['src-shared'] })
  setResumeChatState('res-1', () => ({ messages: [{ id: 'a1', role: 'user', content: 'msg A' }], streaming: false, pendingEffects: [] }))

  const aLocalCountBefore = listProfileLocalKeys('', { profileKey: 'profileA0001' }).length
  const aSessionCountBefore = listProfileSessionKeys('', { profileKey: 'profileA0001' }).length
  const legacyCountBefore = Array.from(local.backing.keys()).filter(k => !k.startsWith('niuma.p.')).length
    + Array.from(session.backing.keys()).filter(k => !k.startsWith('niuma.p.')).length

  // Switch to Profile B, populate B, and clear/forget B
  activateProfileScope('profileB0002')
  writeProfileLocal('resumeDraft.res-2', JSON.stringify({ baseText: 'B', text: 'B draft' }))
  setDraft('debrief:job-B:text', 'Draft B', { sourceIds: ['src-shared'] })
  setResumeChatState('res-2', () => ({ messages: [{ id: 'b1', role: 'user', content: 'msg B' }], streaming: false, pendingEffects: [] }))

  resetResumeChatStore()
  invalidateDraftsBySource('src-shared')
  clearProfileLocalPrefix('resumeDraft.')

  assert.equal(readProfileLocal('resumeDraft.res-2'), null)
  assert.equal(getDraft('debrief:job-B:text'), '')
  assert.equal(getResumeChatState('res-2').messages.length, 0)

  // Profile A and unowned legacy keys remain completely untouched
  assert.equal(listProfileLocalKeys('', { profileKey: 'profileA0001' }).length, aLocalCountBefore)
  assert.equal(listProfileSessionKeys('', { profileKey: 'profileA0001' }).length, aSessionCountBefore)
  const legacyCountAfter = Array.from(local.backing.keys()).filter(k => !k.startsWith('niuma.p.')).length
    + Array.from(session.backing.keys()).filter(k => !k.startsWith('niuma.p.')).length
  assert.equal(legacyCountAfter, legacyCountBefore)
})

test('conservative two-track legacy migration verifies entity ownership, enforces single-owner prefs, preserves legacy keys, and resets locale when server locale is empty', t => {
  const { local, session } = installIsolatedStorages(t)

  // Track 1 + Track 2 legacy seed
  local.setItem('niuma.resumeDraft.res-match', JSON.stringify({ baseText: 'BASE_OK', text: 'EDITED_OK' }))
  local.setItem('niuma.resumeDraft.res-mismatch', JSON.stringify({ baseText: 'OLD_BASE', text: 'STALE_EDIT' }))
  local.setItem('niuma.resumeDraft.res-unknown', JSON.stringify({ baseText: 'ANY', text: 'OTHER_EDIT' }))
  local.setItem('niuma.versionAppearance.res-match', JSON.stringify({ template: 'modern' }))
  local.setItem('niuma.versionAppearance.res-unknown', JSON.stringify({ template: 'minimal' }))
  local.setItem('niuma.selectedResumeId', 'res-match')
  local.setItem('niuma.local.template', 'executive')
  local.setItem('ca_locale_pref', 'en')

  session.setItem('niuma.resumeChat.v2:res-match', JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'Hi' }] }))
  session.setItem('niuma.resumeChat.v2:default', JSON.stringify({ messages: [{ id: 'd1', role: 'user', content: 'Default' }] }))
  session.setItem('niuma.resumeChat.v2:res-unknown', JSON.stringify({ messages: [{ id: 'u1', role: 'user', content: 'Unknown' }] }))
  session.setItem('niuma.draft.v1:add-job', JSON.stringify({ company: 'LegacyCo' }))
  session.setItem('niuma.activeTab', 'resumes')

  activateProfileScope('profileA0001')
  const migratedA = migrateLegacyStorageForProfile(
    {
      config: { locale: 'en' },
      resumes: [
        { id: 'res-match', text: 'BASE_OK' },
        { id: 'res-mismatch', text: 'NEW_BASE' },
      ],
    },
    { resolveResumeBaseText: r => r.text },
  )
  assert.equal(migratedA, true)

  // Entity ownership verified copies
  assert.equal(JSON.parse(readProfileLocal('resumeDraft.res-match')).text, 'EDITED_OK')
  assert.equal(readProfileLocal('resumeDraft.res-mismatch'), null)
  assert.equal(readProfileLocal('resumeDraft.res-unknown'), null)
  assert.equal(JSON.parse(readProfileLocal('versionAppearance.res-match')).template, 'modern')
  assert.equal(readProfileLocal('versionAppearance.res-unknown'), null)
  assert.equal(readProfileLocal('selectedResumeId'), 'res-match')
  assert.ok(readProfileSession('resumeChat.v2:res-match'))
  assert.equal(readProfileSession('resumeChat.v2:default'), null)
  assert.equal(readProfileSession('resumeChat.v2:res-unknown'), null)
  assert.equal(readProfileSession('draft.v1:add-job'), null)

  // Single-owner preferences claimed by A
  assert.equal(local.getItem('niuma.legacyOwner'), 'profileA0001')
  assert.equal(readProfileLocal('local.template'), 'executive')
  assert.equal(readProfileLocal('localePref'), 'en')
  assert.equal(readProfileSession('activeTab'), 'resumes')

  // Legacy keys are NEVER deleted
  assert.equal(local.getItem('niuma.local.template'), 'executive')
  assert.equal(session.getItem('niuma.draft.v1:add-job'), JSON.stringify({ company: 'LegacyCo' }))

  // Cloned profile B sharing same resume ID + baseText NEVER receives A's already-claimed legacy draft/chat,
  // and simulated reload never re-imports cleared scoped data.
  setActiveLocalePreference('en')
  activateProfileScope('profileB0002')
  migrateLegacyStorageForProfile(
    { config: { locale: '' }, resumes: [{ id: 'res-match', text: 'BASE_OK' }] },
    { resolveResumeBaseText: r => r.text },
  )
  assert.equal(readProfileLocal('resumeDraft.res-match'), null)
  assert.equal(readProfileSession('resumeChat.v2:res-match'), null)
  assert.equal(readProfileLocal('versionAppearance.res-match'), null)
  assert.equal(readProfileLocal('local.template'), null)
  assert.equal(readProfileSession('activeTab'), null)
  assert.equal(readProfileLocal('localePref'), null)

  // Returning to A, clearing its scoped copies, and simulating a full page reload must NOT re-import legacy data
  activateProfileScope('profileA0001')
  removeProfileLocal('resumeDraft.res-match')
  resetProfileStorageForTests()
  setStorageAdaptersForTests({ local, session })
  activateProfileScope('profileA0001')
  const secondRunA = migrateLegacyStorageForProfile(
    { config: { locale: 'en' }, resumes: [{ id: 'res-match', text: 'BASE_OK' }] },
    { resolveResumeBaseText: r => r.text },
  )
  assert.equal(secondRunA, false)
  assert.equal(readProfileLocal('resumeDraft.res-match'), null)

  activateProfileScope('profileB0002')
  setActiveLocalePreference('auto', { persist: false })
  assert.equal(getLocalePreference(), 'auto')
  assert.equal(readProfileLocal('localePref'), null)

  // Returning to Profile A preserves A's 'en' preference
  activateProfileScope('profileA0001')
  assert.equal(getLocalePreference(), 'en')
})

test('profileRequestHeaders and checkProfileMismatch attach active keys and emit mismatch events', t => {
  installIsolatedStorages(t)
  activateProfileScope('profileHdr01')
  const headers = profileRequestHeaders({ 'x-career-locale': 'en' })
  assert.equal(headers['x-career-agent'], '1')
  assert.equal(headers['x-career-profile-key'], 'profileHdr01')
  assert.equal(headers['x-career-locale'], 'en')

  const received = []
  const unsubscribe = subscribeProfileMismatch(detail => received.push(detail))
  assert.equal(checkProfileMismatch({ status: 400 }, { code: 'BAD_INPUT' }), false)
  assert.equal(checkProfileMismatch({ status: 409 }, { code: 'PROFILE_MISMATCH', error: 'switched' }), true)
  assert.equal(received.length, 1)
  unsubscribe()
  assert.equal(checkProfileMismatch({ status: 409 }, { code: 'PROFILE_MISMATCH' }), true)
  assert.equal(received.length, 1)
})

test('migrateLegacyStorageForProfile fails closed when legacyClaimed or legacyMigrated persistence fails', t => {
  const { local, session } = installIsolatedStorages(t)
  local.setItem('niuma.resumeDraft.res-fail', JSON.stringify({ baseText: 'BASE', text: 'PRIVATE_EDIT' }))
  session.setItem('niuma.resumeChat.v2:res-fail', JSON.stringify({ messages: [{ id: '1', role: 'user', content: 'hi' }] }))

  const rawSet = local.setItem.bind(local)
  // Block legacyMigrated.v1 writes -> entire migration refuses to copy
  local.setItem = (k, v) => {
    if (String(k).endsWith('.legacyMigrated.v1')) throw new Error('QuotaExceededError')
    rawSet(k, v)
  }
  activateProfileScope('profileFail01')
  assert.equal(migrateLegacyStorageForProfile({ resumes: [{ id: 'res-fail', text: 'BASE' }], config: { locale: 'zh' } }), false)
  assert.equal(readProfileLocal('resumeDraft.res-fail'), null)
  assert.equal(readProfileSession('resumeChat.v2:res-fail'), null)

  // Allow legacyMigrated.v1, block niuma.legacyClaim.* writes -> Track 1 refuses to copy without ownership record
  resetProfileStorageForTests()
  setStorageAdaptersForTests({ local, session })
  local.setItem = (k, v) => {
    if (String(k).startsWith('niuma.legacyClaim.')) throw new Error('QuotaExceededError')
    rawSet(k, v)
  }
  activateProfileScope('profileFail02')
  assert.equal(migrateLegacyStorageForProfile({ resumes: [{ id: 'res-fail', text: 'BASE' }], config: { locale: 'zh' } }), true)
  assert.equal(readProfileLocal('resumeDraft.res-fail'), null)
  assert.equal(readProfileSession('resumeChat.v2:res-fail'), null)
})

test('migrateLegacyStorageLocked serializes concurrent contexts with Web Locks and skips cleanly without locks', async t => {
  const { local } = installIsolatedStorages(t)
  local.setItem('niuma.resumeDraft.res-race', JSON.stringify({ baseText: 'SHARED', text: 'RACED_EDIT' }))

  const state = { resumes: [{ id: 'res-race', text: 'SHARED' }], config: { locale: 'zh' } }
  // Without Web Locks, locked migration fails closed and skips sensitive migration
  activateProfileScope('profileNoLock')
  const unlockedResult = await migrateLegacyStorageLocked(state)
  assert.equal(unlockedResult, false)
  assert.equal(readProfileLocal('resumeDraft.res-race'), null)

  // With Web Locks present, exclusive lock prevents double-copy even across concurrent contexts
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let lockQueue = Promise.resolve()
  const mockLocks = {
    request(_name, _opts, fn) {
      const next = lockQueue.then(() => fn())
      lockQueue = next.then(() => {}, () => {})
      return next
    },
  }
  Object.defineProperty(globalThis, 'navigator', { value: { locks: mockLocks }, configurable: true })
  t.after(() => {
    if (prevNavigatorDesc) Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc)
    else delete globalThis.navigator
  })

  activateProfileScope('profileRaceA')
  const aResult = await migrateLegacyStorageLocked(state)
  // Explicit profileKey option migrates into B while activeProfileKey remains A until activateProfileScope('B') runs
  const bResult = await migrateLegacyStorageLocked(state, { profileKey: 'profileRaceB' })
  assert.equal(aResult, true)
  assert.equal(bResult, true)
  assert.equal(getActiveProfileKey(), 'profileRaceA')

  const inA = readProfileLocal('resumeDraft.res-race', { profileKey: 'profileRaceA' })
  const inB = readProfileLocal('resumeDraft.res-race', { profileKey: 'profileRaceB' })
  assert.ok(inA)
  assert.equal(inB, null)

  // Explicit profileKey works into unclaimed targets without mutating activeProfileKey
  local.setItem('niuma.resumeDraft.res-target', JSON.stringify({ baseText: 'TBASE', text: 'TEDIT' }))
  const targetMigrated = await migrateLegacyStorageLocked(
    { resumes: [{ id: 'res-target', text: 'TBASE' }], config: { locale: 'zh' } },
    { profileKey: 'profileExplicitB' },
  )
  assert.equal(targetMigrated, true)
  assert.equal(getActiveProfileKey(), 'profileRaceA')
  assert.ok(readProfileLocal('resumeDraft.res-target', { profileKey: 'profileExplicitB' }))
  assert.equal(readProfileLocal('resumeDraft.res-target', { profileKey: 'profileRaceA' }), null)
})

test('storage adapter failures degrade gracefully without uncaught exceptions', t => {
  const throwingStorage = {
    get length() { throw new Error('SecurityError') },
    key() { throw new Error('SecurityError') },
    getItem() { throw new Error('SecurityError') },
    setItem() { throw new Error('QuotaExceededError') },
    removeItem() { throw new Error('SecurityError') },
  }
  resetProfileStorageForTests()
  resetDraftStoreForTests()
  setStorageAdaptersForTests({ local: throwingStorage, session: throwingStorage })
  t.after(() => {
    resetDraftStoreForTests()
    resetProfileStorageForTests()
  })

  assert.doesNotThrow(() => {
    activateProfileScope('profileErr01')
    writeProfileLocal('local.template', 'modern')
    assert.equal(readProfileLocal('local.template'), null)
    removeProfileLocal('local.template')
    assert.deepEqual(listProfileLocalKeys(''), [])
    clearProfileLocalPrefix('resumeDraft.')
    migrateLegacyStorageForProfile({ resumes: [{ id: 'r1', text: 'hi' }], config: { locale: 'zh' } })
    setDraft('debrief:job-1:text', 'still works in memory')
    assert.equal(getDraft('debrief:job-1:text'), 'still works in memory')
    setActiveLocalePreference('en')
  })
})

test('static guard: zero raw localStorage or sessionStorage references remain in client/ outside profile-storage.js', async () => {
  const clientDir = resolve(process.cwd(), 'client')
  const files = (await readdir(clientDir))
    .filter(name => (name.endsWith('.js') || name.endsWith('.jsx')) && name !== 'profile-storage.js')
    .sort()

  const violations = []
  for (const name of files) {
    const raw = await readFile(join(clientDir, name), 'utf8')
    const { code } = await esbuildTransform(raw, {
      loader: name.endsWith('.jsx') ? 'jsx' : 'js',
      legalComments: 'none',
    })
    if (/\b(?:localStorage|sessionStorage)\b/.test(code)) {
      violations.push(name)
    }
  }
  assert.deepEqual(violations, [], `Found raw browser storage access in: ${violations.join(', ')}`)
})
