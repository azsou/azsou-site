import { expect, test, type Page } from '@playwright/test';
import { FIXED_TIME } from './pages';
import { settle } from './detect';

/**
 * 双排序回归（站长 2026-10-27：应用排序合成一个控件、一个状态源，默认「最新」）。
 * 合并前 /apps/ 有两组排序：列表外壳分段（最新 / 名称 / 编辑推荐，?sort=new|name|editor）
 * 与「更多筛选」里的「按真实数据排序」（最新 / 热门 / 评分，?sort=new|hot|rating）。
 * 本文件守住两件事：
 *  1. 任何应用目录页面（总目录、全部分类页、全部平台页；1440 / 1024 / 390；展开「更多筛选」后）都只有一个排序控件；
 *     其它列表页（AI / 游戏 / 作品）各自最多一组排序，不会出现第二套。
 *  2. 两组旧链接里的每个 ?sort= 值都映射到唯一控件的对应选项、地址保留同一个 sort、状态区写对应排序名；
 *     需要真实统计的热门 / 评分在统计不可用时如实写「已按最新排序」，控件仍显示访客选的值（不是静默改成最新）。
 * 第三方请求一律拦截（与 a11y / batch3 一致）。
 */
test.beforeEach(async ({ page }) => {
  await page.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname),
    (r) => r.abort(),
  );
});

async function open(page: Page, path: string, vp: { width: number; height: number }) {
  await page.setViewportSize(vp);
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(path, { waitUntil: 'networkidle' });
  await settle(page);
}
async function catalogIdle(page: Page) {
  await expect(page.locator('[data-catalog-filter]')).toHaveAttribute('data-ready', 'yes');
  await expect(page.locator('[data-catalog-grid]')).not.toHaveAttribute('aria-busy', 'true');
}

/** 页面上所有「看起来是排序」的控件：下拉、按钮组、旧的两种按钮属性 */
async function sortControls(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(e as HTMLElement);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const nameOf = (e: Element) => {
      const id = e.getAttribute('id');
      const lab = id ? document.querySelector(`label[for="${id}"]`)?.textContent : '';
      const lb = e.getAttribute('aria-labelledby');
      return [
        e.getAttribute('aria-label'),
        lab,
        lb && document.getElementById(lb)?.textContent,
        e.getAttribute('name'),
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    for (const s of document.querySelectorAll('select'))
      if (/排序|sort/i.test(nameOf(s))) out.push(`select:${nameOf(s)}:${visible(s) ? 'v' : 'h'}`);
    for (const g of document.querySelectorAll('[role="group"], [role="radiogroup"], [role="tablist"]'))
      if (/排序|sort/i.test(nameOf(g))) out.push(`group:${nameOf(g)}:${visible(g) ? 'v' : 'h'}`);
    for (const b of document.querySelectorAll('[data-entry-sort], [data-sort]'))
      out.push(`legacy-btn:${b.textContent?.trim()}`);
    return out;
  });
}

const APP_PAGES = [
  '/apps/',
  ...['ai', 'browser-tools', 'creative', 'dev-tools', 'utilities'].map((c) => `/apps/category/${c}/`),
  ...['android', 'browser-ext', 'cli', 'web', 'windows'].map((p) => `/apps/platform/${p}/`),
];

for (const path of APP_PAGES)
  test(`双排序回归 ${path}：1440 / 1024 / 390 都只有一个排序控件（含展开「更多筛选」后）`, async ({
    page,
  }) => {
    for (const width of [1440, 1024, 390]) {
      await open(page, path, { width, height: 900 });
      await catalogIdle(page);
      const before = await sortControls(page);
      expect(before, `${path} @${width}`).toEqual(['select:排序 sort:v']);
      await page.locator('[data-more-filters] > summary').click();
      await expect(page.locator('[data-more-filters]')).toHaveAttribute('open', '');
      expect(await sortControls(page), `${path} @${width} 更多筛选展开`).toEqual(['select:排序 sort:v']);
      await expect(page.locator('[data-more-filters]')).not.toContainText('排序');
    }
  });

for (const path of ['/ai/', '/games/', '/works/'])
  test(`双排序回归 ${path}：其它列表页最多一组排序，没有第二套`, async ({ page }) => {
    for (const width of [1440, 390]) {
      await open(page, path, { width, height: 900 });
      const ctl = (await sortControls(page)).filter((c) => !c.startsWith('legacy-btn'));
      expect(ctl.length, `${path} @${width}: ${ctl.join(' | ')}`).toBeLessThanOrEqual(1);
      const more = page.locator('[data-more-filters] > summary');
      if (await more.count()) {
        await more.first().click();
        const ctl2 = (await sortControls(page)).filter((c) => !c.startsWith('legacy-btn'));
        expect(ctl2.length, `${path} @${width} 展开后: ${ctl2.join(' | ')}`).toBeLessThanOrEqual(1);
      }
    }
  });

// 旧两组的全部取值 → 唯一控件的值、状态区排序名
const LEGACY: { from: string; sort: string; label: string; stats?: boolean }[] = [
  { from: '列表外壳', sort: 'new', label: '最新' },
  { from: '列表外壳', sort: 'name', label: '名称' },
  { from: '列表外壳', sort: 'editor', label: '编辑推荐' },
  { from: '更多筛选', sort: 'new', label: '最新' },
  { from: '更多筛选', sort: 'hot', label: '热门', stats: true },
  { from: '更多筛选', sort: 'rating', label: '评分', stats: true },
];

for (const l of LEGACY)
  for (const path of ['/apps/', '/apps/category/dev-tools/', '/apps/platform/windows/'])
    test(`双排序回归 旧链接（${l.from}）${path}?sort=${l.sort} → 唯一控件 = ${l.label}`, async ({ page }) => {
      await open(page, `${path}?sort=${l.sort}`, { width: 1440, height: 900 });
      await catalogIdle(page);
      const sort = page.getByRole('combobox', { name: '排序' });
      await expect(sort).toHaveCount(1);
      await expect(sort).toHaveValue(l.sort);
      const url = new URL(page.url());
      expect(url.pathname).toBe(path);
      // 默认值「最新」规范化为不写参数；其它值保留且只有一个 sort
      expect(url.searchParams.getAll('sort')).toEqual(l.sort === 'new' ? [] : [l.sort]);
      const status = page.locator('[data-catalog-status]');
      if (l.stats) {
        // 本地 / CI 设计门禁没有统计数据源：要么按所选排序，要么如实提示退回最新（不能静默）
        await expect(status).toContainText(new RegExp(`按${l.label}排序|统计数据暂时不可用，已按最新排序`));
      } else await expect(status).toContainText(`按${l.label}排序`);
      // 刷新后保持
      await page.reload({ waitUntil: 'networkidle' });
      await catalogIdle(page);
      await expect(sort).toHaveValue(l.sort);
    });

test('双排序回归 两个旧参数同时出现（?sort=hot&sort=name）：只认第一个，地址收敛成一个 sort', async ({
  page,
}) => {
  await open(page, '/apps/?sort=hot&sort=name', { width: 1440, height: 900 });
  await catalogIdle(page);
  const sort = page.getByRole('combobox', { name: '排序' });
  await expect(sort).toHaveValue('hot');
  // 换一次排序后地址里只剩一个 sort
  await sort.selectOption('editor');
  await expect(page).toHaveURL(/sort=editor/);
  expect(new URL(page.url()).searchParams.getAll('sort')).toEqual(['editor']);
});
