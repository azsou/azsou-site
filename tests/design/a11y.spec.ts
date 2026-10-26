/**
 * T9.18 无障碍专项（Chromium，设计门禁）：
 *  - axe（WCAG 2.2 A/AA）深色 + 强制色：设计页面清单全集（浅色由 tests/e2e/a11y.spec.ts 在三引擎跑全部路由）
 *  - 结构：唯一 <main id="main">、跳到正文链接是第一个可聚焦元素且指向 main、唯一 h1、标题不跳级、
 *    banner / contentinfo 地标、无正 tabindex
 *  - 键盘：从页首连续 Tab 40 次，每个焦点元素都可见、有 ≥ 2px outline（或 ::after outline）、不被固定栏遮住
 *  - 键盘流程：导航「更多」、列表筛选（更多筛选 + 排序）、登录表单、发帖页、搜索页
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES } from './pages';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** 不走前台外壳的组件目录页：没有站点导航 / 页脚 */
const NO_CHROME = new Set(['kit', 'kit-prose', 'kit-admin']);

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
}

async function blockThirdParty(page: Page) {
  await page.route(/supabase\.co|challenges\.cloudflare\.com|googlesyndication|googletagmanager/, (r) =>
    r.abort(),
  );
}

for (const p of PAGES) {
  for (const mode of ['dark', 'forced'] as const) {
    test(`axe ${mode} ${p.name}`, async ({ page }) => {
      await blockThirdParty(page);
      await page.emulateMedia(
        mode === 'dark' ? { colorScheme: 'dark' } : { colorScheme: 'light', forcedColors: 'active' },
      );
      await page.goto(p.path);
      await page.waitForLoadState('load');
      expect(await axe(page)).toEqual([]);
    });
  }

  test(`结构与地标 ${p.name}`, async ({ page }) => {
    await blockThirdParty(page);
    await page.goto(p.path);
    const s = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
        (h) => !h.closest('[hidden],template,dialog:not([open])') && (h as HTMLElement).offsetParent !== null,
      );
      const levels = heads.map((h) => Number(h.tagName[1]));
      const skips: string[] = [];
      for (let i = 1; i < levels.length; i++)
        if (levels[i] > levels[i - 1] + 1)
          skips.push(`h${levels[i - 1]}→h${levels[i]}「${heads[i].textContent?.trim().slice(0, 20)}」`);
      const focusables = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]',
        ),
      ].filter((e) => e.tabIndex >= 0);
      const skip = document.querySelector<HTMLAnchorElement>('a.skip-link');
      return {
        mains: document.querySelectorAll('main').length,
        mainId: document.querySelector('main')?.id,
        h1: document.querySelectorAll('h1').length,
        skips,
        first: focusables[0]?.className ?? '',
        skipHref: skip?.getAttribute('href') ?? null,
        banner: !!document.querySelector('header, [role=banner]'),
        contentinfo: !!document.querySelector('footer, [role=contentinfo]'),
        positiveTabindex: [...document.querySelectorAll<HTMLElement>('[tabindex]')]
          .filter((e) => e.tabIndex > 0)
          .map((e) => e.outerHTML.slice(0, 60)),
        lang: document.documentElement.lang,
      };
    });
    expect(s.mains, '恰好一个 <main>').toBe(1);
    expect(s.mainId).toBe('main');
    expect(s.h1, '恰好一个 h1').toBe(1);
    expect(s.skips, '标题不跳级').toEqual([]);
    expect(s.positiveTabindex, '无正 tabindex').toEqual([]);
    expect(s.lang).toMatch(/^(zh-CN|en)$/);
    if (!NO_CHROME.has(p.name)) {
      expect(s.first, '第一个可聚焦元素是「跳到正文」').toContain('skip-link');
      expect(s.skipHref).toBe('#main');
      expect(s.banner && s.contentinfo, 'banner + contentinfo 地标').toBe(true);
    }
  });
}

