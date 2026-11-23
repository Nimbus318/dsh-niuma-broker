import { localeMeta, normalizeLocale } from './index.mjs'

/**
 * Detects the dominant language of user-authored document text (resume / JD / notes).
 * Returns `'zh'`, `'en'`, or `'unknown'`.
 */
export function detectTextLanguage(text = '') {
  const sample = String(text || '')
  if (!sample.trim()) return 'unknown'
  const cjk = (sample.match(/[\u4e00-\u9fff]/gu) ?? []).length
  const latinWords = (sample.match(/[a-zA-Z]{2,}/g) ?? []).length
  if (cjk >= 16 && cjk >= latinWords * 0.45) return 'zh'
  if (latinWords >= 24 && cjk < 12) return 'en'
  if (cjk > 0 && cjk >= latinWords) return 'zh'
  if (latinWords > 0) return 'en'
  return 'unknown'
}

/**
 * Returns a strict, crystal-clear instruction telling the LLM which language to use for
 * UI-facing responses (summaries, explanations, analysis verdicts, follow-up questions, chat replies).
 */
export function uiLanguageDirective(locale) {
  const meta = localeMeta(normalizeLocale(locale, 'zh'))
  if (meta.code === 'zh') {
    return '界面输出语言：所有面向用户的分析、总结、理由、追问、建议与对话回复均使用自然简洁的简体中文。'
  }
  return `UI output language: Write ALL user-facing analysis, summaries, rationales, follow-up questions, labels, and conversational replies in concise, natural ${meta.promptLanguage}. Never reply in Chinese when the UI language is ${meta.promptLanguage} (keep proper nouns / original company or role titles accurate).`
}

/**
 * Separates UI explanation language from resume body language so editing an English resume
 * in a Chinese UI (or vice-versa) NEVER corrupts the resume's own language unless explicitly requested.
 */
export function resumeEditingLanguageDirective({ uiLocale = 'zh', resumeText = '', targetText = '' } = {}) {
  const ui = localeMeta(normalizeLocale(uiLocale, 'zh'))
  const docLang = detectTextLanguage(resumeText)
  const docLabel = docLang === 'zh'
    ? 'Simplified Chinese (简体中文)'
    : docLang === 'en'
      ? 'English'
      : ui.promptLanguage
  const targetLang = detectTextLanguage(targetText)
  const targetNote = targetLang !== 'unknown' && targetLang !== docLang
    ? ` (note: target JD is in ${targetLang === 'zh' ? 'Chinese' : 'English'}; keep resume body in ${docLabel} unless the user explicitly asked to translate)`
    : ''
  if (ui.code === 'zh') {
    return `语言原则：对话回复、修改说明（summary/reason/gaps）使用简体中文；简历正文（markdown/bullets）严格保持原简历语言（${docLabel}）${targetNote}，除非用户明确要求翻译整份简历。`
  }
  return `Language policy: Write conversational replies, summaries, rationales, and gap notes in ${ui.promptLanguage}. Keep all rewritten resume markdown/bullets strictly in the resume's own language (${docLabel})${targetNote}, unless the user explicitly asks to translate the resume.`
}
