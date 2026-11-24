import { templateIds, templateLayouts } from './vendor/reactive-resume-templates.mjs';
import {
  defaultStyleForTemplate, hexToRgba, normalizeResumeStyle, TEMPLATE_DISPLAY_NAMES, templateDisplayName,
} from './resume-style.mjs';
import { detectTextLanguage } from './i18n/prompt.mjs';

let rendererPromise = null;
function loadResumeRenderer() {
  if (!rendererPromise) {
    rendererPromise = import('./vendor/reactive-resume-renderer.mjs');
  }
  return rendererPromise;
}

export { TEMPLATE_DISPLAY_NAMES, templateDisplayName };

export const defaultLocalResumeTemplate = 'onyx';
export const localResumeTemplates = Object.freeze(templateIds.map(id => {
  const layout = templateLayouts[id] ?? { columns: 1, sidebarSide: null, headerPlacement: 'full-width', atsSafe: true };
  const defaults = defaultStyleForTemplate(id);
  const names = TEMPLATE_DISPLAY_NAMES[id] ?? { zh: id[0].toUpperCase() + id.slice(1), en: id[0].toUpperCase() + id.slice(1) };
  return Object.freeze({
    id,
    label: names.zh,
    labelZh: names.zh,
    labelEn: names.en,
    columns: layout.columns,
    sidebarSide: layout.sidebarSide ?? null,
    headerPlacement: layout.headerPlacement ?? 'full-width',
    atsSafe: Boolean(layout.atsSafe),
    defaultAccent: defaults.accent,
    defaultFont: defaults.font,
  });
}));

export const LOCAL_RESUME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const DENSITY_PRESETS = Object.freeze({
  compact: Object.freeze({ bodySize: 9.3, headingSize: 12.6, lineHeight: 1.42, marginX: 11, marginY: 10, gapX: 4, gapY: 4 }),
  balanced: Object.freeze({ bodySize: 10.1, headingSize: 13.6, lineHeight: 1.56, marginX: 15, marginY: 13, gapX: 5, gapY: 6 }),
  airy: Object.freeze({ bodySize: 10.7, headingSize: 14.4, lineHeight: 1.68, marginX: 19, marginY: 16, gapX: 6, gapY: 8 }),
});

const EDITORIAL_POLISH_CSS = `
.rr { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
.rr h1, .rr h2, .rr h3 { letter-spacing: -0.014em; }
.rr a { color: inherit; text-decoration: none; }
.rr p { margin: 0 0 0.35em; }
.rr p:last-child { margin-bottom: 0; }
.rr ul, .rr ol { margin: 0.25em 0 0.55em; padding-inline-start: 1.3em; }
.rr li { margin-bottom: 0.24em; }
.rr li:last-child { margin-bottom: 0; }
.rr h3 { margin-top: 0.72em; margin-bottom: 0.22em; font-weight: 600; }
.rr h3:first-child { margin-top: 0; }
`;

const PRINT_PAPER_CSS = `
  html,body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rr{margin:0 auto}
  .rr-page{max-width:100%}
  .rr a{pointer-events:none}
  @page{size:A4;margin:0}
  @media print{
    html,body{background:#fff}
    .rr .rr-page{overflow:visible!important;box-shadow:none!important}
    .rr h1,.rr h2,.rr h3{break-after:avoid;page-break-after:avoid}
    .rr li,.rr p,.rr .t{orphans:2;widows:2}
    .rr div.v:has(> div.t:first-child + div.v:not(:has(.v))){break-inside:avoid;page-break-inside:avoid}
  }
`;

