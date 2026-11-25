import { cursorCareerUrl, cursorDirectoryLinks } from './cursor-careers.mjs';
import { classifyPublicPosting } from './posting-hiring-scope.mjs';
import { alibabaCampusJobUrl, campusAlibaba, campusJd, campusNetease, campusTencent, mihoyoGraduateProjects, neteaseCampusDetail } from './native-hiring.mjs';
import { ATS_FEISHU_TARGETS, acceptFeishuHiringRow } from './ats-hiring.mjs';
import { createHash } from 'node:crypto';
import { normalizeDomain } from './company-domains.mjs';
import { findCompanyBoard, isValidBoardSlug } from './company-boards.mjs';
import { mokaBoardUrl, readMokaJobs, readMokaDetail } from './moka.mjs';
import { canonicalInterviewRoundKey, interviewGroupKey } from './interview-identity.mjs';

export { canonicalInterviewRoundKey, interviewGroupKey };

export const MAX_SOURCES = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION = 12_000;
const POSTING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,254}$/;
const PROVIDERS = new Set([
  'greenhouse', 'ashby', 'lever', 'feishu', 'moka',
  'tencent', 'meituan', 'jd', 'netease',
  'alibaba', 'baidu', 'xiaohongshu', 'bilibili', 'trip', 'mihoyo',
]);
const SOURCES = new Set(['manual', 'email', 'portal']);

const ALIBABA_ORIGINS = Object.freeze({
  group: 'https://talent-holding.alibaba.com',
  holding: 'https://talent-holding.alibaba.com',
  aliyun: 'https://careers.aliyun.com',
});

function resolveAlibabaOrigin(slug) {
  const lower = String(slug || '').toLowerCase();
  return ALIBABA_ORIGINS[lower] || ALIBABA_ORIGINS.group;
}

const FEISHU_PRESETS = Object.freeze({
  bytedance: Object.freeze({ origin: 'https://jobs.bytedance.com', websitePath: 'society', detailPrefix: 'experienced/position' }),
  bytedance__campus: Object.freeze({ origin: 'https://jobs.bytedance.com', websitePath: 'campus', detailPrefix: 'campus/position', recruitmentIds: ['201'], portalType: 3 }),
  minimax: Object.freeze({ origin: 'https://vrfi1sk8a0.jobs.feishu.cn', websitePath: 'index', detailPrefix: 'index/position' }),
  'zhipu-ai': Object.freeze({ origin: 'https://zhipu-ai.jobs.feishu.cn', websitePath: '', detailPrefix: 'position' }),
});

function resolveFeishuTarget(slug) {
  const lower = slug.toLowerCase();
  if (Object.hasOwn(ATS_FEISHU_TARGETS, lower)) return ATS_FEISHU_TARGETS[lower];
  if (Object.hasOwn(FEISHU_PRESETS, lower)) return FEISHU_PRESETS[lower];
  const sep = slug.indexOf('__');
  const tenant = (sep > 0 ? slug.slice(0, sep) : slug).toLowerCase();
  const sitePath = sep > 0 ? slug.slice(sep + 2) : '';
  return {
    origin: `https://${tenant}.jobs.feishu.cn`,
    websitePath: sitePath,
    detailPrefix: sitePath ? `${sitePath}/position` : 'position',
  };
}

function postingTenant(provider, slug) {
  const board = findCompanyBoard(provider, slug);
  return board?.upstreamSlug || slug;
}

function canonicalPostingUrl(provider, slug, externalId, publicId, deptCodes) {
  const campus = slug === 'campus';
  if (['greenhouse', 'ashby', 'lever'].includes(provider)) slug = postingTenant(provider, slug);
  switch (provider) {
    case 'greenhouse': return `https://job-boards.greenhouse.io/${slug}/jobs/${externalId}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${slug}/${externalId}`;
    case 'lever': return `https://jobs.lever.co/${slug}/${externalId}`;
    case 'moka': return mokaBoardUrl(slug) + '#/job/' + externalId;
    case 'feishu': {
      const target = resolveFeishuTarget(slug);
      return `${target.origin}/${target.detailPrefix}/${externalId}/detail`;
    }
    case 'tencent': return campus ? `https://join.qq.com/post_detail.html?postid=${externalId}` : `https://careers.tencent.com/jobdesc.html?postId=${externalId}`;
    case 'meituan': return `https://zhaopin.meituan.com/web/position/detail?jobUnionId=${externalId}`;
    case 'jd': {
      if (campus) return `https://campus.jd.com/#/details?id=${externalId}&type=present`;
      if (/^\d+$/.test(publicId ?? '')) return `https://zhaopin.jd.com/web/job-info-detail?requementId=${publicId}`;
      return `https://zhaopin.jd.com/web/job/job_info_list/3?reqNumber=${externalId}`;
    }
    case 'netease': return campus ? neteaseCampusDetail(externalId) : `https://hr.163.com/job-detail.html?id=${externalId}`;
    case 'alibaba': return ['group-campus', 'aliyun-campus'].includes(slug) ? alibabaCampusJobUrl(externalId, deptCodes) : `${resolveAlibabaOrigin(slug)}/off-campus/position-detail?positionId=${externalId}`;
    case 'baidu': return `https://talent.baidu.com/jobs/detail/${campus ? 'GRADUATE' : 'SOCIAL'}/${externalId}`;
    case 'xiaohongshu': return `https://job.xiaohongshu.com/${campus ? 'campus' : 'social'}/position/${externalId}`;
    case 'bilibili': return `https://jobs.bilibili.com/${campus ? 'campus' : 'social'}/positions/${externalId}`;
    case 'trip': {
      if (publicId && POSTING_ID.test(publicId)) return `https://job.ctrip.com/#/${campus ? 'campus' : 'experienced'}/job-detail/${publicId}`;
      return campus ? '' : `https://job.ctrip.com/positions/detail?jobId=${externalId}`;
    }
    case 'mihoyo': return `https://jobs.mihoyo.com/#/${campus ? 'campus/' : ''}position/${externalId}`;
    default: return '';
  }
}

export function validateBoardSource(source) {
  if (!source || !PROVIDERS.has(source.provider) || !isValidBoardSlug(source.provider, source.slug)) {
    throw new TypeError('招聘板平台不受支持或企业代号 (board slug) 格式无效；如刚升级插件请 ⌘Q 完全退出并重启 DeepSeek Harness。');
  }
  const domain = normalizeDomain(source.domain);
  return {
    provider: source.provider,
    slug: source.slug,
    company: optionalText(source.company, 'company', 160) || source.slug,
    ...(domain ? { domain } : {}),
  };
}

