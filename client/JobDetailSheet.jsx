import React from 'react'
import { Button, Checkbox, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiTraceCard, useTrackedOperation } from './AiActivity.jsx'
import Composer, { resolveDefaultModelRoute, useModels } from './Composer.jsx'
import { CopyButton, SideSheet } from './Motion.jsx'
import { bucketIdOf, StageLogo } from './LifecycleMachine.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import { boardForSourceId, contextualBoardChannelLabel, extractCustomReceiptEvidence, localizeChangeLabel, opportunityOriginLabel, readableDate, receiptLabel, stageLabel } from './shared.js'
import { resolveDefaultHiringScope } from '../src/job-view-scope.mjs'
import { useI18n } from './i18n.jsx'
import { buildJobResumePickerModel } from '../src/resume-versions.mjs'
import { buildZonedDeadlineSlot, buildZonedQuickSlot, inspectZonedLocalTime, resolveActiveTimeZone, toZonedDatetimeInput, zonedLocalToIso } from '../src/timezone.mjs'
import { canonicalInterviewRoundKey, interviewGroupKey } from '../src/interview-identity.mjs'
import { usePersistedDraft } from './draft-hooks.jsx'
import { readProfileLocal } from './profile-storage.js'
import { AnnotatedJd } from './JobJdWorkbench.jsx'
import { ResumeMiniPaper, ResumeQuickLookModal, ResumeSelectMenu } from './ResumePreviewCards.jsx'

const ROUND_PRESET_KEYS = ['jobDetail.round1', 'jobDetail.round2', 'jobDetail.round3', 'jobDetail.roundFinal', 'jobDetail.roundHr']
const DURATION_OPTIONS = [
  { minutes: 45, labelKey: 'jobDetail.dur45' },
  { minutes: 60, labelKey: 'jobDetail.dur60' },
  { minutes: 90, labelKey: 'jobDetail.dur90' },
]

const STEP_SPECS = [
  { id: 'saved', labelKey: 'bucket.stepSaved', tone: 'indigo', stages: new Set(['discovered', 'opened', 'prepared']) },
  { id: 'applied', labelKey: 'bucket.stepApplied', tone: 'blue', stages: new Set(['contacted', 'resume_sent', 'submitted', 'acknowledged']) },
  { id: 'interview', labelKey: 'bucket.stepInterview', tone: 'violet', stages: new Set(['invited', 'interview_confirmed', 'interview_completed']) },
  { id: 'offer', labelKey: 'bucket.stepOffer', tone: 'emerald', stages: new Set(['offer_received', 'offer_accepted', 'started']) },
]

function stepIndexOf(stage) {
  const idx = STEP_SPECS.findIndex(step => step.stages.has(stage))
  return idx >= 0 ? idx : 0
}

function destLabel(dest, t) {
  if (!dest) return ''
  const key = `destination.${dest}`
  const res = t(key)
  return res === key ? dest : res
}

