import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transformSync } from 'esbuild'

const MAX_IMPORTANT = 148

/**
 * Masks quoted string literals (preserving newlines and handling escapes) so
 * characters inside strings never affect parenthesis, URL, or selector scans.
 */
function maskQuotedStrings(css) {
  let out = ''
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '\\' && i + 1 < css.length) {
      out += ch + css[i + 1]
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += quote
      i++
      while (i < css.length) {
        const cur = css[i]
        if (cur === '\\' && i + 1 < css.length) {
          out += css[i + 1] === '\n' ? '\n' : '  '
          i += 2
          continue
        }
        if (cur === quote) {
          out += quote
          i++
          break
        }
        out += cur === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Masks unquoted `url(...)` arguments (respecting backslash escapes) so URLs
 * like `url(/img\)!important)` do not trigger keyword or paren-depth false positives.
 */
function maskUnquotedUrls(css) {
  let out = ''
  let cursor = 0
  const re = /(?<![a-zA-Z0-9_#-])url\(/gi
  let match
  while ((match = re.exec(css)) !== null) {
    const openIdx = match.index + match[0].length - 1
    out += css.slice(cursor, openIdx + 1)
    let depth = 1
    let i = openIdx + 1
    while (i < css.length && depth > 0) {
      const ch = css[i]
      if (ch === '\\' && i + 1 < css.length) {
        out += css[i + 1] === '\n' ? '\n' : '  '
        i += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth > 0) out += ch === '\n' ? '\n' : ' '
      else out += ')'
      i++
    }
    cursor = i
    re.lastIndex = i
  }
  out += css.slice(cursor)
  return out
}

function splitTopLevelCommas(selectorText) {
  const parts = []
  let parenDepth = 0
  let bracketDepth = 0
  let start = 0
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]
    if (ch === '\\' && i + 1 < selectorText.length) {
      i++
      continue
    }
    if (ch === '(') parenDepth++
    else if (ch === ')' && parenDepth > 0) parenDepth--
    else if (ch === '[') bracketDepth++
    else if (ch === ']' && bracketDepth > 0) bracketDepth--
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(selectorText.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(selectorText.slice(start).trim())
  return parts.filter(Boolean)
}

function lineNumberAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/**
 * Extracts custom properties declared directly inside top-level `.ca-page`
 * rule blocks (ignoring at-rules, nested rules, `:not(..., .ca-page)`, and
 * escaped selector commas like `.other\,.ca-page`).
 */
function extractPageRootCaTokensFromClean(cleanedCss) {
  const tokens = new Set()
  let depth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let prelude = ''
  let inRootPageBlock = false
  let declBuffer = ''

  const flushDecl = () => {
    const m = declBuffer.match(/^\s*(--ca-[a-zA-Z0-9_-]+)\s*:/)
    if (m) tokens.add(m[1])
    declBuffer = ''
  }

  for (let i = 0; i < cleanedCss.length; i++) {
    const ch = cleanedCss[i]
    if (ch === '\\' && i + 1 < cleanedCss.length) {
      if (depth === 0) prelude += ch + cleanedCss[i + 1]
      else if (depth === 1 && inRootPageBlock) declBuffer += ch + cleanedCss[i + 1]
      i++
      continue
    }
    if (ch === '{') {
      if (depth === 0) {
        const trimmed = prelude.trim()
        if (!trimmed.startsWith('@')) {
          const selectors = splitTopLevelCommas(trimmed)
          inRootPageBlock = selectors.includes('.ca-page')
        } else {
          inRootPageBlock = false
        }
        prelude = ''
        declBuffer = ''
        parenDepth = 0
        bracketDepth = 0
      } else if (depth === 1 && inRootPageBlock) {
        // Capture `--ca-x: { ... };` property names before entering nested value braces.
        flushDecl()
      }
      depth++
      continue
    }
    if (ch === '}') {
      if (depth === 1 && inRootPageBlock) {
        flushDecl()
        inRootPageBlock = false
        parenDepth = 0
        bracketDepth = 0
      }
      if (depth > 0) depth--
      if (depth === 0) prelude = ''
      continue
    }
    if (depth === 0) {
      if (ch === ';') {
        prelude = ''
      } else {
        prelude += ch
      }
    } else if (depth === 1 && inRootPageBlock) {
      if (ch === '(') parenDepth++
      else if (ch === ')' && parenDepth > 0) parenDepth--
      else if (ch === '[') bracketDepth++
      else if (ch === ']' && bracketDepth > 0) bracketDepth--

      if (ch === ';' && parenDepth === 0 && bracketDepth === 0) {
        flushDecl()
      } else {
        declBuffer += ch
      }
    }
  }
  return tokens
}

/**
 * Finds all `var(--ca-*)` references, supporting nested parentheses and nested
 * `var(...)` calls inside fallback arguments while ignoring hash tokens (`#var(...)`).
 */
function findCaVarReferencesFromClean(cleanedCss) {
  const refs = []
  const re = /(?<![a-zA-Z0-9_#-])var\(/gi
  let match
  while ((match = re.exec(cleanedCss)) !== null) {
    const openIdx = match.index + match[0].length - 1
    let depth = 1
    let firstComma = -1
    let i = openIdx + 1
    while (i < cleanedCss.length && depth > 0) {
      const ch = cleanedCss[i]
      if (ch === '\\' && i + 1 < cleanedCss.length) {
        i += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 1 && firstComma === -1) firstComma = i
      i++
    }
    if (depth !== 0) continue
    const closeIdx = i - 1
    const rawName = (firstComma === -1
      ? cleanedCss.slice(openIdx + 1, closeIdx)
      : cleanedCss.slice(openIdx + 1, firstComma)).trim()
    if (!rawName.startsWith('--ca-')) continue
    const fallback = firstComma === -1 ? '' : cleanedCss.slice(firstComma + 1, closeIdx)
    const hasFallback = firstComma !== -1
    const hasValidFallback = hasFallback && fallback.trim().length > 0
    refs.push({
      token: rawName,
      hasFallback,
      hasValidFallback,
      fallback: fallback.trim(),
      line: lineNumberAt(cleanedCss, match.index),
    })
  }
  return refs
}

export function auditCss(css, { maxImportant = MAX_IMPORTANT } = {}) {
  const transformed = transformSync(css, { loader: 'css', minify: false, legalComments: 'none' })
  const normalized = maskUnquotedUrls(maskQuotedStrings(transformed.code))
  const rootTokens = extractPageRootCaTokensFromClean(normalized)
  const caRefs = findCaVarReferencesFromClean(normalized)
  const missingNoFallback = caRefs.filter(ref => !rootTokens.has(ref.token) && !ref.hasValidFallback)

  const badThemeSelectors = []
  const themeRe = /\[\s*data-theme(?=\s*(?:[=~|^$*]?=|\s*\]))/gi
  let themeMatch
  while ((themeMatch = themeRe.exec(normalized)) !== null) {
    badThemeSelectors.push({
      selector: themeMatch[0],
      line: lineNumberAt(normalized, themeMatch.index),
    })
  }

  const importantCount = (normalized.match(/(?<!\\)!\s*important\b/gi) || []).length

  return {
    warnings: transformed.warnings,
    rootTokens,
    caRefs,
    missingNoFallback,
    badThemeSelectors,
    importantCount,
    maxImportant,
  }
}

test('client/page.css declares root tokens cleanly, drops data-theme selectors, and keeps !important within ratchet', async () => {
  const css = await readFile(new URL('../client/page.css', import.meta.url), 'utf8')
  const report = auditCss(css)

  assert.equal(report.warnings.length, 0, `Expected 0 CSS parse warnings, got ${JSON.stringify(report.warnings)}`)
  assert.ok(report.rootTokens.size >= 25, `Expected at least 25 root --ca-* tokens, got ${report.rootTokens.size}`)
  assert.deepEqual(report.missingNoFallback, [])
  assert.deepEqual(report.badThemeSelectors, [])
  assert.ok(
    report.importantCount <= MAX_IMPORTANT,
    `!important count ${report.importantCount} exceeded ratchet limit ${MAX_IMPORTANT}`
  )

  assert.match(css, /\.ca-provider-opt\.is-active\s*\{[^}]*\bbackground:\s*var\(--ca-layer-3\);/)
  assert.match(css, /\[data-ds-dark-theme\]\s+\.ca-jd-mark\.is-pinned\s*\{/)
  assert.match(css, /\.ca-page\s*\{[^}]*\bisolation:\s*isolate;[^}]*\bz-index:\s*0;/)
  const headerZMatch = css.match(/\.ca-header\s*\{[^}]*\bz-index:\s*(\d+)\s*;/)
  assert.ok(headerZMatch && Number(headerZMatch[1]) < 15, `.ca-header z-index must stay < 15 for DSH sidebar toggle, got ${headerZMatch?.[1]}`)
  assert.match(css, /html:not\(\[data-platform='darwin'\]\)\s+\.ca-header-inner\s*\{[^}]*--dsh-frame-leading-clearance/)
})

test('auditCss catches undefined tokens, escapes, url/selector tricks, data-theme selectors, and !important spikes while avoiding false positives', () => {
  const baseRoot = '.ca-page { --ca-bg: #fff; --ca-outer: #eee; }'

  const missingPlain = auditCss(`${baseRoot}\n.a { background: var(--ca-surface); }`)
  assert.deepEqual(missingPlain.missingNoFallback.map(x => x.token), ['--ca-surface'])

  const emptyFallback = auditCss(`${baseRoot}\n.a { background: var(--ca-surface, ); }`)
  assert.deepEqual(emptyFallback.missingNoFallback.map(x => x.token), ['--ca-surface'])

  const nestedColorMix = auditCss(`${baseRoot}\n.a { background: color-mix(in srgb, var(--ca-danger) 10%, transparent); }`)
  assert.deepEqual(nestedColorMix.missingNoFallback.map(x => x.token), ['--ca-danger'])

  const nestedMissingVar = auditCss(`${baseRoot}\n.a { background: var(--ca-outer, var(--ca-missing)); }`)
  assert.deepEqual(nestedMissingVar.missingNoFallback.map(x => x.token), ['--ca-missing'])

  const nestedValidFallback = auditCss(`${baseRoot}\n.a { background: var(--ca-outer, rgba(0, 0, 0, 0.1)); }`)
  assert.deepEqual(nestedValidFallback.missingNoFallback, [])

  const nonRootLocalDecl = auditCss(`${baseRoot}\n.ca-other { --ca-local: red; }\n.b { color: var(--ca-local); }`)
  assert.deepEqual(nonRootLocalDecl.missingNoFallback.map(x => x.token), ['--ca-local'])

  const negatedSelectorDecl = auditCss(`${baseRoot}\n:not(.other, .ca-page, .third) { --ca-hidden: red; }\n.ca-page { color: var(--ca-hidden); }`)
  assert.deepEqual(negatedSelectorDecl.missingNoFallback.map(x => x.token), ['--ca-hidden'])

  const escapedCommaSelector = auditCss(`${baseRoot}\n.other\\,.ca-page { --ca-hidden: red; }\n.ca-page { color: var(--ca-hidden); }`)
  assert.deepEqual(escapedCommaSelector.missingNoFallback.map(x => x.token), ['--ca-hidden'])

  const escapedCssLf = auditCss(`${baseRoot}\n.escaped { color: va\\72\n(--ca-missing) !impor\\74 ant; }`)
  assert.deepEqual(escapedCssLf.missingNoFallback.map(x => x.token), ['--ca-missing'])
  assert.equal(escapedCssLf.importantCount, 1)

  const urlCommentLookalike = auditCss(`${baseRoot}\n.a { background: url(/assets/*/image); color: var(--ca-missing) !important; }`)
  assert.deepEqual(urlCommentLookalike.missingNoFallback.map(x => x.token), ['--ca-missing'])
  assert.equal(urlCommentLookalike.importantCount, 1)

  const escapedUrlClose = auditCss(`${baseRoot}\n.a { background: url(/img\\)!important); }`)
  assert.equal(escapedUrlClose.importantCount, 0)

  const hashNotVarFunc = auditCss(`${baseRoot}\n.a { --test: #var(--ca-missing); }`)
  assert.deepEqual(hashNotVarFunc.missingNoFallback, [])

  const rootBraceCustomProp = auditCss(`.ca-page { --ca-found: { widget: red }; }\n.a { color: var(--ca-found); }`)
  assert.deepEqual(rootBraceCustomProp.missingNoFallback, [])

  const urlAndAttrTheme = auditCss(`${baseRoot}\n.bg { background: url(/image!important) !important; }\n.allowed-attr[data-theme-mode='dark'] { color: var(--ca-bg); }`)
  assert.equal(urlAndAttrTheme.importantCount, 1)
  assert.deepEqual(urlAndAttrTheme.badThemeSelectors, [])

  const badTheme = auditCss(`${baseRoot}\n[data-theme='dark'] .ca-x { color: red; }\n[data-theme] .ca-y { color: blue; }`)
  assert.equal(badTheme.badThemeSelectors.length, 2)

  const importantSpike = auditCss(
    `${baseRoot}\n` +
      Array.from({ length: 147 }, (_, i) => `.k${i} { color: red !important; }`).join('\n') +
      '\n.k147 { color: blue ! important; }\n.k148 { color: green !IMPORTANT; }'
  )
  assert.equal(importantSpike.importantCount, 149)
  assert.ok(importantSpike.importantCount > importantSpike.maxImportant)

  const commentsAndStrings = auditCss(`
    ${baseRoot}
    /* var(--ca-fake) [data-theme='dark'] !important */
    /*! [data-theme='dark'] var(--ca-fake) !important .ca-page { --ca-never: red; } */
    .ca-note::before {
      content: "var(--ca-fake) [data-theme='dark'] !important \\" !important";
      --demo: \\!important;
      background: var(--ca-bg);
    }
  `)
  assert.deepEqual(commentsAndStrings.missingNoFallback, [])
  assert.deepEqual(commentsAndStrings.badThemeSelectors, [])
  assert.equal(commentsAndStrings.importantCount, 0)

  const semiInParens = auditCss(`.ca-page { --ca-real: red; --ca-entries: (x; --ca-hidden: red); color: var(--ca-hidden); }`)
  assert.deepEqual([...semiInParens.rootTokens], ['--ca-real', '--ca-entries'])
  assert.deepEqual(semiInParens.missingNoFallback.map(x => x.token), ['--ca-hidden'])
})
