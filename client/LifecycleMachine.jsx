import React from 'react'
import { AnimatedNumber } from './Motion.jsx'
import { useI18n } from './i18n.jsx'

const ACTIVE_PIPELINE_BUCKETS = [
  {
    id: 'saved',
    label: '新机会',
    labelKey: 'bucket.saved',
    tone: 'indigo',
    stages: new Set(['discovered', 'opened', 'prepared']),
  },
  {
    id: 'applied',
    label: '已投递',
    labelKey: 'bucket.applied',
    tone: 'blue',
    stages: new Set(['contacted', 'resume_sent', 'submitted', 'acknowledged']),
  },
  {
    id: 'interview',
    label: '面试中',
    labelKey: 'bucket.interview',
    tone: 'violet',
    stages: new Set(['invited', 'interview_confirmed', 'interview_completed']),
  },
  {
    id: 'offer',
    label: 'Offer',
    labelKey: 'bucket.offer',
    tone: 'emerald',
    stages: new Set(['offer_received', 'offer_accepted', 'started']),
  },
]

const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'offer_declined'])

export const PIPELINE_BUCKETS = [
  ...ACTIVE_PIPELINE_BUCKETS,
  {
    id: 'closed',
    label: '已结束',
    labelKey: 'bucket.closed',
    tone: 'slate',
    stages: CLOSED_STAGES,
  },
]

function bucketIndexOf(stage) {
  const idx = ACTIVE_PIPELINE_BUCKETS.findIndex(b => b.stages.has(stage))
  return idx >= 0 ? idx : 0
}

export function bucketIdOf(stage) {
  if (CLOSED_STAGES.has(stage)) return 'closed'
  const match = ACTIVE_PIPELINE_BUCKETS.find(b => b.stages.has(stage))
  return match?.id ?? 'saved'
}

export function bucketToneOf(stage) {
  if (CLOSED_STAGES.has(stage)) return 'slate'
  const match = ACTIVE_PIPELINE_BUCKETS.find(b => b.stages.has(stage))
  return match?.tone ?? 'indigo'
}

/**
 * Bespoke sculpted multi-layer emblems (Apple / Things 3 / Linear dimensional craft).
 * No generic wireframe strokes inside pastel squares — each stage is a miniature physical object.
 */