function validatedLink(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function downloadText(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

function defaultInterviewTimes(timeZone) {
  return buildZonedQuickSlot(1, 14, 0, 60, timeZone)
}

function nextRoundSuggestion(receipts = [], t) {
  const rounds = receipts.map(r => String(r.round || '').trim()).filter(Boolean)
  if (!rounds.length) return t('jobDetail.round1')
  const latest = rounds[0]
  if (latest.includes('一') || /round\s*1|1st/i.test(latest)) return t('jobDetail.round2')
  if (latest.includes('二') || /round\s*2|2nd/i.test(latest)) return t('jobDetail.round3')
  if (latest.includes('三') || /round\s*3|3rd/i.test(latest)) return t('jobDetail.roundFinal')
  if (latest.includes('终') || /final/i.test(latest)) return t('jobDetail.roundHr')
  return t('jobDetail.roundNext')
}

function defaultEvidenceFor(type, item, values = {}, t) {
  const company = item?.company || t('jobDetail.targetCompany')
  const round = values.round || t('jobs.defaultInterview')
  const form = values.form === 'verbal' ? t('composer.offerVerbal') : t('composer.offerWritten')
  switch (type) {
    case 'application_submitted': return t('jobDetail.evSubmitted', { company })
    case 'application_acknowledged': return t('jobDetail.evAcknowledged', { company })
    case 'contact_sent': return t('jobDetail.evContacted', { company })
    case 'resume_sent': return t('jobDetail.evResumeSent', { company })
    case 'interview_invited': return t('jobDetail.evInvited', { round, company })
    case 'interview_confirmed': return t('jobDetail.evConfirmed', { round, company })
    case 'interview_completed': return t('jobDetail.evCompleted', { round, company })
    case 'offer_received': return t('jobDetail.evOffer', { form, company })
    case 'offer_accepted': return t('jobDetail.evOfferAccepted', { company })
    case 'offer_declined': return t('jobDetail.evOfferDeclined', { company })
    case 'started': return t('jobDetail.evStarted', { company })
    case 'rejected': return t('jobDetail.evRejected', { company })
    case 'withdrawn': return t('jobDetail.evWithdrawn', { company })
    default: return t('jobDetail.evDefault', { company })
  }
}

function formatMaterialLabel(choice) {
  if (!choice) return ''
  return choice.versionTag ? `${choice.title} ${choice.versionTag}` : choice.title
}

function QuickReceiptForm({ item, preset, existingReceipts = [], resumeChoices = [], defaultMaterial, connectedApps = [], timezone, act, busy, onDone }) {
  const { t, locale } = useI18n()
  const activeTz = React.useMemo(() => resolveActiveTimeZone(timezone), [timezone])
  const approvedChoices = React.useMemo(
    () => (Array.isArray(resumeChoices) ? resumeChoices.filter(r => r?.status === 'approved') : []),
    [resumeChoices],
  )
  const roundPresets = React.useMemo(() => ROUND_PRESET_KEYS.map(k => t(k)), [t])
  const defaultRound = t('jobDetail.round1')
  const defaults = React.useMemo(() => defaultInterviewTimes(activeTz), [activeTz])
  const [durationMin, setDurationMin] = React.useState(60)
  const [showCustomTime, setShowCustomTime] = React.useState(false)
  const [sessionMode, setSessionMode] = React.useState(() => (preset?.reschedule ? 'reschedule' : 'new'))
  const [disambig, setDisambig] = React.useState({ startsAt: 'earlier', endsAt: 'earlier', replyBy: 'earlier' })
  const [formErr, setFormErr] = React.useState('')

  const initialResumeChoice = React.useMemo(() => {
    if (preset?.materialKind === 'external') return null
    if (preset?.materialId) return approvedChoices.find(r => r.id === preset.materialId) ?? null
    return approvedChoices[0] ?? null
  }, [preset?.materialId, preset?.materialKind, approvedChoices])

  const [values, setValues] = React.useState(() => ({
    type: preset?.type || 'interview_confirmed',
    evidence: preset?.evidence || '',
    material: preset?.material || (initialResumeChoice ? formatMaterialLabel(initialResumeChoice) : defaultMaterial || ''),
    materialId: preset?.materialKind === 'external' ? '' : (preset?.materialId || initialResumeChoice?.id || ''),
    materialVersion: preset?.materialKind === 'external' ? '' : (preset?.materialVersion || initialResumeChoice?.versionTag || ''),
    materialKind: preset?.materialKind || (initialResumeChoice ? 'resume' : (approvedChoices.length === 0 ? 'external' : 'resume')),
    round: preset?.round || defaultRound,
    interviewId: preset?.interviewId || '',
    startsAt: preset?.startsAt || defaults.startsAt,
    endsAt: preset?.endsAt || defaults.endsAt,
    location: preset?.location || '',
    form: preset?.form || 'written',
    replyBy: preset?.replyBy || '',
    notes: preset?.notes || '',
  }))

  React.useEffect(() => {
    if (!preset) return
    const matchedApproved = preset.materialKind === 'external'
      ? null
      : (preset.materialId ? approvedChoices.find(r => r.id === preset.materialId) : approvedChoices[0]) ?? null
    setFormErr('')
    setSessionMode(preset.reschedule ? 'reschedule' : 'new')
    setDisambig({ startsAt: 'earlier', endsAt: 'earlier', replyBy: 'earlier' })
    setValues(cur => ({
      ...cur,
      type: preset.type || cur.type,
      round: preset.round || cur.round || defaultRound,
      interviewId: preset.interviewId ?? '',
      evidence: preset.evidence ?? '',
      notes: preset.notes ?? '',
      material: preset.material || (matchedApproved ? formatMaterialLabel(matchedApproved) : (defaultMaterial || cur.material)),
      materialId: preset.materialKind === 'external' ? '' : (preset.materialId || matchedApproved?.id || ''),
      materialVersion: preset.materialKind === 'external' ? '' : (preset.materialVersion || matchedApproved?.versionTag || ''),
      materialKind: preset.materialKind || (matchedApproved ? 'resume' : 'external'),
      location: preset.location ?? cur.location,
      ...(preset.startsAt ? { startsAt: preset.startsAt } : {}),
      ...(preset.endsAt ? { endsAt: preset.endsAt } : {}),
    }))
    setShowCustomTime(Boolean(preset.startsAt))
  }, [preset, approvedChoices, defaultMaterial, defaultRound])

  const startInspect = React.useMemo(
    () => (values.type === 'interview_confirmed' && values.startsAt ? inspectZonedLocalTime(values.startsAt, activeTz) : null),
    [values.type, values.startsAt, activeTz],
  )
  const endInspect = React.useMemo(
    () => (values.type === 'interview_confirmed' && values.endsAt ? inspectZonedLocalTime(values.endsAt, activeTz) : null),
    [values.type, values.endsAt, activeTz],
  )
  const replyInspect = React.useMemo(
    () => (values.type === 'offer_received' && values.replyBy ? inspectZonedLocalTime(values.replyBy, activeTz) : null),
    [values.type, values.replyBy, activeTz],
  )
  const hasNonexistentDst = startInspect?.status === 'nonexistent'
    || endInspect?.status === 'nonexistent'
    || replyInspect?.status === 'nonexistent'

  const change = key => event => {
    const val = event.target.value
    setFormErr('')
    setValues(v => {
      if (key === 'startsAt' && val) {
        const info = inspectZonedLocalTime(val, activeTz)
        if (info.status === 'valid' || info.status === 'ambiguous') {
          const startMs = Date.parse(info.iso)
          if (Number.isFinite(startMs)) {
            return { ...v, startsAt: val, endsAt: toZonedDatetimeInput(new Date(startMs + durationMin * 60 * 1000), activeTz) }
          }
        }
      }
      return { ...v, [key]: val }
    })
  }

  const applySuggestedDst = (fieldKey, suggestedLocal) => {
    setFormErr('')
    setValues(v => {
      if (fieldKey === 'startsAt') {
        const startMs = Date.parse(zonedLocalToIso(suggestedLocal, activeTz))
        return {
          ...v,
          startsAt: suggestedLocal,
          ...(Number.isFinite(startMs) ? { endsAt: toZonedDatetimeInput(new Date(startMs + durationMin * 60 * 1000), activeTz) } : {}),
        }
      }
      return { ...v, [fieldKey]: suggestedLocal }
    })
  }

  const pickSlot = (daysAhead, hour) => {
    const slot = buildZonedQuickSlot(daysAhead, hour, 0, durationMin, activeTz)
    setFormErr('')
    setValues(v => ({ ...v, startsAt: slot.startsAt, endsAt: slot.endsAt }))
    setShowCustomTime(false)
  }

  const pickDuration = minutes => {
    setDurationMin(minutes)
    const startMs = Date.parse(zonedLocalToIso(values.startsAt, activeTz, { disambiguation: disambig.startsAt }))
    if (Number.isFinite(startMs)) {
      setValues(v => ({ ...v, endsAt: toZonedDatetimeInput(new Date(startMs + minutes * 60 * 1000), activeTz) }))
    }
  }

  const { type } = values
  const interview = type.startsWith('interview_')
  const isEditingReceipt = Boolean(preset?.editReceiptId)
  const isExplicitReschedule = Boolean(preset?.reschedule)
  const sameRoundConfirmed = React.useMemo(() => {
    if (type !== 'interview_confirmed' || isEditingReceipt || isExplicitReschedule) return null
    const canon = canonicalInterviewRoundKey(values.round || defaultRound)
    const rows = (Array.isArray(existingReceipts) ? existingReceipts : [])
      .filter(r => r?.type === 'interview_confirmed' && canonicalInterviewRoundKey(r.round) === canon)
      .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''))
    return rows[0] ?? null
  }, [type, isEditingReceipt, isExplicitReschedule, values.round, defaultRound, existingReceipts])
  const sameRoundUpcoming = Boolean(sameRoundConfirmed?.endsAt && Date.parse(sameRoundConfirmed.endsAt) > Date.now())
  const quickSlots = [
    { id: 't10', label: t('jobDetail.slotT10'), days: 1, hour: 10 },
    { id: 't14', label: t('jobDetail.slotT14'), days: 1, hour: 14 },
    { id: 't16', label: t('jobDetail.slotT16'), days: 1, hour: 16 },
    { id: 'd214', label: t('jobDetail.slotD214'), days: 2, hour: 14 },
  ]

  const submit = async event => {
    event.preventDefault()
    if (hasNonexistentDst) {
      setFormErr(t('jobDetail.dstGapWarning', {
        tz: activeTz,
        time: (startInspect?.status === 'nonexistent' ? startInspect : endInspect?.status === 'nonexistent' ? endInspect : replyInspect)?.localStr || '',
        suggested: (startInspect?.status === 'nonexistent' ? startInspect : endInspect?.status === 'nonexistent' ? endInspect : replyInspect)?.suggestedLocal || '',
      }))
      return
    }
    setFormErr('')
    if (isEditingReceipt) {
      const matText = values.material.trim() || defaultMaterial || t('common.defaultResume')
      const reply = await act('receipt-update', {
        id: preset.editReceiptId,
        material: matText,
        materialId: values.materialKind === 'external' ? '' : (values.materialId || ''),
        materialVersion: values.materialKind === 'external' ? '' : (values.materialVersion || ''),
        materialKind: values.materialKind,
        notes: values.notes.trim(),
      }, t('jobDetail.toastReceiptUpdated'))
      if (reply?.ok) {
        onDone(reply.result)
      } else {
        setFormErr(reply?.error || (typeof act?.getLastError === 'function' ? act.getLastError() : '') || t('jobDetail.saveFailedRetry'))
      }
      return
    }
    const cleanEvidence = values.evidence.trim() || defaultEvidenceFor(type, item, values, t)
    const receipt = {
      id: crypto.randomUUID(),
      opportunityId: item.id,
      type,
      source: 'manual',
      occurredAt: new Date().toISOString(),
      confirmed: true,
      evidence: cleanEvidence,
      ...(values.notes.trim() && { notes: values.notes.trim() }),
    }
    if (type === 'application_submitted' || type === 'resume_sent') {
      receipt.material = values.material.trim() || defaultMaterial || t('common.defaultResume')
      receipt.materialKind = values.materialKind === 'external' ? 'external' : 'resume'
      if (receipt.materialKind === 'resume' && values.materialId) {
        receipt.materialId = values.materialId
        if (values.materialVersion) receipt.materialVersion = values.materialVersion
      }
    }
    if (interview) {
      receipt.round = values.round.trim() || defaultRound
      if (isExplicitReschedule) {
        if (values.interviewId) receipt.interviewId = values.interviewId
      } else if (type === 'interview_confirmed' && sameRoundConfirmed) {
        if (sessionMode === 'reschedule' && sameRoundUpcoming) {
          if (sameRoundConfirmed.interviewId) receipt.interviewId = sameRoundConfirmed.interviewId
        } else {
          receipt.interviewId = receipt.id
          receipt.isNewSession = true
        }
      } else if (values.interviewId) {
        receipt.interviewId = values.interviewId
      }
    }
    if (type === 'interview_confirmed') {
      receipt.startsAt = zonedLocalToIso(values.startsAt, activeTz, { disambiguation: disambig.startsAt })
      receipt.endsAt = zonedLocalToIso(values.endsAt, activeTz, { disambiguation: disambig.endsAt })
      receipt.location = values.location.trim()
    }
    if (type === 'offer_received') {
      receipt.form = values.form
      if (values.replyBy) receipt.replyBy = zonedLocalToIso(values.replyBy, activeTz, { disambiguation: disambig.replyBy })
    }
    const toast = type === 'interview_confirmed' && connectedApps.length > 0
      ? t('jobDetail.toastSavedInterview')
      : t('jobDetail.toastRecorded', { label: receiptLabel(type, t) || t('jobDetail.newProgress') })
    const reply = await act('receipt', { receipt }, toast)
    if (reply?.ok) {
      onDone(receipt)
    } else {
      setFormErr(reply?.error || (typeof act?.getLastError === 'function' ? act.getLastError() : '') || t('jobDetail.saveFailedRetry'))
    }
  }

  return <form className="ca-progress-form-card" onSubmit={submit}>
    <div className="ca-progress-form-head">
      <strong>{isEditingReceipt ? t('jobDetail.editReceiptTitle') : (receiptLabel(type, t) || t('jobDetail.recordProgress'))}</strong>
      <button type="button" className="ca-text-button" onClick={() => onDone(null)}>{t('common.collapse')}</button>
    </div>

    {(type === 'application_submitted' || type === 'resume_sent') && (
      <div className="ca-progress-form-block">
        <span className="ca-progress-form-label">{t('jobDetail.resumeUsed')}</span>
        <div className="ca-quick-chip-group">
          {approvedChoices.slice(0, 6).map(r => {
            const label = formatMaterialLabel(r)
            const active = values.materialKind !== 'external' && values.materialId === r.id
            return <button key={r.id} type="button"
              className={`ca-target-pill${active ? ' is-active' : ''}`}
              onClick={() => setValues(v => ({
                ...v,
                materialKind: 'resume',
                materialId: r.id,
                materialVersion: r.versionTag || '',
                material: label,
              }))}>
              {r.isTailored ? '★ ' : ''}{label}
            </button>
          })}
          <button type="button"
            className={`ca-target-pill${values.materialKind === 'external' ? ' is-active' : ''}`}
            onClick={() => setValues(v => ({
              ...v,
              materialKind: 'external',
              materialId: '',
              materialVersion: '',
              material: v.materialKind === 'external' ? v.material : '',
            }))}>
            {t('jobDetail.externalFileOption')}
          </button>
        </div>
        {values.materialKind === 'external' && (
          <input style={{ marginTop: '6px' }} required value={values.material} onChange={change('material')}
            placeholder={t('jobDetail.externalFilePlaceholder')} />
        )}
        {approvedChoices.length === 0 && values.materialKind !== 'external' && (
          <p className="ca-meta" style={{ marginTop: '6px' }}>{t('jobDetail.needApprovedBeforeSubmit')}</p>
        )}
      </div>
    )}

    {interview && (
      <div className="ca-progress-form-block">
        <span className="ca-progress-form-label">{t('jobDetail.interviewRound')}</span>
        <div className="ca-quick-chip-group">
          {roundPresets.map(r => (
            <button key={r} type="button"
              className={`ca-target-pill${values.round === r ? ' is-active' : ''}`}
              onClick={() => setValues(v => ({ ...v, round: r }))}>
              {r}
            </button>
          ))}
          <input className="ca-inline-round-input" value={values.round} onChange={change('round')}
            placeholder={t('jobDetail.customRoundPlaceholder')} aria-label={t('jobDetail.customRoundAria')} />
        </div>
        {isExplicitReschedule && (
          <p className="ca-meta" style={{ marginTop: '6px' }}>{t('jobDetail.rescheduleModeHint', { round: values.round || defaultRound })}</p>
        )}
        {type === 'interview_confirmed' && !isExplicitReschedule && sameRoundConfirmed && (
          <div className="ca-quick-chip-group" style={{ marginTop: '6px' }}>
            <button type="button"
              className={`ca-target-pill${sessionMode !== 'reschedule' ? ' is-active' : ''}`}
              onClick={() => setSessionMode('new')}>
              {t('jobDetail.newIndependentSession')}
            </button>
            {sameRoundUpcoming && (
              <button type="button"
                className={`ca-target-pill${sessionMode === 'reschedule' ? ' is-active' : ''}`}
                onClick={() => setSessionMode('reschedule')}>
                {t('jobDetail.rescheduleExistingRound', { round: values.round || defaultRound })}
              </button>
            )}
          </div>
        )}
      </div>
    )}

    {type === 'interview_confirmed' && <>
      <div className="ca-progress-form-block">
        <span className="ca-progress-form-label">{t('jobDetail.interviewTime')} ({activeTz})</span>
        <div className="ca-quick-chip-group">
          {quickSlots.map(slot => {
            const candidate = buildZonedQuickSlot(slot.days, slot.hour, 0, durationMin, activeTz)
            const active = !showCustomTime && values.startsAt === candidate.startsAt
            return <button key={slot.id} type="button"
              className={`ca-target-pill${active ? ' is-active' : ''}`}
              onClick={() => pickSlot(slot.days, slot.hour)}>
              {slot.label}
            </button>
          })}
          <button type="button" className={`ca-target-pill${showCustomTime ? ' is-active' : ''}`}
            onClick={() => setShowCustomTime(v => !v)}>
            {t('jobDetail.customTime')}
          </button>
        </div>
        <div className="ca-quick-chip-group" style={{ marginTop: '6px' }}>
          <span className="ca-meta">{t('jobDetail.duration')}</span>
          {DURATION_OPTIONS.map(opt => (
            <button key={opt.minutes} type="button"
              className={`ca-target-pill${durationMin === opt.minutes ? ' is-active' : ''}`}
              onClick={() => pickDuration(opt.minutes)}>
              {t(opt.labelKey)}
            </button>
          ))}
          {!showCustomTime && values.startsAt && (
            <span className="ca-meta" style={{ marginLeft: 'auto' }}>
              {t('jobDetail.selectedTime', { time: readableDate(zonedLocalToIso(values.startsAt, activeTz), activeTz, locale) })}
            </span>
          )}
        </div>
        {showCustomTime && (
          <div className="ca-fields" style={{ marginTop: '8px' }}>
            <label>{t('jobDetail.startTime')} ({activeTz})<input type="datetime-local" required value={values.startsAt} onChange={change('startsAt')} /></label>
            <label>{t('jobDetail.endTime')} ({activeTz})<input type="datetime-local" required value={values.endsAt} onChange={change('endsAt')} /></label>
          </div>
        )}
        {startInspect?.status === 'nonexistent' && (
          <div className="ca-form-error" role="alert" style={{ marginTop: '6px' }}>
            <span>{t('jobDetail.dstGapWarning', { tz: activeTz, time: startInspect.localStr, suggested: startInspect.suggestedLocal })}</span>{' '}
            <button type="button" className="ca-text-button" onClick={() => applySuggestedDst('startsAt', startInspect.suggestedLocal)}>
              {t('jobDetail.dstUseSuggested', { time: startInspect.suggestedLocal })}
            </button>
          </div>
        )}
        {startInspect?.status === 'ambiguous' && (
          <div className="ca-quick-chip-group" style={{ marginTop: '6px' }}>
            <span className="ca-meta">{t('jobDetail.dstAmbiguousPrompt', { tz: activeTz, time: startInspect.localStr })}</span>
            {startInspect.options.map((opt, idx) => {
              const mode = idx === 0 ? 'earlier' : 'later'
              return <button key={opt.iso} type="button"
                className={`ca-target-pill${disambig.startsAt === mode ? ' is-active' : ''}`}
                onClick={() => setDisambig(d => ({ ...d, startsAt: mode }))}>
                {opt.offsetLabel}
              </button>
            })}
          </div>
        )}
        {endInspect?.status === 'nonexistent' && (
          <div className="ca-form-error" role="alert" style={{ marginTop: '6px' }}>
            <span>{t('jobDetail.dstGapWarning', { tz: activeTz, time: endInspect.localStr, suggested: endInspect.suggestedLocal })}</span>{' '}
            <button type="button" className="ca-text-button" onClick={() => applySuggestedDst('endsAt', endInspect.suggestedLocal)}>
              {t('jobDetail.dstUseSuggested', { time: endInspect.suggestedLocal })}
            </button>
          </div>
        )}
      </div>
      <label className="ca-sheet-field">
        <span>{t('jobDetail.meetingLocation')}</span>
        <input value={values.location} onChange={change('location')} placeholder={t('jobDetail.meetingPlaceholder')} />
      </label>
    </>}

    {type === 'offer_received' && <>
      <div className="ca-progress-form-block">
        <span className="ca-progress-form-label">{t('jobDetail.offerForm')}</span>
        <div className="ca-quick-chip-group">
          <button type="button" className={`ca-target-pill${values.form === 'written' ? ' is-active' : ''}`}
            onClick={() => setValues(v => ({ ...v, form: 'written' }))}>{t('followups.writtenOffer')}</button>
          <button type="button" className={`ca-target-pill${values.form === 'verbal' ? ' is-active' : ''}`}
            onClick={() => setValues(v => ({ ...v, form: 'verbal' }))}>{t('followups.verbalOffer')}</button>
        </div>
      </div>
      <div className="ca-progress-form-block">
        <span className="ca-progress-form-label">{t('jobDetail.replyDeadline')} ({activeTz})</span>
        {(() => {
          const deadline3 = buildZonedDeadlineSlot(3, activeTz)
          const deadline7 = buildZonedDeadlineSlot(7, activeTz)
          return <div className="ca-quick-chip-group">
            <button type="button" className={`ca-target-pill${values.replyBy === deadline3 ? ' is-active' : ''}`}
              onClick={() => setValues(v => ({ ...v, replyBy: deadline3 }))}>{t('jobDetail.in3Days')}</button>
            <button type="button" className={`ca-target-pill${values.replyBy === deadline7 ? ' is-active' : ''}`}
              onClick={() => setValues(v => ({ ...v, replyBy: deadline7 }))}>{t('jobDetail.in7Days')}</button>
            <button type="button" className={`ca-target-pill${!values.replyBy ? ' is-active' : ''}`}
              onClick={() => setValues(v => ({ ...v, replyBy: '' }))}>{t('jobDetail.noDeadline')}</button>
            <input type="datetime-local" className="ca-inline-date-input" value={values.replyBy} onChange={change('replyBy')} aria-label={t('jobDetail.customDeadlineAria')} />
          </div>
        })()}
      </div>
    </>}

    <label className="ca-sheet-field">
      <span>{t('jobDetail.notesOptional')}</span>
      <input value={values.notes} onChange={change('notes')}
        placeholder={type === 'offer_received' ? t('jobDetail.offerNotesPlaceholder') : t('jobDetail.generalNotesPlaceholder')} />
    </label>

    {formErr && <p className="ca-form-error" role="alert">{formErr}</p>}

    <div className="ca-progress-form-foot">
      <div className="ca-inline">
        <Button variant="ghost" size="sm" onClick={() => onDone(null)}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" size="sm" disabled={!!busy || hasNonexistentDst}>
          {isEditingReceipt ? t('common.saveChanges')
            : type === 'interview_confirmed'
              ? (connectedApps.length > 0 ? t('jobDetail.saveAndSyncSchedule') : t('jobDetail.saveInterviewTime'))
              : type === 'offer_received' ? t('jobDetail.recordOffer') : t('jobDetail.saveProgress')}
        </Button>
      </div>
    </div>
  </form>
}

