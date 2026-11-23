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
const STORY_RELATIONSHIPS = new Set(['header', 'footer', 'footnotes', 'endnotes', 'comments']
  .flatMap(kind => [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + kind,
    'http://purl.oclc.org/ooxml/officeDocument/relationships/' + kind,
  ]))
const TRACKED_TEXT_ELEMENTS = new Set(['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'])

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

async function readWordXml(core, docxFile, path) {
  if (!path || !docxFile.exists(path)) return null
  const raw = await core.promises.toExternalPromise(docxFile.read(path, 'utf-8'))
  return core.promises.toExternalPromise(core.xml.readString(stripUtf8Bom(raw), XML_NAMESPACE_MAP))
}

async function readOfficeXmlPart(core, docxFile, path) {
  const doc = await readWordXml(core, docxFile, path)
  const normalized = normalizeOfficeXml(doc, core.xmlNodes.Element)
  return normalized[0] || null
}

async function openWordDocument(buffer) {
  const core = await loadMammothCore()
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const docxFile = await core.promises.toExternalPromise(core.unzip.openZip({ buffer: inputBuffer }))
  const pkgRelsXml = await readWordXml(core, docxFile, '_rels/.rels')
  const pkgRawRels = parseRawRelationships(pkgRelsXml)
  const mainDocumentPath = findPartPath(docxFile, pkgRawRels, REL_OFFICE_DOC, '', 'word/document.xml')
  if (!docxFile.exists(mainDocumentPath)) {
    throw new Error('Could not find main document part. Are you sure this is a valid .docx file?')
  }
  return { core, docxFile, mainDocumentPath }
}

function containsTrackedText(node) {
  return TRACKED_TEXT_ELEMENTS.has(node?.name) || node?.children?.some(containsTrackedText)
}

