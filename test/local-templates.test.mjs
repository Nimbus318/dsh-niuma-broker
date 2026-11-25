import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  defaultLocalResumeTemplate, localResumeTemplates, renderLocalResume,
} from '../src/local-templates.mjs';
import { templateIds, templateLayouts as catalogLayouts } from '../src/vendor/reactive-resume-templates.mjs';

const resume = [
  '# 测试候选人',
  '邮箱：candidate@example.invalid',
  '## 工作经历',
  '### 示例公司',
  '- 缩短交接时间 **10%**。',
  '## 核心技能',
  '- 验收与协作',
  '## 自定义栏目',
  '保留这一行。',
].join('\n');

test('renders all upstream page templates with CJK content and both column layouts', async () => {
  assert.equal(localResumeTemplates.length, 18);
  const pages = new Map();
  for (const { id } of localResumeTemplates) {
    const page = await renderLocalResume({ text: resume, template: id });
    pages.set(id, page);
    assert.equal(page.lang, 'zh-CN');
    for (const sentence of ['测试候选人', '邮箱：', 'candidate@example.invalid', '工作经历', '示例公司', '10%', '核心技能', '验收与协作', '自定义栏目', '保留这一行。']) {
      assert.ok(page.html.includes(sentence), id + ' lost ' + sentence);
    }
    assert.doesNotMatch(page.css, /@font-face|url\(/iu);
  }
  assert.match(pages.get('azurill').html, /data-region="sidebar"/u);
  assert.doesNotMatch(pages.get('onyx').html, /data-region="sidebar"/u);
  assert.notEqual(pages.get('onyx').css, pages.get('porygon').css);
});

test('renders untrusted markup as text without remote resources', async () => {
  const page = await renderLocalResume({
    title: '<svg onload=run()>',
    text: '## Test\n<script>test()</script>\n![Test](https://example.invalid/image.png)\n<a href="javascript:test()">Test</a>',
  });
  assert.match(page.html, /&lt;script&gt;test\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(page.html, /<(?:script|svg|img|a)\b/iu);
  assert.doesNotMatch(page.css, /url\(/iu);
});

test('uses Onyx for an unknown template and preserves additional Markdown headings', async () => {
  const text = '# Sample candidate\n## Experience\nOne line.\n## Another heading\n1.5× faster ETL for user_event_stream.';
  const fallback = await renderLocalResume({ text, template: '__proto__' });
  const onyx = await renderLocalResume({ text, template: defaultLocalResumeTemplate });
  assert.deepEqual(fallback, onyx);
  assert.match(fallback.html, /Another heading/u);
  assert.match(fallback.html, /1\.5× faster ETL for user_event_stream\./u);
});

test('renders Markdown mailto and https links cleanly without raw bracket syntax and strips unsafe protocols', async () => {
  const md = [
    '# 林予安',
    '邮箱：[yuan.lin@example.com](mailto:yuan.lin@example.com)',
    'GitHub：[github.com/linyuan-infra](https://github.com/linyuan-infra)',
    '## 项目经历',
    '- 开源项目：[Agent Sandbox](https://github.com/linyuan-infra/sandbox)，避免 [恶意链接](javascript:alert(1))。',
  ].join('\n');
  const page = await renderLocalResume({ text: md, template: 'onyx' });
  assert.doesNotMatch(page.html, /\[yuan\.lin@example\.com\]|\(mailto:|\[github\.com|\[Agent Sandbox\]|javascript:/iu);
  assert.ok(page.html.includes('yuan.lin@example.com'));
  assert.ok(page.html.includes('github.com/linyuan-infra'));
  assert.ok(page.html.includes('Agent Sandbox'));
  assert.ok(page.html.includes('href="https://github.com/linyuan-infra/sandbox"'));
  assert.ok(page.html.includes('恶意链接'));
});

test('local-templates keeps the full renderer lazy-loaded and its static template catalog stays in sync', async () => {
  const source = await readFile(new URL('../src/local-templates.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+[\s\S]*?from\s+['"]\.\/vendor\/reactive-resume-renderer\.mjs['"]/mu,
    'local-templates.mjs must not statically import the full renderer at startup');
  const renderer = await import('../src/vendor/reactive-resume-renderer.mjs');
  assert.deepEqual([...templateIds], [...renderer.templateSchema.options]);
  assert.deepEqual(catalogLayouts, renderer.templateLayouts);
});

test('bundled renderer omits inert unencrypted third-party doc URLs while retaining standard XML namespaces', async () => {
  const bundle = await readFile(new URL('../src/vendor/reactive-resume-renderer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /css-infos\.net|dottoro\.com|cssdot\.ru|phrogz\.net/iu);
  const httpHosts = [...new Set(bundle.match(/http:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) || [])].sort();
  assert.deepEqual(httpHosts, ['http://json-schema.org', 'http://www.w3.org']);
});
