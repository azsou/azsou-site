import { expect, test, type Page } from '@playwright/test';

/**
 * 回归：桌面列表页「解析到一半先画的那一帧」不能让工具区 / 列表顶部移位（桌面 Lighthouse /apps/ CLS 偶发 0.047–0.049）。
 *
 * 根因（2026-10-28，CI run 40630747358 + 本地 Lighthouse 12.6.1 desktop 20 次复现 1 次 0.0486，trace 见
 * docs/audits/evidence/ci/lighthouse-apps-cls-2026-10-28.md）：/apps/ HTML 约 124KB，Chromium 解析到列表之前就先画一帧。
 * ≥ 1200 时主栏和分类栏同一网格行，主栏被拉到分类栏高度（258px）；.list-main 网格的 align-content 默认 stretch，
 * 把唯一的 auto 行一起拉高，行内 align-items: center → 「更多筛选」落在 y≈340，条目到齐后回到 y≈255（frame_max_distance 85px）。
 *
 * 这里不靠时序：直接把页面 HTML 截断在三个真实的解析位置（工具条之前 / 列表开头 / 第一个条目之后），由浏览器自动补齐标签，
 * 得到的就是那一帧的布局；关掉 JS，两边都只比 CSS 布局。
 *  - 工具条、列表顶部：只要已解析出来，就必须与完整页面完全一致；
 *  - 「更多筛选」：绝不能比最终位置低（被拉高的行把它压到分类栏中线就是那 85px）；工具条还没解析时它所在行只有自己高，
 *    会比最终位置高最多 22px（最终行高由工具条决定）。这一小段（158×44 的按钮、CLS 约 0.0001）在 PR #6 里随
 *    「更多筛选 / 工具条统一外边距」一起消除；那一步会改最终布局和视觉基线，所以不在本 PR 做。
 */
test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ page }) => {
  await page.route(/supabase\.co|challenges\.cloudflare\.com|googlesyndication|googletagmanager/, (r) =>
    r.abort(),
  );
});

type Pos = { more: number | null; toolbar: number | null; items: number | null };

const measure = (page: Page): Promise<Pos> =>
  page.evaluate(() => {
    const y = (sel: string) => {
      const e = document.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null;
    };
    return {
      more: y('[data-more-filters] > summary'),
      toolbar: y('.list-toolbar'),
      items: y('[data-list-items]'),
    };
  });

/** 截断点：返回 HTML 中「解析到这里为止」的字节位置（字符串下标）。 */
function cutPoints(html: string): Record<string, number> {
  const toolbar = html.indexOf('<div class="list-toolbar');
  const listOpen = html.indexOf('<ul class="list-items');
  const listOpenEnd = html.indexOf('>', listOpen) + 1;
  const firstItemEnd = html.indexOf('</li>', listOpenEnd) + '</li>'.length;
  expect(toolbar, '找不到 .list-toolbar').toBeGreaterThan(0);
  expect(listOpen, '找不到 .list-items').toBeGreaterThan(toolbar);
  return {
    工具条还没解析: toolbar,
    '列表 0 个条目': listOpenEnd,
    '列表 1 个条目': firstItemEnd,
  };
}

for (const path of ['/apps/', '/ai/']) {
  for (const width of [1350, 1440, 1024]) {
    test(`首帧 CLS ${path} @${width}：HTML 只解析到一半时工具区与列表顶部已在最终位置`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 940 });
      const html = await (await page.request.get(new URL(path, baseURL).href)).text();
      await page.goto(path, { waitUntil: 'load' });
      const full = await measure(page);
      expect(full.more, '完整页面：更多筛选').not.toBeNull();
      expect(full.toolbar, '完整页面：工具条').not.toBeNull();

      for (const [label, cut] of Object.entries(cutPoints(html))) {
        await page.route(new URL(path, baseURL).href, (r) =>
          r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html.slice(0, cut) }),
        );
        await page.goto(path, { waitUntil: 'load' });
        const partial = await measure(page);
        await page.unroute(new URL(path, baseURL).href);
        expect(partial.more, `${label}：更多筛选不能被拉到最终位置以下`).toBeLessThanOrEqual(full.more!);
        expect(full.more! - partial.more!, `${label}：更多筛选与最终位置的差`).toBeLessThanOrEqual(22);
        if (partial.toolbar !== null) expect(partial.toolbar, `${label}：工具条`).toBe(full.toolbar);
        if (partial.items !== null) expect(partial.items, `${label}：列表顶部`).toBe(full.items);
      }
    });
  }
}
