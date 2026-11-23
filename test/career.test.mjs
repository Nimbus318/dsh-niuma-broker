import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CareerStore, resumeEvidenceIds, tailorableResumeLines } from '../src/career.mjs';

const firstEvening = '2026-11-18T12:00:00.000Z';
const secondEvening = '2026-11-19T12:00:00.000Z';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'niuma-career-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'career.json');
  let clock = firstEvening;
  const now = () => new Date(clock);
  return {
    file,
    store: new CareerStore({ file, now }),
    reopen: () => new CareerStore({ file, now }),
    setTime: (value) => { clock = value; },
  };
}

function workEvent(overrides = {}) {
  return {
    id: 'event-1',
    sourceId: 'dsh-session',
    projectId: 'project-a',
    kind: 'task-completed',
    occurredAt: '2026-11-18T10:00:00.000Z',
    sourceRef: 'session:project-a#event-1',
    evidence: [{
      title: '发布版本',
      text: '我执行了 SKU 校验并协助上线。',
      role: '校验与验收',
      impact: '发布完成，使用率待测。',
      shareable: true,
      status: 'approved',
    }],
    body: 'Raw transcript must stay out of the career store.',
    ...overrides,
  };
}

test('off by default, scoped event ingestion, replay deduplication, and private durable state', async (t) => {
  const { store, reopen, file } = await fixture(t);
  const event = workEvent();
  assert.equal((await store.ingestEvents([event])).disabled, 1);
  assert.equal((await store.state()).events.length, 0);
  await store.setMode('observe');
  assert.equal((await store.ingestEvents([event])).unauthorized, 1);
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  assert.equal((await store.ingestEvents([workEvent({ projectId: 'other-project' })])).unauthorized, 1);

  const competing = await Promise.all([
    store.ingestEvents([event]),
    reopen().ingestEvents([event]),
  ]);
  assert.equal(competing.reduce((count, batch) => count + batch.accepted, 0), 1);
  assert.equal(competing.reduce((count, batch) => count + batch.duplicates, 0), 1);

  const state = await reopen().state();
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].status, 'pending');
  assert.equal(state.evidence[0].shareable, false);
  assert.equal(state.evidence[0].sourceRef, event.sourceRef);
  assert.equal(state.events[0].body, undefined);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes(event.body), false);

  await store.authorizeSource({ id: 'dsh-session', projects: ['*'] });
  assert.equal((await store.ingestEvents([workEvent({ projectId: 'other-project' })])).accepted, 1);
});

test('a failed mutation leaves the whole batch unchanged and unlocks the next write', async (t) => {
  const { store } = await fixture(t);
  await store.setMode('observe');
  await store.authorizeSource({ id: 'dsh-session', projects: ['*'] });
  await assert.rejects(store.ingestEvents([
    workEvent(),
    workEvent({ id: 'incomplete', evidence: [{ title: '无正文' }] }),
  ]), /Evidence text/);
  assert.equal((await store.state()).events.length, 0);
  assert.equal((await store.ingestEvents([workEvent()])).accepted, 1);
});

test('a lock left by a dead process is recovered before a new transaction', async (t) => {
  const { store, file } = await fixture(t);
  await writeFile(`${file}.lock`, '2147483647');
  await store.setMode('observe');
  assert.equal((await store.state()).mode, 'observe');
  await assert.rejects(stat(`${file}.lock`), { code: 'ENOENT' });
});

