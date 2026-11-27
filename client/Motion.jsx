import React from 'react'
import { createPortal } from 'react-dom'
import { useClipboardCopy, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { useI18n } from './i18n.jsx'

export function useMenuDismiss(rootRef, open, onClose, { onEscape, closeOnBlur = true } = {}) {
  const closeRef = React.useRef(onClose)
  const escapeRef = React.useRef(onEscape || onClose)
  closeRef.current = onClose
  escapeRef.current = onEscape || onClose

  const setOpenFalse = React.useCallback(next => {
    if (!next) closeRef.current?.()
  }, [])
  useDismissOnOutsidePointer(rootRef, open, setOpenFalse)

  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      escapeRef.current?.()
    }
    const onWindowBlur = () => { closeRef.current?.() }
    document.addEventListener('keydown', onKeyDown)
    if (closeOnBlur) window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (closeOnBlur) window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, closeOnBlur])
}

export function SlidingTabs({ tabs, value, onChange, renderIcon, inboxCount, counts, runningTabs, className = '', ariaLabel }) {
  const { t } = useI18n()
  const resolvedAria = ariaLabel || t('nav.ariaLabel')
  const list = React.useRef(null)
  const [position, setPosition] = React.useState(null)

  React.useLayoutEffect(() => {
    const element = list.current
    const selected = element?.querySelector('[aria-current="page"], [aria-selected="true"]')
    if (!selected) return
    const measure = () => {
      const next = { width: selected.offsetWidth, left: selected.offsetLeft }
      setPosition(current => current?.width === next.width && current.left === next.left ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(selected)
    return () => observer.disconnect()
  }, [value, tabs.length])

  return <nav ref={list} className={`ca-nav ${className}`.trim()} aria-label={resolvedAria}>
    {position && <span className="ca-nav-indicator" aria-hidden="true"
      style={{ width: position.width, transform: `translateX(${position.left}px)` }} />}
    {tabs.map(([id, label, icon]) => {
      const badge = counts ? (counts[id] ?? 0) : (id === 'overview' ? (inboxCount ?? 0) : 0)
      return <button type="button" key={id} aria-current={id === value ? 'page' : undefined}
        aria-description={badge > 0 ? t('common.pendingCount', { count: badge }) : undefined}
        onClick={() => onChange(id)}>{renderIcon?.(icon)}<span>{label}</span>
        {runningTabs?.[id] ? <LiveBeacon state="ongoing" /> : (
          badge > 0 && <span className="ca-inbox-count" aria-hidden="true" key={badge}>
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>
    })}
  </nav>
}

// transitions.dev inspired numeric digit flip on count transitions
export function AnimatedNumber({ value, className = '' }) {
  const text = String(value ?? 0)
  return <span className={`ca-anim-num ${className}`.trim()} aria-label={text}>
    <span key={text} className="ca-anim-num-digit">{text}</span>
  </span>
}

// transitions.dev + reactbits.dev/c/micro stateful morphing copy button
export function CopyButton({ text, label, copiedLabel, className = '' }) {
  const { t } = useI18n()
  const resolvedLabel = label ?? t('common.copy')
  const resolvedCopied = copiedLabel ?? t('common.copied')
  const { copied, onCopy } = useClipboardCopy(String(text ?? ''))

  const handleCopy = event => {
    event.stopPropagation()
    if (!text) return
    onCopy()
  }

  return <button type="button" className={`ca-copy-btn${copied ? ' is-copied' : ''} ${className}`.trim()} onClick={handleCopy}>
    <span className="ca-copy-icon" aria-hidden="true">
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path className="ca-check-stroke" pathLength="1" d="M3.2 8.4 6.5 11.6 13 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v4.6a1.7 1.7 0 0 0 1.7 1.7h1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </span>
    <span>{copied ? resolvedCopied : resolvedLabel}</span>
  </button>
}

// cube-motion.dev "morph" inspired smooth CSS grid-row accordion (replaces harsh native <details>)
export function Expandable({ title, meta, defaultOpen = false, open: controlledOpen, onToggle, children, className = '' }) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen
  const toggle = () => {
    const next = !isOpen
    if (controlledOpen === undefined) setInternalOpen(next)
    onToggle?.(next)
  }
  return <div className={`ca-expandable${isOpen ? ' is-open' : ''} ${className}`.trim()}>
    <button type="button" className="ca-expandable-trigger" aria-expanded={isOpen} onClick={toggle}>
      <svg className="ca-expandable-chevron" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="ca-expandable-title">{title}</span>
      {meta && <span className="ca-expandable-meta">{meta}</span>}
    </button>
    <div className="ca-expandable-body" aria-hidden={!isOpen}>
      <div className="ca-expandable-inner">{children}</div>
    </div>
  </div>
}

// cube-motion.dev "rise" inspired WAAPI staggered list entrance (zero deps, respects reduced motion)
export function useRiseList(ref, triggerKey) {
  React.useLayoutEffect(() => {
    const root = ref.current
    if (!root || typeof root.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const items = [...root.querySelectorAll(':scope > [data-rise]')].slice(0, 14)
    const animations = items.map((el, idx) =>
      el.animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: 240,
          delay: idx * 28,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        },
      ),
    )
    return () => { for (const anim of animations) anim.cancel() }
  }, [ref, triggerKey])
}

export function InfoTip({ text, down = false, wide = false, question = true, onClick }) {
  const triggerRef = React.useRef(null)
  const [open, setOpen] = React.useState(false)
  const [coords, setCoords] = React.useState(null)

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setCoords(null)
      return
    }
    const updatePosition = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const dialog = el.closest?.('dialog[open]')
      const pad = 12
      const gap = 8
      if (dialog) {
        const dialogRect = dialog.getBoundingClientRect()
        const width = Math.min(wide ? 276 : 248, Math.max(180, dialogRect.width - pad * 2))
        const relLeft = rect.left - dialogRect.left
        const relTop = rect.top - dialogRect.top
        const relBottom = rect.bottom - dialogRect.top
        const left = Math.max(pad, Math.min(relLeft - 14, dialogRect.width - pad - width))
        const spaceBelow = dialogRect.height - relBottom - pad - gap
        const spaceAbove = relTop - pad - gap
        const preferDown = down
          ? (spaceBelow >= 110 || spaceBelow >= spaceAbove)
          : (spaceAbove < 110 && spaceBelow > spaceAbove)
        if (preferDown) {
          setCoords({ position: 'absolute', left, top: relBottom + gap, width })
        } else {
          setCoords({ position: 'absolute', left, bottom: dialogRect.height - relTop + gap, width })
        }
        return
      }
      const container = el.closest?.('.ca-sheet-shell, .ca-page')
      const bounds = container?.getBoundingClientRect?.()
      const minLeft = Math.max(pad, bounds ? bounds.left + pad : pad)
      const maxRight = Math.min(window.innerWidth - pad, bounds ? bounds.right - pad : window.innerWidth - pad)
      const width = Math.min(wide ? 276 : 248, Math.max(180, maxRight - minLeft))
      const left = Math.max(minLeft, Math.min(rect.left - 14, maxRight - width))
      const spaceBelow = window.innerHeight - rect.bottom - pad - gap
      const spaceAbove = rect.top - pad - gap
      const preferDown = down
        ? (spaceBelow >= 110 || spaceBelow >= spaceAbove)
        : (spaceAbove < 110 && spaceBelow > spaceAbove)
      if (preferDown) {
        setCoords({ position: 'fixed', left, top: rect.bottom + gap, width })
      } else {
        setCoords({ position: 'fixed', left, bottom: window.innerHeight - rect.top + gap, width })
      }
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, down, wide, text])

  const portalHost = open && triggerRef.current
    ? (triggerRef.current.closest?.('dialog[open]')
      || triggerRef.current.closest?.('.ca-page')
      || (typeof document !== 'undefined' ? document.body : null))
    : null

  return (
    <span
      ref={triggerRef}
      className="ca-info-tip"
      tabIndex={0}
      role="note"
      aria-label={text}
      onClick={onClick}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {question ? (
        <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
          <path d="M6.3 6.2a1.75 1.75 0 1 1 2.73 1.45c-.62.42-1.03.85-1.03 1.6v.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8" cy="11.6" r="0.8" fill="currentColor" />
        </svg>
      ) : (
        <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7.3v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
        </svg>
      )}
      {open && coords && portalHost ? createPortal(
        <span
          className="ca-info-tip-pop is-portal"
          role="tooltip"
          style={{
            position: coords.position,
            left: coords.left,
            width: coords.width,
            ...(coords.top != null ? { top: coords.top } : { bottom: coords.bottom }),
          }}
        >
          {text}
        </span>,
        portalHost,
      ) : null}
    </span>
  )
}

