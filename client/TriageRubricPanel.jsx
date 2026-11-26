import React from 'react'
import { createPortal } from 'react-dom'
import {
  Button, useDismissOnOutsidePointer, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DeepSeekMark } from './Emblems.jsx'
import { useI18n } from './i18n.jsx'

const list = value => (Array.isArray(value) ? value : [])

/**
 * Strips machine citation IDs (`[J13_1]`, `[R12]`, `【J1】`) and optional leading Markdown
 * heading/bullet syntax so triage prose and quotes read cleanly to end users.
 */
export function cleanTriageDisplayText(raw, { stripMarkdown = false } = {}) {
  let text = typeof raw === 'string' ? raw : String(raw || '')
  if (!text) return ''
  text = text
    .replace(/(?:(?:\[|【)\s*[JR]\d+(?:_\d+)?\s*(?:\]|】)\s*)+(?:(?:中|里)?的\s*)?/giu, ' ')
    .replace(/\s+([,，.。;；:：、!！?？])/gu, '$1')
    .replace(/([，。；：、！？])\s+/gu, '$1')
    .replace(/([（(])\s+/gu, '$1')
    .replace(/\s+([）)])/gu, '$1')
    .replace(/([,，;；:：、])\s*(?=[,，;；:：、。！？.!?])/gu, '')
    .replace(/^[\s,，;；:：、.。·•-]+/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (stripMarkdown && text) {
    text = text.replace(/^(?:#{1,6}\s+|[-*•]\s+)/u, '').trim()
  }
  return text
}

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

function formatFitSignal(dim, value, t) {
  if (dim === 'D') {
    const n = Number(value)
    if (n === 3) return { label: t('jobs.fitRoleLabel'), status: t('jobs.fitRoleDirect'), tone: 'is-high' }
    if (n === 2) return { label: t('jobs.fitRoleLabel'), status: t('jobs.fitRoleStrong'), tone: 'is-mid' }
    if (n === 1) return { label: t('jobs.fitRoleLabel'), status: t('jobs.fitRolePartial'), tone: 'is-low' }
    return { label: t('jobs.fitRoleLabel'), status: t('jobs.fitRoleMismatch'), tone: 'is-zero' }
  }
  if (dim === 'E') {
    if (value === 'unknown' || value === undefined || value === null) {
      return { label: t('jobs.fitProofLabel'), status: t('jobs.fitProofUnknown'), tone: 'is-warn' }
    }
    const n = Number(value)
    if (n >= 3) return { label: t('jobs.fitProofLabel'), status: t('jobs.fitProofSolid'), tone: 'is-high' }
    if (n === 2) return { label: t('jobs.fitProofLabel'), status: t('jobs.fitProofTransferable'), tone: 'is-mid' }
    if (n === 1) return { label: t('jobs.fitProofLabel'), status: t('jobs.fitProofLight'), tone: 'is-low' }
    return { label: t('jobs.fitProofLabel'), status: t('jobs.fitProofNone'), tone: 'is-zero' }
  }
  if (value === null) {
    return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelOpen'), tone: 'is-muted' }
  }
  if (value === 'unknown' || value === undefined) {
    return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelUnknown'), tone: 'is-warn' }
  }
  const n = Number(value)
  if (n >= 3) return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelAligned'), tone: 'is-high' }
  if (n === 2) return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelClose'), tone: 'is-mid' }
  if (n === 1) return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelStretch'), tone: 'is-low' }
  return { label: t('jobs.fitLevelLabel'), status: t('jobs.fitLevelGap'), tone: 'is-zero' }
}

function formatTokenCount(val, t) {
  return Number.isFinite(val) ? Number(val).toLocaleString('en-US') : t('jobs.tokenUnreported')
}

function formatCompactTokens(val) {
  if (!Number.isFinite(val)) return ''
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M tok`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1).replace(/\.0$/u, '')}k tok`
  return `${Math.round(val).toLocaleString('en-US')} tok`
}

function TokenMetricIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="4.2" rx="4.8" ry="1.8" stroke="currentColor" strokeWidth="1.25" />
      <path d="M3.2 4.2v3.6c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8V4.2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M3.2 7.8v3.8c0 1 2.15 1.8 4.8 1.8s4.8-.8 4.8-1.8V7.8" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

export function TriageReceiptBanner({ receipt, onDismiss }) {
  const { t } = useI18n()
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState(null)
  const triggerRef = React.useRef(null)
  const popRef = React.useRef(null)

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setCoords(null)
      return
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const popWidth = 286
      const margin = 12
      const gap = 8
      const left = Math.max(margin, Math.min(rect.right - popWidth, window.innerWidth - popWidth - margin))
      const spaceBelow = window.innerHeight - rect.bottom - margin - gap
      const spaceAbove = rect.top - margin - gap
      const openAbove = spaceBelow < 240 && spaceAbove > spaceBelow
      if (openAbove) {
        setCoords({ left, bottom: window.innerHeight - rect.top + gap, maxHeight: Math.max(200, spaceAbove) })
      } else {
        setCoords({ left, top: rect.bottom + gap, maxHeight: Math.max(200, spaceBelow) })
      }
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, receipt?.at])

  const closePopover = React.useCallback(() => setOpen(false), [])
  const popoverActive = Boolean(open && coords && receipt)
  const dismissOutside = React.useCallback(next => {
    if (!next) setOpen(false)
  }, [])
  useDismissOnOutsidePointer(triggerRef, popoverActive, dismissOutside, popRef)
  useModalLayer(popRef, popoverActive, closePopover)

  if (!receipt) return null
  const est = receipt.estimated || {}
  const usage = receipt.usage || {}
  const counts = receipt.counts || {}
  const written = Number(counts.written ?? 0)
  const failed = Number(counts.failed ?? 0)
  const skipped = Number(counts.skipped ?? 0)
  const cancelled = Number(counts.cancelled ?? 0)

  const headline = written > 0 && failed > 0
    ? t('jobs.receiptSummaryPartial', { written, failed })
    : written > 0
      ? t('jobs.receiptSummaryDone', { count: written })
      : failed > 0
        ? t('jobs.receiptSummaryUnfinishedOnly', { failed })
        : t('jobs.receiptSummaryNone')

  const tokenParts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens].filter(Number.isFinite)
  const resolvedTotal = Number.isFinite(usage.totalTokens)
    ? usage.totalTokens
    : (tokenParts.length > 0 ? tokenParts.reduce((sum, n) => sum + n, 0) : null)

  const promptDenom = (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0)
    + (Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0)
    + (Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0)
  const cacheHitPct = Number.isFinite(usage.cacheReadTokens) && promptDenom > 0
    ? Math.round((usage.cacheReadTokens / promptDenom) * 100)
    : null

  const estInText = Number.isFinite(est.inputTokens)
    ? `${Number(est.inputTokens).toLocaleString('en-US')} tok`
    : (Number.isFinite(est.maxTokens) && est.maxTokens > 0
      ? `${Number(est.minTokens || 0).toLocaleString('en-US')}–${Number(est.maxTokens).toLocaleString('en-US')} tok`
      : null)

  const pillText = resolvedTotal !== null
    ? formatCompactTokens(resolvedTotal)
    : t('jobs.receiptUsagePopoverTitle')

  const portalHost = (typeof document !== 'undefined' && (document.querySelector('.ca-page') || document.body)) || null
  const popoverNode = popoverActive ? (
    <div
      ref={popRef}
      className="ca-receipt-pop ca-popover-surface"
      role="dialog"
      aria-label={t('jobs.receiptUsagePopoverTitle')}
      style={{
        left: `${coords.left}px`,
        ...(coords.top != null ? { top: `${coords.top}px` } : {}),
        ...(coords.bottom != null ? { bottom: `${coords.bottom}px` } : {}),
        maxHeight: `${coords.maxHeight}px`,
      }}
    >
      <div className="ca-receipt-pop-head">
        <span className="ca-receipt-pop-title">
          <TokenMetricIcon />
          <span>{t('jobs.receiptUsagePopoverTitle')}</span>
        </span>
        <strong className="ca-receipt-pop-total">
          {resolvedTotal !== null ? `${Number(resolvedTotal).toLocaleString('en-US')} tok` : t('jobs.tokenUnreported')}
        </strong>
      </div>
      <div className="ca-receipt-pop-rows">
        {cacheHitPct !== null && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptCacheHitLabel')}</span>
            <strong>{cacheHitPct}%</strong>
          </div>
        )}
        {Number.isFinite(usage.inputTokens) && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptUncachedInput', { count: '' }).replace(/[:：]\s*$/u, '')}</span>
            <strong>{formatTokenCount(usage.inputTokens, t)} tok</strong>
          </div>
        )}
        {Number.isFinite(usage.cacheReadTokens) && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptCacheRead', { count: '' }).replace(/[:：]\s*$/u, '')}</span>
            <strong>{formatTokenCount(usage.cacheReadTokens, t)} tok</strong>
          </div>
        )}
        {Number.isFinite(usage.cacheWriteTokens) && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptCacheWrite', { count: '' }).replace(/[:：]\s*$/u, '')}</span>
            <strong>{formatTokenCount(usage.cacheWriteTokens, t)} tok</strong>
          </div>
        )}
        {Number.isFinite(usage.outputTokens) && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptOutput', { count: '' }).replace(/[:：]\s*$/u, '')}</span>
            <strong>{formatTokenCount(usage.outputTokens, t)} tok</strong>
          </div>
        )}
        {estInText && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptEstimateLabel')}</span>
            <strong>{estInText}</strong>
          </div>
        )}
      </div>
      <div className="ca-receipt-pop-rows is-outcomes">
        <div className="ca-receipt-pop-row">
          <span>{t('jobs.receiptWritten', { count: '' }).trim()}</span>
          <strong>{written}</strong>
        </div>
        {failed > 0 && (
          <div className="ca-receipt-pop-row is-warn">
            <span>{t('jobs.receiptFailed', { count: '' }).trim()}</span>
            <strong>{failed}</strong>
          </div>
        )}
        {skipped > 0 && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptSkipped', { count: '' }).trim()}</span>
            <strong>{skipped}</strong>
          </div>
        )}
        {cancelled > 0 && (
          <div className="ca-receipt-pop-row">
            <span>{t('jobs.receiptCancelled', { count: '' }).trim()}</span>
            <strong>{cancelled}</strong>
          </div>
        )}
      </div>
      {usage.reported && !usage.complete && (
        <p className="ca-receipt-pop-foot">{t('jobs.receiptPartialNote')}</p>
      )}
    </div>
  ) : null

  return (
    <div className={`ca-receipt-bar${failed > 0 ? ' has-warn' : ''}`} role="status">
      <span className="ca-receipt-bar-summary">
        <DeepSeekMark size={13} />
        <span>{headline}</span>
      </span>
      <span className="ca-receipt-bar-actions">
        <button
          ref={triggerRef}
          type="button"
          className={`ca-receipt-tok-pill${open ? ' is-open' : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('jobs.receiptDetailToggleAria')}
          onClick={() => setOpen(v => !v)}
        >
          <TokenMetricIcon />
          <span>{pillText}</span>
        </button>
        {onDismiss && (
          <button type="button" className="ca-triage-receipt-close" aria-label={t('common.cancel')} onClick={onDismiss}>×</button>
        )}
      </span>
      {popoverNode && portalHost ? createPortal(popoverNode, portalHost) : popoverNode}
    </div>
  )
}

export function MatchScoreBadge({ match, isDismissed, basisResume = null, open, onToggle, onClose, onRecheck, rechecking }) {
  const { t } = useI18n()
  const triggerRef = React.useRef(null)
  const popRef = React.useRef(null)
  const [coords, setCoords] = React.useState(null)
  const [evidenceOpen, setEvidenceOpen] = React.useState(false)

  React.useEffect(() => {
    if (!open) setEvidenceOpen(false)
  }, [open])

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setCoords(null)
      return
    }
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const popWidth = 372
      const measuredHeight = popRef.current?.getBoundingClientRect().height || 340
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
  }, [open, evidenceOpen])

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
  const isEvaluated = isRubricV2 || isLegacyV1
  const isPendingLocal = zone === 'pending_local'
  const tierMeta = match.tier === 'top'
    ? { label: t('jobs.tierTop'), cls: 'is-top' }
    : match.tier === 'good'
      ? { label: t('jobs.tierGood'), cls: 'is-good' }
      : match.tier === 'stretch'
        ? { label: t('jobs.tierStretch'), cls: 'is-stretch' }
        : { label: t('jobs.tierLow'), cls: 'is-muted' }

  const pendingHints = isPendingLocal
    ? resolveMatchFactSignals(match).filter(row => row.kind !== 'miss')
    : []

  const formatResumeBasis = b => `${b.title}${b.versionTag ? ` ${b.versionTag}` : ''}${b.isDefault ? t('jobs.matchBasisDefaultSuffix') : ''}`
  const knownBasisLabel = isEvaluated
    ? (match.evalBasis?.kind === 'resume' && match.evalBasis?.title
      ? formatResumeBasis(match.evalBasis)
      : match.evalBasis?.kind === 'goal'
        ? t('jobs.matchBasisGoal')
        : '')
    : (basisResume?.title ? formatResumeBasis(basisResume) : '')

  const fitSignals = isRubricV2
    ? [
        formatFitSignal('D', match.rubric.D, t),
        formatFitSignal('E', match.rubric.E, t),
        formatFitSignal('L', match.rubric.L, t),
      ]
    : []

  const cleanReason = cleanTriageDisplayText(match.reason || '')
  const rawPrimaryCaution = match.caution || (match.uncertain ? match.uncertaintyReason : '') || ''
  const cleanPrimaryCaution = cleanTriageDisplayText(rawPrimaryCaution)
  const extraUncertainty = match.uncertain && match.uncertaintyReason
    ? cleanTriageDisplayText(match.uncertaintyReason)
    : ''
  const showExtraUncertainty = Boolean(
    extraUncertainty &&
    cleanPrimaryCaution &&
    !cleanPrimaryCaution.includes(extraUncertainty) &&
    !extraUncertainty.startsWith(cleanPrimaryCaution)
  )

  const jdItems = isRubricV2
    ? list(match.rubric.jdEvidence)
      .map(ev => cleanTriageDisplayText(ev?.text || '', { stripMarkdown: true }))
      .filter(Boolean)
    : (isEvaluated && match.roleQuote
      ? [cleanTriageDisplayText(match.roleQuote, { stripMarkdown: true })].filter(Boolean)
      : [])
  const resumeItems = isRubricV2
    ? list(match.rubric.resumeEvidence)
      .map(ev => cleanTriageDisplayText(ev?.text || '', { stripMarkdown: true }))
      .filter(Boolean)
    : []
  const totalEvidenceCount = jdItems.length + resumeItems.length

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
            : isEvaluated
              ? <span className="ca-inline-mark"><DeepSeekMark size={13} /><span>{t('jobs.llmSemanticRank')}</span></span>
              : t('jobs.heuristicPreRank')}
        </span>
      </div>

      {knownBasisLabel && (
        <p className="ca-score-basis-line" title={t('jobs.matchBasisTitle')}>
          {t('jobs.matchBasisShort', { basis: knownBasisLabel })}
        </p>
      )}

      {fitSignals.length > 0 && (
        <div className="ca-fit-signals">
          {fitSignals.map(sig => (
            <div key={sig.label} className={`ca-fit-signal ${sig.tone}`}>
              <span className="ca-fit-signal-label">{sig.label}</span>
              <span className="ca-fit-signal-val">
                <i className="ca-fit-signal-dot" aria-hidden="true" />
                <strong>{sig.status}</strong>
              </span>
            </div>
          ))}
        </div>
      )}

      {isPendingLocal ? (
        <div className="ca-score-verdict">
          <p className="ca-score-pop-note">{t('jobs.pendingLocalNote')}</p>
          {cleanPrimaryCaution && (
            <p className="ca-score-verdict-caution">{t('jobs.cautionPrefix', { text: cleanPrimaryCaution })}</p>
          )}
        </div>
      ) : (cleanReason || cleanPrimaryCaution || extraUncertainty) && (
        <div className="ca-score-verdict">
          {cleanReason && <p className="ca-score-verdict-main">{cleanReason}</p>}
          {isMissingJd
            ? (extraUncertainty && <p className="ca-score-verdict-caution">{extraUncertainty}</p>)
            : <>
                {cleanPrimaryCaution && (
                  <p className="ca-score-verdict-caution">{t('jobs.cautionPrefix', { text: cleanPrimaryCaution })}</p>
                )}
                {showExtraUncertainty && (
                  <p className="ca-score-verdict-caution">{extraUncertainty}</p>
                )}
              </>}
          {isRubricV2 && match.rubric?.jdTruncated && (
            <p className="ca-score-verdict-note">{t('jobs.rubricExcerptedNote')}</p>
          )}
        </div>
      )}

      {!isMissingJd && totalEvidenceCount > 0 && (
        <div className="ca-evidence-wrap">
          <button
            type="button"
            className={`ca-evidence-toggle${evidenceOpen ? ' is-open' : ''}`}
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen(v => !v)}
          >
            <span className="ca-evidence-toggle-left">
              <span>{t('jobs.evidenceToggleLabel')}</span>
              <span className="ca-evidence-count">{t('jobs.evidenceCountPill', { count: totalEvidenceCount })}</span>
            </span>
            <svg className="ca-evidence-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 6.2L8 9.7l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {evidenceOpen && (
            <div className="ca-evidence-panel">
              {jdItems.length > 0 && (
                <section className="ca-evidence-group">
                  <header className="ca-evidence-group-head">
                    <span className="ca-evidence-pill" aria-hidden="true" />
                    <span>{t('jobs.roleQuoteLabel')}</span>
                  </header>
                  <ul className="ca-evidence-list">
                    {jdItems.map((txt, idx) => <li key={idx}>{txt}</li>)}
                  </ul>
                </section>
              )}
              {resumeItems.length > 0 && (
                <section className="ca-evidence-group is-resume">
                  <header className="ca-evidence-group-head">
                    <span className="ca-evidence-pill" aria-hidden="true" />
                    <span>{t('jobs.resumeEvidenceLabel')}</span>
                  </header>
                  <ul className="ca-evidence-list">
                    {resumeItems.map((txt, idx) => <li key={idx}>{txt}</li>)}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}

      {!isMissingJd && isPendingLocal && pendingHints.length > 0 && (
        <div className="ca-pending-hints">
          <span className="ca-pending-hints-label">{t('jobs.pendingHintsLabel')}</span>
          <div className="ca-pending-hint-list">
            {pendingHints.map(row => (
              <span key={row.key + row.label} className={`ca-pending-hint-pill${row.kind === 'caution' ? ' is-caution' : ''}`}>
                <strong>{row.label}</strong>
                {row.detail ? <em>{row.detail}</em> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      {onRecheck && (
        <Button variant="outline" size="sm" className="ca-score-recheck-btn" disabled={rechecking} onClick={onRecheck}>
          {rechecking ? t('jobs.triaging') : (isEvaluated ? t('jobs.retriageOne') : t('jobs.evaluateOne'))}
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
      ) : (
        <span className="ca-score-tier">{tierMeta.label}</span>
      )}
      <svg className="ca-score-info" width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.35" />
        <path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    {popoverNode && portalHost ? createPortal(popoverNode, portalHost) : popoverNode}
  </div>
}