export function boardSourceId(source) {
  const { provider, slug } = validateBoardSource(source);
  return `${provider}:${slug.toLowerCase()}`;
}

function boardEndpoint({ provider, slug }) {
  switch (provider) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  }
}

const ENTITIES = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bull: '•', rsquo: '’', lsquo: '‘' }));

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (original, entity) => {
    if (entity[0] !== '#') return ENTITIES.get(entity.toLowerCase()) ?? original;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function plainText(value, limit, html = false) {
  if (typeof value !== 'string') return '';
  let text = value.slice(0, limit * 8);
  if (html) {
    text = decodeEntities(text)
      .replace(/<!--[^]*?(?:-->|$)/g, '')
      .replace(/<(script|style|template)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<(?:br\b[^>]*|\/(?:p|li|div|h[1-6])\s*)>/gi, '\n')
      .replace(/<[^>]*>/g, '');
    text = decodeEntities(text);
  }
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function normalizePosting(source, posting, checkedAt) {
  if (!posting || typeof posting !== 'object') return null;
  const { provider, slug, company } = source;
  let externalId;
  let title;
  let location;
  let jd;
  let url;
  let mihoyoSummaryOnly = false;
  let cursorPublicSlug;
  let publicId;
  let deptCodes;

  if (provider === 'greenhouse') {
    if (!Number.isSafeInteger(posting.id) || posting.id <= 0) return null;
    externalId = String(posting.id);
    title = posting.title;
    location = posting.location?.name;
    jd = plainText(posting.content, MAX_DESCRIPTION, true);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'lever') {
    if (typeof posting.id !== 'string' || !POSTING_ID.test(posting.id)) return null;
    externalId = posting.id;
    title = posting.text;
    location = posting.categories?.location;
    const sections = Array.isArray(posting.lists) ? posting.lists.slice(0, 30) : [];
    jd = [
      plainText(posting.descriptionPlain, MAX_DESCRIPTION) || plainText(posting.description, MAX_DESCRIPTION, true),
      ...sections.map(section => [plainText(section?.text, 250), plainText(section?.content, MAX_DESCRIPTION, true)].filter(Boolean).join('\n')),
      plainText(posting.additionalPlain, MAX_DESCRIPTION) || plainText(posting.additional, MAX_DESCRIPTION, true),
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'ashby') {
    if (posting.isListed !== true || typeof posting.jobUrl !== 'string' || posting.jobUrl.length > 2048) return null;
    const parsed = URL.parse(posting.jobUrl);
    const parts = parsed?.pathname.split('/').filter(Boolean) ?? [];
    if (parsed?.origin !== 'https://jobs.ashbyhq.com' || parsed.username || parsed.password ||
        parts.length !== 2 || parts[0]?.toLowerCase() !== postingTenant(provider, slug).toLowerCase() || !POSTING_ID.test(parts[1])) return null;
    externalId = parts[1];
    title = posting.title;
    location = posting.location;
    jd = plainText(posting.descriptionPlain, MAX_DESCRIPTION) || plainText(posting.descriptionHtml, MAX_DESCRIPTION, true);
    if (postingTenant(provider, slug) === 'cursor') {
      cursorPublicSlug = posting.cursorPublicSlug;
      url = cursorCareerUrl(cursorPublicSlug);
      if (!url) return null;
    } else {
      url = canonicalPostingUrl(provider, slug, externalId);
    }
  } else if (provider === 'moka') {
    if (typeof posting.id !== 'string' || !POSTING_ID.test(posting.id)) return null;
    externalId = posting.id;
    title = posting.title;
    location = posting.location;
    jd = plainText(posting.jd, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'feishu') {
    const rawId = posting.id != null ? String(posting.id) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.title;
    const cities = Array.isArray(posting.city_list) && posting.city_list.length
      ? posting.city_list.map(c => c?.name || c?.i18n_name).filter(Boolean)
      : [posting.city_info?.name || posting.city_info?.i18n_name].filter(Boolean);
    location = [...new Set(cities)].join(' / ');
    jd = [
      posting.description ? `岗位职责\n${plainText(posting.description, MAX_DESCRIPTION)}` : '',
      posting.requirement ? `岗位要求\n${plainText(posting.requirement, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'tencent') {
    const rawId = posting.PostId != null ? String(posting.PostId) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.RecruitPostName;
    location = [posting.LocationName, posting.BGName].filter(Boolean).join(' · ');
    jd = [
      posting.ProductName ? `所属团队：${plainText(posting.ProductName, 200)}` : '',
      posting.RequireWorkYearsName ? `工作经验：${plainText(posting.RequireWorkYearsName, 120)}` : '',
      posting.Responsibility ? `岗位职责\n${plainText(posting.Responsibility, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'meituan') {
    const rawId = posting.jobUnionId != null ? String(posting.jobUnionId) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.name;
    const cities = Array.isArray(posting.cityList) ? posting.cityList.map(c => c?.name).filter(Boolean) : [];
    location = [...new Set(cities)].slice(0, 4).join(' / ');
    jd = [
      posting.jobDuty ? plainText(posting.jobDuty, MAX_DESCRIPTION) : '',
      posting.jobRequirement ? plainText(posting.jobRequirement, MAX_DESCRIPTION) : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'jd') {
    const rawId = String(posting.reqNumber || posting.id || '');
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    publicId = slug === 'social' && /^\d+$/.test(String(posting.requirementId ?? '')) ? String(posting.requirementId) : undefined;
    title = posting.positionNameOpen || posting.positionName;
    location = [posting.workCity, posting.positionDeptName].filter(Boolean).join(' · ');
    jd = [
      posting.workContent ? `岗位职责\n${plainText(posting.workContent, MAX_DESCRIPTION)}` : '',
      posting.qualification ? `任职资格\n${plainText(posting.qualification, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId, publicId);
  } else if (provider === 'netease') {
    const rawId = posting.id != null ? String(posting.id) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.name;
    const cities = Array.isArray(posting.workPlaceNameList) ? posting.workPlaceNameList.filter(Boolean) : [];
    location = [...new Set([...cities, posting.productName].filter(Boolean))].join(' · ');
    jd = [
      posting.description ? `岗位职责\n${plainText(posting.description, MAX_DESCRIPTION)}` : '',
      posting.requirement ? `岗位要求\n${plainText(posting.requirement, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'alibaba') {
    const rawId = posting.id != null ? String(posting.id) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    deptCodes = posting.publicDeptCodes;
    title = posting.name;
    const cities = Array.isArray(posting.workLocations) ? posting.workLocations.filter(Boolean) : [];
    location = [...new Set([...cities, posting.departmentName || posting.department].filter(Boolean))].slice(0, 4).join(' · ');
    jd = [
      posting.description ? `岗位职责\n${plainText(posting.description, MAX_DESCRIPTION)}` : '',
      posting.requirement ? `岗位要求\n${plainText(posting.requirement, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId, publicId, deptCodes);
    if (!url) return null;
  } else if (provider === 'baidu') {
    const rawId = String(posting.postId || posting.jobId || '');
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.name;
    location = [posting.workPlace, posting.bgShortName || posting.orgName].filter(Boolean).join(' · ');
    jd = [
      posting.workContent ? `岗位职责\n${plainText(posting.workContent, MAX_DESCRIPTION)}` : '',
      posting.serviceCondition ? `岗位要求\n${plainText(posting.serviceCondition, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'xiaohongshu') {
    const rawId = posting.positionId != null ? String(posting.positionId) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.positionName;
    location = [posting.workplace, posting.directionName].filter(Boolean).join(' · ');
    jd = [
      posting.duty ? `岗位职责\n${plainText(posting.duty, MAX_DESCRIPTION)}` : '',
      posting.qualification ? `任职资格\n${plainText(posting.qualification, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'bilibili') {
    const rawId = posting.id != null ? String(posting.id) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.positionName;
    location = [posting.workLocation, posting.postCodeName].filter(Boolean).join(' · ');
    jd = plainText(posting.positionDescription, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId);
  } else if (provider === 'trip') {
    const rawId = String(posting.jobId || posting.id || '');
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    publicId = typeof posting.fromId === 'string' && POSTING_ID.test(posting.fromId) ? posting.fromId : undefined;
    if (slug === 'campus' && !publicId) return null;
    title = posting.jobTitle;
    location = [posting.cityName, posting.buName].filter(Boolean).join(' · ');
    jd = [
      posting.duty ? plainText(posting.duty, MAX_DESCRIPTION, true) : '',
      posting.requirements ? plainText(posting.requirements, MAX_DESCRIPTION, true) : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    url = canonicalPostingUrl(provider, slug, externalId, publicId);
  } else if (provider === 'mihoyo') {
    const rawId = posting.id != null ? String(posting.id) : '';
    if (!POSTING_ID.test(rawId)) return null;
    externalId = rawId;
    title = posting.title;
    const cities = Array.isArray(posting.addressDetailList)
      ? posting.addressDetailList.map(c => c?.addressDetail).filter(Boolean)
      : [];
    location = [...new Set([...cities, posting.competencyType].filter(Boolean))].join(' · ');
    const formatted = buildMihoyoJd(posting);
    jd = formatted.jd;
    mihoyoSummaryOnly = formatted.summaryOnly;
    url = canonicalPostingUrl(provider, slug, externalId);
  } else {
    return null;
  }

  title = plainText(title, 300, true).replace(/\s+/g, ' ');
  if (!title) return null;
  const sourceId = boardSourceId(source);
  return {
    id: `${sourceId}:${externalId}`, sourceId, provider, externalId, company, title,
    location: plainText(location, 300, true).replace(/\s+/g, ' '), jd, url,
    ...(publicId ? { publicId } : {}),
    ...(deptCodes ? { deptCodes } : {}),
    ...((provider === 'moka' || mihoyoSummaryOnly) ? { jdPreview: true } : {}),
    ...(cursorPublicSlug ? { cursorPublicSlug } : {}),
    firstSeenAt: checkedAt, verifiedAt: checkedAt, trust: 'untrusted_board_text',
  };
}

class BoardError extends Error {}

async function readBoundedResponse(endpoint, fetchImpl, options, mediaType) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchImpl(endpoint, {
    signal,
    method: options.method ?? 'GET',
    redirect: 'error',
    headers: { Accept: mediaType, ...options.headers },
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new BoardError(`HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes(mediaType) || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new BoardError('Unexpected response type');
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    void response.body.cancel().catch(() => {});
    throw new BoardError('Response exceeded the byte limit');
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new BoardError('Response exceeded the byte limit');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

async function fetchJsonBody(endpoint, fetchImpl, options = {}) {
  const text = await readBoundedResponse(endpoint, fetchImpl, options, 'application/json');
  try {
    return JSON.parse(text);
  } catch {
    throw new BoardError('Invalid job board JSON');
  }
}

async function fetchBoard(endpoint, fetchImpl) {
  return fetchJsonBody(endpoint, fetchImpl);
}

const GENERIC_SKIP_TERMS = new Set(['remote', '远程', '上海', '北京', '深圳', '杭州', '广州', '成都', '国内', '中国', 'shanghai', 'beijing', 'shenzhen', 'singapore']);

function pickSearchQueries(keywords = []) {
  const cleaned = (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k || '').trim())
    .filter(k => k.length >= 2 && k.length <= 32 && !GENERIC_SKIP_TERMS.has(k.toLowerCase()));
  const unique = [...new Set(cleaned)];
  return unique.length ? unique.slice(0, 6) : [''];
}

async function fetchFeishuPostings(source, fetchImpl, queries) {
  const target = resolveFeishuTarget(source.slug);
  const pathsToTry = target.websitePath ? [target.websitePath] : ['', 'index'];
  for (const websitePath of pathsToTry) {
    const csrfRes = await fetchImpl(`${target.origin}/api/v1/csrf/token`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'website-path': websitePath,
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!csrfRes.ok) {
      void csrfRes.body?.cancel().catch(() => {});
      throw new BoardError(`HTTP ${csrfRes.status}`);
    }
    const cookies = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
    const csrfBody = await csrfRes.json().catch(() => null);
    const token = csrfBody?.data?.token;
    if (!token) throw new BoardError('Feishu Hire CSRF token unavailable');

    const runQuery = async (keyword, recruitmentIds) => fetchJsonBody(`${target.origin}/api/v1/search/job/posts`, fetchImpl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': token,
        ...(cookies ? { Cookie: cookies } : {}),
        'website-path': websitePath,
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        keyword,
        limit: 30,
        offset: 0,
        job_category_id_list: [],
        location_code_list: [],
        subject_id_list: [],
        recruitment_id_list: recruitmentIds,
        portal_type: target.portalType ?? 2,
        portal_entrance: 1,
      }),
    });

    const collected = [];
    const readRows = body => {
      if (body?.code !== 0 || !Array.isArray(body?.data?.job_post_list)) throw new BoardError('Feishu Hire did not return a valid job list');
      return body.data.job_post_list.filter(row => acceptFeishuHiringRow(target, row));
    };
    const search = keyword => Promise.all((target.recruitmentGroups || [target.recruitmentIds || []]).map(group =>
      runQuery(target.mixed && target.scope === 'campus' && !keyword ? '校园招聘' : keyword, group)));
    let siteMissing = false;
    for (const kw of queries) {
      const responses = await search(kw);
      if (responses.some(body => body?.code === -9000003)) { siteMissing = true; break; }
      for (const body of responses) collected.push(...readRows(body));
    }
    if (siteMissing) continue;
    if (!collected.length && queries[0] !== '') {
      for (const body of await search('')) collected.push(...readRows(body));
    }
    return collected;
  }
  throw new BoardError('Feishu Hire board path not found');
}

const CHINESE_PROVIDERS = new Set([
  'feishu', 'tencent', 'meituan', 'jd', 'netease',
  'alibaba', 'baidu', 'xiaohongshu', 'bilibili', 'trip', 'mihoyo',
]);

async function fetchAlibabaPostings(source, fetchImpl, queries) {
  const campus = ['group-campus', 'aliyun-campus'].includes(source.slug);
  const origin = campus ? 'https://campus-talent.alibaba.com' : resolveAlibabaOrigin(source.slug);
  const pageUrl = origin + (campus ? '/campus/position' : '/off-campus/position-list');
  const pageRes = await fetchImpl(pageUrl, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    method: 'GET',
    redirect: 'error',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!pageRes.ok) {
    void pageRes.body?.cancel().catch(() => {});
    throw new BoardError(`HTTP ${pageRes.status}`);
  }
  const cookies = (pageRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]);
  const xsrf = cookies.find(c => c.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length) || '';
  void pageRes.body?.cancel().catch(() => {});
  const read = (path, data) => fetchJsonBody(`${origin}${path}?_csrf=${encodeURIComponent(xsrf)}`, fetchImpl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: pageUrl,
        ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
        ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}),
      },
      body: JSON.stringify(data),
    });
  if (campus) return campusAlibaba(source.slug, queries, read);
  const runQuery = async kw => {
    const body = await read('/position/search', {
        channel: 'group_official_site',
        language: 'zh',
        batchId: '',
        categories: '',
        deptCodes: [],
        key: kw || '',
        pageIndex: 1,
        pageSize: 30,
        regions: '',
        subCategories: '',
    });
    return Array.isArray(body?.content?.datas) ? body.content.datas : [];
  };
  const collected = [];
  for (const kw of queries) collected.push(...await runQuery(kw));
  if (!collected.length && queries[0] !== '') collected.push(...await runQuery(''));
  return collected;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }));
  return results;
}

function buildMihoyoJd(data) {
  if (!data || typeof data !== 'object') return { jd: '', summaryOnly: false };
  const desc = data.description ? plainText(data.description, MAX_DESCRIPTION) : '';
  const req = data.jobRequire ? plainText(data.jobRequire, MAX_DESCRIPTION) : '';
  if (desc || req) {
    const jd = [
      desc ? `岗位职责\n${desc}` : '',
      req ? `岗位要求\n${req}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    return { jd, summaryOnly: false };
  }
  const summary = data.jobSummary ? plainText(data.jobSummary, MAX_DESCRIPTION) : '';
  return { jd: summary, summaryOnly: Boolean(summary) };
}

async function fetchMihoyoPostings(source, fetchImpl, queries, existingJdIds = new Set()) {
  const hireType = source.slug === 'campus' ? 1 : 0;
  const projects = hireType === 1 ? await mihoyoGraduateProjects((url, options) => fetchJsonBody(url, fetchImpl, options)) : undefined;
  if (projects && !projects.length) return [];
  const runQuery = async kw => {
    const body = await fetchJsonBody('https://ats.openout.mihoyo.com/ats-portal/v1/job/list', fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ channelDetailIds: [1], hireType, ...(projects ? { projectIds: projects } : {}), pageNo: 1, pageSize: 30, jobName: kw || '' }),
    });
    if (!Array.isArray(body?.data?.list)) throw new BoardError('miHoYo job listings unavailable');
    return body.data.list;
  };
  const collected = [];
  for (const kw of queries) collected.push(...await runQuery(kw));
  if (!collected.length && queries[0] !== '') collected.push(...await runQuery(''));
  const unique = [];
  const seen = new Set();
  for (const item of collected) {
    const id = item?.id != null ? String(item.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  const sourceId = boardSourceId(source);
  const toEnrich = [];
  const skipped = [];
  for (const item of unique) {
    const oppId = `${sourceId}:${String(item.id)}`;
    if (existingJdIds?.has(oppId)) skipped.push(item);
    else toEnrich.push(item);
  }
  const enrichTargets = toEnrich.slice(0, 96);
  const overflow = toEnrich.slice(96);
  const enriched = await mapWithConcurrency(enrichTargets, 6, async item => {
    try {
      const detail = await fetchJsonBody('https://ats.openout.mihoyo.com/ats-portal/v1/job/info', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ id: String(item.id), channelDetailIds: [1], hireType }),
      });
      return detail?.data
        ? { ...item, description: detail.data.description, jobRequire: detail.data.jobRequire, jobSummary: detail.data.jobSummary ?? item.jobSummary }
        : item;
    } catch {
      return item;
    }
  });
  return [...enriched, ...skipped, ...overflow];
}

export function resolveOpportunityDetailTarget(opportunity) {
  const provider = String(opportunity?.provider || '').trim().toLowerCase();
  const externalId = String(opportunity?.externalId || '').trim();
  const sourceId = String(opportunity?.sourceId || '');
  const sourceSlug = sourceId.includes(':') ? sourceId.slice(sourceId.indexOf(':') + 1) : '';
  const slug = ['greenhouse', 'ashby', 'lever'].includes(provider) ? postingTenant(provider, sourceSlug) : sourceSlug;
  if (!provider || !POSTING_ID.test(externalId)) return null;
  if (['moka', 'greenhouse', 'ashby', 'lever'].includes(provider)) {
    return isValidBoardSlug(provider, slug) ? { provider, externalId, slug } : null;
  }
  if (provider === 'mihoyo' || provider === 'tencent') {
    return { provider, externalId, slug };
  }
  return null;
}

export function canFetchOpportunityDetail(opportunity) {
  return resolveOpportunityDetailTarget(opportunity) !== null;
}

export async function fetchOpportunityDetail(opportunity, { fetchImpl = fetch, mokaRenderer } = {}) {
  const target = resolveOpportunityDetailTarget(opportunity);
  if (!target) return { jd: '' };
  const { provider, externalId, slug } = target;

  if (provider === 'moka' && isValidBoardSlug(provider, slug)) {
    return { jd: plainText(await readMokaDetail(slug, externalId, fetchImpl, mokaRenderer), MAX_DESCRIPTION) };
  }
  if (provider === 'mihoyo') {
    const detail = await fetchJsonBody('https://ats.openout.mihoyo.com/ats-portal/v1/job/info', fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ id: externalId, channelDetailIds: [1], hireType: slug === 'campus' ? 1 : 0 }),
    });
    const formatted = buildMihoyoJd(detail?.data);
    return formatted.summaryOnly
      ? { jd: formatted.jd, jdPreview: true }
      : { jd: formatted.jd };
  }
  if (provider === 'greenhouse' && isValidBoardSlug(provider, slug)) {
    const body = await fetchJsonBody(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${encodeURIComponent(externalId)}`, fetchImpl);
    return { jd: plainText(body?.content, MAX_DESCRIPTION, true) };
  }
  if (provider === 'ashby' && isValidBoardSlug(provider, slug)) {
    const gql = await fetchJsonBody('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: { organizationHostedJobsPageName: slug, jobPostingId: externalId },
        query: 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { descriptionHtml } }',
      }),
    });
    const posting = gql?.data?.jobPosting;
    return { jd: plainText(posting?.descriptionHtml, MAX_DESCRIPTION, true) };
  }
  if (provider === 'lever' && isValidBoardSlug(provider, slug)) {
    const body = await fetchJsonBody(`https://api.lever.co/v0/postings/${slug}/${encodeURIComponent(externalId)}`, fetchImpl);
    const listText = Array.isArray(body?.lists)
      ? body.lists.map(l => `${l?.text ? `${l.text}\n` : ''}${plainText(l?.content, MAX_DESCRIPTION)}`).filter(Boolean).join('\n\n')
      : '';
    const jd = [
      plainText(body?.descriptionPlain || body?.description, MAX_DESCRIPTION),
      listText,
      plainText(body?.additionalPlain || body?.additional, MAX_DESCRIPTION),
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    return { jd };
  }
  if (provider === 'tencent' && slug === 'campus') {
    const body = await fetchJsonBody(`https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId=${externalId}`, fetchImpl);
    const data = body?.data;
    return { jd: [plainText(data?.desc, MAX_DESCRIPTION, true), plainText(data?.request, MAX_DESCRIPTION, true)].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION) };
  }
  if (provider === 'tencent') {
    const params = new URLSearchParams({ postId: externalId, language: 'zh-cn' });
    const body = await fetchJsonBody(`https://careers.tencent.com/tencentcareer/api/post/ByPostId?${params}`, fetchImpl);
    const data = body?.Data;
    const jd = [
      data?.Responsibility ? `岗位职责\n${plainText(data.Responsibility, MAX_DESCRIPTION)}` : '',
      data?.Requirement ? `岗位要求\n${plainText(data.Requirement, MAX_DESCRIPTION)}` : '',
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    return { jd };
  }
  return { jd: '' };
}

async function fetchChineseBoardPostings(source, fetchImpl, keywords, existingJdIds) {
  const queries = pickSearchQueries(keywords);
  const campus = source.slug === 'campus';
  const read = (url, options) => fetchJsonBody(url, fetchImpl, options);
  if (campus && source.provider === 'netease') return campusNetease(queries, read);
  if (source.provider === 'feishu') return fetchFeishuPostings(source, fetchImpl, queries);
  if (source.provider === 'alibaba') return fetchAlibabaPostings(source, fetchImpl, queries);
  if (source.provider === 'mihoyo') return fetchMihoyoPostings(source, fetchImpl, queries, existingJdIds);
  const collected = [];
  const fetchOne = async kw => {
    if (campus && source.provider === 'tencent') return campusTencent(kw, read);
    if (campus && source.provider === 'jd') return campusJd(kw, read);
    if (source.provider === 'tencent') {
      const params = new URLSearchParams({ pageIndex: '1', pageSize: '30', language: 'zh-cn', area: 'cn' });
      if (kw) params.set('keyword', kw);
      const body = await fetchJsonBody(`https://careers.tencent.com/tencentcareer/api/post/Query?${params}`, fetchImpl);
      return Array.isArray(body?.Data?.Posts) ? body.Data.Posts : [];
    }
    if (source.provider === 'meituan') {
      const body = await fetchJsonBody('https://zhaopin.meituan.com/api/official/job/getJobList', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ page: { pageNo: 1, pageSize: 30 }, jobShareType: '1', jobType: [{ code: campus ? '1' : '3', subCode: [] }], ...(kw ? { keywords: kw } : {}) }),
      });
      if (!Array.isArray(body?.data?.list)) throw new BoardError('Job board did not provide a postings list');
      return body.data.list;
    }
    if (source.provider === 'jd') {
      const form = new URLSearchParams({
        pageIndex: '1', pageSize: '30', workCityJson: '[]', jobTypeJson: '[]', depTypeJson: '[]',
        ...(kw ? { jobSearch: kw } : {}),
      });
      const body = await fetchJsonBody('https://zhaopin.jd.com/web/job/job_list', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        body: form.toString(),
      });
      return Array.isArray(body) ? body : [];
    }
    if (source.provider === 'netease') {
      const body = await fetchJsonBody('https://hr.163.com/api/hr163/position/queryPage', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ currentPage: 1, pageSize: 30, workType: '0', ...(kw ? { keyword: kw } : {}) }),
      });
      if (!Array.isArray(body?.data?.list)) throw new BoardError('Job board did not provide a postings list');
      return body.data.list;
    }
    if (source.provider === 'baidu') {
      const form = new URLSearchParams({
        recruitType: campus ? 'GRADUATE' : 'SOCIAL', pageSize: '20', curPage: '1', projectType: '',
        ...(kw ? { keyWord: kw } : { keyWord: '' }),
      });
      const body = await fetchJsonBody('https://talent.baidu.com/httservice/getPostListNew', fetchImpl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0',
          Referer: campus ? 'https://talent.baidu.com/jobs/list' : 'https://talent.baidu.com/jobs/social-list',
          Origin: 'https://talent.baidu.com',
        },
        body: form.toString(),
      });
      if (!Array.isArray(body?.data?.list)) throw new BoardError('Job board did not provide a postings list');
      return body.data.list;
    }
    if (source.provider === 'xiaohongshu') {
      const body = await fetchJsonBody('https://job.xiaohongshu.com/websiterecruit/position/pageQueryPosition', fetchImpl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          Referer: campus ? 'https://job.xiaohongshu.com/campus/theme' : 'https://job.xiaohongshu.com/social/position',
        },
        body: JSON.stringify({ recruitType: campus ? 'campus' : 'social', positionName: kw || '', pageNum: 1, pageSize: 30 }),
      });
      if (!Array.isArray(body?.data?.list)) throw new BoardError('Job board did not provide a postings list');
      if (!campus) return body.data.list;
      return body.data.list.filter(item => /校园招聘|校招|应届/.test(item.jobProjectName || '') ||
        /校园招聘|校招|应届|在校生|在读学生|毕业的同学/.test([item.positionName, item.qualification].join(' ')));
    }
    if (source.provider === 'bilibili') {
      const body = await fetchJsonBody(`https://jobs.bilibili.com/api/${campus ? 'campus' : 'srs'}/position/positionList`, fetchImpl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'X-AppKey': 'ops.ehr-api.auth',
          'X-UserType': '2',
          'X-CSRF': '1',
        },
        body: JSON.stringify({
          pageSize: 30, pageNum: 1, positionName: kw || '',
          postCode: [], postCodeName: '', workLocationList: [], workTypeList: campus ? [3] : [], recruitType: campus ? 1 : 0,
        }),
      });
      if (!Array.isArray(body?.data?.list)) throw new BoardError('Job board did not provide a postings list');
      return body.data.list;
    }
    if (source.provider === 'trip') {
      const body = await fetchJsonBody('https://job.ctrip.com/api/hrrecruit/getJobAd', fetchImpl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://job.ctrip.com/',
        },
        body: JSON.stringify({ condition: { category: campus ? 2 : 1, keyword: kw || '' }, pager: { index: '1', size: '30' }, head: { language: 'zh_CN', version: '1' } }),
      });
      if (!Array.isArray(body?.retValue?.recruitJobAdList)) throw new BoardError('Trip.com listings unavailable');
      return body.retValue.recruitJobAdList;
    }
    return [];
  };
  for (const kw of queries) collected.push(...await fetchOne(kw));
  if (!collected.length && queries[0] !== '') collected.push(...await fetchOne(''));
  return collected;
}

