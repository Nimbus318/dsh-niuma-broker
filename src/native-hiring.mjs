// Both halves of a company entry point to the company's own public recruiting site.
const pair = (experienced, campus, slug = 'campus') => ({ experienced: { host: experienced }, campus: { slug, host: campus } });
export const NATIVE_HIRING_CHANNELS = Object.freeze({
  'feishu:bytedance': pair('jobs.bytedance.com/experienced/position', 'jobs.bytedance.com/campus/position', 'bytedance__campus'),
  'tencent:social': pair('careers.tencent.com/search.html', 'join.qq.com/post.html'),
  'alibaba:group': pair('talent-holding.alibaba.com/off-campus/position-list', 'campus-talent.alibaba.com/campus/position?circleCode=60000', 'group-campus'),
  'alibaba:aliyun': pair('careers.aliyun.com/off-campus/position-list', 'campus-talent.alibaba.com/campus/position?circleCode=60002', 'aliyun-campus'),
  'baidu:social': pair('talent.baidu.com/jobs/social-list', 'talent.baidu.com/jobs/list'),
  'meituan:social': pair('zhaopin.meituan.com/web/social', 'zhaopin.meituan.com/web/campus'),
  'xiaohongshu:social': pair('job.xiaohongshu.com/social/position', 'job.xiaohongshu.com/campus/theme'),
  'jd:social': pair('zhaopin.jd.com/web/job/job_info_list/3', 'campus.jd.com/#/jobs?type=present'),
  'netease:social': pair('hr.163.com/job-list.html?workType=0', 'campus.163.com/app/job'),
  'bilibili:social': pair('jobs.bilibili.com/social/positions', 'jobs.bilibili.com/campus/positions?type=3'),
  'trip:social': pair('job.ctrip.com/#/experienced/jobList', 'job.ctrip.com/#/campus/jobList'),
  'mihoyo:social': pair('jobs.mihoyo.com/#/position', 'jobs.mihoyo.com/#/campus'),
});

