import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

/**
 * T6.9 视觉升级（P10 起：首页图标墙已删除，条目改平面底）：「试试」关键词都能搜到、卡片用 AVIF / WebP 多尺寸图标并带宽高、
 * 色相渐变封面（纯 CSS）、悬停动效只用 transform（不产生布局偏移）、减少动态效果时关闭、
 * 键盘焦点环、深浅两种配色下的 axe（含对比度）。
 */
const isDesktop = (name: string) => name.endsWith('-desktop');

test.describe('T6.9 视觉', () => {
  test('「试试」关键词有意义，且每个都能搜到结果', async ({ page }, info) => {
    test.skip(!/chromium-desktop/.test(info.project.name), '与引擎 / 视口无关，只跑一次');
    await page.goto('/');
    const qs = await page.locator('.home-try a').allTextContents();
    expect(qs.map((q) => q.trim())).toEqual(['动画编辑器', 'Cursor', '塔防', 'MCP']);
    for (const q of qs) {
      await page.goto(`/search/?q=${encodeURIComponent(q.trim())}`);
      await expect(page.locator('[data-status]')).toContainText(/共 \d+ 条结果/);
    }
  });

  for (const route of ['/', '/apps/', '/ai/', '/apps/fablemotion/']) {
    test(`图标：${route} 每个应用 / 工具图标都是 <picture>（AVIF + WebP 1x/2x）且有宽高`, async ({
      page,
    }) => {
      await page.goto(route);
      const icons = await page.locator('main img.app-icon-img').evaluateAll((els) =>
        els.map((e) => {
          const img = e as HTMLImageElement;
          const pic = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
          return {
            src: img.getAttribute('src') ?? '',
            w: img.getAttribute('width'),
            h: img.getAttribute('height'),
            avif: pic?.querySelector('source[type="image/avif"]')?.getAttribute('srcset') ?? '',
            webp: img.getAttribute('srcset') ?? '',
          };
        }),
      );
      expect(icons.length).toBeGreaterThan(0);
      // 只有 CI 的 E2E 夹具应用（src/content/apps/_e2e/）用单个 SVG 占位图标，线上构建没有它
      for (const i of icons.filter((x) => !x.src.endsWith('/placeholder.svg'))) {
        expect(i.w && i.h, i.src).toBeTruthy();
        // T9.3 规范化管线：/icons/n/<slug>-<px>.webp（32–224 档，src = 2x）
        expect(i.src, i.src).toMatch(/\/icons\/n\/[a-z0-9-]+-\d+\.webp$/);
        expect(i.avif, i.src).toMatch(/\.avif 1x, .+\.avif 2x$/);
        expect(i.webp, i.src).toMatch(/\.webp 1x, .+\.webp 2x$/);
      }
    });
  }

  test('应用目录筛选后（浏览器端渲染的条目）与静态条目同结构：<picture> 图标 + 类型徽标 + 主操作', async ({
    page,
  }) => {
    await page.goto('/apps/?category=creative');
    const card = page.locator('[data-catalog-grid] [data-entry]').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/entry entry--tile/);
    await expect(card.locator('picture source[type="image/avif"]')).toHaveCount(1);
    await expect(card.locator('.entry__type')).toHaveText('应用');
    await expect(card.locator('.entry__action')).toHaveAttribute('href', /^\/(apps|go)\//);
  });

  test('P10 紧凑档：列表条目与详情页头部都是平面底（没有大面积渐变 / 横幅图片）', async ({ page }) => {
    const imgs: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'image') imgs.push(new URL(r.url()).pathname);
    });
    for (const route of ['/apps/', '/ai/', '/games/', '/']) {
      await page.goto(route);
      const entry = page.locator('main [data-entry]').first();
      expect(await entry.evaluate((e) => getComputedStyle(e).backgroundImage), route).toBe('none');
    }
    await page.goto('/apps/fablemotion/');
    // PR G（T10.11）：详情页头部去掉色相横幅，平面底 + 细分隔
    const hero = page.locator('[data-detail-hero]');
    expect(await hero.evaluate((e) => getComputedStyle(e).backgroundImage)).toBe('none');
    expect(imgs.filter((u) => /cover|gradient|banner/.test(u))).toEqual([]);
  });

  test('悬停：条目换底色、至多轻浮起 2px（周围元素不动）', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '只在能悬停的桌面视口');
    await page.goto('/apps/');
    await page.waitForLoadState('networkidle');
    const cards = page.locator('[data-catalog-grid] [data-entry]');
    const second = cards.nth(1);
    const before = await second.boundingBox();
    const bg0 = await cards.first().evaluate((e) => getComputedStyle(e).backgroundColor);
    await cards.first().locator('.entry__link').hover();
    await expect.poll(() => cards.first().evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(bg0);
    // P10h：悬停轻浮起 ≤ 2px（只平移、不缩放，不影响周围布局）
    const m = await cards.first().evaluate((e) => new DOMMatrixReadOnly(getComputedStyle(e).transform));
    expect([m.a, m.d, m.b, m.c, m.e]).toEqual([1, 1, 0, 0, 0]);
    expect(m.f).toBeGreaterThanOrEqual(-2.01);
    expect(m.f).toBeLessThanOrEqual(0);
    expect(await second.boundingBox()).toEqual(before);
  });

  test('键盘焦点：卡片链接显示焦点环', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '键盘导航只在桌面视口');
    await page.goto('/apps/');
    const link = page.locator('[data-catalog-grid] [data-entry] .entry__link').first();
    await link.focus();
    // P10 条目：焦点环画在整张条目上（:has(:focus-visible) 的 outline，强制色下仍可见，DESIGN-SYSTEM §16）
    const ring = await page
      .locator('[data-catalog-grid] [data-entry]')
      .first()
      .evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(ring).not.toBe('none');
  });

  // 浅色模式的 axe 由 a11y.spec.ts（全部路由）负责；这里补深色
  for (const scheme of ['dark'] as const) {
    for (const route of ['/apps/', '/ai/', '/apps/fablemotion/', '/ai/claude-code/', '/games/', '/works/']) {
      test(`axe（${scheme === 'dark' ? '深色' : '浅色'}，含对比度）：${route}`, async ({ page }, info) => {
        test.skip(!/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(route);
        await page.waitForLoadState('networkidle');
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          r.violations.map(
            (v) =>
              `${v.id}: ${v.nodes
                .map((n) => n.target.join(' '))
                .slice(0, 3)
                .join(' | ')}`,
          ),
        ).toEqual([]);
      });
    }
  }
});
