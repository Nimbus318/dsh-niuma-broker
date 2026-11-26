import React from 'react'
import { Button, SegmentedControl, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import templatePreviews from './template-gallery-previews.json'
import {
  accentToThumbFilter, normalizeResumeStyle, RESUME_ACCENT_SWATCHES, templateDisplayName,
} from '../src/resume-style.mjs'
import { getActiveLocale, useI18n } from './i18n.jsx'
import {
  captureProfileContext,
  checkProfileMismatch,
  isProfileContextCurrent,
  profileRequestHeaders,
  readProfileLocal,
  subscribeProfileChange,
  writeProfileLocal,
} from './profile-storage.js'

const A4_WIDTH = 794
const A4_HEIGHT = 1123
const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const paperCss = `
  html,body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rr{margin:0 auto;width:${A4_WIDTH}px}
  .rr-page{width:${A4_WIDTH}px;max-width:${A4_WIDTH}px}
  .rr a{pointer-events:none}
  @page{size:A4;margin:0}
  @media print{
    html,body{background:#fff}
    .rr,.rr-page{width:auto;max-width:100%}
    .rr .rr-page{overflow:visible!important;box-shadow:none!important}
  }
`

function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function paper({ html, css, lang }, title) {
  return `<!doctype html><html lang="${escape(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${css.replaceAll('</', '<\\/')}${paperCss}</style></head><body><div class="rr">${html}</div></body></html>`
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = filename
  link.href = url
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function layoutTag(item, t) {
  if (!item) return ''
  return item.columns === 2 ? t('template.double') : t('template.single')
}

function AppearancePopover({ anchorRef, effectiveStyle, hasCustomStyle, onStyleChange, onStyleReset, onClose }) {
  const { t, locale, bcp47 } = useI18n()
  const panelRef = React.useRef(null)
  const uid = React.useId()
  const fontOptions = React.useMemo(() => [
    { value: 'sans', label: t('template.sans') },
    { value: 'serif', label: t('template.serif') },
  ], [t])
  const densityOptions = React.useMemo(() => [
    { value: 'compact', label: t('template.compact') },
    { value: 'balanced', label: t('template.balanced') },
    { value: 'airy', label: t('template.airy') },
  ], [t])

  const dismissOutside = React.useCallback(next => {
    if (!next) onClose?.()
  }, [onClose])
  useDismissOnOutsidePointer(anchorRef, true, dismissOutside, panelRef)
  useModalLayer(panelRef, true, onClose)

  React.useEffect(() => {
    const onWindowBlur = () => {
      if (document.activeElement?.type === 'color') return
      onClose?.()
    }
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [onClose])

  return <div ref={panelRef} className="ca-popover ca-popover-surface ca-appearance-popover" role="dialog" aria-label={t('template.appearanceAria')}>
    <div className="ca-pop-section">
      <div className="ca-pop-head">
        <span>{t('template.accentColor')}</span>
        {hasCustomStyle && <button type="button" className="ca-text-button" onClick={onStyleReset}>{t('template.resetDefault')}</button>}
      </div>
      <div className="ca-swatch-grid">
        {RESUME_ACCENT_SWATCHES.map(swatch => {
          const active = effectiveStyle.accent.toLowerCase() === swatch.hex.toLowerCase()
          const swLabel = t(`template.swatch.${swatch.id}`) || swatch.label
          return <button key={swatch.id} type="button" className="ca-swatch"
            title={swLabel} aria-label={t('template.accentColorAria', { label: swLabel })} aria-pressed={active}
            style={{ '--swatch': swatch.hex }}
            onClick={() => onStyleChange({ accent: swatch.hex })} />
        })}
        <label className="ca-swatch ca-swatch-custom" title={t('template.customColorTitle')}>
          <input type="color" aria-label={t('template.customColorAria')} value={effectiveStyle.accent}
            onChange={event => onStyleChange({ accent: event.target.value })} />
          <span aria-hidden="true">+</span>
        </label>
      </div>
    </div>

    <div className="ca-pop-section">
      <div className="ca-pop-head"><span>{t('template.fontStyle')}</span></div>
      <SegmentedControl id={`${uid}-font`} label={t('template.fontStyle')} value={effectiveStyle.font}
        options={fontOptions} onChange={font => onStyleChange({ font })} />
    </div>

    <div className="ca-pop-section">
      <div className="ca-pop-head"><span>{t('template.density')}</span></div>
      <SegmentedControl id={`${uid}-density`} label={t('template.density')} value={effectiveStyle.density}
        options={densityOptions} onChange={density => onStyleChange({ density })} />
    </div>

    <p className="ca-pop-tip">{t('template.appearanceTip')}</p>
  </div>
}

export default function LocalTemplatePaper({
  title, text, templates, beforeExport, playing, previewingUnapplied = false,
  resumeId, pdfSupported = false, retainedHtml, onRenderHtml,
  template: controlledTemplate, onSelectTemplate,
  styleOverrides, onStyleChange, onStyleReset,
  externalExportRef, onExportState,
}) {
  const { t, locale, bcp47 } = useI18n()
  const layoutOptions = React.useMemo(() => [
    { value: 'all', label: t('template.all') },
    { value: 'single', label: t('template.single') },
    { value: 'double', label: t('template.double') },
  ], [t])
  const template = templates.some(item => item.id === controlledTemplate) ? controlledTemplate : templates[0]?.id
  const [layoutFilter, setLayoutFilter] = React.useState('all')
  const [stripOpen, setStripOpen] = React.useState(() => readProfileLocal('templateStripOpen') === '1')
  React.useEffect(() => subscribeProfileChange(() => {
    setStripOpen(readProfileLocal('templateStripOpen') === '1')
  }), [])
  const [fitPage, setFitPage] = React.useState(true)
  const [styleOpen, setStyleOpen] = React.useState(false)
  const [buffers, setBuffers] = React.useState(() => [
    retainedHtml ? { key: '__retained__', html: retainedHtml } : null,
    null,
  ])
  const [activeSlot, setActiveSlot] = React.useState(0)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState('')
  const [rawHeight, setRawHeight] = React.useState(A4_HEIGHT)
  const [stageWidth, setStageWidth] = React.useState(520)
  const [stageHeight, setStageHeight] = React.useState(740)
  const [exporting, setExporting] = React.useState('')
  const frameRefs = React.useRef([null, null])
  const scrollRef = React.useRef(null)
  const stageRef = React.useRef(null)
  const stripRef = React.useRef(null)
  const appearanceAnchorRef = React.useRef(null)
  const closeStyle = React.useCallback(() => setStyleOpen(false), [])

  const toggleStrip = React.useCallback(() => {
    setStripOpen(prev => {
      const next = !prev
      writeProfileLocal('templateStripOpen', next ? '1' : '0')
      return next
    })
  }, [])
  const gallery = React.useRef(null)
  const galleryButton = React.useRef(null)
  const galleryTitle = React.useId()
  const filterId = React.useId()
  const activeSlotRef = React.useRef(activeSlot)
  const buffersRef = React.useRef(buffers)
  activeSlotRef.current = activeSlot
  buffersRef.current = buffers

  const selected = templates.find(item => item.id === template)
  const effectiveStyle = React.useMemo(
    () => normalizeResumeStyle(styleOverrides, template),
    [styleOverrides, template],
  )
  const hasCustomStyle = Boolean(styleOverrides && Object.keys(styleOverrides).length > 0)
  const key = JSON.stringify([title, template, effectiveStyle, text])
  const activeBuffer = buffers[activeSlot]
  const current = activeBuffer?.key === key
  const visibleTemplates = React.useMemo(() => {
    if (layoutFilter === 'single') return templates.filter(item => item.columns === 1)
    if (layoutFilter === 'double') return templates.filter(item => item.columns === 2)
    return templates
  }, [templates, layoutFilter])

  React.useEffect(() => {
    onExportState?.({ ready: current && !error, exporting })
  }, [current, error, exporting, onExportState])

  React.useLayoutEffect(() => {
    const node = stageRef.current
    const scroller = scrollRef.current
    if (!node && !scroller) return
    const measure = () => {
      const w = node?.clientWidth ?? 0
      const h = scroller?.clientHeight ?? 0
      if (w > 120) setStageWidth(prev => Math.abs(prev - w) < 2 ? prev : w)
      if (h > 180) setStageHeight(prev => Math.abs(prev - h) < 2 ? prev : h)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (node) observer.observe(node)
    if (scroller) observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!text?.trim() || !template) return
    const visible = activeSlotRef.current
    const other = 1 - visible
    if (buffersRef.current[visible]?.key === key) {
      setRefreshing(false)
      return
    }
    if (buffersRef.current[other]?.key === key) {
      const sheet = frameRefs.current[other]?.contentDocument?.querySelector('.rr')
      if (sheet) {
        const measured = Math.ceil(sheet.getBoundingClientRect().height || A4_HEIGHT)
        setRawHeight(Math.max(A4_HEIGHT, Math.min(A4_HEIGHT * 6, measured)))
      }
      setActiveSlot(other)
      setRefreshing(false)
      return
    }
    const controller = new AbortController()
    const reqCtx = captureProfileContext()
    setRefreshing(true)
    const delay = playing ? 260 : 120
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('api/career-agent/local-preview', {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
          body: JSON.stringify({ text, title, template, style: effectiveStyle }),
        })
        const data = await response.json().catch(() => null)
        checkProfileMismatch(response, data)
        if (!isProfileContextCurrent(reqCtx) || controller.signal.aborted) return
        if (!response.ok || !data?.ok) throw new Error(data?.error || t('template.previewFailed'))
        const html = paper(data.result, title)
        const nextEntry = { key, html }
        onRenderHtml?.(html)
        setError('')
        const curVisible = activeSlotRef.current
        const curOther = 1 - curVisible
        const existingOtherHtml = buffersRef.current[curOther]?.html
        setBuffers(prev => {
          if (!prev[curVisible]) {
            const copy = [...prev]
            copy[curVisible] = nextEntry
            return copy
          }
          const copy = [...prev]
          copy[curOther] = nextEntry
          return copy
        })
        if (buffersRef.current[curVisible] && existingOtherHtml === html) {
          setActiveSlot(curOther)
          setRefreshing(false)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason.message || t('template.previewFailed'))
          setRefreshing(false)
        }
      }
    }, delay)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [key, text, title, template, effectiveStyle, playing, onRenderHtml])

  function handleFrameLoad(slot) {
    const iframe = frameRefs.current[slot]
    const entry = buffersRef.current[slot]
    if (!iframe || !entry) return
    const sheet = iframe.contentDocument?.querySelector('.rr')
    if (sheet) {
      const measured = Math.ceil(sheet.getBoundingClientRect().height || A4_HEIGHT)
      setRawHeight(Math.max(A4_HEIGHT, Math.min(A4_HEIGHT * 6, measured)))
    }
    if (slot !== activeSlotRef.current && entry.key === key) setActiveSlot(slot)
    if (entry.key === key) setRefreshing(false)
  }

  const scrollStrip = direction => {
    const node = stripRef.current
    if (!node) return
    node.scrollBy({ left: direction * Math.max(240, node.clientWidth * 0.72), behavior: 'smooth' })
  }

  const downloadHtml = React.useCallback(async (overrideId) => {
    if (exporting) return
    const reqCtx = captureProfileContext()
    setExporting('html')
    try {
      const targetId = overrideId || resumeId
      const exportResult = await beforeExport(targetId)
      if (!exportResult || !isProfileContextCurrent(reqCtx)) return
      const persistedText = typeof exportResult === 'string' ? exportResult : null
      let html = buffersRef.current[activeSlotRef.current]?.html || ''
      const needsFreshRender = Boolean(
        !html
        || previewingUnapplied
        || (persistedText !== null && (persistedText !== text || buffersRef.current[activeSlotRef.current]?.key !== key)),
      )
      if (needsFreshRender && persistedText) {
        const response = await fetch('api/career-agent/local-preview', {
          method: 'POST', credentials: 'same-origin',
          headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
          body: JSON.stringify({ text: persistedText, title, template, style: effectiveStyle }),
        })
        const data = await response.json().catch(() => null)
        checkProfileMismatch(response, data)
        if (!isProfileContextCurrent(reqCtx)) return
        if (!response.ok || !data?.ok || !data.result) {
          throw new Error(data?.error || t('template.previewFailed'))
        }
        html = paper(data.result, title)
      }
      if (!html || !isProfileContextCurrent(reqCtx)) return
      const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').trim() || t('nav.resume')
      triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), `${name}-${template}.html`)
    } catch (reason) {
      if (isProfileContextCurrent(reqCtx)) setError(reason.message || t('template.previewFailed'))
    } finally { setExporting('') }
  }, [beforeExport, effectiveStyle, exporting, key, previewingUnapplied, resumeId, template, text, title, t])

  const downloadPdf = React.useCallback(async (overrideId) => {
    const targetId = overrideId || resumeId
    if (!targetId || !pdfSupported || exporting) return
    const reqCtx = captureProfileContext()
    setExporting('pdf')
    setError('')
    try {
      if (!await beforeExport(targetId) || !isProfileContextCurrent(reqCtx)) return
      const response = await fetch('api/career-agent/export-pdf', {
        method: 'POST', credentials: 'same-origin',
        headers: profileRequestHeaders({ 'content-type': 'application/json', 'x-career-locale': getActiveLocale() }, reqCtx),
        body: JSON.stringify({ id: targetId, template, style: effectiveStyle }),
      })
      if (!response.ok) {
        const failed = await response.json().catch(() => null)
        checkProfileMismatch(response, failed)
        if (!isProfileContextCurrent(reqCtx)) return
        throw new Error(failed?.error || t('template.pdfFailed'))
      }
      if (!isProfileContextCurrent(reqCtx)) return
      const blob = await response.blob()
      if (!isProfileContextCurrent(reqCtx)) return
      const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').trim() || t('nav.resume')
      triggerDownload(blob, `${name}-${template}.pdf`)
    } catch (reason) {
      if (isProfileContextCurrent(reqCtx)) setError(reason.message || t('template.pdfFailed'))
    } finally { setExporting('') }
  }, [beforeExport, effectiveStyle, exporting, pdfSupported, resumeId, template, title, t])

  React.useImperativeHandle(externalExportRef, () => ({
    downloadPdf,
    downloadHtml,
  }), [downloadPdf, downloadHtml])

  const pageCount = Math.max(1, Math.ceil((rawHeight - 16) / A4_HEIGHT))
  const pageBreaks = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 1)
  const fitWidthScale = Math.min(1, Math.max(0.32, (stageWidth - 2) / A4_WIDTH))
  const fitPageScale = Math.min(1, Math.max(0.32, Math.max(260, stageHeight - 36) / rawHeight))
  const canToggleFit = !stripOpen && pageCount === 1 && fitPageScale < fitWidthScale - 0.02
  const scale = (!stripOpen && pageCount === 1 && fitPage)
    ? Math.min(fitWidthScale, fitPageScale)
    : fitWidthScale
  const scaledWidth = Math.round(A4_WIDTH * scale)
  const scaledHeight = Math.round(rawHeight * scale)

  function onGalleryKeyDown(event) {
    const tiles = [...(gallery.current?.querySelectorAll('button[data-template]') ?? [])]
    const currentIndex = tiles.indexOf(document.activeElement)
    if (currentIndex < 0) return
    let next = -1
    if (event.key === 'ArrowRight') next = Math.min(tiles.length - 1, currentIndex + 1)
    else if (event.key === 'ArrowLeft') next = Math.max(0, currentIndex - 1)
    else if (event.key === 'ArrowDown') next = Math.min(tiles.length - 1, currentIndex + 4)
    else if (event.key === 'ArrowUp') next = Math.max(0, currentIndex - 4)
    if (next >= 0 && next !== currentIndex) {
      event.preventDefault()
      tiles[next].focus()
    }
  }

  return <section className="ca-local-paper" data-appearance-open={styleOpen ? 'true' : undefined} aria-label={t('template.paperAria')}>
    <div className="ca-stage-head" data-strip-open={stripOpen ? 'true' : 'false'}>
      <div className="ca-template-tools">
        {selected && <button type="button" className="ca-template-trigger" aria-expanded={stripOpen}
          aria-label={stripOpen ? t('template.collapseStripAria') : t('template.expandStripAria')}
          onClick={toggleStrip}>
          <strong>{templateDisplayName(selected, locale)}</strong>
          <span className="ca-template-spec">{t('template.pagesSpec', { layout: layoutTag(selected, t), count: pageCount })}</span>
          <svg className="ca-template-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>}
        {previewingUnapplied && <span className="ca-preview-pending-pill" role="status">
          {t('template.previewPendingBadge')}
        </span>}
        {refreshing && activeBuffer && <span className="ca-preview-sync" role="status" aria-live="polite">
          <i aria-hidden="true" />{t('template.typesetting')}
        </span>}
      </div>

      <div className="ca-template-bar-actions">
        <div className="ca-appearance-anchor" ref={appearanceAnchorRef}>
          <Button variant="outline" size="sm" className="ca-appearance-trigger"
            aria-expanded={styleOpen} disabled={playing}
            onClick={() => setStyleOpen(v => !v)}>
            <span className="ca-color-dot" style={{ background: effectiveStyle.accent }} aria-hidden="true" />
            {t('template.appearance')}
          </Button>
          {styleOpen && <AppearancePopover
            anchorRef={appearanceAnchorRef}
            effectiveStyle={effectiveStyle}
            hasCustomStyle={hasCustomStyle}
            onStyleChange={onStyleChange}
            onStyleReset={onStyleReset}
            onClose={closeStyle}
          />}
        </div>

        {canToggleFit && <Button variant="ghost" size="sm" onClick={() => setFitPage(v => !v)}
          title={fitPage ? t('template.zoomInTitle') : t('template.fitPageTitle')}>
          {fitPage ? t('template.zoomIn') : t('template.fitPage')}
        </Button>}
      </div>
    </div>

    <div className="ca-template-strip-collapse" data-open={stripOpen ? 'true' : 'false'} aria-hidden={!stripOpen}>
      <div className="ca-template-strip-collapse-inner">
        <div className="ca-template-inline-gallery" data-surface="template-gallery" ref={gallery}>
          <div className="ca-template-inline-gallery-head">
            <SegmentedControl id={filterId} label={t('template.filterColumnsAria')} className="ca-compact-seg"
              value={layoutFilter} options={layoutOptions} onChange={setLayoutFilter} />
            <button type="button" className="ca-text-button" tabIndex={stripOpen ? 0 : -1} onClick={toggleStrip}>
              {t('common.collapse')}
            </button>
          </div>
          <div className="ca-template-gallery-grid" role="region" aria-label={t('template.galleryAria')} onKeyDown={onGalleryKeyDown}>
            {visibleTemplates.map(item => {
              const active = item.id === template
              const thumbHex = active ? effectiveStyle.accent : (item.defaultAccent || '#18181b')
              return <button key={item.id} type="button" className="ca-strip-card ca-gallery-grid-card"
                data-template={item.id} data-template-strip={item.id} aria-pressed={active}
                aria-label={t('template.applyTemplateAria', { label: templateDisplayName(item, locale), layout: layoutTag(item, t) })}
                tabIndex={stripOpen ? 0 : -1}
                disabled={playing}
                onClick={() => onSelectTemplate(item.id)}>
                <span className="ca-strip-thumb">
                  <img src={templatePreviews[item.id]} alt="" width="240" height="339" loading="lazy" draggable="false"
                    style={{ filter: accentToThumbFilter(thumbHex) }} />
                  {active && <span className="ca-strip-check" aria-hidden="true">✓</span>}
                </span>
                <span className="ca-strip-label">
                  <span>{templateDisplayName(item, locale)}</span>
                  <small>{layoutTag(item, t)}{item.atsSafe ? ' · ATS' : ''}</small>
                </span>
              </button>
            })}
          </div>
        </div>
      </div>
    </div>

    {error && <p className="ca-form-error ca-paper-error" role="alert">{error}</p>}

    <div className="ca-paper-stage-scroll" ref={scrollRef} data-fit-page={!stripOpen && pageCount === 1 && fitPage ? 'true' : undefined}>
      <div className="ca-paper-stage" ref={stageRef}>
        {!activeBuffer && !error && <div className="ca-paper-skeleton" role="status" style={{ width: scaledWidth, height: Math.round(A4_HEIGHT * scale) }}>
          <span>{t('template.rendering', { label: templateDisplayName(selected, locale) })}</span>
        </div>}
        {(buffers[0] || buffers[1]) && <div className="ca-paper-sheet-box"
          style={{ width: scaledWidth, height: scaledHeight }}
          data-refreshing={refreshing || undefined}>
          {[0, 1].map(slot => {
            const entry = buffers[slot]
            if (!entry) return null
            const isVisible = slot === activeSlot
            return <iframe key={slot}
              ref={node => { frameRefs.current[slot] = node }}
              className="ca-local-preview-frame"
              data-buffer-active={isVisible ? 'true' : 'false'}
              aria-hidden={!isVisible || undefined}
              tabIndex={isVisible ? 0 : -1}
              title={isVisible ? t('template.previewFrameTitle') : t('template.previewBufferTitle')}
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
              srcDoc={entry.html}
              style={{
                width: A4_WIDTH,
                height: rawHeight,
                transform: `scale(${scale})`,
              }}
              onLoad={() => handleFrameLoad(slot)} />
          })}
          {pageBreaks.map(pageNumber => (
            <div key={pageNumber} className="ca-page-break-guide" aria-hidden="true"
              style={{ top: Math.round(pageNumber * A4_HEIGHT * scale) }}>
              <span>{t('common.pageN', { page: pageNumber + 1 })}</span>
            </div>
          ))}
        </div>}
      </div>
    </div>
  </section>
}
