/**
 * 社区 E2E 夹具：浏览器的 /rest/v1 请求转发到本地 PostgREST（见 global-setup.ts），
 * 用真实签名的 JWT 写入 V72 格式的会话（az-session-v68），每个用例用自己新建的用户，互不干扰。
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Page, Route } from '@playwright/test';
import { test as base, expect } from './fixtures';
import { ANON, tok } from '../db/postgrest';

export interface TestUser {
  id: string;
  name: string;
  email: string;
  token: string;
}

type Role = 'user' | 'moderator' | 'admin';

interface CommunityFixtures {
  /** true：在全部 4 个视口上跑（角色矩阵等），默认只跑桌面与 iPhone */
  allViewports: boolean;
  db: pg.Pool;
  makeUser(name: string, opts?: { role?: Role; banned?: boolean }): Promise<TestUser>;
  signIn(page: Page, u: TestUser): Promise<void>;
}

let pool: pg.Pool | null = null;
const getPool = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 3 }));

/** 把一个 /rest/v1 请求转发到本地 PostgREST（默认 = 跑完全部迁移的库；target 可指向旧结构的库） */
async function forward(route: Route, target = process.env.E2E_PGRST!) {
  const req = route.request();
  const u = new URL(req.url());
  const headers = { ...req.headers() };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  // 未登录时浏览器带的是 Supabase publishable key（网关识别），本地 PostgREST 只认 JWT：换成 anon JWT
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(headers.authorization ?? ''))
    headers.authorization = `Bearer ${ANON}`;
  try {
    const res = await route.fetch({
      url: target + u.pathname.replace(/^\/rest\/v1/, '') + u.search,
      headers,
    });
    // 与 Supabase 网关一致：跨域可读 Content-Range（count=exact 的总数）
    await route.fulfill({
      response: res,
      headers: {
        ...res.headers(),
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Content-Range, Content-Location',
      },
    });
  } catch (err) {
    // 诊断（2026-10-28 故障 5 首跑失败：mod_list_users 在 36ms 内被 abort，trace 里看不到真实原因）：
    // 把 route.fetch 的真实错误打进日志，下次首跑失败能直接看到是连接复用 / 上游断开 / 页面已离开中的哪一种。
    console.warn(
      `[forwardRest] route.fetch 失败 ${req.method()} ${u.pathname}: ${String(err).slice(0, 300)}`,
    );
    await route.abort('connectionrefused').catch(() => {});
  }
}

/** 公开页面读取站点设置的请求（公告条 / 注册开关 / 发帖分类） */
const PUBLIC_SETTINGS = /\/rest\/v1\/site_content\?kind=eq\.setting&published=eq\.true/;

/**
 * 把页面对 Supabase /rest/v1 的请求转发到本地 PostgREST。
 * 站点设置是全局的：为了不让「后台设置」用例影响并行的其他用例，公开页面读设置默认得到空（= 默认设置），
 * 需要真实设置的用例调用 useRealSettings(page)。
 */
export async function forwardRest(page: Page, target?: string) {
  await page.route('**/rest/v1/**', (route) => forward(route, target));
  await page.route(PUBLIC_SETTINGS, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '[]',
    }),
  );
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"msg":"not mocked"}' }),
  );
}

/** 本页面读真实的站点设置（后注册的路由优先） */
export async function useRealSettings(page: Page) {
  await page.route(PUBLIC_SETTINGS, (route) => forward(route));
}

export const uniq = (p = '') => `${p}${randomUUID().slice(0, 8)}`;

export const test = base.extend<CommunityFixtures>({
  allViewports: [false, { option: true }],
  db: async ({ page, allViewports }, use, info) => {
    info.skip(!process.env.E2E_PGRST, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
    // 控制时长：社区用例在每个引擎的桌面与 iPhone 视口上跑（平板/安卓与这两个共用断点）
    info.skip(
      !allViewports && !process.env.COMMUNITY_ALL && !/-(desktop|iphone)$/.test(info.project.name),
      '仅桌面与 iPhone 视口',
    );
    await forwardRest(page);
    await use(getPool());
  },
  makeUser: async ({ db }, use) => {
    await use(async (name, opts = {}) => {
      const id = randomUUID();
      const email = `${id.slice(0, 8)}@example.com`;
      await db.query(
        `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`,
        [id, email, { name }],
      );
      if (opts.role || opts.banned)
        await db.query(`update public.profiles set role = $2, banned = $3 where id = $1`, [
          id,
          opts.role ?? 'user',
          !!opts.banned,
        ]);
      return { id, name, email, token: tok(id) };
    });
  },
  signIn: async ({ db: _db }, use) => {
    void _db;
    await use(async (page, u) => {
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
      await page.addInitScript((s) => {
        localStorage.setItem('az-session-v68', s);
      }, JSON.stringify(session));
    });
  },
});

/** 以超级用户直接写一条主题（绕过限流，用于准备数据） */
export async function seedThread(
  db: pg.Pool,
  author: string,
  opts: { title?: string; body?: string; cat?: string; locked?: boolean; createdAt?: string } = {},
) {
  const r = await db.query(
    `insert into public.forum_threads (cat, title, body, author, locked, created_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) returning id`,
    [
      opts.cat ?? '技术交流',
      opts.title ?? uniq('主题 '),
      opts.body ?? '正文',
      author,
      !!opts.locked,
      opts.createdAt ?? null,
    ],
  );
  return r.rows[0].id as string;
}

export async function seedReply(db: pg.Pool, author: string, threadId: string, body: string) {
  const r = await db.query(
    `insert into public.forum_replies (thread_id, body, author) values ($1, $2, $3) returning id`,
    [threadId, body, author],
  );
  return r.rows[0].id as string;
}

export { expect };

/**
 * 点「发布主题」并等到新主题页可用。发布 = 一次真实写库 + 一次整页跳转，按真实信号逐段等待：
 * 写库请求返回 201 → 浏览器发出新主题页的文档请求（带新 id）→ 新文档的模块脚本执行完（DOMContentLoaded）。
 * 不用一个 7 秒的 toHaveURL 同时覆盖这三段——CI 40522111734 webkit-iphone 首跑就是导航已提交到新 id、
 * 但新文档 7 秒内没跑完脚本，toHaveURL 只拿到旧页地址（docs/audits/evidence/ci/images-flake-2026-10-28.md）。
 * 返回新主题页地址（已断言是 /forum/t/?id=<uuid>，且当前页就是它）。
 */
export async function publishThread(page: Page): Promise<string> {
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/rest\/v1\/forum_threads/.test(r.url()),
  );
  const navigation = page.waitForRequest(
    (r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && /\/forum\/t\/\?id=/.test(r.url()),
  );
  await page.getByRole('button', { name: '发布主题' }).click();
  expect((await created).status()).toBe(201);
  const threadUrl = (await navigation).url();
  expect(threadUrl).toMatch(/\/forum\/t\/\?id=[0-9a-f-]{36}$/);
  await page.waitForURL(threadUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(threadUrl);
  return threadUrl;
}