test('generated resume requires evidence, disclosure permission, and version approval', async (t) => {
  const { store, reopen } = await fixture(t);
  await store.setMode('search');
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  const ingested = await store.ingestEvents([
    workEvent(),
    workEvent({ id: 'event-2' }),
    workEvent({ id: 'event-3' }),
  ]);
  const [publicEvidence, internalEvidence, rejectedEvidence] = ingested.evidence;
  const resumeInput = (evidenceIds) => ({
    title: '个人履历',
    items: [{ text: '作为校验与验收负责人协助上线。', evidenceIds }],
  });

  await assert.rejects(store.proposeResume(resumeInput([])), /Every resume claim/);
  await assert.rejects(store.proposeResume(resumeInput([publicEvidence.id])), /active human approval/);
  await store.reviewEvidence(internalEvidence.id, { action: 'approve' });
  await assert.rejects(store.proposeResume(resumeInput([internalEvidence.id])), /external use/);
  await store.reviewEvidence(rejectedEvidence.id, { action: 'reject', note: '职责夸大' });
  await assert.rejects(store.reviewEvidence(rejectedEvidence.id, { action: 'approve' }), /pending/);

  const approved = await store.reviewEvidence(publicEvidence.id, {
    action: 'approve',
    shareable: true,
    role: '完成校验并参与验收',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.role, '完成校验并参与验收');
  assert.equal(approved.originalProposal.role, publicEvidence.role);
  const resume = await store.proposeResume(resumeInput([publicEvidence.id]));
  await assert.rejects(reopen().exportResume(resume.id), /human-approved/);
  await store.reviewResume(resume.id, { action: 'approve' });
  assert.match(await reopen().exportResume(resume.id), /协助上线/);

  await store.revokeSource('dsh-session');
  await assert.rejects(reopen().exportResume(resume.id), /active human approval/);
  assert.equal((await store.ingestEvents([workEvent({ id: 'new' })])).unauthorized, 1);
  assert.equal((await store.state()).evidence[0].status, 'revoked');
});

test('imported base resume is immutable and exportable only after version approval', async (t) => {
  const { store } = await fixture(t);
  const draft = { title: '基础简历', text: '# 履历\n\n实际负责测试。' };
  const imported = await store.importResume(draft);
  assert.equal((await store.state()).mode, 'off');
  await assert.rejects(store.exportResume(imported.id), /human-approved/);
  await store.reviewResume(imported.id, { action: 'approve' });
  assert.equal(await store.exportResume(imported.id), draft.text);
  const next = await store.importResume({ ...draft, text: '# 履历新版' });
  assert.notEqual(imported.id, next.id);
  assert.equal(await store.exportResume(imported.id), draft.text);
  await store.reviewResume(imported.id, { action: 'revoke' });
  await assert.rejects(store.exportResume(imported.id), /human-approved/);
});

test('observed complaints require consent and approval across days and never activate search', async (t) => {
  const { store, setTime } = await fixture(t);
  await store.setMode('observe');
  const reflection = (id, occurredAt, evidenceIds) => ({
    id, occurredAt, dimension: 'direction', severity: 'concern', evidenceIds,
  });
  await assert.rejects(store.recordReflection(reflection('first', firstEvening, [])), /opt-in/);
  await store.setPreferences({ allowReflections: true, notificationsEnabled: true });
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  const { evidence } = await store.ingestEvents([workEvent(), workEvent({ id: 'event-2' })]);

  const first = await store.recordReflection(reflection('first', firstEvening, [evidence[0].id]), { actor: 'model' });
  assert.equal(first.status, 'pending');
  await assert.rejects(store.reviewReflection(first.id, { action: 'approve' }), /active human approval/);
  await store.reviewEvidence(evidence[0].id, { action: 'approve' });
  await store.reviewReflection(first.id, { action: 'approve' });
  assert.deepEqual(await store.listNotifications(), []);

  setTime('2026-11-19T09:00:00.000Z');
  await store.reviewEvidence(evidence[1].id, { action: 'approve' });
  await store.recordReflection(reflection('second', '2026-11-19T08:59:00.000Z', [evidence[1].id]), { actor: 'model' });
  assert.deepEqual(await store.listNotifications(), []);
  await store.reviewReflection('second', { action: 'approve' });
  assert.deepEqual(await store.listNotifications(), []);

  setTime(secondEvening);
  const reminders = await store.listNotifications();
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].kind, 'search-intent-check');
  assert.equal((await store.state()).mode, 'observe');
  await store.reviewSuggestion(reminders[0].id, { action: 'dismiss' });
  assert.deepEqual(await store.listNotifications(), []);
});

test('two concerns on one local day do not count twice and a new positive reflection ends a reminder', async (t) => {
  const { store, setTime } = await fixture(t);
  await store.setMode('observe');
  await store.setPreferences({ allowReflections: true, notificationsEnabled: true });
  await store.recordReflection({
    id: 'am', occurredAt: '2026-11-18T04:00:00.000Z', dimension: 'growth', severity: 'concern',
  });
  await store.recordReflection({
    id: 'pm', occurredAt: firstEvening, dimension: 'growth', severity: 'concern',
  });
  assert.deepEqual(await store.listNotifications(), []);
  setTime(secondEvening);
  await store.recordReflection({
    id: 'new-date', occurredAt: '2026-11-19T11:30:00.000Z', dimension: 'growth', severity: 'concern',
  });
  assert.equal((await store.listNotifications())[0].kind, 'growth-check');
  await store.recordReflection({
    id: 'progress', occurredAt: secondEvening, dimension: 'growth', severity: 'positive',
  });
  assert.deepEqual(await store.listNotifications(), []);
});