async function readPublicFeed(source, fetchImpl) {
  let partial = false;
  let body;
  try {
    body = await fetchBoard(boardEndpoint(source), fetchImpl);
  } catch (firstError) {
    // Very large Greenhouse / Ashby boards (e.g. Anthropic, Databricks, OpenAI) can exceed 8 MB with full HTML descriptions.
    // Fall back to lightweight listing endpoints while preserving the strict 8 MB limit.
    if (source.provider === 'greenhouse' && firstError instanceof BoardError && firstError.message === 'Response exceeded the byte limit') {
      partial = true;
      body = await fetchBoard(`https://boards-api.greenhouse.io/v1/boards/${source.slug}/jobs`, fetchImpl);
    } else if (source.provider === 'ashby' && firstError instanceof BoardError && firstError.message === 'Response exceeded the byte limit') {
      partial = true;
      const gql = await fetchJsonBody('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', fetchImpl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'ApiJobBoardWithTeams',
          variables: { organizationHostedJobsPageName: source.slug },
          query: 'query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id title locationName } } }',
        }),
      });
      const rows = Array.isArray(gql?.data?.jobBoard?.jobPostings) ? gql.data.jobBoard.jobPostings : null;
      body = rows ? {
        jobs: rows.map(row => ({
          isListed: true,
          jobUrl: `https://jobs.ashbyhq.com/${source.slug}/${row?.id ?? ''}`,
          title: row?.title ?? '',
          location: row?.locationName ?? '',
          descriptionPlain: '',
        })),
      } : null;
    } else {
      throw firstError;
    }
  }
  if (source.provider === 'ashby' && source.slug === 'cursor' && Array.isArray(body?.jobs) && body.jobs.length) {
    const html = await readBoundedResponse('https://cursor.com/careers', fetchImpl, {}, 'text/html');
    const links = cursorDirectoryLinks(html);
    if (!links.size) throw new BoardError('Cursor career directory did not provide verified posting links');
    const listed = body.jobs.filter(job => job?.isListed === true);
    const postings = listed.filter(job => links.has(job.jobUrl)).map(job => ({ ...job, cursorPublicSlug: links.get(job.jobUrl) }));
    return { postings, partial, coverage: postings.length < listed.length ? 'partial-directory-links' : undefined };
  }
  return { postings: source.provider === 'lever' ? body : body?.jobs, partial };
}

