import { expect, test, type Page } from '@playwright/test';
import { FIXED_TIME } from './pages';
import { settle } from './detect';
import { mockAdmin } from './admin-mock';

/**
 * 批次 3（设计系统与交互）验收用例，Chromium。任务 / 用例编号见 docs/audits/2026-10-27-test-plan.md：
 *   D01/T006 手机主栏目 ≤ 2 次操作可达；D02/T007 动效令牌生效；D03/T008 触控命中区 44 且不重叠；
 *   D05/T010 主题与 theme-color 同步、强制色下拉箭头；D07/T012 菜单键盘与快捷键不吞输入法；
 *   F01/T018 AI 列表手机首屏；F09/T026 论坛首屏主题；F10/T027 搜索类型写进 URL；A18/T094 手机权限矩阵与缺参态。
 * 视口是模拟（不是真机）；真机 / 读屏结论另行签字。
 */

async function open(page: Page, path: string, vp: { width: number; height: number }) {
  await page.setViewportSize(vp);
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(path, { waitUntil: 'networkidle' });
  await settle(page);
}

// ------------------------------------------------------------------ D01 / T006
const MAIN_SECTIONS = ['/', '/apps/', '/ai/', '/videos/', '/games/', '/articles/', '/works/', '/forum/'];

for (const width of [320, 390]) {
  for (const from of ['/articles/', '/ai/', '/works/']) {
    test(`T006 手机 ${width} 从 ${from} 最多 2 次操作到达全部主栏目`, async ({ page }) => {
      await open(page, from, { width, height: 844 });
      const tabbar = page.locator('.tabbar');
      await expect(tabbar).toBeVisible();
      const steps: Record<string, number> = {};
      for (const href of MAIN_SECTIONS) {
        if (await tabbar.locator(`:scope > ul a[href="${href}"]`).isVisible()) {
          steps[href] = 1;
          continue;
        }
        const more = tabbar.locator('[data-tabbar-more]');
        if (!(await more.isVisible())) {
          steps[href] = 99;
          continue;
        }
        // 键盘激活（Enter 触发同一 click）：本地沙箱 Chromium 对部分页面的合成鼠标点击不派发事件，键盘路径稳定
        await more.focus();
        await page.keyboard.press('Enter');
        const link = page.locator(`[data-tabbar-panel] a[href="${href}"]`);
        steps[href] = (await link.isVisible()) ? 2 : 99;
        await page.keyboard.press('Escape');
      }
      expect(Object.entries(steps).filter(([, n]) => n > 2)).toEqual([]);
    });
  }
}

test('T006「更多」面板：当前栏目有 aria-current，Esc 关闭并把焦点还给按钮', async ({ page }) => {
  await open(page, '/videos/', { width: 390, height: 844 });
  const more = page.locator('[data-tabbar-more]');
  await expect(more).toHaveAccessibleName(/更多.*当前：视频/);
  await more.focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('[data-tabbar-panel]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('a[href="/videos/"]')).toHaveAttribute('aria-current', 'page');
  // 面板在底栏之上，且不被安全区 / 底栏盖住
  const [p, t] = await Promise.all([panel.boundingBox(), page.locator('.tabbar').boundingBox()]);
  expect(p!.y + p!.height).toBeLessThanOrEqual(t!.y);
  await panel.locator('a').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(more).toBeFocused();
});

// ------------------------------------------------------------------ D02 / T007
test('T007 图标与 Bento 图的过渡时长来自已定义的令牌（不是失效的 0s）', async ({ page }) => {
  await open(page, '/', { width: 1440, height: 900 });
  const durs = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).transitionDuration : null;
    };
    return { icon: pick('.entry__icon'), bento: pick('.bento-tile__shot img') };
  });
  expect(durs.icon).toBe('0.24s');
  if (durs.bento !== null) expect(durs.bento).toBe('0.24s');
});

test('T007 减少动态：悬停不产生位移', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/', { width: 1440, height: 900 });
  const tile = page.locator('main [data-entry]').first();
  await tile.hover();
  const t = await tile.evaluate((e) => getComputedStyle(e).transform);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(t);
});

// ------------------------------------------------------------------ D03 / T008
/**
 * 命中区探针：在目标中心 ±21px（44 × 44 框内，留 1px 舍入）取 8 个点，elementFromPoint 必须落在目标自身（含 ::before 补区）。
 * 相邻目标的 44 框若重叠，至少一方的探针会落到邻居身上而失败，所以同时验证「不重叠」。
 */
