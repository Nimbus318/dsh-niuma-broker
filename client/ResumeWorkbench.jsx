import React from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiTraceCard, useTrackedOperation } from './AiActivity.jsx'
import { resolveDefaultModelRow, useModels } from './Composer.jsx'
import LocalTemplatePaper from './LocalTemplatePaper.jsx'
import { LocalRichEditor, requiresMarkdownSource, resolveRichEditorLine } from './LocalRichEditor.jsx'
import ResumeLines from './ResumeLines.jsx'
import { ModelSelectMenu, ReasoningEffortMenu } from './Sources.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import { getActiveLocale, useI18n } from './i18n.jsx'
import {
  clearProfileLocalPrefix,
  getActiveProfileKey,
  getProfileGeneration,
  isProfileContextCurrent,
  readProfileLocal,
  removeProfileLocal,
  writeProfileLocal,
} from './profile-storage.js'
import { migrateResumeChatScope } from './draft-hooks.jsx'
import { SideSheet } from './Motion.jsx'
import { AgentTailorBanner, FloatingResumeCommandBar, useResumeAgent } from './ResumeAgent.jsx'
import { buildResumePlayback, ResumePlaybackControls, ResumePlaybackCursor, useResumePlayback } from './ResumePlayback.jsx'
import ResumeGraphModal from './ResumeGraphModal.jsx'
import VersionMenu from './ResumeVersionMenu.jsx'
import { Evidence, Icon, LibrarySheet, ResumeForm } from './ResumeLibrary.jsx'
import { API_BASE as BASE, displayResume, list, readableDate, sourceLabel, stripBulletPrefix, stripMarkdownInline } from './shared.js'
import { applyResumeConversation, applyTailoredSelection } from '../src/resume-apply.mjs'
import {
  applyReviewDecisions, attachStagedReviewProvenance, buildUnifiedPlaybackSteps, computeReviewableLineChanges,
  rebaseReviewDecisions, resolveAcceptedReviewEvidenceIds, suggestEvidencePlacement,
} from '../src/resume-diff.mjs'
import { normalizeResumeStyle } from '../src/resume-style.mjs'
import { isArchivedResume, organizeResumeVersions } from '../src/resume-versions.mjs'