export function LiveBeacon({ state = 'idle' }) {
  const tone = state === 'done' ? 'live'
    : state === 'ongoing' ? 'syncing'
      : state === 'warning' ? 'warn'
        : state === 'error' ? 'error' : 'idle'
  return <span className={`ca-beacon is-${tone}`} aria-hidden="true">
    {tone === 'live' && <span className="ca-beacon-ping" />}
    {tone === 'syncing' ? (
      <svg className="ca-beacon-spin" viewBox="0 0 16 16" width="14" height="14" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
        <path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ) : (
      <span className="ca-beacon-core" />
    )}
  </span>
}

export function SideSheet({ title, subtitle, leading = null, wide = false, children, onClose }) {
  const { t, bcp47 } = useI18n()
  const dialog = React.useRef(null)
  const closeButton = React.useRef(null)
  const [leaving, setLeaving] = React.useState(false)

  React.useLayoutEffect(() => {
    const element = dialog.current
    const origin = document.activeElement
    // Suspend macOS Electron window-drag regions underneath the open sheet so the top-right × button is always clickable.
    const dragRegions = [...document.querySelectorAll('.ca-header[data-window-drag]')]
    for (const node of dragRegions) node.removeAttribute('data-window-drag')
    element.showModal()
    const raf = window.requestAnimationFrame(() => {
      if (element.isConnected && element.open) closeButton.current?.focus()
    })
    return () => {
      window.cancelAnimationFrame(raf)
      for (const node of dragRegions) if (node.isConnected) node.setAttribute('data-window-drag', '')
      if (element.open) element.close()
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus()
    }
  }, [])

  React.useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(onClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 170)
    return () => window.clearTimeout(timer)
  }, [leaving, onClose])

  return <dialog className={`ca-source-sheet${wide ? ' is-wide' : ''}`} lang={bcp47} data-leaving={leaving} data-window-drag-exclude="true" ref={dialog} aria-labelledby="ca-sheet-title"
    onCancel={event => { event.preventDefault(); setLeaving(true) }}
    onClick={event => { if (event.target === dialog.current) setLeaving(true) }}>
    <div className="ca-sheet-shell" data-window-drag-exclude="true">
      <header className="ca-sheet-heading" data-window-drag-exclude="true">
        <div className="ca-sheet-heading-lead">
          {leading}
          <div className="ca-sheet-heading-text">
            <h2 id="ca-sheet-title">{title}</h2>
            {subtitle && <p className="ca-meta">{subtitle}</p>}
          </div>
        </div>
        <button className="ca-icon-button" data-window-drag-exclude="true" ref={closeButton} type="button" aria-label={t('common.close')} onClick={() => setLeaving(true)}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {children({ dismiss: () => setLeaving(true) })}
    </div>
  </dialog>
}