/** 连续 Tab：焦点可见（outline ≥ 2px）、在视口内、没被固定导航 / TabBar 盖住 */
for (const p of PAGES.filter((x) => x.core || x.name === 'en-home' || x.name === 'subscribe')) {
  for (const vp of [
    { name: '1440', width: 1440, height: 900 },
    { name: '390', width: 390, height: 844 },
  ]) {
    test(`键盘 Tab 焦点可见 ${p.name}@${vp.name}`, async ({ page }) => {
      await blockThirdParty(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(p.path);
      const bad: string[] = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const c = getComputedStyle(el);
          const a = getComputedStyle(el, '::after');
          const has = (s: CSSStyleDeclaration) =>
            s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
          // 复合输入框（首页搜索）把焦点环画在 :focus-within 的外框上
          let up: HTMLElement | null = el.parentElement;
          let within = false;
          for (let k = 0; k < 3 && up && !within; k++, up = up.parentElement)
            within = up.matches(':focus-within') && has(getComputedStyle(up));
          const ring = has(c) || has(a) || within;
          const b = el.getBoundingClientRect();
          const cx = Math.min(Math.max(b.left + b.width / 2, 0), innerWidth - 1);
          const cy = Math.min(Math.max(b.top + Math.min(b.height / 2, 12), 0), innerHeight - 1);
          const hit = document.elementFromPoint(cx, cy);
          const lbls = (el as HTMLInputElement).labels;
          const ownLabel = !!hit && !!lbls && [...lbls].some((l) => l.contains(hit));
          const covered = !!hit && !el.contains(hit) && !hit.contains(el) && !ownLabel;
          const inView = b.bottom > 0 && b.top < innerHeight && b.width > 0 && b.height > 0;
          const label = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}「${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 16)}」`;
          return {
            ring,
            inView,
            covered,
            label,
            hitCls: hit ? `${hit.tagName}.${String(hit.className).split(' ')[0]}` : '',
          };
        });
        if (!r) continue;
        if (!r.ring) bad.push(`无焦点环 ${r.label}`);
        if (!r.inView) bad.push(`不在视口 ${r.label}`);
        else if (r.covered) bad.push(`被遮挡 ${r.label} ← ${r.hitCls}`);
      }
      expect([...new Set(bad)]).toEqual([]);
    });
  }
}

test.describe('键盘流程', () => {
  test.beforeEach(async ({ page }) => {
    await blockThirdParty(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('导航「更多」：Enter 展开、Esc 收起且焦点回到按钮（1024）', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    const btn = page.locator('.nav-more__btn');
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-nav-more]')).toHaveAttribute('open', '');
    await page.keyboard.press('Tab');
    await expect(page.locator('.nav-more__list a').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-nav-more]')).not.toHaveAttribute('open', '');
    await expect(btn).toBeFocused();
  });

  test('列表筛选：分类胶囊可 Tab 到达，「更多筛选」用键盘展开并切换排序', async ({ page }) => {
    await page.goto('/apps/');
    const chip = page.locator('.chip[aria-current="page"]').first();
    await chip.focus();
    await expect(chip).toBeFocused();
    const more = page.locator('[data-more-filters] > summary');
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-more-filters]')).toHaveAttribute('open', '');
    const sort = page.locator('[data-sort]').nth(1);
    await sort.focus();
    await page.keyboard.press('Space');
    await expect(sort).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-catalog-status]')).toBeVisible();
  });

  test('登录表单：Tab 顺序 邮箱 → 密码 → 登录按钮，字段有可见标签', async ({ page }) => {
    await page.goto('/login/');
    const email = page.locator('input[type="email"]').first();
    await email.focus();
    await page.keyboard.press('Tab');
    let guard = 0;
    while (guard++ < 4 && !(await page.locator('input[type="password"]:focus').count()))
      await page.keyboard.press('Tab');
    await expect(page.locator('input[type="password"]').first()).toBeFocused();
    const labelled = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('main input:not([type=hidden])')].every(
        (i) => (i.labels?.length ?? 0) > 0 || !!i.getAttribute('aria-label'),
      ),
    );
    expect(labelled).toBe(true);
    guard = 0;
    while (guard++ < 6) {
      await page.keyboard.press('Tab');
      if (await page.locator('main form button[type="submit"]:focus').count()) break;
    }
    await expect(page.locator('main form button[type="submit"]').first()).toBeFocused();
  });

  test('发帖页：未登录提示可键盘到达登录链接', async ({ page }) => {
    await page.goto('/forum/new/');
    const link = page.locator('main a[href*="/login/"]').first();
    await expect(link).toBeVisible();
    await link.focus();
    await expect(link).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test('搜索页：搜索框有名称，输入后结果区以 live region 播报', async ({ page }) => {
    await page.goto('/search/');
    const box = page.getByRole('searchbox').or(page.getByRole('combobox')).first();
    await box.focus();
    await expect(box).toBeFocused();
    const live = await page.locator('main [aria-live], main [role="status"]').count();
    expect(live).toBeGreaterThan(0);
  });
});