function rows(value, message) {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function postJson(data) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

export async function campusTencent(keyword, read) {
  const result = await read('https://join.qq.com/api/v1/position/searchPosition', postJson({
    projectIdList: [], projectMappingIdList: [1], keyword, bgList: [], workCountryType: 0,
    workCityList: [], recruitCityList: [], positionFidList: [], pageIndex: 1, pageSize: 30,
  }));
  return rows(result.status === 0 && result.data?.positionList, 'Tencent graduate listings unavailable')
    .map(item => ({ PostId: item.postId, RecruitPostName: item.positionTitle, LocationName: item.workCities, BGName: item.bgs }));
}

export async function campusJd(keyword, read) {
  const result = await read('https://campus.jd.com/api/wx/position/page?type=present', postJson({
    pageIndex: 0, pageSize: 30,
    parameter: { positionName: keyword, planIdList: [], jobDirectionCodeList: [], workCityCodeList: [], positionDeptList: [] },
  }));
  return rows(result.success && result.body?.items, 'JD graduate listings unavailable').map(item => ({
    ...item, reqNumber: item.publishId, workCity: [...new Set((item.requirementVoList ?? []).map(plan => plan.workCity).filter(Boolean))].join(' / '),
  }));
}

const neteaseOrigins = { group: 'https://campus.163.com', game: 'https://campus.game.163.com' };
export function neteaseCampusDetail(externalId) {
  const [, site, project, job] = /^(group|game)_(\d+)_(\d+)$/.exec(externalId) ?? [];
  return site ? `${neteaseOrigins[site]}/app/detail/index?id=${job}&projectId=${project}` : '';
}

// The Leihuo site publishes a dedicated EHR project per graduate intake.
// Match both the current navigation label and each result's eligible cohort.
const leihuoGraduateProjects = { '2027': '77' };
async function campusLeihuo(entry, queries, read) {
  const cohort = /(?:20\d{2})(?=届)/.exec(entry.title)?.[0];
  const projectId = leihuoGraduateProjects[cohort];
  if (!projectId) return [];
  const result = [];
  for (const keyword of queries) {
    const params = new URLSearchParams({ project_id: projectId, job_name: keyword, page_size: '30', page_number: '1' });
    const page = await read(`https://xiaozhao.leihuo.netease.com/api/apply/job/list/show?${params}`);
    const list = rows(page.status === 200 && page.data?.apply_job_list, 'Leihuo graduate listings unavailable');
    for (const job of list) {
      if (!job.job_target?.includes(cohort + '届') || String(job.ehr_project_id) !== projectId || !/^\d+$/.test(String(job.ehr_job_id))) continue;
      result.push({ id: `group_${projectId}_${job.ehr_job_id}`, name: job.job_name, workPlaceNameList: [job.work_place_name],
        description: job.job_description, requirement: job.job_requirement });
    }
  }
  return result;
}

export async function campusNetease(queries, read) {
  const navigation = await read(neteaseOrigins.group + '/api/campuspc/project/navigation/list');
  const graduate = rows(navigation.code === 200 && navigation.data, 'NetEase project navigation unavailable').find(tab => tab.title === '应届生');
  const projects = [];
  let leihuo;
  for (const entry of graduate?.children ?? []) {
    const url = URL.parse(entry.link, neteaseOrigins.group);
    if (url?.origin === 'https://leihuo.163.com' && url.pathname === '/campus/' && /^#\/full(?:\?|$)/.test(url.hash)) leihuo = entry;
    const site = Object.keys(neteaseOrigins).find(key => neteaseOrigins[key] === url?.origin);
    const project = url?.searchParams.get('id');
    if (site && url.pathname === '/app/job/position' && /^\d+$/.test(project ?? '')) projects.push({ site, project });
  }

  const byProject = await Promise.all(projects.map(async ({ site, project }) => {
    const collected = [];
    for (const keyword of queries) {
      const params = new URLSearchParams({ projectId: project, currentPage: '1', pageSize: '30', keyword });
      const result = await read(`${neteaseOrigins[site]}/api/campuspc/position/getJobList?${params}`);
      const list = rows(result.code === 200 && result.data?.list, 'NetEase graduate listings unavailable');
      collected.push(...list.filter(item => String(item.projectId) === project && /^\d+$/.test(String(item.id))).map(item => ({
        id: `${site}_${project}_${item.id}`, name: item.positionName, workPlaceNameList: [item.workPlaceName],
        description: item.positionDescription, requirement: item.positionRequirement,
      })));
    }
    return collected;
  }));
  if (leihuo) byProject.push(await campusLeihuo(leihuo, queries, read));
  return byProject.flat();
}

export async function campusAlibaba(slug, queries, read) {
  const circles = { 'group-campus': '60000', 'aliyun-campus': '60002' };
  const circle = circles[slug];
  if (!circle) throw new Error('Unknown Alibaba graduate business group');
  const batches = await read('/searchCondition/listBatch', {});
  const graduate = rows(batches.success && batches.content?.graduate, 'Alibaba graduate batches unavailable');
  const postings = [];
  for (const batch of graduate) {
    if (batch.type !== 'graduate' || !/^\d+$/.test(String(batch.id))) continue;
    const base = { channel: 'campus_group_official_site', language: 'zh', batchId: batch.id };
    const conditions = await read('/searchCondition/list', base);
    const groups = rows(conditions.success && conditions.content?.searchItems, 'Alibaba business groups unavailable')
      .find(item => item.type === 'customDept')?.items ?? [];
    const children = groups.find(item => String(item.value) === circle)?.children ?? [];
    const deptCodes = children.map(item => item.value).filter(value => typeof value === 'string' && /^[\w-]+$/.test(value));
    if (!deptCodes.length) continue;
    for (const key of queries) {
      const page = await read('/position/search', { ...base, key, pageIndex: 1, pageSize: 30, customDeptCode: deptCodes.join(',') });
      if (page.success && page.content?.totalCount === 0) continue;
      const list = rows(page.success && page.content?.datas, 'Alibaba graduate listings unavailable');
      postings.push(...list.map(item => ({ ...item, publicDeptCodes: deptCodes.join(',') })));
    }
  }
  return postings;
}

export async function mihoyoGraduateProjects(read) {
  const response = await read('https://ats.openout.mihoyo.com/ats-portal/v1/job/project_count/list', postJson({ channelDetailIds: [1], hireType: 1 }));
  return rows(response.code === 0 && response.data, 'miHoYo graduate projects unavailable')
    .filter(item => /应届/.test(item.projectName)).flatMap(item => item.projectIdList ?? []).filter(Number.isSafeInteger);
}

// Shared JD URLs without a channel identifier cannot determine the hiring scope.
export function parseNativeHiringUrl(input) {
  const url = input instanceof URL ? input : URL.parse(input);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const path = url.pathname;
  const target = (provider, slug) => ({ provider, slug });
  const scope = value => value ? 'campus' : 'social';
  switch (url.hostname) {
    case 'jobs.bytedance.com':
      return target('feishu', /^\/campus(?:\/|$)/.test(path) ? 'bytedance__campus' : 'bytedance');
    case 'join.qq.com': return target('tencent', 'campus');
    case 'careers.tencent.com': return target('tencent', 'social');
    case 'campus-talent.alibaba.com': {
      const group = { '60000': 'group-campus', '60002': 'aliyun-campus' }[url.searchParams.get('circleCode')];
      return ['group-campus', 'aliyun-campus'].includes(group) ? target('alibaba', group) : null;
    }
    case 'careers.aliyun.com':
    case 'talent-holding.alibaba.com': {
      const group = url.hostname === 'careers.aliyun.com' ? 'aliyun' : 'group';
      return target('alibaba', /^\/campus(?:\/|$)/.test(path) ? group + '-campus' : group);
    }
    case 'talent.baidu.com':
      return target('baidu', scope(/^\/jobs\/(?:list(?:\/|$)|detail\/(?:GRADUATE|INTERN)\/)/i.test(path)));
    case 'zhaopin.meituan.com':
      if (/^\/web\/position\/detail(?:\/|$)/.test(path)) return null;
      return target('meituan', scope(/^\/web\/campus(?:\/|$)/.test(path)));
    case 'job.xiaohongshu.com': return target('xiaohongshu', scope(/^\/campus(?:\/|$)/.test(path)));
    case 'campus.jd.com': return target('jd', 'campus');
    case 'zhaopin.jd.com': return target('jd', 'social');
    case 'leihuo.163.com': return path.startsWith('/campus/') ? target('netease', 'campus') : null;
    case 'campus.game.163.com':
    case 'campus.163.com': return target('netease', 'campus');
    case 'hr.163.com': return target('netease', 'social');
    case 'jobs.bilibili.com': return target('bilibili', scope(/^\/campus(?:\/|$)/.test(path)));
    case 'job.ctrip.com':
      return target('trip', scope(/^#\/campus(?:\/|$)/.test(url.hash) || /^\/campus(?:\/|$)/.test(path)));
    case 'jobs.mihoyo.com': return target('mihoyo', scope(/^#\/campus(?:\/|$)/.test(url.hash)));
    default: return null;
  }
}

export function alibabaCampusJobUrl(externalId, codes) {
  if (typeof codes !== 'string' || codes.length > 1600 || !/^[\w-]+(?:,[\w-]+)*$/.test(codes)) return '';
  return `https://campus-talent.alibaba.com/campus/position/${externalId}?deptCodes=${encodeURIComponent(codes)}`;
}
