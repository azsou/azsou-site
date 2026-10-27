import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Page, TestInfo } from '@playwright/test';
import { test as base, expect } from './fixtures';
import { forwardRest, uniq } from './community-fixtures';
import { tok } from '../db/postgrest';

/**
 * 交接批次 2 的后台界面验收（真实本地 Postgres + PostgREST，全部迁移，不是 mock）：
 *   - A08 / T039：批量隐藏时部分目标已被并发删除 → 逐项结果面板（成功 / 不存在），不再只报「已处理 N 条」；
 *   - A09 / T040：页码越界（并发删除末页、旧链接）→ 显示真实总数与「回到最后一页」，不再像空库；
 *   - A01 / T063：对「待审 + 定时」内容点「隐藏」→ 排程取消，到期 tick 不会重新公开（默认策略，待站长确认）。
 * EVIDENCE_DIR 设置时把截图写到该目录（docs/audits/evidence/batch2/ 的来源）。
 */

type Who = { id: string; token: string; email: string; name: string };
let pool: pg.Pool | null = null;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DB_URL!, max: 2 }));

const test = base.extend<{ real: void }>({
  real: [
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具不依赖其他夹具时必须写成 {}
    async ({}, use, info) => {
      info.skip(!process.env.E2E_PGRST, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
      info.skip(!/^chromium-(desktop|iphone)$/.test(info.project.name), '仅 Chromium 桌面与 iPhone 视口');
      await use();
    },
    { auto: true },
  ],
});

async function admin(): Promise<Who> {
  const id = randomUUID();
  const email = `${id.slice(0, 8)}@example.com`;
  const name = uniq('管理员');
  await db().query(
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`,
    [id, email, { name }],
  );
  await db().query(`update public.profiles set role = 'admin' where id = $1`, [id]);
  return { id, email, name, token: tok(id) };
}

async function signIn(page: Page, u: Who) {
  const session = {
    access_token: u.token,
    refresh_token: `refresh-${u.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: {
      id: u.id,
      email: u.email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: { name: u.name },
    },
  };
  await page.addInitScript((s) => localStorage.setItem('az-session-v68', s), JSON.stringify(session));
}

async function threads(author: string, prefix: string, n: number): Promise<string[]> {
  const r = await db().query(
    `insert into public.forum_threads (cat, title, body, author, created_at)
     select '站务反馈', $2 || lpad(g::text, 2, '0'), '批次 2 夹具', $1, now() - (g || ' minutes')::interval
       from generate_series(1, $3::int) g returning id`,
    [author, prefix, n],
  );
  return r.rows.map((x) => x.id as string);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  const w = info.project.name.endsWith('desktop') ? 1440 : 390;
  // EVIDENCE_PREFIX=before|after：同一用例在修复前构建与修复后构建上各拍一次（先拍再断言）
  const pre = process.env.EVIDENCE_PREFIX ?? 'after';
  await page.screenshot({ path: `${dir}/${pre}-${name}-${w}.png`, fullPage: false });
}

test.afterAll(async () => {
  await pool?.end();
  pool = null;
});

test('A08 / T039 批量隐藏：部分目标已被并发删除 → 逐项结果面板', async ({ page }, info) => {
  await forwardRest(page);
  const a = await admin();
  const prefix = uniq('批量结果 ');
  const ids = await threads(a.id, prefix, 3);
  await signIn(page, a);
  await page.goto(`/admin/content/?q=${encodeURIComponent(prefix)}`);
  const rows = page.locator('tbody[data-rows] tr[data-row]');
  await expect(rows).toHaveCount(3);
  await page.locator('[data-select-all]').check();
  // 另一位管理员此时删除了其中一条
  await db().query(`delete from public.forum_threads where id = $1`, [ids[1]]);
  await page.locator('[data-bulkbar] [data-bulk="hide"]').click();
  await expect(page.locator('tbody[data-rows] tr[data-row]')).toHaveCount(2);
  await expect(page.locator('tbody[data-rows]')).not.toHaveAttribute('aria-busy', 'true');
  await shot(page, info, 'bulk-partial');
  const panel = page.locator('[data-bulk-result]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-bulk-summary]')).toContainText('成功 2 条');
  await expect(panel).toContainText('不存在（可能已被删除）');
  const { rows: st } = await db().query(
    `select t.published, w.status from public.forum_threads t
       left join public.content_workflow w on w.target_type = 'thread' and w.target_id = t.id
      where t.id = any($1::uuid[])`,
    [ids],
  );
  expect(st).toEqual([
    { published: false, status: 'offline' },
    { published: false, status: 'offline' },
  ]);
});

test('A09 / T040 页码越界：显示真实总数与「回到最后一页」', async ({ page }, info) => {
  await forwardRest(page);
  const a = await admin();
  const prefix = uniq('越界页 ');
  await threads(a.id, prefix, 30);
  await signIn(page, a);
  await page.goto(`/admin/content/?q=${encodeURIComponent(prefix)}&offset=50`);
  const empty = page.locator('tbody[data-rows]');
  await expect(empty.locator('tr')).toHaveCount(1);
  await expect(empty).not.toHaveAttribute('aria-busy', 'true');
  await shot(page, info, 'out-of-range');
  await expect(empty).toContainText('已超出末页');
  await expect(empty).toContainText('共 30 条');
  await expect(page.locator('[data-pager]')).toContainText('本页超出范围，共 30 条');
  await page.getByRole('button', { name: '回到最后一页' }).click();
  await expect(page.locator('tbody[data-rows] tr[data-row]')).toHaveCount(5);
  await expect(page).toHaveURL(/offset=25/);
});

test('A01 / T063 对「待审 + 定时」内容点「隐藏」：排程取消，到期 tick 不重新公开', async ({ page }) => {
  await forwardRest(page);
  const a = await admin();
  const prefix = uniq('排程隐藏 ');
  const [id] = await threads(a.id, prefix, 1);
  await db().query(
    `insert into public.content_workflow (target_type, target_id, status, scheduled_at)
     values ('thread', $1, 'review', now() + interval '1 hour')`,
    [id],
  );
  await db().query(`update public.forum_threads set published = false where id = $1`, [id]);
  await signIn(page, a);
  await page.goto(`/admin/content/?q=${encodeURIComponent(prefix)}`);
  const row = page.locator('tbody[data-rows] tr[data-row]').first();
  await expect(row).toBeVisible();
  // 已隐藏的内容行内按钮是「恢复」；用批量「隐藏」模拟版主再点一次隐藏
  await page.locator('[data-select-all]').check();
  await page.locator('[data-bulkbar] [data-bulk="hide"]').click();
  await expect(page.locator('[data-bulk-result], .toast').first()).toBeVisible();
  await expect
    .poll(
      async () =>
        (await db().query(`select scheduled_at from public.content_workflow where target_id = $1`, [id]))
          .rows[0].scheduled_at,
    )
    .toBeNull();
  await db().query(
    `update public.content_workflow set scheduled_at = now() - interval '1 minute' where target_id = $1`,
    [id],
  );
  await db().query(`select public.mod_workflow_tick()`);
  const { rows } = await db().query(`select published from public.forum_threads where id = $1`, [id]);
  expect(rows[0].published).toBe(false);
});