async function hitFailures(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const fold = (() => {
      const tab = document.querySelector('.tabbar');
      return tab && getComputedStyle(tab).display !== 'none' ? tab.getBoundingClientRect().top : innerHeight;
    })();
    const bad: string[] = [];
    const els = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      const inTabbar = !!el.closest('.tabbar');
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.left >= 22 &&
        r.right <= innerWidth - 22 &&
        r.top >= 22 &&
        (inTabbar || r.bottom <= fold - 22)
      );
    });
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = 21;
      for (const [dx, dy] of [
        [-d, 0],
        [d, 0],
        [0, -d],
        [0, d],
        [-d, -d],
        [d, -d],
        [-d, d],
        [d, d],
      ]) {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        if (!hit || !(hit === el || el.contains(hit))) {
          const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 16);
          bad.push(
            `${sel} 「${name}」 ${Math.round(r.width)}×${Math.round(r.height)} @(${dx},${dy}) → ${hit?.tagName}.${hit?.className}`,
          );
          break;
        }
      }
    }
    return { count: els.length, bad };
  }, selector);
}

const HIT_TARGETS: { path: string; sels: string[] }[] = [
  {
    path: '/ai/',
    sels: [
      '.tabbar a',
      '.tabbar [data-tabbar-more]',
      '.nav-actions .icon-btn',
      '.list-rail .chip',
      '.more-filters__btn',
      '.list-toolbar .segmented button',
    ],
  },
  { path: '/apps/', sels: ['.list-rail .chip', '.list-toolbar .segmented button'] },
];
for (const t of HIT_TARGETS) {
  test(`T008 ${t.path} @390 触控主目标命中区 ≥ 44 且互不重叠`, async ({ page }) => {
    await open(page, t.path, { width: 390, height: 844 });
    const bad: string[] = [];
    let total = 0;
    for (const sel of t.sels) {
      const r = await hitFailures(page, sel);
      total += r.count;
      bad.push(...r.bad);
    }
    expect(total).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
}

// ------------------------------------------------------------------ D05 / T010
const effectiveThemeColor = (page: Page) =>
  page.evaluate(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const m = metas.find((x) => !x.media || matchMedia(x.media).matches);
    return m?.content ?? null;
  });

test('T010 跟随系统：不刷新切换 light → dark → light，网页与 theme-color 同步；手动选择不被系统覆盖', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, '/', { width: 1440, height: 900 });
  const bg = () =>
    page.evaluate(() => {
      const b = getComputedStyle(document.body).backgroundColor;
      return b === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : b;
    });
  expect(await effectiveThemeColor(page)).toBe('#f5f5f7');
  const lightBg = await bg();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await effectiveThemeColor(page)).toBe('#000000');
  expect(await bg()).not.toBe(lightBg);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await effectiveThemeColor(page)).toBe('#f5f5f7');
  // 手动切到「浅色」（跟随系统 → 浅色）后，系统变深也保持浅色
  await page.locator('.nav-actions [data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await effectiveThemeColor(page)).toBe('#f5f5f7');
  expect(await bg()).toBe(lightBg);
});

test('T010 强制色：自绘下拉箭头换回系统原生箭头（随系统颜色）', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page, '/_kit/', { width: 1440, height: 900 });
  const sel = page.locator('select.select').first();
  await expect(sel).toBeAttached();
  const s = await sel.evaluate((e) => ({
    appearance: getComputedStyle(e).appearance,
    bg: getComputedStyle(e).backgroundImage,
  }));
  expect(s.appearance).toBe('auto');
  expect(s.bg).toBe('none');
});

// ------------------------------------------------------------------ D07 / T012
test('T012 账户菜单：Tab 离开即关闭，Esc 回到触发器', async ({ page }) => {
  await mockAdmin(page, {});
  await open(page, '/articles/', { width: 1440, height: 900 });
  const btn = page.locator('.avatar-btn');
  await expect(btn).toBeVisible();
  await btn.click();
  const menu = page.locator('#user-menu-pop');
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(btn).toBeFocused();
});

test('T012 输入法组字中按 Ctrl+K 不打开搜索面板；Apple 平台提示 ⌘', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }),
  );
  await open(page, '/', { width: 1440, height: 900 });
  await expect(page.locator('.nav-search__kbd')).toHaveText(/⌘\s*K/);
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, isComposing: true, bubbles: true }),
    ),
  );
  await page.waitForTimeout(300);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

// ------------------------------------------------------------------ F01 / T018
test('T018 AI 列表 390×844：常用筛选 / 排序 / 视图在两行内，第一张卡片连同主按钮完整露出', async ({
  page,
}) => {
  await open(page, '/ai/', { width: 390, height: 844 });
  const m = await page.evaluate(() => {
    const top = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const rows = new Set(
      ['.list-rail ul', '.more-filters__btn', '[data-list-sort]', '[data-list-viewtoggle]']
        .map(top)
        .filter((v): v is number => v !== null)
        .map((v) => Math.round(v / 12)),
    );
    const fold = document.querySelector('.tabbar')!.getBoundingClientRect().top;
    const card = document.querySelector('[data-ai-grid] > li')!.getBoundingClientRect();
    return { rows: rows.size, cardBottom: card.bottom, fold };
  });
  expect(m.rows, '工具区控件行数').toBeLessThanOrEqual(2);
  expect(m.cardBottom, '第一张卡片底边').toBeLessThanOrEqual(m.fold);
});

