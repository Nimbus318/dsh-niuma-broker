import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CATALOGS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  detectRuntimeLocale,
  flattenCatalog,
  formatClockTime,
  formatLocalizedDate,
  formatShortDateTime,
  interpolate,
  localeMeta,
  normalizeLocale,
  normalizeLocalePreference,
  translate,
} from '../src/i18n/index.mjs'
import {
  detectTextLanguage,
  resumeEditingLanguageDirective,
  uiLanguageDirective,
} from '../src/i18n/prompt.mjs'
import {
  annotateJd,
  buildDiligencePrompt,
  buildStudyPrompt,
  buildUserJdSignals,
  classifyCompanyProfile,
} from '../src/jd-highlight.mjs'
import { parseStyleDirective } from '../src/resume-style.mjs'
import { localResumeTemplates } from '../src/local-templates.mjs'
import { normalizePreferenceIntake, preferencePatch } from '../src/preference-intake.mjs'
import { smartPlaceEvidenceIntoResume } from '../src/resume-merge.mjs'
import { buildPatrolSearchProfile, scoreOpportunityHeuristic } from '../src/job-triage.mjs'
import { validateScheduleItem } from '../src/personal-schedule.mjs'

const CLIENT_DIR = new URL('../client/', import.meta.url).pathname

function extractPlaceholders(str) {
  const vars = new Set()
  const cleaned = String(str).replace(
    /\{([A-Za-z0-9_]+)\s*,\s*plural\s*,\s*(?:[A-Za-z0-9_=]+\s*\{[^{}]*\}\s*)+\}/gu,
    (_, name) => {
      vars.add(name)
      return ''
    },
  )
  for (const m of cleaned.matchAll(/\{([A-Za-z0-9_]+)\}/gu)) {
    vars.add(m[1])
  }
  return [...vars].sort()
}

test('i18n catalogs have 100% key parity, placeholder parity, and non-empty strings across all supported locales', () => {
  assert.ok(SUPPORTED_LOCALES.length >= 2, 'Should support at least zh and en')
  const baseFlat = flattenCatalog(CATALOGS[DEFAULT_LOCALE])
  const baseKeys = Object.keys(baseFlat).sort()
  assert.ok(baseKeys.length > 300, `Expected substantial catalog, got ${baseKeys.length} keys`)

  for (const loc of SUPPORTED_LOCALES) {
    assert.ok(CATALOGS[loc.code], `Missing catalog for registered locale: ${loc.code}`)
    const flat = flattenCatalog(CATALOGS[loc.code])
    const keys = Object.keys(flat).sort()

    const missing = baseKeys.filter(k => !(k in flat))
    const extra = keys.filter(k => !(k in baseFlat))
    assert.deepEqual(missing, [], `Locale "${loc.code}" is missing keys: ${missing.join(', ')}`)
    assert.deepEqual(extra, [], `Locale "${loc.code}" has extra keys: ${extra.join(', ')}`)

    for (const key of baseKeys) {
      assert.equal(typeof flat[key], 'string', `Key "${key}" in "${loc.code}" must be a string`)
      assert.ok(flat[key].trim().length > 0, `Key "${key}" in "${loc.code}" must not be empty`)
      const baseVars = extractPlaceholders(baseFlat[key])
      const locVars = extractPlaceholders(flat[key])
      assert.deepEqual(locVars, baseVars, `Placeholder mismatch for "${key}" in "${loc.code}": expected [${baseVars}], got [${locVars}]`)
    }
  }
})

