import assert from 'node:assert/strict'
import test from 'node:test'
import { proposeIntake } from '../src/intake.mjs'
import { buildPatrolSearchProfile, scoreOpportunityHeuristic } from '../src/job-triage.mjs'

async function propose(text) {
  const raw = { kind: 'search', summary: '搜索', data: { goal: '寻找工作', searchTerms: ['Datadog', '软件工程师', '社招'] } }
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(raw) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return (await proposeIntake({ text, llm, config: { model: 'fixture:test', sendToModel: true } })).data
}

test('English role in a Chinese UI survives translated model keywords and outranks unrelated roles', async () => {
  const proposal = await propose("I'm looking for experienced-hire software engineering roles at Datadog. I have five years of backend infrastructure experience.")
  assert.equal(proposal.boards[0].slug, 'datadog__experienced')
  assert.deepEqual(proposal.searchTerms, ['software engineer', '软件工程师'])
  const profile = buildPatrolSearchProfile(proposal)
  const score = title => scoreOpportunityHeuristic({ title, company: 'Datadog' }, profile).score
  assert.ok(score('Senior Software Engineer - Distributed Systems') > score('Forward Deployed Engineering Manager - Datadog for Startups'))
  assert.ok(score('Senior Software Engineer - Distributed Systems') > score('Art Director - Brand'))
})

test('a prior field or expressly excluded role is not added to search terms', async () => {
  for (const text of [
    'I previously worked as a data scientist. I want software engineer jobs at Datadog.',
    'I want software engineering roles at Datadog, not data scientist jobs.',
    "I don't want data scientist jobs but prefer software engineering at Datadog.",
    'I want software engineer positions at Datadog instead of data scientist jobs.',
  ]) {
    const data = await propose(text)
    assert.ok(data.searchTerms.includes('software engineer'), text)
    assert.ok(!data.searchTerms.includes('data scientist'), text)
  }
  const management = await propose('Find software engineering manager jobs at Datadog.')
  assert.ok(management.searchTerms.includes('software engineering manager'))
  assert.ok(!management.searchTerms.includes('software engineer'))
})
