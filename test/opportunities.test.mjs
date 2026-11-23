import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectOpportunities, createInterviewIcs, fetchOpportunityDetail, prepareApplicationHandoff,
  projectOpportunityStage, validateBoardSource, validateReceipt,
} from '../src/opportunities.mjs';

const now = () => '2026-11-19T00:00:00.000Z';
const sources = [
  { provider: 'greenhouse', slug: 'example', company: 'Example' },
  { provider: 'ashby', slug: 'Example', company: 'Example' },
  { provider: 'lever', slug: 'example', company: 'Example' },
];
const greenhousePosting = {
  id: 1001, title: 'AI <em>Product</em> Manager', location: { name: '上海' },
  content: '&lt;p&gt;Lead AI platform work&lt;/p&gt;&lt;script&gt;doNotExecute()&lt;/script&gt;',
  absolute_url: 'https://untrusted.example/suspicious',
};
const json = value => Response.json(value);

test('reads only documented board endpoints, normalizes JD text and removes duplicates', async () => {
  const endpoints = [];
  const result = await collectOpportunities([...sources, sources[0]], { now, fetchImpl: async (url, options) => {
    endpoints.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!options.headers.Authorization);
    if (url.includes('greenhouse')) return json({ jobs: [greenhousePosting, greenhousePosting, { id: -1, title: 'Invalid' }] });
    if (url.includes('ashby')) return json({ jobs: [
      { jobUrl: 'https://jobs.ashbyhq.com/Example/abc-123?utm_campaign=tracker', title: 'Team Lead', isListed: true, descriptionPlain: 'A team lead role' },
      { jobUrl: 'https://jobs.ashbyhq.com/Example/unlisted', title: 'Unlisted', isListed: false },
      { jobUrl: 'https://evil.example/Example/wrong', title: 'Fake link', isListed: true },
    ] });
    return json([{ id: 'xyz-123', text: '顾问', descriptionPlain: '岗位描述', lists: [{ text: '要求', content: '<li>GPU</li>' }] }]);
  } });
  assert.deepEqual(endpoints, [
    'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true',
    'https://api.ashbyhq.com/posting-api/job-board/Example',
    'https://api.lever.co/v0/postings/example?mode=json',
  ]);
  assert.deepEqual(result.results.map(({ status, count, rejected }) => [status, count, rejected]), [
    ['ok', 1, 1], ['ok', 1, 1], ['ok', 1, 0],
  ]);
  const [greenhouse, ashby, lever] = result.opportunities;
  assert.equal(greenhouse.id, 'greenhouse:example:1001');
  assert.equal(greenhouse.title, 'AI Product Manager');
  assert.equal(greenhouse.jd, 'Lead AI platform work');
  assert.equal(greenhouse.trust, 'untrusted_board_text');
  assert.equal(greenhouse.verifiedAt, now());
  assert.equal(greenhouse.url, 'https://job-boards.greenhouse.io/example/jobs/1001');
  assert.equal(ashby.url, 'https://jobs.ashbyhq.com/Example/abc-123');
  assert.equal(lever.jd, '岗位描述\n\n要求\nGPU');
  assert.equal(prepareApplicationHandoff(ashby, { material: 'resume-v2' }).status, 'draft_only');
});

test('rejects URL injection and isolates transport and byte limit failures from good boards', async () => {
  for (const slug of ['../x', 'https://evil.example', 'hi?path=/admin', 'hi%2Fx']) {
    assert.throws(() => validateBoardSource({ provider: 'greenhouse', slug }), /board slug/);
  }
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
  const res = await collectOpportunities(sources, { now, fetchImpl: async url => {
    if (url.includes('greenhouse')) return json({ jobs: [greenhousePosting] });
    if (url.includes('ashby')) return new Response(bytes, { headers: { 'content-type': 'application/json' } });
    return new Response('Rate limited', { status: 429 });
  } });
  assert.equal(res.opportunities.length, 1);
  assert.deepEqual(res.results.map(({ status, error }) => [status, error]), [
    ['ok', undefined], ['error', 'Response exceeded the byte limit'], ['error', 'HTTP 429'],
  ]);
});

