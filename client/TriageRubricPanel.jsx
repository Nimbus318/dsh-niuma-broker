import React from 'react'
import { createPortal } from 'react-dom'
import {
  Button, useDismissOnOutsidePointer, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DeepSeekMark } from './Emblems.jsx'
import { useI18n } from './i18n.jsx'

const list = value => (Array.isArray(value) ? value : [])

function resolveMatchFactSignals(match) {
  if (Array.isArray(match?.factSignals) && match.factSignals.length > 0) {
    return match.factSignals.filter(Boolean)
  }
  return list(match?.breakdown)
    .filter(row => row && row.key !== 'base')
    .map(row => {
      const delta = Number(row.delta) || 0
      const isCaution = Boolean(row.explicitExclude || row.hardExclude || row.hiddenCompany || row.outsideTargetCountry || row.offRoleCap || delta < 0)
      return {
        key: String(row.key || ''),
        kind: isCaution ? 'caution' : (delta > 0 ? 'match' : 'miss'),
        label: String(row.label || ''),
        detail: String(row.detail || ''),
      }
    })
}

function formatRubricLevel(dim, value, t) {
  if (value === null && dim === 'L') {
    return { text: t('jobs.rubricNotStated'), tone: 'is-muted' }
  }
  if (value === 'unknown' || value === undefined) {
    return { text: t('jobs.rubricUnknown'), tone: 'is-warn' }
  }
  const n = Number(value)
  if (!Number.isFinite(n)) return { text: t('jobs.rubricUnknown'), tone: 'is-warn' }
  const tone = n >= 3 ? 'is-high' : n >= 2 ? 'is-mid' : n === 1 ? 'is-low' : 'is-zero'
  return { text: `${n}/3`, tone }
}

function formatTokenStat(val, t) {
  return Number.isFinite(val) ? Number(val).toLocaleString('en-US') : t('jobs.tokenUnreported')
}

export function TriageConfirmDialog({ request, busy, onCancel, onConfirm }) {
  const { t } = useI18n()
  const dialogRef = React.useRef(null)
  const open = Boolean(request)
  useModalLayer(dialogRef, open, onCancel)

  React.useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    if (open && !node.open) {
      try { node.showModal() } catch {}
    } else if (!open && node.open) {
      try { node.close() } catch {}
    }
  }, [open])

  if (!request) return null
  const scopeText = request.mode === 'single'
    ? t('jobs.triageConfirmSingleScope', {
        company: request.job?.company || t('common.company'),
        title: request.job?.title || t('common.role'),
      })
    : request.filterScope === 'filtered'
      ? t('jobs.triageConfirmFilteredScope', { count: request.count })
      : t('jobs.triageConfirmBatchScope', { count: request.count })
  const basisLabel = request.basisResume?.kind === 'resume' || request.basisResume?.title
    ? `${request.basisResume.title}${request.basisResume.versionTag ? ` ${request.basisResume.versionTag}` : ''}${request.basisResume.isDefault ? t('jobs.matchBasisDefaultSuffix') : ''}`
    : t('jobs.matchBasisGoal')

  return (
    <dialog
      ref={dialogRef}
      className="ca-triage-confirm-dialog"
      aria-labelledby="ca-triage-confirm-title"
      onCancel={event => { event.preventDefault(); onCancel?.() }}
      onClick={event => { if (event.target === dialogRef.current) onCancel?.() }}
    >
      <div className="ca-triage-confirm-shell">
        <div className="ca-triage-confirm-head">
          <span className="ca-inline-mark">
            <DeepSeekMark size={15} />
            <h3 id="ca-triage-confirm-title">{t('jobs.triageConfirmTitle')}</h3>
          </span>
        </div>
        <div className="ca-triage-confirm-body">
          <p className="ca-triage-confirm-scope">{scopeText}</p>
          <p className="ca-triage-confirm-meta">
            {Number.isFinite(request.estimatedInputTokens) && Number.isFinite(request.maxOutputTokens)
              ? t('jobs.triageConfirmEstimateSplit', {
                  input: Number(request.estimatedInputTokens || 0).toLocaleString('en-US'),
                  outMin: Number(request.minOutputTokens || 0).toLocaleString('en-US'),
                  outMax: Number(request.maxOutputTokens || 0).toLocaleString('en-US'),
                })
              : t('jobs.triageConfirmEstimate', { min: request.minTokens, max: request.maxTokens })}
          </p>
          <p className="ca-triage-confirm-meta">{t('jobs.triageConfirmBasis', { basis: basisLabel })}</p>
          <p className="ca-triage-confirm-note">{t('jobs.triageConfirmPrivacy')}</p>
        </div>
        <div className="ca-triage-confirm-actions">
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!!busy} onClick={onConfirm}>{t('jobs.triageConfirmAction')}</Button>
        </div>
      </div>
    </dialog>
  )
}