const escapeAttr = value => String(value).replace(/[&<>"']/gu, character => namedEntities[character]);

export function buildPrintableResumeHtml({ html, css, lang = 'zh-CN', title = '简历' }) {
  return `<!doctype html><html lang="${escapeAttr(lang || 'zh-CN')}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(LOCAL_RESUME_CSP)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttr(title)}</title><style>${css.replaceAll('</', '<\\/')}${PRINT_PAPER_CSS}</style></head><body><div class="rr">${html}</div></body></html>`;
}

const mainHeading = /^#\s+(.+?)\s*$/u;
const sectionHeading = /^##\s+(.+?)\s*$/u;
const entryHeading = /^#{3,6}\s+(.+?)\s*$/u;
const sidebarHeading = /^(?:核心技能|技能清单|专业技能|技能|语言能力|语言|资格证书|证书|获奖情况|荣誉|Technical Skills(?:\s*(?:&|and)\s*(?:Tools|Certifications|Expertise))?|Core (?:Skills|Competencies)|Skills(?:\s*(?:&|and)\s*(?:Certifications|Tools|Expertise|Languages))?|Technologies(?:\s*(?:&|and)\s*Tools)?|Tools(?:\s*(?:&|and)\s*Technologies)?|Languages|Certifications(?:\s*(?:&|and)\s*Licenses)?|Awards(?:\s*(?:&|and)\s*Honors)?|Honors(?:\s*(?:&|and)\s*Awards)?|Interests)[：:]?$/iu;
const otherHeading = /^(?:个人简介|个人概述|自我评价|核心优势|工作经历|工作经验|职业经历|项目经历|项目经验|教育经历|教育背景|联系方式|联系信息|开源项目|学术成果|发表论文|(?:Executive |Professional )?Summary|Objective|Profile|About(?: Me)?|(?:Work |Professional |Relevant |Industry )?Experience|Employment(?: History)?|Work History|Career(?: History| Summary)?|(?:Selected |Key |Personal |Open Source )?Projects|Education(?: & Training)?|Academic Background|Contact(?: Information| Details)?|Key Achievements|Achievements|Highlights|Publications|Open Source|Leadership|Volunteer(?:ing| Experience)?)[：:]?$/iu;
const contactField = /^(?:电子邮箱|邮箱|邮件|电子邮件|电话|手机|联系方式|地址|位置|微信|个人网站|网站|主页|Email|Phone|Mobile|Location|Address|Website|GitHub|LinkedIn)\s*[：:]/iu;
const bareContactLine = /(?:[\w.%+-]+@[\w.-]+\.[a-z]{2,}|(?:^|[\s|·•,])\+?\d[\d\s().-]{6,}\d(?:$|[\s|·•,])|\b(?:github\.com|linkedin\.com)\/\S+)/iu;
const bullet = /^\s*(?:[-*+]\s+|[•▪●○]\s*)(\S.*)$/u;
const numberedBullet = /^\s*([1-9]\d{0,2})(?:[.)]\s+|、\s*)(\S.*)$/u;
const namedEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => value.replace(/[&<>"']/gu, character => namedEntities[character]);

export function extractPlainTextHeaderName(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return '';
  const first = String(lines[0] ?? '').trim();
  if (!first || first.length < 2 || first.length > 64) return '';
  if (/^(?:#|[-*+•▪●○><`~[!]|\d+[.)、])/u.test(first)) return '';
  if (sectionHeading.test(first) || sidebarHeading.test(first) || otherHeading.test(first)) return '';
  if (contactField.test(first) || bareContactLine.test(first)) return '';
  if (/(?:https?:\/\/|www\.|[<>={}]|@\S)/iu.test(first)) return '';
  // Reject prose sentences (ending in punctuation) while allowing middle initials like "Alex M. Synthetic"
  if (/[.。!！?？;；:：]$/u.test(first)) return '';
  const words = first.split(/\s+/u).filter(Boolean);
  if (words.length > 6) return '';
  return first;
}

function isPlainTextHeadline(line, followingLines) {
  const clean = String(line ?? '').trim();
  if (!clean || clean.length < 2 || clean.length > 90) return false;
  if (/^(?:#|[-*+•▪●○><`~[!]|\d+[.)、])/u.test(clean)) return false;
  if (sectionHeading.test(clean) || sidebarHeading.test(clean) || otherHeading.test(clean)) return false;
  if (contactField.test(clean) || bareContactLine.test(clean)) return false;
  if (/[.。!！?？;；]$/u.test(clean)) return false;
  // Treat as plain-text headline only if followed by a contact line, blank line, or section heading (i.e. not body prose)
  const next = followingLines.find(row => row.trim().length > 0);
  if (!next) return true;
  const nextTrim = next.trim();
  return !followingLines[0]?.trim()
    || contactField.test(nextTrim)
    || bareContactLine.test(nextTrim)
    || sectionHeading.test(nextTrim)
    || sidebarHeading.test(nextTrim)
    || otherHeading.test(nextTrim);
}

function safeLinkHref(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^mailto:[^\s<>()[\]"']+$/iu.test(value)) return value;
  if (/^https?:\/\/[^\s<>()[\]"']+$/iu.test(value)) {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
        return parsed.href;
      }
    } catch {}
  }
  return '';
}

function parseContactField(raw) {
  let link = '';
  let linkCount = 0;
  const text = String(raw ?? '')
    .replace(/(?<!!)\[([^\]\r\n]+)\]\(([^)\s\r\n]+)\)/gu, (_match, label, href) => {
      const safe = safeLinkHref(href);
      if (safe) {
        linkCount += 1;
        if (linkCount === 1) link = safe;
      }
      return label;
    })
    .replace(/<(mailto:[^\s<>]+|https?:\/\/[^\s<>]+)>/giu, (_match, href) => {
      const safe = safeLinkHref(href);
      if (safe) {
        linkCount += 1;
        if (linkCount === 1) link = safe;
      }
      return href.replace(/^mailto:/iu, '');
    })
    .trim();
  return { text, link: linkCount === 1 ? link : '' };
}

// Render common résumé formatting without reading Markdown HTML, images, or remote resources.
function inlineMarkup(text) {
  const marks = /`([^`]+)`|(?<!!)\[([^\]\r\n]+)\]\(([^)\s\r\n]+)\)|\*\*([^*\r\n]+)\*\*|(?<![\p{L}\p{N}])__([^_\r\n]+)__(?![\p{L}\p{N}])|\*([^*\r\n]+)\*|(?<![\p{L}\p{N}])_([^_\r\n]+)_(?![\p{L}\p{N}])/gu;
  let out = '';
  let position = 0;
  for (const mark of text.matchAll(marks)) {
    out += escapeHtml(text.slice(position, mark.index));
    if (mark[2] !== undefined && mark[3] !== undefined) {
      const href = safeLinkHref(mark[3]);
      const labelHtml = escapeHtml(mark[2]);
      out += href ? `<a href="${escapeAttr(href)}">${labelHtml}</a>` : labelHtml;
    } else {
      const tag = mark[1] ? 'code' : mark[4] || mark[5] ? 'strong' : 'em';
      out += '<' + tag + '>' + escapeHtml(mark[1] ?? mark[4] ?? mark[5] ?? mark[6] ?? mark[7]) + '</' + tag + '>';
    }
    position = mark.index + mark[0].length;
  }
  return out + escapeHtml(text.slice(position));
}

function richText(lines) {
  const parts = [];
  let list = '';
  let fence = '';
  function closeList() {
    if (list) parts.push('</' + list + '>');
    list = '';
  }
  for (const source of lines) {
    const line = source.trim();
    const fenceStart = line.match(/^(`{3,}|~{3,})/u)?.[1] ?? '';
    if (fenceStart && (!fence || fence[0] === fenceStart[0])) {
      closeList();
      fence = fence ? '' : fenceStart;
      continue;
    }
    const heading = !fence && entryHeading.exec(line);
    const unordered = !fence && bullet.exec(line);
    const ordered = !fence && numberedBullet.exec(line);
    if (unordered || ordered) {
      const type = ordered ? 'ol' : 'ul';
      if (list !== type) {
        closeList();
        list = type;
        parts.push(ordered ? '<ol start="' + Number(ordered[1]) + '">' : '<ul>');
      }
      parts.push('<li>' + inlineMarkup(unordered?.[1] ?? ordered[2]) + '</li>');
    } else {
      closeList();
      if (!line) continue;
      const tag = heading ? 'h3' : 'p';
      const value = fence ? escapeHtml(source) : inlineMarkup(heading?.[1] ?? line);
      parts.push('<' + tag + '>' + value + '</' + tag + '>');
    }
  }
  closeList();
  return parts.join('');
}

