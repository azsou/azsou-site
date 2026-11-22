/**
 * Q5 / Q8 / Q12：全视口溢出 0、拉丁单词内断行 0、导航 / 按钮单字断行 0；意外截断 0；排版档数。
 * 运行：npm run test:design（需先 npm run build）
 */
import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PAGES, VIEWPORTS, FIXED_TIME } from './pages';
import { measure, settle } from './detect';
import { knownIssue } from './known';

const REPORT = process.env.DESIGN_REPORT;

for (const p of PAGES) {
  test.describe(p.name, () => {
    for (const vp of VIEWPORTS) {
      test(`layout ${p.name} @${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.clock.setFixedTime(new Date(FIXED_TIME));
        await page.goto(p.path, { waitUntil: 'networkidle' });
        await settle(page);
        const m = await measure(page);
        if (REPORT) appendFileSync(REPORT, JSON.stringify({ page: p.name, vp: vp.name, ...m }) + '\n');
        const soft = (check: string) => knownIssue(check, p.name, vp.name);
        const issue = soft('overflow') ?? soft('midword') ?? soft('singlechar');
        test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
        expect(m.overflow, '页面横向溢出（px）').toBeLessThanOrEqual(0);
        expect(m.midWord, '拉丁单词内断行').toEqual([]);
        expect(m.singleChar, '导航 / 按钮单字断行').toEqual([]);
        if (vp.name === '1440' || vp.name === '390') {
          const t = soft('trunc');
          if (!t || process.env.DESIGN_STRICT) {
            expect(
              m.trunc.filter((x) => x.kind === 'ellipsis'),
              '单行省略号截断',
            ).toEqual([]);
            expect(m.trunc.filter((x) => x.kind === 'clamp').length, '2 行简介被截断').toBeLessThanOrEqual(
              Math.ceil(m.clampTotal * 0.2),
            );
          }
        }
        if (vp.name === '1440') {
          expect(m.tiny, '小于 12px 的文字').toBe(0);
          expect(
            m.weights.filter((w) => !['400', '600', '700'].includes(w)),
            '字重只允许 400/600/700',
          ).toEqual([]);
          const t = soft('typescale');
          if (!t || process.env.DESIGN_STRICT)
            expect(m.fontSizes.length, `字号档数 ${m.fontSizes.join(' ')}`).toBeLessThanOrEqual(8);
        }
      });
    }
  });
}