test('every static t(...), translate(...), and labelKey in client/ resolves in all supported locales', () => {
  const catalogs = Object.fromEntries(SUPPORTED_LOCALES.map(l => [l.code, flattenCatalog(CATALOGS[l.code])]))
  const files = readdirSync(CLIENT_DIR).filter(f => f.endsWith('.js') || f.endsWith('.jsx'))
  const missing = []

  const keyPatterns = [
    /\bt\(\s*'([a-z][a-z0-9_.]+)'/gu,
    /\bt\(\s*"([a-z][a-z0-9_.]+)"/gu,
    /\btranslate\([^,]+,\s*'([a-z][a-z0-9_.]+)'/gu,
    /\btranslate\([^,]+,\s*"([a-z][a-z0-9_.]+)"/gu,
    /\blabelKey\s*:\s*'([a-z][a-z0-9_.]+)'/gu,
    /\blabelKey\s*:\s*"([a-z][a-z0-9_.]+)"/gu,
  ]

  for (const file of files) {
    const src = readFileSync(join(CLIENT_DIR, file), 'utf8')
    for (const re of keyPatterns) {
      for (const m of src.matchAll(re)) {
        const key = m[1]
        for (const loc of SUPPORTED_LOCALES) {
          if (!(key in catalogs[loc.code])) {
            missing.push(`${file}: ${key} (missing in ${loc.code})`)
          }
        }
      }
    }
  }
  assert.deepEqual(missing, [], `Unresolved i18n keys in client/:\n${missing.join('\n')}`)
})

test('core i18n normalization, interpolation, translator, and date formatting helpers', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale('zh_TW'), 'zh')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('en_GB'), 'en')
  assert.equal(normalizeLocale('fr-FR', 'zh'), 'zh')
  assert.equal(normalizeLocale('', 'en'), 'en')

  assert.equal(normalizeLocalePreference('auto'), 'auto')
  assert.equal(normalizeLocalePreference('system'), 'auto')
  assert.equal(normalizeLocalePreference('en-US'), 'en')
  assert.equal(normalizeLocalePreference('zh-Hans'), 'zh')
  assert.equal(normalizeLocalePreference('invalid'), 'auto')

  assert.equal(detectRuntimeLocale({ envLang: 'en_US.UTF-8', fallback: 'zh' }), 'en')
  assert.equal(detectRuntimeLocale({ envLang: 'zh_CN.UTF-8', fallback: 'en' }), 'zh')
  assert.equal(detectRuntimeLocale({ preference: 'en', envLang: 'zh_CN.UTF-8' }), 'en')

  assert.equal(localeMeta('en').brandTitle, 'Niuma Broker')
  assert.equal(localeMeta('zh').brandTitle, '牛马经纪人')

  assert.equal(interpolate('Hello {name}, {count} items', { name: 'Alex', count: 3 }), 'Hello Alex, 3 items')
  assert.equal(translate('en', 'sources.scopeWorkspaces', { count: 1 }), '1 workspace')
  assert.equal(translate('en', 'sources.scopeWorkspaces', { count: 3 }), '3 workspaces')
  assert.equal(translate('en', 'jobs.debriefsCount', { count: 1 }), '1 debrief')
  assert.equal(translate('en', 'jobs.debriefsCount', { count: 2 }), '2 debriefs')
  assert.equal(translate('en', 'brand.name'), 'Niuma Broker')
  assert.equal(translate('zh', 'brand.name'), '牛马经纪人')

  const { t: tEn } = createTranslator('en')
  assert.equal(tEn('brand.name'), 'Niuma Broker')
  assert.equal(tEn('nonexistent.key.xyz'), 'nonexistent.key.xyz')

  const sampleDate = '2026-06-15T14:30:00.000Z'
  const zhDate = formatLocalizedDate(sampleDate, 'zh')
  const enDate = formatLocalizedDate(sampleDate, 'en')
  assert.ok(zhDate.length > 0 && enDate.length > 0)
  assert.notEqual(zhDate, enDate)
  assert.ok(formatShortDateTime(sampleDate, 'en').length > 0)
  assert.ok(formatClockTime(sampleDate, 'en').length > 0)
})

test('dual-language AI prompt policy separates UI language from resume body language', () => {
  const enResume = '# Alex Chen\nStaff Distributed Systems Engineer\n## Experience\n- Designed high-throughput GPU inference scheduler across 2,000+ nodes.\n- Reduced tail latency by 42% using Rust and Kubernetes.'
  const zhResume = '# 林予安\n资深大模型基础设施工程师\n## 工作经历\n- 主导千卡级 GPU 推理集群调度系统，端到端 P99 延迟降低 42%。\n- 使用 Rust 与 Kubernetes 搭建高可用推理网关。'

  assert.equal(detectTextLanguage(enResume), 'en')
  assert.equal(detectTextLanguage(zhResume), 'zh')
  assert.equal(detectTextLanguage('   12345   '), 'unknown')

  assert.match(uiLanguageDirective('en'), /English/i)
  assert.match(uiLanguageDirective('zh'), /简体中文/)

  // Cross-language safety: Chinese UI editing an English resume MUST preserve English body!
  const zhUiEnResume = resumeEditingLanguageDirective({ uiLocale: 'zh', resumeText: enResume })
  assert.match(zhUiEnResume, /English/i)
  assert.match(zhUiEnResume, /简体中文/)

  // Cross-language safety: English UI editing a Chinese resume MUST preserve Chinese body!
  const enUiZhResume = resumeEditingLanguageDirective({ uiLocale: 'en', resumeText: zhResume })
  assert.match(enUiZhResume, /Simplified Chinese|Chinese/i)
  assert.match(enUiZhResume, /English/i)
})

test('English JD highlight decoder, company profile, and prompts work cleanly in English', () => {
  const enJd = [
    'Responsibilities:',
    '- Build distributed GPU inference infrastructure on Kubernetes using Rust and Go.',
    '- Thrive in a fast-paced environment where we work hard, play hard and wear many hats.',
    'Benefits:',
    '- Unlimited PTO and 5 days in office required.',
  ].join('\n')

  const signals = buildUserJdSignals({
    resumes: [{ status: 'approved', text: '# Alex Chen\nBuilt Kubernetes GPU scheduling in Go.' }],
    evidence: [],
    config: { goal: 'Staff AI Infrastructure Engineer', searchTerms: ['Kubernetes', 'GPU'] },
    job: {
      company: 'Anthropic',
      title: 'Staff Infrastructure Engineer',
      location: 'San Francisco',
      provider: 'greenhouse',
      jd: enJd,
      intel: {
        riskNotes: [
          { term: 'work hard, play hard', meaning: 'Often signals heavy overtime expectations.', question: 'What are typical on-call hours?' },
          { term: 'wear many hats', meaning: 'Role scope may span multiple functions.', question: 'How is work prioritized?' },
          { term: 'Unlimited PTO', meaning: 'Check actual average days taken per year.', question: 'How much PTO did the team average last year?' },
          { term: '5 days in office', meaning: 'Strict full-time onsite policy.', question: 'Is there any remote flexibility?' },
        ],
      },
    },
    locale: 'en',
  })
  const annotated = annotateJd(enJd, signals)
  const riskTerms = annotated.summary.risks.map(r => r.term.toLowerCase())

  assert.ok(riskTerms.some(t => t.includes('work hard')), `Expected "work hard, play hard" risk, got: ${riskTerms}`)
  assert.ok(riskTerms.some(t => t.includes('wear many hats')), `Expected "wear many hats" risk (including trailing period), got: ${riskTerms}`)
  assert.ok(riskTerms.some(t => t.includes('unlimited pto')), `Expected "unlimited PTO" risk, got: ${riskTerms}`)
  assert.ok(riskTerms.some(t => t.includes('5 days in office')), `Expected RTO risk, got: ${riskTerms}`)
  for (const risk of annotated.summary.risks) {
    assert.ok(!/[\u4e00-\u9fff]/u.test(risk.category), `English risk category leaked CJK: ${risk.category}`)
    assert.ok(!/[\u4e00-\u9fff]/u.test(risk.translation), `English risk translation leaked CJK: ${risk.translation}`)
    assert.ok(!/[\u4e00-\u9fff]/u.test(risk.question), `English risk question leaked CJK: ${risk.question}`)
  }

  const profile = classifyCompanyProfile(
    { company: 'Stripe', title: 'Staff Systems Engineer', location: 'San Francisco', provider: 'greenhouse' },
    { locale: 'en' },
  )
  assert.ok(!/[\u4e00-\u9fff]/u.test(profile.badge))
  assert.ok(!/[\u4e00-\u9fff]/u.test(profile.summary))
  assert.ok(profile.links.every(l => !/[\u4e00-\u9fff]/u.test(l.label)))

  const studyPrompt = buildStudyPrompt({
    job: { company: 'Anthropic', title: 'Staff Infra Engineer' },
    term: 'Rust',
    locale: 'en',
  })
  assert.ok(!/[\u4e00-\u9fff]/u.test(studyPrompt), `English study prompt leaked CJK: ${studyPrompt}`)

  const diligencePrompt = buildDiligencePrompt({
    job: { company: 'Stripe', title: 'Staff Systems Engineer' },
    companyProfile: profile,
    risks: annotated.summary.risks,
    locale: 'en',
  })
  assert.ok(!/[\u4e00-\u9fff]/u.test(diligencePrompt), `English diligence prompt leaked CJK: ${diligencePrompt}`)
})

test('English natural-language resume style directives and content-edit guard', () => {
  const styled = parseStyleDirective('switch to navy 2-column compact layout', localResumeTemplates, 'en')
  assert.equal(styled.matched, true)
  assert.equal(styled.pureStyle, true)
  assert.equal(styled.patch.accent, '#1e3a5f')
  assert.equal(styled.patch.density, 'compact')
  assert.equal(styled.templateId, 'azurill')
  assert.ok(!/[\u4e00-\u9fff]/u.test(styled.summary), `Expected English style summary, got: ${styled.summary}`)

  const reset = parseStyleDirective('reset to default layout', localResumeTemplates, 'en')
  assert.equal(reset.matched, true)
  assert.equal(reset.patch.reset, true)
  assert.ok(!/[\u4e00-\u9fff]/u.test(reset.summary))

  const contentEdit = parseStyleDirective('rewrite my experience bullets to emphasize distributed systems and make it compact', localResumeTemplates, 'en')
  assert.equal(contentEdit.pureStyle, false)
})

test('English preference intake parses cadences, toggles, and time windows with localized errors', () => {
  const cadence = normalizePreferenceIntake({
    proposed: { intervalMinutes: 360 },
    previous: {},
    text: 'Check job boards every 6 hours',
    locale: 'en',
  })
  assert.equal(cadence.data.intervalMinutes, 360)
  assert.equal(cadence.question, '')

  const daily = normalizePreferenceIntake({
    proposed: { intervalMinutes: 1440 },
    previous: {},
    text: 'Patrol once a day',
    locale: 'en',
  })
  assert.equal(daily.data.intervalMinutes, 1440)
  assert.equal(daily.question, '')

  const muted = normalizePreferenceIntake({
    proposed: { notificationsEnabled: false, allowReflections: false },
    previous: {},
    text: 'Turn off alerts and disable career reflections',
    locale: 'en',
  })
  assert.equal(muted.data.notificationsEnabled, false)
  assert.equal(muted.data.allowReflections, false)
  assert.equal(muted.question, '')

  const win = normalizePreferenceIntake({
    proposed: { notificationHour: 9, notificationEndHour: 18 },
    previous: {},
    text: 'Send notifications between 9am to 6pm',
    locale: 'en',
  })
  assert.equal(win.data.notificationHour, 9)
  assert.equal(win.data.notificationEndHour, 18)
  assert.equal(win.question, '')

  assert.throws(() => preferencePatch({}, 'en'), /verify/i)
})

test('smartPlaceEvidenceIntoResume handles English resumes with English formatting and summary', () => {
  const enResume = [
    '# Alex Chen',
    'alex@example.com · San Francisco, CA',
    '',
    '## Experience',
    '### Acme Cloud · Staff Engineer (2023 - Present)',
    '- Built multi-tenant Kubernetes control plane serving 400 clusters.',
    '',
    '## Skills',
    '- Go, Rust, Kubernetes, Distributed Systems',
  ].join('\n')

  const merged = smartPlaceEvidenceIntoResume(
    enResume,
    [
      {
        id: 'ev-1',
        title: 'Inference Gateway',
        text: 'Architected vLLM routing layer with prefix-aware scheduling',
        impact: 'cut P99 latency by 38%',
      },
    ],
    'en',
  )
  assert.ok(merged.markdown.includes('Architected vLLM routing layer with prefix-aware scheduling — cut P99 latency by 38%'))
  assert.ok(!merged.markdown.includes('## 近期核心成果'), 'English resume must not get Chinese fallback heading')
  assert.ok(!/[\u4e00-\u9fff]/u.test(merged.summary), `Expected English merge summary, got: ${merged.summary}`)
})

test('heuristic job triage and personal schedule validation support English cleanly', () => {
  const profile = buildPatrolSearchProfile({
    resumeText: '# Alex Chen\nStaff Infrastructure Engineer specializing in Kubernetes, GPU scheduling, Rust, and distributed systems.',
    goal: 'Staff AI Infrastructure Engineer in San Francisco or Remote',
    searchTerms: ['Kubernetes', 'GPU', 'Infrastructure'],
  })
  const scored = scoreOpportunityHeuristic({
    id: 'job-en-1',
    company: 'Anthropic',
    title: 'Staff Infrastructure Engineer - GPU Scheduling',
    location: 'San Francisco / Remote',
    jd: 'Build high-throughput Kubernetes GPU cluster scheduling and inference infrastructure in Rust and Go.',
  }, profile, 'en')

  assert.ok(scored.score >= 60, `Expected high fit score, got ${scored.score}`)
  assert.ok(scored.reason && !/[\u4e00-\u9fff]/u.test(scored.reason), `English triage reason leaked CJK: ${scored.reason}`)
  assert.ok(scored.breakdown.every(b => !/[\u4e00-\u9fff]/u.test(b.label) && !/[\u4e00-\u9fff]/u.test(b.detail)),
    `English triage breakdown leaked CJK: ${JSON.stringify(scored.breakdown)}`)

  assert.throws(
    () => validateScheduleItem({ destination: 'invalid', id: '1', target: 'x', title: 't' }, 'en'),
    /calendar|reminders|things/i,
  )
})