// ------------------------------------------------------------------ F09 / T026
test('T026 论坛 390×844：首屏完整显示第一条主题，保留发帖与搜索', async ({ page }) => {
  await open(page, '/forum/', { width: 390, height: 844 });
  await expect(page.getByRole('link', { name: '发新主题' })).toBeVisible();
  const first = page.locator('[data-forum-list] [data-list] > li').first();
  await expect(first).toBeVisible();
  const box = (await first.boundingBox())!;
  const fold = (await page.locator('.tabbar').boundingBox())!.y;
  expect(box.y + box.height).toBeLessThanOrEqual(fold);
});

// ------------------------------------------------------------------ F10 / T027
test('T027 搜索类型写进 URL：刷新、后退、前进都还原；摘要不是字段堆砌', async ({ page }) => {
  await open(page, '/search/?q=Claude', { width: 1440, height: 900 });
  const tabs = page.locator('[data-type-tabs]');
  await expect(tabs.getByRole('tab').first()).toBeVisible();
  // 键盘激活 = 同一 click 处理器（见 T006 注释）
  await tabs.getByRole('tab', { name: /^视频/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]type=video/);
  await expect(page).toHaveURL(/[?&]q=Claude/);
  const visibleTypes = () =>
    page
      .locator('[data-results] > li:not([hidden])')
      .evaluateAll((ls) => [...new Set(ls.map((l) => (l as HTMLElement).dataset.type))]);
  expect(await visibleTypes()).toEqual(['video']);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(tabs.getByRole('tab', { name: /^视频/ })).toHaveAttribute('aria-selected', 'true');
  expect(await visibleTypes()).toEqual(['video']);
  await page.goBack();
  await expect(tabs.getByRole('tab', { name: /^全部/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(tabs.getByRole('tab', { name: /^视频/ })).toHaveAttribute('aria-selected', 'true');
  // 摘要：不应出现详情页指标条 / 开发者行的字段名（价格、平台、第三方开发者）
  await tabs.getByRole('tab', { name: /^全部/ }).focus();
  await page.keyboard.press('Enter');
  const subs = await page.locator('[data-results] li[data-type="tool"] .list-row__sub').allTextContents();
  expect(subs.length).toBeGreaterThan(0);
  expect(subs.filter((s) => /价格|第三方开发者|平台\s/.test(s))).toEqual([]);
});

test('T027 未知 type 参数安全回退到「全部」', async ({ page }) => {
  await open(page, '/search/?q=Claude&type=bogus', { width: 1440, height: 900 });
  await expect(page.locator('[data-type-tabs]').getByRole('tab', { name: /^全部/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).not.toHaveURL(/type=/);
});

// ------------------------------------------------------------------ A18 / T094
for (const width of [390, 320]) {
  test(`T094 权限矩阵 @${width}：能力列不是文字柱，整页不横向溢出`, async ({ page }) => {
    await mockAdmin(page, {});
    await open(page, '/admin/permissions/', { width, height: 844 });
    const m = await page.evaluate(() => {
      const ths = [...document.querySelectorAll<HTMLElement>('[data-perm-table] tbody th[scope="row"]')];
      const fs = parseFloat(getComputedStyle(ths[0]).fontSize);
      return {
        minWidthEm: Math.min(...ths.map((t) => t.getBoundingClientRect().width / fs)),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(m.minWidthEm, '能力列最窄宽度（em）').toBeGreaterThanOrEqual(8);
    expect(m.pageOverflow, '整页横向溢出').toBeLessThanOrEqual(0);
  });
}

test('T094 用户详情缺参态 @390：顶部没有大块空白；手机搜索按钮的名称含功能', async ({ page }) => {
  await mockAdmin(page, {});
  await open(page, '/admin/users/view/', { width: 390, height: 844 });
  const nav = (await page.locator('.admin-nav').boundingBox())!;
  expect(nav.height, '顶部导航条高度').toBeLessThanOrEqual(64);
  const head = (await page.locator('.admin-head').boundingBox())!;
  expect(head.y - (nav.y + nav.height), '导航与标题之间的空白').toBeLessThanOrEqual(80);
  await expect(page.locator('[data-admin-palette-open]').first()).toHaveAccessibleName(/搜索/);
});
