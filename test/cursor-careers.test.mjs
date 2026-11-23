import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOpportunities, prepareApplicationHandoff } from '../src/opportunities.mjs';
import { cursorCareerUrl, cursorDirectoryLinks } from '../src/cursor-careers.mjs';

const id = 'f602d5d4-7961-479b-894e-7e975e7bfe4e';
const other = '13ceadb8-638f-40c7-a59d-70dab2f4de0b';
const listing = (id, slug) => ({
  id, title: 'Identical listing title', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/cursor/' + id,
  urlSlug: slug, descriptionPlain: 'Five years of relevant experience required.',
});
const render = (jobs, anchorSlugs) => {
  const model = ['$', 'main', null, { children: ['$', '$L80', null, { jobs }] }];
  const data = JSON.stringify([1, 'a:' + JSON.stringify(model) + '\n']);
  return anchorSlugs.map(s => '<a href="/careers/' + s + '">Open JD</a>').join('') + '<script>self.__next_f.push(' + data + ')</script>';
};
const read = (rows, page) => collectOpportunities([{ provider: 'ashby', slug: 'cursor', company: 'Cursor' }], {
  fetchImpl: async endpoint => {
    if (endpoint === 'https://api.ashbyhq.com/posting-api/job-board/cursor') return Response.json({ jobs: rows });
    assert.equal(endpoint, 'https://cursor.com/careers');
    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  },
});
const job = listing(id, 'regional-director-strategic-enterprise');
const alt = listing(other, 'account-executive-commercial');

test('Cursor verifies the ATS identity and visible permalink, independent of similar job titles', async () => {
  const page = render([job, alt], [alt.urlSlug, job.urlSlug]);
  const { opportunities, results } = await read([job, alt], page);
  assert.equal(results[0].count, 2);
  assert.equal(opportunities[0].externalId, id);
  assert.equal(opportunities[0].cursorPublicSlug, job.urlSlug);
  const link = cursorCareerUrl(job.urlSlug);
  assert.equal(prepareApplicationHandoff(opportunities[0], { material: 'v1' }).url, link);
  for (const bad of [cursorCareerUrl(alt.urlSlug), link + '?tracking=1', 'https://external.example/careers/' + job.urlSlug, job.jobUrl]) {
    assert.throws(() => prepareApplicationHandoff({ ...opportunities[0], url: bad }, { material: 'v1' }));
  }
  const { cursorPublicSlug, ...legacy } = opportunities[0];
  assert.equal(prepareApplicationHandoff({ ...legacy, url: job.jobUrl }, { material: 'v1' }).url, job.jobUrl);
  assert.throws(() => prepareApplicationHandoff({ ...legacy, url: link }, { material: 'v1' }));
});

test('missing visible links and changed directory markup preserve previous records', async () => {
  const partial = await read([job, alt], render([job, alt], [job.urlSlug]));
  assert.deepEqual(partial.opportunities.map(job => job.externalId), [id]);
  assert.equal(partial.results[0].complete, false);
  const unavailable = await read([job], '<main>Careers</main>');
  assert.equal(unavailable.results[0].status, 'error');
  assert.equal(unavailable.opportunities.length, 0);
});

test('Cursor rejects duplicate, unlisted or inconsistent ID/slug pairs', () => {
  const dup = listing(other, job.urlSlug);
  assert.equal(cursorDirectoryLinks(render([job, dup], [job.urlSlug])).size, 0);
  const shifted = listing(id, alt.urlSlug);
  assert.equal(cursorDirectoryLinks(render([job, shifted], [job.urlSlug, alt.urlSlug])).size, 0);
  assert.equal(cursorDirectoryLinks(render([{ ...job, jobUrl: alt.jobUrl }], [job.urlSlug])).size, 0);
  assert.equal(cursorDirectoryLinks(render([{ ...job, isListed: false }], [job.urlSlug])).size, 0);
  assert.equal(cursorCareerUrl('../external'), '');
});