test('approved source-backed updates can extend an approved imported base without rewriting it', async (t) => {
  const { store } = await fixture(t);
  await store.setMode('observe');
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  const { evidence: [pending] } = await store.ingestEvents([workEvent()]);
  await store.reviewEvidence(pending.id, { action: 'approve', shareable: true });

  const base = await store.importResume({ title: '基础版本', text: '# 基础履历\n\n保留原句。' });
  const update = {
    title: '交付案例',
    baseId: base.id,
    items: [{ text: '执行 SKU 校验并协助上线。', evidenceIds: [pending.id] }],
  };
  await assert.rejects(store.proposeResume(update), /base resume requires explicit human approval/);
  await store.reviewResume(base.id, { action: 'approve' });
  const proposed = await store.proposeResume(update);
  await store.reviewResume(proposed.id, { action: 'approve' });
  assert.equal(await store.exportResume(proposed.id), '# 基础履历\n\n保留原句。\n\n## 交付案例\n\n- 执行 SKU 校验并协助上线。\n');
  await store.reviewResume(base.id, { action: 'revoke' });
  await assert.rejects(store.exportResume(proposed.id), /human-approved/);
});

test('forget source erases evidence and derived text and suppresses historical replay after reauthorization', async (t) => {
  const { store, file, setTime } = await fixture(t);
  await store.setMode('observe');
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  await store.authorizeSource({ id: 'manual', projects: ['personal'] });
  await store.setPreferences({ allowReflections: true, notificationsEnabled: true });
  const first = workEvent({
    evidence: [{ title: '待删除的内容', text: '演示敏感标记' }],
  });
  const { evidence: [session, manual] } = await store.ingestEvents([
    first,
    workEvent({ id: 'personal', sourceId: 'manual', projectId: 'personal' }),
  ]);
  await store.reviewEvidence(session.id, { action: 'approve', shareable: true });
  await store.reviewEvidence(manual.id, { action: 'approve', shareable: true });
  await store.recordReflection({
    id: 'source-reflection', dimension: 'growth', severity: 'concern', evidenceIds: [session.id],
    text: '演示衍生反思',
  });
  setTime(secondEvening);
  await store.recordReflection({ id: 'other-reflection', dimension: 'growth', severity: 'concern' });
  assert.equal((await store.listNotifications()).length, 1);
  const draft = await store.proposeResume({
    title: '混合版本',
    items: [{ text: '演示衍生简历', evidenceIds: [session.id, manual.id] }],
  });
  await store.reviewResume(draft.id, { action: 'approve' });
  await store.forgetSource('dsh-session');
  const state = await store.state();
  assert.deepEqual(state.events.map((event) => event.sourceId), ['manual']);
  assert.deepEqual(state.evidence.map((evidence) => evidence.id), [manual.id]);
  assert.deepEqual(state.reflections.map((reflection) => reflection.id), ['other-reflection']);
  assert.equal(state.resumes.length, 0);
  assert.equal(state.suggestions.length, 0);
  const content = await readFile(file, 'utf8');
  assert.doesNotMatch(content, /演示敏感标记|演示衍生反思|演示衍生简历/);

  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  assert.equal((await store.ingestEvents([first])).unauthorized, 1);
  setTime('2026-11-20T12:00:00.000Z');
  assert.equal((await store.ingestEvents([workEvent({
    id: 'new-event', occurredAt: '2026-11-20T11:00:00.000Z',
  })])).accepted, 1);
});

