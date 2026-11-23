const textBlocks = 'p,h1,h2,h3,h4,h5,h6'
const lineMaps = new WeakMap()

function visibleTextKey(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

function markdownLineKey(editor, line) {
  const text = []
  function visit(node) {
    if (node.text) text.push(node.text)
    node.content?.forEach(visit)
  }
  visit(editor.markdown.parse(line))
  return visibleTextKey(text.join(''))
}

function collectRenderedLines(block, add) {
  const document = block.ownerDocument
  const walker = document.createTreeWalker(block, 5) // SHOW_ELEMENT | SHOW_TEXT
  let start = [block, 0]

  function finish(end, nextStart = end) {
    const range = document.createRange()
    range.setStart(...start)
    range.setEnd(...end)
    const key = visibleTextKey(range.toString())
    if (key) add(key, range)
    start = nextStart
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') {
      const parent = node.parentNode
      const offset = Array.prototype.indexOf.call(parent.childNodes, node)
      finish([parent, offset], [parent, offset + 1])
    }
    if (node.nodeType !== 3) continue
    for (const { index } of node.data.matchAll(/\n/gu)) finish([node, index], [node, index + 1])
  }
  finish([block, block.childNodes.length])
}

function collectLineMap(editor, source) {
  const sourceByKey = new Map()
  const renderedByKey = new Map()
  const append = (map, key, entry) => {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(entry)
  }
  const decodedLines = new Map()

  for (const [line, raw] of source.split(/\r?\n/u).entries()) {
    if (!raw.trim()) continue
    if (!decodedLines.has(raw)) decodedLines.set(raw, markdownLineKey(editor, raw))
    const key = decodedLines.get(raw)
    if (key) append(sourceByKey, key, line)
  }

  for (const block of editor.view.dom.querySelectorAll(textBlocks)) {
    collectRenderedLines(block, (key, range) => append(renderedByKey, key, range))
  }

  const ranges = new Map()
  for (const [key, sourceLines] of sourceByKey) {
    const rendered = renderedByKey.get(key)
    if (rendered?.length !== sourceLines.length) continue
    sourceLines.forEach((line, occurrence) => ranges.set(line, rendered[occurrence]))
  }
  return ranges
}

/** Resolve an exact Markdown source line against the current local editor's rendered document. */
export function resolveRichEditorLine(editor, source, line) {
  if (!editor || editor.isDestroyed || !Number.isInteger(line) || line < 0) return null
  const document = editor.state.doc
  const cached = lineMaps.get(editor)
  if (cached?.document !== document || cached.source !== source) {
    lineMaps.set(editor, { document, source, ranges: collectLineMap(editor, source) })
  }
  return lineMaps.get(editor).ranges.get(line) ?? null
}
