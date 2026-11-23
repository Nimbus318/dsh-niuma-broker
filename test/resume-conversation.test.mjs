import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CareerStore } from '../src/career.mjs';
import { proposeResumeConversation } from '../src/resume-conversation.mjs';

const source = [
  '# 林某',
  '邮箱：user@example.com',
  '## 个人简介',
  '有做运营的经验。',
  '## 工作经历',
  '### A 公司',
  '- 整理交接文档。',
  '- 把交接时间缩短 10%。',
  '### B 公司',
  '- 收集用户反馈。',
].join('\n');

function fixtureModel(result) {
  return {
    listProviders: () => [{ id: 'fixture' }],
    async *stream({ messages, tools }) {
      assert.deepEqual(tools, []);
      const response = result(JSON.parse(messages[0].content[0].text));
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(response) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const config = { model: 'fixture:mock', sendToModel: true };

test('optimizes one selected pending version, anchors its diff, and keeps approval and lineage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'niuma-resume-conversation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CareerStore({ file: join(directory, 'career.json') });
  const base = await store.importResume({ title: '个人简历', text: source });
  const request = '精简简介，提高交接成果的优先级。';
  const phases = [];
  const { items, summary } = await proposeResumeConversation({
    config, source: await store.previewResume(base.id), request,
    phase: value => phases.push(value),
    llm: fixtureModel(input => {
      assert.equal(input.request, request);
      assert.deepEqual(input.lines.map(row => row.index), [3, 6, 7, 9]);
      assert.doesNotMatch(JSON.stringify(input.lines), /林某|example\.com/);
      return { items: [{ index: 3, text: '具备运营经验。' }, { index: 7, text: '缩短交接时间 10%。', promote: true }], summary: '把已经量化的交接成果前移。' };
    }),
  });
  assert.deepEqual(phases, ['drafting', 'verifying']);
  assert.deepEqual(items.map(edit => edit.source), ['有做运营的经验。', '- 把交接时间缩短 10%。']);
  const draft = await store.proposeOptimizedResume({ baseId: base.id, items, summary, expectedText: source });
  assert.equal(draft.parentId, base.id);
  assert.equal(draft.variant, 'conversation');
  assert.equal(draft.summary, summary);
  assert.match(draft.text, /### A 公司\n- 缩短交接时间 10%。\n- 整理交接文档。\n### B 公司\n- 收集用户反馈。/);
  assert.equal(await store.previewResume(base.id), source);
  await assert.rejects(store.exportResume(draft.id), /human-approved/);
  await assert.rejects(store.reviewResume(draft.id, { action: 'approve', selected: [0, 0] }), /有效改动/);
  const accepted = await store.reviewResume(draft.id, { action: 'approve', selected: [1] });
  assert.equal(accepted.parentId, draft.id);
  assert.equal((await store.reviewResume(draft.id, { action: 'approve', selected: [1] })).id, accepted.id);
  const acceptedText = await store.exportResume(accepted.id);
  assert.match(acceptedText, /有做运营的经验。/);
  assert.match(acceptedText, /### A 公司\n- 缩短交接时间 10%。\n- 整理交接文档。/);
  await assert.rejects(store.exportResume(draft.id), /human-approved/);

  const humanEdit = await store.reviseResume(draft.id, { items: ['具有运营经验。', '交接用时减少 10%。'] });
  assert.equal(humanEdit.parentId, draft.id);
  assert.deepEqual(humanEdit.items.map(row => row.source), items.map(row => row.source));
  await store.reviewResume(humanEdit.id, { action: 'approve' });
  assert.match(await store.exportResume(humanEdit.id), /交接用时减少 10%。/);
  await store.reviewResume(base.id, { action: 'revoke' });
  await assert.rejects(store.exportResume(humanEdit.id), /human-approved/);
  await assert.rejects(store.exportResume(accepted.id), /human-approved/);
});

test('rejects changed metrics and results targeting protected or duplicate source positions', async () => {
  const propose = items => proposeResumeConversation({
    config, source, request: '优化交接成果', llm: fixtureModel(() => ({ items })),
  });
  await assert.rejects(propose([{ index: 7, text: '缩短交接时间 30%。' }]), /原句之外/);
  await assert.rejects(propose([{ index: 1, text: '改地址' }]), /未关联/);
  await assert.rejects(propose([{ index: 3, text: '有运营经验。', promote: true }]), /留在原位/);
  await assert.rejects(propose([{ index: 7, text: '交接耗时减少 10%。' }, { index: 7, text: '节约 10% 的交接时间。' }]), /唯一对应/);
});