function ManualDebriefPanel({ item, config, act, busy, onDone }) {
  const { t } = useI18n()
  const latestRound = [...(item.receipts ?? [])].reverse().find(r => r.round)?.round || ''
  const [round, setRound, clearRound] = usePersistedDraft(`debrief:${item.id}:round`, latestRound || t('jobDetail.round1'))
  const [sourceRef, setSourceRef, clearSourceRef] = usePersistedDraft(`debrief:${item.id}:source`, t('jobDetail.defaultSourceNotes'))
  const [text, setText, clearText] = usePersistedDraft(`debrief:${item.id}:text`, '')
  const [consent, setConsent] = React.useState(true)
  const [fileErr, setFileErr] = React.useState('')
  const fileRef = React.useRef(null)
  const catalog = useModels()
  const model = config?.model || resolveDefaultModelRoute(catalog.rows)

  const submit = async event => {
    event.preventDefault()
    if (!text.trim() || !round.trim() || !consent) return
    const reply = await act('debrief', {
      id: item.id,
      projectId: 'personal',
      explicitManual: true,
      round: round.trim(),
      text: text.trim(),
      sourceRef: sourceRef.trim() || t('jobDetail.defaultSourceNotes'),
      consent: true,
      ...(config?.model && { model: config.model }),
    }, t('jobDetail.toastDebriefGenerated'))
    if (reply?.ok) {
      clearText()
      clearRound()
      clearSourceRef()
      onDone?.()
    }
  }

  return <form className="ca-form ca-formbox" onSubmit={submit}>
    <div className="ca-fields">
      <label>{t('jobDetail.interviewRound')}<input required value={round} onChange={e => setRound(e.target.value)} placeholder={t('jobDetail.debriefRoundPlaceholder')} /></label>
      <label>{t('jobDetail.debriefSourceLabel')}<input value={sourceRef} onChange={e => setSourceRef(e.target.value)} placeholder={t('jobDetail.debriefSourcePlaceholder')} /></label>
    </div>
    <label>
      <span>{t('jobDetail.debriefPasteLabel')}</span>
      <textarea rows="6" required maxLength={24000} value={text} onChange={e => setText(e.target.value)}
        placeholder={t('jobDetail.debriefPastePlaceholder')} />
    </label>
    <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={async e => {
      const file = e.currentTarget.files?.[0]
      e.currentTarget.value = ''
      if (!file) return
      setFileErr('')
      try {
        if (file.size > 200_000) throw new Error()
        const body = await file.text()
        if (!body.trim()) throw new Error()
        setText(body.slice(0, 24000))
        setSourceRef(file.name)
      } catch { setFileErr(t('jobDetail.debriefFileError')) }
    }} />
    {fileErr && <p className="ca-form-error">{fileErr}</p>}
    <Checkbox checked={consent} onChange={setConsent} label={t('jobDetail.debriefConsent')} />
    <div className="ca-form-actions ca-import-actions">
      <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>{t('jobDetail.uploadTranscript')}</Button>
      <Button type="submit" variant="primary" size="sm" disabled={!!busy || !text.trim() || !round.trim() || !consent || !model}>
        {busy === 'debrief' ? <><StateDot state="ongoing" size={11} /> {t('jobDetail.generatingDebrief')}</> : t('jobDetail.generateAiDebrief')}
      </Button>
    </div>
  </form>
}


