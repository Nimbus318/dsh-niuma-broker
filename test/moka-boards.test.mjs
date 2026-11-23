import test from 'node:test'
import assert from 'node:assert/strict'
import { collectOpportunities, fetchOpportunityDetail, prepareApplicationHandoff, validateBoardSource } from '../src/opportunities.mjs'

const id = '640e5a5d-3f3a-4e43-aa4f-ceed1879c1ef'
const source = { provider: 'moka', slug: 'moonshot', company: '月之暗面' }
const base = 'https://app.mokahr.com/apply/moonshot/148506'

test('Moka public page returns an owned JD link and the same ID is accepted for the handoff', async () => {
  const mokaRenderer = async input => {
    assert.equal(input.base, base)
    if (input.detailId) {
      assert.equal(input.detailId, id)
      return { jd: '完整公开职位职责' }
    }
    assert.deepEqual(input.queries, ['推理'])
    return { jobs: [{ id, title: '推理工程师', location: '北京', jd: '分布式推理' }] }
  }
  const { results, opportunities } = await collectOpportunities([source], { keywords: ['推理'], mokaRenderer })
  assert.equal(results[0].complete, false)
  assert.equal(results[0].coverage, 'searched-pages')
  const [job] = opportunities
  assert.equal(job.jd, '分布式推理')
  assert.equal(job.jdPreview, true)
  assert.equal(job.url, base + '#/job/' + id)
  assert.equal(prepareApplicationHandoff(job, { material: 'main' }).url, job.url)
  assert.deepEqual(await fetchOpportunityDetail(job, { mokaRenderer }), { jd: '完整公开职位职责' })
  assert.throws(() => prepareApplicationHandoff({ ...job, url: job.url.replace('148506', '1') }, { material: 'main' }))
  assert.throws(() => validateBoardSource({ provider: 'moka', slug: 'other' }))
})

function homepage(org = 'moonshot') {
  const data = {
    org: { id: org }, siteId: 148506,
    jobs: [
      { orgId: org, id, status: 'open', title: 'GPU & NPU', locations: [{ cityName: '上海' }] },
      { orgId: org, id: 'closed', status: 'closed', title: 'closed' },
      { orgId: 'other', id: 'wrong', status: 'open', title: 'other' },
    ],
  }
  const value = JSON.stringify(data).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return new Response('<input id="init-data" type="hidden" value="' + value + '">', { headers: { 'Content-Type': 'text/html' } })
}

test('isolated public homepage fallback never closes unsampled jobs or invents descriptions', async () => {
  let calls = 0
  const fetchImpl = async (url, options) => {
    assert.equal(url, base)
    assert.equal(options.redirect, 'manual')
    if (++calls === 1) return new Response('', { status: 302, headers: { location: '/apply/moonshot/148506', 'set-cookie': 'guest=temporary; Path=/' } })
    assert.equal(options.headers.Cookie, 'guest=temporary')
    return homepage()
  }
  const result = await collectOpportunities([source], { fetchImpl, mokaRenderer: async () => { throw Error('unavailable') } })
  assert.equal(result.results[0].coverage, 'homepage-only')
  assert.equal(result.results[0].complete, false)
  assert.equal(result.opportunities[0].jdPreview, true)
  assert.deepEqual(result.opportunities.map(x => [x.title, x.location, x.jd]), [['GPU & NPU', '上海', '']])
  assert.deepEqual(await fetchOpportunityDetail(result.opportunities[0], { fetchImpl, mokaRenderer: null }), { jd: '' })
  const foreign = await collectOpportunities([source], { fetchImpl: async () => homepage('foreign'), mokaRenderer: null })
  assert.equal(foreign.results[0].status, 'error')
})

test('dotted public Ashby tenant survives listing, on-demand JD, and user handoff', async () => {
  const source = { provider: 'ashby', slug: 'mistral.ai', company: 'Mistral AI' }
  const jobUrl = 'https://jobs.ashbyhq.com/mistral.ai/' + id
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body)
      assert.equal(request.variables.organizationHostedJobsPageName, 'mistral.ai')
      assert.doesNotMatch(request.query, /descriptionPlain/)
      return Response.json({ data: { jobPosting: { descriptionHtml: '<p>Multi-GPU inference.</p>' } } })
    }
    assert.equal(url, 'https://api.ashbyhq.com/posting-api/job-board/mistral.ai')
    return Response.json({ jobs: [{ jobUrl, title: 'Inference engineer', isListed: true, descriptionPlain: 'GPU serving' }] })
  }
  const { opportunities } = await collectOpportunities([source], { fetchImpl })
  assert.equal(opportunities[0].url, jobUrl)
  assert.equal(prepareApplicationHandoff(opportunities[0], { material: 'main' }).url, jobUrl)
  assert.deepEqual(await fetchOpportunityDetail(opportunities[0], { fetchImpl }), { jd: 'Multi-GPU inference.' })
  for (const slug of ['..', 'mistral..ai', 'mistral/ai', '.mistral']) {
    assert.throws(() => validateBoardSource({ provider: 'ashby', slug }))
  }
})
