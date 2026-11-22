/**
 * Q18 资源与图标：站点图标齐全、首屏无 lazy 图片、按钮 / 链接末尾无字符图标、断图不露 alt 文本。
 */
import { expect, test } from '@playwright/test';
import { PAGES } from './pages';
import { knownIssue } from './known';

test('站点图标：/favicon.ico、favicon.svg、apple-touch-icon、manifest 图标与 shortcuts', async ({
  request,
}) => {
  const issue = knownIssue('favicon', '*', '*');
  test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
  for (const u of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) {
    const r = await request.get(u);
    expect(r.status(), u).toBe(200);
  }
  const m = await (await request.get('/manifest.webmanifest')).json();
  const sizes = (m.icons as { sizes: string; purpose?: string }[]).map(
    (i) => `${i.sizes}${i.purpose && i.purpose !== 'any' ? ':' + i.purpose : ''}`,
  );
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512', '512x512:maskable']));
  expect((m.shortcuts ?? []).length).toBeGreaterThanOrEqual(4);
});

for (const p of PAGES.filter((x) => x.core)) {
  for (const vp of [
    { name: '1440', width: 1440, height: 900 },
    { name: '390', width: 390, height: 844 },
  ]) {
    test(`首屏无 lazy 图片 ${p.name} @${vp.name}`, async ({ page }) => {
      const issue = knownIssue('lazy', p.name, vp.name);
      test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
      await page.setViewportSize(vp);
      await page.goto(p.path);
      const lazy = await page.$$eval('img[loading="lazy"]', (imgs) =>
        imgs
          .filter((i) => {
            const r = i.getBoundingClientRect();
            return r.width > 0 && r.top < innerHeight && r.bottom > 0;
          })
          .map((i) => i.getAttribute('src')),
      );
      expect(lazy).toEqual([]);
    });
  }

  test(`字符图标 0 ${p.name}`, async ({ page }) => {
    const issue = knownIssue('glyph', p.name, '*');
    test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
    await page.goto(p.path);
    const bad = await page.$$eval('a, button', (els) =>
      els.map((e) => (e.textContent || '').trim()).filter((t) => /[→←›‹»✓✕×]$/.test(t)),
    );
    expect(bad).toEqual([]);
  });

  test(`断图不露 alt 文本、无裂图 ${p.name}`, async ({ page }) => {
    const issue = knownIssue('broken-img', p.name, '*');
    test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
    await page.route(/\.(png|webp|avif|jpe?g|svg)(\?.*)?$/, (r) =>
      r.request().resourceType() === 'image' ? r.abort() : r.continue(),
    );
    await page.goto(p.path);
    await page.waitForTimeout(300);
    const leaking = await page.$$eval('main img', (imgs: HTMLImageElement[]) =>
      imgs
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 0 && i.alt && getComputedStyle(i).color !== 'rgba(0, 0, 0, 0)';
        })
        .map((i) => i.alt),
    );
    expect(leaking).toEqual([]);
  });
}
