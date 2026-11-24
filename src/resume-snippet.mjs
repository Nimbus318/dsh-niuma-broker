const SNIPPET_LANGUAGES = new Set(['markdown', 'md', 'resume', 'text', ''])

/**
 * Determine whether a fenced code block contains a resume bullet/section snippet
 * eligible for one-click insertion into the resume editor.
 */
export function looksLikeResumeSnippet(lang = '', code = '') {
  const body = String(code ?? '')
  if (!body || body.trim().length < 18) return false
  const normalizedLang = String(lang || '').trim().toLowerCase()
  if (!SNIPPET_LANGUAGES.has(normalizedLang)) return false
  return /(?:^|\n)\s*(?:##+\s+|[-*•]\s+)/u.test(body)
}
