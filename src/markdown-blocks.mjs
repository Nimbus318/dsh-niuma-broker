/**
 * Pure, zero-dependency, streaming-aware Markdown block parser.
 * Supports headings (#..####), GFM tables, fenced code blocks (closed & unclosed),
 * blockquotes (> ...), nested ordered/unordered lists, horizontal rules, and paragraphs.
 */

function isTableSeparator(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = stripped.split('|').map(c => c.trim())
  return cells.length >= 2 && cells.every(c => /^:?-{2,}:?$/.test(c))
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*$/u
const HR_RE = /^(?:[-*_]\s*){3,}$/u
const FENCE_RE = /^```([\w.+-]*)\s*$/u
const QUOTE_RE = /^>\s?(.*)$/u
const UL_RE = /^(\s*)(?:[-*+•▪])\s+(.+)$/u
const OL_RE = /^(\s*)(\d+)[.)、]\s+(.+)$/u

export function parseMarkdownBlocks(rawText) {
  const text = String(rawText ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  const lines = text.split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    const fenceMatch = FENCE_RE.exec(trimmed)
    if (fenceMatch) {
      const lang = (fenceMatch[1] || '').toLowerCase()
      const codeLines = []
      i += 1
      let closed = false
      while (i < lines.length) {
        if (/^```\s*$/u.test(lines[i].trim())) {
          closed = true
          i += 1
          break
        }
        codeLines.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang, code: codeLines.join('\n'), closed })
      continue
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    const headingMatch = HEADING_RE.exec(trimmed)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() })
      i += 1
      continue
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(raw)
      const alignments = parseTableAlignments(lines[i + 1])
      i += 2
      const rows = []
      while (i < lines.length) {
        const rowRaw = lines[i]
        const rowTrim = rowRaw.trim()
        if (!rowTrim || !rowTrim.includes('|')) break
        if (HEADING_RE.test(rowTrim) || FENCE_RE.test(rowTrim) || QUOTE_RE.test(rowTrim)) break
        rows.push(splitTableRow(rowRaw))
        i += 1
      }
      blocks.push({ type: 'table', headers, alignments, rows })
      continue
    }

    if (QUOTE_RE.test(trimmed)) {
      const quoteLines = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i].trim())
        if (!m) break
        quoteLines.push(m[1])
        i += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    const ulFirst = UL_RE.exec(raw)
    const olFirst = !ulFirst ? OL_RE.exec(raw) : null
    if (ulFirst || olFirst) {
      const ordered = Boolean(olFirst)
      const baseIndent = (ulFirst ? ulFirst[1] : olFirst[1]).length
      const items = []
      while (i < lines.length) {
        const cur = lines[i]
        if (!cur.trim()) {
          const next = lines[i + 1]
          if (next && (UL_RE.test(next) || OL_RE.test(next))) {
            i += 1
            continue
          }
          break
        }
        const mUl = UL_RE.exec(cur)
        const mOl = !mUl ? OL_RE.exec(cur) : null
        if (!mUl && !mOl) {
          if (/^\s{2,}\S/.test(cur) && items.length > 0) {
            const last = items[items.length - 1]
            if (last.children.length > 0) {
              last.children[last.children.length - 1].text += ` ${cur.trim()}`
            } else {
              last.text += ` ${cur.trim()}`
            }
            i += 1
            continue
          }
          break
        }
        const indent = (mUl ? mUl[1] : mOl[1]).length
        const itemText = (mUl ? mUl[2] : mOl[3]).trim()
        const isSub = indent >= baseIndent + 2 && items.length > 0
        if (isSub) {
          items[items.length - 1].children.push({ text: itemText, ordered: Boolean(mOl) })
          i += 1
          continue
        }
        if (Boolean(mOl) !== ordered) break
        items.push({ text: itemText, index: mOl ? Number(mOl[2]) : null, children: [] })
        i += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paraLines = [trimmed]
    i += 1
    while (i < lines.length) {
      const nextRaw = lines[i]
      const nextTrim = nextRaw.trim()
      if (!nextTrim) break
      if (
        FENCE_RE.test(nextTrim)
        || HR_RE.test(nextTrim)
        || HEADING_RE.test(nextTrim)
        || QUOTE_RE.test(nextTrim)
        || UL_RE.test(nextRaw)
        || OL_RE.test(nextRaw)
        || (nextTrim.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break
      }
      paraLines.push(nextTrim)
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
  }

  return blocks
}