export async function hasDocxTrackedText(buffer) {
  const { core, docxFile, mainDocumentPath } = await openWordDocument(buffer)
  const baseDir = core.zipfile.splitPath(mainDocumentPath).dirname
  const relationshipsXml = await readWordXml(core, docxFile, relationshipsFilename(core.zipfile, mainDocumentPath))
  const relationships = parseRawRelationships(relationshipsXml)
  const storyPaths = new Set([mainDocumentPath])
  for (const [type, relatedParts] of Object.entries(relationships.byType)) {
    if (!STORY_RELATIONSHIPS.has(type)) continue
    for (const rel of relatedParts) {
      if (!rel.isExternal) storyPaths.add(normalizeZipPath(baseDir, rel.target))
    }
  }
  for (const storyPath of storyPaths) {
    const story = await readWordXml(core, docxFile, storyPath)
    if (!story || (storyPath === mainDocumentPath && story.name !== 'w:document')) {
      throw new Error('Could not read a referenced part of the .docx file.')
    }
    if (containsTrackedText(story)) return true
  }
  return false
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
      entry.hasConditionalVisibility = styleEl.getElementsByTagName('w:tblStylePr').some(condition => {
        const rPr = condition.first('w:rPr')
        return rPr?.first('w:vanish') || rPr?.first('w:webHidden')
      })
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

function isRunHidden(runEl, ctx, styleInfo) {
  const rPr = runEl.first('w:rPr')
  const rStyleId = rPr?.first('w:rStyle')?.attributes?.['w:val'] || null
  const effectiveParaStyleId = ctx.paraStyleId || styleInfo.defaultParagraphStyleId

  const resolveProp = (prop) => {
    let state = styleInfo.docDefaults[prop]
    const tVal = resolveStyleChainProp(styleInfo.tableStyles, ctx.tblStyleId, prop)
    if (tVal !== undefined) state = tVal
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

function stripHiddenRuns(node, styleInfo, Element, visibilityReasons, ctx = {}) {
  if (!node || node.type !== 'element') return node

  let nextCtx = ctx
  if (node.name === 'w:tbl') {
    const tblStyleId = node.first('w:tblPr')?.first('w:tblStyle')?.attributes?.['w:val'] || styleInfo.defaultTableStyleId
    nextCtx = { tblStyleId }
    if (getStyleChain(styleInfo.tableStyles, tblStyleId).some(style => style.hasConditionalVisibility)) {
      visibilityReasons.add('conditional-table-style-visibility')
    }
  } else if (node.name === 'w:p') {
    // A run style on the paragraph mark applies to the mark itself.
    const paraStyleId = node.first('w:pPr')?.first('w:pStyle')?.attributes?.['w:val']
    nextCtx = { ...ctx, paraStyleId }
  } else if (node.name === 'w:r') {
    if (isRunHidden(node, ctx, styleInfo)) {
      const fldChars = (node.children || []).filter(c => c.type === 'element' && c.name === 'w:fldChar')
      if (fldChars.length === 0) return null
      const kept = (node.children || []).filter(c => c.type === 'element' && (c.name === 'w:rPr' || c.name === 'w:fldChar'))
      return new Element(node.name, node.attributes, kept)
    }
  }

  const children = (node.children || [])
    .map(child => stripHiddenRuns(child, styleInfo, Element, visibilityReasons, nextCtx))
    .filter(child => child !== null)
  return new Element(node.name, node.attributes, children)
}

const SECTION_WRAPPERS = new Set(['w:sdt', 'w:sdtContent', 'w:ins', 'w:moveTo', 'w:customXml', 'w:smartTag'])

function collectSectionProperties(container, sections = []) {
  for (const child of container?.children || []) {
    if (child.name === 'w:sectPr') {
      sections.push(child)
    } else if (child.name === 'w:p') {
      const properties = child.first('w:pPr')?.first('w:sectPr')
      if (properties) sections.push(properties)
    } else if (SECTION_WRAPPERS.has(child.name)) {
      collectSectionProperties(child, sections)
    }
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

async function extractHeaderOrFooterText(core, docxFile, partPath, { contentTypes, numbering, styles, styleInfo, files, visibilityReasons }) {
  const rawXml = await readOfficeXmlPart(core, docxFile, partPath)
  if (!rawXml) return ''
  const filteredXml = stripHiddenRuns(rawXml, styleInfo, core.xmlNodes.Element, visibilityReasons)
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

// Pick the first-page part where it is defined by section settings. Later page variants need layout.
async function resolveHeadersAndFooters({
  core,
  bodyEl,
  mainDocumentPath,
  mainRawRels,
  docxFile,
  evenAndOddHeaders,
  sharedOpts,
  visibilityReasons,
}) {
  const sections = collectSectionProperties(bodyEl)
  const baseDir = core.zipfile.splitPath(mainDocumentPath).dirname

  async function readParts(kind) {
    const referenceName = 'w:' + kind + 'Reference'
    const references = { default: null, first: null, even: null }
    const activePaths = new Set()
    const uncertainPaths = new Set()

    for (const [index, section] of sections.entries()) {
      for (const child of section.children || []) {
        if (child.name !== referenceName) continue
        const type = String(child.attributes?.['w:type'] || 'default').toLowerCase()
        if (!Object.hasOwn(references, type)) continue
        const rel = mainRawRels.byId[child.attributes?.['r:id']]
        const path = rel?.target && !rel.isExternal ? normalizeZipPath(baseDir, rel.target) : ''
        references[type] = path && docxFile.exists(path) ? path : null
      }

      const titlePage = readOnOff(section.first('w:titlePg')) === true
      const sectionType = String(section.first('w:type')?.attributes?.['w:val'] || '').toLowerCase()
      const continuesPage = index > 0 && (sectionType === 'continuous' || sectionType === 'nextcolumn')
      const customPageStart = section.first('w:pgNumType')?.attributes?.['w:start']
      const needsPageParity = evenAndOddHeaders && (index > 0 || customPageStart !== undefined)
      let activeType = null
      if (!continuesPage) {
        if (titlePage) activeType = 'first'
        else if (!needsPageParity) activeType = 'default'
      }

      const enabledTypes = ['default']
      if (titlePage) enabledTypes.push('first')
      if (evenAndOddHeaders) enabledTypes.push('even')
      for (const type of enabledTypes) {
        const path = references[type]
        if (!path) continue
        if (type === activeType) activePaths.add(path)
        else uncertainPaths.add(path)
      }
    }

    if ([...uncertainPaths].some(path => !activePaths.has(path))) {
      visibilityReasons.add('pagination-dependent-header-footer')
    }

    const texts = new Set()
    for (const path of activePaths) {
      const text = await extractHeaderOrFooterText(core, docxFile, path, { ...sharedOpts, visibilityReasons })
      if (text) texts.add(text)
    }
    return [...texts]
  }

  return {
    activeHeaderTexts: await readParts('header'),
    activeFooterTexts: await readParts('footer'),
  }
}

/** Extract readable DOCX text for local review without estimating page layout. */
export async function extractDocxDetails(buffer) {
  const { core, docxFile, mainDocumentPath } = await openWordDocument(buffer)
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

  const visibilityReasons = new Set()
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
    visibilityReasons,
  })

  const filteredDocumentXml = stripHiddenRuns(documentXml, styleInfo, core.xmlNodes.Element, visibilityReasons)
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
    visibilityUncertain: visibilityReasons.size > 0,
    visibilityReasons: [...visibilityReasons],
  }
}
