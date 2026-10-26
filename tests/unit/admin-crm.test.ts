import { describe, expect, it } from 'vitest';
import { diffStats, fillTemplate, lineDiff, recentCount, userSegments } from '@/lib/admin-crm';

describe('lineDiff', () => {
  it('相同文本全部 same', () => {
    expect(lineDiff('a\nb', 'a\nb').every((o) => o.op === 'same')).toBe(true);
  });
  it('新增 / 删除 / 修改一行', () => {
    const ops = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(ops).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
      { op: 'add', text: 'd' },
    ]);
    expect(diffStats(ops)).toEqual({ add: 2, del: 1 });
  });
  it('CRLF 与 LF 视为相同', () => {
    expect(diffStats(lineDiff('a\r\nb', 'a\nb'))).toEqual({ add: 0, del: 0 });
  });
  it('超大文本退化为整段替换，不卡顿', () => {
    const big = Array.from({ length: 900 }, (_, i) => `l${i}`).join('\n');
    const ops = lineDiff(big, `${big}\nx`);
    expect(ops.length).toBe(1801);
  });
});

describe('userSegments', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const base = {
    role: 'user',
    banned: false,
    createdAt: '2026-01-01T00:00:00Z',
    threads: 1,
    replies: 0,
    comments: 0,
    reportsAgainst: 0,
  };
  it('按真实字段分群', () => {
    expect(userSegments(base, now)).toEqual([]);
    expect(userSegments({ ...base, createdAt: '2026-10-20T00:00:00Z' }, now)).toContain('new');
    expect(userSegments({ ...base, recentPosts: 3 }, now)).toContain('active');
    expect(userSegments({ ...base, threads: 0 }, now)).toContain('silent');
    expect(userSegments({ ...base, reportsAgainst: 1, banned: true, role: 'moderator' }, now)).toEqual([
      'reported',
      'banned',
      'staff',
    ]);
  });
  it('recentCount 只数 30 天内', () => {
    expect(
      recentCount(
        [{ createdAt: '2026-10-25T00:00:00Z' }, { createdAt: '2026-08-01T00:00:00Z' }, { createdAt: 'x' }],
        now,
      ),
    ).toBe(1);
  });
});

describe('fillTemplate', () => {
  it('替换已知变量，未知变量原样保留', () => {
    expect(fillTemplate('{{name}}，你好 {{ role }} {{oops}}', { name: '小明', role: '用户' })).toBe(
      '小明，你好 用户 {{oops}}',
    );
  });
});

describe('createAdminApi：排序参数只传白名单', async () => {
  const { createAdminApi } = await import('@/lib/data/admin');
  const calls: { path: string; body: unknown }[] = [];
  const api = createAdminApi({
    rest: async <T>(path: string, init?: { body?: unknown }) => {
      calls.push({ path, body: init?.body });
      return [] as T;
    },
    restCount: async () => ({ rows: [], total: 0 }),
  });
  it('合法列带上 p_sort / p_dir；非法列不传', async () => {
    await api.listContent({ type: 'thread', sort: 'title', dir: 'asc' });
    expect(calls.at(-1)?.body).toMatchObject({ p_sort: 'title', p_dir: 'asc' });
    await api.listUsers({ sort: 'evil' as never });
    expect(calls.at(-1)?.body).not.toHaveProperty('p_sort');
    await api.listUsers({ sort: 'threads' });
    expect(calls.at(-1)?.body).toMatchObject({ p_sort: 'threads', p_dir: 'desc' });
  });
  it('备注 / 版本对非法 id 不发请求', async () => {
    const n = calls.length;
    const { createCrmApi } = await import('@/lib/data/admin-crm-api');
    const crm = createCrmApi(api.raw());
    expect(await crm.versions('thread', 'x')).toEqual([]);
    expect(await crm.deleteNote(-1)).toBe(0);
    expect(calls.length).toBe(n);
  });
});
