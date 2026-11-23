let mammothCorePromise = null

async function loadMammothCore() {
  if (!mammothCorePromise) {
    mammothCorePromise = import('./vendor/mammoth-core.mjs')
  }
  return mammothCorePromise
}

const REL_OFFICE_DOC = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]
const REL_STYLES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/styles',
]
const REL_NUMBERING = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/numbering',
]
const REL_SETTINGS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/settings',
]

// Matches Mammoth's Transitional + Strict OOXML map and adds DrawingML shape namespaces
// so modern Word text boxes (<mc:Choice><w:drawing>...<wps:txbx><w:txbxContent>) are preserved.
const XML_NAMESPACE_MAP = Object.freeze({
  // Transitional OOXML
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',

  // Strict OOXML (ISO/IEC 29500 Strict)
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',

  // Common OPC & Markup Compatibility & VML
  'http://schemas.openxmlformats.org/package/2006/content-types': 'content-types',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'relationships',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:word': 'office-word',

  // MS-DOCX Word 2010+ extensions (checkboxes + DrawingML text boxes / shapes)
  'http://schemas.microsoft.com/office/word/2010/wordml': 'wordml',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas': 'wpc',
})

// OOXML ECMA-376 §17.7.6 table conditional formatting precedence order (lowest to highest)
const TBL_STYLE_COND_ORDER = [
  'band1Vert',
  'band2Vert',
  'band1Horz',
  'band2Horz',
  'firstCol',
  'lastCol',
  'firstRow',
  'lastRow',
  'nwCell',
  'neCell',
  'swCell',
  'seCell',
]

const VALID_TBL_STYLE_CONDS = new Set(TBL_STYLE_COND_ORDER)

export const DOCX_VISIBILITY_WARNING_ZH = '检测到该 Word 文档含随分页变化的页眉/页脚或复杂条件隐藏样式，已仅保留本地文本供你核对且未发送给 AI；如需完整按排版识别，建议先在 Word 中导出为文字版 PDF 再导入。'

function readOnOff(element) {
  if (!element) return undefined
  const val = element.attributes?.['w:val']
  if (val === undefined || val === '') return true
  const low = String(val).trim().toLowerCase()
  return low !== '0' && low !== 'false' && low !== 'off'
}

function readAttrOnOff(val) {
  if (val === undefined || val === null || val === '') return undefined
  const low = String(val).trim().toLowerCase()
  return low !== '0' && low !== 'false' && low !== 'off'
}

function stripUtf8Bom(str) {
  return String(str || '').replace(/^\uFEFF/g, '')
}