export function StageLogo({ id, size = 32, active = false, hasItems = false }) {
  const uid = React.useId().replace(/:/g, '')

  // 01. 新机会 — Sculpted Deep Maritime Slate Compass with Warm Vermilion Needle
  if (id === 'saved') {
    const dial = `sm-dial-${uid}`
    const gloss = `sm-gloss-${uid}`
    const tip = `sm-tip-${uid}`
    return (
      <svg className="ca-sm-emblem ca-sm-emblem-saved" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={dial} x1="4" y1="3" x2="24" y2="25" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#355578" />
            <stop offset="56%" stopColor="#253e59" />
            <stop offset="100%" stopColor="#162638" />
          </linearGradient>
          <linearGradient id={gloss} x1="14" y1="3" x2="14" y2="16" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={tip} x1="14" y1="7" x2="20" y2="14" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#e58262" />
            <stop offset="100%" stopColor="#c44d2d" />
          </linearGradient>
        </defs>
        <circle cx="14" cy="14" r="11.5" fill={`url(#${dial})`} />
        <circle cx="14" cy="14" r="11" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.8" />
        <ellipse cx="14" cy="9" rx="7.4" ry="4.5" fill={`url(#${gloss})`} />
        <g stroke="#ffffff" strokeOpacity="0.44" strokeWidth="1.15" strokeLinecap="round">
          <line x1="14" y1="4.7" x2="14" y2="6.1" />
          <line x1="14" y1="21.9" x2="14" y2="23.3" />
          <line x1="4.7" y1="14" x2="6.1" y2="14" />
          <line x1="21.9" y1="14" x2="23.3" y2="14" />
        </g>
        <g className={`ca-sm-compass-needle${hasItems ? ' is-alive' : ''}`}>
          <path d="M18.9 9.1 15.6 15.6 12.4 12.4 18.9 9.1Z" fill={`url(#${tip})`} />
          <path d="M9.1 18.9 12.4 12.4 15.6 15.6 9.1 18.9Z" fill="#f4f2ee" fillOpacity="0.94" />
          <circle cx="14" cy="14" r="1.45" fill="#ffffff" />
          <circle cx="14" cy="14" r="0.65" fill="#253e59" />
        </g>
      </svg>
    )
  }

  // 02. 已投递 — Sculpted Mineral Cerulean-Steel Origami Paper Plane
  if (id === 'applied') {
    const wingTop = `sm-wing-top-${uid}`
    const wingShade = `sm-wing-shade-${uid}`
    const wingInner = `sm-wing-inner-${uid}`
    return (
      <svg className="ca-sm-emblem ca-sm-emblem-applied" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={wingTop} x1="4" y1="6" x2="24" y2="16" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6598bf" />
            <stop offset="100%" stopColor="#356891" />
          </linearGradient>
          <linearGradient id={wingShade} x1="11" y1="13" x2="23" y2="23" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#467da6" />
            <stop offset="100%" stopColor="#245075" />
          </linearGradient>
          <linearGradient id={wingInner} x1="11" y1="15" x2="15" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1f4464" />
            <stop offset="100%" stopColor="#16324b" />
          </linearGradient>
        </defs>
        <ellipse className="ca-sm-plane-shadow" cx="13.5" cy="24.2" rx="6.8" ry="1.6" fill="#245075" fillOpacity="0.16" />
        <g className="ca-sm-plane-trails" stroke="#467da6" strokeWidth="1.35" strokeLinecap="round">
          <line x1="3.2" y1="21.4" x2="6.8" y2="18.2" strokeOpacity="0.52" />
          <line x1="6.4" y1="22.8" x2="9.1" y2="20.4" strokeOpacity="0.32" />
        </g>
        <g className={`ca-sm-plane-craft${hasItems && active ? ' is-flying' : ''}`}>
          <path d="M24.2 4.3 3.4 11.7 11.4 15.1 24.2 4.3Z" fill={`url(#${wingTop})`} />
          <path d="M24.2 4.3 11.4 15.1 12.7 21.4 15.6 17.5 24.2 4.3Z" fill={`url(#${wingInner})`} />
          <path d="M24.2 4.3 13.7 16.5 20.4 20.6 24.2 4.3Z" fill={`url(#${wingShade})`} />
          <path d="M23.5 4.8 11.7 14.9" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="0.85" strokeLinecap="round" />
        </g>
      </svg>
    )
  }

  // 03. 面试中 — Warm Terracotta & Parchment Layered Speech Capsules (zero AI purple!)
  if (id === 'interview') {
    const backBub = `sm-bub-back-${uid}`
    const frontBub = `sm-bub-front-${uid}`
    return (
      <svg className="ca-sm-emblem ca-sm-emblem-interview" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={backBub} x1="10" y1="3" x2="25" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ecc7ad" />
            <stop offset="100%" stopColor="#dba37d" />
          </linearGradient>
          <linearGradient id={frontBub} x1="3" y1="7" x2="21" y2="23" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#d46f43" />
            <stop offset="56%" stopColor="#b95228" />
            <stop offset="100%" stopColor="#8f3a19" />
          </linearGradient>
        </defs>
        <g className="ca-sm-bubble-back">
          <path
            d="M12.2 4.2h10a3.4 3.4 0 0 1 3.4 3.4v5.6a3.4 3.4 0 0 1-3.4 3.4h-.8v2.6l-3.1-2.6h-6.1a3.4 3.4 0 0 1-3.4-3.4V7.6a3.4 3.4 0 0 1 3.4-3.4Z"
            fill={`url(#${backBub})`}
          />
        </g>
        <g className="ca-sm-bubble-front">
          <path
            d="M5.6 8.6h11.6a3.4 3.4 0 0 1 3.4 3.4v6.2a3.4 3.4 0 0 1-3.4 3.4H10l-3.8 3.1v-3.1h-.6a3.4 3.4 0 0 1-3.4-3.4V12a3.4 3.4 0 0 1 3.4-3.4Z"
            fill={`url(#${frontBub})`}
          />
          <path
            d="M5.6 9h11.6a3 3 0 0 1 3 3v.5a3 3 0 0 0-3-3H5.6a3 3 0 0 0-3 3V12a3 3 0 0 1 3-3Z"
            fill="#ffffff"
            fillOpacity="0.22"
          />
          <rect className={`ca-sm-wave-bar is-b1${hasItems ? ' is-live' : ''}`} x="7.4" y="13.5" width="2" height="3.6" rx="1" fill="#fffaf3" />
          <rect className={`ca-sm-wave-bar is-b2${hasItems ? ' is-live' : ''}`} x="10.4" y="11.9" width="2" height="6.8" rx="1" fill="#fffaf3" />
          <rect className={`ca-sm-wave-bar is-b3${hasItems ? ' is-live' : ''}`} x="13.4" y="13.2" width="2" height="4.2" rx="1" fill="#fffaf3" />
        </g>
      </svg>
    )
  }

  // 04. Offer — Sculpted Botanical Jade Rosette Medal with Brushed Champagne-Brass Crest
  if (id === 'offer') {
    const sealGrad = `sm-seal-${uid}`
    const goldGrad = `sm-gold-${uid}`
    const ribbonGrad = `sm-ribbon-${uid}`
    return (
      <svg className="ca-sm-emblem ca-sm-emblem-offer" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={sealGrad} x1="6" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#2a8665" />
            <stop offset="100%" stopColor="#14563f" />
          </linearGradient>
          <linearGradient id={goldGrad} x1="10" y1="6" x2="18" y2="17" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#f3d996" />
            <stop offset="55%" stopColor="#d4a248" />
            <stop offset="100%" stopColor="#a37221" />
          </linearGradient>
          <linearGradient id={ribbonGrad} x1="14" y1="17" x2="14" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1e6f52" />
            <stop offset="100%" stopColor="#104532" />
          </linearGradient>
        </defs>
        <path className="ca-sm-medal-ribbon" d="M9.6 17.4 7.8 25.4 11.9 23.2 14 25.4 16.1 23.2 20.2 25.4 18.4 17.4H9.6Z" fill={`url(#${ribbonGrad})`} />
        <g className="ca-sm-seal-body">
          <path
            d="M14 2.8 16.6 4.4 19.6 4.4 21.1 7 23.6 8.6 23.6 11.6 25 14.2 23.6 16.8 21.1 18.4 19.6 21 16.6 21 14 22.4 11.4 21 8.4 21 6.9 18.4 4.4 16.8 3 14.2 4.4 11.6 4.4 8.6 6.9 7 8.4 4.4 11.4 4.4 14 2.8Z"
            fill={`url(#${sealGrad})`}
          />
          <circle cx="14" cy="12.6" r="7.4" fill="#0d3d2c" fillOpacity="0.28" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="0.7" />
          <path
            className="ca-sm-gold-crest"
            d="M14 7.4 15.5 11.1 19.2 12.6 15.5 14.1 14 17.8 12.5 14.1 8.8 12.6 12.5 11.1 14 7.4Z"
            fill={`url(#${goldGrad})`}
          />
        </g>
        {hasItems && (
          <path
            className="ca-sm-spark ca-sm-spark-a is-alive"
            d="M23.5 3.2v2.8M22.1 4.6h2.8"
            stroke="#cf9c44"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        )}
      </svg>
    )
  }

  // END. 已结束 — Sculpted Warm Brushed-Pewter Archival Folder
  const folderBack = `sm-fback-${uid}`
  const folderFront = `sm-ffront-${uid}`
  return (
    <svg className="ca-sm-emblem ca-sm-emblem-closed" width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={folderBack} x1="4" y1="5" x2="24" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#9d9991" />
          <stop offset="100%" stopColor="#6c6861" />
        </linearGradient>
        <linearGradient id={folderFront} x1="4" y1="11" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d2cec6" />
          <stop offset="100%" stopColor="#a39e95" />
        </linearGradient>
      </defs>
      <path
        d="M4.2 8.2a2.6 2.6 0 0 1 2.6-2.6h4.2c.8 0 1.5.4 2 1l1 1.2h7.2a2.6 2.6 0 0 1 2.6 2.6v9.8a2.8 2.8 0 0 1-2.8 2.8H7a2.8 2.8 0 0 1-2.8-2.8V8.2Z"
        fill={`url(#${folderBack})`}
      />
      <g className="ca-sm-archive-card">
        <rect x="7.4" y="8.6" width="13.2" height="10" rx="1.8" fill="#fdfcfa" />
        <rect x="7.4" y="8.6" width="13.2" height="10" rx="1.8" stroke="#6c6861" strokeOpacity="0.18" strokeWidth="0.6" />
        <line x1="10.2" y1="11.6" x2="17.8" y2="11.6" stroke="#9d9991" strokeWidth="1.2" strokeLinecap="round" />
      </g>
      <path
        d="M3.6 13.4a2.2 2.2 0 0 1 2.2-2.2h16.4a2.2 2.2 0 0 1 2.2 2.2v7.2a2.8 2.8 0 0 1-2.8 2.8H6.4a2.8 2.8 0 0 1-2.8-2.8v-7.2Z"
        fill={`url(#${folderFront})`}
      />
      {/* Top machined lip highlight */}
      <path d="M5.8 11.6h16.4" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="0.9" strokeLinecap="round" />
      {/* Minimal center pull notch */}
      <rect x="11.2" y="15.8" width="5.6" height="1.7" rx="0.85" fill="#475569" fillOpacity="0.42" />
    </svg>
  )
}