test('an approved claim can be corrected or made private, invalidating formal dependent versions', async (t) => {
  const { store } = await fixture(t);
  await store.setMode('observe');
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  const { evidence: [pending] } = await store.ingestEvents([workEvent()]);
  await store.reviewEvidence(pending.id, { action: 'approve', shareable: true });
  const generate = async (text) => {
    const draft = await store.proposeResume({ title: '可用版本', items: [{ text, evidenceIds: [pending.id] }] });
    return store.reviewResume(draft.id, { action: 'approve' });
  };
  const first = await generate(pending.text);
  const corrected = await store.reviewEvidence(pending.id, {
    action: 'approve', text: '我执行了 SKU 校验。', impact: '',
  });
  assert.equal(corrected.shareable, true);
  assert.equal(corrected.impact, undefined);
  assert.equal(corrected.originalProposal.text, pending.text);
  await assert.rejects(store.exportResume(first.id), /human-approved/);
  const second = await generate(corrected.text);
  await store.reviewEvidence(pending.id, { action: 'approve', shareable: false });
  assert.equal((await store.state()).resumes.at(-1).invalidatedByEvidenceId, pending.id);
  await assert.rejects(store.exportResume(second.id), /human-approved/);
  await store.reviewEvidence(pending.id, { action: 'approve', shareable: true });
  await assert.rejects(store.exportResume(second.id), /human-approved/);
});

test('explicit manual evidence and reflection work without waking background collection', async (t) => {
  const { store } = await fixture(t);
  await store.authorizeSource({ id: 'manual', projects: ['personal'] });
  await store.authorizeSource({ id: 'dsh-session', projects: ['project-a'] });
  const result = await store.ingestEvents([
    workEvent({ id: 'manual-1', sourceId: 'manual', projectId: 'personal' }),
    workEvent({ id: 'not-manual' }),
  ], { explicitManual: true });
  assert.equal(result.accepted, 1);
  assert.equal(result.disabled, 1);
  await store.reviewEvidence(result.evidence[0].id, { action: 'approve', shareable: true });
  await store.recordReflection({ dimension: 'growth', severity: 'concern', text: '写下一条观察。' }, { explicitManual: true });
  const state = await store.state();
  assert.equal(state.mode, 'off');
  assert.deepEqual(state.events.map(row => row.sourceId), ['manual']);
  assert.equal(state.preferences.allowReflections, false);
  assert.equal(state.reflections[0].status, 'approved');
  assert.deepEqual(state.suggestions, []);
});

