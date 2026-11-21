import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { mockAdmin } from '../design/admin-mock';

/**
 * 用户详情页的重叠加载：保存角色会重新加载整页，而首次加载还停在「最近发布」读取上时，
 * 较早的加载晚到不得再追加一份面板，也不得把新页面换成错误提示或提前结束忙碌状态。
 * 只拦截并延迟本文件登记的内容列表请求，不连接真实服务，其余后台请求仍由 mockAdmin 夹具返回。
 */
type Held = { type: string; route: Route };

const TARGET = '00000000-0000-4000-8000-0000000002a1';
const USER = {
  id: TARGET,
  display_name: '被查看用户',
  role: 'user',
  banned: false,
  created_at: '2026-11-01T08:00:00Z',
  email: null,
  threads: 0,
  replies: 0,
  comments: 0,
  reports_against: 0,
  ban_reason: null,
  ban_expires_at: null,
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range',
  'content-range': '*/0',
};
const PANELS = ['最近发布', '分群与标签', '订阅与登录', '近期发布', '内部备注'];

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const saveRole = (page: Page) => page.getByRole('button', { name: '保存角色' });
const box = (page: Page) => page.locator('[data-user]');
const loadError = (page: Page) => page.locator('[data-user] > .data-status');

/** 稳定观察「没有再发生」：留出时间让较早的加载把它剩下的步骤走完，再断言。 */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
}

async function setup(page: Page) {
  await mockAdmin(page);
  const held: Held[] = [];
  let immediate = false;
  await page.route('**/rest/v1/rpc/mod_list_users', (route) => {
    const body = route.request().postDataJSON() as { p_id?: string | null };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(body.p_id === TARGET ? [USER] : []),
    });
  });
  await page.route('**/rest/v1/rpc/mod_list_content', (route) => {
    if (immediate)
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' });
    const body = route.request().postDataJSON() as { p_type?: string };
    held.push({ type: body.p_type ?? '', route });
  });
  async function release(entries: Held[], failed = false) {
    await Promise.all(
      entries.map(async (entry) => {
        const completed = page.waitForEvent(
          'requestfinished',
          (request) => request === entry.route.request(),
        );
        await entry.route.fulfill({
          status: failed ? 503 : 200,
          contentType: 'application/json',
          headers: CORS,
          body: failed ? JSON.stringify({ message: 'intentional user view test failure' }) : '[]',
        });
        await completed;
      }),
    );
    await settle(page);
  }
  /** 打开页面并扣住首次加载的三个内容读取，再保存角色触发第二次加载，两次加载都在途。 */
  async function openAndReload() {
    await page.goto(`/admin/users/view/?id=${TARGET}`, { waitUntil: 'domcontentloaded' });
    await expect(saveRole(page)).toBeVisible();
    await expect.poll(() => held.length).toBe(3);
    expect(held.map((entry) => entry.type).sort()).toEqual(['comment', 'reply', 'thread']);
    await page.getByRole('combobox', { name: '角色' }).selectOption('moderator');
    await saveRole(page).click();
    await expect.poll(() => held.length).toBe(6);
    expect(
      held
        .slice(3)
        .map((entry) => entry.type)
        .sort(),
    ).toEqual(['comment', 'reply', 'thread']);
    expect(held).toHaveLength(6);
    return { first: held.slice(0, 3), second: held.slice(3) };
  }
  return {
    release,
    openAndReload,
    allowImmediate() {
      immediate = true;
    },
  };
}

test.describe('用户详情：重叠加载', () => {
  test('单次加载每个面板只出现一次', async ({ page }) => {
    const env = await setup(page);
    env.allowImmediate();
    await page.goto(`/admin/users/view/?id=${TARGET}`, { waitUntil: 'domcontentloaded' });
    await expect(heading(page, '内部备注')).toHaveCount(1);
    for (const name of PANELS) await expect(heading(page, name)).toHaveCount(1);
    await expect(saveRole(page)).toHaveCount(1);
    await expect(box(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(loadError(page)).toHaveCount(0);
  });

  test('较早的加载晚到，不再追加一份面板', async ({ page }) => {
    const env = await setup(page);
    const { first, second } = await env.openAndReload();
    await env.release(second);
    await expect(heading(page, '内部备注')).toHaveCount(1);
    await expect(box(page)).not.toHaveAttribute('aria-busy', 'true');
    await env.release(first);
    for (const name of PANELS) await expect(heading(page, name)).toHaveCount(1);
    await expect(saveRole(page)).toHaveCount(1);
    await expect(loadError(page)).toHaveCount(0);
  });

  test('较早的加载失败得更晚，不把新页面换成错误提示', async ({ page }) => {
    const env = await setup(page);
    const { first, second } = await env.openAndReload();
    await env.release(second);
    await expect(heading(page, '内部备注')).toHaveCount(1);
    await env.release(first, true);
    await expect(loadError(page)).toHaveCount(0);
    for (const name of PANELS) await expect(heading(page, name)).toHaveCount(1);
    await expect(saveRole(page)).toBeVisible();
    await expect(box(page)).not.toHaveAttribute('aria-busy', 'true');
  });

  test('新加载仍在途时，较早的加载返回不得提前结束忙碌状态或显示旧内容', async ({ page }) => {
    const env = await setup(page);
    const { first, second } = await env.openAndReload();
    await env.release(first);
    await expect(box(page)).toHaveAttribute('aria-busy', 'true');
    await expect(heading(page, '最近发布')).toHaveCount(0);
    await expect(heading(page, '内部备注')).toHaveCount(0);
    await env.release(second);
    await expect(box(page)).not.toHaveAttribute('aria-busy', 'true');
    for (const name of PANELS) await expect(heading(page, name)).toHaveCount(1);
    await expect(saveRole(page)).toHaveCount(1);
  });
});
