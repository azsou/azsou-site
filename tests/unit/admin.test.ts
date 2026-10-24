/** P4 管理后台：纯函数（CSV / 图表 / 设置 / 封禁时长 / 审计摘要 / 路由）与 Supabase 后台接口的请求格式。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRepository, DataUnavailableError, memoryStore, type Session } from '@/lib/data';
import { auditPath, toContentRow, uuidList } from '@/lib/data/admin';
import { csvCell, toCsv } from '@/lib/csv';
import { groupedBars, niceMax } from '@/lib/chart';
import {
  DEFAULT_SETTINGS,
  enabledCategories,
  mergeSettings,
  normalizeAnnouncement,
  normalizeForum,
  normalizeRegistration,
  parseSettingsImport,
  RATE_LIMITS,
  safeLink,
} from '@/lib/settings';
import { auditSummary, banExpiry } from '@/lib/admin-utils';
import { auditLabel, ADMIN_SECTIONS } from '@/lib/admin-nav';
import { pageKeyUrl, url } from '@/lib/routes';
import { githubEdit } from '@/lib/site';

describe('CSV', () => {
  it('转义逗号 / 引号 / 换行；对象转 JSON；null 为空', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('他说"好"')).toBe('"他说""好"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
  });
  it('防公式注入：= + - @ 开头加单引号', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM')).toBe("'@SUM");
  });
  it('表头 + BOM + CRLF；列顺序按 columns', () => {
    const s = toCsv([{ b: 2, a: '中文' }], ['a', 'b']);
    expect(s).toBe('\uFEFFa,b\r\n中文,2\r\n');
    expect(toCsv([{ x: 1 }, { y: 2 }], undefined, false)).toBe('x,y\r\n1,\r\n,2\r\n');
  });
});

describe('柱状图几何', () => {
  it('niceMax 取 1/2/5×10^n', () => {
    expect([0, 1, 3, 7, 12, 45, 101].map(niceMax)).toEqual([1, 1, 5, 10, 20, 50, 200]);
  });
  it('分组柱：高度按比例，柱子不越界', () => {
    const { bars, max } = groupedBars(
      [
        { key: 'a', values: [0, 5, 10] },
        { key: 'b', values: [2, 4, 6] },
      ],
      { width: 300, height: 100, gap: 4 },
    );
    expect(max).toBe(10);
    expect(bars).toHaveLength(6);
    const a2 = bars.find((b) => b.series === 'a' && b.index === 2)!;
    expect(a2.height).toBe(100);
    expect(a2.y).toBe(0);
    expect(bars.find((b) => b.series === 'a' && b.index === 0)!.height).toBe(0);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(300.0001);
    }
  });
});

describe('站点设置', () => {
  it('公告：没有内容时不能启用；level 只认 warning；链接只允许站内路径或 http(s)', () => {
    expect(normalizeAnnouncement({ enabled: true, text: '  ' }).enabled).toBe(false);
    const a = normalizeAnnouncement({
      enabled: true,
      text: ' 维护通知 ',
      level: 'x',
      link: 'javascript:alert(1)',
    });
    expect(a).toEqual({ enabled: true, text: '维护通知', level: 'info', link: '', linkText: '' });
    expect(safeLink('/changelog/')).toBe('/changelog/');
    expect(safeLink('//evil.com')).toBe('');
    expect(safeLink('https://azsou.com/a')).toBe('https://azsou.com/a');
    expect(safeLink('data:text/html,1')).toBe('');
    expect(normalizeAnnouncement({ text: 'x'.repeat(300) }).text).toHaveLength(200);
  });
  it('论坛分类：未知 / 重复的 id 丢弃，缺的补在最后，order 归一化', () => {
    const f = normalizeForum({
      categories: [
        { id: 'meta', enabled: false, order: 5 },
        { id: 'evil', enabled: true },
        { id: 'tech', order: 1 },
        { id: 'tech', order: 9 },
      ],
    });
    expect(f.categories.map((c) => c.id)).toEqual(['tech', 'meta', 'announce', 'product']);
    expect(f.categories.map((c) => c.order)).toEqual([0, 1, 2, 3]);
    expect(enabledCategories(f)).toEqual(['tech', 'announce', 'product']);
  });
  it('注册：默认开放；mergeSettings 忽略未发布与未知设置', () => {
    expect(normalizeRegistration({})).toEqual({ open: true, message: '' });
    const s = mergeSettings([
      { slug: 'registration', data: { open: false, message: '维护中' } },
      { slug: 'announcement', data: { enabled: true, text: 'hi' }, published: false },
      { slug: 'nope', data: {} },
    ]);
    expect(s.registration).toEqual({ open: false, message: '维护中' });
    expect(s.announcement).toEqual(DEFAULT_SETTINGS.announcement);
  });
  it('导入：本站导出格式与简写格式；未知设置项 / 非对象 / 坏 JSON 报错', () => {
    const ok = parseSettingsImport(
      JSON.stringify({
        version: 1,
        settings: [
          { slug: 'announcement', data: { enabled: true, text: 'x', link: 'javascript:1' }, published: true },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.settings[0]).toMatchObject({ slug: 'announcement', data: { link: '' }, published: true });
    const short = parseSettingsImport(JSON.stringify({ registration: { open: false } }));
    expect(short.settings).toEqual([
      { slug: 'registration', data: { open: false, message: '' }, published: true },
    ]);
    expect(parseSettingsImport('{').errors).toEqual(['不是有效的 JSON']);
    expect(parseSettingsImport(JSON.stringify({ admin: {} })).ok).toBe(false);
    expect(parseSettingsImport(JSON.stringify({ forum: [] })).errors[0]).toMatch(/必须是对象/);
    expect(parseSettingsImport('{}').ok).toBe(false);
  });
  it('后台展示的限流与 0004 迁移里的 az_rate_limit 调用一致', () => {
    const sql = readFileSync(
      resolve(import.meta.dirname, '../../db/migrations/0004_functions_triggers.sql'),
      'utf8',
    );
    const found = [...sql.matchAll(/az_rate_limit\('([a-z_]+)', (\d+), interval '([^']+)'\)/g)].map(
      ([, action, max, per]) => ({ action, max: Number(max), per }),
    );
    expect(found.length).toBeGreaterThan(5);
    expect(
      RATE_LIMITS.map(({ action, max, per }) => ({ action, max, per })).sort((a, b) =>
        a.action.localeCompare(b.action),
      ),
    ).toEqual(found.sort((a, b) => a.action.localeCompare(b.action)));
  });
});

describe('封禁时长 / 审计摘要 / 路由', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  it('banExpiry：天数、永久、自定义（过去 / 空 → 错误）', () => {
    expect(banExpiry('7', '', now)).toBe('2026-10-31T00:00:00.000Z');
    expect(banExpiry('', '', now)).toBeNull();
    expect(banExpiry('custom', '2026-11-01T08:00', now)).toMatch(/^2026-11-01T/);
    expect(banExpiry('custom', '', now)).toBeInstanceOf(Error);
    expect(banExpiry('custom', '2020-01-01T00:00', now)).toBeInstanceOf(Error);
    expect(banExpiry('-3', '', now)).toBeInstanceOf(Error);
  });
  it('auditSummary：角色变化、原因、内容修改', () => {
    expect(auditSummary({ from: { role: 'user' }, to: { role: 'moderator' } })).toBe(
      '{"role":"user"} → {"role":"moderator"}',
    );
    expect(auditSummary({ reason: '广告', expires_at: '2026-11-01' })).toBe('原因：广告 · 到期：2026-11-01');
    expect(
      auditSummary({ author: 'x', changes: { published: { from: true, to: false }, body: 'edited' } }),
    ).toBe('published=false，body:edited');
    expect(auditSummary({})).toBe('');
    expect(auditLabel('user.ban')).toBe('封禁用户');
    expect(auditLabel('x.y')).toBe('x.y');
  });
  it('pageKeyUrl / 后台路由 / GitHub 编辑链接', () => {
    expect(pageKeyUrl('article:pinyin-initial-search')).toBe('/articles/pinyin-initial-search/');
    expect(pageKeyUrl('tool:claude-code')).toBe('/ai/claude-code/');
    expect(pageKeyUrl('ai:claude-code')).toBeNull();
    expect(pageKeyUrl('project:fablemotion')).toBe('/apps/fablemotion/');
    expect(pageKeyUrl('game:emberdeep')).toBe('/games/emberdeep/');
    expect(pageKeyUrl('evil:x')).toBeNull();
    expect(url.adminUser('a b')).toBe('/admin/users/view/?id=a%20b');
    expect(url.admin('reports')).toBe('/admin/reports/');
    expect(githubEdit('src/content/apps/x.md')).toBe(
      'https://github.com/azsou/azsou-site/edit/main/src/content/apps/x.md',
    );
    expect(ADMIN_SECTIONS.filter((s) => s.role === 'admin').map((s) => s.id)).toEqual([
      'audit',
      'settings',
      'data',
    ]);
  });
});

// ------------------------------------------------------ 后台接口请求格式 ----
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fakeFetch(
  routes: [RegExp, (c: Call) => { status?: number; json?: unknown; headers?: Record<string, string> }][],
) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      url: decodeURIComponent(String(input)),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    const r = hit ? hit[1](c) : { status: 404, json: { message: 'no route' } };
    return new Response(JSON.stringify(r.json ?? null), { status: r.status ?? 200, headers: r.headers });
  });
  return { f: f as unknown as typeof fetch, calls };
}
const session: Session = {
  accessToken: 'jwt-admin',
  refreshToken: 'r',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u-admin', email: 'a@x.com', emailConfirmed: true, provider: 'email' },
};
const repoWith = (routes: Parameters<typeof fakeFetch>[0]) => {
  const ff = fakeFetch(routes);
  const repo = createSupabaseRepository({
    url: 'https://x.supabase.co',
    key: 'pk',
    fetch: ff.f,
    store: memoryStore(session),
  });
  return { admin: repo.admin!, calls: ff.calls };
};
const ID1 = '10000000-0000-4000-b000-000000000001';
const ID2 = '10000000-0000-4000-b000-000000000002';

describe('Supabase 后台接口', () => {
  it('listContent → rpc/mod_list_content（分类名中文、筛选、总数）', async () => {
    const { admin, calls } = repoWith([
      [
        /POST .*rpc\/mod_list_content/,
        () => ({
          json: [
            {
              id: ID1,
              kind: 'thread',
              title: 'T',
              excerpt: 'b',
              cat: '技术交流',
              author: ID2,
              author_name: 'bob',
              published: false,
              open_reports: 2,
              created_at: '2026-10-01T00:00:00Z',
              total: 7,
            },
          ],
        }),
      ],
    ]);
    const r = await admin.listContent({
      type: 'thread',
      q: ' 关键 ',
      category: 'tech',
      hidden: true,
      author: 'bad',
      limit: 500,
    });
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-admin');
    expect(calls[0].body).toEqual({
      p_type: 'thread',
      p_q: '关键',
      p_cat: '技术交流',
      p_hidden: true,
      p_reported: null,
      p_author: null,
      p_limit: 100,
      p_offset: 0,
    });
    expect(r.total).toBe(7);
    expect(r.items[0]).toMatchObject({
      category: 'tech',
      published: false,
      openReports: 2,
      author: { name: 'bob' },
      href: `/forum/t/?id=${ID1}`,
    });
  });
  it('listReports 用 Prefer: count=exact 并解析 Content-Range 总数', async () => {
    const { admin, calls } = repoWith([
      [
        /GET .*reports\?/,
        () => ({
          json: [
            {
              id: ID1,
              target_type: 'thread',
              target_id: ID2,
              reason: 'spam',
              status: 'open',
              created_at: 'x',
            },
          ],
          headers: { 'content-range': '0-0/42' },
        }),
      ],
    ]);
    const r = await admin.listReports({ status: 'open', targetType: 'reply', limit: 1 });
    expect(r.total).toBe(42);
    expect(calls[0].headers.Prefer).toBe('count=exact');
    expect(calls[0].url).toContain(
      'status=eq.open&target_type=eq.reply&order=created_at.asc,id.asc&limit=1&offset=0',
    );
  });
  it('批量隐藏只发合法 uuid；没有合法 id 时不发请求', async () => {
    const { admin, calls } = repoWith([
      [/PATCH .*forum_replies/, () => ({ json: [{ id: ID1 }, { id: ID2 }] })],
    ]);
    expect(await admin.setPublished('reply', [ID1, 'x),id.neq.(', ID2, ID1], false)).toBe(2);
    expect(calls[0].url).toContain(`forum_replies?id=in.(${ID1},${ID2})&select=id`);
    expect(calls[0].body).toEqual({ published: false });
    expect(await admin.deleteContent('comment', ['nope'])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(uuidList(['A0000000-0000-4000-b000-000000000001'])).toHaveLength(1);
  });
  it('handleReports / ban / setRole 的 RPC 参数', async () => {
    const { admin, calls } = repoWith([[/POST .*rpc\//, () => ({ json: 3 })]]);
    expect(
      await admin.handleReports([ID1, 'bad'], 'resolved', { note: ' 广告 ', action: 'ban', banDays: 7 }),
    ).toBe(3);
    await admin.ban(ID2, ' 刷屏 ', null);
    await admin.setRole(ID2, 'moderator', false);
    expect(calls.map((c) => [c.url.split('/rpc/')[1], c.body])).toEqual([
      [
        'mod_handle_reports',
        { p_ids: [ID1], p_status: 'resolved', p_note: '广告', p_action: 'ban', p_ban_days: 7 },
      ],
      ['mod_ban_user', { p_target: ID2, p_reason: '刷屏', p_expires_at: null }],
      ['admin_set_user', { target: ID2, new_role: 'moderator', new_banned: false }],
    ]);
  });
  it('saveSetting 用 upsert（on_conflict=kind,slug + merge-duplicates）', async () => {
    const { admin, calls } = repoWith([
      [/POST .*site_content/, (c) => ({ json: [{ ...(c.body as object), updated_at: 'now' }] })],
    ]);
    const r = await admin.saveSetting('registration', { open: false });
    expect(calls[0].url).toContain('site_content?on_conflict=kind,slug');
    expect(calls[0].headers.Prefer).toBe('resolution=merge-duplicates,return=representation');
    expect(calls[0].body).toEqual({
      kind: 'setting',
      slug: 'registration',
      data: { open: false },
      published: true,
    });
    expect(r).toEqual({ slug: 'registration', data: { open: false }, published: true, updatedAt: 'now' });
  });
  it('旧库（没有 0009 的 RPC）→ DataUnavailableError 提示需要迁移', async () => {
    const { admin } = repoWith([
      [/rpc\/admin_stats/, () => ({ status: 404, json: { code: 'PGRST202', message: 'x' } })],
    ]);
    await expect(admin.stats()).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(admin.stats()).rejects.toThrow(/0009/);
  });
  it('数据库的中文参数错误 → 原样展示', async () => {
    const { admin } = repoWith([
      [
        /rpc\/mod_ban_user/,
        () => ({ status: 400, json: { code: '22023', message: '到期时间必须晚于现在' } }),
      ],
    ]);
    await expect(admin.ban(ID1, '', '2000-01-01T00:00:00Z')).rejects.toThrow('到期时间必须晚于现在');
  });
  it('previews：不存在的目标标记为已删除；回复链接到主题锚点；评论链接到页面', async () => {
    const { admin } = repoWith([
      [
        /GET .*forum_replies\?/,
        () => ({
          json: [
            {
              id: ID1,
              thread_id: 't-announce',
              body: '回复正文',
              author: ID2,
              published: true,
              profiles: { display_name: 'bob' },
            },
          ],
        }),
      ],
      [/GET .*comments\?/, () => ({ json: [] })],
    ]);
    const p = await admin.previews([
      { type: 'reply', id: ID1 },
      { type: 'comment', id: ID2 },
    ]);
    expect(p[`reply:${ID1}`]).toMatchObject({
      exists: true,
      href: `/forum/t/t-announce/#r-${ID1}`,
      author: { name: 'bob' },
    });
    expect(p[`comment:${ID2}`]).toMatchObject({ exists: false, excerpt: '内容已被删除' });
  });
  it('auditPath：前缀匹配、时间范围、非法 actor 丢弃、limit 上限 1000', () => {
    const p = decodeURIComponent(
      auditPath({ action: 'user.', actor: 'x', from: '2026-10-01T00:00:00Z', limit: 5000 }),
    );
    expect(p).toContain('action=like.user.*');
    expect(p).toContain('created_at=gte.2026-10-01T00:00:00.000Z');
    expect(p).not.toContain('actor=');
    expect(p).toContain('limit=1000');
    expect(decodeURIComponent(auditPath({ targetId: 'a,b(c)' }))).toContain('target_id=eq.a b c');
  });
  it('toContentRow：评论链接到所在页面，回复链接到主题锚点', () => {
    expect(toContentRow({ id: ID1, kind: 'comment', page_key: 'article:x', author: null }).href).toBe(
      '/articles/x/',
    );
    expect(toContentRow({ id: ID1, kind: 'reply', thread_key: ID2 }).href).toBe(
      `/forum/t/?id=${ID2}#r-${ID1}`,
    );
    expect(toContentRow({ id: ID1, kind: 'thread', author_name: '' }).author.name).toBe('已注销用户');
  });
});