// Oversized boards have a lightweight index. Read the original JD for ambiguous student
// titles so an internship alone never establishes student eligibility.
async function completeStudentCandidates(rows, source, fetchImpl, checkedAt) {
  const candidates = rows.filter(row => /internship|\bintern\b|co[- ]?op|apprentice|graduate|early[- ](?:career|talent)/iu.test(row.title || row.text));
  const details = new Map();
  for (let i = 0; i < Math.min(24, candidates.length); i += 4) {
    await Promise.all(candidates.slice(i, Math.min(24, i + 4)).map(async row => {
      const job = normalizePosting(source, row, checkedAt);
      if (!job) return;
      const detail = await fetchOpportunityDetail(job, { fetchImpl }).catch(() => null);
      if (detail?.jd) details.set(row, { ...row, descriptionPlain: detail.jd, content: detail.jd });
    }));
  }
  return rows.map(row => details.get(row) || row);
}

async function collectBoard(source, fetchImpl, checkedAt, keywords = [], existingJdIds = undefined, mokaRenderer, feeds) {
  const sourceId = boardSourceId(source);
  try {
    let postings;
    let coverage;
    if (source.provider === 'moka') {
      const page = await readMokaJobs(source.slug, pickSearchQueries(keywords), fetchImpl, mokaRenderer);
      postings = page.jobs;
      coverage = page.coverage;
    } else if (CHINESE_PROVIDERS.has(source.provider)) {
      postings = await fetchChineseBoardPostings(source, fetchImpl, keywords, existingJdIds);
    } else {
      const tenant = postingTenant(source.provider, source.slug);
      const feedKey = source.provider + ':' + tenant;
      if (!feeds.has(feedKey)) feeds.set(feedKey, readPublicFeed({ ...source, slug: tenant }, fetchImpl));
      const feed = await feeds.get(feedKey);
      postings = feed.postings;
      coverage = feed.coverage;
      const preset = findCompanyBoard(source.provider, source.slug);
      if (preset?.filterHiringScope && Array.isArray(postings)) {
        if (feed.partial) {
          coverage = 'partial-hiring-scope';
          const details = feed.candidateDetails ??= completeStudentCandidates(postings, source, fetchImpl, checkedAt);
          postings = await details;
        }
        postings = postings.filter(post => classifyPublicPosting(source.provider, post) === preset.hiringScope);
      }
    }
    if (!Array.isArray(postings)) throw new BoardError('Job board did not provide a postings list');
    const unique = new Map();
    let rejected = 0;
    for (const input of postings) {
      // An unlisted Ashby posting is not a public opportunity on this board.
      if (source.provider === 'ashby' && input?.isListed === false) continue;
      const posting = normalizePosting(source, input, checkedAt);
      if (!posting) rejected += 1;
      else if (!unique.has(posting.id)) unique.set(posting.id, posting);
    }
    return {
      opportunities: [...unique.values()],
      result: { sourceId, status: 'ok', count: unique.size, rejected, checkedAt, ...(coverage ? { complete: false, coverage } : {}) },
    };
  } catch (error) {
    const failure = error instanceof BoardError ? error.message :
      error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Request timed out' : 'Request failed';
    return { opportunities: [], result: { sourceId, status: 'error', error: failure, checkedAt } };
  }
}

