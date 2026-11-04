import type { Request } from '@playwright/test';
import { test, expect } from './fixtures';
import { BASE_URL } from './port';

/**
 * /apps/ 页面加载期间的全部 JS（含 load 后空闲时才动态加载的 island）≤ 49,152 B——与 lighthouserc.cjs 的
 * `resource-summary:script:size` 同一个预算、同一个口径（脚本响应的传输字节 = gzip 后正文 + 响应头），同一个 gzip 服务器（scripts/serve.mjs）。
 * 站长 2026-10-27：预算不放宽，不靠重跑、推迟空闲加载或挪采样窗口过关。所以这里：
 *  - 用 Lighthouse 的移动档视口（412×823、DPR 1.75、触屏），只放行本机请求（第三方一律拦截）；
 *  - 不在某个时间点截断：load 后等两次 requestIdleCallback，再等到连续 3 秒没有新的脚本请求为止（最多 20 秒），
 *    空闲时加载的 island 全部算进去——采样只会比 Lighthouse 更晚、更全，不会更少；
 *  - 用例失败不重试也照样失败：字节数是构建产物决定的，不随机。
 * 后台专用模块不进公开页面 chunk 的检查见 tests/built/js-budget.test.ts。
 */
const BUDGET = 49_152;

test('/apps/ 加载期间的全部 JS（含空闲加载）≤ 49,152 B（Lighthouse 同口径）', async ({ browser }, info) => {
  test.skip(
    info.project.name !== 'chromium-desktop',
    '只在 chromium 跑一次（字节数与引擎无关，口径与 Lighthouse 的 Chrome 一致）',
  );
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (r) => r.abort());
  const scripts: Request[] = [];
  let last = Date.now();
  page.on('request', (r) => {
    if (r.resourceType() === 'script') {
      scripts.push(r);
      last = Date.now();
    }
  });
  await page.goto('/apps/', { waitUntil: 'load' });
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestIdleCallback(() => requestIdleCallback(() => done(), { timeout: 5000 }), { timeout: 5000 }),
      ),
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() - last < 3000 && Date.now() < deadline) await page.waitForTimeout(250);
  expect(Date.now() - last, '20 秒内脚本请求一直没有停').toBeGreaterThanOrEqual(3000);

  const rows: { url: string; bytes: number }[] = [];
  for (const r of scripts) {
    const res = await r.response();
    expect(res, `${r.url()} 没有响应`).toBeTruthy();
    await res!.finished();
    const s = await r.sizes();
    rows.push({ url: new URL(r.url()).pathname, bytes: s.responseBodySize + s.responseHeadersSize });
  }
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const report = rows
    .sort((a, b) => b.bytes - a.bytes)
    .map((r) => `${String(r.bytes).padStart(6)}  ${r.url}`)
    .join('\n');
  console.log(
    `[js-budget] /apps/ ${rows.length} 个脚本，共 ${total} B（预算 ${BUDGET} B，余量 ${BUDGET - total} B）\n${report}`,
  );
  await info.attach('apps-js.txt', { body: `${total}\n${report}`, contentType: 'text/plain' });
  // 不是 gzip 传输就不是 Lighthouse 的口径（服务器配置变了会让数字失真）
  for (const r of scripts) expect((await r.response())!.headers()['content-encoding'], r.url()).toBe('gzip');
  expect(total, report).toBeLessThanOrEqual(BUDGET);
  await ctx.close();
});
