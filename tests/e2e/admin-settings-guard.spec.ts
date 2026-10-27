import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Page, Request, TestInfo } from '@playwright/test';
import { test as base, expect } from './fixtures';
import { forwardRest, uniq } from './community-fixtures';
import { tok } from '../db/postgrest';

/**
 * A16 / T092 / T095：站点设置的写保护（真实本地 Postgres + PostgREST；读取失败 / 延迟由 Playwright 路由注入）。
 *
 * 用缺 0017 的隔离库（E2E_PGRST_PRE17；0017 不涉及 site_content，设置相关结构与全量库相同），
 * 这样不会和 admin.spec.ts 里并行修改全局设置的用例互相干扰；用 pg_advisory_lock 让各浏览器项目串行。
 * 修复前：读取失败时 fill(默认值) 且保存可用 → 一次保存就用默认值覆盖了库里的真实配置（本用例会在 DB 断言处失败）。
 */

const LOCK = 7_715_092;
const SETTINGS_READ = /\/rest\/v1\/site_content\?kind=eq\.setting&select=slug/;
let pool: pg.Pool | null = null;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DB_URL_PRE17, max: 3 }));

const test = base.extend<{ lock: pg.PoolClient }>({
  lock: [
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具不依赖其他夹具时必须写成 {}
    async ({}, use, info) => {
      info.skip(!process.env.E2E_PGRST_PRE17, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
      info.skip(!/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
      info.setTimeout(60_000);
      const c = await db().connect();
      await c.query('select pg_advisory_lock($1)', [LOCK]);
      try {
        await use(c);
      } finally {
        await c.query(`delete from site_content where kind = 'setting'`).catch(() => {});
        await c.query('select pg_advisory_unlock($1)', [LOCK]);
        c.release();
      }
    },
    { auto: true },
  ],
});

async function admin(page: Page) {
  const id = randomUUID();
  const email = `${id.slice(0, 8)}@example.com`;
  const name = uniq('管理员');
  await db().query(
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`,
    [id, email, { name }],
  );
  await db().query(`update public.profiles set role = 'admin' where id = $1`, [id]);
  const session = {
    access_token: tok(id),
    refresh_token: `refresh-${id}`,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: {
      id,
      email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: { name },
    },
  };
  await page.addInitScript((s) => localStorage.setItem('az-session-v68', s), JSON.stringify(session));
}

async function seed(slug: string, data: Record<string, unknown>) {
  await db().query(
    `insert into site_content (kind, slug, data, published) values ('setting', $1, $2, true)
     on conflict (kind, slug) do update set data = excluded.data, published = true`,
    [slug, data],
  );
}
const row = async (slug: string) =>
  (await db().query(`select data from site_content where kind = 'setting' and slug = $1`, [slug])).rows[0]
    ?.data as Record<string, unknown> | undefined;

/** 记录所有对 site_content 的写请求（POST / PATCH / DELETE） */
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', (r: Request) => {
    if (/\/rest\/v1\/site_content/.test(r.url()) && r.method() !== 'GET')
      writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir || !/^chromium-(desktop|iphone)$/.test(info.project.name)) return;
  const w = info.project.name.endsWith('desktop') ? 1440 : 390;
  await page.screenshot({ path: `${dir}/${name}-${w}.png`, fullPage: false });
}

const ann = (page: Page) => page.locator('form[data-setting="announcement"]');
const reg = (page: Page) => page.locator('form[data-setting="registration"]');
const loadBox = (page: Page) => page.locator('[data-settings-load]');

test('T092 读取失败：持续错误提示、表单与保存停用、不发任何写请求、库里真实配置不被默认值覆盖；重试成功显示真实值', async ({
  page,
}, info) => {
  const realText = uniq('真实公告 ');
  await seed('announcement', { enabled: true, text: realText, level: 'warning', link: '', linkText: '' });
  await seed('registration', { open: false, message: '真实配置：暂停注册' });
  await forwardRest(page, process.env.E2E_PGRST_PRE17);
  await admin(page);
  const writes = watchWrites(page);
  let fail = true;
  await page.route(SETTINGS_READ, (route) => (fail ? route.abort('internetdisconnected') : route.fallback()));

  await page.goto('/admin/settings/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  await shot(page, info, 'settings-load-error'); // 修复前后同一时机截图
  // 先验证「不写库」：直接提交全部表单（模拟点击保存 / 脚本 / 快捷键），修复前这里会把默认值写进库
  await page.evaluate(() => {
    for (const f of document.querySelectorAll<HTMLFormElement>('form[data-setting]')) f.requestSubmit();
  });
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  expect(await row('registration')).toMatchObject({ open: false, message: '真实配置：暂停注册' });
  expect(await row('announcement')).toMatchObject({ text: realText });
  await expect(reg(page).locator('[data-form-status]')).toContainText('不能保存');
  // 再验证界面：持续错误提示、表单与保存停用、没有默认值冒充真实配置
  await expect(loadBox(page)).toHaveAttribute('data-state', 'error');
  await expect(loadBox(page)).toHaveAttribute('role', 'alert');
  await expect(loadBox(page)).toContainText('设置读取失败');
  await expect(loadBox(page)).toContainText('编辑与保存已停用');
  for (const name of ['保存公告', '保存注册设置', '保存分类设置'])
    await expect(page.getByRole('button', { name })).toBeDisabled();
  await expect(ann(page).getByLabel('公告内容')).toBeDisabled();
  await expect(reg(page).getByRole('switch', { name: '开放新用户注册' })).not.toBeChecked();
  // 提示是持续的（不是几秒后消失的 toast）
  await page.waitForTimeout(4500);
  await expect(loadBox(page)).toHaveAttribute('data-state', 'error');

  // 重试：真的重新请求，成功后显示数据库里的真实值，保存恢复可用
  fail = false;
  await loadBox(page).getByRole('button', { name: '重试' }).click();
  await expect(loadBox(page)).toHaveAttribute('data-state', 'loaded');
  await expect(ann(page).getByLabel('公告内容')).toHaveValue(realText);
  await expect(reg(page).getByRole('switch', { name: '开放新用户注册' })).not.toBeChecked();
  await expect(reg(page).getByLabel('关闭注册时的说明（选填）')).toHaveValue('真实配置：暂停注册');
  await expect(page.getByRole('button', { name: '保存公告' })).toBeEnabled();
  expect(writes).toEqual([]);
});

test('T095 重试成功 → 编辑 → 迟到的重新加载响应不覆盖编辑（提示冲突，由管理员选择）；过期响应被丢弃', async ({
  page,
}, info) => {
  const A = uniq('公告 A ');
  const B = uniq('公告 B（另一位管理员改的）');
  await seed('announcement', { enabled: true, text: A, level: 'info', link: '', linkText: '' });
  await seed('registration', { open: true, message: '' });
  await forwardRest(page, process.env.E2E_PGRST_PRE17);
  await admin(page);
  const writes = watchWrites(page);
  let n = 0;
  let stale: string | null = null;
  await page.route(SETTINGS_READ, async (route) => {
    n += 1;
    if (n === 1)
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"x"}' });
    if (n === 2 || n === 3) {
      await new Promise((r) => setTimeout(r, 1200));
      return route.fallback();
    }
    if (n === 4) {
      // 第一次「重新加载」：故意最晚返回，而且带的是旧数据 → 必须被丢弃
      await new Promise((r) => setTimeout(r, 2000));
      return route.fulfill({ status: 200, contentType: 'application/json', body: stale! });
    }
    return route.fallback();
  });

  await page.goto('/admin/settings/');
  await expect(loadBox(page)).toHaveAttribute('data-state', 'error');
  await expect(loadBox(page)).toContainText('HTTP 503');
  await loadBox(page).getByRole('button', { name: '重试' }).click();
  // 加载中：表单仍停用
  await expect(loadBox(page)).toHaveAttribute('data-state', 'loading');
  await expect(ann(page).getByLabel('公告内容')).toBeDisabled();
  await expect(loadBox(page)).toHaveAttribute('data-state', 'loaded');
  await expect(ann(page).getByLabel('公告内容')).toHaveValue(A);

  // 管理员开始编辑；同时另一位管理员在库里改了公告与注册设置
  await ann(page).getByLabel('公告内容').fill('我的未保存修改');
  await seed('announcement', { enabled: true, text: B, level: 'info', link: '', linkText: '' });
  await seed('registration', { open: false, message: '别人关闭了注册' });
  await loadBox(page).getByRole('button', { name: '重新加载' }).click(); // n = 3，延迟 1.2 s
  await expect(ann(page).locator('[data-setting-conflict]')).toBeVisible();
  // 迟到响应没有覆盖编辑；没改过的「注册」表单直接更新为库里的值
  await expect(ann(page).getByLabel('公告内容')).toHaveValue('我的未保存修改');
  await expect(reg(page).getByLabel('关闭注册时的说明（选填）')).toHaveValue('别人关闭了注册');
  await expect(ann(page).locator('[data-setting-conflict]')).toContainText('与你未保存的修改不同');
  await shot(page, info, 'settings-conflict');
  // 冲突未处理时不能保存（不发写请求）
  await ann(page).getByRole('button', { name: '保存公告' }).click();
  await expect(ann(page).locator('[data-form-status]')).toContainText('请先处理上面的冲突');
  expect(writes).toEqual([]);
  await ann(page).getByRole('button', { name: '使用数据库中的值' }).click();
  await expect(ann(page).getByLabel('公告内容')).toHaveValue(B);
  await expect(ann(page).locator('[data-setting-conflict]')).toHaveCount(0);

  // 过期响应：连点两次「重新加载」，第一次的响应（旧数据）最后才到 → 被丢弃，表单保持最新值
  stale = JSON.stringify([
    {
      slug: 'announcement',
      data: { enabled: true, text: A, level: 'info' },
      published: true,
      updated_at: null,
    },
  ]);
  await loadBox(page).getByRole('button', { name: '重新加载' }).click(); // n = 4（2 s，旧数据）
  await loadBox(page).getByRole('button', { name: '重新加载' }).click(); // n = 5（立即，真实）
  await page.waitForTimeout(2600);
  await expect(ann(page).getByLabel('公告内容')).toHaveValue(B);
  await expect(ann(page).locator('[data-setting-conflict]')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await row('announcement')).toMatchObject({ text: B });
});

test.afterAll(async () => {
  await pool?.end();
});
