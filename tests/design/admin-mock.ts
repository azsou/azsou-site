/**
 * 后台状态夹具（T9.16）：不连数据库，用 page.route 拦截 Supabase（/rest/v1、/auth/v1）返回固定数据，
 * 让静态构建里的后台页面可以稳定地截出「有数据 / 空 / 错 / 加载 / 无权限」各态。
 * e2e（tests/e2e/admin-states.spec.ts）与视觉基线（tests/visual/visual.spec.ts）共用。
 */
import type { Page, Route } from '@playwright/test';

export type AdminMockState = 'data' | 'empty' | 'error' | 'loading';
export type AdminMockRole = 'admin' | 'moderator' | 'user' | 'banned' | 'anon';

export const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const AUTHOR_A = '00000000-0000-4000-8000-0000000000b1';
const AUTHOR_B = '00000000-0000-4000-8000-0000000000b2';
const tid = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

const json = (route: Route, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });

/** 主题行：标题长短不一、摘要带 Markdown（应显示为一行纯文本）、各种状态徽标 */
export const CONTENT_ROWS = [
  {
    id: tid(1),
    kind: 'thread',
    title: 'Godot 4.5 的 TileMapLayer 迁移踩坑记录：旧场景批量转换脚本分享',
    excerpt:
      '## 背景\n升级到 **4.5** 之后，`TileMap` 被拆成多个 [TileMapLayer](https://docs.godotengine.org)，旧场景需要……',
    cat: '技术交流',
    author: AUTHOR_A,
    author_name: '像素旅人',
    published: true,
    pinned: true,
    featured: true,
    locked: false,
    created_at: '2026-10-24T09:12:00Z',
    open_reports: 0,
  },
  {
    id: tid(2),
    kind: 'thread',
    title: '求推荐：独立开发者用的轻量崩溃上报方案',
    excerpt: '目前用的是自建 Sentry，内存占用有点大。大家都用什么？> 最好支持 Windows 与 Android。',
    cat: '产品讨论',
    author: AUTHOR_B,
    author_name: 'Mika',
    published: true,
    pinned: false,
    featured: false,
    locked: false,
    created_at: '2026-10-23T14:30:00Z',
    open_reports: 2,
  },
  {
    id: tid(3),
    kind: 'thread',
    title: '广告：低价出售游戏账号',
    excerpt: '加 V 私聊……',
    cat: '站务反馈',
    author: AUTHOR_B,
    author_name: 'Mika',
    published: false,
    pinned: false,
    featured: false,
    locked: true,
    created_at: '2026-10-22T03:05:00Z',
    open_reports: 5,
  },
  {
    id: tid(4),
    kind: 'thread',
    title: 'AI 工具页能不能加一个「只看开源」的筛选？',
    excerpt: '现在要一个个点进去看许可证。',
    cat: '站务反馈',
    author: AUTHOR_A,
    author_name: '像素旅人',
    published: true,
    pinned: false,
    featured: false,
    locked: false,
    created_at: '2026-10-21T11:45:00Z',
    edited_at: '2026-10-21T12:00:00Z',
    open_reports: 0,
  },
].map((r) => ({ ...r, total: 4 }));

export const STATS = {
  users: 128,
  banned: 2,
  moderators: 3,
  admins: 1,
  threads: 342,
  threads_hidden: 6,
  replies: 1897,
  replies_hidden: 12,
  comments: 465,
  comments_hidden: 0,
  reports_open: 3,
  signups_7: 14,
  signups_30: 52,
  daily: Array.from({ length: 30 }, (_, i) => ({
    day: `2026-${i < 5 ? '09' : '10'}-${String(i < 5 ? 26 + i : i - 4).padStart(2, '0')}`,
    signups: (i * 7) % 5,
    posts: 8 + ((i * 13) % 17),
  })),
  generated_at: '2026-10-25T04:00:00Z',
};

function profile(role: AdminMockRole) {
  return {
    id: ADMIN_ID,
    display_name: '站长',
    role: role === 'banned' ? 'moderator' : role === 'anon' ? 'user' : role,
    banned: role === 'banned',
    created_at: '2025-01-01T00:00:00Z',
  };
}

/** 在页面脚本运行前写入登录态（V72 会话格式），并拦截所有 Supabase 请求 */
type MockSet = { role?: AdminMockRole; state?: AdminMockState };
export async function mockAdmin(page: Page, opts: MockSet = {}): Promise<{ set(next: MockSet): void }> {
  // 可变：测试中途切换状态 / 角色（不重新注册路由）；未登录（anon）只能在开头决定
  let role = opts.role ?? 'admin';
  let state = opts.state ?? 'data';
  if (role !== 'anon')
    await page.addInitScript((id) => {
      localStorage.setItem(
        'az-session-v68',
        JSON.stringify({
          access_token: 'mock-access',
          refresh_token: 'mock-refresh',
          expires_at: 4102444800,
          user: {
            id,
            email: 'owner@example.com',
            email_confirmed_at: '2025-01-01T00:00:00Z',
            app_metadata: { provider: 'email' },
            user_metadata: { name: '站长' },
          },
        }),
      );
    }, ADMIN_ID);

  await page.route(/\/auth\/v1\//, (route) =>
    json(route, { id: ADMIN_ID, email: 'owner@example.com', app_metadata: {}, user_metadata: {} }),
  );
  await page.route(/\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace(/^.*\/rest\/v1\//, '');
    if (path === 'profiles' && u.searchParams.get('id') === `eq.${ADMIN_ID}`)
      return json(route, [profile(role)]);
    const isData = /^rpc\/(admin_stats|mod_list_content|mod_list_users)$/.test(path) || path === 'reports';
    if (isData && state === 'loading') return; // 永不返回：停在加载态
    if (isData && state === 'error')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'upstream unavailable' }),
      });
    if (path === 'rpc/admin_stats') return json(route, STATS);
    if (path === 'rpc/mod_list_content') return json(route, state === 'data' ? CONTENT_ROWS : []);
    if (path === 'reports') {
      const n = state === 'data' ? STATS.reports_open : 0;
      return json(route, [], { 'content-range': `*/${n}` });
    }
    if (path.startsWith('rpc/') && /lift/.test(path)) return json(route, 0);
    // 其余（通知数、站点设置、昵称等）：空
    return json(route, [], { 'content-range': '*/0' });
  });
  return {
    set(next: MockSet) {
      if (next.role) role = next.role;
      if (next.state) state = next.state;
    },
  };
}