function DebriefSourceViewer({ note }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const label = note.sourceRef || (note.recordingId ? t('jobDetail.sourceRecording') : t('jobDetail.sourceManual'))
  const raw = typeof note.rawTranscript === 'string' ? note.rawTranscript.trim() : ''
  return <div className="ca-debrief-source">
    <button type="button" className="ca-debrief-source-btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span>{t('jobDetail.sourceLine', { label })}</span>
      <span className="ca-debrief-source-action">{open ? t('jobDetail.hideSource') : t('jobDetail.showSource')}</span>
    </button>
    {open && (
      <div className="ca-debrief-raw">
        {raw ? <>
          <div className="ca-debrief-raw-head">
            <span className="ca-meta">{note.recordingId ? t('jobDetail.rawRecording') : t('jobDetail.rawManualNotes')}</span>
            <CopyButton text={raw} label={t('jobDetail.copyRaw')} />
          </div>
          <pre className="ca-debrief-raw-body">{raw}</pre>
        </> : (
          <p className="ca-meta">{t('jobDetail.legacyDebriefNote')}</p>
        )}
      </div>
    )}
  </div>
}

const JD_HYDRATE_ATTEMPTED = new Set()

function canHydrateJobJd(job) {
  return Boolean((job?.detailProvider && job.detailProvider !== 'manual') || (job?.provider && job.provider !== 'manual'))
}

function resolveInitialSection(job, preferred) {
  if (preferred === 'jd' || preferred === 'progress' || preferred === 'debrief') return preferred
  return (job?.jd || (canHydrateJobJd(job) && !job?.closedAt)) ? 'jd' : 'progress'
}


