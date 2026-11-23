import test from 'node:test'
import assert from 'node:assert/strict'
import { ATS_FEISHU_TARGETS, acceptFeishuHiringRow, filterMokaHiringRows, repairAtsPostingUrl } from '../src/ats-hiring.mjs'
import { collectOpportunities, prepareApplicationHandoff } from '../src/opportunities.mjs'
import { mokaBoardUrl } from '../src/moka.mjs'

test('campus portals include cohort internships and exclude general rolling internships', async () => {
  // Titles, project names and type IDs from MiniMax's public graduate board.
  const responses = {
    '201': [{ id: '1', title: 'GPU 集群服务器工程师-2027届', recruit_type: { id: '201' }, process_type: 2 }],
    '202': [
      { id:'7705268557953009971', title:'机器学习系统研发实习生-2028 届', recruit_type:{id:'202'}, process_type:2,
        job_subject:{name:{zh_cn:'2028届实习生招聘'}} },
      { id:'7710128331056007478', title:'数仓实习生', recruit_type:{id:'202'}, process_type:2,
        job_subject:{name:{zh_cn:'日常实习'}}, requirement:'本科及以上在读' },
      { id:'4', title:'计算平台实习生', recruit_type:{id:'202'}, process_type:2, requirement:'硕士在读' },
      { id:'5', title:'前端实习生', recruit_type:{id:'202'}, process_type:2, requirement:'熟悉前端技术' },
    ],
  }
  const requests = []
  const sig = 'vrfi1sk8a0__379481'
  const board = {provider:'feishu',slug:sig,company:'MiniMax'}
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers['website-path'], '379481')
    if (url.endsWith('/csrf/token')) return Response.json({data:{token:'public'}})
    const body = JSON.parse(options.body), ids = body.recruitment_id_list
    requests.push(ids[0])
    return Response.json({code:0,data:{job_post_list:responses[ids[0]]}})
  }
  const {opportunities, results} = await collectOpportunities([board], {fetchImpl})
  assert.deepEqual(requests.sort(), ['201','202'])
  assert.equal(results[0].status, 'ok')
  assert.deepEqual(opportunities.map(x=>x.externalId),['1','7705268557953009971','4'])
  assert.equal(prepareApplicationHandoff(opportunities[1],{material:'v1'}).url,'https://vrfi1sk8a0.jobs.feishu.cn/379481/position/7705268557953009971/detail')
})

test('normal sources and derived graduate filters retain their real ATS site and employer eligibility', () => {
  const c = ATS_FEISHU_TARGETS['01ai__newgrad'], s=ATS_FEISHU_TARGETS['01ai__experienced']
  const graduate = {title:'研发工程师（AI 应用与平台方向）- 校园招聘', process_type:1, recruit_type:{name:'全职'}}
  assert.equal(c.websitePath,'index')
  assert.equal(acceptFeishuHiringRow(c, graduate),true)
  assert.equal(acceptFeishuHiringRow(s, graduate),false)
  assert.equal(acceptFeishuHiringRow(s,{title:'后端实习生',process_type:1,recruit_type:{name:'全职'}}),false)
  assert.equal(acceptFeishuHiringRow(c,{title:'研发工程师',process_type:1}),false)
  assert.equal(mokaBoardUrl('zhipu-campus'), 'https://app.mokahr.com/campus-recruitment/zphz/148984')
  assert.equal(mokaBoardUrl('deepseek-campus'), mokaBoardUrl('deepseek'))
  const eligible = {title:'服务端开发工程师',jd:'我们欢迎应届毕业生及两年以内经验的新鲜力量加入'}
  assert.deepEqual(filterMokaHiringRows('deepseek-campus',[eligible,{title:'财务',jd:'3 年经验'},{title:'软件开发',jd:'不接受应届毕业生'}]),[eligible])
})

test('only plugin-generated, same-board historical URLs can be repaired', () => {
  const job={provider:'feishu',id:'feishu:momenta:201',sourceId:'feishu:momenta',externalId:'201',url:'https://momenta.jobs.feishu.cn/position/201/detail'}
  assert.equal(repairAtsPostingUrl(job),'https://momenta.jobs.feishu.cn/talent/position/201/detail')
  assert.equal(repairAtsPostingUrl({...job,id:'feishu:momenta:111'}),job.url)
  const own='https://example.org/job/201'
  assert.equal(repairAtsPostingUrl({...job,url:own}),own)
})

test('malformed ATS replies are not reported as empty graduate boards', async () => {
  const board = {provider:'feishu',slug:'poizon__578078',company:'得物'}
  const result = await collectOpportunities([board],{fetchImpl:async url=>url.endsWith('/token')?Response.json({data:{token:'public'}}):Response.json({code:10001})})
  assert.equal(result.results[0].status,'error')
})