export function TriageReceiptBanner({ receipt, onDismiss }) {
  const { t } = useI18n()
  if (!receipt) return null
  const est = receipt.estimated || {}
  const usage = receipt.usage || {}
  const counts = receipt.counts || {}
  const estInText = Number.isFinite(est.inputTokens)
    ? Number(est.inputTokens).toLocaleString('en-US')
    : (Number.isFinite(est.maxTokens) && est.maxTokens > 0
      ? `${Number(est.minTokens || 0).toLocaleString('en-US')}–${Number(est.maxTokens).toLocaleString('en-US')}`
      : t('jobs.tokenUnreported'))
  const estOutText = Number.isFinite(est.maxOutputTokens)
    ? `${Number(est.minOutputTokens || 0).toLocaleString('en-US')}–${Number(est.maxOutputTokens).toLocaleString('en-US')}`
    : t('jobs.tokenUnreported')

  return (
    <div className="ca-triage-receipt" role="status">
      <div className="ca-triage-receipt-head">
        <span className="ca-inline-mark">
          <DeepSeekMark size={12} />
          <strong>{t('jobs.receiptTitle')}</strong>
          {usage.reported && !usage.complete && (
            <span className="ca-triage-receipt-partial">{t('jobs.receiptPartialNote')}</span>
          )}
        </span>
        {onDismiss && (
          <button type="button" className="ca-triage-receipt-close" aria-label={t('common.cancel')} onClick={onDismiss}>×</button>
        )}
      </div>
      <div className="ca-triage-receipt-grid">
        <span>{t('jobs.receiptEstimate', { range: estInText })}</span>
        <span>{t('jobs.receiptOutputEstimate', { range: estOutText })}</span>
        <span>{t('jobs.receiptUncachedInput', { count: formatTokenStat(usage.inputTokens, t) })}</span>
        <span>{t('jobs.receiptCacheRead', { count: formatTokenStat(usage.cacheReadTokens, t) })}</span>
        <span>{t('jobs.receiptCacheWrite', { count: formatTokenStat(usage.cacheWriteTokens, t) })}</span>
        <span>{t('jobs.receiptOutput', { count: formatTokenStat(usage.outputTokens, t) })}</span>
        <span>{t('jobs.receiptTotalTokens', { count: formatTokenStat(usage.totalTokens, t) })}</span>
      </div>
      <div className="ca-triage-receipt-counts">
        <span>{t('jobs.receiptWritten', { count: counts.written ?? 0 })}</span>
        <span>{t('jobs.receiptSkipped', { count: counts.skipped ?? 0 })}</span>
        <span>{t('jobs.receiptFailed', { count: counts.failed ?? 0 })}</span>
        <span>{t('jobs.receiptCancelled', { count: counts.cancelled ?? 0 })}</span>
      </div>
    </div>
  )
}

