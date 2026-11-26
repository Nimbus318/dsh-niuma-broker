import React from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiTraceCard, useTrackedOperation } from './AiActivity.jsx'
import CompanyAvatar from './CompanyAvatar.jsx'
import { DeepSeekMark, EmptySearchEmblem } from './Emblems.jsx'
import { AnimatedNumber } from './Motion.jsx'
import { readableDate } from './shared.js'
import { useI18n } from './i18n.jsx'
import { readProfileSession, subscribeProfileChange, writeProfileSession } from './profile-storage.js'

const list = value => (Array.isArray(value) ? value : [])

const GEO_PALETTE = ['#17191c', '#315bd6', '#4b6584', '#7c8aa5', '#a3aebf', '#c5cdd9']

function HelpTip({ title, text, align = 'left' }) {
  return (
    <span className="ca-tip-anchor">
      <button type="button" className="ca-inline-help" aria-label={title || text}>?</button>
      <span className={`ca-tip-pop ${align === 'right' ? 'is-right' : 'is-left'}`} role="tooltip">
        {title && <strong>{title}</strong>}
        {text && <span>{text}</span>}
      </span>
    </span>
  )
}

function heatTone(heat) {
  if (heat === 'surging') return 'warning'
  if (heat === 'baseline') return 'neutral'
  return 'info'
}

function heatLabel(heat, t) {
  if (heat === 'surging') return t('insights.heatSurging')
  if (heat === 'baseline') return t('insights.heatBaseline')
  return t('insights.heatHot')
}

function horizonLabel(horizon, t) {
  if (horizon === 'this_week') return t('insights.horizonWeek')
  if (horizon === 'quarter') return t('insights.horizonQuarter')
  return t('insights.horizonMonth')
}

function shortSkillTag(label, { maxZh = 8, maxLatin = 13 } = {}) {
  const clean = String(label || '').trim()
  const beforeParen = clean.replace(/\s*\([^)]*\)\s*/gu, '').trim()
  const firstPart = beforeParen.split(/\s*\/\s*/u)[0].trim()
  if (/[\u4e00-\u9fff]/u.test(firstPart)) {
    if (beforeParen.startsWith('分布式系统')) return '分布式系统'
    if (beforeParen.startsWith('多租户')) return '多租户/FinOps'
    if (beforeParen.startsWith('推理加速')) return 'KV-Cache/推理'
    if (beforeParen.startsWith('分布式训练')) return '分布式训练'
    if (beforeParen.startsWith('模型量化')) return 'FP8/量化'
    if (beforeParen.startsWith('后训练')) return '后训练/RLHF'
    if (beforeParen.startsWith('可观测性')) return '可观测性'
    if (firstPart.length <= maxZh) return firstPart
    return `${firstPart.slice(0, Math.max(4, maxZh - 1))}…`
  }
  return firstPart.length <= maxLatin ? firstPart : `${firstPart.slice(0, Math.max(6, maxLatin - 1))}…`
}

function buildStudyPrompt({ topic, why, howInCurrentJob, goal, locale }) {
  if (locale === 'en') {
    return [
      `I want to build practical depth in "${topic}" while working in my current role.`,
      goal ? `My target direction: ${goal}.` : '',
      why ? `Why the market values it: ${why}` : '',
      howInCurrentJob ? `Suggested angle at work: ${howInCurrentJob}` : '',
      'Please break down the core architecture/concepts, design a realistic small project or production improvement I can practice in 1-2 weeks, and list key trade-offs interviewers probe.',
    ].filter(Boolean).join('\n')
  }
  return [
    `我想结合当前在职工作，系统补齐「${topic}」方向的实战深度。`,
    goal ? `我的关注方向：${goal}。` : '',
    why ? `市场看重它的原因：${why}` : '',
    howInCurrentJob ? `切入思路：${howInCurrentJob}` : '',
    '请帮我拆解核心原理与生产落地关键点，设计一个可以在 1–2 周内结合日常工作或小型实验练手的路径，并列出资深岗位最常追问的架构取舍。',
  ].filter(Boolean).join('\n')
}

function buildResumeWeavePrompt({ title, detail, locale }) {
  if (locale === 'en') {
    return `Please weave my recent work experience related to "${title}" into my default master resume cleanly and concisely without fabricating details.${detail ? ` Context: ${detail}` : ''}`
  }
  return `请结合我日常工作素材中与「${title}」相关的真实落地经历，帮我提炼补进默认主干简历，严格基于已有事实不编造。${detail ? `参考要点：${detail}` : ''}`
}

/* ==========================================================================
   Chart 1: 5-Axis Capability Radar (Market Pull vs Resume vs Daily Work)
   ========================================================================== */