const opportunity = { id: 'greenhouse:example:1001', company: '示例,公司', title: 'AI Product Manager' };
const receipt = (type, hour, additions = {}) => ({
  id: `receipt-${hour}-${type}`, opportunityId: opportunity.id, type, source: 'manual',
  occurredAt: `2026-11-19T${String(hour).padStart(2, '0')}:00:00+08:00`,
  confirmed: true, evidence: 'Candidate reviewed this receipt', ...additions,
});

test('uses confirmed milestones, recognizes separate rounds and does not regress on late receipts', () => {
  const open = receipt('opened', 8);
  const submit = receipt('application_submitted', 9, { material: 'resume-v3' });
  const round1 = receipt('interview_completed', 10, { round: 'First round' });
  const round2 = receipt('interview_invited', 11, { round: 'Second round', source: 'email' });
  const acknowledged = receipt('application_acknowledged', 12, { source: 'portal' });
  const offer = receipt('offer_received', 13, { form: 'verbal' });
  const accepted = receipt('offer_accepted', 14);
  const started = receipt('started', 15);
  assert.equal(projectOpportunityStage([], opportunity.id).stage, 'discovered');
  assert.equal(projectOpportunityStage([open], opportunity.id).stage, 'opened');
  assert.equal(projectOpportunityStage([submit, open], opportunity.id).stage, 'submitted');
  assert.equal(projectOpportunityStage([round2, round1, acknowledged, submit], opportunity.id).stage, 'invited');
  assert.equal(projectOpportunityStage([offer, round2], opportunity.id).stage, 'offer_received');
  assert.equal(projectOpportunityStage([accepted, offer], opportunity.id).stage, 'offer_accepted');
  assert.deepEqual(projectOpportunityStage([started, accepted, started], opportunity.id), {
    stage: 'started', lastReceiptId: started.id, lastReceiptAt: '2026-11-19T07:00:00.000Z', receiptCount: 2,
  });
  assert.throws(() => validateReceipt({ ...offer, confirmed: false }), /must confirm/);
  assert.throws(() => validateReceipt({ ...offer, occurredAt: '2026-02-31T10:00:00+08:00' }), /Invalid occurredAt/);
  assert.throws(() => validateReceipt({ ...offer, occurredAt: '2026-11-19T10:00:00' }), /explicit UTC offset/);
  assert.throws(() => projectOpportunityStage([offer, { ...offer, form: 'written' }], opportunity.id), /Conflicting receipts/);
});

test('creates a manual handoff and an inert, escaped calendar export only for the right confirmed interview', async () => {
  const { opportunities: [job] } = await collectOpportunities([sources[0]], { now, fetchImpl: async () => json({ jobs: [greenhousePosting] }) });
  const draft = prepareApplicationHandoff(job, { material: 'resume-v3', message: 'Draft outreach' });
  assert.equal(draft.url, job.url);
  assert.equal(draft.material, 'resume-v3');
  assert.throws(() => prepareApplicationHandoff({ ...job, url: 'https://untrusted.example' }, { material: 'resume-v3' }), /Invalid public board opportunity/);
  const confirmed = receipt('interview_confirmed', 10, {
    source: 'email', round: '第一轮', startsAt: '2026-11-20T10:00:00+08:00', endsAt: '2026-11-20T11:00:00+08:00',
    location: 'Meeting room; 4\r\nATTENDEE:mailto:evil@example.com',
  });
  const ics = createInterviewIcs(confirmed, opportunity);
  assert.match(ics, /DTSTART:20261120T020000Z\r\nDTEND:20261120T030000Z/);
  assert.match(ics, /SUMMARY:示例\\,公司 · AI Product Manager · 第一轮/);
  assert.ok(!ics.includes('\r\nATTENDEE:'));
  assert.ok(!ics.includes('METHOD:REQUEST'));
  assert.throws(() => createInterviewIcs({ ...confirmed, type: 'interview_invited' }, opportunity), /requires a confirmed interview/);
  assert.throws(() => createInterviewIcs(confirmed, { ...opportunity, id: 'manual:different' }), /for this opportunity/);
});

