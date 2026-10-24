/**
 * 社区 E2E 夹具：浏览器的 /rest/v1 请求转发到本地 PostgREST（见 global-setup.ts），
 * 用真实签名的 JWT 写入 V72 格式的会话（az-session-v68），每个用例用自己新建的用户，互不干扰。
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Page } from '@playwright/test';
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
  db: pg.Pool;
  makeUser(name: string, opts?: { role?: Role; banned?: boolean }): Promise<TestUser>;
  signIn(page: Page, u: TestUser): Promise<void>;
}

let pool: pg.Pool | null = null;
const getPool = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 3 }));

/** 把页面对 Supabase /rest/v1 的请求转发到本地 PostgREST */
export async function forwardRest(page: Page) {
  const target = process.env.E2E_PGRST!;
  await page.route('**/rest/v1/**', async (route) => {
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
      await route.fulfill({ response: res });
    } catch {
      await route.abort('connectionrefused').catch(() => {});
    }
  });
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"msg":"not mocked"}' }),
  );
}

export const uniq = (p = '') => `${p}${randomUUID().slice(0, 8)}`;

export const test = base.extend<CommunityFixtures>({
  db: async ({ page }, use, info) => {
    info.skip(!process.env.E2E_PGRST, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
    // 控制时长：社区用例在每个引擎的桌面与 iPhone 视口上跑（平板/安卓与这两个共用断点）
    info.skip(
      !process.env.COMMUNITY_ALL && !/-(desktop|iphone)$/.test(info.project.name),
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
