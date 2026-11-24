import React from 'react'
import {
  FenceCodeBlock, MarkdownDelegateProvider, MarkdownText, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { looksLikeResumeSnippet } from '../src/resume-snippet.mjs'
import { useI18n } from './i18n.jsx'

export { looksLikeResumeSnippet }

function ResumeSnippetCard({ lang, code, onApplySnippet }) {
  const { t } = useI18n()
  const { copied, onCopy } = useClipboardCopy(code)
  const label = lang === 'markdown' || lang === 'md'
    ? t('markdown.resumeSnippet')
    : (lang || t('markdown.referenceSnippet'))

  return (
    <div className="ca-md-fence">
      <div className="ca-md-fence-head">
        <span className="ca-md-fence-lang">{label}</span>
        <div className="ca-md-fence-actions">
          <button type="button" className="ca-md-fence-apply" onClick={() => onApplySnippet(code)}>
            {t('markdown.applyToResume')}
          </button>
          <button type="button" className="ca-md-fence-copy" onClick={onCopy}>
            {copied ? t('common.copiedTick') : t('common.copy')}
          </button>
        </div>
      </div>
      <pre className="ca-md-pre"><code>{code}</code></pre>
    </div>
  )
}

export default function MarkdownProse({ text, streaming = false, onApplySnippet, className = '' }) {
  const { t } = useI18n()
  const src = String(text ?? '')
  const mdLabels = React.useMemo(() => ({
    code: {
      copyLabel: t('common.copy'),
      copiedLabel: t('common.copied'),
      toolbarLabels: {
        codeLabel: t('markdown.referenceSnippet'),
        wrapLabel: t('common.expand'),
        unwrapLabel: t('common.collapse'),
      },
    },
    footnotes: t('markdown.referenceSnippet'),
  }), [t])

  const renderCode = React.useCallback(({ lang = '', code = '', streaming: fenceStreaming = false }) => {
    if (!streaming && !fenceStreaming && typeof onApplySnippet === 'function' && looksLikeResumeSnippet(lang, code)) {
      return <ResumeSnippetCard lang={lang} code={code} onApplySnippet={onApplySnippet} />
    }
    return <FenceCodeBlock lang={lang} code={code} streaming={fenceStreaming} labels={mdLabels.code} />
  }, [streaming, onApplySnippet, mdLabels.code])

  if (!src.trim()) return null

  return (
    <div className={`ca-md-prose${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}>
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={src} streaming={streaming} labels={mdLabels} />
      </MarkdownDelegateProvider>
    </div>
  )
}
