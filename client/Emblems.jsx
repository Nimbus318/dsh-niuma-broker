import React from 'react'
import brandGraphiteFineSvg from './assets/A-graphite-paper-v3-fine.svg'

/**
 * Unified Sculpted Multi-Layer Emblem Library — v0.17.0 Architectural Mineral Palette
 * Zero generic AI blue-purple gradients: machined obsidian-graphite, brushed champagne brass,
 * warm terracotta, maritime slate-steel, deep spruce-teal, and botanical jade.
 * Every emblem uses unique React.useId() gradient IDs so multiple instances never collide.
 */

/** Official DeepSeek Harness Whale Mark (exact host sidebar.brand.mark SVG, scales crisply down to 11px-16px) */
export function DeepSeekMark({ size = 13, className = '' }) {
  const height = size
  const width = Math.round(size * (23.16 / 17.04) * 100) / 100
  return (
    <svg
      className={`ca-ds-mark${className ? ` ${className}` : ''}`}
      width={width}
      height={height}
      viewBox="0 0 23.16 17.04"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"
      />
    </svg>
  )
}

/** Finalized Niuma Broker Brand Mark — A「石墨浮雕 · 细金线」SVG (109.5:99 aspect ratio) */
export function BrokerBrandEmblem({ size = 22 }) {
  const height = size
  const width = Math.round(size * (109.5 / 99) * 100) / 100
  return (
    <img
      className="ca-brand-mark"
      src={brandGraphiteFineSvg}
      width={width}
      height={height}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  )
}

/** Sculpted Warm Terracotta & Linen Archival Notebook with Brass Bookmark (工作成果提炼 / 履历库) */
export function DistillEmblem({ size = 28, active = true, scanning = false }) {
  const uid = React.useId().replace(/:/g, '')
  const back = `eb-ds-back-${uid}`
  const front = `eb-ds-front-${uid}`
  const ribbon = `eb-ds-ribbon-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-distill${active ? ' is-on' : ' is-off'}${scanning ? ' is-scanning' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={back} x1="4" y1="4" x2="20" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#efe5d5" />
          <stop offset="100%" stopColor="#dcccb4" />
        </linearGradient>
        <linearGradient id={front} x1="6" y1="5" x2="22" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#cc663e" />
          <stop offset="56%" stopColor="#b24d29" />
          <stop offset="100%" stopColor="#89371b" />
        </linearGradient>
        <linearGradient id={ribbon} x1="17" y1="3" x2="22" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f2d894" />
          <stop offset="55%" stopColor="#d19e43" />
          <stop offset="100%" stopColor="#9f6e1f" />
        </linearGradient>
      </defs>
      {/* Back archival parchment sheet */}
      <rect x="4.2" y="5.6" width="15.4" height="18.2" rx="3.4" transform="rotate(-6 4.2 5.6)" fill={`url(#${back})`} stroke="#cbb99e" strokeWidth="0.55" />
      {/* Front sculpted terracotta notebook folio */}
      <rect x="6.4" y="5.4" width="16" height="19" rx="3.6" fill={`url(#${front})`} />
      <rect x="6.8" y="5.8" width="15.2" height="18.2" rx="3.2" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.7" />
      {/* Fine book-spine crease */}
      <line x1="9.2" y1="6.4" x2="9.2" y2="23.4" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="0.9" />
      {/* Crisp distilled achievement lines */}
      <rect x="11.2" y="11.2" width="7.2" height="1.75" rx="0.88" fill="#fffaf3" fillOpacity="0.92" />
      <rect x="11.2" y="14.8" width="8.2" height="1.7" rx="0.85" fill="#fffaf3" fillOpacity="0.68" />
      <rect x="11.2" y="18.4" width="5.4" height="1.7" rx="0.85" fill="#fffaf3" fillOpacity="0.46" />
      {/* Tailored brushed-brass ribbon bookmark (replaces generic AI sparkle) */}
      <path
        className="ca-emblem-spark-star"
        d="M17.2 4.6h3.6v6.4l-1.8-1.35-1.8 1.35V4.6Z"
        fill={`url(#${ribbon})`}
      />
    </svg>
  )
}