export async function collectOpportunities(sources, { fetchImpl = fetch, now = () => new Date(), keywords = [], existingJdIds, mokaRenderer } = {}) {
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) {
    throw new TypeError(`Configure at most ${MAX_SOURCES} public job boards.`);
  }
  const unique = new Map();
  for (const input of sources) {
    const source = validateBoardSource(input);
    const id = boardSourceId(source);
    if (!unique.has(id)) unique.set(id, source);
  }
  const checkedAt = new Date(now()).toISOString();
  const feeds = new Map();
  const boards = await Promise.all([...unique.values()].map(source => collectBoard(source, fetchImpl, checkedAt, keywords, existingJdIds, mokaRenderer, feeds)));
  return { opportunities: boards.flatMap(board => board.opportunities), results: boards.map(board => board.result) };
}

function optionalText(value, name, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${name}.`);
  }
  return value.trim();
}

function requiredText(value, name, max) {
  const text = optionalText(value, name, max);
  if (!text) throw new TypeError(`${name} is required.`);
  return text;
}

function identity(value, name) {
  if (typeof value !== 'string' || !RECEIPT_ID.test(value)) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function timestamp(value, name) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new TypeError(`${name} needs a timestamp with an explicit UTC offset.`);
  const [, year, month, day] = match;
  const lastDay = new Date(`${year}-${month}-01T00:00:00Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  const date = new Date(value);
  if (!Number.isFinite(+date) || !Number.isFinite(+lastDay) || +day < 1 || +day > lastDay.getUTCDate()) {
    throw new TypeError(`Invalid ${name}.`);
  }
  return date.toISOString();
}