function computeSpanDelta(before, after) {
  if (before === after) return { changed: false }
  let start = 0
  const minLen = Math.min(before.length, after.length)
  while (start < minLen && before[start] === after[start]) start += 1
  let end = 0
  while (end < minLen - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1
  const removed = before.slice(start, before.length - end)
  const added = after.slice(start, after.length - end)
  const localized = (start + end) >= Math.max(4, Math.floor(after.length * 0.3))
  return { changed: true, start, end, removed, added, localized }
}

function EditorialDiff({ source, text, kept, rank, promoted }) {
  const { t } = useI18n()
  const before = stripMarkdownInline(stripBulletPrefix(source))
  const after = stripMarkdownInline(stripBulletPrefix(text))
  const delta = React.useMemo(() => computeSpanDelta(before, after), [before, after])

  if (!kept) {
    return <div className="ca-ed-card is-rejected">
      <p className="ca-ed-main">{before}</p>
      <span className="ca-ed-note">{t('resume.keptOriginalNote')}</span>
    </div>
  }

  if (!delta.changed) {
    return <div className="ca-ed-card">
      <p className="ca-ed-main">{after}</p>
      {promoted && <span className="ca-ed-note">{t('resume.promotedOnlyNote', { rank })}</span>}
    </div>
  }

  const head = after.slice(0, delta.start)
  const tail = delta.end > 0 ? after.slice(after.length - delta.end) : ''
  const compactOld = delta.localized && delta.removed && delta.removed.length <= 18

  return <div className="ca-ed-card">
    <p className="ca-ed-main">
      {delta.localized && delta.added ? (
        <>{head}<mark className="ca-ed-mark">{delta.added}</mark>{tail}</>
      ) : after}
    </p>
    {compactOld ? (
      <span className="ca-ed-note">{t('resume.originalDeltaNote', { removed: delta.removed, added: delta.added || t('resume.trimmed') })}</span>
    ) : (
      <p className="ca-ed-origin">
        <span>{t('resume.originalLine')}</span>
        <span>{before}</span>
      </p>
    )}
  </div>
}

function parseGapChips(raw = '') {
  const clean = String(raw || '').trim()
  if (!clean) return { lead: '', chips: [] }
  // Split intro before "需确认：" / "缺少证据：" / "如下：" if followed by semicolon/newline list
  let lead = ''
  let body = clean
  const colonMatch = /^(.{6,90}?[：:])\s*([\s\S]+)$/.exec(clean)
  if (colonMatch && /[;；\n]/.test(colonMatch[2])) {
    lead = colonMatch[1].replace(/[：:]\s*$/, '')
    body = colonMatch[2]
  }
  const parts = body
    .split(/[;；\n]+/u)
    .map(s => s.replace(/^[\s•·\-–—\d.、]+|[。；;.\s]+$/gu, '').trim())
    .filter(Boolean)
  if (parts.length <= 1) return { lead: '', chips: [], prose: clean }
  return { lead, chips: parts, prose: '' }
}

function GapsPanel({ gaps, onPickGap }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = React.useState(false)
  const parsed = React.useMemo(() => parseGapChips(gaps), [gaps])
  if (!gaps) return null
  const limit = 6
  const visible = expanded ? parsed.chips : parsed.chips.slice(0, limit)
  const hiddenCount = Math.max(0, parsed.chips.length - visible.length)

  return <div className="ca-gaps-panel">
    <div className="ca-gaps-head">
      <div className="ca-inline">
        <strong>{t('resume.gapsTitle')}</strong>
        {parsed.chips.length > 0 && <span className="ca-gaps-count">{t('common.countItems', { count: parsed.chips.length })}</span>}
      </div>
      {onPickGap && <button type="button" className="ca-text-button" onClick={() => onPickGap(t('resume.askAiGapsPrompt'))}>{t('resume.askAiGaps')}</button>}
    </div>
    {parsed.lead && <p className="ca-gaps-lead">{parsed.lead}</p>}
    {parsed.chips.length > 0 ? <>
      <div className="ca-gaps-chips">
        {visible.map((chip, idx) => (
          <button key={idx} type="button" className="ca-gap-chip" title={t('resume.gapChipTitle')}
            onClick={() => onPickGap?.(t('resume.gapChipSeed', { chip }))}>
            <span className="ca-gap-plus" aria-hidden="true">+</span>
            <span>{chip}</span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button type="button" className="ca-gap-chip is-more" onClick={() => setExpanded(true)}>
            {t('resume.expandMoreGaps', { count: hiddenCount })}
          </button>
        )}
        {expanded && parsed.chips.length > limit && (
          <button type="button" className="ca-gap-chip is-more" onClick={() => setExpanded(false)}>{t('common.collapse')}</button>
        )}
      </div>
      <p className="ca-gaps-tip">{t('resume.gapsTip')}</p>
    </> : <p className="ca-gaps-prose">{parsed.prose}</p>}
  </div>
}

function readSavedStyle() {
  try {
    const raw = readProfileLocal('local.style')
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const DRAFT_STORAGE_PREFIX = 'resumeDraft.'
const VERSION_APPEARANCE_PREFIX = 'versionAppearance.'
const SELECTED_RESUME_KEY = 'selectedResumeId'
const ACTIVE_TAB_KEY = 'activeTab'

function readVersionAppearance(item) {
  const serverApp = item?.appearance && typeof item.appearance === 'object' ? item.appearance : null
  let localApp = null
  if (item?.id) {
    try {
      const raw = readProfileLocal(VERSION_APPEARANCE_PREFIX + item.id)
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) localApp = parsed
    } catch {}
  }
  const template = serverApp?.template
    || localApp?.template
    || readProfileLocal('local.template')
    || 'onyx'
  const style = (serverApp?.style && typeof serverApp.style === 'object')
    ? serverApp.style
    : (localApp?.style && typeof localApp.style === 'object')
      ? localApp.style
      : readSavedStyle()
  return { template, style }
}

function writeVersionAppearance(id, template, style, opts) {
  try {
    if (template) writeProfileLocal('local.template', template, opts)
    if (style && typeof style === 'object') {
      if (Object.keys(style).length) writeProfileLocal('local.style', JSON.stringify(style), opts)
      else removeProfileLocal('local.style', opts)
    }
    if (id) {
      writeProfileLocal(VERSION_APPEARANCE_PREFIX + id, JSON.stringify({
        ...(template ? { template } : {}),
        ...(style && typeof style === 'object' ? { style } : {}),
      }), opts)
    }
  } catch {}
}

function buildStarterMarkdown({ name, role, highlights, skills, locale }) {
  const isEn = locale === 'en'
  const cleanName = String(name || '').trim() || (isEn ? 'My Resume' : '个人简历')
  const cleanRole = String(role || '').trim()
  const rawLines = String(highlights || '').replace(/\r\n?/gu, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  const bullets = rawLines.length
    ? rawLines.map(l => /^[-*+•]\s+/u.test(l) ? `- ${l.replace(/^[-*+•]\s+/u, '')}` : `- ${l}`)
    : [isEn ? '- Key project and delivery highlight (click to edit or ask AI to refine).' : '- 在此补充一段核心项目与量化成果（可直接编辑，或在下方与 AI 对话润色）。']
  const cleanSkills = String(skills || '').trim()
  const parts = [`# ${cleanName}`]
  if (cleanRole) parts.push(`_${cleanRole}_`)
  parts.push('')
  parts.push(isEn ? '## Experience & Projects' : '## 核心工作与项目经历')
  if (cleanRole) parts.push(`### ${cleanRole}`)
  parts.push(...bullets)
  if (cleanSkills) {
    parts.push('')
    parts.push(isEn ? '## Core Skills' : '## 核心技能')
    parts.push(`- ${cleanSkills}`)
  }
  return `${parts.join('\n')}\n`
}

function buildBlankResumeMarkdown(locale) {
  if (locale === 'en') {
    return '# Your Name\n_Target Role · City · Email_\n\n## Summary\n\n## Experience\n\n## Projects\n\n## Education\n\n## Skills\n'
  }
  return '# 你的姓名\n_求职方向 · 城市 · 联系方式_\n\n## 个人简介\n\n## 工作经历\n\n## 项目经历\n\n## 教育背景\n\n## 核心技能\n'
}

const ROLE_WORD_RE = /(?:engineer|infra|ai|ml|product|manager|design|stack|backend|frontend|data|ops|后端|前端|全栈|算法|产品|架构|开发|经理|运营|设计|工程|平台)/iu

function parseIdentityInput(raw) {
  const clean = String(raw || '').trim()
  if (!clean) return { name: '', role: '' }
  const parts = clean.split(/[，,\n]+/u).map(s => s.trim()).filter(Boolean)
  if (parts.length >= 2 && parts[0].length <= 16 && !ROLE_WORD_RE.test(parts[0])) {
    return { name: parts[0].slice(0, 60), role: parts.slice(1).join(' · ').slice(0, 120) }
  }
  return { name: '', role: clean.slice(0, 120) }
}

function readLocalDraft(id, expectedBase, opts) {
  if (!id) return null
  try {
    const raw = readProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.text === 'string' && parsed.baseText === expectedBase && parsed.text !== expectedBase) {
      return parsed.text
    }
  } catch {}
  return null
}

function writeLocalDraft(id, text, baseText, opts) {
  if (!id) return
  try {
    if (!text || text === baseText) removeProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
    else writeProfileLocal(DRAFT_STORAGE_PREFIX + id, JSON.stringify({ text, baseText, updatedAt: Date.now() }), opts)
  } catch {}
}

function clearLocalDraft(id, opts) {
  if (!id) return
  removeProfileLocal(DRAFT_STORAGE_PREFIX + id, opts)
}

function clearAllLocalDrafts(opts) {
  clearProfileLocalPrefix(DRAFT_STORAGE_PREFIX, opts)
}

function ResumeWorkbench({
  item, resumes, defaultMasterTrackId = '', profileKey = '', templates, opportunities, config, capabilities, act, silentAct, busy,
  onVersion, agent, playback, onReplay, onTriggerStagedPlayback, onEditorReady, retainedPreviewRef,
  onOpenImport, onOpenLibrary, evidenceCountTotal, pendingEvidence, unmergedCount, unmergedEvidence = [],
  hasSources, onSources, seedPrompt, onConsumeSeedPrompt,
}) {
  const { t, locale } = useI18n()
  const ownerProfileRef = React.useRef(null)
  if (!ownerProfileRef.current) {
    const pk = (typeof profileKey === 'string' && profileKey.trim()) || getActiveProfileKey()
    ownerProfileRef.current = { profileKey: pk, generation: getProfileGeneration() }
  }
  const editorOpts = React.useMemo(() => ({ profileKey: ownerProfileRef.current.profileKey }), [])
  const baseText = displayResume(item, resumes)
  const initialApp = React.useMemo(() => readVersionAppearance(item), [item.id])
  const [draftText, setDraftText] = React.useState(() => readLocalDraft(item.id, baseText) ?? baseText)
  const [saveState, setSaveState] = React.useState(() => item.autoSaved ? 'saved' : 'idle')
  const [excluded, setExcluded] = React.useState([])
  const [stagedProposal, setStagedProposal] = React.useState(null)
  const [stagedOpen, setStagedOpen] = React.useState(true)
  const [lastAppliedUndo, setLastAppliedUndo] = React.useState(null)
  const [evidenceSourcePreviews, setEvidenceSourcePreviews] = React.useState({})
  const [mobilePane, setMobilePane] = React.useState('edit')
  const [templateChoice, setTemplateChoice] = React.useState(() => initialApp.template)
  const [styleOverrides, setStyleOverrides] = React.useState(() => initialApp.style)
  const [highlightLine, setHighlightLine] = React.useState(null)
  const [syncedResumeId, setSyncedResumeId] = React.useState(item.id)
  const [pendingOpen, setPendingOpen] = React.useState(false)
  const [reviewOpen, setReviewOpen] = React.useState(
    () => (item.kind === 'tailored' && item.status === 'pending')
      || ((item.kind === 'generated' || item.origin === 'rebase') && item.status === 'pending' && Boolean(item.placements?.length || item.summary)),
  )
  const [localSeedPrompt, setLocalSeedPrompt] = React.useState('')
  const [exportState, setExportState] = React.useState({ ready: false, exporting: '' })
  const paperExportRef = React.useRef(null)
  const reviewCardRef = React.useRef(null)
  const prevIdRef = React.useRef(item.id)
  const prevBaseTextRef = React.useRef(baseText)
  const autoSaveTimerRef = React.useRef(null)
  const autoSaveSeqRef = React.useRef(0)
  const autoSavedIdsRef = React.useRef(new Set())
  const latestRef = React.useRef({
    id: item.id, draftText, baseText, editable: ['pending', 'approved'].includes(item.status),
    isAutoSavedPending: item.status === 'pending' && item.autoSaved === true, dirty: false,
  })

  const activeTemplate = templates.find(row => row.id === templateChoice) ?? templates[0] ?? null

  const persistVersionAppearance = React.useCallback((nextTpl, nextStyle) => {
    writeVersionAppearance(item.id, nextTpl, nextStyle, editorOpts)
    if (item.id && ['pending', 'approved'].includes(item.status)) {
      void silentAct?.('resume-appearance', { id: item.id, template: nextTpl, style: nextStyle })
    }
  }, [item.id, item.status, silentAct, editorOpts])

  const selectTemplate = React.useCallback(id => {
    setTemplateChoice(id)
    persistVersionAppearance(id, styleOverrides)
  }, [persistVersionAppearance, styleOverrides])

  const updateStyle = React.useCallback(patch => {
    setStyleOverrides(current => {
      const next = { ...current, ...patch }
      persistVersionAppearance(templateChoice, next)
      return next
    })
  }, [persistVersionAppearance, templateChoice])

  const resetStyle = React.useCallback(() => {
    setStyleOverrides({})
    persistVersionAppearance(templateChoice, {})
  }, [persistVersionAppearance, templateChoice])

  const applyStyleDirective = React.useCallback(directive => {
    if (directive?.targetResumeId && directive.targetResumeId !== latestRef.current.id) return
    const nextTpl = directive.templateId || templateChoice
    const nextStyle = directive.patch?.reset
      ? {}
      : (directive.patch && Object.keys(directive.patch).length > 0 ? { ...styleOverrides, ...directive.patch } : styleOverrides)
    if (directive.templateId) setTemplateChoice(nextTpl)
    if (directive.patch?.reset) setStyleOverrides({})
    else if (directive.patch && Object.keys(directive.patch).length > 0) setStyleOverrides(nextStyle)
    persistVersionAppearance(nextTpl, nextStyle)
  }, [templateChoice, styleOverrides, persistVersionAppearance])

  React.useEffect(() => {
    if (prevIdRef.current !== item.id || prevBaseTextRef.current !== baseText) {
      const switchedVersion = prevIdRef.current !== item.id
      const fromOwnAutoSave = autoSavedIdsRef.current.has(item.id)
      if (fromOwnAutoSave) autoSavedIdsRef.current.delete(item.id)
      prevIdRef.current = item.id
      prevBaseTextRef.current = baseText
      if (fromOwnAutoSave) {
        // Keep user's in-flight typing if they typed ahead while auto-save was completing.
        setDraftText(cur => cur === baseText ? baseText : cur)
      } else {
        const recovered = readLocalDraft(item.id, baseText)
        setDraftText(recovered ?? baseText)
        setSaveState(recovered ? 'saving' : (item.autoSaved ? 'saved' : 'idle'))
      }
      setExcluded([])
      if (switchedVersion && !fromOwnAutoSave) {
        setStagedProposal(null)
        setLastAppliedUndo(null)
        const nextApp = readVersionAppearance(item)
        setTemplateChoice(nextApp.template)
        setStyleOverrides(nextApp.style)
        setReviewOpen(
          (item.kind === 'tailored' && item.status === 'pending')
          || ((item.kind === 'generated' || item.origin === 'rebase') && item.status === 'pending' && Boolean(item.placements?.length || item.summary)),
        )
      }
    }
    setSyncedResumeId(item.id)
  }, [item.id, item.status, item.autoSaved, item.kind, item.origin, item.appearance, baseText])

  const editable = ['pending', 'approved'].includes(item.status)
  const locked = !!busy || playback.active
  const items = list(item.items)
  const mergePlacements = (item.kind === 'generated' || item.origin === 'rebase') ? list(item.placements) : []
  const isEmptyRebase = item.origin === 'rebase' && mergePlacements.length === 0
  const hasMergeSummary = (item.kind === 'generated' || item.origin === 'rebase') && !isEmptyRebase && (mergePlacements.length > 0 || Boolean(item.summary))
  const isReviewable = item.kind === 'tailored' && items.length > 0
  const versionTree = React.useMemo(
    () => organizeResumeVersions(resumes, { defaultMasterTrackId, opportunities }),
    [resumes, defaultMasterTrackId, opportunities],
  )
  const currentBranchRev = React.useMemo(() => {
    for (const b of versionTree.branches) {
      const hit = b.revisions.find(r => r.id === item.id)
      if (hit) return hit
    }
    return null
  }, [versionTree, item.id])
  const currentMasterBehind = Boolean(currentBranchRev?.masterBehind)
  const currentMasterHasDiff = Boolean(currentBranchRev?.masterBehind && currentBranchRev?.masterHasContentDiff !== false)
  const currentMasterInSync = Boolean(currentBranchRev?.masterBehind && currentBranchRev?.masterHasContentDiff === false)
  const canSelectChanges = isReviewable && item.status === 'pending' && draftText === baseText
  const selectedIndices = React.useMemo(
    () => items.flatMap((_, index) => excluded.includes(index) ? [] : [index]),
    [items, excluded],
  )
  const hasPartialSelection = canSelectChanges && excluded.length > 0

  const hasUnappliedStaged = Boolean(stagedProposal && !stagedProposal.applied)
  const stagedPreviewText = React.useMemo(() => {
    if (!hasUnappliedStaged) return null
    return rebaseReviewDecisions(draftText, stagedProposal.baseText, stagedProposal.items, stagedProposal.rejectedIds)
  }, [hasUnappliedStaged, draftText, stagedProposal])

  // editorText is ALWAYS the real editable draft (or animated playback frame while read-only).
  // Unapproved staged suggestions NEVER enter the editor document, localStorage, auto-save, Cmd+S, or export.
  const editorText = React.useMemo(() => {
    if (playback.active && playback.text !== undefined) return playback.text
    if (draftText !== baseText) return draftText
    if (hasPartialSelection) {
      const parent = resumes.find(row => row.id === item.baseId)
      const parentText = parent ? displayResume(parent, resumes) : ''
      if (parentText) {
        if (!selectedIndices.length) return parentText
        const chosen = selectedIndices.map(index => items[index])
        try {
          return item.variant === 'conversation'
            ? applyResumeConversation(parentText, chosen)
            : applyTailoredSelection(parentText, chosen)
        } catch { return baseText }
      }
    }
    return baseText
  }, [playback.active, playback.text, draftText, baseText, hasPartialSelection, resumes, item.baseId, item.variant, selectedIndices, items])

  // previewText drives the right-hand A4 layout preview: shows unapproved staged lines visually without persisting them.
  const previewText = React.useMemo(() => {
    if (playback.active && playback.text !== undefined) return playback.text
    if (stagedPreviewText !== null) return stagedPreviewText
    return editorText
  }, [playback.active, playback.text, stagedPreviewText, editorText])

  const dirty = editable && !playback.active && draftText !== baseText
  latestRef.current = {
    id: item.id,
    draftText,
    baseText,
    editable,
    isAutoSavedPending: item.status === 'pending' && item.autoSaved === true,
    dirty,
    profileKey: ownerProfileRef.current.profileKey,
    profileGeneration: ownerProfileRef.current.generation,
  }

  const persistDraftNow = React.useCallback(async ({ text: nextText, title, variant, evidenceIds, opportunityId } = {}) => {
    const snap = latestRef.current
    const ctxSnap = { profileKey: ownerProfileRef.current.profileKey, generation: ownerProfileRef.current.generation }
    if (!isProfileContextCurrent(ctxSnap)) return null
    const bodyText = typeof nextText === 'string' ? nextText : snap.draftText
    const forkingJob = Boolean(opportunityId && opportunityId !== item.opportunityId)
    if (!snap.editable || !bodyText?.trim() || (!forkingJob && bodyText === snap.baseText)) return null
    const seq = ++autoSaveSeqRef.current
    setSaveState('saving')
    const reply = await silentAct?.('resume-revise', {
      id: snap.id,
      text: bodyText,
      autoSaved: true,
      inPlace: !forkingJob && snap.isAutoSavedPending && !title,
      ...(Array.isArray(evidenceIds) && evidenceIds.length ? { evidenceIds } : {}),
      ...(opportunityId ? { opportunityId } : {}),
      ...(title ? { title } : {}),
      ...(variant ? { variant } : {}),
      ...(ctxSnap.profileKey ? { profileKey: ctxSnap.profileKey } : {}),
    })
    if (!isProfileContextCurrent(ctxSnap)) return null
    if (seq !== autoSaveSeqRef.current) return reply?.result?.id ?? null
    if (reply?.result?.id) {
      const savedId = reply.result.id
      clearLocalDraft(snap.id, editorOpts)
      if (latestRef.current.draftText === bodyText) {
        clearLocalDraft(savedId, editorOpts)
        setSaveState('saved')
      } else {
        writeLocalDraft(savedId, latestRef.current.draftText, bodyText, editorOpts)
      }
      if (savedId !== snap.id) {
        autoSavedIdsRef.current.add(savedId)
        migrateResumeChatScope(snap.id, savedId)
        onVersion(savedId)
      }
      return savedId
    }
    setSaveState('error')
    return null
  }, [silentAct, onVersion, item.opportunityId])

  const scheduleAutoSave = React.useCallback(nextText => {
    window.clearTimeout(autoSaveTimerRef.current)
    writeLocalDraft(latestRef.current.id, nextText, latestRef.current.baseText, editorOpts)
    if (nextText === latestRef.current.baseText) {
      setSaveState(item.autoSaved ? 'saved' : 'idle')
      return
    }
    setSaveState('saving')
    autoSaveTimerRef.current = window.setTimeout(() => {
      void persistDraftNow({ text: nextText })
    }, 1100)
  }, [persistDraftNow, item.autoSaved, editorOpts])

  // If a recovered localStorage draft exists on mount, flush it to disk automatically.
  React.useEffect(() => {
    if (dirty && saveState === 'saving') {
      autoSaveTimerRef.current = window.setTimeout(() => {
        void persistDraftNow({ text: latestRef.current.draftText })
      }, 350)
    }
    return () => window.clearTimeout(autoSaveTimerRef.current)
  }, [item.id])

  // Zero-data-loss unmount flush: if the user switches to「新会话」or closes tab mid-edit,
  // flush pending edits via keepalive fetch so career.json on disk never loses work.
  React.useEffect(() => () => {
    window.clearTimeout(autoSaveTimerRef.current)
    const snap = latestRef.current
    if (snap.dirty && snap.editable && snap.draftText?.trim()) {
      writeLocalDraft(snap.id, snap.draftText, snap.baseText, { profileKey: snap.profileKey })
      try {
        void fetch(`${BASE}action`, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: {
            'content-type': 'application/json',
            'x-career-agent': '1',
            'x-career-locale': getActiveLocale(),
            ...(snap.profileKey ? { 'x-career-profile-key': snap.profileKey } : {}),
          },
          body: JSON.stringify({
            action: 'resume-revise',
            id: snap.id,
            text: snap.draftText,
            autoSaved: true,
            inPlace: snap.isAutoSavedPending,
            ...(snap.profileKey ? { profileKey: snap.profileKey } : {}),
          }),
        }).catch(() => {})
      } catch {}
    }
  }, [])

  React.useEffect(() => {
    const onForgotten = () => {
      window.clearTimeout(autoSaveTimerRef.current)
      clearAllLocalDrafts(editorOpts)
      setStagedProposal(null)
      setLastAppliedUndo(null)
      setEvidenceSourcePreviews({})
      if (retainedPreviewRef) retainedPreviewRef.current = null
      setSaveState('idle')
    }
    window.addEventListener('niuma:source-forgotten', onForgotten)
    return () => window.removeEventListener('niuma:source-forgotten', onForgotten)
  }, [retainedPreviewRef])

  const stageReviewProposal = React.useCallback((proposedMarkdown, meta = {}) => {
    if (meta.targetResumeId && meta.targetResumeId !== latestRef.current.id) return 'noop'
    const cleanNext = String(proposedMarkdown || '')
    const fallbackEvidenceIds = Array.isArray(meta.evidenceIds) ? meta.evidenceIds : []
    const provList = Array.isArray(meta.changeProvenance) && meta.changeProvenance.length ? meta.changeProvenance : null
    const isEvidenceSource = (meta.sourceKind || 'chat') === 'evidence'
    const currentBase = latestRef.current.draftText
    if (!cleanNext.trim() || cleanNext.trim() === String(currentBase || '').trim()) return 'noop'
    const rawItems = computeReviewableLineChanges(currentBase, cleanNext, meta.changes || [], { locale })
    if (!rawItems.length) return 'noop'
    const prevItems = (isEvidenceSource && stagedProposal && !stagedProposal.applied && Array.isArray(stagedProposal.items))
      ? stagedProposal.items
      : []
    const itemSourceLabel = meta.sourceLabel || (isEvidenceSource ? t('resume.sourceEvidenceLabel') : t('agent.sourceChatLabel'))
    const newItemReason = isEvidenceSource && Array.isArray(meta.changes) && meta.changes.length === 1
      ? String(meta.changes[0]?.summary || '')
      : ''
    const reviewItems = attachStagedReviewProvenance(rawItems, {
      changeProvenance: provList,
      previousItems: prevItems,
      fallbackEvidenceIds,
      sourceLabel: itemSourceLabel,
      sourceKind: meta.sourceKind || 'chat',
      newItemReason,
    })
    const allEvidenceIds = [...new Set(reviewItems.flatMap(row => Array.isArray(row.evidenceIds) ? row.evidenceIds : []))]
    const distinctSources = [...new Set(reviewItems.map(row => row.sourceLabel).filter(Boolean))]
    const playbackSource = distinctSources.length ? distinctSources.join(' · ') : itemSourceLabel
    // Wording-only chat edits apply optimistically with lightweight undo unless base drifted or staging is forced;
    // any evidence suggestion, newly inserted factual lines, or JD branch edit stays staged until explicitly accepted.
    const hasNewFacts = isEvidenceSource
      || allEvidenceIds.length > 0
      || reviewItems.some(row => row.kind === 'insert' || (Array.isArray(row.evidenceIds) && row.evidenceIds.length > 0))
    const baseDrifted = Boolean(meta.forceStage) || (typeof meta.baseMarkdown === 'string' && meta.baseMarkdown !== currentBase)
    const isOptimisticChat = (meta.sourceKind || 'chat') === 'chat' && !hasNewFacts && !meta.opportunityId && !baseDrifted
    const propId = crypto.randomUUID()
    const nextProposal = {
      id: propId,
      applied: isOptimisticChat,
      sourceKind: meta.sourceKind || 'chat',
      sourceLabel: playbackSource,
      sourceTitle: meta.sourceTitle || '',
      baseText: currentBase,
      proposedText: cleanNext,
      items: reviewItems,
      rejectedIds: [],
      evidenceIds: allEvidenceIds,
      meta,
    }
    setStagedProposal(nextProposal)
    setStagedOpen(!isOptimisticChat)
    setLastAppliedUndo(null)
    if (isOptimisticChat) {
      const appliedEvidenceIds = resolveAcceptedReviewEvidenceIds(reviewItems, [], allEvidenceIds)
      window.clearTimeout(autoSaveTimerRef.current)
      setDraftText(cleanNext)
      writeLocalDraft(latestRef.current.id, cleanNext, latestRef.current.baseText, editorOpts)
      void persistDraftNow({
        text: cleanNext,
        title: meta.title,
        variant: 'conversation',
        ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
        ...(appliedEvidenceIds.length ? { evidenceIds: appliedEvidenceIds } : {}),
      })
    }
    const steps = buildUnifiedPlaybackSteps(currentBase, reviewItems, { source: playbackSource })
    if (steps.length > 0 && onTriggerStagedPlayback) {
      onTriggerStagedPlayback({ token: propId, before: currentBase, steps })
    }
    return isOptimisticChat ? 'applied' : 'staged'
  }, [stagedProposal, locale, onTriggerStagedPlayback, persistDraftNow, t, editorOpts])

  const syncAppliedReviewDraft = React.useCallback((proposal, nextRejectedIds) => {
    const finalText = applyReviewDecisions(proposal.baseText, proposal.items, nextRejectedIds)
    const evidenceIds = resolveAcceptedReviewEvidenceIds(proposal.items, nextRejectedIds, proposal.evidenceIds)
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(finalText)
    writeLocalDraft(latestRef.current.id, finalText, latestRef.current.baseText, editorOpts)
    void persistDraftNow({
      text: finalText,
      title: proposal.meta?.title,
      variant: 'conversation',
      ...(proposal.meta?.opportunityId ? { opportunityId: proposal.meta.opportunityId } : {}),
      ...(evidenceIds.length ? { evidenceIds } : {}),
    })
  }, [persistDraftNow, editorOpts])

  const toggleStagedItem = React.useCallback(itemId => {
    if (!stagedProposal) return
    const isRejected = stagedProposal.rejectedIds.includes(itemId)
    const nextRejectedIds = isRejected
      ? stagedProposal.rejectedIds.filter(id => id !== itemId)
      : [...stagedProposal.rejectedIds, itemId]
    setStagedProposal(cur => cur ? { ...cur, rejectedIds: nextRejectedIds } : cur)
    if (stagedProposal.applied) {
      syncAppliedReviewDraft(stagedProposal, nextRejectedIds)
    }
  }, [stagedProposal, syncAppliedReviewDraft])

  const applyStagedProposal = React.useCallback(async () => {
    if (!stagedProposal) return
    if (stagedProposal.applied) {
      setStagedProposal(null)
      onTriggerStagedPlayback?.(null)
      return
    }
    const acceptedItems = stagedProposal.items.filter(row => !stagedProposal.rejectedIds.includes(row.id))
    const acceptedCount = acceptedItems.length
    const beforeSnapshot = latestRef.current.draftText
    const finalText = rebaseReviewDecisions(beforeSnapshot, stagedProposal.baseText, stagedProposal.items, stagedProposal.rejectedIds)
    const meta = stagedProposal.meta || {}
    const evidenceIds = resolveAcceptedReviewEvidenceIds(stagedProposal.items, stagedProposal.rejectedIds, stagedProposal.evidenceIds)
    setStagedProposal(null)
    onTriggerStagedPlayback?.(null)
    if (!acceptedCount || finalText === beforeSnapshot) return
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(finalText)
    writeLocalDraft(latestRef.current.id, finalText, latestRef.current.baseText, editorOpts)
    setLastAppliedUndo({ before: beforeSnapshot, after: finalText, count: acceptedCount })
    await persistDraftNow({
      text: finalText,
      title: meta.title,
      variant: 'conversation',
      ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
      ...(Array.isArray(evidenceIds) && evidenceIds.length ? { evidenceIds } : {}),
    })
  }, [stagedProposal, persistDraftNow, onTriggerStagedPlayback, editorOpts])

  const discardStagedProposal = React.useCallback(() => {
    if (stagedProposal?.applied) {
      const target = stagedProposal.baseText
      setStagedProposal(null)
      onTriggerStagedPlayback?.(null)
      window.clearTimeout(autoSaveTimerRef.current)
      setDraftText(target)
      writeLocalDraft(latestRef.current.id, target, latestRef.current.baseText, editorOpts)
      void persistDraftNow({ text: target })
      return
    }
    setStagedProposal(null)
    onTriggerStagedPlayback?.(null)
  }, [stagedProposal, onTriggerStagedPlayback, persistDraftNow, editorOpts])

  const replayStagedProposal = React.useCallback(() => {
    if (!stagedProposal || !onTriggerStagedPlayback) return
    const steps = buildUnifiedPlaybackSteps(stagedProposal.baseText, stagedProposal.items, { source: stagedProposal.sourceLabel })
    if (steps.length > 0) {
      onTriggerStagedPlayback({ token: `${stagedProposal.id}:${Date.now()}`, before: stagedProposal.baseText, steps })
    }
  }, [stagedProposal, onTriggerStagedPlayback])

  const undoLastApplied = React.useCallback(() => {
    if (!lastAppliedUndo) return
    const target = lastAppliedUndo.before
    setLastAppliedUndo(null)
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(target)
    writeLocalDraft(latestRef.current.id, target, latestRef.current.baseText, editorOpts)
    if (target !== latestRef.current.baseText) {
      void persistDraftNow({ text: target })
    } else {
      setSaveState('idle')
    }
  }, [lastAppliedUndo, persistDraftNow, editorOpts])

  const jumpToStagedItem = React.useCallback(row => {
    const lines = editorText.split(/\r?\n/u)
    const rejected = stagedProposal?.rejectedIds?.includes(row.id)
    const candidates = [
      (!rejected && row.text) ? stripBulletPrefix(row.text) : '',
      row.source ? stripBulletPrefix(row.source) : '',
    ].filter(Boolean)
    let idx = -1
    for (const targetText of candidates) {
      idx = lines.findIndex(line => stripBulletPrefix(line) === targetText || line === row.text || line === row.source)
      if (idx >= 0) break
    }
    if (idx < 0 && row.section) {
      idx = lines.findIndex(line => line.trim().includes(row.section))
    }
    if (idx < 0) idx = Math.max(0, Math.min(lines.length - 1, row.line ?? 0))
    setHighlightLine({ line: idx, token: Date.now() })
  }, [editorText, stagedProposal?.rejectedIds])

  const previewUnmergedEvidence = React.useCallback(ev => {
    if (hasUnappliedStaged && stagedProposal.items.some(row => Array.isArray(row.evidenceIds) && row.evidenceIds.includes(ev.id))) {
      const alreadyRejected = stagedProposal.items
        .filter(row => Array.isArray(row.evidenceIds) && row.evidenceIds.includes(ev.id) && stagedProposal.rejectedIds.includes(row.id))
        .map(row => row.id)
      if (alreadyRejected.length) {
        setStagedProposal(cur => cur ? { ...cur, rejectedIds: cur.rejectedIds.filter(id => !alreadyRejected.includes(id)) } : cur)
      }
      setStagedOpen(true)
      setPendingOpen(false)
      window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
      return
    }
    const placementBase = hasUnappliedStaged && stagedPreviewText !== null ? stagedPreviewText : editorText
    const placement = suggestEvidencePlacement(placementBase, ev, locale)
    const staged = stageReviewProposal(placement.proposedText, {
      sourceKind: 'evidence',
      sourceLabel: sourceLabel(ev.sourceId, t),
      sourceTitle: ev.title || t('evidence.defaultTitle'),
      evidenceIds: [ev.id],
      changes: [{
        kind: 'add',
        summary: t('resume.evidenceInsertReason', {
          section: placement.sectionLabel,
          title: ev.title || t('evidence.defaultTitle'),
        }),
      }],
    })
    if (staged === 'staged') {
      setPendingOpen(false)
      window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    }
  }, [hasUnappliedStaged, stagedProposal, stagedPreviewText, editorText, locale, stageReviewProposal, t])

  const toggleEvidenceSourcePreview = React.useCallback(async ev => {
    const cur = evidenceSourcePreviews[ev.id]
    if (cur?.open) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { ...cur, open: false } }))
      return
    }
    if (cur?.text || cur?.error) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { ...cur, open: true } }))
      return
    }
    setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: true, text: '', error: '' } }))
    const runner = typeof act?.background === 'function' ? act.background : act
    const reply = await runner('evidence-source', { id: ev.id })
    if (reply?.result?.text) {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: false, text: reply.result.text, error: '' } }))
    } else {
      setEvidenceSourcePreviews(prev => ({ ...prev, [ev.id]: { open: true, loading: false, text: ev.sourceRef || '', error: reply?.error || '' } }))
    }
  }, [evidenceSourcePreviews, act])

  const handleApplyAiMarkdown = React.useCallback((next, meta = {}) => {
    if (meta?.targetResumeId && meta.targetResumeId !== latestRef.current.id) return
    window.clearTimeout(autoSaveTimerRef.current)
    setDraftText(next)
    writeLocalDraft(latestRef.current.id, next, latestRef.current.baseText, editorOpts)
    void persistDraftNow({
      text: next,
      title: meta.title,
      variant: 'conversation',
      ...(meta.opportunityId ? { opportunityId: meta.opportunityId } : {}),
      ...(Array.isArray(meta.evidenceIds) && meta.evidenceIds.length ? { evidenceIds: meta.evidenceIds } : {}),
    })
  }, [persistDraftNow, editorOpts])

  const pdfSupported = capabilities?.pdfExport === true
  const hasPendingWork = pendingEvidence.length > 0 || unmergedCount > 0
  const effectiveStyle = React.useMemo(
    () => normalizeResumeStyle(styleOverrides, templateChoice),
    [styleOverrides, templateChoice],
  )

  const restoreAppearance = React.useCallback(prev => {
    if (!prev) return
    if (prev.template) selectTemplate(prev.template)
    if (prev.style) {
      setStyleOverrides(prev.style)
      try { writeProfileLocal('local.style', JSON.stringify(prev.style), editorOpts) } catch {}
    }
  }, [selectTemplate, editorOpts])

  const saveDraft = React.useCallback(async () => {
    if (busy) return null
    if (!dirty) {
      if (item.status === 'pending' && item.autoSaved === true) {
        const reply = await act('resume-review', { id: item.id, decision: 'approve' }, t('resume.toastSavedApproved'))
        if (reply?.result?.id) {
          clearLocalDraft(item.id, editorOpts)
          setSaveState('saved')
          return reply.result.id
        }
      }
      return null
    }
    window.clearTimeout(autoSaveTimerRef.current)
    const reply = await act('resume-revise', {
      id: item.id,
      text: draftText,
      approve: true,
      inPlace: item.status === 'pending' && item.autoSaved === true,
    }, t('resume.toastSavedApproved'))
    if (reply?.result?.id) {
      const savedId = reply.result.id
      clearLocalDraft(item.id, editorOpts)
      clearLocalDraft(savedId, editorOpts)
      setSaveState('saved')
      if (savedId !== item.id) {
        autoSavedIdsRef.current.add(savedId)
      }
      onVersion(savedId)
      return savedId
    }
    return null
  }, [dirty, busy, act, item.id, item.status, item.autoSaved, draftText, onVersion, t, editorOpts])

  const exportWithAutoSave = async kind => {
    let targetId = item.id
    if (dirty) {
      targetId = await saveDraft()
      if (!targetId) return
    }
    if (kind === 'pdf') await paperExportRef.current?.downloadPdf(targetId)
    else await paperExportRef.current?.downloadHtml(targetId)
  }

  const confirmVersion = async () => {
    const args = { id: item.id, decision: 'approve' }
    if (hasPartialSelection) args.selected = selectedIndices
    const reply = await act('resume-review', args, hasPartialSelection ? t('resume.toastApprovedSelected') : t('resume.toastApprovedVersion'))
    if (reply?.result?.id && reply.result.id !== item.id) onVersion(reply.result.id)
    else if (reply) agent.dismiss()
  }

  const jumpToChange = row => {
    const lines = editorText.split(/\r?\n/u)
    const stripped = stripBulletPrefix(row.text)
    const idx = lines.findIndex(line => stripBulletPrefix(line) === stripped || line === row.source)
    if (idx >= 0) setHighlightLine({ line: idx, token: Date.now() })
  }

  const jumpToPlacement = placement => {
    const lines = editorText.split(/\r?\n/u)
    const target = stripBulletPrefix(placement?.bullet || '')
    if (!target) return
    const head = target.slice(0, 18)
    const idx = lines.findIndex(line => {
      const clean = stripBulletPrefix(line)
      return clean === target || (head.length >= 6 && clean.includes(head))
    })
    if (idx >= 0) setHighlightLine({ line: idx, token: Date.now() })
  }

  const focusSnippet = React.useCallback(summaryText => {
    const clean = String(summaryText || '').trim()
    if (!clean) return
    const lines = editorText.split(/\r?\n/u)
    const tokens = [...clean.matchAll(/[\u4e00-\u9fff]{2,6}|[a-z0-9._+-]{3,}/giu)]
      .map(m => m[0].toLowerCase())
      .filter(t => !['优化', '调整', '补充', '精简', '更新', '结构', '表述', '简历', '经历', 'the', 'and', 'for', 'with', 'resume', 'update', 'updated', 'refine'].includes(t))
    if (!tokens.length) return
    let bestIdx = -1
    let bestHits = 0
    lines.forEach((line, idx) => {
      const lower = line.toLowerCase()
      const hits = tokens.filter(t => lower.includes(t)).length
      if (hits > bestHits) { bestHits = hits; bestIdx = idx }
    })
    if (bestIdx >= 0) setHighlightLine({ line: bestIdx, token: Date.now() })
  }, [editorText])

  const handleSmartMergeEvidence = React.useCallback(async () => {
    const canUseActiveBase = item.status === 'approved' && !item.opportunityId && item.general !== false && item.kind !== 'tailored'
    const reply = await act(
      'resume-generate',
      canUseActiveBase ? { baseId: item.id } : {},
      result => result?.summary || t('resume.toastMergedDraft'),
    )
    if (reply?.result?.id) { setPendingOpen(false); onVersion(reply.result.id) }
  }, [act, item.id, item.status, item.opportunityId, item.general, item.kind, onVersion, t])

  const rebaseOp = useTrackedOperation(act, 'resume-rebase')
  const [rebaseTargetLabel, setRebaseTargetLabel] = React.useState('')
  const [graphFilter, setGraphFilter] = React.useState('')

  const activeResumeCount = React.useMemo(
    () => resumes.filter(r => !r.archivedAt && (r.status === 'approved' || r.status === 'pending')).length,
    [resumes],
  )
  const archivedResumeCount = React.useMemo(
    () => resumes.filter(isArchivedResume).length,
    [resumes],
  )

  const handleArchiveResume = React.useCallback(async (id, scope = 'version') => {
    const toast = scope === 'older'
      ? t('resume.toastSquashed')
      : t('resume.toastArchived')
    const reply = await act('resume-archive', { id, scope }, toast)
    const archivedIds = Array.isArray(reply?.result?.archivedIds) ? reply.result.archivedIds : []
    if (archivedIds.includes(item.id)) {
      onVersion('')
    }
  }, [act, item.id, onVersion, t])

  const handleRestoreResume = React.useCallback(async (id, scope = 'version') => {
    await act('resume-restore', { id, scope }, t('resume.toastRestored'))
  }, [act, t])

  const handleDeleteArchived = React.useCallback(async id => {
    await act('resume-delete', { id }, t('resume.toastDeletedArchived'))
  }, [act, t])

  const handleRebaseBranch = React.useCallback(async (branchId = item.id) => {
    const targetId = branchId || item.id
    const targetBranch = versionTree.branches.find(b => b.revisions.some(r => r.id === targetId))
    const targetRow = resumes.find(r => r.id === targetId)
    const label = targetBranch?.label || targetRow?.title || t('resume.tailoredResumeDefault')
    setRebaseTargetLabel(label)
    if (targetId && targetId !== item.id) onVersion(targetId)
    const reply = await rebaseOp.run(
      'resume-rebase',
      { id: targetId },
      {
        kind: 'resume-rebase',
        label,
        toast: result => result?.summary || t('resume.toastRebased', { label }),
      },
    )
    if (reply?.result?.id) {
      onVersion(reply.result.id)
      setReviewOpen(true)
    }
  }, [rebaseOp, item.id, versionTree.branches, resumes, onVersion, t])

  const toolbarMeta = saveState === 'saving'
    ? <span className="ca-save-pill is-saving">{t('resume.autoSaving')}</span>
    : saveState === 'error'
      ? <button type="button" className="ca-save-pill is-error" onClick={() => void persistDraftNow()}>{t('resume.autoSaveError')}</button>
      : dirty
        ? <span className="ca-dirty-pill">{t('resume.unsavedShortcut')}</span>
        : (saveState === 'saved' || item.autoSaved)
          ? <span className="ca-save-pill is-saved">{t('resume.autoSaved')}</span>
          : item.evidenceCount > 0
            ? <span>{t('resume.linkedEvidence', { count: item.evidenceCount })}</span>
            : null

  const beforeExport = React.useCallback(
    async targetId => {
      const reply = await act('export', { id: targetId || item.id })
      return typeof reply?.result?.text === 'string' && reply.result.text.length > 0 ? reply.result.text : ''
    },
    [act, item.id],
  )

  return <div className="ca-studio">
    <div className="ca-studio-bar" data-agent-toolbar>
      <div className="ca-studio-bar-left">
        <VersionMenu item={item} resumes={resumes} defaultMasterTrackId={defaultMasterTrackId}
          opportunities={opportunities} timezone={config.timezone}
          disabled={busy === 'resume-optimize' || playback.active} onVersion={onVersion}
          accent={effectiveStyle.accent} font={effectiveStyle.font}
          onDismiss={id => act('resume-review', { id, decision: 'dismiss' }, t('resume.toastDismissedDraft'))}
          onRename={(id, title) => act('resume-rename', { id, title }, t('resume.toastRenamedMaster'))}
          onSetDefault={trackId => act('resume-set-default', { trackId }, t('resume.toastSetDefault'))}
          onBranchMaster={async (id, title) => {
            const reply = await act('resume-branch-master', { id, title }, t('resume.toastBranchedMaster'))
            if (reply?.result?.id) onVersion(reply.result.id)
          }}
          onRebase={handleRebaseBranch}
          onOpenGraph={mode => setGraphFilter(mode || 'all')}
          onArchive={handleArchiveResume} />

        {(currentMasterInSync || isEmptyRebase) && !playback.active && (
          <span className="ca-version-sync-inline" title={isEmptyRebase ? (item.summary || t('resume.masterInSyncTitle')) : t('resume.masterInSyncTitle')}>
            {isEmptyRebase ? t('resume.rebaseAlignedShort') : t('resume.masterInSyncShort')}
          </span>
        )}

        {(activeResumeCount >= 2 || archivedResumeCount > 0) && (
          <button
            type="button"
            className={`ca-graph-trigger-btn${graphFilter ? ' is-open' : ''}`}
            aria-label={t('graph.triggerAria')}
            title={t('graph.triggerTitle')}
            disabled={busy === 'resume-optimize' || playback.active}
            onClick={() => setGraphFilter('all')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="11.5" cy="6.2" r="1.8" stroke="currentColor" strokeWidth="1.4" />
              <path d="M4.5 5.3v5.4M11.5 8v1.1c0 1.8-1.4 3.2-3.2 3.2H6.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>
        )}

        <Button variant="ghost" size="sm" icon={<Icon name="plus" size={13} />} disabled={locked} onClick={onOpenImport}>{t('resume.importBtn')}</Button>

        {hasPendingWork && <button type="button" className="ca-studio-work-pill"
          aria-expanded={pendingOpen} onClick={() => setPendingOpen(v => !v)}>
          <i aria-hidden="true" />
          {pendingEvidence.length > 0 ? t('resume.newEvidencePill', { count: pendingEvidence.length }) : t('resume.unmergedPill', { count: unmergedCount })}
        </button>}

        <Button variant="ghost" size="sm" disabled={locked} onClick={onOpenLibrary}>
          {evidenceCountTotal > 0 ? t('resume.libraryBtnCount', { count: evidenceCountTotal }) : t('resume.libraryBtn')}
        </Button>
      </div>

      <div className="ca-studio-bar-right">
        {playback.active ? (
          <ResumePlaybackControls playback={playback} />
        ) : dirty ? <>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => {
            window.clearTimeout(autoSaveTimerRef.current)
            clearLocalDraft(item.id, editorOpts)
            setDraftText(baseText)
            setSaveState('idle')
          }}>{t('resume.discard')}</Button>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={saveDraft}>{t('common.save')}</Button>
          {pdfSupported ? <Button variant="primary" size="sm" disabled={!!busy || !exportState.ready || !!exportState.exporting}
            onClick={() => void exportWithAutoSave('pdf')}>
            {exportState.exporting === 'pdf' ? t('resume.exportingPdf') : t('resume.saveExportPdf')}
          </Button> : <Button variant="primary" size="sm" disabled={!!busy || !exportState.ready || !!exportState.exporting}
            onClick={() => void exportWithAutoSave('html')}>
            {exportState.exporting === 'html' ? t('resume.exporting') : t('resume.saveExport')}
          </Button>}
        </> : item.status === 'pending' ? <>
          <Button variant="ghost" size="sm" disabled={locked}
            onClick={() => {
              clearLocalDraft(item.id, editorOpts)
              void act('resume-review', { id: item.id, decision: 'dismiss' }, t('resume.toastIgnoredDraft'))
            }}>{t('common.dismiss')}</Button>
          <Button variant="primary" size="sm"
            disabled={locked || (hasPartialSelection && !selectedIndices.length)}
            onClick={confirmVersion}>
            {hasPartialSelection ? t('resume.confirmSelected', { selected: selectedIndices.length, total: items.length }) : t('resume.approveVersion')}
          </Button>
        </> : item.status === 'approved' ? (
          pdfSupported ? <>
            <Button variant="ghost" size="sm" disabled={!exportState.ready || !!exportState.exporting}
              onClick={() => paperExportRef.current?.downloadHtml()}>
              {exportState.exporting === 'html' ? t('resume.exporting') : 'HTML'}
            </Button>
            <Button variant="primary" size="sm" disabled={!exportState.ready || !!exportState.exporting}
              onClick={() => paperExportRef.current?.downloadPdf()}>
              {exportState.exporting === 'pdf' ? t('resume.exportingPdf') : t('resume.exportPdf')}
            </Button>
          </> : <Button variant="primary" size="sm" disabled={!exportState.ready || !!exportState.exporting}
            onClick={() => paperExportRef.current?.downloadHtml()}>
            {exportState.exporting === 'html' ? t('resume.exporting') : t('resume.downloadPrint')}
          </Button>
        ) : null}
      </div>
    </div>

    {pendingOpen && hasPendingWork && <div className="ca-pending-tray">
      <div className="ca-pending-tray-head">
        <span>{pendingEvidence.length > 0 ? t('resume.pendingBannerTitle') : t('resume.unmergedBannerTitle', { count: unmergedEvidence.length || unmergedCount })}</span>
        <div className="ca-inline">
          {unmergedCount > 0 && <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void handleSmartMergeEvidence()}>
            {busy === 'resume-generate' ? t('resume.merging') : t('resume.smartMerge', { count: unmergedCount })}
          </Button>}
          <Button variant="ghost" size="sm" onClick={() => setPendingOpen(false)}>{t('common.collapse')}</Button>
        </div>
      </div>
      {pendingEvidence.length > 0 && <div className="ca-pending-tray-list">
        {pendingEvidence.map(ev => <Evidence key={ev.id} item={ev} config={config} busy={busy} act={act}
          onResume={id => { setPendingOpen(false); onVersion(id) }} />)}
      </div>}
      {unmergedEvidence.length > 0 && <div className="ca-pending-tray-list">
        {unmergedEvidence.map(ev => {
          const placement = suggestEvidencePlacement(editorText, ev, locale)
          const srcPreview = evidenceSourcePreviews[ev.id]
          return (
            <article key={ev.id} className="ca-unmerged-ev-card">
              <div className="ca-unmerged-ev-head">
                <div className="ca-inline" style={{ gap: '6px', flexWrap: 'wrap' }}>
                  <strong>{ev.title || t('evidence.defaultTitle')}</strong>
                  <Tag tone="neutral">{sourceLabel(ev.sourceId, t)}</Tag>
                  <Tag tone="info">{t('resume.intendedSectionBadge', { section: placement.sectionLabel })}</Tag>
                </div>
                <span className="ca-meta">{readableDate(ev.occurredAt || ev.createdAt, config.timezone, locale)}</span>
              </div>
              {ev.text && <p className="ca-unmerged-ev-text">{ev.text}</p>}
              {(ev.impact || ev.role) && (
                <div className="ca-unmerged-ev-meta">
                  {ev.role && <span>{t('evidence.role')}: {ev.role}</span>}
                  {ev.impact && <span>{t('evidence.impact')}: {ev.impact}</span>}
                </div>
              )}
              <div className="ca-inline" style={{ marginTop: '8px', gap: '8px', flexWrap: 'wrap' }}>
                <Button variant="outline" size="sm" disabled={locked} onClick={() => previewUnmergedEvidence(ev)}>
                  {t('resume.previewEvidenceInsert')}
                </Button>
                {(ev.sourceId === 'dsh-session' || ev.sourceRef) && (
                  <button type="button" className="ca-text-button" onClick={() => void toggleEvidenceSourcePreview(ev)}>
                    {srcPreview?.open ? t('common.collapse') : t('resume.viewEvidenceSource')}
                  </button>
                )}
              </div>
              {srcPreview?.open && (
                <div className="ca-ev-source-excerpt">
                  {srcPreview.loading
                    ? <span className="ca-meta">{t('common.processingEllipsis')}</span>
                    : srcPreview.text
                      ? <p className="ca-preline">{srcPreview.text}</p>
                      : <span className="ca-meta">{srcPreview.error || t('resume.noSourceExcerpt')}</span>}
                </div>
              )}
            </article>
          )
        })}
      </div>}
    </div>}

    <div className="ca-narrow-switcher" role="tablist" aria-label={t('resume.switchPaneAria')}>
      <button type="button" role="tab" aria-selected={mobilePane === 'edit'} onClick={() => setMobilePane('edit')}>{t('resume.editBody')}</button>
      <button type="button" role="tab" aria-selected={mobilePane === 'preview'} onClick={() => setMobilePane('preview')}>
        {t('resume.layoutPreview')}{activeTemplate ? ` · ${activeTemplate.label}` : ''}
      </button>
    </div>

    <div className="ca-studio-split" data-mobile-pane={mobilePane} data-agent-paper>
      <div className="ca-studio-left">
        <div className="ca-studio-left-scroll" data-editor-scroll>
          <AgentTailorBanner activity={agent.activity} onDismiss={agent.dismiss} />
          {rebaseOp.activity && rebaseOp.activity.phase !== 'ready' && (
            <AiTraceCard
              compact
              activity={rebaseOp.activity}
              title={rebaseOp.activity.phase === 'error'
                ? t('resume.rebaseFailed')
                : t('resume.rebasingBranch', { label: rebaseTargetLabel || currentBranchRev?.title || t('version.tailoredBranches') })}
              onDismiss={rebaseOp.dismiss}
            />
          )}
          {currentMasterHasDiff && !playback.active && !rebaseOp.running && (
            <div className="ca-rebase-banner" role="status">
              <div className="ca-rebase-copy">
                <i className="ca-rebase-dot" aria-hidden="true" />
                <strong>{t('resume.masterUpdatedTitle', { version: currentBranchRev?.masterLatestVersion })}</strong>
              </div>
              <Button variant="outline" size="sm" disabled={!!busy || rebaseOp.running} onClick={() => void handleRebaseBranch(item.id)}>
                {rebaseOp.running ? t('resume.syncing') : t('version.syncMaster')}
              </Button>
            </div>
          )}
          {lastAppliedUndo && !stagedProposal && !playback.active && (
            <div className="ca-rebase-banner" role="status">
              <div className="ca-rebase-copy">
                <strong>{t('resume.appliedUndoBanner', { count: lastAppliedUndo.count })}</strong>
              </div>
              <div className="ca-inline">
                <Button variant="outline" size="sm" onClick={undoLastApplied}>{t('resume.undoApplied')}</Button>
                <button type="button" className="ca-text-button" onClick={() => setLastAppliedUndo(null)}>{t('common.close')}</button>
              </div>
            </div>
          )}
          {stagedProposal && !playback.active && (() => {
            const totalCount = stagedProposal.items.length
            const selectedCount = totalCount - stagedProposal.rejectedIds.length
            const isSingle = totalCount === 1
            const isEvidence = stagedProposal.sourceKind === 'evidence'
            const showBatchControls = stagedProposal.applied || !isSingle
            const primaryCommitLabel = selectedCount === 0
              ? t('resume.noEditsSelected')
              : isSingle
                ? (isEvidence ? t('resume.insertIntoResume') : t('resume.applySingleEdit'))
                : selectedCount === totalCount
                  ? (isEvidence ? t('resume.insertAllCount', { count: totalCount }) : t('resume.applyAllCount', { count: totalCount }))
                  : (isEvidence ? t('resume.insertSelectedCount', { count: selectedCount }) : t('resume.applySelectedShort', { count: selectedCount }))
            const footHint = isSingle
              ? t('resume.stagedSingleHint')
              : selectedCount === 0
                ? t('resume.stagedNoneHint')
                : t('resume.stagedMultiHint', { selected: selectedCount, total: totalCount })
            return <section ref={reviewCardRef} className={`ca-review-card${stagedOpen ? ' is-open' : ''}`} data-surface="unified-review">
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={stagedOpen}
                onClick={() => setStagedOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {isEvidence
                    ? t('resume.stagedEvidenceTitle')
                    : stagedProposal.applied
                      ? t('resume.appliedChatTitle')
                      : t('resume.stagedChatTitle')}
                </span>
                {showBatchControls && (
                  <Tag tone={stagedProposal.applied ? 'success' : 'info'}>
                    {t('resume.selectedEdits', {
                      selected: selectedCount,
                      total: totalCount,
                    })}
                  </Tag>
                )}
                {stagedProposal.sourceLabel && <Tag tone="neutral">{stagedProposal.sourceLabel}</Tag>}
              </button>
              <div className="ca-inline" style={{ flexWrap: 'nowrap', flexShrink: 0 }}>
                <Button variant="ghost" size="sm" icon={<Icon name="play" size={11} />} onClick={replayStagedProposal}>{t('resume.replay')}</Button>
                {stagedProposal.applied ? <>
                  <button type="button" className="ca-text-button" onClick={discardStagedProposal}>{t('agent.undoStep')}</button>
                  <button type="button" className="ca-text-button" onClick={() => setStagedProposal(null)}>{t('common.close')}</button>
                </> : (!isSingle && (
                  <button type="button" className="ca-text-button" onClick={() => setStagedProposal(cur => cur ? {
                    ...cur,
                    rejectedIds: cur.rejectedIds.length > 0 ? [] : cur.items.map(it => it.id),
                  } : cur)}>
                    {stagedProposal.rejectedIds.length > 0 ? t('resume.includeAllEdits') : t('resume.skipAllEdits')}
                  </button>
                ))}
              </div>
            </div>

            <div className="ca-review-collapse" aria-hidden={!stagedOpen}>
              <div className="ca-review-collapse-inner">
                <div className="ca-review-list">
                  {stagedProposal.items.map((row, index) => {
                    const kept = !stagedProposal.rejectedIds.includes(row.id)
                    const multiSource = new Set(stagedProposal.items.map(it => it.sourceLabel).filter(Boolean)).size > 1
                    const kindLabel = row.kind === 'insert'
                      ? t('agent.changeAdd')
                      : row.kind === 'delete'
                        ? t('agent.changeDelete')
                        : t('agent.changeEdit')
                    return <div className="ca-ed-row" key={row.id}
                      data-staged-change={index} data-excluded={!kept || undefined}
                      onClick={() => jumpToStagedItem(row)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head">
                          <span className={`ca-ed-kind${row.kind === 'insert' ? ' is-add' : row.kind === 'delete' ? ' is-del' : ' is-edit'}`}>{kindLabel}</span>
                          {row.section && <span className="ca-ed-kind is-section" title={row.section}>{row.section}</span>}
                          {multiSource && row.sourceLabel && <span className="ca-ed-kind is-section" title={row.sourceLabel}>{row.sourceLabel}</span>}
                          {row.reason && <span className="ca-ed-reason">{row.reason}</span>}
                          {showBatchControls && (
                            <button type="button"
                              className={`ca-ed-toggle${stagedProposal.applied ? ' is-applied-revert' : ''}${kept ? ' is-kept' : ''}`}
                              aria-pressed={kept}
                              disabled={locked}
                              onClick={event => {
                                event.stopPropagation()
                                toggleStagedItem(row.id)
                              }}>
                              {stagedProposal.applied
                                ? (kept ? t('resume.revertLineBtn') : t('resume.reapplyLineBtn'))
                                : (kept ? <>✓ {t('resume.includeEditPill')}</> : t('resume.skippedEditPill'))}
                            </button>
                          )}
                        </div>
                        {row.kind === 'edit' ? (
                          <EditorialDiff source={row.source} text={row.text} kept={kept} rank={index + 1} promoted={false} />
                        ) : row.kind === 'insert' ? (
                          <div className={`ca-ed-card${!kept ? ' is-rejected' : ''}`}>
                            <p className="ca-ed-main">
                              {kept
                                ? <mark className="ca-ed-mark">{stripMarkdownInline(stripBulletPrefix(row.text))}</mark>
                                : stripMarkdownInline(stripBulletPrefix(row.text))}
                            </p>
                            <span className="ca-ed-note">{kept ? t('resume.addedLineNote') : t('resume.skippedInsertNote')}</span>
                          </div>
                        ) : (
                          <div className={`ca-ed-card${!kept ? ' is-rejected' : ''}`}>
                            <p className="ca-ed-main">
                              {kept
                                ? <del className="ca-ed-del">{stripMarkdownInline(stripBulletPrefix(row.source))}</del>
                                : stripMarkdownInline(stripBulletPrefix(row.source))}
                            </p>
                            <span className="ca-ed-note">{kept ? t('resume.removedLineNote') : t('resume.keptOriginalNote')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  })}
                </div>
                {!stagedProposal.applied && (
                  <div className="ca-review-staged-foot">
                    <span className="ca-review-staged-foot-hint">{footHint}</span>
                    <div className="ca-review-staged-foot-actions">
                      <Button variant="ghost" size="sm" onClick={discardStagedProposal}>{t('resume.discardProposal')}</Button>
                      <Button variant="primary" size="sm" disabled={!!busy || selectedCount === 0} onClick={() => void applyStagedProposal()}>
                        {primaryCommitLabel}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
          })()}
          {hasMergeSummary && !playback.active && <section className={`ca-review-card${reviewOpen ? ' is-open' : ''}`}>
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={reviewOpen}
                onClick={() => setReviewOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {item.origin === 'rebase' ? t('resume.rebaseSummary') : t('resume.mergeSummary')}
                </span>
                <Tag tone={item.status === 'pending' ? 'info' : 'neutral'}>
                  {mergePlacements.length ? t('resume.placementsCount', { count: mergePlacements.length }) : t('resume.merged')}
                </Tag>
                {item.summary && !reviewOpen && <span className="ca-review-bar-sub">{item.summary}</span>}
              </button>
            </div>

            <div className="ca-review-collapse" aria-hidden={!reviewOpen}>
              <div className="ca-review-collapse-inner">
                {item.summary && <p className="ca-change-summary">{item.summary}</p>}
                {mergePlacements.length > 0 && <div className="ca-review-list">
                  {mergePlacements.map((pl, index) => (
                    <div className="ca-ed-row" key={`${pl.evidenceId || index}-${index}`} onClick={() => jumpToPlacement(pl)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head is-wrap">
                          {pl.section && <span className="ca-ed-kind is-edit is-section" title={pl.section}>{pl.section}</span>}
                          {pl.reason && <span className="ca-ed-reason">{pl.reason}</span>}
                        </div>
                        {pl.bullet && <p className="ca-ed-merge-bullet">{String(pl.bullet).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\*+(?!\s)/, '')}</p>}
                      </div>
                    </div>
                  ))}
                </div>}
              </div>
            </div>
          </section>}
          {isReviewable && !playback.active && <section className={`ca-review-card${reviewOpen ? ' is-open' : ''}`}>
            <div className="ca-review-bar">
              <button type="button" className="ca-review-bar-toggle" aria-expanded={reviewOpen}
                onClick={() => setReviewOpen(v => !v)}>
                <svg className="ca-review-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ca-review-bar-title">
                  {item.variant === 'conversation' ? t('resume.reviewEdits') : t('resume.tailorSummary')}
                </span>
                <Tag tone={canSelectChanges ? 'info' : 'neutral'}>
                  {canSelectChanges ? t('resume.selectedEdits', { selected: selectedIndices.length, total: items.length }) : t('resume.optimizationsCount', { count: items.length })}
                </Tag>
                {item.gaps && !reviewOpen && <span className="ca-review-bar-sub">{t('resume.hasGapsHint')}</span>}
              </button>
              <div className="ca-inline">
                {canSelectChanges && (
                  <button type="button" className="ca-text-button" onClick={() => setExcluded(excluded.length > 0 ? [] : items.map((_, i) => i))}>
                    {excluded.length > 0 ? t('resume.selectAllEdits') : t('resume.keepAllOriginal')}
                  </button>
                )}
                {onReplay && <Button variant="ghost" size="sm" icon={<Icon name="play" size={11} />}
                  onClick={onReplay}>{t('resume.replay')}</Button>}
              </div>
            </div>

            <div className="ca-review-collapse" aria-hidden={!reviewOpen}>
              <div className="ca-review-collapse-inner">
                {item.summary && <p className="ca-change-summary">{item.summary}</p>}

                <div className="ca-review-list">
                  {items.map((row, index) => {
                    const kept = !excluded.includes(index)
                    const promoted = row.promote === true || item.variant !== 'conversation'
                    const textChanged = stripBulletPrefix(row.source) !== stripBulletPrefix(row.text)
                    const changeKind = promoted && textChanged ? t('resume.changePromotedEdited') : promoted ? t('resume.changePromoted') : t('resume.changeEdited')
                    const rank = index + 1
                    return <div className="ca-ed-row" key={index}
                      data-agent-change={index} data-excluded={!kept || undefined}
                      onClick={() => jumpToChange(row)}>
                      <span className="ca-ed-rank" aria-hidden="true">{String(rank).padStart(2, '0')}</span>
                      <div className="ca-ed-body">
                        <div className="ca-ed-row-head">
                          <span className={`ca-ed-kind${textChanged ? ' is-edit' : ''}`}>{changeKind}</span>
                          {row.reason && <span className="ca-ed-reason">{row.reason}</span>}
                          {canSelectChanges && <button type="button"
                            className={`ca-ed-toggle${kept ? ' is-kept' : ''}`}
                            aria-pressed={kept}
                            disabled={locked}
                            onClick={event => {
                              event.stopPropagation()
                              setExcluded(kept ? [...excluded, index] : excluded.filter(v => v !== index))
                            }}>
                            {kept ? t('resume.kept') : t('resume.keepOriginal')}
                          </button>}
                        </div>
                        <EditorialDiff source={row.source} text={row.text} kept={kept} rank={rank} promoted={promoted} />
                      </div>
                    </div>
                  })}
                </div>

                <GapsPanel gaps={item.gaps} onPickGap={prompt => setLocalSeedPrompt(prompt)} />
              </div>
            </div>
          </section>}

          <div className="ca-editor-host">
            {playback.active && requiresMarkdownSource(editorText)
              ? <ResumeLines text={editorText} />
              : <LocalRichEditor
                ariaLabel={playback.active ? t('editor.lineByLineAria') : t('editor.ariaLabel')}
                text={editorText}
                disabled={!editable || locked}
                playing={playback.active}
                showToolbar={!playback.active}
                toolbarMeta={toolbarMeta}
                highlightLine={highlightLine}
                onChange={next => {
                  if (!playback.active) {
                    if (next === editorText) return
                    if (stagedProposal?.applied) {
                      setStagedProposal(null)
                    }
                    setDraftText(next)
                    scheduleAutoSave(next)
                  }
                }}
                onSaveShortcut={saveDraft}
                onUserInteract={() => {
                  if (playback.active && !playback.paused) playback.pause()
                }}
                onEditorReady={onEditorReady}
              />}
          </div>
        </div>

        {editable && <FloatingResumeCommandBar
          resumeId={item.id}
          resumeVersion={`${item.id}:${item.updatedAt || item.createdAt || ''}:${item.versionTag || ''}:${baseText.length}`}
          resumeTitle={item.title || ''}
          readyForEffects={syncedResumeId === item.id && prevIdRef.current === item.id}
          markdown={editorText}
          template={templateChoice}
          effectiveStyle={effectiveStyle}
          opportunities={opportunities}
          templates={templates}
          config={config}
          busy={busy}
          disabled={playback.active}
          unmergedCount={unmergedCount}
          masterBehind={currentMasterHasDiff && !rebaseOp.running}
          onMergeEvidence={unmergedCount > 0 ? handleSmartMergeEvidence : undefined}
          onRebaseBranch={(currentMasterHasDiff && !rebaseOp.running) ? () => handleRebaseBranch(item.id) : undefined}
          onFocusSnippet={focusSnippet}
          onApplyMarkdown={handleApplyAiMarkdown}
          onStageProposal={stageReviewProposal}
          hasStagedProposal={Boolean(stagedProposal)}
          onFocusReview={() => {
            setStagedOpen(true)
            window.requestAnimationFrame(() => reviewCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
          }}
          onApplyStyleDirective={applyStyleDirective}
          onRestoreAppearance={restoreAppearance}
          seedPrompt={localSeedPrompt || seedPrompt}
          onConsumeSeedPrompt={() => { setLocalSeedPrompt(''); onConsumeSeedPrompt?.() }}
        />}
      </div>

      <div className="ca-studio-right">
        <LocalTemplatePaper
          title={item.title}
          text={previewText}
          previewingUnapplied={hasUnappliedStaged}
          templates={templates}
          template={templateChoice}
          onSelectTemplate={selectTemplate}
          styleOverrides={styleOverrides}
          onStyleChange={updateStyle}
          onStyleReset={resetStyle}
          playing={playback.active}
          resumeId={item.id}
          pdfSupported={pdfSupported}
          retainedHtml={retainedPreviewRef.current}
          onRenderHtml={html => { retainedPreviewRef.current = html }}
          externalExportRef={paperExportRef}
          onExportState={setExportState}
          beforeExport={beforeExport}
        />
      </div>
    </div>

    {graphFilter && (
      <ResumeGraphModal
        resumes={resumes}
        defaultMasterTrackId={defaultMasterTrackId}
        opportunities={opportunities}
        currentId={item.id}
        timezone={config.timezone}
        template={templateChoice}
        style={effectiveStyle}
        initialFilter={graphFilter}
        busy={busy}
        onSelectVersion={id => onVersion(id)}
        onBranchMaster={async (id, title) => {
          const reply = await act('resume-branch-master', { id, title }, t('resume.toastBranchedMaster'))
          if (reply?.result?.id) onVersion(reply.result.id)
        }}
        onSetDefault={trackId => act('resume-set-default', { trackId }, t('resume.toastSetDefault'))}
        onRebase={handleRebaseBranch}
        onArchive={handleArchiveResume}
        onRestore={handleRestoreResume}
        onDeleteArchived={handleDeleteArchived}
        onClose={() => setGraphFilter('')}
      />
    )}
  </div>
}

function OnboardingModelCard({ config, busy, act }) {
  const { t } = useI18n()
  const models = useModels()
  const mainModel = config?.model || ''
  const reasoningEffort = config?.reasoningEffort || ''
  const defaultSystemRow = resolveDefaultModelRow(models.rows)
  const effectiveMainRow = (mainModel ? models.rows.find(r => r.route === mainModel) : null) ?? defaultSystemRow
  const mainDefaultOpt = React.useMemo(() => ({
    route: '',
    name: t('sources.modelFollowDsh'),
    provider: defaultSystemRow ? t('sources.modelCurrent', { name: defaultSystemRow.name }) : t('sources.modelAuto'),
  }), [defaultSystemRow, t])

  const changeModel = nextRoute => {
    if (busy || nextRoute === mainModel) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const chosen = nextRoute ? models.rows.find(r => r.route === nextRoute) : defaultSystemRow
    const nextEfforts = chosen?.reasoning?.efforts ?? []
    const keepEffort = !reasoningEffort || nextEfforts.some(e => e.id === reasoningEffort)
    const tabEffort = config?.tabReasoningEffort || ''
    const keepTabEffort = Boolean(config?.tabModel) || !tabEffort || nextEfforts.some(e => e.id === tabEffort)
    void runner(
      'configure',
      {
        config: {
          model: nextRoute,
          ...(keepEffort ? {} : { reasoningEffort: '' }),
          ...(keepTabEffort ? {} : { tabReasoningEffort: '' }),
        },
      },
      nextRoute
        ? t('sources.toastMainModelSet', { name: chosen?.name || nextRoute })
        : t('sources.toastMainModelFollow'),
    )
  }

  const changeReasoning = nextEffort => {
    if (busy || nextEffort === reasoningEffort) return
    const runner = typeof act?.background === 'function' ? act.background : act
    const chosen = effectiveMainRow?.reasoning?.efforts?.find(e => e.id === nextEffort)
    void runner(
      'configure',
      { config: { reasoningEffort: nextEffort } },
      nextEffort
        ? t('sources.toastReasoningSet', { name: chosen?.name || nextEffort })
        : t('sources.toastReasoningReset'),
    )
  }

  return <section className="ca-onboarding-model-card" data-surface="onboarding-model" aria-label={t('resume.onboardingModelTitle')}>
    <div className="ca-onboarding-model-label">
      <strong>{t('resume.onboardingModelTitle')}</strong>
      <span className="ca-info-tip" tabIndex={0} role="note" aria-label={t('resume.onboardingModelNote')}>
        <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7.3v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
        </svg>
        <span className="ca-info-tip-pop is-down" role="tooltip">
          {t('resume.onboardingModelNote')}
        </span>
      </span>
    </div>
    <div className="ca-onboarding-model-picker">
      <div className="ca-model-select-pair">
        <ModelSelectMenu
          value={mainModel}
          rows={models.rows}
          pending={models.pending}
          disabled={!!busy}
          defaultOption={mainDefaultOpt}
          ariaLabel={t('sources.mainModelAria')}
          placement="down"
          onChange={changeModel}
        />
        <ReasoningEffortMenu
          value={reasoningEffort}
          reasoning={effectiveMainRow?.reasoning}
          disabled={!!busy}
          placement="down"
          onChange={changeReasoning}
        />
      </div>
    </div>
  </section>
}

export default function Resume({ state, busy, act, silentAct, initialId, onSources, retainedPreviewRef, seedPrompt, onConsumeSeedPrompt, pendingTailor, onConsumeTailor, returnJob, onReturnToJob, onDismissReturnJob }) {
  const { t, locale } = useI18n()
  const [sheet, setSheet] = React.useState('')
  const resumeProfileKey = state.profileKey || getActiveProfileKey()
  const [selected, setSelectedState] = React.useState(() => {
    if (initialId) return initialId
    return readProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey }) || ''
  })
  React.useEffect(() => {
    if (!initialId) setSelectedState(readProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey }) || '')
  }, [resumeProfileKey, initialId])
  const setSelected = React.useCallback(id => {
    const next = id || ''
    setSelectedState(next)
    if (next) writeProfileLocal(SELECTED_RESUME_KEY, next, { profileKey: resumeProfileKey })
    else removeProfileLocal(SELECTED_RESUME_KEY, { profileKey: resumeProfileKey })
    if (next && returnJob?.id) {
      const targetRow = list(state.resumes).find(r => r.id === next)
      if (targetRow?.opportunityId && targetRow.opportunityId !== returnJob.id) {
        onDismissReturnJob?.()
      }
    }
  }, [returnJob?.id, state.resumes, onDismissReturnJob, resumeProfileKey])
  const [replaySeed, setReplaySeed] = React.useState(0)
  const [stagedPlayback, setStagedPlayback] = React.useState(null)
  const [agentDraftSeed, setAgentDraftSeed] = React.useState('')
  const canvas = React.useRef(null)
  const richEditor = React.useRef(null)
  const fallbackPreviewRef = React.useRef(null)
  const previewCacheRef = retainedPreviewRef ?? fallbackPreviewRef
  const onEditorReady = React.useCallback(editor => { richEditor.current = editor }, [])
  const agent = useResumeAgent(act, id => setSelected(id), state.activeOperations)
  const tailorTriggeredRef = React.useRef(0)

  React.useEffect(() => {
    if (initialId) setSelected(initialId)
  }, [initialId, setSelected])

  React.useEffect(() => {
    if (!pendingTailor?.id || pendingTailor.nonce === tailorTriggeredRef.current) return
    tailorTriggeredRef.current = pendingTailor.nonce
    const { id, label } = pendingTailor
    onConsumeTailor?.()
    void agent.tailor({ id, label })
  }, [pendingTailor, onConsumeTailor, agent])

  const evidence = list(state.evidence)
  const resumes = list(state.resumes)
  const reflections = list(state.reflections)
  const activeResumes = resumes.filter(row => !row.archivedAt && row.status !== 'revoked' && row.status !== 'rejected')
  // Default to the latest approved version unless a strictly newer pending draft exists.
  const latestApproved = activeResumes.findLast(row => row.status === 'approved')
  const latestOverall = activeResumes.at(-1)
  const defaultResume = latestOverall?.status === 'pending' && (!latestApproved || Date.parse(latestOverall.createdAt || '') > Date.parse(latestApproved.createdAt || ''))
    ? latestOverall
    : (latestApproved ?? latestOverall)
  const current = activeResumes.find(row => row.id === selected) ?? defaultResume

  React.useEffect(() => {
    if (current?.id) {
      writeProfileLocal(SELECTED_RESUME_KEY, current.id, { profileKey: resumeProfileKey })
    }
  }, [current?.id, resumeProfileKey])

  const activeSources = list(state.config?.sources)
  const isSourceUsable = item => {
    const entry = activeSources.find(s => s.id === item.sourceId)
    if (entry?.revokedAt) return false
    if (entry && (entry.projects?.includes('*') || entry.projects?.includes(item.projectId))) return true
    return item.sourceId === 'manual' && !entry
  }
  const pendingEvidence = evidence.filter(item => item.status === 'pending').toReversed()
  const shareableEvidence = evidence.filter(item => item.status === 'approved' && item.shareable && isSourceUsable(item))
  const resumeTree = React.useMemo(
    () => organizeResumeVersions(resumes, { defaultMasterTrackId: state.defaultMasterTrackId || '', opportunities: list(state.opportunities) }),
    [resumes, state.defaultMasterTrackId, state.opportunities],
  )
  const isViewingApprovedMaster = Boolean(current && current.status === 'approved' && !current.opportunityId && current.general !== false && current.kind !== 'tailored')
  const defaultMasterNode = resumeTree.masters.find(m => m.isDefault) ?? resumeTree.masters[0] ?? null
  const targetMasterForMerge = isViewingApprovedMaster
    ? current
    : (defaultMasterNode?.latestApproved ?? defaultMasterNode?.latest ?? activeResumes.findLast(row => !row.opportunityId && row.general !== false))
  const mergedEvidenceIds = new Set(Array.isArray(targetMasterForMerge?.evidenceIds) ? targetMasterForMerge.evidenceIds : [])
  const unmergedEvidence = shareableEvidence.filter(item => !mergedEvidenceIds.has(item.id)).toReversed()
  const unmergedCount = unmergedEvidence.length
  const hasSources = (state.config?.sources?.length > 0) || state.recordings?.sources?.some(row => row.enabled)

  const tailoredPlaybackToken = agent.activity?.phase === 'ready' && current?.id === agent.activity.version
    ? `${agent.activity.id}:${replaySeed}`
    : replaySeed > 0 && current?.kind === 'tailored' ? `replay:${current.id}:${replaySeed}` : null
  const parent = tailoredPlaybackToken && current?.baseId ? resumes.find(row => row.id === current.baseId) : null
  const tailoredBefore = parent ? displayResume(parent, resumes) : ''
  const tailoredSteps = React.useMemo(() => tailoredPlaybackToken && tailoredBefore && current ? buildResumePlayback({
    before: tailoredBefore,
    after: displayResume(current, resumes),
    items: current.items,
    variant: current.variant,
    locale,
    source: current.kind === 'tailored' ? t('resume.sourceJdTailorLabel') : '',
  }) : [], [tailoredPlaybackToken, tailoredBefore, current, resumes, locale, t])

  const activePlaybackToken = stagedPlayback?.token || tailoredPlaybackToken
  const activePlaybackBefore = stagedPlayback?.token ? stagedPlayback.before : tailoredBefore
  const activePlaybackSteps = stagedPlayback?.token ? stagedPlayback.steps : tailoredSteps
  const playback = useResumePlayback({
    token: activePlaybackToken,
    before: activePlaybackBefore,
    steps: activePlaybackSteps,
    canvasRef: canvas,
    resolveAnchor: ({ line }) => resolveRichEditorLine(richEditor.current, playback.text ?? activePlaybackBefore, line),
    onDone: () => {
      if (agent.activity?.phase === 'ready' && current?.id === agent.activity.version) {
        setReplaySeed(0)
        agent.dismiss()
      }
    },
  })

  const createBlankResume = async ({ withAgent = false } = {}) => {
    if (busy) return
    const md = buildBlankResumeMarkdown(locale)
    const reply = await act('resume-import', { title: t('resume.blankResumeTitle'), text: md }, t('resume.toastBlankCreated'))
    if (reply?.result?.id) {
      await act('resume-review', { id: reply.result.id, decision: 'approve' })
      if (withAgent) setAgentDraftSeed(t('resume.agentDraftStarterPrompt'))
      setSelected(reply.result.id)
    }
  }

  if (!current) {
    return <div className="ca-width ca-content">
      <AgentTailorBanner activity={agent.activity} onDismiss={agent.dismiss} />
      <section className="ca-resume-onboarding" data-surface="resume-onboarding">
        <OnboardingModelCard config={state.config} busy={busy} act={act} />
        <div className="ca-resume-onboarding-head is-split">
          <h2>{t('resume.emptyTitle')}</h2>
          <div className="ca-inline">
            {shareableEvidence.length > 0 && (
              <Button variant="primary" size="sm" disabled={!!busy} onClick={async () => {
                const reply = await act('resume-generate', {}, t('resume.toastGenerated'))
                if (reply?.result?.id) setSelected(reply.result.id)
              }}>{t('resume.generateFromEvidence', { count: shareableEvidence.length })}</Button>
            )}
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void createBlankResume({ withAgent: true })}>
              {t('resume.onboardingChatTitle')}
            </Button>
            <button type="button" className="ca-text-button ca-nowrap-btn" disabled={!!busy} onClick={() => void createBlankResume()}>
              {t('resume.skipToBlankEditor')}
            </button>
          </div>
        </div>
        <div className="ca-formbox">
          <ResumeForm busy={busy} act={act} onDone={id => setSelected(id)} />
        </div>
      </section>
    </div>
  }

  return <div className="ca-resume-canvas" ref={canvas}>
    {returnJob && (
      <div className="ca-return-job-bar" role="region" aria-label={t('resume.returnJobAria')}>
        <button type="button" className="ca-return-job-btn" onClick={onReturnToJob}>
          <span className="ca-return-job-arrow" aria-hidden="true">←</span>
          <span>{t('resume.returnJob')}</span>
          <CompanyAvatar company={returnJob.company} url={returnJob.url} size={18} />
          <strong className="ca-return-job-title">{[returnJob.company, returnJob.title].filter(Boolean).join(' · ')}</strong>
        </button>
        <button type="button" className="ca-return-job-close" aria-label={t('resume.hideReturnJobAria')} onClick={onDismissReturnJob}>×</button>
      </div>
    )}
    <ResumePlaybackCursor playback={playback} />
    <ResumeWorkbench
      item={current}
      resumes={resumes}
      defaultMasterTrackId={state.defaultMasterTrackId || ''}
      profileKey={resumeProfileKey}
      templates={list(state.resumeTemplates)}
      opportunities={list(state.opportunities)}
      config={state.config}
      capabilities={state.capabilities}
      act={act}
      silentAct={silentAct}
      busy={busy}
      onVersion={id => {
        agent.dismiss()
        setReplaySeed(0)
        setStagedPlayback(null)
        setSelected(id)
      }}
      agent={agent}
      playback={playback}
      onReplay={current.kind === 'tailored' && current.baseId ? () => { setStagedPlayback(null); setReplaySeed(v => v + 1) } : null}
      onTriggerStagedPlayback={setStagedPlayback}
      onEditorReady={onEditorReady}
      retainedPreviewRef={previewCacheRef}
      onOpenImport={() => setSheet('import')}
      onOpenLibrary={() => setSheet('library')}
      evidenceCountTotal={evidence.filter(e => ['pending', 'approved'].includes(e.status)).length + reflections.filter(r => ['pending', 'approved'].includes(r.status)).length}
      pendingEvidence={pendingEvidence}
      unmergedCount={unmergedCount}
      unmergedEvidence={unmergedEvidence}
      hasSources={hasSources}
      onSources={onSources}
      seedPrompt={agentDraftSeed || seedPrompt}
      onConsumeSeedPrompt={() => { setAgentDraftSeed(''); onConsumeSeedPrompt?.() }}
    />
    {sheet === 'import' && <SideSheet title={t('resume.importSheetTitle')} onClose={() => setSheet('')}>
      {({ dismiss }) => <div className="ca-sheet-body">
        <ResumeForm busy={busy} act={act} onDone={id => { setSelected(id); dismiss() }} />
      </div>}
    </SideSheet>}
    {sheet === 'library' && <LibrarySheet evidence={evidence} reflections={reflections}
      state={state} config={state.config} busy={busy} act={act}
      onResume={id => setSelected(id)} onSources={onSources} onClose={() => setSheet('')} />}
  </div>
}
