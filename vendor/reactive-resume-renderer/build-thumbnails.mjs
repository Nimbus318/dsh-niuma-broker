import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { localResumeTemplates, renderLocalResume } from '../../src/local-templates.mjs';

const [playwrightModule, executablePath] = process.argv.slice(2);
const { chromium } = playwrightModule
  ? await import(pathToFileURL(resolve(playwrightModule)))
  : await import('playwright');
const encodeWebp = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), 'niuma-template-gallery-'));
const sample = `# 林予安
_AI 基础设施产品经理_
邮箱：lin.yuan@example.invalid
地址：上海

## 个人简介
负责算力平台和研发工具的产品工作，熟悉 GPU 资源管理、跨团队交付及项目复盘。关注复杂系统在实际业务中的使用体验。

## 工作经历
### 栖梧云计算 · 基础设施产品经理
2022.07 至今
- 负责 GPU 资源管理控制台的需求分析、路线图规划和迭代验收。
- 连同研发与运维统一容量和配额口径，推动 3 个算力资源池的扩容。
- 建立需求反馈和验收指标看板，将平均问题确认时间由 5 天缩短到 3 天。

### 岚桥软件 · 产品专员
2019.06 — 2022.06
- 整理内部研发工具的需求，负责原型、验收用例及版本说明。
- 联合支持团队梳理高频工单，改善首次接入和环境诊断流程。

## 项目经历
### GPU 资源利用率看板
- 梳理利用率、等待时长和任务失败率的统计口径，建立周度复盘模板。
- 支持业务方按工作负载识别资源瓶颈，追踪优化措施的执行结果。

## 教育经历
东江理工大学 · 信息管理学士 · 2015 — 2019

## 核心技能
- 产品路线图与需求管理
- Kubernetes、GPU 调度
- 数据分析与指标设计
- 跨团队协作与交付

## 语言能力
普通话 · 母语
英语 · 工作沟通
`;

let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
  const attemptedRequests = [];
  await page.route('**/*', async route => {
    attemptedRequests.push(route.request().url());
    await route.abort();
  });
  const images = {};
  for (const { id } of localResumeTemplates) {
    const { html, css, lang } = await renderLocalResume({ text: sample, template: id });
    await page.setContent(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${css}
html,body{margin:0;background:#fff}
.rr{margin:0 auto}
.rr-page{max-width:100%}
</style></head><body><div class="rr">${html}</div></body></html>`);
    const png = join(scratch, id + '.png');
    const webp = join(scratch, id + '.webp');
    await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 794, height: 1123 } });
    await encodeWebp('cwebp', ['-quiet', '-q', '84', '-m', '6', '-resize', '240', '339', png, '-o', webp]);
    images[id] = 'data:image/webp;base64,' + (await readFile(webp)).toString('base64');
  }
  if (attemptedRequests.length) throw new Error('Template previews must render offline.');
  await writeFile(new URL('../../client/template-gallery-previews.json', import.meta.url), JSON.stringify(images, null, 2) + '\n');
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