function CapabilityRadarChart({ axes = [], hasResume, t }) {
  const [hoveredId, setHoveredId] = React.useState('')
  const count = axes.length
  if (count < 3) return null

  const cx = 165
  const cy = 126
  const maxR = 82
  const rings = [25, 50, 75, 100]
  const maxVal = Math.max(60, ...axes.map(a => Number(a.marketPct || 0)))
  const scaleMax = Math.min(100, Math.ceil(maxVal / 20) * 20)

  const pointAt = (index, valuePct) => {
    const angle = (-Math.PI / 2) + (index * 2 * Math.PI) / count
    const ratio = Math.max(0, Math.min(1, valuePct / Math.max(1, scaleMax)))
    const r = ratio * maxR
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      angle,
    }
  }

  const polyString = getter => axes.map((a, i) => {
    const p = pointAt(i, getter(a))
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  }).join(' ')

  const hasWorkDelta = axes.some(a => (a.withWorkAxisVal || 0) > (a.resumeAxisVal || 0))
  const activeAxis = axes.find(a => a.id === hoveredId) ?? null

  return (
    <div className="ca-ins-radar-wrap">
      <svg
        className="ca-ins-radar-svg"
        viewBox="0 0 330 254"
        role="img"
        aria-label={t('insights.radarAria')}
      >
        {/* Concentric pentagon grid rings */}
        {rings.map(pct => {
          const pts = axes.map((_, i) => {
            const p = pointAt(i, (pct / 100) * scaleMax)
            return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
          }).join(' ')
          return (
            <polygon
              key={pct}
              points={pts}
              fill="none"
              stroke="currentColor"
              strokeOpacity={pct === 100 ? 0.14 : 0.08}
              strokeWidth={pct === 100 ? 1 : 0.75}
              strokeDasharray={pct === 100 ? undefined : '2.5 2.5'}
            />
          )
        })}

        {/* Radial spokes */}
        {axes.map((axis, i) => {
          const outer = pointAt(i, scaleMax)
          const isHot = hoveredId === axis.id
          return (
            <line
              key={axis.id}
              x1={cx}
              y1={cy}
              x2={outer.x}
              y2={outer.y}
              stroke="currentColor"
              strokeOpacity={isHot ? 0.35 : 0.1}
              strokeWidth={isHot ? 1.2 : 0.75}
            />
          )
        })}

        {/* Layer 1: Market Pull polygon */}
        <polygon
          points={polyString(a => a.marketPct || 0)}
          className="ca-ins-radar-market"
        />

        {/* Layer 2: Resume + Daily Work extension polygon (if daily work covers extra skills) */}
        {hasWorkDelta && (
          <polygon
            points={polyString(a => a.withWorkAxisVal || 0)}
            className="ca-ins-radar-work"
          />
        )}

        {/* Layer 3: Master Resume Coverage polygon */}
        {hasResume && (
          <polygon
            points={polyString(a => a.resumeAxisVal || 0)}
            className="ca-ins-radar-resume"
          />
        )}

        {/* Vertices & generous sector hit targets (zero hover jitter) */}
        {axes.map((axis, i) => {
          const mp = pointAt(i, axis.marketPct || 0)
          const rp = pointAt(i, axis.resumeAxisVal || 0)
          const wp = pointAt(i, axis.withWorkAxisVal || 0)
          const lp = pointAt(i, scaleMax * 1.24)
          const anchor = Math.abs(lp.x - cx) < 12 ? 'middle' : (lp.x > cx ? 'start' : 'end')
          const dy = lp.y < cy - maxR * 0.7 ? -2 : (lp.y > cy + maxR * 0.7 ? 9 : 4)
          const isHot = hoveredId === axis.id
          const stepAngle = (2 * Math.PI) / count
          const a1 = mp.angle - stepAngle / 2
          const a2 = mp.angle + stepAngle / 2
          const hitR = maxR * 1.55
          const wedge = `${cx},${cy} ${(cx + Math.cos(a1) * hitR).toFixed(1)},${(cy + Math.sin(a1) * hitR).toFixed(1)} ${(cx + Math.cos(mp.angle) * hitR).toFixed(1)},${(cy + Math.sin(mp.angle) * hitR).toFixed(1)} ${(cx + Math.cos(a2) * hitR).toFixed(1)},${(cy + Math.sin(a2) * hitR).toFixed(1)}`
          return (
            <g
              key={axis.id}
              className="ca-ins-radar-axis-group"
              onMouseEnter={() => setHoveredId(axis.id)}
              onMouseLeave={() => setHoveredId(cur => (cur === axis.id ? '' : cur))}
            >
              <polygon points={wedge} fill="transparent" />
              <circle cx={mp.x} cy={mp.y} r={isHot ? 4 : 2.8} className="ca-ins-radar-dot-market" />
              {hasWorkDelta && (axis.withWorkAxisVal || 0) > (axis.resumeAxisVal || 0) && (
                <circle cx={wp.x} cy={wp.y} r={isHot ? 4 : 3} className="ca-ins-radar-dot-work" />
              )}
              {hasResume && (
                <circle cx={rp.x} cy={rp.y} r={isHot ? 4.2 : 3} className="ca-ins-radar-dot-resume" />
              )}
              <text
                x={lp.x}
                y={lp.y + dy}
                textAnchor={anchor}
                className={`ca-ins-radar-label${isHot ? ' is-active' : ''}`}
              >
                {axis.label}
              </text>
            </g>
          )
        })}
      </svg>

      <div className="ca-ins-radar-foot">
        {activeAxis ? (
          <div className="ca-ins-radar-readout">
            <div className="ca-ins-radar-readout-line">
              <strong>{activeAxis.label}</strong>
              <span>{t('insights.radarAxisMarket', { pct: activeAxis.marketPct, count: activeAxis.marketCount })}</span>
              {hasResume && (
                <span>· {t('insights.radarAxisResume', { pct: activeAxis.resumeCoveragePct })}</span>
              )}
            </div>
            {activeAxis.gapSkill && (
              <div className="ca-ins-radar-readout-sub">
                <span className="ca-ins-radar-gap-hint">{t('insights.radarAxisGap', { skill: shortSkillTag(activeAxis.gapSkill) })}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="ca-ins-radar-legend">
            <span><i className="ca-ins-swatch is-market" />{t('insights.legendMarketPull')}</span>
            {hasResume && <span><i className="ca-ins-swatch is-resume" />{t('insights.legendYourResume')}</span>}
            {hasWorkDelta && <span><i className="ca-ins-swatch is-work" />{t('insights.legendWithWork')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ==========================================================================
   Chart 2: 2D Skill Quadrant Bubble Matrix (Company Breadth × JD Density)
   ========================================================================== */
function estimateLabelWidth(text) {
  let w = 0
  for (const ch of String(text || '')) {
    w += /[\u4e00-\u9fff]/u.test(ch) ? 10.5 : 6.2
  }
  return w + 4
}

function SkillQuadrantChart({ skills = [], totalCompanies = 1, hasWorkOnly = false, onSelectSkill, t }) {
  const [hoveredId, setHoveredId] = React.useState('')

  const plotW = 760
  const plotH = 330
  const padL = 62
  const padR = 28
  const padT = 28
  const padB = 46
  const innerW = plotW - padL - padR
  const innerH = plotH - padT - padB

  const layout = React.useMemo(() => {
    if (!skills.length) return null
    const seniorVals = skills.map(s => Number(s.seniorPct ?? 0))
    const pcts = skills.map(s => Number(s.pct || 0))
    const maxCount = Math.max(1, ...skills.map(s => Number(s.count || 0)))

    const rawMinX = Math.min(...seniorVals)
    const rawMaxX = Math.max(...seniorVals)
    const xMin = Math.max(0, Math.floor(Math.max(0, rawMinX - 5) / 5) * 5)
    const xMax = Math.min(100, Math.max(xMin + 20, Math.ceil((rawMaxX + 5) / 5) * 5))

    const rawMinP = Math.min(...pcts)
    const rawMaxP = Math.max(...pcts)
    const yMin = Math.max(0, Math.floor(Math.max(0, rawMinP - 5) / 5) * 5)
    const yMax = Math.min(100, Math.max(yMin + 20, Math.ceil((rawMaxP + 6) / 10) * 10))

    // Adaptive median quadrant splitters
    const sortedX = [...seniorVals].sort((a, b) => a - b)
    const sortedP = [...pcts].sort((a, b) => a - b)
    const medX = sortedX[Math.floor(sortedX.length / 2)]
    const medP = sortedP[Math.floor(sortedP.length / 2)]
    const toX = v => padL + ((v - xMin) / Math.max(1, xMax - xMin)) * innerW
    const toY = p => padT + (1 - (p - yMin) / Math.max(1, yMax - yMin)) * innerH

    const midX = Math.max(padL + innerW * 0.28, Math.min(plotW - padR - innerW * 0.25, toX(medX)))
    const midY = Math.max(padT + innerH * 0.25, Math.min(plotH - padB - innerH * 0.25, toY(medP)))

    // Step 1: initial positions with jewel-like radii (5.5..13.5)
    const nodes = skills.map((skill, idx) => {
      const sv = Number(skill.seniorPct ?? 0)
      const p = Number(skill.pct || 0)
      const r = 5.5 + Math.sqrt((skill.count || 1) / maxCount) * 8
      return {
        skill,
        rank: idx,
        r,
        anchorX: toX(sv),
        anchorY: toY(p),
        x: Math.max(padL + r + 6, Math.min(plotW - padR - r - 6, toX(sv))),
        y: Math.max(padT + r + 6, Math.min(plotH - padB - r - 6, toY(p))),
      }
    })

    // Step 2: gentle 28-pass 2D force relaxation keeping bubbles faithful to coordinates without overlapping
    for (let iter = 0; iter < 28; iter += 1) {
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i]
          const b = nodes[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let dist = Math.hypot(dx, dy)
          const minDist = a.r + b.r + 7
          if (dist < minDist) {
            if (dist < 0.01) {
              dx = (i % 2 === 0 ? 1 : -1)
              dy = (j % 2 === 0 ? 0.6 : -0.6)
              dist = Math.hypot(dx, dy)
            }
            const push = (minDist - dist) * 0.45
            const ux = dx / dist
            const uy = dy / dist
            a.x -= ux * push
            a.y -= uy * push
            b.x += ux * push
            b.y += uy * push
          }
        }
      }
      // Pull lightly back toward true coordinates & clamp within plot box
      for (const n of nodes) {
        n.x += (n.anchorX - n.x) * 0.06
        n.y += (n.anchorY - n.y) * 0.06
        n.x = Math.max(padL + n.r + 6, Math.min(plotW - padR - n.r - 6, n.x))
        n.y = Math.max(padT + n.r + 6, Math.min(plotH - padB - n.r - 6, n.y))
      }
    }

    // Step 3: 4-way bounding-box label placement solver (zero label/bubble overlap & zero edge clipping)
    const placedBoxes = []
    const labelH = 14
    const boxOverlaps = (box, other) => !(
      box.x2 < other.x1 - 3 || box.x1 > other.x2 + 3 || box.y2 < other.y1 - 2 || box.y1 > other.y2 + 2
    )
    const boxHitsBubble = (box, selfIdx) => nodes.some((n, idx) => {
      if (idx === selfIdx) return false
      const nearestX = Math.max(box.x1, Math.min(n.x, box.x2))
      const nearestY = Math.max(box.y1, Math.min(n.y, box.y2))
      return Math.hypot(n.x - nearestX, n.y - nearestY) < n.r + 3
    })

    const positioned = nodes.map((node, idx) => {
      const tag = shortSkillTag(node.skill.label)
      const lw = estimateLabelWidth(tag)
      const candidates = [
        // Right
        { anchor: 'start', lx: node.x + node.r + 6, ly: node.y + 3.5, x1: node.x + node.r + 6, x2: node.x + node.r + 6 + lw, y1: node.y - 7, y2: node.y + 7 },
        // Left
        { anchor: 'end', lx: node.x - node.r - 6, ly: node.y + 3.5, x1: node.x - node.r - 6 - lw, x2: node.x - node.r - 6, y1: node.y - 7, y2: node.y + 7 },
        // Top
        { anchor: 'middle', lx: node.x, ly: node.y - node.r - 5, x1: node.x - lw / 2, x2: node.x + lw / 2, y1: node.y - node.r - 5 - labelH, y2: node.y - node.r - 3 },
        // Bottom
        { anchor: 'middle', lx: node.x, ly: node.y + node.r + 13, x1: node.x - lw / 2, x2: node.x + lw / 2, y1: node.y + node.r + 2, y2: node.y + node.r + 2 + labelH },
      ]
      let chosen = null
      for (const c of candidates) {
        const inBounds = c.x1 >= padL + 2 && c.x2 <= plotW - padR - 2 && c.y1 >= padT + 2 && c.y2 <= plotH - padB - 2
        if (!inBounds) continue
        if (placedBoxes.some(b => boxOverlaps(c, b))) continue
        if (boxHitsBubble(c, idx)) continue
        chosen = c
        break
      }
      // Show label cleanly for all collision-free bubbles (prioritizing top ranks & in_work_only)
      const defaultVisible = Boolean(chosen) && (idx < 12 || node.skill.coverage === 'in_work_only')
      if (defaultVisible && chosen) placedBoxes.push(chosen)
      // Fallback placement for hover state if a low-rank bubble was crowded out
      const hoverPlacement = chosen || candidates.find(c => c.x1 >= padL && c.x2 <= plotW - padR) || candidates[1]
      return { ...node, tag, labelPos: hoverPlacement, defaultVisible }
    })

    // Build crisp percentage X ticks & Y ticks
    const xMid = Math.round((xMin + xMax) / 2)
    const xTicks = [xMin, xMid, xMax]
    const yMid = Math.round((yMin + yMax) / 2)
    const yTicks = [yMin, yMid, yMax]

    return { points: positioned, midX, midY, xTicks, yTicks, toX, toY }
  }, [skills, innerW, innerH])

  if (!layout) {
    return <p className="ca-meta" style={{ margin: '12px 0' }}>{t('insights.noSkillsInFilter')}</p>
  }

  const { points, midX, midY, xTicks, yTicks, toX, toY } = layout
  const hovered = points.find(p => p.skill.id === hoveredId) ?? null

  return (
    <div className="ca-ins-quad-wrap">
      <div className="ca-ins-quad-inspector" aria-live="polite">
        {hovered ? (
          <div className="ca-ins-quad-readout">
            <strong>{hovered.skill.label}</strong>
            <span className={`ca-insights-cov-dot is-${hovered.skill.coverage}`}>
              {hovered.skill.coverage === 'covered'
                ? t('insights.covCovered')
                : hovered.skill.coverage === 'in_work_only'
                  ? t('insights.covWorkOnly')
                  : t('insights.covGap')}
            </span>
            <span className="ca-meta">
              {t('insights.quadHoverStat', {
                pct: hovered.skill.pct,
                count: hovered.skill.count,
                seniorPct: hovered.skill.seniorPct ?? 0,
                companies: hovered.skill.companyCount ?? 1,
                totalCompanies: Math.max(1, totalCompanies),
              })}
            </span>
            {hovered.skill.deltaPct !== null && hovered.skill.deltaPct !== 0 && (
              <span className={`ca-insights-delta is-${hovered.skill.trend}`}>
                {hovered.skill.deltaPct > 0 ? `↑ +${hovered.skill.deltaPct}%` : `↓ ${hovered.skill.deltaPct}%`}
              </span>
            )}
          </div>
        ) : (
          <div className="ca-ins-quad-legend">
            <span><i className="ca-ins-dot is-covered" />{t('insights.covCovered')}</span>
            {hasWorkOnly && <span><i className="ca-ins-dot is-in_work_only" />{t('insights.covWorkOnly')}</span>}
            <span><i className="ca-ins-dot is-gap" />{t('insights.covGap')}</span>
          </div>
        )}
      </div>

      <svg
        className="ca-ins-quad-svg"
        viewBox={`0 0 ${plotW} ${plotH}`}
        role="img"
        aria-label={t('insights.quadChartAria')}
      >
        {/* Subtle quadrant shading for Top-Right Core Consensus zone */}
        <rect
          x={midX}
          y={padT}
          width={plotW - padR - midX}
          height={midY - padT}
          className="ca-ins-quad-core-bg"
          rx="6"
        />

        {/* Horizontal Y-grid & ticks */}
        {yTicks.map(tick => {
          const y = toY(tick)
          return (
            <g key={`y-${tick}`}>
              <line x1={padL} y1={y} x2={plotW - padR} y2={y} stroke="currentColor" strokeOpacity="0.07" strokeWidth="0.75" />
              <text x={padL - 10} y={y + 3.5} textAnchor="end" className="ca-ins-axis-tick">{tick}%</text>
            </g>
          )
        })}

        {/* Vertical X-grid & seniority-% ticks */}
        {xTicks.map(tick => {
          const x = toX(tick)
          return (
            <g key={`x-${tick}`}>
              <line x1={x} y1={padT} x2={x} y2={plotH - padB} stroke="currentColor" strokeOpacity="0.06" strokeWidth="0.75" />
              <text x={x} y={plotH - padB + 14} textAnchor="middle" className="ca-ins-axis-tick">
                {tick}%
              </text>
            </g>
          )
        })}

        {/* Median Quadrant Dividers */}
        <line x1={midX} y1={padT} x2={midX} y2={plotH - padB} stroke="currentColor" strokeOpacity="0.16" strokeDasharray="3 3" />
        <line x1={padL} y1={midY} x2={plotW - padR} y2={midY} stroke="currentColor" strokeOpacity="0.16" strokeDasharray="3 3" />

        {/* Quadrant corner watermarks */}
        <text x={plotW - padR - 8} y={padT + 14} textAnchor="end" className="ca-ins-quad-watermark is-core">
          {t('insights.quadTopRight')}
        </text>
        <text x={padL + 8} y={padT + 14} textAnchor="start" className="ca-ins-quad-watermark">
          {t('insights.quadTopLeft')}
        </text>
        <text x={plotW - padR - 8} y={plotH - padB - 7} textAnchor="end" className="ca-ins-quad-watermark">
          {t('insights.quadBottomRight')}
        </text>
        <text x={padL + 8} y={plotH - padB - 7} textAnchor="start" className="ca-ins-quad-watermark">
          {t('insights.quadBottomLeft')}
        </text>

        {/* Axis Titles — cleanly separated from tick labels */}
        <text x={padL + innerW / 2} y={plotH - 8} textAnchor="middle" className="ca-ins-axis-title">
          {t('insights.quadXAxis')}
        </text>
        <text x={15} y={padT + innerH / 2} textAnchor="middle" transform={`rotate(-90 15 ${padT + innerH / 2})`} className="ca-ins-axis-title">
          {t('insights.quadYAxis')}
        </text>

        {/* Bubbles (render non-hovered first, hovered on top) */}
        {[...points]
          .sort((a, b) => Number(a.skill.id === hoveredId) - Number(b.skill.id === hoveredId))
          .map(({ skill, x, y, r, tag, labelPos, defaultVisible }) => {
            const isHot = hoveredId === skill.id
            const isDim = Boolean(hoveredId) && !isHot
            const showLabel = isHot || defaultVisible
            return (
              <g
                key={skill.id}
                className={`ca-ins-bubble is-${skill.coverage}${isHot ? ' is-active' : ''}${isDim ? ' is-dim' : ''}`}
                onMouseEnter={() => setHoveredId(skill.id)}
                onMouseLeave={() => setHoveredId('')}
                onClick={() => onSelectSkill?.(skill)}
              >
                {skill.coverage === 'in_work_only' && (
                  <circle cx={x} cy={y} r={r + 3.5} className="ca-ins-bubble-halo" />
                )}
                <circle cx={x} cy={y} r={isHot ? r + 2 : r} className="ca-ins-bubble-core" />
                {showLabel && labelPos && (
                  <text
                    x={labelPos.lx}
                    y={labelPos.ly}
                    textAnchor={labelPos.anchor}
                    className="ca-ins-bubble-label"
                  >
                    {tag}
                  </text>
                )}
              </g>
            )
          })}
      </svg>
    </div>
  )
}

/* ==========================================================================
   Chart 3: Company × Role-Track Heatmap Matrix
   ========================================================================== */
function CompanyTrackHeatmap({ matrix, onSelectCell, onSelectCompany, t }) {
  const companies = list(matrix?.companies)
  const tracks = list(matrix?.tracks)
  const cells = list(matrix?.cells)
  const maxCell = Math.max(1, Number(matrix?.maxCell || 1))

  if (!companies.length || !tracks.length) return null

  return (
    <div className="ca-ins-heatmap-scroll">
      <div
        className="ca-ins-heatmap-grid"
        style={{ gridTemplateColumns: `minmax(124px, 1.35fr) repeat(${tracks.length}, minmax(60px, 1fr))` }}
        role="grid"
        aria-label={t('insights.heatmapAria')}
      >
        {/* Header Row */}
        <div className="ca-ins-hm-corner">{t('insights.heatmapCompanyCol')}</div>
        {tracks.map(track => (
          <div key={track.id} className="ca-ins-hm-colhead" title={track.label}>
            <span>{track.shortLabel || track.label}</span>
          </div>
        ))}

        {/* Company Rows */}
        {companies.map((comp, rowIdx) => (
          <React.Fragment key={comp.company}>
            <button
              type="button"
              className="ca-ins-hm-rowhead"
              title={t('insights.clickCompanyHint')}
              onClick={() => onSelectCompany?.(comp)}
            >
              <CompanyAvatar company={comp.company} size={20} />
              <span className="ca-ins-hm-comp-name">{comp.company}</span>
              <span className="ca-ins-hm-comp-total">{comp.count}</span>
            </button>
            {tracks.map((track, colIdx) => {
              const cell = cells[rowIdx]?.[colIdx] ?? { count: 0, jobIds: [] }
              const ratio = cell.count > 0 ? Math.max(0.14, cell.count / maxCell) : 0
              const isDark = ratio >= 0.56
              if (cell.count === 0) {
                return <div key={`${comp.company}-${track.id}`} className="ca-ins-hm-cell is-empty" aria-hidden="true">·</div>
              }
              return (
                <button
                  key={`${comp.company}-${track.id}`}
                  type="button"
                  className={`ca-ins-hm-cell${isDark ? ' is-dark' : ''}`}
                  style={{ '--hm-intensity': ratio.toFixed(3) }}
                  title={t('insights.heatmapCellTitle', { company: comp.company, track: track.label, count: cell.count })}
                  onClick={() => onSelectCell?.(comp, track, cell.jobIds)}
                >
                  {cell.count}
                </button>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

/* ==========================================================================
   Chart 4A: Seniority Donut Ring + Proportional Geo Stacked Composition
   ========================================================================== */
function MarketCompositionCard({ seniorCount = 0, regularCount = 0, seniorSharePct = 0, locations = [], onSelectLocation, t }) {
  const r = 30
  const circ = 2 * Math.PI * r
  const seniorLen = (Math.max(0, Math.min(100, seniorSharePct)) / 100) * circ
  const locTotal = Math.max(1, locations.reduce((sum, l) => sum + (l.count || 0), 0))
  const topLocs = locations.slice(0, 5)
  const restCount = locations.slice(5).reduce((sum, l) => sum + (l.count || 0), 0)
  const segments = [
    ...topLocs.map((loc, i) => ({
      id: loc.id,
      label: loc.label,
      count: loc.count,
      share: (loc.count / locTotal) * 100,
      color: GEO_PALETTE[i % GEO_PALETTE.length],
    })),
    ...(restCount > 0 ? [{
      id: 'other',
      label: t('insights.otherCities'),
      count: restCount,
      share: (restCount / locTotal) * 100,
      color: GEO_PALETTE[5],
    }] : []),
  ]

  return (
    <div className="ca-ins-comp-body">
      {/* Donut Ring for Seniority Split */}
      <div className="ca-ins-donut-row">
        <div className="ca-ins-donut-wrap">
          <svg viewBox="0 0 80 80" width="80" height="80" role="img" aria-label={t('insights.seniorityAria')}>
            <circle cx="40" cy="40" r={r} fill="none" stroke="currentColor" strokeOpacity="0.1" strokeWidth="8" />
            <circle
              cx="40"
              cy="40"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${seniorLen.toFixed(1)} ${circ.toFixed(1)}`}
              transform="rotate(-90 40 40)"
            />
          </svg>
          <span className="ca-ins-donut-center"><b>{seniorSharePct}%</b></span>
        </div>
        <div className="ca-ins-donut-meta">
          <strong>{t('insights.seniorityTitle')}</strong>
          <div className="ca-ins-donut-stats">
            <span><i className="ca-ins-swatch is-resume" />{t('insights.seniorLabel', { count: seniorCount })}</span>
            <span><i className="ca-ins-swatch is-muted" />{t('insights.regularLabel', { count: regularCount })}</span>
          </div>
        </div>
      </div>

      {/* Proportional Segmented Geo Bar */}
      {segments.length > 0 && (
        <div className="ca-ins-geo-block">
          <div className="ca-ins-geo-head">
            <span>{t('insights.geoMixTitle')}</span>
          </div>
          <div className="ca-ins-geo-bar" role="presentation">
            {segments.map(seg => (
              <button
                key={seg.id}
                type="button"
                className="ca-ins-geo-seg"
                style={{ width: `${Math.max(4, seg.share)}%`, background: seg.color }}
                title={`${seg.label}: ${seg.count}`}
                onClick={() => seg.id !== 'other' && onSelectLocation?.(seg.label)}
              />
            ))}
          </div>
          <div className="ca-ins-geo-legend">
            {segments.map(seg => (
              <button
                key={seg.id}
                type="button"
                className="ca-ins-geo-item"
                disabled={seg.id === 'other'}
                onClick={() => seg.id !== 'other' && onSelectLocation?.(seg.label)}
              >
                <i className="ca-ins-swatch" style={{ background: seg.color }} />
                <span>{seg.label}</span>
                <b>{seg.count}</b>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ==========================================================================
   Chart 4B: Daily Patrol Activity & Historical Trend Chart
   ========================================================================== */
function PatrolActivityChart({ series = [], history = [], t }) {
  const data = series.length > 0 ? series : history.map(h => ({
    dateKey: h.dateKey,
    added: h.new7d ?? 0,
    closed: 0,
    activeSnapshot: h.activeCount ?? null,
  }))
  if (!data.length) {
    return <p className="ca-insights-trend-note">{t('insights.trendBaselineNote')}</p>
  }

  const W = 380
  const H = 108
  const padL = 28
  const padR = 12
  const padT = 14
  const padB = 22
  const innerW = W - padL - padR
  const innerH = H - padT - padB

  const maxBar = Math.max(1, ...data.map(d => Math.max(d.added || 0, d.closed || 0)))
  const slotW = innerW / Math.max(1, data.length)
  const barW = Math.min(22, Math.max(6, slotW * 0.44))

  const snapPoints = data
    .map((d, i) => (Number.isFinite(d.activeSnapshot) ? { i, val: d.activeSnapshot, dateKey: d.dateKey } : null))
    .filter(Boolean)
  const minSnap = snapPoints.length ? Math.min(...snapPoints.map(p => p.val)) : 0
  const maxSnap = snapPoints.length ? Math.max(...snapPoints.map(p => p.val)) : 1
  const snapSpan = Math.max(1, maxSnap - minSnap)
  const snapPolyline = snapPoints.length >= 2
    ? snapPoints.map(p => {
      const x = padL + (p.i + 0.5) * slotW
      const y = padT + (1 - (p.val - minSnap) / snapSpan) * (innerH * 0.8) + innerH * 0.1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    : ''

  return (
    <div className="ca-ins-activity-wrap">
      <svg className="ca-ins-activity-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('insights.trendChartAria')}>
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="currentColor" strokeOpacity="0.12" />
        <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="currentColor" strokeOpacity="0.06" strokeDasharray="2 3" />
        <text x={padL - 6} y={padT + 4} textAnchor="end" className="ca-ins-axis-tick">{maxBar}</text>
        <text x={padL - 6} y={padT + innerH + 3} textAnchor="end" className="ca-ins-axis-tick">0</text>

        {data.map((d, i) => {
          const cx = padL + (i + 0.5) * slotW
          const addH = ((d.added || 0) / maxBar) * innerH
          const closeH = ((d.closed || 0) / maxBar) * innerH
          const shortDate = String(d.dateKey || '').slice(5)
          const showTick = data.length <= 7 || i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2)
          return (
            <g key={d.dateKey || i}>
              {d.added > 0 && (
                <rect
                  x={cx - (d.closed > 0 ? barW * 0.95 : barW * 0.5)}
                  y={padT + innerH - addH}
                  width={d.closed > 0 ? barW * 0.85 : barW}
                  height={Math.max(2, addH)}
                  rx="2.5"
                  className="ca-ins-act-bar-add"
                >
                  <title>{`${d.dateKey}: +${d.added}`}</title>
                </rect>
              )}
              {d.closed > 0 && (
                <rect
                  x={cx + barW * 0.08}
                  y={padT + innerH - closeH}
                  width={barW * 0.8}
                  height={Math.max(2, closeH)}
                  rx="2.5"
                  className="ca-ins-act-bar-close"
                >
                  <title>{`${d.dateKey}: -${d.closed}`}</title>
                </rect>
              )}
              {showTick && (
                <text x={cx} y={H - 5} textAnchor="middle" className="ca-ins-axis-tick">{shortDate}</text>
              )}
            </g>
          )
        })}

        {snapPolyline && (
          <polyline
            points={snapPolyline}
            fill="none"
            stroke="var(--ca-blue)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>

      <div className="ca-ins-activity-foot">
        <div className="ca-ins-radar-legend">
          <span><i className="ca-ins-swatch is-resume" />{t('insights.legendAdded')}</span>
          <span><i className="ca-ins-swatch is-muted" />{t('insights.legendClosed')}</span>
          {snapPolyline && <span><i className="ca-ins-swatch is-market" />{t('insights.legendActivePool')}</span>}
        </div>
        {history.length >= 2 && (
          <span className="ca-meta">
            {t('insights.trendDaysTracked', { count: history.length })}
          </span>
        )}
      </div>
    </div>
  )
}

/* ==========================================================================
   Main「市场洞察」Page
   ========================================================================== */
export default function MarketInsights({
  state,
  act,
  busy,
  onExploreJobs,
  onOpenJobs,
  onResumeWithPrompt,
  onStartSession,
  onSources,
}) {
  const { t, locale } = useI18n()
  const [scope, setScope] = React.useState('target') // 'target' | 'all'
  const [skillFilter, setSkillFilter] = React.useState('all') // 'all' | 'covered' | 'in_work_only' | 'gap'
  const [skillView, setSkillView] = React.useState('quadrant') // 'quadrant' | 'table'
  const [strategyTab, setStrategyTab] = React.useState('align') // 'align' | 'trends' | 'tiers'
  const [strategyCollapsed, setStrategyCollapsedState] = React.useState(() => readProfileSession('insightBriefCollapsed') === '1')
  React.useEffect(() => subscribeProfileChange(() => {
    setStrategyCollapsedState(readProfileSession('insightBriefCollapsed') === '1')
  }), [])
  const setStrategyCollapsed = React.useCallback(next => {
    setStrategyCollapsedState(cur => {
      const val = typeof next === 'function' ? next(cur) : Boolean(next)
      writeProfileSession('insightBriefCollapsed', val ? '1' : '0')
      return val
    })
  }, [])

  const radar = state?.marketRadar ?? null
  const config = state?.config ?? {}
  const stats = radar?.[scope] ?? radar?.target ?? null
  const targetStats = radar?.target ?? null
  const allStats = radar?.all ?? null
  const reportEntry = radar?.reports?.[scope] ?? null
  const report = reportEntry?.report ?? null
  const evidenceSourceById = React.useMemo(() => {
    const map = new Map()
    for (const item of list(state?.evidence)) {
      if (item?.id && item?.sourceId) map.set(item.id, item.sourceId)
    }
    return map
  }, [state?.evidence])

  const insightOp = useTrackedOperation(act, {
    scopeKey: `market-insight:${scope}`,
    nonBlocking: true,
    serverOps: state?.activeOperations,
  })

  const fallbackRunningActivity = React.useMemo(() => {
    if (!radar?.running) return null
    const serverMatch = list(state?.activeOperations).find(op => op?.kind === 'market-insight')
    if (serverMatch) return serverMatch
    return {
      kind: 'market-insight',
      phase: 'trends',
      detail: t('insights.generatingTraceTitle'),
      startedAt: Date.now(),
    }
  }, [radar?.running, state?.activeOperations, t])

  const liveActivity = (insightOp.activity && insightOp.activity.phase !== 'ready')
    ? insightOp.activity
    : fallbackRunningActivity

  const running = insightOp.running || Boolean(radar?.running)
  const activeCount = stats?.activeCount ?? 0
  const jdCount = stats?.jdCount ?? 0
  const totalActiveCount = allStats?.activeCount ?? activeCount
  const hasAnyJobs = totalActiveCount > 0

  const runInsight = async () => {
    if (running) return
    setStrategyCollapsed(false)
    await insightOp.run(
      'market-insight',
      { scope, force: true },
      {
        kind: 'market-insight',
        label: scope === 'target' ? t('insights.scopeTarget') : t('insights.scopeAll'),
        toast: t('insights.toastUpdated'),
      },
    )
  }

  const allSkills = list(stats?.topSkills)
  const coveredSkillCount = allSkills.filter(s => s.coverage === 'covered').length
  const workOnlySkillCount = allSkills.filter(s => s.coverage === 'in_work_only').length
  const gapSkillCount = allSkills.filter(s => s.coverage === 'gap').length
  const hasWorkOnly = workOnlySkillCount > 0

  React.useEffect(() => {
    if (skillFilter === 'in_work_only' && !hasWorkOnly) setSkillFilter('all')
    else if (skillFilter === 'covered' && coveredSkillCount === 0) setSkillFilter('all')
    else if (skillFilter === 'gap' && gapSkillCount === 0) setSkillFilter('all')
  }, [skillFilter, hasWorkOnly, coveredSkillCount, gapSkillCount])

  const skillFilterTabs = React.useMemo(() => [
    ['all', t('insights.filterAll')],
    ...(coveredSkillCount > 0 ? [['covered', t('insights.filterCovered')]] : []),
    ...(hasWorkOnly ? [['in_work_only', `${t('insights.filterWorkOnly')} ${workOnlySkillCount}`]] : []),
    ...(gapSkillCount > 0 ? [['gap', t('insights.filterGap')]] : []),
  ], [t, coveredSkillCount, hasWorkOnly, workOnlySkillCount, gapSkillCount])

  const filteredSkills = React.useMemo(() => {
    if (skillFilter === 'all') return allSkills
    return allSkills.filter(s => s.coverage === skillFilter)
  }, [allSkills, skillFilter])
  const coverage = stats?.coverageSummary ?? {
    topCount: 0, coveredCount: 0, inWorkOnlyCount: 0, gapCount: 0, readinessPct: 0, hiddenGemSkills: [], topGapSkills: [],
  }
  const radarAxes = list(stats?.radarAxes)
  const companyTrackMatrix = stats?.companyTrackMatrix ?? null
  const activitySeries = list(stats?.activitySeries)
  const clusters = list(stats?.roleClusters)
  const locations = list(stats?.locations)
  const history = list(stats?.history)

  const topCovered = allSkills.filter(s => s.coverage === 'covered').slice(0, 3)
  const deterministicTopGaps = (list(coverage.topGapSkills).length > 0
    ? list(coverage.topGapSkills)
    : allSkills.filter(s => s.coverage === 'gap')).slice(0, 3)
  const aiPriorityGaps = list(report?.personalAlignment?.gaps).slice(0, 3)
  const heroGaps = aiPriorityGaps.length > 0
    ? aiPriorityGaps.map((g, idx) => ({ id: `ai-gap-${idx}`, label: g.skill, pct: null, jobIds: null, fromAi: true }))
    : deterministicTopGaps
  const hiddenGems = list(coverage.hiddenGemSkills)
  const topDomains = [...radarAxes].sort((a, b) => (b.marketPct || 0) - (a.marketPct || 0)).slice(0, 2)

  const findJobIdsForTerm = term => {
    const clean = String(term || '').trim().toLowerCase()
    if (!clean) return []
    const skillHit = allSkills.find(s => s.label.toLowerCase().includes(clean) || clean.includes(s.id.replace(/_/g, ' ')))
    if (skillHit?.jobIds?.length) return skillHit.jobIds
    const clusterHit = clusters.find(c => c.label.toLowerCase().includes(clean))
    if (clusterHit?.jobIds?.length) return clusterHit.jobIds
    return list(state?.opportunities)
      .filter(j => !j.closedAt && `${j.title || ''} ${j.company || ''} ${j.jd || ''}`.toLowerCase().includes(clean))
      .map(j => j.id)
      .slice(0, 80)
  }

  const jumpToTermJobs = (term, explicitIds = null) => {
    const ids = Array.isArray(explicitIds) && explicitIds.length > 0 ? explicitIds : findJobIdsForTerm(term)
    if (ids.length > 0) onExploreJobs?.({ label: term, ids })
    else onExploreJobs?.({ query: term })
  }

  const hasReportBody = Boolean(
    report && (
      list(report.hotTrends).length > 0
      || list(report.requirementProfile?.baseline).length > 0
      || list(report.requirementProfile?.differentiators).length > 0
      || Boolean(report.personalAlignment?.verdict)
      || list(report.personalAlignment?.strengths).length > 0
      || list(report.personalAlignment?.hiddenGems).length > 0
      || list(report.personalAlignment?.gaps).length > 0
      || list(report.actionPlan).length > 0
    ),
  )

  const sampleStale = Boolean(
    reportEntry && stats && (
      Math.abs((stats.activeCount || 0) - (reportEntry.sample?.activeCount || 0)) >= 8
      || (reportEntry.fingerprint && stats.fingerprint && reportEntry.fingerprint !== stats.fingerprint)
    ),
  )

  if (!hasAnyJobs) {
    return (
      <div className="ca-insights-screen" data-surface="insights">
        <div className="ca-dsh-page-head">
          <div className="ca-jobs-head-title">
            <h2>{t('insights.title')}</h2>
          </div>
        </div>
        <div className="ca-insights-empty">
          <div className="ca-jobs-empty-art" aria-hidden="true">
            <EmptySearchEmblem size={56} emptyCatalog />
          </div>
          <h3>{t('insights.emptyTitle')}</h3>
          <p>{t('insights.emptyDesc')}</p>
          <div className="ca-inline">
            <Button variant="primary" size="sm" onClick={() => onOpenJobs?.()}>
              {t('insights.emptyGoJobs')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onSources?.('')}>
              {t('insights.emptyCheckWatch')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const autoHeadline = coverage.hasResume
    ? t('insights.autoHeadlineResume', {
      covered: coverage.coveredCount,
      topCount: coverage.topCount || 10,
      domain1: topDomains[0]?.label || '',
      domain2: topDomains[1]?.label || '',
    })
    : t('insights.autoHeadlineNoResume', {
      count: activeCount,
      domain1: topDomains[0]?.label || '',
      domain2: topDomains[1]?.label || '',
    })

  return (
    <div className="ca-insights-screen" data-surface="insights">
      {/* Page Header */}
      <div className="ca-dsh-page-head">
        <div className="ca-insights-head-left">
          <h2>{t('insights.title')}</h2>
          <div className="ca-lens-pills" role="tablist" aria-label={t('insights.scopeAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'target'}
              className={`ca-lens-pill${scope === 'target' ? ' is-active' : ''}`}
              onClick={() => { setScope('target'); setSkillFilter('all') }}
            >
              {t('insights.scopeTarget')} <b>{targetStats?.activeCount ?? 0}</b>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              className={`ca-lens-pill${scope === 'all' ? ' is-active' : ''}`}
              onClick={() => { setScope('all'); setSkillFilter('all') }}
            >
              {t('insights.scopeAll')} <b>{allStats?.activeCount ?? 0}</b>
            </button>
          </div>
        </div>
        <div className="ca-inline">
          {reportEntry?.generatedAt && hasReportBody && (
            <span className="ca-meta">
              {t('insights.updatedAt', { time: readableDate(reportEntry.generatedAt, config.timezone, locale) })}
            </span>
          )}
          <span className="ca-tip-anchor">
            <Button
              variant={hasReportBody ? 'outline' : 'primary'}
              size="sm"
              className="ca-nowrap-btn"
              disabled={running || Boolean(busy)}
              onClick={() => void runInsight()}
            >
              {running
                ? t('insights.generating')
                : (hasReportBody ? t('insights.refreshReport') : t('insights.generateReport'))}
            </Button>
            <span className="ca-tip-pop is-right" role="tooltip">
              <strong>{t('insights.aiTooltipTitle')}</strong>
              <span>{(state.mode === 'search' && (config.boards?.length ?? 0) > 0 && config.sendToModel)
                ? t('insights.aiTooltipAuto', { count: jdCount || activeCount })
                : t('insights.aiTooltipManual', { count: jdCount || activeCount })}</span>
            </span>
          </span>
        </div>
      </div>

      {/* Live AI Generation Trace — persists seamlessly across tab switches & reloads */}
      {liveActivity && (
        <AiTraceCard
          activity={liveActivity}
          title={liveActivity.phase === 'error'
            ? t('insights.generateFailed')
            : t('insights.generatingTraceTitle')}
          onDismiss={insightOp.dismiss}
        />
      )}

      {/* ================================================================
          SECTION 1: FOCAL HERO — Dynamic Capability Radar + Verdict & Telemetry
         ================================================================ */}
      <section className="ca-ins-hero" aria-label={t('insights.heroAria')}>
        <div className="ca-ins-hero-visual">
          <div className="ca-ins-hero-visual-head">
            <div className="ca-ins-title-with-tip">
              <span className="ca-ins-kicker">{t('insights.radarTitle')}</span>
              <HelpTip title={t('insights.radarTitle')} text={t('insights.radarHelpTip')} />
            </div>
          </div>
          <CapabilityRadarChart axes={radarAxes} hasResume={coverage.hasResume} t={t} />
        </div>

        <div className="ca-ins-hero-main">
          <div className="ca-ins-hero-meta-row">
            <span className="ca-inline-mark ca-ins-kicker">
              <DeepSeekMark size={13} />
              <span>{hasReportBody ? t('insights.reportBadge') : t('insights.livePulseBadge')}</span>
            </span>
            {radar?.basisResume && (
              <span className="ca-meta">
                {t('insights.basisResume', { title: radar.basisResume.title })}
              </span>
            )}
          </div>

          <h3 className="ca-ins-hero-headline">
            {hasReportBody ? report.headline : autoHeadline}
          </h3>
          {hasReportBody && report.marketSummary && (
            <p className="ca-ins-hero-desc">{report.marketSummary}</p>
          )}

          {/* Calm editorial inline telemetry strip */}
          <div className="ca-ins-telemetry-strip" aria-label={t('insights.kpiAria')}>
            <div className="ca-ins-stat">
              <span className="ca-ins-stat-val"><AnimatedNumber value={activeCount} /></span>
              <span className="ca-ins-stat-label">{t('insights.statOpenRoles', { companies: stats?.companyCount ?? 0 })}</span>
            </div>
            <div className="ca-ins-stat">
              <span className="ca-ins-stat-val">
                {coverage.hasResume ? `${coverage.readinessPct}%` : '—'}
              </span>
              <span className="ca-ins-stat-label">
                {coverage.hasResume
                  ? t('insights.statCoverageRatio', { covered: coverage.coveredCount, total: coverage.topCount || 10 })
                  : t('insights.kpiCoverageNoResume')}
              </span>
            </div>
            <div className="ca-ins-stat">
              <span className="ca-ins-stat-val">+{stats?.velocity?.new7d ?? 0}</span>
              <span className="ca-ins-stat-label">{t('insights.statVelocity7d', { closed: stats?.velocity?.closed7d ?? 0 })}</span>
            </div>
            <div className="ca-ins-stat">
              <span className="ca-ins-stat-val">{stats?.seniorSharePct ?? 0}%</span>
              <span className="ca-ins-stat-label">{t('insights.statSeniorShare')}</span>
            </div>
          </div>

          {/* Focused signal summary strip */}
          <div className="ca-ins-focus-pills">
            {hiddenGems.length > 0 && (
              <div className="ca-ins-focus-row is-gem">
                <span className="ca-ins-focus-tag">{t('insights.focusWorkGem')}</span>
                <div className="ca-ins-focus-chips">
                  {hiddenGems.slice(0, 3).map(skill => (
                    <button
                      key={skill.id}
                      type="button"
                      className="ca-ins-focus-chip is-gem"
                      title={skill.label}
                      onClick={() => {
                        const leadEvidence = skill.matchedEvidence?.[0]
                        const prompt = buildResumeWeavePrompt({
                          title: leadEvidence?.title || skill.label,
                          detail: `${skill.label} (${skill.pct}%)`,
                          locale,
                        })
                        const leadSourceId = leadEvidence?.sourceId || (leadEvidence?.id ? evidenceSourceById.get(leadEvidence.id) : '')
                        const sourceIds = leadSourceId ? [leadSourceId] : []
                        onResumeWithPrompt?.(sourceIds.length ? { text: prompt, sourceIds } : prompt)
                      }}
                    >
                      <span>{shortSkillTag(skill.label, { maxZh: 11, maxLatin: 22 })}</span>
                      <span aria-hidden="true">→ {t('insights.addShort')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {heroGaps.length > 0 && (
              <div className="ca-ins-focus-row">
                <span className="ca-ins-focus-tag">{t('insights.focusTopGaps')}</span>
                <div className="ca-ins-focus-chips">
                  {heroGaps.map(skill => (
                    <button
                      key={skill.id}
                      type="button"
                      className="ca-ins-focus-chip is-gap"
                      title={skill.label}
                      onClick={() => jumpToTermJobs(skill.label, skill.jobIds)}
                    >
                      <span>{shortSkillTag(skill.label, { maxZh: 15, maxLatin: 24 })}</span>
                      {skill.pct != null && <b>{skill.pct}%</b>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {topCovered.length > 0 && (
              <div className="ca-ins-focus-row">
                <span className="ca-ins-focus-tag">{t('insights.focusEdge')}</span>
                <div className="ca-ins-focus-chips">
                  {topCovered.map(skill => (
                    <button
                      key={skill.id}
                      type="button"
                      className="ca-ins-focus-chip is-covered"
                      title={skill.label}
                      onClick={() => jumpToTermJobs(skill.label, skill.jobIds)}
                    >
                      <span>{shortSkillTag(skill.label, { maxZh: 11, maxLatin: 22 })}</span>
                      <b>{skill.pct}%</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {sampleStale && hasReportBody && !running && (
            <div className="ca-ins-hero-cta-row">
              <button type="button" className="ca-text-button" onClick={() => void runInsight()}>
                {t('insights.sampleUpdatedHint')}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ================================================================
          SECTION 2 (Conditional & Collapsible): Focused Tabbed AI Strategy Brief
         ================================================================ */}
      {hasReportBody && (
        <section className={`ca-ins-card ca-ins-strategy-card${strategyCollapsed ? ' is-collapsed' : ''}`} aria-label={t('insights.aiSectionAria')}>
          {strategyCollapsed ? (
            <button
              type="button"
              className="ca-ins-strategy-collapsed-bar"
              aria-expanded="false"
              onClick={() => setStrategyCollapsed(false)}
            >
              <span className="ca-ins-strategy-collapsed-left">
                <span className="ca-inline-mark">
                  <DeepSeekMark size={13} />
                  <strong>{t('insights.reportBadge')}</strong>
                </span>
                <span className="ca-meta">
                  {t('insights.collapsedSummary', {
                    trends: list(report.hotTrends).length,
                    gaps: list(report.personalAlignment?.gaps).length,
                    actions: list(report.actionPlan).length,
                  })}
                </span>
              </span>
              <span className="ca-ins-collapse-trigger">
                <span>{t('insights.expandBrief')}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
          ) : <>
          <div className="ca-ins-card-head is-wrap">
            <nav className="ca-ins-subtabs" role="tablist" aria-label={t('insights.strategyTabsAria')}>
              {[
                ['align', t('insights.tabPersonalStrategy')],
                ['trends', t('insights.tabHotTrends')],
                ['tiers', t('insights.tabReqTiers')],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={strategyTab === id}
                  className={`ca-ins-subtab${strategyTab === id ? ' is-active' : ''}`}
                  onClick={() => setStrategyTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="ca-inline">
              <span className="ca-meta">
                {[
                  reportEntry?.sample?.jdCount ? t('insights.reportSampleMeta', { count: reportEntry.sample.jdCount }) : '',
                  reportEntry?.model || '',
                  reportEntry?.trigger === 'auto' ? t('insights.triggerAuto') : t('insights.triggerManual'),
                ].filter(Boolean).join(' · ')}
              </span>
              <button
                type="button"
                className="ca-ins-collapse-trigger"
                aria-expanded="true"
                onClick={() => setStrategyCollapsed(true)}
              >
                <span>{t('common.collapse')}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M3 7.5 6 4.5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          {strategyTab === 'align' && (
            <div className="ca-ins-strategy-body">
              {report.personalAlignment?.verdict && (
                <p className="ca-insights-verdict">{report.personalAlignment.verdict}</p>
              )}
              <div className="ca-ins-strategy-cols">
                <div className="ca-insights-col">
                  {list(report.personalAlignment?.hiddenGems).length > 0 && (
                    <div className="ca-insights-subblock is-gem">
                      <span className="ca-insights-subblock-label">{t('insights.aiHiddenGemsLabel')}</span>
                      {report.personalAlignment.hiddenGems.map((gem, idx) => (
                        <div key={`${gem.point}-${idx}`} className="ca-insights-align-item">
                          <div className="ca-insights-align-head">
                            <strong>{gem.point}</strong>
                            <button
                              type="button"
                              className="ca-text-button"
                              onClick={() => {
                                const prompt = buildResumeWeavePrompt({
                                  title: gem.evidenceTitle || gem.point,
                                  detail: gem.detail,
                                  locale,
                                })
                                const reportSources = Array.isArray(reportEntry?.provenance?.sourceIds) ? reportEntry.provenance.sourceIds.filter(Boolean) : []
                                onResumeWithPrompt?.(reportSources.length ? { text: prompt, sourceIds: reportSources } : prompt)
                              }}
                            >
                              {t('insights.weaveIntoResume')}
                            </button>
                          </div>
                          <p>{gem.detail}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {list(report.personalAlignment?.strengths).length > 0 && (
                    <div className="ca-insights-subblock">
                      <span className="ca-insights-subblock-label">{t('insights.strengthsLabel')}</span>
                      {report.personalAlignment.strengths.map((item, idx) => (
                        <div key={`${item.point}-${idx}`} className="ca-insights-align-item">
                          <strong>{item.point}</strong>
                          <p>{item.detail}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {list(report.personalAlignment?.gaps).length > 0 && (
                    <div className="ca-insights-subblock">
                      <span className="ca-insights-subblock-label">{t('insights.gapsLabel')}</span>
                      {report.personalAlignment.gaps.map((gap, idx) => (
                        <div key={`${gap.skill}-${idx}`} className="ca-insights-align-item">
                          <div className="ca-insights-align-head">
                            <div className="ca-inline">
                              <strong>{gap.skill}</strong>
                              <Tag tone={gap.priority === 'high' ? 'warning' : 'neutral'}>
                                {gap.priority === 'high' ? t('insights.priorityHigh') : t('insights.priorityMed')}
                              </Tag>
                            </div>
                            <button
                              type="button"
                              className="ca-text-button"
                              onClick={() => onStartSession?.(buildStudyPrompt({
                                topic: gap.skill,
                                why: gap.why,
                                howInCurrentJob: gap.howInCurrentJob,
                                goal: config.goal,
                                locale,
                              }))}
                            >
                              {t('insights.studyInDsh')}
                            </button>
                          </div>
                          {gap.why && <p>{gap.why}</p>}
                          {gap.howInCurrentJob && (
                            <p className="ca-insights-how-work">
                              <b>{t('insights.inCurrentJobPrefix')}</b>{gap.howInCurrentJob}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {list(report.actionPlan).length > 0 && (
                  <div className="ca-insights-col">
                    <span className="ca-insights-subblock-label">{t('insights.actionPlanTitle')}</span>
                    <ol className="ca-insights-action-list">
                      {report.actionPlan.map((step, idx) => (
                        <li key={`${step.title}-${idx}`} className="ca-insights-action-item">
                          <div className="ca-insights-action-head">
                            <strong>{step.title}</strong>
                            <span className="ca-insights-horizon-chip">{horizonLabel(step.horizon, t)}</span>
                          </div>
                          <p>{step.detail}</p>
                          <div className="ca-insights-action-links">
                            {step.kind === 'resume' && (
                              <button
                                type="button"
                                className="ca-text-button"
                                onClick={() => {
                                  const prompt = buildResumeWeavePrompt({
                                    title: step.title,
                                    detail: step.detail,
                                    locale,
                                  })
                                  const reportSources = Array.isArray(reportEntry?.provenance?.sourceIds) ? reportEntry.provenance.sourceIds.filter(Boolean) : []
                                  onResumeWithPrompt?.(reportSources.length ? { text: prompt, sourceIds: reportSources } : prompt)
                                }}
                              >
                                {t('insights.weaveIntoResume')}
                              </button>
                            )}
                            {step.filterTerm && (
                              <button type="button" className="ca-text-button" onClick={() => jumpToTermJobs(step.filterTerm)}>
                                {t('insights.viewMatchingJds', { term: step.filterTerm })}
                              </button>
                            )}
                            {step.studyTopic && (
                              <button
                                type="button"
                                className="ca-text-button"
                                onClick={() => onStartSession?.(buildStudyPrompt({
                                  topic: step.studyTopic,
                                  why: step.detail,
                                  goal: config.goal,
                                  locale,
                                }))}
                              >
                                {t('insights.studyInDsh')}
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            </div>
          )}

          {strategyTab === 'trends' && (
            <div className="ca-ins-trends-grid">
              {list(report.hotTrends).map((trend, idx) => (
                <article key={`${trend.title}-${idx}`} className="ca-insights-trend-card">
                  <div className="ca-insights-trend-card-head">
                    <strong>{trend.title}</strong>
                    <Tag tone={heatTone(trend.heat)}>{heatLabel(trend.heat, t)}</Tag>
                  </div>
                  <p>{trend.signal}</p>
                  {list(trend.skills).length > 0 && (
                    <div className="ca-insights-chip-row">
                      {trend.skills.map(skill => (
                        <button key={skill} type="button" className="ca-insights-skill-chip" onClick={() => jumpToTermJobs(skill)}>
                          {skill}<span aria-hidden="true">→</span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}

          {strategyTab === 'tiers' && (
            <div className="ca-ins-tiers-grid">
              {[
                ['baseline', t('insights.tierBaseline'), ''],
                ['differentiators', t('insights.tierDiff'), 'is-strong'],
                ['emerging', t('insights.tierEmerging'), 'is-emerging'],
              ].map(([key, label, tone]) => (
                <div key={key} className="ca-ins-tier-col">
                  <span className="ca-insights-req-label">{label}</span>
                  <div className="ca-insights-chip-row">
                    {list(report.requirementProfile?.[key]).map(item => (
                      <button key={item} type="button" className={`ca-insights-tier-pill ${tone}`} onClick={() => jumpToTermJobs(item)}>
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          </>}
        </section>
      )}

      {/* ================================================================
          SECTION 3: 2D Skill Value Quadrant (Seniority Bar × JD Density)
         ================================================================ */}
      <section className="ca-ins-card" aria-label={t('insights.quadChartAria')}>
        <div className="ca-ins-card-head is-wrap">
          <div className="ca-ins-title-with-tip">
            <h4>{t('insights.quadTitle')}</h4>
            <HelpTip
              title={t('insights.quadTitle')}
              text={t('insights.quadSub', { count: jdCount || activeCount })}
            />
          </div>
          <div className="ca-ins-card-tools">
            {skillFilterTabs.length > 1 && (
              <div className="ca-insights-filter-pills" role="tablist" aria-label={t('insights.skillFilterAria')}>
                {skillFilterTabs.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={skillFilter === id}
                    className={`ca-insights-filter-pill${skillFilter === id ? ' is-active' : ''}`}
                    onClick={() => setSkillFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="ca-insights-filter-pills" role="tablist" aria-label={t('insights.viewModeAria')}>
              <button
                type="button"
                role="tab"
                aria-selected={skillView === 'quadrant'}
                className={`ca-insights-filter-pill${skillView === 'quadrant' ? ' is-active' : ''}`}
                onClick={() => setSkillView('quadrant')}
              >
                {t('insights.viewQuadrant')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={skillView === 'table'}
                className={`ca-insights-filter-pill${skillView === 'table' ? ' is-active' : ''}`}
                onClick={() => setSkillView('table')}
              >
                {t('insights.viewTable')}
              </button>
            </div>
          </div>
        </div>

        {skillView === 'quadrant' ? (
          <SkillQuadrantChart
            skills={filteredSkills}
            totalCompanies={stats?.companyCount ?? 1}
            hasWorkOnly={hasWorkOnly}
            onSelectSkill={skill => jumpToTermJobs(skill.label, skill.jobIds)}
            t={t}
          />
        ) : (
          <div className="ca-ins-table-wrap">
            <table className="ca-ins-table">
              <thead>
                <tr>
                  <th>{t('insights.tableSkillCol')}</th>
                  <th>{t('insights.tableCoverageCol')}</th>
                  <th className="is-num">{t('insights.tableCompaniesCol')}</th>
                  <th className="is-num">{t('insights.tableJobsCol')}</th>
                  <th className="is-num">{t('insights.tableShareCol')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredSkills.map(skill => (
                  <tr key={skill.id} onClick={() => jumpToTermJobs(skill.label, skill.jobIds)}>
                    <td><strong>{skill.label}</strong></td>
                    <td>
                      <span className={`ca-insights-cov-dot is-${skill.coverage}`}>
                        {skill.coverage === 'covered'
                          ? t('insights.covCovered')
                          : skill.coverage === 'in_work_only'
                            ? t('insights.covWorkOnly')
                            : t('insights.covGap')}
                      </span>
                    </td>
                    <td className="is-num">{skill.companyCount ?? 1} / {stats?.companyCount ?? 1}</td>
                    <td className="is-num">{skill.count}</td>
                    <td className="is-num">
                      <b>{skill.pct}%</b>
                      {skill.deltaPct !== null && skill.deltaPct !== 0 && (
                        <span className={`ca-insights-delta is-${skill.trend}`} style={{ marginLeft: 6 }}>
                          {skill.deltaPct > 0 ? `+${skill.deltaPct}%` : `${skill.deltaPct}%`}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ================================================================
          SECTION 4: Multi-Dimensional Bottom Row
          Left: Company × Role-Track Heatmap | Right: Seniority Donut + Geo + Activity Timeline
         ================================================================ */}
      <section className="ca-ins-bottom-grid" aria-label={t('insights.quantAria')}>
        <div className="ca-ins-card">
          <div className="ca-ins-card-head">
            <div className="ca-ins-title-with-tip">
              <h4>{t('insights.heatmapTitle')}</h4>
              <HelpTip title={t('insights.heatmapTitle')} text={t('insights.heatmapSub')} />
            </div>
          </div>
          <CompanyTrackHeatmap
            matrix={companyTrackMatrix}
            onSelectCompany={comp => onExploreJobs?.({
              company: { key: comp.company, company: comp.company, label: comp.company },
            })}
            onSelectCell={(comp, track, jobIds) => {
              if (Array.isArray(jobIds)) {
                onExploreJobs?.({ label: `${comp.company} · ${track.shortLabel || track.label}`, ids: jobIds })
              } else {
                onExploreJobs?.({ company: { key: comp.company, company: comp.company, label: comp.company } })
              }
            }}
            t={t}
          />
        </div>

        <div className="ca-insights-col">
          <div className="ca-ins-card">
            <div className="ca-ins-card-head">
              <h4>{t('insights.compositionTitle')}</h4>
            </div>
            <MarketCompositionCard
              seniorCount={stats?.seniorCount ?? 0}
              regularCount={stats?.regularCount ?? 0}
              seniorSharePct={stats?.seniorSharePct ?? 0}
              locations={locations}
              onSelectLocation={loc => onExploreJobs?.({ query: loc })}
              t={t}
            />
          </div>

          <div className="ca-ins-card">
            <div className="ca-ins-card-head">
              <div className="ca-ins-title-with-tip">
                <h4>{t('insights.activityTitle')}</h4>
                <HelpTip title={t('insights.activityTitle')} text={t('insights.activityHelpTip')} align="right" />
              </div>
            </div>
            <PatrolActivityChart series={activitySeries} history={history} t={t} />
          </div>
        </div>
      </section>
    </div>
  )
}
