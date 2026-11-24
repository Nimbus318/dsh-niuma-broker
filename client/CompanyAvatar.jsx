import React from 'react'
import { resolveCompanyDomain } from '../src/company-domains.mjs'
import { useI18n } from './i18n.jsx'

const TONES = ['blue', 'indigo', 'teal', 'amber', 'rose', 'slate']

export function companyTone(name = '') {
  let hash = 0
  for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TONES[hash % TONES.length]
}

export default function CompanyAvatar({
  company = '',
  domain = '',
  slug = '',
  url = '',
  tone = '',
  size = 36,
  className = '',
}) {
  const resolvedDomain = React.useMemo(
    () => resolveCompanyDomain({ domain, company, slug, url }),
    [domain, company, slug, url],
  )
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    setFailed(false)
  }, [resolvedDomain])

  const { t } = useI18n()
  const fallbackTone = tone || companyTone(company || slug)
  const label = String(company || slug || t('brand.defaultAvatar')).trim().slice(0, 2)
  const isMini = size <= 20

  if (resolvedDomain && !failed) {
    return (
      <span
        className={`ca-company-logo${isMini ? ' is-mini' : ''}${className ? ` ${className}` : ''}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <img
          src={`api/career-agent/logo?domain=${encodeURIComponent(resolvedDomain)}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    )
  }

  return (
    <span
      className={`ca-app-badge tone-${fallbackTone}${isMini ? ' is-mini' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <strong>{isMini ? label.slice(0, 1) : label}</strong>
    </span>
  )
}