const STAGES = new Map([
  ['opened', 'opened'],
  ['application_prepared', 'prepared'],
  ['contact_sent', 'contacted'],
  ['resume_sent', 'resume_sent'],
  ['application_submitted', 'submitted'],
  ['application_acknowledged', 'acknowledged'],
  ['interview_invited', 'invited'],
  ['interview_confirmed', 'interview_confirmed'],
  ['interview_completed', 'interview_completed'],
  ['offer_received', 'offer_received'],
  ['offer_accepted', 'offer_accepted'],
  ['started', 'started'],
  ['offer_declined', 'offer_declined'],
  ['rejected', 'rejected'],
  ['withdrawn', 'withdrawn'],
]);

const INTERVIEWS = new Set(['interview_invited', 'interview_confirmed', 'interview_completed']);
const TERMINAL = new Set(['started', 'offer_declined', 'rejected', 'withdrawn']);
const MILESTONES = new Set(['contact_sent', 'resume_sent', 'application_submitted', 'application_acknowledged', ...INTERVIEWS, 'offer_received', 'offer_accepted', 'started', 'offer_declined', 'rejected', 'withdrawn']);

export function validateReceipt(receipt) {
  if (!receipt || !STAGES.has(receipt.type) || !SOURCES.has(receipt.source)) throw new TypeError('Invalid receipt type or source.');
  const normalized = {
    id: identity(receipt.id, 'receipt id'),
    opportunityId: identity(receipt.opportunityId, 'opportunity id'),
    type: receipt.type,
    source: receipt.source,
    occurredAt: timestamp(receipt.occurredAt, 'occurredAt'),
  };
  if (MILESTONES.has(receipt.type)) {
    if (receipt.confirmed !== true) throw new TypeError('A candidate must confirm a milestone before it changes progress.');
    normalized.confirmed = true;
    normalized.evidence = requiredText(receipt.evidence, 'evidence reference', 500);
  }
  if (receipt.type === 'application_submitted' || receipt.type === 'resume_sent') {
    normalized.material = requiredText(receipt.material, 'material version', 200);
    if (receipt.materialId !== undefined && receipt.materialId !== null && String(receipt.materialId).trim() !== '') {
      normalized.materialId = identity(String(receipt.materialId).trim(), 'material id');
    }
    const materialVersion = optionalText(receipt.materialVersion, 'material version tag', 32);
    if (materialVersion) normalized.materialVersion = materialVersion;
    if (receipt.materialKind === 'resume' || receipt.materialKind === 'external') {
      normalized.materialKind = receipt.materialKind;
    } else if (normalized.materialId) {
      normalized.materialKind = 'resume';
    }
  }
  const notes = optionalText(receipt.notes, 'notes', 4000);
  if (notes) normalized.notes = notes;
  if (receipt.amendedAt !== undefined && receipt.amendedAt !== null && String(receipt.amendedAt).trim() !== '') {
    normalized.amendedAt = timestamp(receipt.amendedAt, 'amendedAt');
  }
  if (Array.isArray(receipt.amendments) && receipt.amendments.length > 0) {
    normalized.amendments = receipt.amendments.slice(-20).map(entry => {
      const prevMaterial = optionalText(entry?.material, 'previous material', 200);
      const prevMaterialId = entry?.materialId ? optionalText(String(entry.materialId), 'previous material id', 128) : '';
      const prevVersion = optionalText(entry?.materialVersion, 'previous version', 32);
      const prevKind = entry?.materialKind === 'resume' || entry?.materialKind === 'external' ? entry.materialKind : '';
      const prevNotes = optionalText(entry?.notes, 'previous notes', 4000);
      const prevAt = entry?.occurredAt ? timestamp(entry.occurredAt, 'amendment occurredAt') : normalized.occurredAt;
      return {
        ...(prevMaterial && { material: prevMaterial }),
        ...(prevMaterialId && { materialId: prevMaterialId }),
        ...(prevVersion && { materialVersion: prevVersion }),
        ...(prevKind && { materialKind: prevKind }),
        ...(prevNotes && { notes: prevNotes }),
        occurredAt: prevAt,
      };
    });
  }
  if (INTERVIEWS.has(receipt.type)) {
    normalized.round = requiredText(receipt.round, 'interview round', 100);
    if (receipt.interviewId !== undefined && receipt.interviewId !== null && String(receipt.interviewId).trim() !== '') {
      normalized.interviewId = identity(String(receipt.interviewId).trim(), 'interview id');
    }
    if (receipt.type === 'interview_confirmed' || receipt.startsAt !== undefined || receipt.endsAt !== undefined) {
      normalized.startsAt = timestamp(receipt.startsAt, 'startsAt');
      normalized.endsAt = timestamp(receipt.endsAt, 'endsAt');
      if (normalized.endsAt <= normalized.startsAt) throw new TypeError('Interview end must come after its start.');
      normalized.location = optionalText(receipt.location, 'interview location', 300);
    }
  }
  if (receipt.type === 'offer_received') {
    if (receipt.form !== 'written' && receipt.form !== 'verbal') throw new TypeError('Offer form must be written or verbal.');
    normalized.form = receipt.form;
    if (receipt.replyBy !== undefined) normalized.replyBy = timestamp(receipt.replyBy, 'replyBy');
  }
  return normalized;
}