test('supports domestic Chinese big-tech public boards (Feishu Hire, Tencent, Meituan, JD, NetEase) with canonical handoff', async () => {
  const cnSources = [
    { provider: 'feishu', slug: 'bytedance', company: '字节跳动' },
    { provider: 'tencent', slug: 'social', company: '腾讯' },
    { provider: 'meituan', slug: 'social', company: '美团' },
    { provider: 'jd', slug: 'social', company: '京东' },
    { provider: 'netease', slug: 'social', company: '网易' },
  ];
  const res = await collectOpportunities(cnSources, {
    now,
    keywords: ['AI Infra'],
    fetchImpl: async url => {
      if (url.includes('csrf/token')) return json({ code: 0, data: { token: 'tok-123' } });
      if (url.includes('jobs.bytedance.com/api/v1/search')) {
        return json({ code: 0, data: { job_post_list: [{ id: '762956', title: 'AI Infra 工程师', city_info: { name: '上海' }, description: '负责推理调度', requirement: '熟悉 Go' }] } });
      }
      if (url.includes('careers.tencent.com')) {
        return json({ Code: 200, Data: { Posts: [{ PostId: '206670', RecruitPostName: '混元 AI Infra', LocationName: '深圳', BGName: 'TEG', Responsibility: '大模型训练平台' }] } });
      }
      if (url.includes('zhaopin.meituan.com')) {
        return json({ data: { list: [{ jobUnionId: '469732', name: 'AI 推理工程师', cityList: [{ name: '北京市' }], jobDuty: '推理加速', jobRequirement: '熟悉 CUDA' }] } });
      }
      if (url.includes('zhaopin.jd.com')) {
        return json([{ reqNumber: 'JDZP0001', positionNameOpen: 'AI Infra 专家', workCity: '北京市', positionDeptName: '京东零售', workContent: '推理引擎', qualification: '3年以上' }]);
      }
      if (url.includes('hr.163.com')) {
        return json({ code: 200, data: { list: [{ id: 74021, name: 'AI Infra 研发', workPlaceNameList: ['杭州市'], productName: '网易有道', description: '平台研发', requirement: '熟悉 K8s' }] } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  assert.equal(res.opportunities.length, 5);
  assert.ok(res.results.every(r => r.status === 'ok' && r.count === 1));
  for (const job of res.opportunities) {
    const handoff = prepareApplicationHandoff(job, { material: '林予安 · 通用简历' });
    assert.equal(handoff.status, 'draft_only');
    assert.equal(handoff.url, job.url);
    assert.throws(() => prepareApplicationHandoff({ ...job, url: 'https://evil.example/phish' }, { material: 'v1' }), /Invalid public board opportunity/);
  }
});

test('keeps AGIBOT social and campus searches and JD handoffs on their own portals', async () => {
  for (const portal of ['socialrecruitment', 'campusrecruitment']) {
    const source = { provider: 'feishu', slug: 'agirobot__' + portal, company: '智元机器人' };
    const requests = [];
    const { opportunities, results } = await collectOpportunities([source], {
      now, keywords: ['具身智能'], fetchImpl: async (url, options) => {
        const { origin, pathname } = new URL(url);
        assert.equal(origin, 'https://agirobot.jobs.feishu.cn');
        assert.equal(options.headers['website-path'], portal);
        const keyword = options.body && JSON.parse(options.body).keyword;
        requests.push([pathname, keyword]);
        if (pathname.endsWith('/csrf/token')) return json({ data: { token: 'token' } });
        const rows = keyword ? [] : [{ id: '123456', title: '具身智能工程师' }];
        return json({ code: 0, data: { job_post_list: rows } });
      },
    });
    assert.deepEqual(requests, [
      ['/api/v1/csrf/token', undefined],
      ['/api/v1/search/job/posts', '具身智能'],
      ['/api/v1/search/job/posts', ''],
    ]);
    assert.equal(results[0].sourceId, 'feishu:' + source.slug);
    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].id, 'feishu:' + source.slug + ':123456');
    const handoff = prepareApplicationHandoff(opportunities[0], { material: 'v1' });
    assert.equal(handoff.url, 'https://agirobot.jobs.feishu.cn/' + portal + '/position/123456/detail');
  }
});

test('reports a missing named Feishu portal without switching the recruitment channel', async () => {
  const requests = [];
  const { opportunities, results } = await collectOpportunities([
    { provider: 'feishu', slug: 'agirobot__socialrecruitment', company: '智元机器人' },
  ], { now, fetchImpl: async (url, options) => {
    requests.push(options.headers['website-path']);
    return json(url.endsWith('/csrf/token') ? { data: { token: 'token' } } : { code: -9000003 });
  } });
  assert.deepEqual(requests, ['socialrecruitment', 'socialrecruitment']);
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /board path not found/);
  assert.deepEqual(opportunities, []);
});

test('supports expanded Chinese big-tech boards (Alibaba, Aliyun, Baidu, Xiaohongshu, Bilibili, Trip, MiHoYo) and large Ashby fallback', async () => {
  const expanded = [
    { provider: 'alibaba', slug: 'group', company: '阿里巴巴集团' },
    { provider: 'alibaba', slug: 'aliyun', company: '阿里云' },
    { provider: 'baidu', slug: 'social', company: '百度' },
    { provider: 'xiaohongshu', slug: 'social', company: '小红书' },
    { provider: 'bilibili', slug: 'social', company: '哔哩哔哩' },
    { provider: 'trip', slug: 'social', company: '携程' },
    { provider: 'mihoyo', slug: 'social', company: '米哈游' },
    { provider: 'ashby', slug: 'openai', company: 'OpenAI' },
  ];
  const oversized = new Uint8Array(8 * 1024 * 1024 + 16);
  const res = await collectOpportunities(expanded, {
    now,
    keywords: ['AI'],
    fetchImpl: async url => {
      if (url.includes('/off-campus/position-list')) {
        return new Response('<html></html>', { status: 200, headers: { 'set-cookie': 'XSRF-TOKEN=xsrf-tok; Path=/' } });
      }
      if (url.includes('talent-holding.alibaba.com/position/search')) {
        return json({ content: { datas: [{ id: 10005264, name: 'AI 系统专家', workLocations: ['杭州'], department: '基础架构', description: '负责 AI 平台', requirement: '熟悉 Go' }] } });
      }
      if (url.includes('careers.aliyun.com/position/search')) {
        return json({ content: { datas: [{ id: 10009999, name: '阿里云 AI Agent 专家', workLocations: ['北京'], description: '负责百炼平台', requirement: '3年以上' }] } });
      }
      if (url.includes('talent.baidu.com/httservice/getPostListNew')) {
        return json({ status: 'ok', data: { list: [{ postId: '70a4972a-3131-41b6-9fb5-b7a989948823', name: '文心大模型推理工程师', workPlace: '北京市', bgShortName: 'TPG', workContent: '负责推理优化', serviceCondition: '熟悉 CUDA' }] } });
      }
      if (url.includes('job.xiaohongshu.com')) {
        return json({ data: { list: [{ positionId: 21369, positionName: 'AI 应用架构工程师', workplace: '上海市', duty: '搭建 Agent 底座', qualification: '5年以上' }] } });
      }
      if (url.includes('jobs.bilibili.com')) {
        return json({ data: { list: [{ id: 31441, positionName: 'AI 视频算法工程师', workLocation: '上海', positionDescription: '负责多模态生成' }] } });
      }
      if (url.includes('job.ctrip.com')) {
        return json({ retValue: { recruitJobAdList: [{ jobId: '74f709e5-b26a-4ad0-96a5-fc9e5fef2d21', jobTitle: 'AI 搜索引擎专家', cityName: 'Shanghai', buName: 'Hotel', requirements: '<p>熟悉检索与 LLM</p>' }] } });
      }
      if (url.includes('ats.openout.mihoyo.com/ats-portal/v1/job/list')) {
        return json({ code: 0, data: { list: [{ id: '7783', title: 'AI 应用产品经理', addressDetailList: [{ addressDetail: '上海' }], competencyType: '产品类' }] } });
      }
      if (url.includes('ats.openout.mihoyo.com/ats-portal/v1/job/info')) {
        return json({ code: 0, data: { id: '7783', description: '负责 AI 效率工具', jobRequire: '热爱 AI' } });
      }
      if (url.includes('api.ashbyhq.com/posting-api/job-board/openai')) {
        return new Response(oversized, { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('jobs.ashbyhq.com/api/non-user-graphql')) {
        return json({ data: { jobBoard: { jobPostings: [{ id: 'fa49d49e-0a9b-4927-898e-2e3faa6be981', title: 'Research Engineer, Inference', locationName: 'San Francisco' }] } } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  assert.equal(res.opportunities.length, 8);
  assert.ok(res.results.every(r => r.status === 'ok' && r.count === 1));
  const mihoyo = res.opportunities.find(o => o.provider === 'mihoyo');
  assert.match(mihoyo.jd, /AI 效率工具/);
  const openai = res.opportunities.find(o => o.provider === 'ashby');
  assert.equal(openai.url, 'https://jobs.ashbyhq.com/openai/fa49d49e-0a9b-4927-898e-2e3faa6be981');
  for (const job of res.opportunities) {
    assert.equal(prepareApplicationHandoff(job, { material: 'v1' }).url, job.url);
  }
});

test('mihoyo enriches beyond the first 12 postings, skips already-cached IDs, and supports on-demand JD detail hydration', async () => {
  const list = Array.from({ length: 20 }, (_, i) => ({
    id: String(8700 + i),
    title: i === 15 ? '大模型推理平台工程师(资源调度方向)' : `工程岗 ${i}`,
    addressDetailList: [{ addressDetail: '上海' }],
    competencyType: '程序&技术类',
  }));
  const infoHits = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('ats.openout.mihoyo.com/ats-portal/v1/job/list')) {
      return json({ code: 0, data: { list } });
    }
    if (url.includes('ats.openout.mihoyo.com/ats-portal/v1/job/info')) {
      const parsed = JSON.parse(opts.body);
      infoHits.push(parsed.id);
      return json({
        code: 0,
        data: {
          id: parsed.id,
          description: `岗位 ${parsed.id} 核心职责：大模型推理集群资源调度`,
          jobRequire: '熟悉 Kubernetes 与 vLLM',
        },
      });
    }
    return new Response('not found', { status: 404 });
  };

  // First scan: all 20 postings (including index #15 past the old 12-item cap!) receive full JDs
  const first = await collectOpportunities(
    [{ provider: 'mihoyo', slug: 'social', company: '米哈游' }],
    { now, keywords: ['推理'], fetchImpl },
  );
  assert.equal(first.opportunities.length, 20);
  const target = first.opportunities.find(o => o.externalId === '8715');
  assert.ok(target);
  assert.match(target.jd, /大模型推理集群资源调度/);
  assert.match(target.jd, /Kubernetes 与 vLLM/);
  assert.equal(infoHits.length, 20);

  // Second scan with existingJdIds skips already-cached IDs
  infoHits.length = 0;
  const cachedIds = new Set(first.opportunities.map(o => o.id));
  await collectOpportunities(
    [{ provider: 'mihoyo', slug: 'social', company: '米哈游' }],
    { now, keywords: ['推理'], existingJdIds: cachedIds, fetchImpl },
  );
  assert.equal(infoHits.length, 0);

  // On-demand detail hydration for an already-saved empty-JD miHoYo opportunity
  const detail = await fetchOpportunityDetail(
    { id: 'mihoyo:social:8715', sourceId: 'mihoyo:social', provider: 'mihoyo', externalId: '8715', jd: '' },
    { fetchImpl },
  );
  assert.match(detail.jd, /大模型推理集群资源调度/);
  assert.match(detail.jd, /Kubernetes 与 vLLM/);
});