test('JD tailoring rewrites and ranks only selected bullets from the same approved section', async (t) => {
  const { store } = await fixture(t);
  const text = '# 履历\n联系：本人\n\n## 甲公司\n- 第一条\n- 保留条目\n- 第二条\n\n## 乙公司\n•第三条\n\n相同\n- 重复\n- 重复\n';
  const base = await store.importResume({ title: '原版', text });
  assert.deepEqual(tailorableResumeLines(text), ['- 第一条', '- 保留条目', '- 第二条', '•第三条']);
  const lines = [{ source: '•第三条', text: '乙公司改写' }, { source: '- 第二条', text: '甲公司优先' },
    { source: '- 第一条', text: '甲公司其次' }];
  await assert.rejects(store.proposeTailoredResume({ title: '更新', baseId: base.id, lines }), /base resume requires explicit human approval/);
  await store.reviewResume(base.id, { action: 'approve' });
  await assert.rejects(store.proposeTailoredResume({ title: '伪造', baseId: base.id,
    lines: [{ source: '- 重复', text: '歧义条目' }] }), /unique line/);
  await assert.rejects(store.proposeTailoredResume({ title: '伪造', baseId: base.id,
    lines: [{ source: '- 无依据', text: '不能加入' }] }), /unique line/);

  const tailored = await store.proposeTailoredResume({ title: '更新', baseId: base.id, lines });
  assert.equal(tailored.kind, 'tailored');
  assert.equal(tailored.status, 'pending');
  assert.match(tailored.text, /## 甲公司\n- 甲公司优先\n- 甲公司其次\n- 保留条目\n\n## 乙公司\n•乙公司改写/);
  assert.ok(tailored.text.includes('联系：本人') && tailored.text.includes('- 重复\n- 重复'));
  assert.equal(await store.previewResume(tailored.id), tailored.text);
  await assert.rejects(store.exportResume(tailored.id), /human-approved/);
  assert.equal(await store.exportResume(base.id), text.trim());
  await store.reviewResume(tailored.id, { action: 'approve' });

  const revised = await store.reviseResume(tailored.id, { items: ['乙公司人工更正', '甲公司优先', '甲公司其次'] });
  assert.equal(revised.parentId, tailored.id);
  assert.deepEqual(revised.items.map(item => item.source), lines.map(item => item.source));
  assert.match(await store.previewResume(revised.id), /## 乙公司\n•乙公司人工更正/);
  assert.equal(await store.exportResume(tailored.id), tailored.text);
  await store.reviewResume(base.id, { action: 'revoke' });
  await assert.rejects(store.exportResume(tailored.id), /human-approved/);
  assert.equal((await store.state()).resumes.at(-1).status, 'revoked');
});

test('forgetting the source erases tailored descendants of generated versions', async (t) => {
  const { store } = await fixture(t);
  await store.authorizeSource({ id: 'manual', projects: ['personal'] });
  const { evidence: [entry] } = await store.ingestEvents([workEvent({ sourceId: 'manual', projectId: 'personal' })], { explicitManual: true });
  await store.reviewEvidence(entry.id, { action: 'approve', shareable: true });
  const base = await store.proposeResume({ title: '从证据生成', items: [{ text: entry.text, evidenceIds: [entry.id] }] });
  await store.reviewResume(base.id, { action: 'approve' });
  const tailored = await store.proposeTailoredResume({ baseId: base.id, title: '调整措辞',
    lines: [{ source: `- ${entry.text}`, text: '执行 SKU 校验。' }] });
  await store.reviewResume(tailored.id, { action: 'approve' });
  const nested = await store.proposeTailoredResume({ baseId: tailored.id, title: '再调整',
    lines: [{ source: '- 执行 SKU 校验。', text: '执行 SKU 校验任务。' }] });
  await store.reviewResume(nested.id, { action: 'approve' });
  assert.match(await store.exportResume(nested.id), /执行 SKU 校验任务/);
  await store.forgetSource('manual');
  assert.deepEqual((await store.state()).resumes, []);
});

test('evidence updates preserve approved conversation optimizations and deduplicate evidence in the base history', async (t) => {
  const { store } = await fixture(t);
  await store.authorizeSource({ id: 'manual', projects: ['personal'] });
  const { evidence: [first, second] } = await store.ingestEvents([
    workEvent({ sourceId: 'manual', projectId: 'personal' }),
    workEvent({ id: 'event-2', sourceId: 'manual', projectId: 'personal',
      evidence: [{ title: '维护交付文档', text: '独立整理了交接指南。' }] }),
  ], { explicitManual: true });
  await store.reviewEvidence(first.id, { action: 'approve', shareable: true });
  await store.reviewEvidence(second.id, { action: 'approve', shareable: true });
  const base = await store.proposeResume({ title: '简历更新', items: [{ text: first.text, evidenceIds: [first.id] }] });
  await store.reviewResume(base.id, { action: 'approve' });
  const optimized = await store.proposeOptimizedResume({
    baseId: base.id, expectedText: await store.exportResume(base.id),
    items: [{ line: 2, source: `- ${first.text}`, text: '负责 SKU 校验并协助上线。', promote: false }],
  });
  await store.reviewResume(optimized.id, { action: 'approve' });
  assert.deepEqual([...resumeEvidenceIds((await store.summary()).resumes, optimized.id)], [first.id]);
  await assert.rejects(store.proposeResume({ title: '简历更新', baseId: optimized.id,
    items: [{ text: first.text, evidenceIds: [first.id] }] }), /already appears/);
  const patch = { title: '简历更新', baseId: optimized.id, items: [{ text: second.text, evidenceIds: [second.id] }] };
  const next = await store.proposeResume(patch);
  assert.equal((await store.proposeResume(patch)).id, next.id);
  const preview = await store.previewResume(next.id);
  assert.ok(preview.includes('负责 SKU 校验并协助上线。'));
  assert.ok(preview.includes(second.text));
  assert.equal(preview.includes(first.text), false);
  assert.equal((await store.summary()).resumes.at(-1).text, preview);
  await store.reviewResume(next.id, { action: 'approve' });
  const job = await store.proposeTailoredResume({ baseId: base.id, title: '岗位定制',
    lines: [{ source: `- ${first.text}`, text: '负责 SKU 上线校验。' }] });
  await store.reviewResume(job.id, { action: 'approve' });
  await assert.rejects(store.proposeResume({ ...patch, baseId: job.id }), /job-specific/);
  await store.reviewEvidence(first.id, { action: 'approve', shareable: false });
  await assert.rejects(store.exportResume(next.id), /human-approved/);
});