export function projectOpportunityStage(receipts, opportunityId) {
  identity(opportunityId, 'opportunity id');
  if (!Array.isArray(receipts)) throw new TypeError('Receipts must be an array.');
  const unique = new Map();
  for (const input of receipts) {
    if (input?.opportunityId !== opportunityId) continue;
    const receipt = validateReceipt(input);
    const prior = unique.get(receipt.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) throw new TypeError('Conflicting receipts have the same id.');
    unique.set(receipt.id, receipt);
  }
  const order = [...STAGES.keys()];
  const ordered = [...unique.values()].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) || order.indexOf(a.type) - order.indexOf(b.type) || a.id.localeCompare(b.id));
  let last;
  for (const receipt of ordered) {
    if (last && TERMINAL.has(last.type)) continue;
    if (last && order.indexOf(receipt.type) < order.indexOf(last.type) &&
        !(INTERVIEWS.has(last.type) && INTERVIEWS.has(receipt.type))) continue;
    if (last?.type === 'offer_accepted' && receipt.type === 'offer_declined') continue;
    last = receipt;
  }
  return {
    stage: STAGES.get(last?.type) ?? 'discovered',
    lastReceiptId: last?.id ?? null,
    lastReceiptAt: last?.occurredAt ?? null,
    receiptCount: ordered.length,
  };
}

