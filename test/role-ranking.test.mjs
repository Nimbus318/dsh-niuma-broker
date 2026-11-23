import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPatrolSearchProfile, scoreOpportunityHeuristic } from '../src/job-triage.mjs'

test('official AGIBOT whole-body title and shorthand outrank broad algorithm titles', () => {
  const profile = buildPatrolSearchProfile({goal: '在上海找人形机器人全身运动控制算法岗', searchTerms: ['智元机器人','人形机器人','全身运动控制算法','社招','上海']})
  // Titles and IDs from the official social recruitment board. Short JD excerpts are paraphrased.
  const jobs = [
    ['7620730986292398379', '具身智能大模型算法专家', '研究大模型和具身智能，与机器人运动控制团队合作。'],
    ['7674633294918486298', '具身强化学习后训练算法研究员', '从事模型后训练及强化学习研究。'],
    ['7654151926649391410', '运控强化学习算法工程师', '研发机器人运动控制算法，涉及运动学和动力学。'],
    ['7593282052935485739', '全身运控操作研究员', '研究全身控制和操作。'],
    ['7704132371998853414', '人形机器人全身运动控制算法工程师', '与算法、云平台及运控团队协作。'],
  ].map(([id,title,jd]) => scoreOpportunityHeuristic({id, title, jd, company:'智元机器人', location:'上海'},profile))
  assert.equal(jobs.toSorted((a,b)=>b.score-a.score)[0].opportunityId,'7704132371998853414')
  for (const focus of jobs.slice(2)) {
    assert.ok(focus.score > Math.max(jobs[0].score,jobs[1].score))
    assert.ok(focus.breakdown.find(f=>f.key==='role').detail.includes('岗位名称'))
  }
  const wbc = title => scoreOpportunityHeuristic({title, location:'上海'},profile).breakdown.find(f=>f.key==='role')
  assert.ok(wbc('算法工程师（WBC+感控融合方向）')?.delta > 0)
  assert.ok(wbc('Whole‑Body Control Engineer')?.delta > 0)
  assert.equal(wbc('SWBC2 平台工程师'),undefined)
})

test('literal occupational titles get more credit than peripheral JD references in other industries', () => {
  const profile=buildPatrolSearchProfile({goal:'Find a compliance analyst job',searchTerms:['compliance analyst']})
  const score = (title,jd) => scoreOpportunityHeuristic({title,jd,company:'Example'},profile,'en')
  const direct=score('Senior Compliance Analyst','Investigate and report regulatory concerns.')
  const support=score('Legal Operations Associate','Partner with the compliance analyst on reporting.')
  assert.ok(direct.score > support.score)
  assert.equal(direct.breakdown.find(f=>f.key==='role').detail,'Job title · compliance analyst')
  assert.equal(support.breakdown.find(f=>f.key==='role').detail,'Job description · compliance analyst')
})
