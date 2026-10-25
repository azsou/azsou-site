/**
 * Q11 系统模式：强制色下焦点可见（outline ≥ 2px）、减少动态无位移动画、仅文字放大 200% 无横向溢出。
 */
import { expect, test } from '@playwright/test';
import { PAGES } from './pages';
import { knownIssue } from './known';

const CORE = PAGES.filter((p) => p.core);

for (const p of CORE) {
  test(`forced-colors 焦点可见 ${p.name}`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(p.path);
    // DESIGN-QA §2.11：先按一次键盘让 Chromium 进入键盘模式，再聚焦 main 里第一个链接
    await page.keyboard.press('Shift');
    await page.locator('main a:visible').first().focus();
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const c = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      const own = c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 2;
      const pseudo = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) >= 2;
      return { ok: own || pseudo, tag: el.tagName, cls: el.className };
    });
    expect(ring.ok, `${ring.tag}.${ring.cls} 在强制色下没有 outline 焦点环`).toBe(true);
  });

  test(`reduced-motion 无位移动画 ${p.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(p.path);
    const moving = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => {
          const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? [];
          return kf.some((k) => k.transform && k.transform !== 'none');
        })
        .map((a) => (a as CSSAnimation).animationName ?? 'transition'),
    );
    expect(moving).toEqual([]);
    const smooth = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
    expect(smooth).not.toBe('smooth');
  });

  test(`text-zoom 200% 无横向溢出 ${p.name}`, async ({ page }) => {
    const issue = knownIssue('zoom', p.name, '390');
    test.fixme(!!issue && !process.env.DESIGN_STRICT, issue);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(p.path);
    await page.addStyleTag({ content: 'html{font-size:200%}' });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

// Q11 打印（T9.15）：导航 / TabBar / 页脚 / 评论不打印；正文黑字白底；文章页数有上限
test('print 样式与页数上限 article-detail', async ({ page }) => {
  await page.goto('/articles/pinyin-initial-search/');
  await page.emulateMedia({ media: 'print' });
  const hidden = await page.evaluate(() =>
    ['.site-nav', '.tabbar', '.site-footer', '.discussion'].map((s) => {
      const el = document.querySelector(s);
      return !el || getComputedStyle(el).display === 'none';
    }),
  );
  expect(hidden).toEqual([true, true, true, true]);
  const color = await page.evaluate(() => getComputedStyle(document.documentElement).color);
  expect(color).toBe('rgb(0, 0, 0)');
  const pdf = await page.pdf({ format: 'A4' });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pages, '打印页数').toBeLessThanOrEqual(8);
  expect(pages).toBeGreaterThan(0);
});