function FlowConnector({ traversed = false, lit = false }) {
  return (
    <div
      className={`ca-sm-connector${traversed ? ' is-traversed' : ''}${lit ? ' is-lit' : ''}`}
      aria-hidden="true"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <line className="ca-sm-conn-base" x1="1" y1="10" x2="15" y2="10" strokeWidth="1.4" strokeLinecap="round" />
        {(traversed || lit) && (
          <line className="ca-sm-conn-pulse" x1="1" y1="10" x2="15" y2="10" strokeWidth="1.8" strokeLinecap="round" />
        )}
        <path className="ca-sm-conn-head" d="M12 6.8 15.6 10 12 13.2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export function StageSteps({ stage, label }) {
  const { t } = useI18n()
  const resolvedLabel = label || t('bucket.saved')
  const activeIdx = bucketIndexOf(stage)
  const closed = CLOSED_STAGES.has(stage)
  const tone = bucketToneOf(stage)
  return (
    <div
      className={`ca-stage-steps is-tone-${tone}${closed ? ' is-closed' : ''}`}
      aria-label={t('bucket.currentStageAria', { label: resolvedLabel })}
    >
      {ACTIVE_PIPELINE_BUCKETS.map((bucket, idx) => (
        <span
          key={bucket.id}
          className={`ca-stage-pip${idx <= activeIdx && !closed ? ' is-done' : ''}${idx === activeIdx && !closed ? ' is-current' : ''}`}
          title={t(bucket.labelKey)}
        />
      ))}
    </div>
  )
}

export default function LifecycleStateMachine({ counts, activeStage, onSelect }) {
  const { t } = useI18n()
  const [hoveredId, setHoveredId] = React.useState('')

  let maxPopulatedIdx = -1
  for (let i = 0; i < ACTIVE_PIPELINE_BUCKETS.length; i += 1) {
    if ((counts[ACTIVE_PIPELINE_BUCKETS[i].id] ?? 0) > 0) maxPopulatedIdx = i
  }

  const focusId = hoveredId || (activeStage !== 'all' ? activeStage : '')
  const focusActiveIdx = ACTIVE_PIPELINE_BUCKETS.findIndex(b => b.id === focusId)
  const closedBucket = PIPELINE_BUCKETS[PIPELINE_BUCKETS.length - 1]

  const renderNode = (bucket, isClosed = false) => {
    const count = counts[bucket.id] ?? 0
    const active = activeStage === bucket.id
    const hasItems = count > 0
    return (
      <button
        key={bucket.id}
        type="button"
        className={`ca-sm-node is-tone-${bucket.tone}${active ? ' is-active' : ''}${hasItems ? ' has-items' : ' is-zero'}${isClosed ? ' is-closed-node' : ''}`}
        data-stage-bucket={bucket.id}
        aria-pressed={active}
        onMouseEnter={() => setHoveredId(bucket.id)}
        onMouseLeave={() => setHoveredId(cur => (cur === bucket.id ? '' : cur))}
        onFocus={() => setHoveredId(bucket.id)}
        onBlur={() => setHoveredId(cur => (cur === bucket.id ? '' : cur))}
        onClick={() => onSelect(active ? 'all' : bucket.id)}
      >
        <span className="ca-sm-emblem-wrap">
          <StageLogo id={bucket.id} size={32} active={active} hasItems={hasItems} />
        </span>
        <span className="ca-sm-stack">
          <span className="ca-sm-label">{t(bucket.labelKey)}</span>
          <AnimatedNumber value={count} className="ca-sm-count" />
        </span>
        <span className="ca-sm-bar" aria-hidden="true" />
      </button>
    )
  }

  return (
    <div className="ca-sm-dock" role="group" aria-label={t('bucket.ariaLabel')}>
      <div className="ca-sm-flow">
        {ACTIVE_PIPELINE_BUCKETS.map((bucket, idx) => (
          <React.Fragment key={bucket.id}>
            {renderNode(bucket, false)}
            {idx < ACTIVE_PIPELINE_BUCKETS.length - 1 && (
              <FlowConnector
                traversed={maxPopulatedIdx > idx}
                lit={focusActiveIdx > idx}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="ca-sm-fork" aria-hidden="true">
        <span className="ca-sm-fork-line" />
      </div>

      <div className="ca-sm-archive">
        {renderNode(closedBucket, true)}
      </div>
    </div>
  )
}