function resumeData({ text, title, template, style, locale = 'zh' }, { defaultResumeData, sectionDefaults }) {
  const isEn = String(locale || '').toLowerCase().startsWith('en');
  if (typeof text !== 'string') {
    throw new TypeError(isEn ? 'Resume content must be a text string.' : '简历原文必须是文本。');
  }
  const data = structuredClone(defaultResumeData);
  const resolvedTemplate = Object.hasOwn(templateLayouts, template) ? template : defaultLocalResumeTemplate;
  const resolvedStyle = normalizeResumeStyle(style, resolvedTemplate);
  const density = DENSITY_PRESETS[resolvedStyle.density] ?? DENSITY_PRESETS.balanced;

  data.picture.hidden = true;
  data.metadata.template = resolvedTemplate;
  data.metadata.design.colors.primary = hexToRgba(resolvedStyle.accent, 1);
  data.metadata.design.colors.text = 'rgba(24, 24, 27, 1)';
  data.metadata.design.colors.background = 'rgba(255, 255, 255, 1)';
  data.metadata.typography.body.fontSize = density.bodySize;
  data.metadata.typography.body.lineHeight = density.lineHeight;
  data.metadata.typography.heading.fontSize = density.headingSize;
  data.metadata.typography.heading.lineHeight = Math.max(1.3, density.lineHeight - 0.14);
  data.metadata.page.marginX = density.marginX;
  data.metadata.page.marginY = density.marginY;
  data.metadata.page.gapX = density.gapX;
  data.metadata.page.gapY = density.gapY;
  const docLang = detectTextLanguage(text);
  data.metadata.page.locale = docLang === 'zh'
    ? 'zh-CN'
    : docLang === 'en'
      ? 'en-US'
      : (isEn ? 'en-US' : 'zh-CN');
  data.metadata.page.hideIcons = true;
  const layout = data.metadata.layout.pages[0];
  layout.fullWidth = templateLayouts[resolvedTemplate].columns === 1;
  layout.main = [];
  layout.sidebar = [];

  const lines = text.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u);
  const firstTitle = mainHeading.exec(lines[0]);
  const plainName = firstTitle ? '' : extractPlainTextHeaderName(lines);
  data.basics.name = firstTitle?.[1]
    ?? (plainName || (typeof title === 'string' && title.trim()) || (data.metadata.page.locale === 'en-US' ? 'Resume' : '简历'));
  if (firstTitle || plainName) lines.shift();

  const sections = [{ heading: '', lines: [] }];
  let fence = '';
  for (const source of lines) {
    const line = source.trim();
    const marker = line.match(/^(`{3,}|~{3,})/u)?.[1]?.[0];
    if (marker && (!fence || fence === marker)) fence = fence ? '' : marker;
    const heading = !fence && (sectionHeading.exec(line)?.[1]
      ?? (sidebarHeading.test(line) || otherHeading.test(line) ? line : ''));
    if (heading) sections.push({ heading, lines: [] });
    else sections.at(-1).lines.push(source);
  }

  const intro = sections[0].lines;
  while (intro.length && !intro[0].trim()) intro.shift();
  if (/^_[^_]+_$/u.test(intro[0] ?? '')) {
    data.basics.headline = intro.shift().slice(1, -1);
  } else if (plainName && intro.length && isPlainTextHeadline(intro[0], intro.slice(1))) {
    data.basics.headline = intro.shift().trim();
  }
  while (intro.length && (!intro[0].trim() || contactField.test(intro[0].trim()) || bareContactLine.test(intro[0].trim()))) {
    const contact = intro.shift().trim();
    if (contact) {
      const parsed = parseContactField(contact);
      if (parsed.text) data.basics.customFields.push({
        id: 'contact-' + data.basics.customFields.length, icon: '', text: parsed.text, link: parsed.link,
      });
    }
  }

  for (const { heading, lines: contentLines } of sections) {
    const content = richText(contentLines);
    if (!content && !heading) continue;
    const id = 'niuma-' + data.customSections.length;
    data.customSections.push({
      ...sectionDefaults('none'), id, type: 'summary', title: heading, showHeading: Boolean(heading),
      items: [{ id: id + '-text', hidden: false, content: content || '<p>&nbsp;</p>' }],
    });
    const column = !layout.fullWidth && sidebarHeading.test(heading) ? 'sidebar' : 'main';
    layout[column].push(id);
  }
  return { data, resolvedStyle };
}

/** Returns a local Reactive Resume sheet for a container with class "rr". */
export async function renderLocalResume({ text, title, template = defaultLocalResumeTemplate, style, locale = 'zh' } = {}) {
  const { defaultResumeData, renderResumeWebPage, sectionDefaults } = await loadResumeRenderer();
  const { data, resolvedStyle } = resumeData({ text, title, template, style, locale }, { defaultResumeData, sectionDefaults });
  const preview = await renderResumeWebPage({ data, imageUrl: () => undefined });
  const isZh = preview.lang === 'zh-CN';
  const fontStack = resolvedStyle.font === 'serif'
    ? (isZh
      ? '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "STSong", Georgia, serif'
      : 'Georgia, "Iowan Old Style", "Times New Roman", serif')
    : (isZh
      ? '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif'
      : '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif');

  const css = preview.css.replace(/^@font-face\{[^\r\n]*\}\r?\n?/gmu, '')
    .replace(/font-family:[^;{}]+(?=[;}])/gu, 'font-family:' + fontStack)
    + EDITORIAL_POLISH_CSS;
  return { ...preview, css, style: resolvedStyle };
}
