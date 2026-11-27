import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createResumeEditor, directionStyles, requiresMarkdownSource } from '../vendor/reactive-resume-editor/editor.bundle.js'
import { normalizeCjkBoldMarkdown } from '../src/resume-style.mjs'
import { resolveRichEditorLine } from './rich-editor-lines.js'
import { useI18n } from './i18n.jsx'

export { requiresMarkdownSource, resolveRichEditorLine }

const formatActions = [
  { id: 'h1', activeName: 'heading', labelKey: 'editor.h1', icon: 'H₁', attrs: { level: 1 }, command: chain => chain.toggleHeading({ level: 1 }) },
  { id: 'heading', activeName: 'heading', labelKey: 'editor.h2', icon: 'H₂', attrs: { level: 2 }, command: chain => chain.toggleHeading({ level: 2 }) },
  { id: 'h3', activeName: 'heading', labelKey: 'editor.h3', icon: 'H₃', attrs: { level: 3 }, command: chain => chain.toggleHeading({ level: 3 }) },
  { id: 'bold', activeName: 'bold', labelKey: 'editor.bold', icon: 'B', command: chain => chain.toggleBold() },
  { id: 'italic', activeName: 'italic', labelKey: 'editor.italic', icon: 'I', command: chain => chain.toggleItalic() },
  { id: 'bulletList', activeName: 'bulletList', labelKey: 'editor.bulletList', icon: '•≡', command: chain => chain.toggleBulletList() },
  { id: 'orderedList', activeName: 'orderedList', labelKey: 'editor.orderedList', icon: '¹≡', command: chain => chain.toggleOrderedList() },
]

const editorStyles = `
.ca-local-rich-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ca-ink, #17191c);
}
.ca-local-rich-toolbar {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 2px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 24px;
  border-block-end: 0.5px solid var(--ca-line-subtle, var(--ca-line, #eceef2));
  background: color-mix(in srgb, var(--ca-bg, #fff) 94%, transparent);
  opacity: 0.9;
  transition: opacity 160ms ease;
}
.ca-local-rich-editor:hover .ca-local-rich-toolbar,
.ca-local-rich-editor:focus-within .ca-local-rich-toolbar {
  opacity: 1;
}
.ca-local-rich-toolbar-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.ca-local-rich-sep {
  width: 0.5px;
  height: 14px;
  margin-inline: 5px;
  background: var(--ca-line, #e4e7ec);
}
.ca-local-rich-toolbar-meta {
  margin-inline-start: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ca-subtle, #78808a);
  padding-inline: 4px;
}
.ca-local-rich-toolbar button {
  display: grid;
  place-items: center;
  min-width: 28px;
  height: 26px;
  margin: 0;
  padding: 0 5px;
  font: 580 12.5px/1 system-ui, -apple-system, sans-serif;
  border: 0;
  border-radius: var(--dsw-radius-sm, 7px);
  color: var(--ca-muted, #575e68);
  background: transparent;
  transition: background-color 130ms ease, color 130ms ease;
}
.ca-local-rich-toolbar button[data-format='italic'] { font-style: italic; font-family: Georgia, serif; }
.ca-local-rich-toolbar button:disabled { opacity: 0.42; color: var(--ca-muted, #575e68); }
@media (hover: hover) {
  .ca-local-rich-toolbar button:enabled:hover {
    background: var(--ca-hover, #f3f5f8);
    color: var(--ca-ink, #17191c);
  }
}
.ca-local-rich-toolbar button[aria-pressed='true'] {
  background: var(--ca-hover, #f0f2f5);
  color: var(--ca-ink, #17191c);
}
.ca-local-rich-toolbar button:focus-visible { outline: 2px solid var(--ca-blue, #315bd6); outline-offset: -1px; }
.ca-local-rich-scroll {
  position: relative;
  min-height: 360px;
}
.ca-local-rich-content {
  box-sizing: border-box;
  min-height: 280px;
  padding: 20px 26px 40px;
  overflow-wrap: anywhere;
  font-size: 14.5px;
  line-height: 1.78;
}
.ca-local-rich-content:focus { outline: 0; }
.ca-local-rich-content p { margin: 0 0 0.6em; }
.ca-local-rich-content p:last-child { margin-bottom: 0; }
.ca-local-rich-content :is(h1, h2, h3, h4, h5, h6) {
  margin: 0.9em 0 0.36em;
  line-height: 1.32;
  font-weight: 600;
  letter-spacing: -.015em;
}
.ca-local-rich-content :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }
.ca-local-rich-content h1 { font-size: 1.56em; font-weight: 640; letter-spacing: -.022em; }
.ca-local-rich-content h2 {
  font-size: 1.15em;
  padding-bottom: 0.22em;
  border-bottom: 0.5px solid var(--ca-line-subtle, var(--ca-line, #eceef2));
}
.ca-local-rich-content h3 { font-size: 1.03em; color: var(--ca-ink, #17191c); }
.ca-local-rich-content :is(h4, h5, h6) { font-size: 1em; }
.ca-local-rich-content :is(ol, ul) { padding-inline-start: 1.45em; margin: 0 0 0.65em; }
.ca-local-rich-content ul { list-style: disc; }
.ca-local-rich-content ol { list-style: decimal; }
.ca-local-rich-content li { margin-bottom: 0.3em; }
.ca-local-rich-content li > p { margin: 0; }
.ca-local-rich-content blockquote {
  margin-inline: 0;
  padding-inline-start: 0.85em;
  border-inline-start: 2px solid var(--ca-line, #d8dce3);
  color: var(--ca-muted, #575e68);
}
.ca-local-rich-content [data-resume-whitespace='preserve'] { white-space: pre-wrap; }
.ca-local-rich-content .selectedCell { background: var(--ca-hover, #f5f6f8); }
.ca-local-rich-content :is(td, th) { min-width: 2.5em; padding: 3px 8px; border: 0.5px solid var(--ca-line, #d8dce3); }
.ca-local-rich-source { padding: 18px 28px 128px; }
.ca-local-rich-source textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  min-height: 360px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.65;
}
.ca-local-rich-source > small { display: block; margin-bottom: 8px; color: var(--ca-muted, #575e68); }
.ca-editor-jump-pulse {
  position: absolute;
  pointer-events: none;
  z-index: 2;
  border-radius: 6px;
  background: color-mix(in srgb, var(--ca-blue, #315bd6) 13%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ca-blue, #315bd6) 36%, transparent);
  animation: ca-jump-fade 1250ms ease-out forwards;
}
@keyframes ca-jump-fade {
  0% { opacity: 0; transform: scale(.992); }
  14% { opacity: 1; transform: scale(1); }
  72% { opacity: .88; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ca-editor-jump-pulse { animation: none; opacity: .85; }
}
`

