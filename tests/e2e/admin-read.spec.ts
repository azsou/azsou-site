import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Page, TestInfo } from '@playwright/test';
import { test as base, expect } from './fixtures';
import { forwardRest, seedThread, uniq } from './community-fixtures';
import { tok } from '../db/postgrest';

/**
 * A15 / T091：8 个后台模块的读取（真实本地 Postgres + PostgREST，不是 mock）。
 *
 * 根因（见 docs/audits/evidence/batch1/README.md）：预览站直连的生产库只有 V72 基线，0002–0017 都没执行，
 * 后台 RPC / 表在 PostgREST 上是 404 PGRST202 / PGRST205；修复前前端把它与断网一样显示为
 * 「网络或服务暂时不可用」，重试也无效。这里用三种库结构复现与验收：
 *   - v72   = shim + 0001（与生产库现状一致）→ 8 模块显示「数据库未就绪：缺少 X（迁移 N）」，不再说网络问题；
 *   - pre17 = shim + 0001…0016（缺 0017）→ 内容 / 用户照常读出真实数据，服务端排序降级并提示需要 0017；
 *   - full  = 全部迁移 → 断网 / 5xx 各有提示，「重试」真的重新请求并恢复；真实空集显示空态而不是错误。
 * EVIDENCE_DIR 设置时把截图写到该目录（docs/audits/evidence/batch1/ 的来源）。
 */

type Who = { id: string; token: string; email: string; name: string };
const pools: Record<string, pg.Pool> = {};
const poolFor = (url: string) => (pools[url] ??= new pg.Pool({ connectionString: url, max: 2 }));