function normalizeZipPath(baseDir, target) {
  if (!target) return ''
  const raw = String(target).replace(/\\/g, '/')
  const combined = raw.startsWith('/')
    ? raw.slice(1)
    : (baseDir ? `${baseDir}/${raw}` : raw)
  const out = []
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function relationshipsFilename(zipfile, filename) {
  const split = zipfile.splitPath(filename)
  return zipfile.joinPath(split.dirname, '_rels', `${split.basename}.rels`)
}

function parseRawRelationships(xmlEl) {
  const byId = Object.create(null)
  const byType = Object.create(null)
  if (!xmlEl) return { byId, byType }
  for (const child of xmlEl.children || []) {
    if (child.name !== 'relationships:Relationship') continue
    const id = child.attributes?.Id
    const target = child.attributes?.Target
    const type = child.attributes?.Type
    const mode = String(child.attributes?.TargetMode || '').toLowerCase()
    const rec = { id, target, type, isExternal: mode === 'external' }
    if (id && !byId[id]) byId[id] = rec
    if (type) {
      if (!byType[type]) byType[type] = []
      byType[type].push(rec)
    }
  }
  return { byId, byType }
}

function findPartPath(docxFile, rels, types, baseDir, fallbackPath) {
  for (const type of types) {
    for (const rec of rels.byType[type] || []) {
      if (rec.isExternal || !rec.target) continue
      const candidate = normalizeZipPath(baseDir, rec.target)
      if (candidate && docxFile.exists(candidate)) return candidate
    }
  }
  return fallbackPath
}

function collectTxbxContents(node, out = []) {
  if (!node || node.type !== 'element') return out
  if (node.name === 'w:txbxContent') {
    out.push(node)
    return out
  }
  for (const child of node.children || []) {
    collectTxbxContents(child, out)
  }
  return out
}

function hasReadableWordContent(nodes) {
  for (const node of nodes || []) {
    if (!node || node.type !== 'element') continue
    if (
      node.name === 'w:txbxContent'
      || node.name === 'w:p'
      || node.name === 'w:r'
      || node.name === 'w:tbl'
      || node.name === 'w:t'
      || node.name === 'w:sdt'
      || node.name === 'w:hyperlink'
    ) {
      return true
    }
    if (hasReadableWordContent(node.children)) return true
  }
  return false
}

/**
 * Normalizes parsed OOXML elements before hidden-run filtering and Mammoth body reading:
 * 1. Hoists modern DrawingML text boxes (<w:drawing>...<wps:txbx><w:txbxContent>) so Mammoth reads them.
 * 2. In <mc:AlternateContent>, prefers <mc:Choice> when it contains readable Word content (such as modern
 *    DrawingML text boxes), falling back to <mc:Fallback> only when no <mc:Choice> provides readable content.
 */
function normalizeOfficeXml(node, Element) {
  if (!node || node.type !== 'element') return [node]

  if (node.name === 'mc:AlternateContent') {
    const choices = (node.children || []).filter(c => c.type === 'element' && c.name === 'mc:Choice')
    for (const choice of choices) {
      const normalizedChoice = (choice.children || []).flatMap(c => normalizeOfficeXml(c, Element))
      if (hasReadableWordContent(normalizedChoice)) {
        return normalizedChoice
      }
    }
    const fallback = (node.children || []).find(c => c.type === 'element' && c.name === 'mc:Fallback')
    if (fallback) {
      return (fallback.children || []).flatMap(c => normalizeOfficeXml(c, Element))
    }
    return []
  }

  const nextChildren = (node.children || []).flatMap(c => normalizeOfficeXml(c, Element))

  if (node.name === 'w:drawing') {
    const txbxList = []
    for (const child of nextChildren) {
      collectTxbxContents(child, txbxList)
    }
    if (txbxList.length > 0) {
      return txbxList
    }
  }

  return [new Element(node.name, node.attributes, nextChildren)]
}

async function readOfficeXmlPart(core, docxFile, path) {
  if (!path || !docxFile.exists(path)) return null
  const raw = await core.promises.toExternalPromise(docxFile.read(path, 'utf-8'))
  const doc = await core.promises.toExternalPromise(core.xml.readString(stripUtf8Bom(raw), XML_NAMESPACE_MAP))
  const normalized = normalizeOfficeXml(doc, core.xmlNodes.Element)
  return normalized[0] || null
}

function parseStyleVisibilityInfo(stylesXml) {
  const docDefaults = { vanish: false, webHidden: false }
  const paragraphStyles = Object.create(null)
  const characterStyles = Object.create(null)
  const tableStyles = Object.create(null)
  let defaultParagraphStyleId = null
  let defaultTableStyleId = null

  if (!stylesXml) {
    return { docDefaults, paragraphStyles, characterStyles, tableStyles, defaultParagraphStyleId, defaultTableStyleId }
  }

  const rPrDefault = stylesXml.first('w:docDefaults')?.first('w:rPrDefault')?.first('w:rPr')
  if (rPrDefault) {
    docDefaults.vanish = readOnOff(rPrDefault.first('w:vanish')) ?? false
    docDefaults.webHidden = readOnOff(rPrDefault.first('w:webHidden')) ?? false
  }

  for (const styleEl of stylesXml.getElementsByTagName('w:style')) {
    const type = styleEl.attributes?.['w:type']
    const styleId = styleEl.attributes?.['w:styleId']
    if (!styleId) continue
    const targetMap = type === 'paragraph'
      ? paragraphStyles
      : type === 'character'
        ? characterStyles
        : type === 'table'
          ? tableStyles
          : null
    if (!targetMap || targetMap[styleId] !== undefined) continue

    const rPr = styleEl.first('w:rPr')
    const basedOn = styleEl.first('w:basedOn')?.attributes?.['w:val'] || null
    const entry = {
      basedOn,
      vanish: rPr ? readOnOff(rPr.first('w:vanish')) : undefined,
      webHidden: rPr ? readOnOff(rPr.first('w:webHidden')) : undefined,
    }

    if (type === 'table') {
      const tblPr = styleEl.first('w:tblPr')
      const rowBandRaw = Number.parseInt(tblPr?.first('w:tblStyleRowBandSize')?.attributes?.['w:val'] || '', 10)
      const colBandRaw = Number.parseInt(tblPr?.first('w:tblStyleColBandSize')?.attributes?.['w:val'] || '', 10)
      entry.rowBandSize = Number.isFinite(rowBandRaw) && rowBandRaw > 0 ? rowBandRaw : undefined
      entry.colBandSize = Number.isFinite(colBandRaw) && colBandRaw > 0 ? colBandRaw : undefined
      entry.tblLook = parseTblLookEl(tblPr?.first('w:tblLook'))
      entry.condPr = Object.create(null)
      for (const child of styleEl.children || []) {
        if (child.type !== 'element' || child.name !== 'w:tblStylePr') continue
        const condType = child.attributes?.['w:type']
        const condRPr = child.first('w:rPr')
        if (!condType || !condRPr) continue
        const vanish = readOnOff(condRPr.first('w:vanish'))
        const webHidden = readOnOff(condRPr.first('w:webHidden'))
        if (vanish !== undefined || webHidden !== undefined) {
          entry.condPr[condType] = { vanish, webHidden }
        }
      }
    }

    targetMap[styleId] = entry
    if (type === 'paragraph' && !defaultParagraphStyleId && readAttrOnOff(styleEl.attributes?.['w:default']) === true) {
      defaultParagraphStyleId = styleId
    } else if (type === 'table' && !defaultTableStyleId && readAttrOnOff(styleEl.attributes?.['w:default']) === true) {
      defaultTableStyleId = styleId
    }
  }

  return { docDefaults, paragraphStyles, characterStyles, tableStyles, defaultParagraphStyleId, defaultTableStyleId }
}

function getStyleChain(styleMap, styleId) {
  if (!styleId || !styleMap[styleId]) return []
  const chain = []
  const visited = new Set()
  let cur = styleId
  while (cur && styleMap[cur] && !visited.has(cur)) {
    visited.add(cur)
    chain.push(styleMap[cur])
    cur = styleMap[cur].basedOn
  }
  return chain.reverse() // root -> leaf
}

function resolveStyleChainProp(styleMap, styleId, prop) {
  let resolved
  for (const style of getStyleChain(styleMap, styleId)) {
    if (style[prop] !== undefined) resolved = style[prop]
  }
  return resolved
}

function resolveTableStyleConditionalInfo(tableStyles, tblStyleId) {
  const chain = getStyleChain(tableStyles, tblStyleId)
  const condPr = Object.create(null)
  let rowBandSize = 1
  let colBandSize = 1
  let inheritedTblLook = null
  let hasConditionalVisibility = false
  let hasUnknownCondType = false

  for (const style of chain) {
    if (style.rowBandSize !== undefined) rowBandSize = style.rowBandSize
    if (style.colBandSize !== undefined) colBandSize = style.colBandSize
    if (style.tblLook) inheritedTblLook = style.tblLook
    for (const [condType, vals] of Object.entries(style.condPr || {})) {
      if (!VALID_TBL_STYLE_CONDS.has(condType)) hasUnknownCondType = true
      if (vals.vanish === true || vals.webHidden === true) hasConditionalVisibility = true
      condPr[condType] = {
        vanish: vals.vanish !== undefined ? vals.vanish : condPr[condType]?.vanish,
        webHidden: vals.webHidden !== undefined ? vals.webHidden : condPr[condType]?.webHidden,
      }
    }
  }

  return { condPr, rowBandSize, colBandSize, inheritedTblLook, hasConditionalVisibility, hasUnknownCondType }
}

// Per ECMA-376 §17.4.56 (CT_TblLook), noHBand and noVBand are negative suppression flags whose default is false
// (meaning row/column banding applies by default when <w:tblLook> is omitted).
const DEFAULT_TBL_LOOK = Object.freeze({
  firstRow: false,
  lastRow: false,
  firstColumn: false,
  lastColumn: false,
  noHBand: false,
  noVBand: false,
})

function parseTblLookEl(lookEl) {
  if (!lookEl) return null
  const attrs = lookEl.attributes || {}
  const mask = attrs['w:val'] ? Number.parseInt(attrs['w:val'], 16) : 0
  const safeMask = Number.isFinite(mask) ? mask : 0
  const pick = (attrName, bit) => {
    const explicit = readAttrOnOff(attrs[attrName])
    return explicit !== undefined ? explicit : Boolean(safeMask & bit)
  }
  return {
    firstRow: pick('w:firstRow', 0x0020),
    lastRow: pick('w:lastRow', 0x0040),
    firstColumn: pick('w:firstColumn', 0x0080),
    lastColumn: pick('w:lastColumn', 0x0100),
    noHBand: pick('w:noHBand', 0x0200),
    noVBand: pick('w:noVBand', 0x0400),
  }
}

function parseCnfStyle(prEl) {
  const cnfEl = prEl?.first('w:cnfStyle')
  if (!cnfEl) return null
  const attrs = cnfEl.attributes || {}
  const bits = typeof attrs['w:val'] === 'string' && /^[01]{12}$/.test(attrs['w:val']) ? attrs['w:val'] : null
  const pick = (attrName, bitIdx) => {
    const explicit = readAttrOnOff(attrs[attrName])
    if (explicit !== undefined) return explicit
    return bits ? bits[bitIdx] === '1' : false
  }
  return {
    firstRow: pick('w:firstRow', 0),
    lastRow: pick('w:lastRow', 1),
    firstCol: pick('w:firstColumn', 2),
    lastCol: pick('w:lastColumn', 3),
    band1Vert: pick('w:oddVBand', 4),
    band2Vert: pick('w:evenVBand', 5),
    band1Horz: pick('w:oddHBand', 6),
    band2Horz: pick('w:evenHBand', 7),
    neCell: pick('w:firstRowLastColumn', 8),
    nwCell: pick('w:firstRowFirstColumn', 9),
    seCell: pick('w:lastRowLastColumn', 10),
    swCell: pick('w:lastRowFirstColumn', 11),
  }
}

function computeCellConditions({ tblLook, rowIdx, rowCount, colIdx, colCount, rowBandSize, colBandSize, rowCnf, cellCnf }) {
  const active = new Set()

  const isFirstRow = cellCnf ? cellCnf.firstRow : (rowCnf ? rowCnf.firstRow : (tblLook.firstRow && rowIdx === 0))
  const isLastRow = cellCnf ? cellCnf.lastRow : (rowCnf ? rowCnf.lastRow : (tblLook.lastRow && rowIdx === rowCount - 1))
  const isFirstCol = cellCnf ? cellCnf.firstCol : (tblLook.firstColumn && colIdx === 0)
  const isLastCol = cellCnf ? cellCnf.lastCol : (tblLook.lastColumn && colIdx === colCount - 1)

  if (isFirstRow) active.add('firstRow')
  if (isLastRow) active.add('lastRow')
  if (isFirstCol) active.add('firstCol')
  if (isLastCol) active.add('lastCol')

  if (cellCnf?.nwCell || (isFirstRow && isFirstCol)) active.add('nwCell')
  if (cellCnf?.neCell || (isFirstRow && isLastCol)) active.add('neCell')
  if (cellCnf?.swCell || (isLastRow && isFirstCol)) active.add('swCell')
  if (cellCnf?.seCell || (isLastRow && isLastCol)) active.add('seCell')

  if (cellCnf?.band1Horz || rowCnf?.band1Horz) {
    active.add('band1Horz')
  } else if (cellCnf?.band2Horz || rowCnf?.band2Horz) {
    active.add('band2Horz')
  } else if (!tblLook.noHBand && !isFirstRow && !isLastRow) {
    const dataRowIdx = rowIdx - (tblLook.firstRow ? 1 : 0)
    const band = Math.floor(Math.max(0, dataRowIdx) / Math.max(1, rowBandSize))
    active.add(band % 2 === 0 ? 'band1Horz' : 'band2Horz')
  }

  if (cellCnf?.band1Vert) {
    active.add('band1Vert')
  } else if (cellCnf?.band2Vert) {
    active.add('band2Vert')
  } else if (!tblLook.noVBand && !isFirstCol && !isLastCol) {
    const dataColIdx = colIdx - (tblLook.firstColumn ? 1 : 0)
    const band = Math.floor(Math.max(0, dataColIdx) / Math.max(1, colBandSize))
    active.add(band % 2 === 0 ? 'band1Vert' : 'band2Vert')
  }

  return active
}

const TABLE_TRANSPARENT_WRAPPERS = new Set(['w:sdt', 'w:sdtContent', 'w:customXml', 'w:ins', 'w:moveTo', 'w:smartTag'])

function collectTableTargets(children, targetName, out = []) {
  for (const child of children || []) {
    if (!child || child.type !== 'element') continue
    if (child.name === targetName) {
      out.push(child)
    } else if (TABLE_TRANSPARENT_WRAPPERS.has(child.name)) {
      collectTableTargets(child.children, targetName, out)
    }
  }
  return out
}

function mapTableChildren(children, targetName, Element, onTarget, onOther) {
  const out = []
  for (const child of children || []) {
    if (!child || child.type !== 'element') {
      out.push(child)
      continue
    }
    if (child.name === targetName) {
      const mapped = onTarget(child)
      if (mapped !== null) out.push(mapped)
    } else if (TABLE_TRANSPARENT_WRAPPERS.has(child.name)) {
      const nextKids = mapTableChildren(child.children, targetName, Element, onTarget, onOther)
      out.push(new Element(child.name, child.attributes, nextKids))
    } else {
      const mapped = onOther(child)
      if (mapped !== null) out.push(mapped)
    }
  }
  return out
}

function tableHasMergedCells(tblEl) {
  for (const row of collectTableTargets(tblEl.children, 'w:tr')) {
    for (const cell of collectTableTargets(row.children, 'w:tc')) {
      const tcPr = cell.first('w:tcPr')
      if (!tcPr) continue
      const span = Number.parseInt(tcPr.first('w:gridSpan')?.attributes?.['w:val'] || '1', 10)
      if (span > 1 || tcPr.first('w:vMerge')) return true
    }
  }
  return false
}

function isRunHidden(runEl, ctx, styleInfo) {
  const rPr = runEl.first('w:rPr')
  const rStyleId = rPr?.first('w:rStyle')?.attributes?.['w:val'] || null
  const effectiveParaStyleId = ctx.paraStyleId || styleInfo.defaultParagraphStyleId

  const resolveProp = (prop) => {
    let state = styleInfo.docDefaults[prop]
    const tVal = resolveStyleChainProp(styleInfo.tableStyles, ctx.tblStyleId, prop)
    if (tVal !== undefined) state = tVal
    if (ctx.tblCondPr && ctx.cellConditions) {
      for (const condType of TBL_STYLE_COND_ORDER) {
        if (!ctx.cellConditions.has(condType)) continue
        const cVal = ctx.tblCondPr[condType]?.[prop]
        if (cVal !== undefined) state = cVal
      }
    }
    const pVal = resolveStyleChainProp(styleInfo.paragraphStyles, effectiveParaStyleId, prop)
    if (pVal !== undefined) state = pVal
    const cVal = resolveStyleChainProp(styleInfo.characterStyles, rStyleId, prop)
    if (cVal !== undefined) state = cVal
    const directVal = rPr ? readOnOff(rPr.first(`w:${prop}`)) : undefined
    if (directVal !== undefined) state = directVal
    return state
  }

  return resolveProp('vanish') || resolveProp('webHidden')
}

function stripHiddenRuns(node, styleInfo, Element, state, ctx = { paraStyleId: null, tblStyleId: null, tblCondPr: null, cellConditions: null }) {
  if (!node || node.type !== 'element') return node

  if (node.name === 'w:tbl') {
    const tblPr = node.first('w:tblPr')
    const tblStyleId = tblPr?.first('w:tblStyle')?.attributes?.['w:val'] || styleInfo.defaultTableStyleId || null
    const condInfo = resolveTableStyleConditionalInfo(styleInfo.tableStyles, tblStyleId)
    const tblLook = parseTblLookEl(tblPr?.first('w:tblLook')) ?? condInfo.inheritedTblLook ?? DEFAULT_TBL_LOOK
    if (condInfo.hasConditionalVisibility) {
      state.visibilityUncertain = true
      state.reasons.add(
        (condInfo.hasUnknownCondType || tableHasMergedCells(node))
          ? 'complex-table-style-visibility'
          : 'conditional-table-style-visibility',
      )
    }
    const rows = collectTableTargets(node.children, 'w:tr')
    const rowCount = rows.length
    let rowIdx = 0

    const nextChildren = mapTableChildren(
      node.children,
      'w:tr',
      Element,
      (rowEl) => {
        const curRowIdx = rowIdx
        rowIdx += 1
        const rowCnf = parseCnfStyle(rowEl.first('w:trPr'))
        const cells = collectTableTargets(rowEl.children, 'w:tc')
        const colCount = cells.length
        let colIdx = 0

        const nextRowChildren = mapTableChildren(
          rowEl.children,
          'w:tc',
          Element,
          (cellEl) => {
            const curColIdx = colIdx
            colIdx += 1
            const cellCnf = parseCnfStyle(cellEl.first('w:tcPr'))
            const cellConditions = computeCellConditions({
              tblLook,
              rowIdx: curRowIdx,
              rowCount,
              colIdx: curColIdx,
              colCount,
              rowBandSize: condInfo.rowBandSize,
              colBandSize: condInfo.colBandSize,
              rowCnf,
              cellCnf,
            })
            return stripHiddenRuns(cellEl, styleInfo, Element, state, {
              paraStyleId: null,
              tblStyleId,
              tblCondPr: condInfo.condPr,
              cellConditions,
            })
          },
          otherRowChild => stripHiddenRuns(otherRowChild, styleInfo, Element, state, {
            paraStyleId: null,
            tblStyleId,
            tblCondPr: condInfo.condPr,
            cellConditions: null,
          }),
        )
        return new Element(rowEl.name, rowEl.attributes, nextRowChildren)
      },
      otherChild => stripHiddenRuns(otherChild, styleInfo, Element, state, {
        paraStyleId: null,
        tblStyleId,
        tblCondPr: condInfo.condPr,
        cellConditions: null,
      }),
    )

    return new Element(node.name, node.attributes, nextChildren)
  }

  let nextCtx = ctx
  if (node.name === 'w:p') {
    // Direct <w:pPr><w:rPr><w:vanish/> hides only the paragraph mark glyph (e.g. Word style separators),
    // NOT visible runs inside the paragraph. Paragraph styles from styles.xml do propagate to runs.
    nextCtx = { ...ctx, paraStyleId: node.first('w:pPr')?.first('w:pStyle')?.attributes?.['w:val'] || null }
  } else if (node.name === 'w:r') {
    if (isRunHidden(node, ctx, styleInfo)) {
      const fldChars = (node.children || []).filter(c => c.type === 'element' && c.name === 'w:fldChar')
      if (fldChars.length === 0) return null
      const kept = (node.children || []).filter(c => c.type === 'element' && (c.name === 'w:rPr' || c.name === 'w:fldChar'))
      return new Element(node.name, node.attributes, kept)
    }
  }

  let strippedHiddenChild = false
  const nextChildren = []
  for (const child of node.children || []) {
    const filtered = stripHiddenRuns(child, styleInfo, Element, state, nextCtx)
    if (filtered === null) {
      strippedHiddenChild = true
      continue
    }
    nextChildren.push(filtered)
  }

  if (node.name === 'w:p' && strippedHiddenChild) {
    const hasContent = nextChildren.some(
      c => c.type === 'element' && c.name !== 'w:pPr' && c.name !== 'w:bookmarkStart' && c.name !== 'w:bookmarkEnd',
    )
    if (!hasContent) return null
  }

  return new Element(node.name, node.attributes, nextChildren)
}

function countExplicitBreaksInNode(node, isFirstBodyParagraph = false) {
  if (!node || node.type !== 'element') return 0
  if (node.name === 'w:del' || node.name === 'w:moveFrom') return 0

  let count = 0
  let paraAlreadyHasBreak = false
  if (node.name === 'w:p') {
    const pPr = node.first('w:pPr')
    if (!isFirstBodyParagraph && pPr && readOnOff(pPr.first('w:pageBreakBefore')) === true) {
      count += 1
      paraAlreadyHasBreak = true
    }
  }

  const walk = (el) => {
    for (const child of el.children || []) {
      if (child.type !== 'element') continue
      if (child.name === 'w:del' || child.name === 'w:moveFrom') continue
      if (child.name === 'w:br' && String(child.attributes?.['w:type'] || '').toLowerCase() === 'page') {
        count += 1
        paraAlreadyHasBreak = true
      } else if (child.name === 'w:lastRenderedPageBreak') {
        if (!paraAlreadyHasBreak) {
          count += 1
          paraAlreadyHasBreak = true
        }
      } else {
        walk(child)
      }
    }
  }
  walk(node)
  return count
}

function splitSectionsWithContent(bodyEl) {
  const sections = []
  if (!bodyEl) return sections

  let currentNodes = []
  const walk = (el) => {
    for (const child of el.children || []) {
      if (child.type !== 'element') continue
      if (child.name === 'w:sectPr') continue
      if (child.name === 'w:p') {
        currentNodes.push(child)
        const sectPr = child.first('w:pPr')?.first('w:sectPr')
        if (sectPr) {
          sections.push({ sectPr, nodes: currentNodes })
          currentNodes = []
        }
      } else if (child.name === 'w:sdt') {
        const content = child.first('w:sdtContent')
        if (content) walk(content)
      } else if (child.name === 'w:ins' || child.name === 'w:moveTo' || child.name === 'w:customXml' || child.name === 'w:smartTag') {
        walk(child)
      } else {
        currentNodes.push(child)
      }
    }
  }

  walk(bodyEl)
  const finalSectPr = bodyEl.first('w:sectPr')
  if (finalSectPr) {
    sections.push({ sectPr: finalSectPr, nodes: currentNodes })
  }
  return sections
}

function convertElementToRawText(documents, element) {
  if (!element) return ''
  if (element.type === documents.types.text) {
    return element.value
  }
  if (element.type === documents.types.tab) {
    return '\t'
  }
  if (element.type === documents.types.break) {
    return element.breakType === 'page' ? '\n\n' : '\n'
  }
  const tail = element.type === documents.types.paragraph ? '\n\n' : ''
  return (element.children || []).map(child => convertElementToRawText(documents, child)).join('') + tail
}

async function extractHeaderOrFooterText(core, docxFile, partPath, { contentTypes, numbering, styles, styleInfo, files, state }) {
  const rawXml = await readOfficeXmlPart(core, docxFile, partPath)
  if (!rawXml) return ''
  const filteredXml = stripHiddenRuns(rawXml, styleInfo, core.xmlNodes.Element, state)
  if (!filteredXml || !(filteredXml.children || []).length) return ''

  const partRelsXml = await readOfficeXmlPart(core, docxFile, relationshipsFilename(core.zipfile, partPath))
  const relationships = partRelsXml
    ? core.relationshipsReader.readRelationships(partRelsXml)
    : core.relationshipsReader.defaultValue
  const bodyReader = core.bodyReaderModule.createBodyReader({
    relationships,
    contentTypes,
    docxFile,
    numbering,
    styles,
    files,
  })
  const parsed = bodyReader.readXmlElements(filteredXml.children)
  return (parsed.value || []).map(el => convertElementToRawText(core.documents, el)).join('').trim()
}

/**
 * Evaluates OOXML header/footer visibility per section (ECMA-376 §17.10.5, §17.10.6, §17.15.1.43).
 *
 * Key invariant:
 * - Statically inactive headers/footers (e.g. w:type="first" when titlePg is off, w:type="even" when
 *   evenAndOddHeaders is off, unreferenced orphan parts) are ALWAYS excluded.
 * - For pagination-dependent combinations (titlePg + default, titlePg + even + default, evenAndOddHeaders + even):
 *   only parts provably rendered by explicit page counts are included automatically. Whenever real layout
 *   overflow could change which non-empty header/footer is visible (including stale cached docProps/app.xml),
 *   visibilityUncertain is flagged true so the host keeps the text in local preview and never auto-sends to LLM.
 */
async function resolveHeadersAndFooters({
  core,
  bodyEl,
  mainDocumentPath,
  mainRawRels,
  docxFile,
  evenAndOddHeaders,
  sharedOpts,
  state,
}) {
  const sections = splitSectionsWithContent(bodyEl)
  const baseDir = core.zipfile.splitPath(mainDocumentPath).dirname

  const resolveRelTarget = (rId) => {
    if (!rId) return null
    const rec = mainRawRels.byId[rId]
    if (!rec || rec.isExternal || !rec.target) return null
    const path = normalizeZipPath(baseDir, rec.target)
    return path && docxFile.exists(path) ? path : null
  }

  // Pre-extract text for all referenced header/footer parts (deduplicated) so empty parts never trigger ambiguity
  const partTextCache = new Map()
  const loadPartText = async (path) => {
    if (!path) return ''
    if (!partTextCache.has(path)) {
      partTextCache.set(path, await extractHeaderOrFooterText(core, docxFile, path, { ...sharedOpts, state }))
    }
    return partTextCache.get(path)
  }

  const inheritedHeader = { default: null, first: null, even: null }
  const inheritedFooter = { default: null, first: null, even: null }
  const activeHeaderTexts = []
  const activeFooterTexts = []
  const seenHeaderTexts = new Set()
  const seenFooterTexts = new Set()

  const addUnique = (text, list, seen) => {
    const clean = String(text || '').trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    list.push(clean)
  }

  for (let secIdx = 0; secIdx < sections.length; secIdx += 1) {
    const { sectPr, nodes } = sections[secIdx]
    for (const child of sectPr.children || []) {
      if (child.type !== 'element') continue
      if (child.name === 'w:headerReference') {
        const type = String(child.attributes?.['w:type'] || 'default').toLowerCase()
        if (type === 'default' || type === 'first' || type === 'even') {
          inheritedHeader[type] = resolveRelTarget(child.attributes?.['r:id'])
        }
      } else if (child.name === 'w:footerReference') {
        const type = String(child.attributes?.['w:type'] || 'default').toLowerCase()
        if (type === 'default' || type === 'first' || type === 'even') {
          inheritedFooter[type] = resolveRelTarget(child.attributes?.['r:id'])
        }
      }
    }

    const titlePg = readOnOff(sectPr.first('w:titlePg')) === true
    const sectType = String(sectPr.first('w:type')?.attributes?.['w:val'] || '').toLowerCase()
    const startsOnSamePage = secIdx > 0 && (sectType === 'continuous' || sectType === 'nextcolumn')
    const pgStartRaw = sectPr.first('w:pgNumType')?.attributes?.['w:start']
    const hasCustomParity = Boolean(evenAndOddHeaders && (sectType === 'evenpage' || sectType === 'oddpage' || pgStartRaw !== undefined))

    let explicitBreaks = 0
    for (let i = 0; i < nodes.length; i += 1) {
      explicitBreaks += countExplicitBreaksInNode(nodes[i], secIdx === 0 && i === 0)
    }
    const minProvablePages = 1 + explicitBreaks

    const evaluateKind = async (inherited, outList, seenSet) => {
      const firstText = await loadPartText(inherited.first)
      const defaultText = await loadPartText(inherited.default)
      const evenText = await loadPartText(inherited.even)

      if (startsOnSamePage) {
        // ECMA-376 §17.6.22: a continuous / nextColumn section begins on the previous section's page,
        // so its own header is NOT displayed on that shared page unless it reaches a subsequent page.
        const candidateTexts = [
          defaultText,
          ...(titlePg ? [firstText] : []),
          ...(evenAndOddHeaders ? [evenText] : []),
        ].filter(Boolean)
        if (candidateTexts.some(txt => !seenSet.has(txt))) {
          state.visibilityUncertain = true
          state.reasons.add('continuous-section-header-footer')
        }
        if (minProvablePages < 2) {
          return
        }
        if (!titlePg && !evenAndOddHeaders) {
          addUnique(defaultText, outList, seenSet)
        }
        return
      }

      if (!titlePg && !evenAndOddHeaders) {
        // Case 1: Normal Word document — ONLY default header/footer is active, 100% independent of page count.
        addUnique(defaultText, outList, seenSet)
        return
      }

      if (hasCustomParity && (evenText || defaultText)) {
        state.visibilityUncertain = true
        state.reasons.add('custom-section-page-parity')
      }

      if (titlePg && !evenAndOddHeaders) {
        // Case 2: Different First Page only. Page 1 = first, Page 2+ = default.
        addUnique(firstText, outList, seenSet)
        if (defaultText && defaultText !== firstText) {
          if (minProvablePages >= 2) {
            addUnique(defaultText, outList, seenSet)
          } else {
            // Natural text flow may stay on 1 page or spill onto page 2; never rely on cached app.xml <Pages>.
            state.visibilityUncertain = true
            state.reasons.add('pagination-dependent-default-header')
          }
        }
        return
      }

      if (titlePg && evenAndOddHeaders) {
        // Case 3: Different First Page + Different Odd & Even.
        // Page 1 = first, Page 2 = even, Page 3+ odd = default.
        addUnique(firstText, outList, seenSet)
        if (evenText && evenText !== firstText) {
          if (minProvablePages >= 2) {
            addUnique(evenText, outList, seenSet)
          } else {
            state.visibilityUncertain = true
            state.reasons.add('pagination-dependent-even-header')
          }
        }
        if (defaultText && defaultText !== firstText && defaultText !== evenText) {
          if (minProvablePages >= 3) {
            addUnique(defaultText, outList, seenSet)
          } else {
            // Page 3 is NOT provably rendered (e.g. a 2-page doc never displays the page-3+ default header).
            state.visibilityUncertain = true
            state.reasons.add('pagination-dependent-odd-page3-header')
          }
        }
        return
      }

      // Case 4: !titlePg && evenAndOddHeaders. Page 1 = default (odd), Page 2+ = even.
      addUnique(defaultText, outList, seenSet)
      if (evenText && evenText !== defaultText) {
        if (minProvablePages >= 2) {
          addUnique(evenText, outList, seenSet)
        } else {
          state.visibilityUncertain = true
          state.reasons.add('pagination-dependent-even-header')
        }
      }
    }

    await evaluateKind(inheritedHeader, activeHeaderTexts, seenHeaderTexts)
    await evaluateKind(inheritedFooter, activeFooterTexts, seenFooterTexts)
  }

  return { activeHeaderTexts, activeFooterTexts }
}

/**
 * Extracts visible text from a .docx buffer using bundled Mammoth primitives and strict OOXML
 * visibility filtering (active headers/footers, hidden runs, conditional table styles, modern
 * DrawingML <mc:Choice> text boxes).
 *
 * Returns `{ text, visibilityUncertain, visibilityReasons }`.
 */
export async function extractDocxDetails(buffer) {
  const core = await loadMammothCore()
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const docxFile = await core.promises.toExternalPromise(core.unzip.openZip({ buffer: inputBuffer }))

  const pkgRelsXml = await readOfficeXmlPart(core, docxFile, '_rels/.rels')
  const pkgRawRels = parseRawRelationships(pkgRelsXml)
  const mainDocumentPath = findPartPath(docxFile, pkgRawRels, REL_OFFICE_DOC, '', 'word/document.xml')
  if (!docxFile.exists(mainDocumentPath)) {
    throw new Error('Could not find main document part. Are you sure this is a valid .docx file?')
  }

  const mainBaseDir = core.zipfile.splitPath(mainDocumentPath).dirname
  const [contentTypesXml, mainRelsXml, documentXml] = await Promise.all([
    readOfficeXmlPart(core, docxFile, '[Content_Types].xml'),
    readOfficeXmlPart(core, docxFile, relationshipsFilename(core.zipfile, mainDocumentPath)),
    readOfficeXmlPart(core, docxFile, mainDocumentPath),
  ])
  if (!documentXml) {
    throw new Error('Could not find main document part. Are you sure this is a valid .docx file?')
  }

  const contentTypes = contentTypesXml
    ? core.contentTypesReader.readContentTypesFromXml(contentTypesXml)
    : core.contentTypesReader.defaultContentTypes
  const mainRelationships = mainRelsXml
    ? core.relationshipsReader.readRelationships(mainRelsXml)
    : core.relationshipsReader.defaultValue
  const mainRawRels = parseRawRelationships(mainRelsXml)

  const stylesPath = findPartPath(docxFile, mainRawRels, REL_STYLES, mainBaseDir, 'word/styles.xml')
  const numberingPath = findPartPath(docxFile, mainRawRels, REL_NUMBERING, mainBaseDir, 'word/numbering.xml')
  const settingsPath = findPartPath(docxFile, mainRawRels, REL_SETTINGS, mainBaseDir, 'word/settings.xml')

  const [stylesXml, numberingXmlEl, settingsXml] = await Promise.all([
    readOfficeXmlPart(core, docxFile, stylesPath),
    readOfficeXmlPart(core, docxFile, numberingPath),
    readOfficeXmlPart(core, docxFile, settingsPath),
  ])

  const styles = stylesXml ? core.stylesReader.readStylesXml(stylesXml) : core.stylesReader.defaultStyles
  const styleInfo = parseStyleVisibilityInfo(stylesXml)
  const numbering = numberingXmlEl
    ? core.numberingXml.readNumberingXml(numberingXmlEl, { styles })
    : core.numberingXml.defaultNumbering
  const evenAndOddHeaders = readOnOff(settingsXml?.first('w:evenAndOddHeaders')) === true
  const files = new core.filesModule.Files({ externalFileAccess: false })

  const state = { visibilityUncertain: false, reasons: new Set() }
  const sharedOpts = { contentTypes, numbering, styles, styleInfo, files }

  const bodyEl = documentXml.first('w:body')
  const { activeHeaderTexts, activeFooterTexts } = await resolveHeadersAndFooters({
    core,
    bodyEl,
    mainDocumentPath,
    mainRawRels,
    docxFile,
    evenAndOddHeaders,
    sharedOpts,
    state,
  })

  const filteredDocumentXml = stripHiddenRuns(documentXml, styleInfo, core.xmlNodes.Element, state)
  const bodyReader = core.bodyReaderModule.createBodyReader({
    relationships: mainRelationships,
    contentTypes,
    docxFile,
    numbering,
    styles,
    files,
  })
  const docReader = new core.documentXmlReaderModule.DocumentXmlReader({
    bodyReader,
    notes: new core.documents.Notes([]),
    comments: [],
  })
  const docResult = docReader.convertXmlToDocument(filteredDocumentXml)
  const bodyText = convertElementToRawText(core.documents, docResult.value).trim()

  const text = [...activeHeaderTexts, bodyText, ...activeFooterTexts].filter(Boolean).join('\n\n')
  return {
    text,
    visibilityUncertain: state.visibilityUncertain,
    visibilityReasons: [...state.reasons],
  }
}
