/**
 * 正文排版（T9.14，DESIGN-SYSTEM §22.4）：正文列内块右缘对齐（差 ≤ 1px）、代码块不折行、h3 ≥ 正文字号、
 * 长文行长 ≤ 45 字（Q12，按 reading-max / 字号估算）。
 */
import { expect, test } from '@playwright/test';

for (const path of ['/_kit/prose/', '/articles/pinyin-initial-search/']) {
  for (const vp of [
    { name: '1440', width: 1440, height: 900 },
    { name: '390', width: 390, height: 844 },
  ]) {
    test(`正文排版 ${path} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto(path);
      const r = await page.$eval('.prose', (prose) => {
        const blocks = Array.from(prose.children).filter((c) =>
          /^(P|UL|OL|BLOCKQUOTE|FIGURE|DIV|PRE|H2|H3|HR|SECTION)$/.test(c.tagName),
        );
        const rights = blocks.map((b) => Math.round(b.getBoundingClientRect().right));
        const pres = Array.from(prose.querySelectorAll('pre')).map((p) => getComputedStyle(p).whiteSpace);
        const body = parseFloat(getComputedStyle(prose).fontSize);
        const h3 = Array.from(prose.querySelectorAll('h3')).map((h) =>
          parseFloat(getComputedStyle(h).fontSize),
        );
        const width = prose.getBoundingClientRect().width;
        return { spread: Math.max(...rights) - Math.min(...rights), pres, body, h3, perLine: width / body };
      });
      expect(r.spread, '正文列内块右缘差').toBeLessThanOrEqual(1);
      expect(
        r.pres.every((w) => w === 'pre'),
        '代码块不折行',
      ).toBe(true);
      for (const s of r.h3) expect(s, 'h3 ≥ 正文字号').toBeGreaterThanOrEqual(r.body);
      expect(r.perLine, '每行字数（按字号估算）').toBeLessThanOrEqual(45);
    });
  }
}
