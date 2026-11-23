import React from 'react'
import { parseMarkdownBlocks } from '../src/markdown-blocks.mjs'
import { useI18n } from './i18n.jsx'

export { parseMarkdownBlocks }

function safeHref(raw) {
  const url = String(raw || '').trim()
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url
  return ''
}

const INLINE_TOKEN_RE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*/gu

export function renderMarkdownInline(text, keyPrefix = 'in') {
  const src = String(text ?? '')
  if (!src) return null
  const out = []
  let last = 0
  let tokenIdx = 0
  for (const match of src.matchAll(INLINE_TOKEN_RE)) {
    if (match.index > last) out.push(src.slice(last, match.index))
    const key = `${keyPrefix}-${tokenIdx++}`
    if (match[1] != null) {
      out.push(<code key={key} className="ca-md-code">{match[1]}</code>)
    } else if (match[2] != null && match[3] != null) {
      const href = safeHref(match[3])
      if (href) {
        out.push(
          <a key={key} className="ca-md-link" href={href} target="_blank" rel="noopener noreferrer">
            {match[2]}
          </a>,
        )
      } else {
        out.push(match[2])
      }
    } else if (match[4] != null) {
      out.push(<strong key={key}><em>{match[4]}</em></strong>)
    } else if (match[5] != null || match[6] != null) {
      out.push(<strong key={key}>{match[5] ?? match[6]}</strong>)
    } else if (match[7] != null) {
      out.push(<del key={key}>{match[7]}</del>)
    } else if (match[8] != null) {
      out.push(<em key={key}>{match[8]}</em>)
    }
    last = match.index + match[0].length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function looksLikeResumeSnippet(lang, code) {
  if (!code || code.trim().length < 18) return false
  if (['markdown', 'md', 'resume', 'text', ''].includes(lang)) {
    return /(?:^|\n)\s*(?:##+\s+|[-*•]\s+)/u.test(code)
  }
  return false
}

function CodeFenceCard({ lang, code, onApplySnippet }) {
  const { t } = useI18n()
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef(null)
  React.useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {}
  }

  const canApply = typeof onApplySnippet === 'function' && looksLikeResumeSnippet(lang, code)
  const label = lang === 'markdown' || lang === 'md'
    ? t('markdown.resumeSnippet')
    : (lang || t('markdown.referenceSnippet'))

  return (
    <div className="ca-md-fence">
      <div className="ca-md-fence-head">
        <span className="ca-md-fence-lang">{label}</span>
        <div className="ca-md-fence-actions">
          {canApply && (
            <button type="button" className="ca-md-fence-apply" onClick={() => onApplySnippet(code)}>
              {t('markdown.applyToResume')}
            </button>
          )}
          <button type="button" className="ca-md-fence-copy" onClick={() => void copy()}>
            {copied ? t('common.copiedTick') : t('common.copy')}
          </button>
        </div>
      </div>
      <pre className="ca-md-pre"><code>{code}</code></pre>
    </div>
  )
}

export default function MarkdownProse({ text, streaming = false, onApplySnippet, className = '' }) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(text), [text])
  if (!blocks.length) return null

  return (
    <div className={`ca-md-prose${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}>
      {blocks.map((block, idx) => {
        const isLast = idx === blocks.length - 1
        const caret = streaming && isLast ? <span className="ca-ai-caret" aria-hidden="true" /> : null

        if (block.type === 'heading') {
          const Tag = block.level <= 2 ? 'h3' : 'h4'
          return (
            <Tag key={idx} className={`ca-md-h ca-md-h${Math.min(4, Math.max(2, block.level))}`}>
              {renderMarkdownInline(block.text, `h-${idx}`)}
              {caret}
            </Tag>
          )
        }

        if (block.type === 'hr') {
          return <hr key={idx} className="ca-md-hr" />
        }

        if (block.type === 'code') {
          return (
            <CodeFenceCard
              key={idx}
              lang={block.lang}
              code={block.code}
              onApplySnippet={streaming ? undefined : onApplySnippet}
            />
          )
        }

        if (block.type === 'table') {
          return (
            <div key={idx} className="ca-md-table-wrap">
              <table className="ca-md-table">
                <thead>
                  <tr>
                    {block.headers.map((cell, cIdx) => (
                      <th key={cIdx} style={{ textAlign: block.alignments[cIdx] || 'left' }}>
                        {renderMarkdownInline(cell, `th-${idx}-${cIdx}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {block.headers.map((_, cIdx) => (
                        <td key={cIdx} style={{ textAlign: block.alignments[cIdx] || 'left' }}>
                          {renderMarkdownInline(row[cIdx] ?? '', `td-${idx}-${rIdx}-${cIdx}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        if (block.type === 'blockquote') {
          return (
            <blockquote key={idx} className="ca-md-quote">
              {block.lines.map((line, lIdx) => (
                <p key={lIdx}>
                  {renderMarkdownInline(line, `q-${idx}-${lIdx}`)}
                  {lIdx === block.lines.length - 1 ? caret : null}
                </p>
              ))}
            </blockquote>
          )
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={idx} className={`ca-md-list${block.ordered ? ' is-ordered' : ''}`}>
              {block.items.map((item, iIdx) => {
                const isLastItem = isLast && iIdx === block.items.length - 1
                return (
                  <li key={iIdx}>
                    <span>
                      {renderMarkdownInline(item.text, `li-${idx}-${iIdx}`)}
                      {isLastItem && item.children.length === 0 ? caret : null}
                    </span>
                    {item.children.length > 0 && (
                      <ul className="ca-md-sublist">
                        {item.children.map((sub, sIdx) => (
                          <li key={sIdx}>
                            {renderMarkdownInline(sub.text, `sub-${idx}-${iIdx}-${sIdx}`)}
                            {isLastItem && sIdx === item.children.length - 1 ? caret : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ListTag>
          )
        }

        // Paragraph (respect explicit soft newlines cleanly)
        const paraLines = block.text.split('\n')
        return (
          <p key={idx} className="ca-md-p">
            {paraLines.map((line, lIdx) => (
              <React.Fragment key={lIdx}>
                {lIdx > 0 && <br />}
                {renderMarkdownInline(line, `p-${idx}-${lIdx}`)}
              </React.Fragment>
            ))}
            {caret}
          </p>
        )
      })}
    </div>
  )
}
