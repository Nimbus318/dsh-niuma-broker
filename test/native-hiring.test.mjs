import test from 'node:test';
import assert from 'node:assert/strict';
import { campusAlibaba, campusNetease, parseNativeHiringUrl } from '../src/native-hiring.mjs';
import { collectOpportunities, fetchOpportunityDetail, prepareApplicationHandoff } from '../src/opportunities.mjs';

test('native portals preserve hiring scope in paths, SPA fragments, and distinct domains', () => {
  for (const [url, provider, slug] of [
    ['jobs.bytedance.com/campus/position/42/detail', 'feishu', 'bytedance__campus'],
    ['talent.baidu.com/jobs/detail/GRADUATE/123', 'baidu', 'campus'],
    ['talent.baidu.com/jobs/detail/SOCIAL/ABC', 'baidu', 'social'],
    ['join.qq.com/post_detail.html?postid=123', 'tencent', 'campus'],
    ['job.ctrip.com/#/experienced/job-detail/MJ123', 'trip', 'social'],
    ['job.ctrip.com/#/campus/job-detail/MJ123', 'trip', 'campus'],
    ['campus-talent.alibaba.com/campus/position?circleCode=60002', 'alibaba', 'aliyun-campus'],
  ]) assert.deepEqual(parseNativeHiringUrl(new URL('https://' + url)), { provider, slug });
  for (const url of ['https://campus-talent.alibaba.com/campus/position/123', 'https://zhaopin.meituan.com/web/position/detail?jobUnionId=42', 'https://join.qq.com.evil.test/post.html', 'http://join.qq.com/post.html']) assert.equal(parseNativeHiringUrl(url), null);
});

test('Alibaba restricts every search to the current graduate batch and selected business group', async () => {
  const calls = [];
  const read = async (path, query) => {
    calls.push({ path, query });
    if (path.endsWith('listBatch')) return { success: true, content: { graduate: [{ id: 17, type: 'graduate' }], internship: [{ id: 18 }] } };
    if (path.endsWith('/list')) return { success: true, content: { searchItems: [{ type: 'customDept', items: [{ value: '60000', children: [{ value: 'GROUP' }] }, { value: '60002', children: [{ value: 'CLOUD' }] }] }] } };
    return { success: true, content: { datas: [{ id: 42 }] } };
  };
  assert.deepEqual(await campusAlibaba('aliyun-campus', ['Infra'], read), [{ id: 42, publicDeptCodes: 'CLOUD' }]);
  assert.deepEqual(calls.at(-1).query, { channel:'campus_group_official_site',language:'zh',batchId:17,key:'Infra',pageIndex:1,pageSize:30,customDeptCode:'CLOUD' });
  const noGroup = async (path, query) => path.endsWith('/list') ? { success:true,content:{searchItems:[]} } : read(path,query);
  assert.deepEqual(await campusAlibaba('group-campus', ['Infra'], noGroup), []);
});

test('NetEase follows only official graduate projects and keeps keywords on their original board', async () => {
  const read = async url => {
    if (url.endsWith('/navigation/list')) return { code:200,data:[
      { title:'应届生',children:[{ link:'https://campus.game.163.com/app/job/position?id=3' }, { link:'https://example.com/app/job/position?id=3' }] },
      { title:'日常实习生',children:[{ link:'https://campus.163.com/app/job/position?id=2' }] },
    ] };
    const parsed = new URL(url);
    assert.equal(parsed.hostname,'campus.game.163.com'); assert.equal(parsed.searchParams.get('projectId'),'3'); assert.equal(parsed.searchParams.get('keyword'),'Infra');
    return {code:200,data:{list:[{ id:18,projectId:3,positionName:'GPU Infra' },{id:19,projectId:2,positionName:'Intern'}]}};
  };
  assert.deepEqual((await campusNetease(['Infra'],read)).map(item=>item.id), ['game_3_18']);
});

test('Trip refresh retains the original persisted opportunity ID while opening the actual JD using its public job code', async () => {
  for (const [slug,category,channel] of [['campus',2,'campus'],['social',1,'experienced']]) {
    const source={provider:'trip',slug,company:'携程'};
    const { opportunities: [job] } = await collectOpportunities([source], { fetchImpl: async (url, options) => {
      assert.equal(JSON.parse(options.body).condition.category, category);
      return Response.json({retValue:{recruitJobAdList:[{jobId:'persisted-uuid',fromId:'MJ012345',jobTitle:'Backend'}]}});
    }});
    assert.equal(job.id, 'trip:'+slug+':persisted-uuid');
    assert.equal(prepareApplicationHandoff(job,{material:'v1'}).url, 'https://job.ctrip.com/#/'+channel+'/job-detail/MJ012345');
    assert.throws(()=>prepareApplicationHandoff({...job,url:'https://evil.test/'},{material:'v1'}));
  }
});

test('Tencent graduate detail stays on join.qq.com and returns both sections', async () => {
  const {jd}=await fetchOpportunityDetail({provider:'tencent',sourceId:'tencent:campus',externalId:'42'}, {fetchImpl:async url=>{
    assert.equal(url,'https://join.qq.com/api/v1/jobDetails/getJobDetailsByPostId?postId=42');
    return Response.json({data:{desc:'职责',request:'要求'}});
  }});
  assert.match(jd,/职责\n\n要求/);
});

test('JD experienced link uses the published requirement ID and survives a refresh of a tracked reqNumber', async () => {
  const {opportunities:[job]}=await collectOpportunities([{provider:'jd',slug:'social',company:'京东'}],{fetchImpl:async()=>Response.json([{
    reqNumber:'JDZP0123',requirementId:4216,positionNameOpen:'供应链算法工程师',
  }])});
  assert.equal(job.id,'jd:social:JDZP0123');
  assert.equal(prepareApplicationHandoff(job,{material:'v1'}).url,'https://zhaopin.jd.com/web/job-info-detail?requementId=4216');
});

test('RED campus excludes a generic internship returned by the official campus endpoint', async () => {
  const {opportunities,results}=await collectOpportunities([{provider:'xiaohongshu',slug:'campus',company:'小红书'}],{fetchImpl:async(url,opts)=>{
    assert.equal(JSON.parse(opts.body).recruitType,'campus');
    return Response.json({data:{list:[
      {positionId:'1',positionName:'AI实习生',jobProjectName:'其他项目',qualification:'熟悉 Python。'},
      {positionId:'2',positionName:'数据仓库工程师',jobProjectName:'2027 校园招聘'},
    ]}});
  }});
  assert.equal(results[0].status,'ok');
  assert.deepEqual(opportunities.map(o=>o.externalId),['2']);
});