function RichEditor({
  text, onChange, disabled, ariaLabel, onEditorReady, showToolbar,
  playing, toolbarMeta, onSaveShortcut, onUserInteract, highlightLine,
}) {
  const mount = useRef(null)
  const scrollBox = useRef(null)
  const editor = useRef(null)
  const source = useRef(text)
  const composing = useRef(false)
  const current = useRef({ text, onChange, disabled, ariaLabel, onSaveShortcut, onUserInteract })
  const [active, setActive] = useState({})
  const [history, setHistory] = useState({ undo: false, redo: false })
  const [jumpBox, setJumpBox] = useState(null)
  current.current = { text, onChange, disabled, ariaLabel, onSaveShortcut, onUserInteract }

  useLayoutEffect(() => {
    const syncState = ({ editor: instance }) => {
      const next = Object.fromEntries(formatActions.map(action => [action.id, instance.isActive(action.activeName, action.attrs)]))
      setActive(previous => formatActions.every(action => previous[action.id] === next[action.id]) ? previous : next)
      const nextHistory = { undo: instance.can().undo(), redo: instance.can().redo() }
      setHistory(prev => prev.undo === nextHistory.undo && prev.redo === nextHistory.redo ? prev : nextHistory)
    }
    const input = current.current
    const normalizedInput = normalizeCjkBoldMarkdown(input.text)
    const instance = createResumeEditor({
      element: mount.current,
      text: normalizedInput,
      editable: !input.disabled,
      ariaLabel: input.ariaLabel,
      onUpdate(event) {
        syncState(event)
        const next = event.editor.getMarkdown()
        if (next === source.current || next === normalizeCjkBoldMarkdown(source.current)) return
        source.current = next
        current.current.onChange?.(next)
      },
      onSelectionUpdate: syncState,
    })
    const dom = instance.view.dom
    const onCompStart = () => { composing.current = true; current.current.onUserInteract?.() }
    const onCompEnd = () => { composing.current = false }
    const onKeyDown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        current.current.onSaveShortcut?.()
        return
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) current.current.onUserInteract?.()
    }
    const onPointerDown = () => current.current.onUserInteract?.()
    dom.addEventListener('compositionstart', onCompStart)
    dom.addEventListener('compositionend', onCompEnd)
    dom.addEventListener('keydown', onKeyDown)
    dom.addEventListener('pointerdown', onPointerDown)
    editor.current = instance
    source.current = input.text
    syncState({ editor: instance })
    return () => {
      dom.removeEventListener('compositionstart', onCompStart)
      dom.removeEventListener('compositionend', onCompEnd)
      dom.removeEventListener('keydown', onKeyDown)
      dom.removeEventListener('pointerdown', onPointerDown)
      editor.current = null
      instance.destroy()
    }
  }, [])

  useLayoutEffect(() => {
    const instance = editor.current
    if (!instance) return
    if (source.current !== text && !composing.current) {
      source.current = text
      instance.commands.setContent(normalizeCjkBoldMarkdown(text), { contentType: 'markdown', emitUpdate: false })
      setHistory({ undo: instance.can().undo(), redo: instance.can().redo() })
    }
    if (instance.isEditable === disabled) instance.setEditable(!disabled, false)
    instance.view.dom.setAttribute('aria-label', ariaLabel)
    instance.view.dom.setAttribute('aria-readonly', String(disabled))
  }, [text, disabled, ariaLabel])

  useLayoutEffect(() => {
    onEditorReady?.(editor.current)
    return () => onEditorReady?.(null)
  }, [onEditorReady])

  useEffect(() => {
    if (!highlightLine || !editor.current || !scrollBox.current) return
    const target = resolveRichEditorLine(editor.current, text, highlightLine.line)
    if (!target) return
    const el = target.startContainer.nodeType === 1 ? target.startContainer : target.startContainer.parentElement
    el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    const box = target.getBoundingClientRect()
    const host = scrollBox.current.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) {
      setJumpBox({
        key: highlightLine.token,
        left: Math.max(4, box.left - host.left - 6),
        top: Math.max(4, box.top - host.top - 3),
        width: box.width + 12,
        height: box.height + 6,
      })
      const timer = window.setTimeout(() => setJumpBox(curr => curr?.key === highlightLine.token ? null : curr), 1300)
      return () => window.clearTimeout(timer)
    }
  }, [highlightLine, text])

  function applyFormat(action) {
    const instance = editor.current
    if (!instance?.isEditable) return
    action.command(instance.chain().focus()).run()
    setActive(previous => ({ ...previous, [action.id]: instance.isActive(action.activeName, action.attrs) }))
    setHistory({ undo: instance.can().undo(), redo: instance.can().redo() })
  }

  function runHistory(kind) {
    const instance = editor.current
    if (!instance?.isEditable) return
    instance.chain().focus()[kind]().run()
    setHistory({ undo: instance.can().undo(), redo: instance.can().redo() })
  }

  const { t } = useI18n()

  return <div className="ca-local-rich-editor" data-playing={playing || undefined}>
    {showToolbar && <div className="ca-local-rich-toolbar" role="group" aria-label={t('editor.toolbarAria')}>
      <div className="ca-local-rich-toolbar-group">
        {formatActions.slice(0, 3).map(action => {
          const label = t(action.labelKey)
          return <button key={action.id} type="button"
            title={label} aria-label={label} aria-pressed={Boolean(active[action.id])}
            data-format={action.id} disabled={disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={() => applyFormat(action)}>{action.icon}</button>
        })}
      </div>
      <span className="ca-local-rich-sep" aria-hidden="true" />
      <div className="ca-local-rich-toolbar-group">
        {formatActions.slice(3, 5).map(action => {
          const label = t(action.labelKey)
          return <button key={action.id} type="button"
            title={label} aria-label={label} aria-pressed={Boolean(active[action.id])}
            data-format={action.id} disabled={disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={() => applyFormat(action)}>{action.icon}</button>
        })}
      </div>
      <span className="ca-local-rich-sep" aria-hidden="true" />
      <div className="ca-local-rich-toolbar-group">
        {formatActions.slice(5).map(action => {
          const label = t(action.labelKey)
          return <button key={action.id} type="button"
            title={label} aria-label={label} aria-pressed={Boolean(active[action.id])}
            data-format={action.id} disabled={disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={() => applyFormat(action)}>{action.icon}</button>
        })}
      </div>
      <span className="ca-local-rich-sep" aria-hidden="true" />
      <div className="ca-local-rich-toolbar-group">
        <button type="button" title={t('editor.undo')} aria-label={t('editor.undo')} disabled={disabled || !history.undo}
          onMouseDown={event => event.preventDefault()} onClick={() => runHistory('undo')}>↶</button>
        <button type="button" title={t('editor.redo')} aria-label={t('editor.redo')} disabled={disabled || !history.redo}
          onMouseDown={event => event.preventDefault()} onClick={() => runHistory('redo')}>↷</button>
      </div>
      {toolbarMeta && <div className="ca-local-rich-toolbar-meta">{toolbarMeta}</div>}
    </div>}
    <div className="ca-local-rich-scroll" ref={scrollBox}>
      {jumpBox && <div key={jumpBox.key} className="ca-editor-jump-pulse" aria-hidden="true"
        style={{ left: jumpBox.left, top: jumpBox.top, width: jumpBox.width, height: jumpBox.height }} />}
      <div ref={mount} />
    </div>
  </div>
}

export function LocalRichEditor({
  text = '', onChange, disabled = false, ariaLabel, onEditorReady, showToolbar = true,
  playing = false, toolbarMeta = null, onSaveShortcut, onUserInteract, highlightLine = null,
}) {
  const { t } = useI18n()
  const resolvedAria = ariaLabel || t('editor.ariaLabel')
  const editSource = useMemo(() => requiresMarkdownSource(text), [text])
  return <>
    <style>{editorStyles + directionStyles}</style>
    {editSource
      ? <div className="ca-local-rich-editor ca-local-rich-source" data-playing={playing || undefined}>
        <small>{t('editor.markdownSourceHint')}</small>
        <textarea rows={14} value={text} onChange={event => onChange?.(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              onSaveShortcut?.()
            }
          }}
          aria-label={resolvedAria} readOnly={disabled} />
      </div>
      : <RichEditor {...{
        text, onChange, disabled, ariaLabel: resolvedAria, onEditorReady, showToolbar,
        playing, toolbarMeta, onSaveShortcut, onUserInteract, highlightLine,
      }} />}
  </>
}