/** Sculpted Deep Maritime Prussian-Steel Radar Instrument Orb (官网定时巡检 / 盯盘卡) */
export function PatrolEmblem({ size = 28, active = true, scanning = false }) {
  const uid = React.useId().replace(/:/g, '')
  const orb = `eb-pt-orb-${uid}`
  const gloss = `eb-pt-gloss-${uid}`
  const beam = `eb-pt-beam-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-patrol${active ? ' is-on' : ' is-off'}${scanning ? ' is-scanning' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={orb} x1="4" y1="3" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3c678a" />
          <stop offset="55%" stopColor="#274764" />
          <stop offset="100%" stopColor="#162a3d" />
        </linearGradient>
        <linearGradient id={gloss} x1="14" y1="3" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={beam} x1="14" y1="14" x2="21" y2="7" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="100%" stopColor="#3eb489" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="11.4" fill={`url(#${orb})`} />
      <circle cx="14" cy="14" r="10.95" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.8" />
      <ellipse cx="14" cy="8.6" rx="7.2" ry="4.2" fill={`url(#${gloss})`} />
      <circle cx="14" cy="14" r="7.4" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.85" />
      <circle cx="14" cy="14" r="3.8" stroke="#ffffff" strokeOpacity="0.26" strokeWidth="0.85" />
      <g className="ca-emblem-patrol-sweep">
        <path d="M14 14 L14 4.2 A9.8 9.8 0 0 1 21.8 8.2 Z" fill={`url(#${beam})`} />
        <line x1="14" y1="14" x2="20.4" y2="7.6" stroke="#f8fafc" strokeWidth="1.55" strokeLinecap="round" />
      </g>
      <circle cx="14" cy="14" r="1.55" fill="#ffffff" />
      <circle className="ca-emblem-patrol-blip" cx="20.2" cy="7.8" r="2.1" fill="#2fa37c" stroke="#ffffff" strokeWidth="0.9" />
    </svg>
  )
}

