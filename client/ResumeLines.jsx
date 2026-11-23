import React from 'react'
import { useI18n } from './i18n.jsx'

export default function ResumeLines({ text = '' }) {
  const { t } = useI18n()
  return <section className="ca-line-sheet" aria-label={t('editor.lineByLineAria')}>
    {text.split(/\r?\n/u).map((raw, index) => {
      const line = raw.trim()
      if (!line) return <div className="ca-line-break" key={index} aria-hidden="true" />
      const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
      if (heading) return <div className={`ca-line-title ca-line-level-${heading[1].length}`} data-agent-line={index} key={index}>{heading[2]}</div>
      const bullet = /^(?:[-*+•▪·]\s*|\d+[.)、]\s*)(.+)$/u.exec(line)
      return <div data-agent-line={index} className={bullet ? 'ca-line-bullet' : 'ca-line-text'} key={index}>{bullet?.[1] ?? line}</div>
    })}
  </section>
}