export function prepareApplicationHandoff(opportunity, { material, message = '' } = {}) {
  const { provider, slug, externalId, cursorUrl } = opportunityIdentity(opportunity);
  const url = cursorUrl || canonicalPostingUrl(provider, slug, externalId, opportunity.publicId, opportunity.deptCodes);
  if (opportunity.url !== url) throw new TypeError('The opportunity URL does not match its verified board posting.');
  return {
    status: 'draft_only', opportunityId: opportunity.id, url,
    company: requiredText(opportunity.company, 'company', 160), title: requiredText(opportunity.title, 'title', 300),
    material: requiredText(material, 'material version', 200), message: optionalText(message, 'message', 6000),
  };
}

function opportunityIdentity(opportunity) {
  const [provider, slug, externalId, ...rest] = identity(opportunity?.id, 'opportunity id').split(':');
  const url = typeof opportunity.url === 'string' ? URL.parse(opportunity.url) : null;
  if (!PROVIDERS.has(provider) || !isValidBoardSlug(provider, slug) || !POSTING_ID.test(externalId ?? '') || rest.length ||
      opportunity.provider !== provider || opportunity.sourceId !== `${provider}:${slug}` || opportunity.externalId !== externalId) {
    throw new TypeError('Invalid public board opportunity.');
  }
  if (provider === 'ashby' && postingTenant(provider, slug) === 'cursor' && Object.hasOwn(opportunity, 'cursorPublicSlug')) {
    const cursorUrl = cursorCareerUrl(opportunity.cursorPublicSlug);
    if (!cursorUrl || opportunity.url !== cursorUrl) throw new TypeError('Invalid public board opportunity.');
    return { provider, slug, externalId, cursorUrl };
  }
  if (provider === 'greenhouse' || provider === 'ashby' || provider === 'lever') {
    const label = url?.pathname.split('/')[1];
    if (label?.toLowerCase() !== postingTenant(provider, slug).toLowerCase() || !isValidBoardSlug(provider, label)) {
      throw new TypeError('Invalid public board opportunity.');
    }
    return { provider, slug: findCompanyBoard(provider, slug) ? slug : label, externalId };
  }
  const expected = canonicalPostingUrl(provider, slug, externalId, opportunity.publicId, opportunity.deptCodes);
  if (!url || opportunity.url !== expected) {
    throw new TypeError('Invalid public board opportunity.');
  }
  return { provider, slug, externalId };
}

function icsText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function icsTime(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldIcs(line) {
  let folded = '';
  let bytes = 0;
  for (const char of line) {
    const length = Buffer.byteLength(char);
    if (bytes + length > 75) {
      folded += '\r\n ';
      bytes = 1;
    }
    folded += char;
    bytes += length;
  }
  return folded;
}

export function createInterviewIcs(input, opportunity, { sequence = 0 } = {}) {
  const receipt = validateReceipt(input);
  if (receipt.type !== 'interview_confirmed' || receipt.opportunityId !== opportunity?.id) {
    throw new TypeError('Calendar export requires a confirmed interview for this opportunity.');
  }
  const company = requiredText(opportunity.company, 'company', 160);
  const title = requiredText(opportunity.title, 'title', 300);
  const groupKey = interviewGroupKey(receipt);
  const stableUid = createHash('sha256').update(`${opportunity.id}:${groupKey}`).digest('hex').slice(0, 24);
  const seqNum = Number.isInteger(sequence) && sequence >= 0 ? sequence : 0;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Career Agent//Interview//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${stableUid}@career-agent.local`, `SEQUENCE:${seqNum}`, `DTSTAMP:${icsTime(receipt.occurredAt)}`,
    `DTSTART:${icsTime(receipt.startsAt)}`, `DTEND:${icsTime(receipt.endsAt)}`,
    `SUMMARY:${icsText(`${company} · ${title} · ${receipt.round}`)}`,
    ...(receipt.location ? [`LOCATION:${icsText(receipt.location)}`] : []),
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR', '',
  ].map(foldIcs).join('\r\n');
}
