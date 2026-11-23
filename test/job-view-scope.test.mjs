import test from 'node:test';
import assert from 'node:assert/strict';
import { findCompanyBoard } from '../src/company-boards.mjs';
import {
  intakeSearchSources,
  matchesJobFilter,
  migrateBoardsToHiringScope,
  needsChannelDisambiguation,
  pickChannelForScope,
  planJobSources,
  reconcileJobSources,
  resolveDefaultHiringScope,
} from '../src/job-view-scope.mjs';
import { proposeIntake } from '../src/intake.mjs';

const campus = findCompanyBoard('tencent','campus');
const social = findCompanyBoard('tencent','social');
const other = findCompanyBoard('baidu','social');
const [c,s,b] = [campus,social,other].map(x => x.provider + ':' + x.slug);
const jobs = [{ id:'old-applied', sourceId:s, company:'腾讯', receiptCount:1 }, {id:'new-grad', sourceId:c, company:'腾讯'}, {id:'other',sourceId:b,company:'百度'},{id:'manual',company:'腾讯'}];

test('confirmed hiring plan and a source chip show only the requested board while all jobs and company-level analytics remain accessible', () => {
  const ids = planJobSources({ hiringTargets:[campus.hiringGroup], boards:[campus,other] });
  assert.deepEqual(ids,[c]);
  assert.deepEqual(jobs.filter(job=>matchesJobFilter(job,{sourceIds:ids})).map(job=>job.id),['new-grad']);
  assert.deepEqual(jobs.filter(job=>matchesJobFilter(job,{company:'腾讯'})).map(job=>job.id),['old-applied','new-grad','manual']);
  assert.equal(matchesJobFilter({company:'腾讯音乐'},{company:'腾讯'}),false);
  assert.equal(jobs.filter(job=>matchesJobFilter(job,null)).length,4);
});

test('changing an active subscription follows its replacement without touching unrelated views', () => {
  assert.deepEqual(reconcileJobSources([s],[campus,other]),[c]);
  assert.deepEqual(reconcileJobSources([s,b],[campus,other]),[c,b]);
  assert.deepEqual(reconcileJobSources([b],[campus,other]),[b]);
  assert.deepEqual(reconcileJobSources([s],[other]),[]);
});

test('current search, a named mixed-language query, and explicit history have independent scopes', () => {
  const boards=[campus,other];
  assert.deepEqual([...intakeSearchSources('看看匹配岗位',boards,[c])],[c]);
  assert.deepEqual([...intakeSearchSources('之前做开发，想找腾讯校招岗位',boards)],[c]);
  assert.deepEqual([...intakeSearchSources('Show me Tencent campus jobs and Baidu experienced jobs',boards)],[c,b]);
  assert.deepEqual([...intakeSearchSources('找腾讯社招岗位',boards)],[]);
  assert.equal(intakeSearchSources('我以前投过的腾讯社招有哪些？',boards,[c]),null);
  assert.equal(intakeSearchSources('Which jobs have I already applied to?',boards,[c]),null);
});

test('resolveDefaultHiringScope infers experienced or campus track from explicit config, goal text, or subscribed boards', () => {
  assert.equal(resolveDefaultHiringScope({ hiringScope: 'campus', boards: [social] }), 'campus');
  assert.equal(resolveDefaultHiringScope({ hiringScope: 'all', boards: [social] }), 'experienced');
  assert.equal(resolveDefaultHiringScope({ hiringScope: 'all', boards: [campus] }), 'campus');
  assert.equal(resolveDefaultHiringScope({ goal: '上海 2026 校招 AI Infra' }), 'campus');
  assert.equal(resolveDefaultHiringScope({ goal: '上海社招后端', boards: [campus] }), 'experienced');
  assert.equal(resolveDefaultHiringScope({ boards: [campus] }), 'campus');
  assert.equal(resolveDefaultHiringScope({ boards: [social, other] }), 'experienced');
  assert.equal(resolveDefaultHiringScope({ boards: [social, campus] }), 'experienced');
  assert.equal(resolveDefaultHiringScope({}), 'experienced');
});

test('needsChannelDisambiguation hides redundant channel tags and surfaces only genuine conflicts or exceptions', () => {
  const bytedanceExp = findCompanyBoard('feishu', 'bytedance');
  const openaiAll = findCompanyBoard('ashby', 'openai');
  // Standard experienced user with all experienced boards: zero clutter.
  assert.equal(needsChannelDisambiguation(social, { userScope: 'experienced', boards: [social, other, bytedanceExp] }), false);
  assert.equal(needsChannelDisambiguation(openaiAll, { userScope: 'experienced', boards: [social, openaiAll] }), false);
  // Experienced user with an exception campus board/job: disambiguate ONLY the campus one.
  assert.equal(needsChannelDisambiguation(campus, { userScope: 'experienced', boards: [campus, other] }), true);
  assert.equal(needsChannelDisambiguation(other, { userScope: 'experienced', boards: [campus, other] }), false);
  // Same company subscribed on both channels: disambiguate both Tencent chips, leave Baidu clean.
  assert.equal(needsChannelDisambiguation(social, { userScope: 'experienced', boards: [social, campus, other] }), true);
  assert.equal(needsChannelDisambiguation(campus, { userScope: 'experienced', boards: [social, campus, other] }), true);
  assert.equal(needsChannelDisambiguation(other, { userScope: 'experienced', boards: [social, campus, other] }), false);
  // Campus user with all campus boards: zero clutter; historical experienced job gets disambiguated.
  assert.equal(needsChannelDisambiguation(campus, { userScope: 'campus', boards: [campus] }), false);
  assert.equal(needsChannelDisambiguation(social, { userScope: 'campus', boards: [campus] }), true);
});

test('pickChannelForScope and migrateBoardsToHiringScope switch subscribed companies cleanly', () => {
  const anthropic = findCompanyBoard('greenhouse', 'anthropic');
  assert.equal(pickChannelForScope(social, 'campus')?.slug, 'campus');
  assert.equal(pickChannelForScope(campus, 'experienced')?.slug, 'social');
  assert.equal(pickChannelForScope(anthropic, 'campus'), null);

  const migrated = migrateBoardsToHiringScope([social, other, anthropic], 'campus');
  assert.equal(migrated.migratedCount, 2);
  assert.deepEqual(migrated.nextBoards.map(b => `${b.provider}:${b.slug}`), ['tencent:campus', 'baidu:campus', 'greenhouse:anthropic']);
  assert.deepEqual(migrated.unavailable.map(u => u.company), ['Anthropic']);
});

test('proposeIntake honors configured hiringScope by default while letting explicit user requests override it', async () => {
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ kind: 'search', summary: '订阅招聘板', data: { goal: 'AI 工程师', searchTerms: ['AI'] } }) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const campusDefault = await proposeIntake({
    text: '帮我订阅腾讯和百度的研发岗位',
    context: { hiringScope: 'campus' },
    llm,
    config: { model: 'fixture:test', sendToModel: true },
  });
  assert.deepEqual(campusDefault.data.boards.map(b => `${b.provider}:${b.slug}`), ['tencent:campus', 'baidu:campus']);

  const explicitOverride = await proposeIntake({
    text: '查一下腾讯的社招岗位',
    context: { hiringScope: 'campus' },
    llm,
    config: { model: 'fixture:test', sendToModel: true },
  });
  assert.deepEqual(explicitOverride.data.boards.map(b => `${b.provider}:${b.slug}`), ['tencent:social']);
});