const test = base.extend<{ legacy: void }>({
  legacy: [
    // eslint-disable-next-line no-empty-pattern -- Playwright 夹具不依赖其他夹具时必须写成 {}
    async ({}, use, info) => {
      info.skip(!process.env.E2E_PGRST_V72, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
      info.skip(!/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
      await use();
    },
    { auto: true },
  ],
});

async function adminOn(dbUrl: string, role = 'admin'): Promise<Who> {
  const db = poolFor(dbUrl);
  const id = randomUUID();
  const email = `${id.slice(0, 8)}@example.com`;
  const name = uniq('管理员');
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`,
    [id, email, { name }],
  );
  await db.query(`update public.profiles set role = $2 where id = $1`, [id, role]);
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

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir || !/^chromium-(desktop|iphone)$/.test(info.project.name)) return;
  const w = info.project.name.endsWith('desktop') ? 1440 : 390;
  await page.screenshot({ path: `${dir}/${name}-${w}.png`, fullPage: false });
}

/** 8 个模块：路径、错误所在区域、生产库缺的对象所属迁移 */
const MODULES = [
  { id: 'overview', path: '/admin/', migration: '0009' },
  { id: 'content', path: '/admin/content/', migration: '0009' },
  { id: 'users', path: '/admin/users/', migration: '0009' },
  { id: 'reports', path: '/admin/reports/', migration: '0003' },
  { id: 'guestbook', path: '/admin/guestbook/', migration: '0015' },
  { id: 'links', path: '/admin/links/', migration: '0015' },
  { id: 'subscribers', path: '/admin/subscribers/', migration: '0016' },
  { id: 'audit', path: '/admin/audit/', migration: '0003' },
] as const;

test.describe('A15 / T091 生产等价库（shim + 0001，0002–0017 未执行）', () => {
  for (const m of MODULES)
    test(`${m.id}：显示「数据库未就绪」（缺迁移 ${m.migration}），不是网络错误；PostgREST 实际回 404 PGRST20x`, async ({
      page,
    }, info) => {
      await forwardRest(page, process.env.E2E_PGRST_V72);
      const a = await adminOn(process.env.E2E_DB_URL_V72!);
      await signIn(page, a);
      const firstMissing = page.waitForResponse(
        (r) => /\/rest\/v1\//.test(r.url()) && r.status() === 404 && !/profiles/.test(r.url()),
      );
      await page.goto(m.path);
      const res = await firstMissing;
      const body = (await res.json()) as { code?: string };
      // 证据：真实 PostgREST 的状态码与错误码（与生产库匿名探测结果一致）
      expect(res.status()).toBe(404);
      expect(body.code).toMatch(/^PGRST20[25]$/);
      const err = page.locator('[data-table-error]').first();
      await expect(err).toBeVisible();
      await shot(page, info, `v72-${m.id}`); // 修复前后同一时机截图（EVIDENCE_DIR = before / after）
      await expect(err).toHaveAttribute('role', 'alert');
      await expect(err).toHaveAttribute('data-error-kind', 'schema');
      await expect(err).toContainText('数据库未就绪');
      await expect(err).toContainText(`迁移 ${m.migration}`);
      await expect(err).not.toContainText('网络或服务暂时不可用');
      await expect(err.getByRole('button', { name: '重新检测' })).toBeVisible();
      // 「重新检测」会真的再请求一次（库仍未迁移 → 仍是同一类错误）
      const again = page.waitForResponse((r) => /\/rest\/v1\//.test(r.url()) && r.status() === 404);
      await err.getByRole('button', { name: '重新检测' }).click();
      await again;
      await expect(page.locator('[data-table-error][data-error-kind="schema"]').first()).toBeVisible();
    });
});

test.describe('A15 缺 0017 的库（0001…0016）', () => {
  test('内容 / 用户：真实数据照常显示；服务端排序退回旧签名并提示「需要数据库迁移 0017」', async ({
    page,
  }, info) => {
    await forwardRest(page, process.env.E2E_PGRST_PRE17);
    const dbUrl = process.env.E2E_DB_URL_PRE17!;
    const a = await adminOn(dbUrl);
    const title = uniq('旧库主题 ');
    await seedThread(poolFor(dbUrl), a.id, { title });
    await signIn(page, a);
    await page.goto(`/admin/content/?q=${encodeURIComponent(title)}`);
    await expect(page.locator('tbody[data-rows] tr[data-row]')).toHaveCount(1);
    await expect(page.locator('[data-table-error]')).toHaveCount(0);
    // 记住「按标题排序」后重新打开（与点表头相同的存储），请求先带 p_sort，库只有旧签名 → 去掉后重读
    const col = await page
      .locator('th[data-sort-key="title"]')
      .evaluate((th) => Array.from(th.parentElement!.children).indexOf(th) + 1);
    await page.evaluate((c) => {
      localStorage.setItem('az-admin-table:content', JSON.stringify({ sort: { col: c, dir: 'ascending' } }));
      localStorage.setItem('az-admin-table:users', JSON.stringify({ sort: { col: 2, dir: 'ascending' } }));
    }, col);
    const sorted = page.waitForResponse(
      (r) => /rpc\/mod_list_content/.test(r.url()) && (r.request().postData() ?? '').includes('p_sort'),
    );
    await page.reload();
    expect((await sorted).status()).toBe(404);
    await page.waitForLoadState('networkidle');
    await shot(page, info, 'pre17-content-sorted');
    await expect(page.locator(`tbody[data-rows] tr[data-row]`)).toContainText(title);
    await expect(page.locator('[data-status]').first()).toContainText('服务端排序需要数据库迁移 0017');

    await page.goto('/admin/users/');
    await expect(page.locator('tbody[data-rows] tr[data-row]').first()).toBeVisible();
    await expect(page.locator('[data-table-error]')).toHaveCount(0);
  });
});

test.describe('A15 全量库（0001…0017）：8 个模块读出真实数据', () => {
  test('概览 / 内容 / 用户 / 举报 / 留言 / 友链 / 订阅 / 审计：无错误态，显示数据库里的真实数据或真实空态', async ({
    page,
  }, info) => {
    info.setTimeout(60_000);
    await forwardRest(page);
    const db = poolFor(process.env.E2E_DB_URL!);
    const a = await adminOn(process.env.E2E_DB_URL!);
    const title = uniq('真实数据主题 ');
    const tid = await seedThread(db, a.id, { title });
    await db.query(
      `insert into public.reports (reporter, target_type, target_id, reason, detail) values ($1, 'thread', $2, 'spam', 'T091 合成举报')`,
      [a.id, tid],
    );
    await signIn(page, a);
    const ready: Record<string, string> = {
      overview: '[data-stats] .stat',
      content: 'tbody[data-rows] tr[data-row]',
      users: 'tbody[data-rows] tr[data-row]',
      reports: '[data-report], .report, [data-table-empty]',
      guestbook: '[data-table-empty], .mod-item',
      links: '[data-table-empty], .mod-item',
      subscribers: '[data-status-row]',
      audit: 'tbody[data-rows] tr, [data-table-empty]',
    };
    for (const m of MODULES) {
      await page.goto(m.id === 'content' ? `${m.path}?q=${encodeURIComponent(title)}` : m.path);
      await expect(page.locator(ready[m.id]).first()).toBeVisible();
      await expect(page.locator('[data-table-error]')).toHaveCount(0);
      await shot(page, info, `full-${m.id}`);
    }
    await page.goto(`/admin/content/?q=${encodeURIComponent(title)}`);
    await expect(page.locator('tbody[data-rows] tr[data-row]')).toContainText(title);
  });
});

test.describe('A15 全量库：错误分类与重试', () => {
  test('内容：断网 → 「无法连接数据服务」；5xx → 「服务端出错」；恢复后「重试」重新请求并显示真实数据', async ({
    page,
  }, info) => {
    await forwardRest(page);
    const db = poolFor(process.env.E2E_DB_URL!);
    const a = await adminOn(process.env.E2E_DB_URL!);
    const title = uniq('重试主题 ');
    await seedThread(db, a.id, { title });
    await signIn(page, a);
    let mode: 'down' | '503' | 'ok' = 'down';
    await page.route('**/rest/v1/rpc/mod_list_content', async (route) => {
      if (mode === 'down') return route.abort('internetdisconnected');
      if (mode === '503')
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"x"}' });
      return route.fallback();
    });
    await page.goto(`/admin/content/?q=${encodeURIComponent(title)}`);
    const err = page.locator('[data-table-error]');
    await expect(err).toBeVisible();
    await shot(page, info, 'full-content-network');
    await expect(err).toHaveAttribute('data-error-kind', 'network');
    await expect(err).toContainText('无法连接数据服务');
    mode = '503';
    await err.getByRole('button', { name: '重试' }).click();
    await expect(err).toHaveAttribute('data-error-kind', 'server');
    await expect(err).toContainText('HTTP 503');
    mode = 'ok';
    const req = page.waitForRequest(/rpc\/mod_list_content/);
    await err.getByRole('button', { name: '重试' }).click();
    await req;
    await expect(page.locator('tbody[data-rows] tr[data-row]')).toContainText(title);
    await expect(page.locator('[data-table-error]')).toHaveCount(0);
  });

  test('概览：「重试」重新请求统计（不整页刷新），恢复后显示真实计数', async ({ page }) => {
    await forwardRest(page);
    const a = await adminOn(process.env.E2E_DB_URL!);
    await signIn(page, a);
    let down = true;
    await page.route('**/rest/v1/rpc/admin_stats', (route) =>
      down ? route.abort('internetdisconnected') : route.fallback(),
    );
    await page.goto('/admin/');
    const err = page.locator('[data-stats] [data-table-error]');
    await expect(err).toHaveAttribute('data-error-kind', 'network');
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    down = false;
    await err.getByRole('button', { name: '重试' }).click();
    await expect(page.locator('[data-stats] .stat')).toHaveCount(8);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });

  test('真实空集显示空态，不是错误：订阅数量为 0、待审核留言为空', async ({ page }) => {
    await forwardRest(page);
    const a = await adminOn(process.env.E2E_DB_URL!);
    await signIn(page, a);
    await page.goto('/admin/subscribers/');
    await expect(page.locator('[data-status-row="confirmed"] th')).toHaveText('已订阅');
    await expect(page.locator('[data-table-error]')).toHaveCount(0);
    await page.goto('/admin/links/');
    await expect(page.locator('[data-table-empty], [data-table-error]').first()).toBeVisible();
    await expect(page.locator('[data-table-error]')).toHaveCount(0);
  });
});

test.afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
});
