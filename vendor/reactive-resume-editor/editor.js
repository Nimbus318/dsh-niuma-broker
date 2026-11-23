import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { Lexer } from 'marked'
import { richTextExtensions } from './upstream/rich-text-extensions'
import { cleanPastedHtml } from './upstream/pasted-html'
import { hasUnsupportedTableMarkup, toPreviewHtml } from './upstream/rich-text-markup'
import directionStyles from './upstream/content-direction.css'

export { directionStyles }

// Keep hard line breaks significant for resumes written as consecutive Markdown lines.
const markedOptions = { gfm: true, breaks: true }
const markdown = Markdown.configure({ markedOptions })

function hasUnsupportedToken(tokens = []) {
  return tokens.some(token => {
    if (token.type === 'code' || token.type === 'image') return true
    if (token.type === 'html' && !/^<\/?u>$/i.test(token.raw)) return true
    return hasUnsupportedToken(token.tokens) ||
      hasUnsupportedToken(token.items) ||
      (token.type === 'table' && token.rows.concat([token.header]).some(row =>
        row.some(cell => hasUnsupportedToken(cell.tokens))))
  })
}

export function requiresMarkdownSource(text) {
  if (text.length > 200_000) return true
  const tokens = new Lexer(markedOptions).lex(text)
  return Object.keys(tokens.links).length > 0 || hasUnsupportedToken(tokens)
}

export function createResumeEditor({ element, text, editable, ariaLabel, onUpdate, onSelectionUpdate }) {
  return new Editor({
    element,
    editable,
    extensions: [...richTextExtensions, markdown],
    content: text,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        class: 'ca-local-rich-content',
        spellcheck: 'true',
      },
      transformPastedHTML(pasted) {
        const cleaned = cleanPastedHtml(pasted)
        return hasUnsupportedTableMarkup(cleaned) ? toPreviewHtml(cleaned) : cleaned
      },
    },
    onUpdate,
    onSelectionUpdate,
  })
}