/** Sculpted Spruce-Jade Optical Loupe over Archival JD Folio (展开岗位自动解读) */
export function IntelEmblem({ size = 28, active = true, scanning = false }) {
  const uid = React.useId().replace(/:/g, '')
  const paper = `eb-in-paper-${uid}`
  const rim = `eb-in-rim-${uid}`
  const glass = `eb-in-glass-${uid}`
  const brass = `eb-in-brass-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-intel${active ? ' is-on' : ' is-off'}${scanning ? ' is-scanning' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={paper} x1="4" y1="3" x2="20" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f7f3eb" />
          <stop offset="100%" stopColor="#e2d8c7" />
        </linearGradient>
        <linearGradient id={rim} x1="12" y1="10" x2="25" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#358669" />
          <stop offset="56%" stopColor="#205f49" />
          <stop offset="100%" stopColor="#123a2c" />
        </linearGradient>
        <linearGradient id={glass} x1="13" y1="11" x2="22" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e8f7f1" />
          <stop offset="100%" stopColor="#a7d8c5" />
        </linearGradient>
        <linearGradient id={brass} x1="6" y1="8" x2="15" y2="10" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f0d58e" />
          <stop offset="55%" stopColor="#cf9b3e" />
          <stop offset="100%" stopColor="#9d6d1f" />
        </linearGradient>
      </defs>
      {/* Back archival JD sheet */}
      <rect x="3.8" y="3.8" width="15.8" height="19.6" rx="3.4" fill={`url(#${paper})`} stroke="#cbbda7" strokeWidth="0.6" />
      <rect x="4.3" y="4.3" width="14.8" height="18.6" rx="2.9" stroke="#ffffff" strokeOpacity="0.65" strokeWidth="0.6" />
      {/* Highlighted key match bar in brushed champagne brass */}
      <rect x="6.6" y="7.6" width="8.6" height="2" rx="1" fill={`url(#${brass})`} />
      {/* Secondary JD detail lines */}
      <rect x="6.6" y="11.4" width="9.8" height="1.65" rx="0.82" fill="#8b8173" fillOpacity="0.52" />
      <rect x="6.6" y="14.6" width="6.8" height="1.65" rx="0.82" fill="#8b8173" fillOpacity="0.38" />
      <rect x="6.6" y="17.8" width="5.2" height="1.65" rx="0.82" fill="#8b8173" fillOpacity="0.28" />
      {/* Sculpted deep spruce-jade inspection loupe */}
      <path d="M21.4 20.6 L24.6 23.8" stroke={`url(#${rim})`} strokeWidth="3.1" strokeLinecap="round" />
      <path d="M21.8 21.0 L24.2 23.4" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="0.8" strokeLinecap="round" />
      <circle cx="17.5" cy="16.4" r="6.3" fill={`url(#${rim})`} />
      <circle cx="17.5" cy="16.4" r="5.85" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="0.7" />
      <circle cx="17.5" cy="16.4" r="4.25" fill={`url(#${glass})`} />
      {/* Specular optical arc & crisp match check inside lens */}
      <path d="M14.7 14.3a3.3 3.3 0 0 1 3.7-1" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.05" strokeLinecap="round" />
      <path d="M15.4 16.6 L16.8 18.0 L19.8 14.9" stroke="#184d3a" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Sculpted Stacked Warm-Paper Job Folios + Brushed Graphite Magnifier (Empty Jobs State) */
export function EmptySearchEmblem({ size = 54, emptyCatalog = false }) {
  const uid = React.useId().replace(/:/g, '')
  const cardBack = `eb-es-cback-${uid}`
  const cardFront = `eb-es-cfront-${uid}`
  const lensRim = `eb-es-rim-${uid}`
  const lensGlass = `eb-es-glass-${uid}`
  return (
    <svg className="ca-emblem ca-emblem-empty" width={size} height={size} viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={cardBack} x1="8" y1="8" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e8e4dc" />
          <stop offset="100%" stopColor="#d6d0c4" />
        </linearGradient>
        <linearGradient id={cardFront} x1="10" y1="11" x2="40" y2="41" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#f5f3ef" />
        </linearGradient>
        <linearGradient id={lensRim} x1="27" y1="22" x2="49" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3c4553" />
          <stop offset="100%" stopColor="#191e26" />
        </linearGradient>
        <linearGradient id={lensGlass} x1="29" y1="24" x2="44" y2="41" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f8f7f4" />
          <stop offset="100%" stopColor="#ebe7df" />
        </linearGradient>
      </defs>
      <rect x="8" y="10" width="32" height="26" rx="6" transform="rotate(-5 8 10)" fill={`url(#${cardBack})`} />
      <rect x="10" y="12" width="33" height="27" rx="6.5" fill={`url(#${cardFront})`} stroke="#d4cec4" strokeWidth="0.9" />
      <rect x="16" y="19" width="13" height="2.6" rx="1.3" fill="#8b857b" fillOpacity="0.65" />
      <rect x="16" y="25" width="20" height="2.4" rx="1.2" fill="#cfc9be" />
      <rect x="16" y="30.5" width="11" height="2.4" rx="1.2" fill="#cfc9be" fillOpacity="0.7" />
      <g className="ca-emblem-empty-lens">
        <path d="m43.5 40.5 5.4 5.4" stroke={`url(#${lensRim})`} strokeWidth="4.2" strokeLinecap="round" />
        <circle cx="37.2" cy="34.2" r="10.2" fill={`url(#${lensGlass})`} stroke={`url(#${lensRim})`} strokeWidth="2.4" />
        <path d="M32.5 30.2a6.4 6.4 0 0 1 6.2-2.1" stroke="#ffffff" strokeOpacity="0.88" strokeWidth="1.6" strokeLinecap="round" />
        {emptyCatalog ? (
          <path d="M37.2 30.6v7.2M33.6 34.2h7.2" stroke="#2c3440" strokeWidth="2" strokeLinecap="round" />
        ) : (
          <path d="M34 34.2h6.4" stroke="#2c3440" strokeWidth="2" strokeLinecap="round" />
        )}
      </g>
    </svg>
  )
}

/** Sculpted Machined Graphite-Obsidian Master Folio with Brushed-Brass Default Seal (主干母版) */
export function MasterResumeEmblem({ size = 28, isDefault = false }) {
  const uid = React.useId().replace(/:/g, '')
  const back = `eb-mr-back-${uid}`
  const front = `eb-mr-front-${uid}`
  const brass = `eb-mr-brass-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-master${isDefault ? ' is-default' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={back} x1="3" y1="4" x2="19" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e2ddd3" />
          <stop offset="100%" stopColor="#c8c0b1" />
        </linearGradient>
        <linearGradient id={front} x1="6" y1="4" x2="23" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#353d49" />
          <stop offset="56%" stopColor="#21262f" />
          <stop offset="100%" stopColor="#12151b" />
        </linearGradient>
        <linearGradient id={brass} x1="18" y1="2" x2="26" y2="11" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f3d996" />
          <stop offset="55%" stopColor="#cf9c44" />
          <stop offset="100%" stopColor="#9c6c1e" />
        </linearGradient>
      </defs>
      {/* Back warm archival linen sheet */}
      <rect x="4" y="5.6" width="15.2" height="18.4" rx="3.4" transform="rotate(-6 4 5.6)" fill={`url(#${back})`} />
      {/* Sculpted obsidian-graphite master folio */}
      <rect x="6.4" y="4.8" width="16.2" height="19.6" rx="3.8" fill={`url(#${front})`} />
      <rect x="6.8" y="5.2" width="15.4" height="18.8" rx="3.4" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.75" />
      {/* Crisp ivory typography lines */}
      <rect x="9.6" y="9.4" width="6.2" height="2" rx="1" fill="#f8f6f2" fillOpacity="0.94" />
      <rect x="9.6" y="13.4" width="9.8" height="1.65" rx="0.82" fill="#f8f6f2" fillOpacity="0.7" />
      <rect x="9.6" y="16.8" width="8.2" height="1.65" rx="0.82" fill="#f8f6f2" fillOpacity="0.52" />
      <rect x="9.6" y="20.2" width="5.4" height="1.65" rx="0.82" fill="#f8f6f2" fillOpacity="0.34" />
      {/* Matte brushed-brass default crest vs crisp corner bevel */}
      {isDefault ? (
        <g>
          <circle cx="22.1" cy="6.6" r="4.4" fill={`url(#${brass})`} stroke="#ffffff" strokeWidth="1.25" />
          <path d="M22.1 4.1 22.8 5.7 24.5 5.9 23.2 7 23.6 8.7 22.1 7.8 20.6 8.7 21 7 19.7 5.9 21.4 5.7 22.1 4.1Z" fill="#ffffff" />
        </g>
      ) : (
        <path d="M18.6 5.2h2.4a1.2 1.2 0 0 1 1.2 1.2v2.4" stroke="#d6d3cd" strokeOpacity="0.45" strokeWidth="1.1" strokeLinecap="round" />
      )}
    </svg>
  )
}

/** Sculpted Deep Spruce-Teal Tailored Job Branch Folio with Warm Terracotta Fork Node (岗位定向版) */
export function BranchResumeEmblem({ size = 28 }) {
  const uid = React.useId().replace(/:/g, '')
  const back = `eb-br-fback-${uid}`
  const front = `eb-br-ffront-${uid}`
  const fork = `eb-br-ffork-${uid}`
  return (
    <svg
      className="ca-emblem ca-emblem-branch"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={back} x1="3" y1="4" x2="18" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d2e4e0" />
          <stop offset="100%" stopColor="#b0cfc8" />
        </linearGradient>
        <linearGradient id={front} x1="5" y1="4" x2="21" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2b756d" />
          <stop offset="56%" stopColor="#1e5a54" />
          <stop offset="100%" stopColor="#133d39" />
        </linearGradient>
        <linearGradient id={fork} x1="15" y1="15" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d97246" />
          <stop offset="55%" stopColor="#c2562c" />
          <stop offset="100%" stopColor="#993d1c" />
        </linearGradient>
      </defs>
      {/* Subtle angled source folio silhouette */}
      <rect x="3.8" y="5.4" width="14.6" height="17.8" rx="3.2" transform="rotate(-6 3.8 5.4)" fill={`url(#${back})`} />
      {/* Sculpted deep spruce-teal tailored folio */}
      <rect x="6" y="4.6" width="15.8" height="19.2" rx="3.7" fill={`url(#${front})`} />
      <rect x="6.4" y="5" width="15" height="18.4" rx="3.3" stroke="#ffffff" strokeOpacity="0.2" strokeWidth="0.75" />
      {/* Clean ivory typography bars */}
      <rect x="9.1" y="9" width="7.2" height="1.9" rx="0.95" fill="#f7faf9" fillOpacity="0.92" />
      <rect x="9.1" y="12.8" width="9.4" height="1.65" rx="0.82" fill="#f7faf9" fillOpacity="0.7" />
      <rect x="9.1" y="16.2" width="6.2" height="1.65" rx="0.82" fill="#f7faf9" fillOpacity="0.5" />
      {/* Warm terracotta precision branch-fork medallion (unobstructed!) */}
      <circle cx="20.4" cy="20.4" r="5.3" fill={`url(#${fork})`} stroke="#ffffff" strokeWidth="1.4" />
      <path d="M18.6 17.8v5.2M22.2 18.6c0 1.6-1.4 2.1-3.6 2.1" stroke="#ffffff" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.6" cy="17.8" r="1.05" fill="#ffffff" />
      <circle cx="22.2" cy="18.6" r="1.05" fill="#ffffff" />
      <circle cx="18.6" cy="23" r="1.05" fill="#ffffff" />
    </svg>
  )
}

/** Sculpted Multi-Layered Physical Emblem: Archival Resume Folio Rising from Brushed Slate Import Tray (导入已有简历) */
export function ImportResumeEmblem({ size = 44, active = false }) {
  const uid = React.useId().replace(/:/g, '')
  const trayBack = `eb-imp-tb-${uid}`
  const sheet = `eb-imp-sh-${uid}`
  const trayFront = `eb-imp-tf-${uid}`
  const brass = `eb-imp-br-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-import${active ? ' is-active' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={trayBack} x1="6" y1="14" x2="34" y2="39" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3d4654" />
          <stop offset="100%" stopColor="#1b2029" />
        </linearGradient>
        <linearGradient id={sheet} x1="12" y1="5" x2="31" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fffdf9" />
          <stop offset="100%" stopColor="#ebe5da" />
        </linearGradient>
        <linearGradient id={trayFront} x1="7" y1="22" x2="35" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2e3643" />
          <stop offset="55%" stopColor="#202631" />
          <stop offset="100%" stopColor="#12161d" />
        </linearGradient>
        <linearGradient id={brass} x1="27" y1="23" x2="40" y2="37" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f4da97" />
          <stop offset="55%" stopColor="#cf9c44" />
          <stop offset="100%" stopColor="#9c6b1c" />
        </linearGradient>
      </defs>
      {/* Layer 1: Machined graphite back tray */}
      <rect x="6" y="15" width="28" height="23" rx="6.5" fill={`url(#${trayBack})`} />
      <rect x="6.5" y="15.5" width="27" height="22" rx="6" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="0.8" />
      {/* Layer 2: Rising archival ivory resume sheet (animated) */}
      <g className="ca-emblem-imp-sheet">
        <path
          d="M11.5 9.5A3 3 0 0 1 14.5 6.5h11.2L30.5 11.3v18.2a2.5 2.5 0 0 1-2.5 2.5H14a2.5 2.5 0 0 1-2.5-2.5V9.5Z"
          fill={`url(#${sheet})`}
          stroke="#cfc7b9"
          strokeWidth="0.9"
        />
        <path d="M25.7 6.5v3.6a1.2 1.2 0 0 0 1.2 1.2h3.6" stroke="#c89e4e" strokeWidth="1" strokeLinejoin="round" />
        <rect x="14.8" y="11.8" width="7.4" height="2.1" rx="1.05" fill="#232934" fillOpacity="0.86" />
        <rect x="14.8" y="16" width="11.6" height="1.6" rx="0.8" fill="#545e6d" fillOpacity="0.58" />
        <rect x="14.8" y="19.4" width="9.2" height="1.6" rx="0.8" fill="#545e6d" fillOpacity="0.42" />
      </g>
      {/* Layer 3: Sculpted front pocket bevel */}
      <path
        d="M6 25.2c0-1.2.98-2.2 2.2-2.2h6.3c.9 0 1.7.52 2.1 1.32l.68 1.36c.4.8 1.2 1.32 2.1 1.32h3.24c.9 0 1.7-.52 2.1-1.32l.68-1.36c.4-.8 1.2-1.32 2.1-1.32h4.3c1.22 0 2.2 1 2.2 2.2v6.6A6.2 6.2 0 0 1 27.8 38H12.2A6.2 6.2 0 0 1 6 31.8v-6.6Z"
        fill={`url(#${trayFront})`}
      />
      <path
        d="M7 24.4h7.2c.6 0 1.15.34 1.42.88l.68 1.36c.45.9 1.37 1.46 2.38 1.46h3.64c1.01 0 1.93-.56 2.38-1.46l.68-1.36c.27-.54.82-.88 1.42-.88H33"
        stroke="#ffffff"
        strokeOpacity="0.18"
        strokeWidth="0.85"
        strokeLinecap="round"
      />
      {/* Layer 4: Floating brushed-brass upload medallion (animated) */}
      <g className="ca-emblem-imp-badge">
        <circle cx="33.5" cy="30.5" r="7.2" fill={`url(#${brass})`} stroke="#ffffff" strokeWidth="1.6" />
        <path d="M33.5 33.8v-6.4M30.8 29.9l2.7-2.7 2.7 2.7" stroke="#ffffff" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

/** Sculpted Multi-Layered Physical Emblem: Deep Spruce Dialogue Card + Emerging Parchment Draft + Brass Spark (聊几句生成初稿) */
export function ChatDraftEmblem({ size = 44, active = false }) {
  const uid = React.useId().replace(/:/g, '')
  const paper = `eb-ch-pa-${uid}`
  const bubble = `eb-ch-bu-${uid}`
  const brass = `eb-ch-br-${uid}`
  return (
    <svg
      className={`ca-emblem ca-emblem-chatdraft${active ? ' is-active' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={paper} x1="16" y1="6" x2="36" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fdfbf7" />
          <stop offset="100%" stopColor="#e5dfd3" />
        </linearGradient>
        <linearGradient id={bubble} x1="5" y1="12" x2="31" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2e7b73" />
          <stop offset="56%" stopColor="#1f5e58" />
          <stop offset="100%" stopColor="#123c38" />
        </linearGradient>
        <linearGradient id={brass} x1="27" y1="5" x2="40" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f5dc99" />
          <stop offset="55%" stopColor="#d19d44" />
          <stop offset="100%" stopColor="#9c6a1c" />
        </linearGradient>
      </defs>
      {/* Layer 1: Emerging warm archival draft sheet behind bubble (animated) */}
      <g className="ca-emblem-cd-paper">
        <rect x="17" y="8" width="20" height="25" rx="4.5" transform="rotate(6 17 8)" fill={`url(#${paper})`} stroke="#cfc7b9" strokeWidth="0.9" />
        <rect x="20.4" y="13.8" width="8.5" height="2" rx="1" transform="rotate(6 20.4 13.8)" fill="#2b3340" fillOpacity="0.72" />
        <rect x="20" y="18" width="11.2" height="1.5" rx="0.75" transform="rotate(6 20 18)" fill="#5d6675" fillOpacity="0.48" />
        <rect x="19.6" y="21.6" width="8.8" height="1.5" rx="0.75" transform="rotate(6 19.6 21.6)" fill="#5d6675" fillOpacity="0.34" />
      </g>
      {/* Layer 2: Sculpted spruce-teal dialogue bubble */}
      <path
        d="M6 19.5A6.5 6.5 0 0 1 12.5 13h13A6.5 6.5 0 0 1 32 19.5v6.8a6.5 6.5 0 0 1-6.5 6.5H15.2l-5.7 4.4c-.75.58-1.83.04-1.83-.9v-3.5A6.5 6.5 0 0 1 6 26.3v-6.8Z"
        fill={`url(#${bubble})`}
      />
      <path
        d="M12.5 13.5h13a6 6 0 0 1 6 6v6.8a6 6 0 0 1-6 6H15l-5.2 4a.65.65 0 0 1-1.05-.52v-3.48H12.5a6 6 0 0 1-6-6v-6.8a6 6 0 0 1 6-6Z"
        stroke="#ffffff"
        strokeOpacity="0.2"
        strokeWidth="0.85"
      />
      {/* Animated rhythmic dialogue dots */}
      <circle className="ca-emblem-cd-dot is-1" cx="14.2" cy="22.8" r="1.85" fill="#f7faf9" fillOpacity="0.92" />
      <circle className="ca-emblem-cd-dot is-2" cx="19.1" cy="22.8" r="1.85" fill="#f7faf9" fillOpacity="0.92" />
      <circle className="ca-emblem-cd-dot is-3" cx="24" cy="22.8" r="1.85" fill="#f7faf9" fillOpacity="0.92" />
      {/* Layer 3: Floating brushed-brass spark crest (animated) */}
      <g className="ca-emblem-cd-spark">
        <circle cx="33.5" cy="11.5" r="6.4" fill={`url(#${brass})`} stroke="#ffffff" strokeWidth="1.5" />
        <path
          d="M33.5 7.9 34.4 10.6 37.1 11.5 34.4 12.4 33.5 15.1 32.6 12.4 29.9 11.5 32.6 10.6 33.5 7.9Z"
          fill="#ffffff"
        />
      </g>
    </svg>
  )
}