export function MatchScoreBadge({ match, isDismissed, basisResume = null, open, onToggle, onClose, onRecheck, rechecking }) {
  const { t } = useI18n()
  const triggerRef = React.useRef(null)
  const popRef = React.useRef(null)
  const [coords, setCoords] = React.useState(null)

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setCoords(null)
      return
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const popWidth = 368
      const measuredHeight = popRef.current?.getBoundingClientRect().height || 420
      const margin = 12
      const gap = 8
      const spaceBelow = window.innerHeight - rect.bottom - margin - gap
      const spaceAbove = rect.top - margin - gap
      const openAbove = spaceBelow < measuredHeight && spaceAbove > spaceBelow
      const left = Math.max(margin, Math.min(rect.right - popWidth, window.innerWidth - popWidth - margin))
      if (openAbove) {
        setCoords({
          left,
          bottom: window.innerHeight - rect.top + gap,
          maxHeight: Math.max(240, spaceAbove),
          placement: 'top',
        })
      } else {
        setCoords({
          left,
          top: rect.bottom + gap,
          maxHeight: Math.max(240, spaceBelow),
          placement: 'bottom',
        })
      }
    }
    updatePosition()
    const raf = window.requestAnimationFrame(updatePosition)
    const onResize = () => updatePosition()
    const onScroll = event => {
      if (popRef.current && event?.target instanceof Node && popRef.current.contains(event.target)) return
      updatePosition()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const portalHost = (typeof document !== 'undefined' && (document.querySelector('.ca-page') || document.body)) || null
  const popoverActive = Boolean(open && coords && !isDismissed && match)
  const dismissPopoverOutside = React.useCallback(next => {
    if (!next) onClose?.()
  }, [onClose])
  useDismissOnOutsidePointer(triggerRef, popoverActive, dismissPopoverOutside, popRef)
  useModalLayer(popRef, popoverActive, onClose)

  if (isDismissed) {
    return <span className="ca-score-pill is-muted">{t('jobs.dismissedPill')}</span>
  }
  if (!match) {
    return <span className="ca-score-pill is-muted">{t('stage.discovered')}</span>
  }

  const isMissingJd = Boolean(match && match.mode !== 'llm' && (match.missingJd || match.uncertaintyCode === 'missing_jd'))
  const zone = match.zone || (isMissingJd ? 'missing_jd' : match.mode === 'llm' ? 'legacy_v1' : 'pending_local')
  const isRubricV2 = zone === 'rubric_v2' && Boolean(match.rubric)
  const isLegacyV1 = zone === 'legacy_v1'
  const isEvaluated = zone === 'rubric_v2' || zone === 'legacy_v1'
  const isPendingLocal = zone === 'pending_local'
  const tierMeta = match.tier === 'top'
    ? { label: t('jobs.tierTop'), cls: 'is-top' }
    : match.tier === 'good'
      ? { label: t('jobs.tierGood'), cls: 'is-good' }
      : match.tier === 'stretch'
        ? { label: t('jobs.tierStretch'), cls: 'is-stretch' }
        : { label: t('jobs.tierLow'), cls: 'is-muted' }

  const signalOrder = { match: 0, caution: 1, miss: 2 }
  const signals = resolveMatchFactSignals(match)
    .slice()
    .sort((a, b) => (signalOrder[a.kind] ?? 2) - (signalOrder[b.kind] ?? 2))

  const formatResumeBasis = b => `${b.title}${b.versionTag ? ` ${b.versionTag}` : ''}${b.isDefault ? t('jobs.matchBasisDefaultSuffix') : ''}`
  const basisLabel = isEvaluated
    ? (match.evalBasis?.kind === 'resume' && match.evalBasis?.title
      ? formatResumeBasis(match.evalBasis)
      : match.evalBasis?.kind === 'goal'
        ? t('jobs.matchBasisGoal')
        : t('jobs.matchBasisUnknown'))
    : (basisResume ? formatResumeBasis(basisResume) : t('jobs.matchBasisGoal'))

  const dMeta = isRubricV2 ? formatRubricLevel('D', match.rubric.D, t) : null
  const eMeta = isRubricV2 ? formatRubricLevel('E', match.rubric.E, t) : null
  const lMeta = isRubricV2 ? formatRubricLevel('L', match.rubric.L, t) : null
  const jdEvidence = isRubricV2 ? list(match.rubric.jdEvidence) : []
  const resumeEvidence = isRubricV2 ? list(match.rubric.resumeEvidence) : []

  const popoverNode = popoverActive ? (
    <div
      ref={popRef}
      className={`ca-score-pop ca-popover-surface${coords.placement === 'top' ? ' is-top-placed' : ''}`}
      role="dialog"
      aria-label={t('jobs.scoreDetailsAria')}
      style={{
        left: `${coords.left}px`,
        ...(coords.top != null ? { top: `${coords.top}px` } : {}),
        ...(coords.bottom != null ? { bottom: `${coords.bottom}px` } : {}),
        maxHeight: `${coords.maxHeight}px`,
      }}
      onClick={event => event.stopPropagation()}
    >
      <div className="ca-score-pop-head">
        <div className="ca-score-pop-total">
          {isMissingJd ? <>
            <em className="ca-score-pop-tier is-muted">{t('jobs.missingJdBadge')}</em>
            <span className="ca-score-uncertain-pill">{t('jobs.uncertainBadge')}</span>
          </> : isPendingLocal ? <>
            <em className="ca-score-pop-tier is-muted">{t('jobs.pendingLocalBadge')}</em>
            {match.uncertain && <span className="ca-score-uncertain-pill">{t('jobs.uncertainBadge')}</span>}
          </> : <>
            <em className={`ca-score-pop-tier ${tierMeta.cls}`}>{tierMeta.label}</em>
            {match.uncertain && <span className="ca-score-uncertain-pill">{t('jobs.uncertainBadge')}</span>}
          </>}
        </div>
        <span className="ca-score-pop-mode">
          {isMissingJd
            ? t('jobs.missingJdMode')
            : isLegacyV1
              ? t('jobs.legacyAiBadge')
              : isEvaluated
                ? <span className="ca-inline-mark"><DeepSeekMark size={13} /><span>{t('jobs.llmSemanticRank')}</span></span>
                : t('jobs.heuristicPreRank')}
        </span>
      </div>

      <div className="ca-score-basis">
        <span>{t('jobs.matchBasis')}</span>
        <strong title={t('jobs.matchBasisTitle')}>{basisLabel}</strong>
      </div>

      {isRubricV2 && (
        <div className="ca-rubric-grid">
          <div className="ca-rubric-cell">
            <span>{t('jobs.rubricDimD')}</span>
            <strong className={dMeta.tone}>{dMeta.text}</strong>
          </div>
          <div className="ca-rubric-cell">
            <span>{t('jobs.rubricDimE')}</span>
            <strong className={eMeta.tone}>{eMeta.text}</strong>
          </div>
          <div className="ca-rubric-cell">
            <span>{t('jobs.rubricDimL')}</span>
            <strong className={lMeta.tone}>{lMeta.text}</strong>
          </div>
        </div>
      )}

      {isRubricV2 && match.rubric?.jdTruncated && (
        <p className="ca-score-summary-caution">{t('jobs.rubricExcerptedNote')}</p>
      )}

      {isPendingLocal ? (
        <div className="ca-score-summary">
          <p className="ca-score-summary-text">{t('jobs.pendingLocalNote')}</p>
          {(match.uncertain && match.uncertaintyReason ? match.uncertaintyReason : match.caution) && (
            <p className="ca-score-summary-caution">
              {t('jobs.cautionPrefix', { text: (match.uncertain && match.uncertaintyReason) ? match.uncertaintyReason : match.caution })}
            </p>
          )}
        </div>
      ) : (match.reason || match.caution || (match.uncertain && match.uncertaintyReason)) && (
        <div className="ca-score-summary">
          <span className="ca-score-summary-kicker">{t('jobs.scoreSummaryLabel')}</span>
          {match.reason && <p className="ca-score-summary-text">{match.reason}</p>}
          {isMissingJd
            ? (match.uncertaintyReason && <p className="ca-score-summary-caution">{match.uncertaintyReason}</p>)
            : <>
                {(match.caution || (match.uncertain && match.uncertaintyReason)) && (
                  <p className="ca-score-summary-caution">{t('jobs.cautionPrefix', { text: match.caution || match.uncertaintyReason })}</p>
                )}
                {match.uncertain && match.uncertaintyReason && match.caution && !match.caution.includes(match.uncertaintyReason) && !match.uncertaintyReason.startsWith(match.caution) && (
                  <p className="ca-score-summary-caution">{match.uncertaintyReason}</p>
                )}
              </>}
        </div>
      )}

      {isRubricV2 ? <>
        {jdEvidence.length > 0 && (
          <div className="ca-rubric-evidence">
            <span className="ca-score-quote-label">{t('jobs.roleQuoteLabel')}</span>
            {jdEvidence.map(ev => (
              <blockquote key={ev.id} className="ca-score-quote">
                <p><code>[{ev.id}]</code> {ev.text}</p>
              </blockquote>
            ))}
          </div>
        )}
        {resumeEvidence.length > 0 && (
          <div className="ca-rubric-evidence">
            <span className="ca-score-quote-label">{t('jobs.resumeEvidenceLabel')}</span>
            {resumeEvidence.map(ev => (
              <blockquote key={ev.id} className="ca-score-quote is-resume">
                <p><code>[{ev.id}]</code> {ev.text}</p>
              </blockquote>
            ))}
          </div>
        )}
      </> : isEvaluated && match.roleQuote && (
        <blockquote className="ca-score-quote">
          <span className="ca-score-quote-label">{t('jobs.roleQuoteLabel')}</span>
          <p>{match.roleQuote}</p>
        </blockquote>
      )}

      {!isMissingJd && (signals.length > 0 ? (
        <div className="ca-score-rows">
          {signals.map(row => {
            const statusTone = row.kind === 'caution' ? 'is-neg' : row.kind === 'match' ? 'is-pos' : 'is-zero'
            const statusText = row.kind === 'caution'
              ? t('jobs.scoreFactorAdjust')
              : row.kind === 'miss'
                ? t('jobs.scoreFactorMiss')
                : t('jobs.scoreFactorMatch')
            return (
              <div key={row.key + row.label} className={`ca-score-row${row.kind === 'miss' ? ' is-unmatched' : ''}`}>
                <div className="ca-score-row-left">
                  <div className="ca-score-row-head">
                    <span className="ca-score-row-label">{row.label}</span>
                    <span className={`ca-score-factor-tag ${statusTone}`}>{statusText}</span>
                  </div>
                  {row.detail && <small className="ca-score-row-detail">{row.detail}</small>}
                </div>
              </div>
            )
          })}
        </div>
      ) : !isEvaluated && (
        <p className="ca-score-pop-note">{t('jobs.scoreNoBreakdown')}</p>
      ))}

      {onRecheck && (
        <Button variant="ghost" size="sm" disabled={rechecking} onClick={onRecheck}>
          {rechecking ? t('jobs.triaging') : t('jobs.retriageOne')}
        </Button>
      )}
    </div>
  ) : null

  return <div className="ca-score-wrap" onClick={event => event.stopPropagation()}>
    <button
      ref={triggerRef}
      type="button"
      className={`ca-score-trigger ${isMissingJd || isPendingLocal ? 'is-muted' : tierMeta.cls}${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={t('jobs.scoreClickTitle')}
      onClick={onToggle}
    >
      {isMissingJd ? (
        <span className="ca-score-tier">{t('jobs.missingJdBadge')}</span>
      ) : isPendingLocal ? (
        <span className="ca-score-tier">{t('jobs.pendingLocalBadge')}</span>
      ) : <>
        <span className="ca-score-tier">{tierMeta.label}</span>
        {isLegacyV1 && <span className="ca-score-zone-tag">{t('jobs.legacyAiBadge')}</span>}
      </>}
      <svg className="ca-score-info" width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.35" />
        <path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    {popoverNode && portalHost ? createPortal(popoverNode, portalHost) : popoverNode}
  </div>
}
