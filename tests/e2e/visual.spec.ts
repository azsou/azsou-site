import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

/**
 * T6.9 视觉升级：图标墙不重复、「试试」关键词都能搜到、卡片用 AVIF / WebP 多尺寸图标并带宽高、
 * 色相渐变封面（纯 CSS）、悬停动效只用 transform（不产生布局偏移）、减少动态效果时关闭、
 * 键盘焦点环、深浅两种配色下的 axe（含对比度）。
 */
const isDesktop = (name: string) => name.endsWith('-desktop');

test.describe('T6.9 视觉', () => {
  test('首页图标墙：12 个图标、没有重复的品牌 / 图片', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '图标墙只在宽屏显示');
    await page.goto('/');
    const srcs = await page
      .locator('.icon-wall img')
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).getAttribute('src')));
    expect(srcs).toHaveLength(12);
    expect(new Set(srcs).size).toBe(12);
    // ChatGPT 与 Codex CLI 是同一个 OpenAI 标志：最多出现其一
    const openai = srcs.filter((s) => /\/ai\/icons\/(chatgpt|codex-cli)-/.test(s ?? ''));
    expect(openai.length).toBeLessThanOrEqual(1);
  });

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
        expect(i.src, i.src).toMatch(/-(64|128)\.webp$/);
        expect(i.avif, i.src).toMatch(/\.avif 1x, .+\.avif 2x$/);
        expect(i.webp, i.src).toMatch(/\.webp 1x, .+\.webp 2x$/);
      }
    });
  }

  test('应用目录换页后（浏览器端渲染的卡片）仍是 <picture> 图标 + 色相', async ({ page }) => {
    await page.goto('/apps/?category=creative');
    const card = page.locator('[data-catalog-grid] .app-card').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-hue', /^(accent|green|teal|blue|orange|purple)$/);
    await expect(card.locator('picture source[type="image/avif"]')).toHaveCount(1);
  });

  test('色相渐变封面：卡片 / 详情页横幅用 CSS 渐变，没有额外图片请求', async ({ page }) => {
    const imgs: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'image') imgs.push(new URL(r.url()).pathname);
    });
    await page.goto('/apps/fablemotion/');
    const hero = page.locator('.app-hero');
    await expect(hero).toHaveAttribute('data-hue', 'purple');
    expect(await hero.evaluate((e) => getComputedStyle(e).backgroundImage)).toMatch(/gradient/);
    await page.goto('/ai/');
    const tool = page.locator('.tool-card').first();
    await expect(tool).toHaveAttribute('data-hue', /.+/);
    expect(await tool.evaluate((e) => getComputedStyle(e).backgroundImage)).toMatch(/radial-gradient/);
    await page.goto('/games/');
    const media = page.locator('.card--media .card__media').first();
    expect(await media.evaluate((e) => getComputedStyle(e).backgroundImage)).toMatch(/gradient/);
    // 渐变不是图片文件
    expect(imgs.filter((u) => /cover|gradient|banner/.test(u))).toEqual([]);
  });

  test('悬停：卡片上浮 + 图标放大，只改 transform（周围元素不移动）', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '只在能悬停的桌面视口');
    await page.goto('/apps/');
    await page.waitForLoadState('networkidle');
    const cards = page.locator('[data-catalog-grid] .app-card');
    const second = cards.nth(1);
    // 评分 / 下载数一行由 island 异步填入：等它写完再量（预留了整行高度，填入前后卡片也应同高）
    await expect(second.locator('[data-card-stats]'))
      .not.toBeEmpty({ timeout: 3000 })
      .catch(() => {});
    const before = await second.boundingBox();
    await cards.first().locator('.card__link').hover();
    await expect.poll(() => cards.first().evaluate((e) => getComputedStyle(e).transform)).not.toBe('none');
    await expect
      .poll(() =>
        cards
          .first()
          .locator('.app-icon-img')
          .evaluate((e) => getComputedStyle(e).transform),
      )
      .not.toBe('none');
    // 邻居卡片位置不变（transform 不参与布局）
    expect(await second.boundingBox()).toEqual(before);
  });

  test('减少动态效果：悬停不位移、不缩放', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '只在能悬停的桌面视口');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/apps/');
    const card = page.locator('[data-catalog-grid] .app-card').first();
    await card.locator('.card__link').hover();
    await page.waitForTimeout(350);
    expect(await card.evaluate((e) => getComputedStyle(e).transform)).toBe('none');
    expect(await card.locator('.app-icon-img').evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  });

  test('键盘焦点：卡片链接显示焦点环', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '键盘导航只在桌面视口');
    await page.goto('/apps/');
    const link = page.locator('[data-catalog-grid] .app-card .card__link').first();
    await link.focus();
    // 焦点环画在 ::after（覆盖整张卡片）上
    const ring = await link.evaluate((e) => getComputedStyle(e, '::after').boxShadow);
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