function JobLinkedRecordings({ recordings, job, config, defaultRound, busy, act }) {
  const { t, formatDate } = useI18n()
  const catalog = useModels()
  const [roundById, setRoundById] = React.useState({})
  const model = config?.model || resolveDefaultModelRoute(catalog.rows)

  if (!recordings.length) return null

  return <section className="ca-job-recordings" data-surface="job-recordings" aria-label={t('recordings.sectionTitle')}>
    <div className="ca-section-head">
      <h4>{t('jobDetail.linkedRecordingsTitle')}</h4>
      <Tag tone="info">{t('recordings.readyCount', { count: recordings.length })}</Tag>
    </div>
    <div className="ca-recording-list">
      {recordings.map(item => {
        const roundVal = item.round?.trim() || (roundById[item.id] ?? defaultRound ?? '')
        const time = formatDate(item.occurredAt, { timezone: config?.timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        const detail = [item.sourceName, time, item.round].filter(Boolean).join(' · ')
        const canGenerate = !busy && item.available !== false && Boolean(roundVal.trim()) && Boolean(model)
        return <article key={item.id} className="ca-recording-item">
          <div className="ca-recording-row">
            <span className="ca-recording-icon" aria-hidden="true"><i /><i /><i /></span>
            <div className="ca-recording-main">
              <div className="ca-inline">
                <strong>{item.title || [job.company, job.title].filter(Boolean).join(' · ') || t('recordings.defaultTitle')}</strong>
                <StateDot state={item.available === false ? 'warning' : 'done'} size={7} />
              </div>
              {detail && <p className="ca-meta">{detail}</p>}
              {item.available === false && <p className="ca-meta">{t('recordings.sourceUnavailable')}</p>}
              {!item.round && item.available !== false && (
                <input
                  className="ca-job-rec-round-input"
                  value={roundVal}
                  maxLength={100}
                  disabled={!!busy}
                  placeholder={t('recordings.roundPlaceholder')}
                  aria-label={t('recordings.round')}
                  onChange={e => setRoundById(cur => ({ ...cur, [item.id]: e.target.value }))}
                />
              )}
              {!catalog.pending && !model && item.available !== false && (
                <p className="ca-form-error">{t('recordings.needModel')}</p>
              )}
            </div>
            <div className="ca-inline">
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => act('recording-dismiss', { id: item.id }, t('recordings.toastDismissed'))}>
                {t('common.dismiss')}
              </Button>
              {item.available !== false && (
                <Button variant="primary" size="sm" disabled={!canGenerate}
                  onClick={() => act('recording-debrief', { id: item.id, opportunityId: job.id, round: roundVal.trim(), ...(config?.model && { model: config.model }) }, t('recordings.toastSaved'))}>
                  {busy === 'recording-debrief' ? t('recordings.generating') : t('recordings.generateDebrief')}
                </Button>
              )}
            </div>
          </div>
        </article>
      })}
    </div>
  </section>
}

export default function JobDetailSheet({
  job, initialSection = '', state, busy, act, onClose, onResume, onTailorJob, onResumeWithPrompt, onSources, onStartSession,
}) {
  const { t, locale } = useI18n()
  const [section, setSection] = React.useState(() => resolveInitialSection(job, initialSection))
  const [receiptPreset, setReceiptPreset] = React.useState(null)
  const [quickLookResume, setQuickLookResume] = React.useState(null)
  const [showManualDebrief, setShowManualDebrief] = React.useState(false)
  const [showOlderResumes, setShowOlderResumes] = React.useState(false)
  const [selectedResumeId, setSelectedResumeId] = React.useState('')
  const [pendingApplyDraft, setPendingApplyDraft] = React.useState(null)
  const [justCompletedRound, setJustCompletedRound] = React.useState('')
  const [confirmClearProgress, setConfirmClearProgress] = React.useState(false)
  const [clearedUndoSnapshot, setClearedUndoSnapshot] = React.useState(null)
  const [jdHydrating, setJdHydrating] = React.useState(false)
  const progressRef = React.useRef(null)
  const tailorOp = useTrackedOperation(act, {
    scopeKey: job?.id ? `tailor:${job.id}` : '',
    nonBlocking: true,
    serverOps: state.activeOperations,
  })
  const uid = React.useId()

  React.useEffect(() => {
    setSection(resolveInitialSection(job, initialSection))
    setReceiptPreset(null)
    setQuickLookResume(null)
    setShowManualDebrief(false)
    setShowOlderResumes(false)
    setSelectedResumeId('')
    setPendingApplyDraft(null)
    setJustCompletedRound('')
    setConfirmClearProgress(false)
    setClearedUndoSnapshot(null)
    setJdHydrating(false)
  }, [job?.id, initialSection])

  const hydrateJobJd = React.useCallback(async (force = false) => {
    if (!job?.id || !canHydrateJobJd(job)) return
    if (!force && JD_HYDRATE_ATTEMPTED.has(job.id)) return
    JD_HYDRATE_ATTEMPTED.add(job.id)
    setJdHydrating(true)
    try {
      const runner = typeof act?.background === 'function' ? act.background : act
      await runner('fetch-job-jd', { id: job.id })
    } finally {
      setJdHydrating(false)
    }
  }, [act, job?.id, job?.provider, job?.detailProvider])

  React.useEffect(() => {
    if (!job?.id || job.closedAt || !canHydrateJobJd(job)) return
    if (job.jd && String(job.jd).trim() && !job.jdPreview) {
      JD_HYDRATE_ATTEMPTED.delete(job.id)
      return
    }
    if (JD_HYDRATE_ATTEMPTED.has(job.id)) return
    void hydrateJobJd(false)
  }, [job?.id, job?.jd, job?.jdPreview, job?.provider, job?.detailProvider, job?.closedAt, hydrateJobJd])

  if (!job) return null
  const { config, personalSync } = state
  const url = validatedLink(job.applyUrl ?? job.url ?? job.sourceUrl)
  const stage = job.stage ?? job.status ?? 'discovered'
  const activeStep = stepIndexOf(stage)
  const closed = ['rejected', 'withdrawn', 'offer_declined'].includes(stage)
  const receipts = Array.isArray(job.receipts) ? [...job.receipts].sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '')) : []
  const interviewNotes = Array.isArray(job.interviewNotes) ? [...job.interviewNotes].reverse() : []
  const currentEditorResumeId = readProfileLocal('selectedResumeId') || ''
  const pickerModel = buildJobResumePickerModel(state.resumes ?? [], {
    jobId: job.id,
    defaultMasterTrackId: state.defaultMasterTrackId || '',
    currentEditorResumeId,
    opportunities: state.opportunities ?? [],
  })
  const tailoredResumes = pickerModel.tailoredOptions
  const latestTailored = tailoredResumes[0] ?? null
  const olderTailored = tailoredResumes.slice(1)
  const resumeChoices = pickerModel.allOptions
  const activeResume = pickerModel.allOptions.find(r => r.id === selectedResumeId)
    ?? pickerModel.defaultChoice
    ?? null
  const activeResumeTitle = activeResume
    ? `${activeResume.title}${activeResume.versionTag ? ` ${activeResume.versionTag}` : ''}`
    : t('common.defaultResume')
  const approveResume = async id => {
    const reply = await act('resume-review', { id, decision: 'approve' }, t('jobDetail.toastApproved'))
    if (reply?.ok) {
      if (quickLookResume?.id === id) setQuickLookResume(cur => cur ? { ...cur, status: 'approved' } : cur)
      if (pendingApplyDraft?.draft?.id === id) setPendingApplyDraft(null)
    }
    return reply
  }
  const currentRound = receipts.find(r => r.round)?.round || t('jobDetail.round1')
  const suggestedNextRound = nextRoundSuggestion(receipts, t)
  const latestByRound = new Map()
  for (const r of receipts) {
    if (!r.round || !['interview_invited', 'interview_confirmed', 'interview_completed'].includes(r.type)) continue
    const rk = interviewGroupKey(r)
    if (!latestByRound.has(rk)) latestByRound.set(rk, r)
  }
  const upcomingInterview = !closed && stage !== 'interview_completed'
    ? [...latestByRound.values()]
      .filter(r => r.type === 'interview_confirmed' && r.startsAt && Date.parse(r.startsAt) > Date.now() - 2 * 3600 * 1000)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] || null
    : null
  const hasDebriefForRound = roundName => {
    const norm = String(roundName || '').trim().toLowerCase()
    return interviewNotes.some(note => {
      const nr = String(note.round || '').trim().toLowerCase()
      return !norm || !nr || nr === norm
    })
  }
  const completedRoundName = justCompletedRound || (stage === 'interview_completed' ? currentRound : '')
  const needsDebriefNudge = !closed && Boolean(completedRoundName) && !hasDebriefForRound(completedRoundName)
  const syncItems = Object.values(personalSync?.items ?? {}).filter(item => item?.opportunityId === job.id)
  const jobRecordings = (state.recordings?.interviews ?? []).filter(r => r.opportunityId === job.id)
  const connectedApps = Object.entries(config.personalSchedule ?? {}).filter(([, val]) => Boolean(val))

  const sectionOptions = [
    { value: 'jd', label: t('jobDetail.tabJd') },
    { value: 'progress', label: t('jobDetail.tabProgress', { count: receipts.length }) },
    { value: 'debrief', label: t('jobDetail.tabDebrief', { count: interviewNotes.length + jobRecordings.length }) },
  ]

  const quickRecord = async (type, extra = {}, toastText = '') => {
    const isSubmitType = type === 'application_submitted' || type === 'resume_sent'
    const chosenResume = extra.materialId
      ? (pickerModel.allOptions.find(r => r.id === extra.materialId) ?? null)
      : activeResume
    // Never silently bind an unapproved pending draft as submitted material!
    if (isSubmitType && !extra.skipPendingCheck && extra.materialKind !== 'external' && chosenResume && chosenResume.status !== 'approved') {
      setSection('progress')
      setReceiptPreset(null)
      setPendingApplyDraft({
        type,
        draft: chosenResume,
        toastText: toastText || t('jobDetail.toastRecordedApply', { company: job.company }),
      })
      return null
    }
    const receipt = {
      id: crypto.randomUUID(),
      opportunityId: job.id,
      type,
      source: 'manual',
      occurredAt: new Date().toISOString(),
      confirmed: true,
      evidence: extra.evidence || defaultEvidenceFor(type, job, extra, t),
      ...(isSubmitType ? {
        material: extra.material || (chosenResume ? formatMaterialLabel(chosenResume) : activeResumeTitle),
        materialKind: extra.materialKind === 'external' ? 'external' : (chosenResume?.id ? 'resume' : 'external'),
        ...(extra.materialKind !== 'external' && chosenResume?.id ? {
          materialId: chosenResume.id,
          ...(chosenResume.versionTag ? { materialVersion: chosenResume.versionTag } : {}),
        } : {}),
      } : {}),
      ...(type.startsWith('interview_') ? {
        round: extra.round || currentRound,
        ...(extra.interviewId ? { interviewId: extra.interviewId } : {}),
      } : {}),
      ...(extra.notes ? { notes: extra.notes } : {}),
    }
    const reply = await act('receipt', { receipt }, toastText || t('jobDetail.toastUpdatedStage', { label: receiptLabel(type, t) || t('jobDetail.newProgress') }))
    if (reply?.ok) {
      setReceiptPreset(null)
      setPendingApplyDraft(null)
      if (type === 'interview_completed') setJustCompletedRound(receipt.round || currentRound)
    }
    return reply
  }

  const approveAndSubmitDraft = async () => {
    if (!pendingApplyDraft?.draft?.id) return
    const { draft, type, toastText } = pendingApplyDraft
    const approved = await act('resume-review', { id: draft.id, decision: 'approve' })
    if (!approved?.ok) return
    await quickRecord(type, {
      material: formatMaterialLabel(draft),
      materialId: draft.id,
      materialVersion: draft.versionTag || '',
      materialKind: 'resume',
      skipPendingCheck: true,
    }, toastText)
  }

  const jumpToStageAction = stepId => {
    setSection('progress')
    if (stepId === 'applied') {
      if (activeStep === 0 && !closed) {
        setReceiptPreset(null)
      } else {
        setReceiptPreset({ type: 'application_submitted', material: activeResumeTitle })
      }
    } else if (stepId === 'interview') {
      setReceiptPreset({ type: 'interview_confirmed', round: stage === 'interview_completed' ? suggestedNextRound : currentRound })
    } else if (stepId === 'offer') {
      setReceiptPreset({ type: 'offer_received' })
    } else {
      setReceiptPreset(null)
    }
    window.requestAnimationFrame(() => {
      progressRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const runTailorAnalysis = async () => {
    await tailorOp.run('tailor', { id: job.id }, {
      kind: 'tailor',
      label: [job.company, job.title].filter(Boolean).join(' · '),
      toast: t('jobDetail.toastDraftReady'),
    })
  }

  const runClearProgress = async () => {
    const snapshot = receipts.map(r => ({ ...r }))
    const reply = await act('receipt-reset', { opportunityId: job.id, mode: 'clear_all' }, t('jobDetail.toastClearedAll'))
    if (reply?.ok) {
      setConfirmClearProgress(false)
      setClearedUndoSnapshot(snapshot.length > 0 ? snapshot : null)
    }
  }

  const undoClearedProgress = async () => {
    if (!clearedUndoSnapshot?.length) return
    const reply = await act('receipt-restore', { opportunityId: job.id, receipts: clearedUndoSnapshot }, t('jobDetail.toastRestoredProgress'))
    if (reply?.ok) setClearedUndoSnapshot(null)
  }

  const stageText = stageLabel(stage, t)
  const preset = boardForSourceId(job.sourceId)
  const companyName = (locale === 'en' && job.company === preset?.company && preset?.companyEn) || job.company
  const subscribedBoards = Array.isArray(config.boards) ? config.boards : []
  const userScope = resolveDefaultHiringScope(config)
  const channelBadge = contextualBoardChannelLabel(preset, t, { userScope, boards: subscribedBoards })
  const matchedBoard = subscribedBoards.find(
    b => `${b.provider}:${String(b.slug || '').toLowerCase()}` === String(job.sourceId || '').toLowerCase(),
  )

  return <>
  <SideSheet
    wide
    leading={
      <CompanyAvatar
        company={job.company || t('common.company')}
        domain={matchedBoard?.domain || ''}
        slug={matchedBoard?.slug || ''}
        url={job.url}
        size={38}
        className="ca-sheet-company-logo"
      />
    }
    title={job.title || t('jobDetail.titleFallback')}
    subtitle={[companyName, channelBadge, job.location, opportunityOriginLabel(job, t)].filter(Boolean).join(' · ')}
    onClose={onClose}
  >
    {({ dismiss }) => <div className="ca-sheet-body ca-job-detail-body" data-surface="job-detail" data-stage={stage}>
      {/* Sculpted Horizontal Journey Rail (unified recessed progress track, zero box-in-box) */}
      <div className={`ca-detail-journey${closed ? ' is-closed' : ` is-tone-${STEP_SPECS[activeStep]?.tone || 'indigo'}`}`}>
        <div className="ca-detail-journey-head">
          <div className="ca-detail-journey-status">
            {closed ? (
              <>
                <StageLogo id="closed" size={16} active={false} hasItems />
                <span className="ca-detail-journey-stage-text">{t('jobDetail.closedPrefix', { stage: stageText || t('jobDetail.closedFallback') })}</span>
              </>
            ) : (
              <>
                <span className="ca-detail-journey-dot" aria-hidden="true" />
                <span className="ca-detail-journey-stage-text">{stageText || t('stage.discovered')}</span>
              </>
            )}
            {job.closedAt && <Tag tone="danger">{t('jobs.closedTag')}</Tag>}
          </div>
          {url && <a className="ca-detail-ext-link" href={url} target="_blank" rel="noopener noreferrer">{t('jobDetail.officialPage')}</a>}
        </div>
        <div
          className="ca-detail-journey-track"
          role="group"
          aria-label={t('jobDetail.stageAria')}
          style={{ '--journey-progress': `${closed ? 0 : (activeStep / Math.max(1, STEP_SPECS.length - 1)) * 100}%` }}
        >
          <div className="ca-detail-journey-rail" aria-hidden="true">
            <div className="ca-detail-journey-rail-fill" />
          </div>
          {STEP_SPECS.map((step, idx) => {
            const done = !closed && idx < activeStep
            const current = !closed && idx === activeStep
            const upcoming = closed || idx > activeStep
            return (
              <button
                key={step.id}
                type="button"
                className={`ca-detail-journey-stop is-tone-${step.tone}${done ? ' is-done' : ''}${current ? ' is-current' : ''}${upcoming ? ' is-upcoming' : ''}`}
                aria-current={current ? 'step' : undefined}
                onClick={() => jumpToStageAction(step.id)}
              >
                <span className="ca-detail-journey-orb">
                  <StageLogo id={step.id} size={22} active={current} hasItems={done || current} />
                  {done && (
                    <span className="ca-detail-journey-check" aria-hidden="true">
                      <svg viewBox="0 0 12 12" width="8" height="8" fill="none">
                        <path d="M2.4 6.2 4.9 8.7 9.6 3.5" stroke="#ffffff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </span>
                <span className="ca-detail-journey-label">{t(step.labelKey)}</span>
              </button>
            )
          })}
        </div>
      </div>

      <SegmentedControl id={`${uid}-sec`} label={t('jobDetail.workspaceTabsAria')} value={section} options={sectionOptions} onChange={setSection} />

      {section === 'progress' && <div className="ca-detail-section" ref={progressRef}>
        {/* Calm, focused stage action card (unified Apply Prep Studio at Step 0) */}
        <section className="ca-progress-next-card">
          <div className="ca-progress-next-head">
            <div className="ca-progress-next-head-left">
              <StageLogo id={bucketIdOf(stage)} size={28} active={!closed} hasItems />
              <div className="ca-progress-next-title-wrap">
                <strong className="ca-progress-next-title">
                  {closed ? t('jobDetail.journeyClosed', { stage: stageText || t('jobDetail.closedFallback') })
                    : activeStep === 0 ? t('jobDetail.journeyReady')
                    : activeStep === 1 ? t('jobDetail.journeyApplied')
                    : activeStep === 2 ? (
                      stage === 'interview_completed'
                        ? t('jobDetail.journeyCompletedRound', { round: currentRound })
                        : upcomingInterview
                          ? t('jobDetail.journeyUpcoming', { round: upcomingInterview.round || currentRound })
                          : stage === 'invited'
                            ? t('jobDetail.journeyInvited', { round: currentRound })
                            : t('jobDetail.journeyInterviewing', { round: currentRound })
                    )
                    : stage === 'offer_received' ? t('jobDetail.journeyOffer')
                    : (stageText || t('jobDetail.journeyActive'))}
                </strong>
                {activeStep === 2 && upcomingInterview && (
                  <span className="ca-meta">
                    {readableDate(upcomingInterview.startsAt, config.timezone, locale)}{upcomingInterview.location ? ` · ${upcomingInterview.location}` : ''}
                  </span>
                )}
              </div>
            </div>
          </div>

          {activeStep === 0 && !closed && (
            <div className="ca-handoff-split ca-prep-studio">
              {resumeChoices.length > 0 && (
                <ResumeMiniPaper
                  resume={activeResume}
                  canExportPdf={Boolean(state.capabilities?.pdfExport)}
                  onQuickLook={r => setQuickLookResume(r)}
                  onOpenResume={id => { dismiss(); onResume?.(id) }}
                />
              )}
              <div className="ca-handoff-right">
                <div className="ca-handoff-fields">
                  {resumeChoices.length > 0 && (
                    <div className="ca-handoff-field">
                      <div className="ca-handoff-field-head">
                        <span className="ca-handoff-label">{t('jobDetail.submitResume')}</span>
                        <div className="ca-inline">
                          {latestTailored ? <>
                            {latestTailored.masterBehind && (
                              <button type="button" className="ca-text-button" disabled={!!busy} onClick={async () => {
                                const reply = await act('resume-rebase', { id: latestTailored.id }, r => r?.summary || t('jobDetail.rebaseToastFallback'))
                                if (reply?.result?.id) { dismiss(); onResume?.(reply.result.id) }
                              }}>{busy === 'resume-rebase' ? t('resume.syncing') : t('version.syncMaster')}</button>
                            )}
                            <button type="button" className="ca-text-button" onClick={() => { dismiss(); onResume?.(latestTailored.id) }}>
                              {t('jobDetail.editTailoredResume')}
                            </button>
                          </> : (!job.closedAt && (
                            <button type="button" className="ca-text-button" data-action="tailor-resume" disabled={!!busy} onClick={async () => {
                              if (onTailorJob) { dismiss(); onTailorJob(job); return }
                              const reply = await act('tailor-resume', { id: job.id }, t('jobs.tailorResumeToast'))
                              if (reply?.result?.id) { dismiss(); onResume?.(reply.result.id) }
                            }}>{busy === 'tailor-resume' ? t('jobDetail.tailoring') : t('jobDetail.tailorByJdArrow')}</button>
                          ))}
                        </div>
                      </div>
                      <div className="ca-prep-resume-picker-row">
                        <ResumeSelectMenu
                          pickerModel={pickerModel}
                          choices={resumeChoices}
                          selectedId={activeResume?.id || ''}
                          onSelect={id => { setSelectedResumeId(id); setPendingApplyDraft(null) }}
                          timezone={config.timezone}
                        />
                        {activeResume?.status === 'pending' && (
                          <Button variant="outline" size="sm" className="ca-nowrap-btn" disabled={!!busy} onClick={() => void approveResume(activeResume.id)}>
                            {t('jobDetail.approveShort')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="ca-handoff-field is-grow">
                    <div className="ca-handoff-field-head">
                      <span className="ca-handoff-label">{t('jobDetail.greetingMessage')}</span>
                      {job.draft?.message && !tailorOp.running && (
                        <div className="ca-inline">
                          <button type="button" className="ca-text-button" disabled={!!busy || tailorOp.running} onClick={() => void runTailorAnalysis()}>
                            {t('jobDetail.regenerateGreeting')}
                          </button>
                          <CopyButton className="is-quiet" text={job.draft.message} label={t('common.copy')} />
                        </div>
                      )}
                    </div>
                    {tailorOp.activity && tailorOp.activity.phase !== 'ready' ? (
                      <AiTraceCard
                        activity={tailorOp.activity}
                        title={tailorOp.activity.phase === 'error'
                          ? t('jobDetail.tailorDraftFailed')
                          : t('jobDetail.tailorDraftWorking')}
                        onDismiss={tailorOp.dismiss}
                      />
                    ) : job.draft?.message ? (
                      <div className="ca-handoff-msg-box">
                        <p className="ca-preline">{job.draft.message}</p>
                      </div>
                    ) : (
                      <div className="ca-handoff-msg-empty">
                        <span className="ca-meta">{t('jobDetail.noGreetingYet')}</span>
                        <Button variant="outline" size="sm" disabled={!!busy || tailorOp.running} onClick={() => void runTailorAnalysis()}>
                          {tailorOp.running ? t('jobDetail.analyzing') : t('jobDetail.generateGreeting')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="ca-progress-next-actions">
            {closed ? <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => void act('receipt-reset', { opportunityId: job.id, mode: 'remove_type', targetType: stage }, t('jobDetail.toastUndoneStage', { stage: stageText || t('jobDetail.closedFallback') }))}>
                {t('jobDetail.undoStage', { stage: stageText || t('jobDetail.closedFallback') })}
              </Button>
              <Button variant="outline" size="sm" disabled={!!busy}
                onClick={() => setConfirmClearProgress(true)}>
                {t('jobDetail.resetToUnapplied')}
              </Button>
            </> : activeStep === 0 ? <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('application_submitted', { material: activeResumeTitle }, t('jobDetail.toastRecordedApply', { company: job.company }))}>
                {t('jobDetail.iApplied')}
              </Button>
              <Button variant="outline" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('contact_sent', {}, t('jobDetail.toastContacted'))}>
                {t('jobDetail.referredOrContacted')}
              </Button>
              <Button variant="outline" size="sm" disabled={!!busy}
                onClick={() => setReceiptPreset({ type: 'interview_confirmed', round: t('jobDetail.round1') })}>
                {t('jobDetail.scheduleDirectly')}
              </Button>
              {url && (
                <a className="ca-link-cta is-btn is-quiet-outline" href={url} target="_blank" rel="noopener noreferrer">
                  {t('jobDetail.goOfficialApply')}
                </a>
              )}
            </> : activeStep === 1 ? <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => setReceiptPreset({ type: 'interview_confirmed', round: t('jobDetail.round1') })}>
                {t('jobDetail.scheduleInterview')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('interview_invited', { round: t('jobDetail.round1') }, t('jobDetail.toastInvitedR1'))}>
                {t('jobDetail.gotInvite')}
              </Button>
              {stage !== 'acknowledged' && (
                <Button variant="ghost" size="sm" disabled={!!busy}
                  onClick={() => void quickRecord('application_acknowledged', {}, t('jobDetail.toastAck'))}>
                  {t('jobDetail.acknowledged')}
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('rejected', {}, t('jobDetail.toastRejected'))}>
                {t('jobDetail.notPassed')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('withdrawn', {}, t('jobDetail.toastWithdrawn'))}>
                {t('jobDetail.withdrawBtn')}
              </Button>
            </> : activeStep === 2 ? <>
              {stage !== 'interview_completed' ? (
                <Button variant="primary" size="sm" disabled={!!busy}
                  onClick={() => void quickRecord('interview_completed', { round: currentRound }, t('jobDetail.toastCompletedRound', { round: currentRound }))}>
                  {t('jobDetail.markRoundDone', { round: currentRound })}
                </Button>
              ) : (
                <Button variant="primary" size="sm" disabled={!!busy}
                  onClick={() => setReceiptPreset({ type: 'interview_confirmed', round: suggestedNextRound })}>
                  {t('jobDetail.scheduleNextRound', { round: suggestedNextRound })}
                </Button>
              )}
              {stage !== 'interview_completed' && (
                <Button variant="ghost" size="sm" disabled={!!busy}
                  onClick={() => setReceiptPreset({ type: 'interview_confirmed', round: suggestedNextRound })}>
                  {t('jobDetail.addAnotherInterview')}
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => setReceiptPreset({ type: 'offer_received' })}>
                {t('jobDetail.gotOffer')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('rejected', {}, t('jobDetail.toastRejected'))}>
                {t('jobDetail.notPassed')}
              </Button>
            </> : stage === 'offer_received' ? <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('offer_accepted', {}, t('jobDetail.toastAcceptedOffer'))}>
                {t('jobDetail.acceptOffer')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('offer_declined', {}, t('jobDetail.toastDeclinedOffer'))}>
                {t('jobDetail.declineOffer')}
              </Button>
            </> : stage === 'offer_accepted' ? <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => void quickRecord('started', {}, t('jobDetail.toastStarted'))}>
                {t('jobDetail.markStarted')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => void act('receipt-reset', { opportunityId: job.id, mode: 'remove_type', targetType: 'offer_accepted' }, t('jobDetail.toastUndoOfferAccept'))}>
                {t('jobDetail.undoOfferAccept')}
              </Button>
            </> : <>
              <Button variant="primary" size="sm" disabled={!!busy}
                onClick={() => void act('receipt-reset', { opportunityId: job.id, mode: 'remove_type', targetType: 'started' }, t('jobDetail.toastUndoStarted'))}>
                {t('jobDetail.undoStarted')}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy}
                onClick={() => setConfirmClearProgress(true)}>
                {t('jobDetail.resetToUnapplied')}
              </Button>
            </>}
          </div>

          {pendingApplyDraft && activeStep === 0 && !closed && (() => {
            const draftTitle = formatMaterialLabel(pendingApplyDraft.draft)
            const approvedFallback = pickerModel.defaultApprovedChoice
            const fallbackTitle = approvedFallback ? formatMaterialLabel(approvedFallback) : ''
            return (
              <div className="ca-apply-draft-nudge" role="status">
                <p className="ca-apply-draft-nudge-text">
                  {approvedFallback
                    ? t('jobDetail.applyDraftNotice', { title: draftTitle })
                    : t('jobDetail.applyDraftNoticeNoApproved', { title: draftTitle })}
                </p>
                <div className="ca-apply-draft-nudge-actions">
                  <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void approveAndSubmitDraft()}>
                    {t('jobDetail.approveAndApply')}
                  </Button>
                  {approvedFallback ? (
                    <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void quickRecord(
                      pendingApplyDraft.type,
                      { materialId: approvedFallback.id, material: fallbackTitle },
                      pendingApplyDraft.toastText,
                    )}>
                      {t('jobDetail.applyWithApproved', { title: fallbackTitle })}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={!!busy} onClick={() => {
                      const nextType = pendingApplyDraft.type
                      setPendingApplyDraft(null)
                      setReceiptPreset({ type: nextType, materialKind: 'external', material: '' })
                    }}>
                      {t('jobDetail.applyWithExternal')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setPendingApplyDraft(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )
          })()}

          {confirmClearProgress && receipts.length > 0 && (
            <div className="ca-clear-confirm-box" role="alert">
              <p className="ca-meta" style={{ margin: 0 }}>
                {t('jobDetail.clearProgressImpact', {
                  count: receipts.length,
                  interviews: receipts.filter(r => r.type.startsWith('interview_')).length,
                })}
              </p>
              <div className="ca-inline" style={{ marginTop: '8px' }}>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClearProgress(false)}>{t('common.cancel')}</Button>
                <Button variant="outline" size="sm" className="ca-danger-text" disabled={!!busy} onClick={() => void runClearProgress()}>
                  {t('jobDetail.confirmClearProgressBtn')}
                </Button>
              </div>
            </div>
          )}

          {clearedUndoSnapshot && receipts.length === 0 && (
            <div className="ca-progress-debrief-nudge" role="status">
              <span>{t('jobDetail.clearedUndoPrompt', { count: clearedUndoSnapshot.length })}</span>
              <div className="ca-inline">
                <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void undoClearedProgress()}>
                  {t('jobDetail.undoClearProgressBtn')}
                </Button>
                <button type="button" className="ca-text-button" onClick={() => setClearedUndoSnapshot(null)}>{t('common.close')}</button>
              </div>
            </div>
          )}

          {needsDebriefNudge && (
            <div className="ca-progress-debrief-nudge">
              <span>{t('jobDetail.debriefNudge', { round: completedRoundName })}</span>
              <Button variant="outline" size="sm" onClick={() => { setShowManualDebrief(true); setSection('debrief') }}>
                {t('jobDetail.writeDebriefArrow')}
              </Button>
            </div>
          )}
        </section>

        {activeStep >= 1 && latestTailored && (
          <div className="ca-detail-resume-strip">
            <div className="ca-detail-resume-primary">
              <span className="ca-meta">{t('jobDetail.thisJobTailored')}</span>
              <button type="button" className="ca-detail-resume-btn" onClick={() => { dismiss(); onResume?.(latestTailored.id) }}>
                <Tag tone={latestTailored.status === 'approved' ? 'success' : 'info'}>
                  {latestTailored.status === 'approved' ? t('version.statusApproved') : t('version.statusPending')}
                </Tag>
                <span className="ca-detail-resume-name">{latestTailored.title}{latestTailored.versionTag ? ` ${latestTailored.versionTag}` : ''}</span>
                <small>{[latestTailored.lineage ? localizeChangeLabel(latestTailored.lineage, t) : '', latestTailored.masterBehind ? t('version.masterBehindPlain') : '', readableDate(latestTailored.createdAt, config.timezone, locale)].filter(Boolean).join(' · ')}</small>
                <span className="ca-detail-resume-go">{t('common.open')}</span>
              </button>
              {latestTailored.masterBehind && (
                <Button variant="outline" size="sm" disabled={!!busy} onClick={async () => {
                  const reply = await act('resume-rebase', { id: latestTailored.id }, r => r?.summary || t('jobDetail.rebaseToastFallback'))
                  if (reply?.result?.id) { dismiss(); onResume?.(reply.result.id) }
                }}>
                  {busy === 'resume-rebase' ? t('resume.syncing') : t('version.syncMaster')}
                </Button>
              )}
              {olderTailored.length > 0 && (
                <button type="button" className="ca-text-button" onClick={() => setShowOlderResumes(v => !v)}>
                  {showOlderResumes ? t('jobDetail.collapseOlder') : t('jobDetail.olderVersions', { count: olderTailored.length })}
                </button>
              )}
            </div>
            {showOlderResumes && olderTailored.length > 0 && (
              <div className="ca-detail-resume-older">
                {olderTailored.map(r => (
                  <button key={r.id} type="button" className="ca-detail-resume-btn is-older"
                    onClick={() => { dismiss(); onResume?.(r.id) }}>
                    <Tag tone={r.status === 'approved' ? 'neutral' : 'outline'}>
                      {r.status === 'approved' ? t('version.olderApproved') : t('version.olderDraft')}
                    </Tag>
                    <span className="ca-detail-resume-name">{r.title}</span>
                    <small>{readableDate(r.createdAt, config.timezone, locale)}</small>
                    <span className="ca-detail-resume-go">{t('common.open')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {receiptPreset && <QuickReceiptForm
          item={job}
          preset={receiptPreset}
          existingReceipts={receipts}
          resumeChoices={resumeChoices}
          defaultMaterial={activeResumeTitle}
          connectedApps={connectedApps}
          timezone={config.timezone}
          act={act}
          busy={busy}
          onDone={saved => {
            setReceiptPreset(null)
            if (saved?.type === 'interview_completed') setJustCompletedRound(saved.round || currentRound)
          }}
        />}

        {/* Compact natural-language / email paste quick recorder */}
        <Composer
          compact
          config={config}
          act={act}
          busy={busy}
          placeholderOverride={t('jobDetail.pasteEmailPlaceholder')}
          intakes={(state.intakes ?? []).filter(entry => entry.data?.opportunityId === job.id || entry.opportunityId === job.id)}
          opportunity={job}
        />

        {/* Native Calendar / Things / Reminders sync status — real per-item status & failure retry */}
        {(syncItems.length > 0 || (connectedApps.length > 0 && activeStep >= 2)) && <div className="ca-sync-strip">
          <div className="ca-inline" style={{ flexWrap: 'wrap', gap: '6px' }}>
            <span className="ca-meta">{t('jobDetail.scheduleSyncLabel')}</span>
            {syncItems.length > 0 ? syncItems.map(si => (
              <span key={si.id} className="ca-inline" style={{ gap: '4px' }}>
                <Tag tone={si.verified ? 'success' : 'danger'}>
                  {si.verified ? '✓ ' : '⚠ '}
                  {destLabel(si.destination, t)}·{si.target}
                  {si.verified ? t('jobDetail.verifiedParen') : t('jobDetail.retryParen', { reason: si.error || t('jobDetail.retryPending') })}
                </Tag>
                {!si.verified && connectedApps.length > 0 && (
                  <Button variant="ghost" size="sm" disabled={!!busy || personalSync?.running}
                    onClick={() => act('schedule-sync', {}, t('jobDetail.toastScheduleTriggered'))}>
                    {personalSync?.running || busy === 'schedule-sync' ? t('followups.syncing') : t('common.retry')}
                  </Button>
                )}
              </span>
            )) : <span className="ca-meta">{t('jobDetail.scheduleSyncDesc', { targets: connectedApps.map(([k, v]) => `${destLabel(k, t)}·${v}`).join(' / ') })}</span>}
          </div>
          {connectedApps.length === 0 && (
            <Button variant="ghost" size="sm" onClick={() => { dismiss(); onSources?.('schedule') }}>{t('jobDetail.goConnect')}</Button>
          )}
        </div>}

        {/* Connected vertical timeline with 1-click undo */}
        {receipts.length > 0 ? <div className="ca-timeline">
          {receipts.map((r, idx) => (
            <div key={r.id} className={`ca-timeline-item${idx === 0 ? ' is-latest' : ''}`}>
              <div className="ca-timeline-rail" aria-hidden="true">
                <StateDot state={idx === 0 ? 'done' : 'idle'} size={9} />
                {idx < receipts.length - 1 && <span className="ca-timeline-line" />}
              </div>
              <div className="ca-timeline-card">
                <div className="ca-timeline-head">
                  <strong>{receiptLabel(r.type, t)}{r.round ? ` · ${r.round}` : ''}</strong>
                  <div className="ca-inline">
                    <span className="ca-meta">{readableDate(r.occurredAt, config.timezone, locale)}</span>
                    <button type="button" className="ca-timeline-undo" disabled={!!busy} title={t('jobDetail.undoReceiptTitle')}
                      onClick={() => void act('receipt-remove', { id: r.id }, t('jobDetail.toastReceiptRemoved'))}>
                      {t('jobDetail.undoReceipt')}
                    </button>
                  </div>
                </div>
                {r.material && (() => {
                  const boundResume = r.materialId ? (state.resumes ?? []).find(res => res.id === r.materialId) : null
                  return <div className="ca-inline" style={{ flexWrap: 'wrap', gap: '6px' }}>
                    <p className="ca-meta" style={{ margin: 0 }}>
                      {t('jobDetail.submittedMaterial', { material: r.material })}
                      {r.materialKind === 'external' ? ` · ${t('jobDetail.externalMaterialBadge')}` : ''}
                    </p>
                    {boundResume && (
                      <button type="button" className="ca-text-button" onClick={() => setQuickLookResume({
                        id: boundResume.id,
                        title: boundResume.title || r.material,
                        status: boundResume.status,
                        versionTag: r.materialVersion || '',
                        text: boundResume.previewText || boundResume.text || '',
                        appearance: boundResume.appearance,
                      })}>
                        {t('jobDetail.viewBoundResume')}
                      </button>
                    )}
                  </div>
                })()}
                {Array.isArray(r.amendments) && r.amendments.length > 0 && (
                  <p className="ca-meta">
                    {t('jobDetail.amendedHistory', { material: r.amendments.at(-1)?.material || '' })}
                  </p>
                )}
                {r.startsAt && <p className="ca-timeline-time">
                  {t('jobDetail.timeRange', { start: readableDate(r.startsAt, config.timezone, locale), end: readableDate(r.endsAt, config.timezone, locale) })}
                  {r.location ? ` · ${r.location}` : ''}
                </p>}
                {r.type === 'offer_received' && <p className="ca-timeline-time">
                  {r.form === 'written' ? t('followups.writtenOffer') : t('followups.verbalOffer')}
                  {r.replyBy ? t('jobDetail.deadlineSuffix', { time: readableDate(r.replyBy, config.timezone, locale) }) : ''}
                </p>}
                {(() => {
                  const customEv = extractCustomReceiptEvidence(r.evidence, { label: receiptLabel(r.type, t), company: job.company })
                  return customEv ? <p className="ca-meta">{t('jobDetail.evidenceLine', { text: customEv })}</p> : null
                })()}
                {r.notes && <p>{r.notes}</p>}
                {(() => {
                  const rk = r.round ? interviewGroupKey(r) : ''
                  const latestForRound = rk ? latestByRound.get(rk) : null
                  const roundFinished = latestForRound?.type === 'interview_completed'
                  const isLatestConfirmationForRound = r.type === 'interview_confirmed' && latestForRound?.id === r.id
                  const showConfirmedActions = isLatestConfirmationForRound && !roundFinished && !closed
                  const roundHasDebrief = r.type === 'interview_completed' && hasDebriefForRound(r.round)
                  const showWriteDebrief = r.type === 'interview_completed' && !roundHasDebrief && !(needsDebriefNudge && idx === 0)
                  if (!showConfirmedActions && !roundHasDebrief && !showWriteDebrief) return null
                  return <div className="ca-inline ca-timeline-actions">
                    {showConfirmedActions && <>
                      <Button variant="outline" size="sm" disabled={!!busy} onClick={async () => {
                        const reply = await act('calendar', { id: r.id })
                        if (typeof reply?.result?.text === 'string') downloadText(reply.result.text, `${job.company}-${r.round || t('jobs.defaultInterview')}.ics`)
                      }}>{t('jobDetail.exportIcs')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setReceiptPreset({
                        type: 'interview_confirmed', round: r.round, interviewId: r.interviewId || '', reschedule: true, location: r.location || '',
                        evidence: t('jobDetail.rescheduleEvidence', { round: r.round || t('jobs.defaultInterview') }),
                      })}>{t('jobDetail.reschedule')}</Button>
                    </>}
                    {roundHasDebrief && (
                      <Button variant="ghost" size="sm" onClick={() => { setShowManualDebrief(false); setSection('debrief') }}>
                        {t('jobDetail.viewDebrief')}
                      </Button>
                    )}
                    {showWriteDebrief && (
                      <Button variant="ghost" size="sm" onClick={() => { setShowManualDebrief(true); setSection('debrief') }}>
                        {t('jobDetail.writeRoundDebrief')}
                      </Button>
                    )}
                  </div>
                })()}
              </div>
            </div>
          ))}
        </div> : <p className="ca-timeline-quiet-empty">{t('jobDetail.emptyTimeline')}</p>}
      </div>}

      {section === 'debrief' && <div className="ca-detail-section">
        <JobLinkedRecordings
          recordings={jobRecordings}
          job={job}
          config={config}
          defaultRound={currentRound}
          busy={busy}
          act={act}
        />

        <div className="ca-section-head">
          <h3>{t('jobDetail.debriefSectionTitle')}</h3>
          {(interviewNotes.length > 0 || jobRecordings.length > 0) && (
            <Button variant={showManualDebrief ? 'ghost' : 'primary'} size="sm"
              aria-expanded={showManualDebrief}
              onClick={() => setShowManualDebrief(v => !v)}>
              {showManualDebrief ? t('jobDetail.collapseForm') : t('jobDetail.addManualDebrief')}
            </Button>
          )}
        </div>

        {(showManualDebrief || (interviewNotes.length === 0 && jobRecordings.length === 0)) && (
          <ManualDebriefPanel item={job} config={config} act={act} busy={busy} onDone={() => setShowManualDebrief(false)} />
        )}

        {interviewNotes.length > 0 && <div className="ca-debrief-list">
          {interviewNotes.map((note, idx) => (
            <article key={note.id ?? idx} className="ca-debrief-card">
              <div className="ca-debrief-head">
                <div className="ca-inline">
                  <Tag tone="info">{note.round || t('jobDetail.defaultDebriefTag')}</Tag>
                  <span className="ca-meta">{readableDate(note.createdAt, config.timezone, locale)}</span>
                </div>
                {onResumeWithPrompt && (
                  <Button variant="outline" size="sm" onClick={() => {
                    const prompt = t('jobDetail.debriefToResumePrompt', {
                      company: job.company,
                      title: job.title,
                      round: note.round || t('jobs.defaultInterview'),
                      questions: (note.questions || '').slice(0, 220),
                      observations: (note.observations || '').slice(0, 220),
                    })
                    const noteSourceIds = ['transcript']
                    if (note.sourceId) noteSourceIds.push(String(note.sourceId))
                    if (note.recordingSourceId) {
                      const rec = String(note.recordingSourceId)
                      noteSourceIds.push(rec.startsWith('recording:') ? rec : `recording:${rec}`)
                    }
                    dismiss()
                    onResumeWithPrompt({ text: prompt, sourceIds: [...new Set(noteSourceIds)] })
                  }}>{t('jobDetail.debriefToResumeBtn')}</Button>
                )}
              </div>
              <div className="ca-debrief-grid">
                {note.questions && <div className="ca-debrief-quad"><strong>{t('jobDetail.debriefQuestions')}</strong><p className="ca-preline">{note.questions}</p></div>}
                {note.feedback && <div className="ca-debrief-quad"><strong>{t('jobDetail.debriefFeedback')}</strong><p className="ca-preline">{note.feedback}</p></div>}
                {note.observations && <div className="ca-debrief-quad"><strong>{t('jobDetail.debriefObservations')}</strong><p className="ca-preline">{note.observations}</p></div>}
                {note.next && <div className="ca-debrief-quad"><strong>{t('jobDetail.debriefNext')}</strong><p className="ca-preline">{note.next}</p></div>}
              </div>
              {(note.sourceRef || note.rawTranscript || note.recordingId) && <DebriefSourceViewer note={note} />}
            </article>
          ))}
        </div>}
      </div>}

      {section === 'jd' && <div className="ca-detail-section">
        {job.jdPreview && job.jd && <div className="ca-jd-missing-box">
          <p className="ca-meta" role="status">{t(jdHydrating ? 'jobDetail.hydratingJd' : 'jobDetail.jdPreview')}</p>
          {!jdHydrating && <Button variant="outline" size="sm" onClick={() => void hydrateJobJd(true)}>{t('jobDetail.retryFetchJd')}</Button>}
        </div>}
        {job.jdPreview && job.jd ? <p style={{ whiteSpace: 'pre-line' }}>{job.jd}</p> : job.jd
          ? <AnnotatedJd job={job} state={state} tailoredResumes={tailoredResumes} busy={busy} act={act} dismiss={dismiss} onStartSession={onStartSession} />
          : jdHydrating
            ? <div className="ca-jd-hydrating-box" role="status" aria-live="polite">
                <StateDot state="ongoing" size={10} />
                <span>{t('jobDetail.hydratingJd')}</span>
              </div>
            : <div className="ca-jd-missing-box">
                <p className="ca-meta">{t('jobDetail.missingJdHint')}</p>
                {canHydrateJobJd(job) && (
                  <Button variant="outline" size="sm" disabled={jdHydrating} onClick={() => void hydrateJobJd(true)}>
                    {t('jobDetail.retryFetchJd')}
                  </Button>
                )}
              </div>}
      </div>}
    </div>}
  </SideSheet>
  {quickLookResume && (
    <ResumeQuickLookModal
      resume={quickLookResume}
      canExportPdf={Boolean(state.capabilities?.pdfExport)}
      busy={busy}
      onApprove={approveResume}
      onEditResume={id => { setQuickLookResume(null); onClose?.(); onResume?.(id) }}
      onClose={() => setQuickLookResume(null)}
    />
  )}
  </>
}
