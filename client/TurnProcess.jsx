import React from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useElapsedSeconds } from './AiActivity.jsx'
import { useI18n } from './i18n.jsx'

export function formatTraceDuration(ms = 0) {
  const n = Number(ms) || 0
  if (n <= 0) return ''
  const sec = Math.max(0.1, n / 1000)
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

function formatTraceChars(len = 0, t) {
  const n = Number(len) || 0
  if (n >= 1000) return t('common.charCountK', { count: (n / 1000).toFixed(1).replace(/\.0$/, '') })
  return n > 0 ? t('common.charCount', { count: n }) : ''
}

function stepDotState(state) {
  if (state === 'ongoing') return 'ongoing'
  if (state === 'done') return 'done'
  if (state === 'error') return 'error'
  if (state === 'stopped') return 'warning'
  return 'idle'
}

function outcomeToDotState(outcome) {
  if (outcome === 'stopped') return 'warning'
  if (outcome === 'error' || outcome === 'interrupted') return 'error'
  return 'done'
}

function formatStepLabel(step, t, trace = null) {
  if (!step) return ''
  const ongoing = step.state === 'ongoing'
  const isError = step.state === 'error'
  const isStopped = step.state === 'stopped'
  if (step.kind === 'retry' || step.name === 'language-repair') {
    return ongoing ? t('agent.traceStepRetryLive') : isError ? t('agent.traceStepRetryFailed') : t('agent.traceStepRetryDone')
  }
  if (step.name === 'update_resume') {
    if (ongoing) return t('agent.traceStepResumeDrafting')
    if (isError) return t('agent.traceStepResumeFailed')
    if (isStopped) return t('agent.traceStepResumeStopped')
    if (trace?.artifactState === 'staged') return t('agent.traceStepResumeStaged')
    if (trace?.artifactState === 'noop') return t('agent.traceSumNoOp')
    return t('agent.traceStepResumeDone')
  }
  if (step.name === 'update_appearance') {
    return ongoing
      ? t('agent.statusUpdatingStyle')
      : isError
        ? t('agent.traceStepStyleFailed')
        : isStopped
          ? t('agent.traceStepStyleStopped')
          : t('agent.traceStepStyleDone')
  }
  return ongoing ? t('common.processingEllipsis') : t('agent.traceStepGenericDone')
}

function formatContextSummaryLine(items = [], citedEvidenceCount = 0, t) {
  const resumeItem = items.find(i => i?.kind === 'resume')
  const jobItem = items.find(i => i?.kind === 'job')
  const evItem = items.find(i => i?.kind === 'evidence')
  const parts = []
  if (resumeItem) {
    parts.push(resumeItem.label
      ? t('agent.traceCtxShortResumeNamed', { title: resumeItem.label })
      : t('agent.traceCtxShortResume'))
  }
  if (jobItem) {
    parts.push(t('agent.traceCtxShortJob', { job: jobItem.label || t('common.role') }))
  }
  if (evItem?.count > 0) {
    parts.push(citedEvidenceCount > 0
      ? t('agent.traceCtxShortEvidenceCited', { count: evItem.count, cited: citedEvidenceCount })
      : t('agent.traceCtxShortEvidence', { count: evItem.count }))
  }
  return parts.join(' · ')
}

function formatContextItemDetail(item, citedEvidenceCount = 0, t) {
  if (!item) return ''
  const charsText = formatTraceChars(item.chars, t)
  if (item.kind === 'resume') {
    if (item.label && charsText) return t('agent.traceCtxResumeNamedChars', { title: item.label, chars: charsText })
    if (item.label) return t('agent.traceCtxResumeNamed', { title: item.label })
    return charsText ? t('agent.traceCtxResumeChars', { chars: charsText }) : t('agent.traceCtxShortResume')
  }
  if (item.kind === 'job') {
    const label = item.label || t('common.role')
    return charsText ? t('agent.traceCtxJobChars', { job: label, chars: charsText }) : t('agent.traceCtxShortJob', { job: label })
  }
  if (item.kind === 'evidence') {
    return citedEvidenceCount > 0
      ? t('agent.traceCtxEvidenceDetailCited', { count: item.count || 0, cited: citedEvidenceCount })
      : t('agent.traceCtxEvidenceDetailSupplied', { count: item.count || 0 })
  }
  if (item.kind === 'jobs') {
    return t('agent.traceCtxOtherJobs', { count: item.count || 0 })
  }
  return ''
}

export function summarizeTurnProcess(trace, t) {
  if (!trace || typeof trace !== 'object') return ''
  const items = Array.isArray(trace.contextItems) ? trace.contextItems : []
  const steps = Array.isArray(trace.steps) ? trace.steps : []
  const citedCount = Number(trace.citedEvidenceCount) || 0
  const parts = []

  const resumeItem = items.find(i => i?.kind === 'resume')
  const jobItem = items.find(i => i?.kind === 'job')
  if (resumeItem && jobItem) {
    parts.push(t('agent.traceSumReadResumeJob', { job: jobItem.label || t('common.role') }))
  } else if (jobItem) {
    parts.push(t('agent.traceSumReadJob', { job: jobItem.label || t('common.role') }))
  } else if (resumeItem) {
    parts.push(t('agent.traceSumReadResume'))
  }

  const hasResumeEditDone = steps.some(s => s?.name === 'update_resume' && s?.state === 'done')
  const hasStyleDone = steps.some(s => s?.name === 'update_appearance' && s?.state === 'done')
  if (hasResumeEditDone) {
    if (trace.artifactState === 'staged') parts.push(t('agent.traceSumStagedResume'))
    else if (trace.artifactState === 'noop') parts.push(t('agent.traceSumNoOp'))
    else parts.push(t('agent.traceSumEditedResume'))
  }
  if (hasStyleDone) {
    parts.push(t('agent.traceSumUpdatedStyle'))
  }
  if (citedCount > 0) {
    parts.push(t('agent.traceSumCitedEvidence', { count: citedCount }))
  }

  if (!hasResumeEditDone && !hasStyleDone && trace.thinkingMs > 0) {
    const thinkDur = formatTraceDuration(trace.thinkingMs)
    if (thinkDur) parts.push(t('agent.traceSumThought', { time: thinkDur }))
  }

  if (trace.outcome === 'stopped') parts.push(t('agent.traceSumStopped'))
  else if (trace.outcome === 'interrupted') parts.push(t('agent.traceSumInterrupted'))
  else if (trace.outcome === 'error') parts.push(t('agent.traceSumError'))

  const totalDur = formatTraceDuration(trace.elapsedMs || trace.thinkingMs)
  if (totalDur && (trace.elapsedMs > 0 || parts.length === 0)) {
    const thoughtOnly = parts.length === 1 && !hasResumeEditDone && !hasStyleDone && trace.thinkingMs > 0 && !trace.outcome
    if (!thoughtOnly) parts.push(totalDur)
  }

  return parts.filter(Boolean).join(' · ') || t('agent.traceSumDone')
}

function formatEffortDisplay(effort = '', t) {
  const key = String(effort || '').trim().toLowerCase()
  if (!key) return ''
  if (key === 'off' || key === 'none') return t('agent.effortOff')
  if (key === 'minimal') return t('agent.effortMinimal')
  if (key === 'low') return t('agent.effortLow')
  if (key === 'medium') return t('agent.effortMedium')
  if (key === 'high') return t('agent.effortHigh')
  if (key === 'max' || key === 'xhigh' || key === 'ultra') return t('agent.effortMax')
  return effort
}

export default function TurnProcess({
  trace,
  streaming = false,
  hasContent = false,
  fallbackStatus = '',
  hasStagedProposal = false,
  onInspectEdit,
}) {
  const { t } = useI18n()
  const [foldOpen, setFoldOpen] = React.useState(false)
  const [liveThinkingOpen, setLiveThinkingOpen] = React.useState(false)
  const [settledThinkingOpen, setSettledThinkingOpen] = React.useState(false)
  const [ctxOpen, setCtxOpen] = React.useState(false)
  const [openSteps, setOpenSteps] = React.useState({})

  const effectiveTrace = (trace && typeof trace === 'object') ? trace : null

  const steps = Array.isArray(effectiveTrace?.steps) ? effectiveTrace.steps : []
  const contextItems = Array.isArray(effectiveTrace?.contextItems) ? effectiveTrace.contextItems : []
  const citedEvidenceCount = Number(effectiveTrace?.citedEvidenceCount) || 0
  const thinkingText = effectiveTrace?.thinkingText || ''
  const thinkingMs = Number(effectiveTrace?.thinkingMs) || 0
  const ongoingStep = steps.find(s => s?.state === 'ongoing') || null
  const hasRunningStep = Boolean(ongoingStep)
  const isActivelyThinking = Boolean(streaming && thinkingText && thinkingMs <= 0 && !hasRunningStep && !hasContent)
  const needsLiveWaitRow = Boolean(streaming && !hasContent && !hasRunningStep && !isActivelyThinking)
  const liveThinkingElapsed = useElapsedSeconds(isActivelyThinking, effectiveTrace?.thinkingStartedAt)
  const ongoingStepElapsed = useElapsedSeconds(Boolean(streaming && ongoingStep), ongoingStep?.startedAt)
  const waitElapsed = useElapsedSeconds(needsLiveWaitRow, effectiveTrace?.attemptStartedAt || effectiveTrace?.startedAt)

  if (!effectiveTrace) return null

  if (streaming) {
    const shownThinkMs = isActivelyThinking ? liveThinkingElapsed : thinkingMs
    const waitTitle = steps.length > 0
      ? (fallbackStatus || t('agent.traceSummarizing'))
      : (fallbackStatus || t('agent.statusThinking'))
    return (
      <div className="ca-turn-process is-live" aria-live="polite">
        {contextItems.length > 0 && (
          <DisclosureRow
            icon={<StateDot state="done" appearance="step" />}
            title={t('agent.traceCtxLoaded')}
            collapsedContent={<span className="ca-tp-meta">{formatContextSummaryLine(contextItems, citedEvidenceCount, t)}</span>}
            open={ctxOpen}
            expandable={contextItems.length > 0}
            expandOnRowClick={true}
            keepContentWhenOpen={true}
            onToggle={() => setCtxOpen(v => !v)}
          >
            <div className="ca-tp-rail">
              <ul className="ca-tp-ctx-list">
                {contextItems.map((item, idx) => (
                  <li key={`${item.kind}-${idx}`}>{formatContextItemDetail(item, citedEvidenceCount, t)}</li>
                ))}
              </ul>
            </div>
          </DisclosureRow>
        )}

        {(thinkingText || thinkingMs > 0) && (
          <DisclosureRow
            icon={<StateDot state={isActivelyThinking ? 'ongoing' : 'done'} appearance="step" />}
            title={isActivelyThinking ? t('agent.thinkingActive') : t('agent.thinkingDone')}
            collapsedContent={shownThinkMs > 0 ? <span className="ca-tp-meta">{formatTraceDuration(shownThinkMs)}</span> : null}
            running={isActivelyThinking}
            open={liveThinkingOpen}
            expandable={Boolean(thinkingText)}
            expandOnRowClick={Boolean(thinkingText)}
            keepContentWhenOpen={true}
            onToggle={() => { if (thinkingText) setLiveThinkingOpen(v => !v) }}
          >
            {thinkingText && (
              <div className="ca-tp-thinking-body">
                <p>{thinkingText}</p>
              </div>
            )}
          </DisclosureRow>
        )}

        {steps.map(step => {
          const isOpen = Boolean(openSteps[step.id])
          const hasSummary = Boolean(step.summary)
          const stepDur = step.id === ongoingStep?.id
            ? ongoingStepElapsed
            : (step.elapsedMs || 0)
          return (
            <DisclosureRow
              key={step.id}
              icon={<StateDot state={stepDotState(step.state)} appearance="step" />}
              title={formatStepLabel(step, t, effectiveTrace)}
              collapsedContent={stepDur > 0 ? <span className="ca-tp-meta">{formatTraceDuration(stepDur)}</span> : null}
              keepContentWhenOpen={true}
              running={step.state === 'ongoing'}
              open={isOpen}
              expandable={hasSummary}
              expandOnRowClick={hasSummary}
              onToggle={() => {
                if (!hasSummary) return
                setOpenSteps(prev => ({ ...prev, [step.id]: !prev[step.id] }))
              }}
            >
              {hasSummary && (
                <div className="ca-tp-step-body">{step.summary}</div>
              )}
            </DisclosureRow>
          )
        })}

        {needsLiveWaitRow && (
          <DisclosureRow
            icon={<StateDot state="ongoing" appearance="step" />}
            title={waitTitle}
            collapsedContent={waitElapsed > 0 ? <span className="ca-tp-meta">{formatTraceDuration(waitElapsed)}</span> : null}
            running={true}
            open={false}
            expandable={false}
            onToggle={() => {}}
          />
        )}
      </div>
    )
  }

  const effortLabel = formatEffortDisplay(effectiveTrace.effort, t)
  const routeFoot = [
    effectiveTrace.modelName || '',
    effortLabel,
    formatTraceDuration(effectiveTrace.elapsedMs),
  ].filter(Boolean).join(' · ')
  const hasDetails = contextItems.length > 0
    || Boolean(thinkingText)
    || thinkingMs > 0
    || steps.length > 0
    || citedEvidenceCount > 0
    || Boolean(routeFoot)
  const summaryTitle = summarizeTurnProcess(effectiveTrace, t)
  if (!summaryTitle && !hasDetails) return null

  return (
    <div className="ca-turn-process is-folded">
      <DisclosureRow
        icon={<StateDot state={outcomeToDotState(effectiveTrace.outcome)} appearance="step" />}
        title={summaryTitle || t('agent.traceSumDone')}
        open={foldOpen}
        expandable={hasDetails}
        expandOnRowClick={hasDetails}
        previewChevron={hasDetails}
        onToggle={() => { if (hasDetails) setFoldOpen(v => !v) }}
      >
        <div className="ca-tp-rail">
          {contextItems.length > 0 && (
            <div className="ca-tp-group">
              <span className="ca-tp-group-label">{t('agent.traceCtxSection')}</span>
              <ul className="ca-tp-ctx-list">
                {contextItems.map((item, idx) => (
                  <li key={`${item.kind}-${idx}`}>{formatContextItemDetail(item, citedEvidenceCount, t)}</li>
                ))}
              </ul>
            </div>
          )}

          {(thinkingText || thinkingMs > 0) && (
            <DisclosureRow
              icon={<StateDot state="done" appearance="step" />}
              title={t('agent.thinkingDone')}
              collapsedContent={thinkingMs > 0 ? <span className="ca-tp-meta">{formatTraceDuration(thinkingMs)}</span> : null}
              open={settledThinkingOpen}
              expandable={Boolean(thinkingText)}
              expandOnRowClick={Boolean(thinkingText)}
              keepContentWhenOpen={true}
              onToggle={() => { if (thinkingText) setSettledThinkingOpen(v => !v) }}
            >
              {thinkingText && (
                <div className="ca-tp-thinking-body">
                  <p>{thinkingText}</p>
                </div>
              )}
            </DisclosureRow>
          )}

          {steps.map(step => {
            const isOpen = Boolean(openSteps[step.id])
            const hasSummary = Boolean(step.summary)
            const canInspect = step.name === 'update_resume' && step.state === 'done' && typeof onInspectEdit === 'function' && hasStagedProposal
            return (
              <DisclosureRow
                key={step.id}
                icon={<StateDot state={stepDotState(step.state)} appearance="step" />}
                title={formatStepLabel(step, t, effectiveTrace)}
                open={isOpen}
                expandable={hasSummary}
                expandOnRowClick={hasSummary}
                headerAccessory={canInspect ? (
                  <button type="button" className="ca-text-button ca-tp-accessory" onClick={onInspectEdit}>
                    {t('agent.focusReviewBar')}
                  </button>
                ) : null}
                onToggle={() => {
                  if (!hasSummary) return
                  setOpenSteps(prev => ({ ...prev, [step.id]: !prev[step.id] }))
                }}
              >
                {hasSummary && (
                  <div className="ca-tp-step-body">{step.summary}</div>
                )}
              </DisclosureRow>
            )
          })}

          {routeFoot && (
            <div className="ca-tp-foot">{routeFoot}</div>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
