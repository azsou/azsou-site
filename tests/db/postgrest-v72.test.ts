/**
 * V72 兼容性（真实 HTTP）：起一个与生产同版本线的 PostgREST（14.x），
 * 把 V72 前端发出的请求原样重放到「迁移前（baseline）」与「迁移后」两个库上，结果必须一致可用。
 * 也覆盖 v2 新增的请求形状（嵌入提示、HTTP 429 限流、403 越权）。
 *
 * 需要环境变量 POSTGREST_BIN（CI 会下载静态二进制）；没有时跳过并提示。
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, SHIM, migrationFiles } from './helpers';
import { ANON, BIN, ensureAuthenticator, freePort, startPostgrest, tok } from './postgrest';
import { C, T, U } from './fixtures';
import { freshDb } from './setup';

function client(port: number) {
  return async (method: string, path: string, token: string, body?: unknown, prefer?: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const r = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

const targets = [
  {
    label: '迁移前（baseline = 生产现状）',
    files: [SHIM, join(MIGRATIONS_DIR, '0001_baseline.sql')],
    migrated: false,
  },
  { label: '迁移后（0001–最新）', files: [SHIM, ...migrationFiles()], migrated: true },
];

describe.skipIf(!BIN)('PostgREST 重放 V72 请求', () => {
  beforeAll(async () => ensureAuthenticator());

  describe.each(targets)('$label', ({ files, migrated }) => {
    let db: Awaited<ReturnType<typeof freshDb>>;
    let proc: ChildProcess;
    let api: ReturnType<typeof client>;
    let port = 0;

    beforeAll(async () => {
      port = await freePort();
      db = await freshDb(migrated ? 'pgrst_new' : 'pgrst_old', { files });
      proc = await startPostgrest(db.name, port);
      api = client(port);
    }, 60_000);
    afterAll(async () => {
      proc?.kill();
      await db?.close();
    });

    it('anon：论坛列表（含 profiles(display_name) 嵌入，不得出现 PGRST201 歧义）', async () => {
      const r = await api(
        'GET',
        'forum_threads?select=id,cat,title,body,author,pinned,published,created_at,profiles(display_name)&order=created_at.desc&limit=200',
        ANON,
      );
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.length).toBeGreaterThan(3);
      expect(r.json.find((t: { id: string }) => t.id === T.alice).profiles).toEqual({
        display_name: 'alice',
      });
    });
    it('anon：回复计数 / 回复列表 / 评论列表 / 站点内容', async () => {
      expect((await api('GET', 'forum_replies?select=thread_id&limit=5000', ANON)).status).toBe(200);
      const rep = await api(
        'GET',
        `forum_replies?thread_id=eq.${T.bob}&select=id,body,author,created_at,published,profiles(display_name)&order=created_at.asc`,
        ANON,
      );
      expect(rep.status, JSON.stringify(rep.json)).toBe(200);
      expect(rep.json[0].profiles.display_name).toBeTruthy();
      const com = await api(
        'GET',
        'comments?page_key=eq.article:pinyin-initial-search&select=id,body,author,created_at,published,profiles(display_name)&order=created_at.asc',
        ANON,
      );
      expect(com.status).toBe(200);
      expect(com.json.length).toBe(5);
      const sc = await api(
        'GET',
        'site_content?kind=eq.app&select=*&order=updated_at.desc&published=is.true',
        ANON,
      );
      expect(sc.status).toBe(200);
      expect(sc.json.length).toBe(1);
    });
    it('user：读资料 / 改昵称 / 发主题 / 回帖（uuid 与种子主题）/ 评论 / 删除', async () => {
      const a = tok(U.alice);
      const p = await api('GET', `profiles?id=eq.${U.alice}&select=*`, a);
      expect(p.status).toBe(200);
      expect(p.json[0]).toMatchObject({ id: U.alice, role: 'user', banned: false });
      const n = await api(
        'PATCH',
        `profiles?id=eq.${U.alice}`,
        a,
        { display_name: 'alice2' },
        'return=representation',
      );
      expect(n.status, JSON.stringify(n.json)).toBe(200);
      expect(n.json[0].display_name).toBe('alice2');
      const t = await api(
        'POST',
        'forum_threads',
        a,
        { cat: '产品讨论', title: 'hi', body: 'b', author: U.alice },
        'return=representation',
      );
      expect(t.status, JSON.stringify(t.json)).toBe(201);
      const r1 = await api(
        'POST',
        'forum_replies',
        a,
        { thread_id: T.bob, body: 'r', author: U.alice },
        'return=representation',
      );
      expect(r1.status, JSON.stringify(r1.json)).toBe(201);
      const r2 = await api(
        'POST',
        'forum_replies',
        a,
        { thread_id: 't-announce', body: 'r', author: U.alice },
        'return=representation',
      );
      expect(r2.status, JSON.stringify(r2.json)).toBe(201);
      const c = await api(
        'POST',
        'comments',
        a,
        { page_key: 'article:pinyin-initial-search', body: 'c', author: U.alice },
        'return=representation',
      );
      expect(c.status, JSON.stringify(c.json)).toBe(201);
      expect((await api('DELETE', `comments?id=eq.${c.json[0].id}`, a)).status).toBe(204);
      expect((await api('DELETE', `forum_replies?id=eq.${r1.json[0].id}`, a)).status).toBe(204);
      expect((await api('DELETE', `forum_threads?id=eq.${t.json[0].id}`, a)).status).toBe(204);
    });
    it('admin：内容 upsert / 发布切换 / 置顶 / 隐藏 / 用户列表 / admin_set_user', async () => {
      const z = tok(U.ada);
      const row = { kind: 'game', slug: `g-${randomUUID().slice(0, 8)}`, data: { a: 1 }, published: true };
      const up = await api(
        'POST',
        'site_content?on_conflict=kind,slug',
        z,
        row,
        'return=representation,resolution=merge-duplicates',
      );
      expect(up.status, JSON.stringify(up.json)).toBe(201);
      const up2 = await api(
        'POST',
        'site_content?on_conflict=kind,slug',
        z,
        { ...row, data: { a: 2 } },
        'return=representation,resolution=merge-duplicates',
      );
      expect([200, 201]).toContain(up2.status);
      expect(up2.json[0].data).toEqual({ a: 2 });
      expect(
        (await api('PATCH', `site_content?id=eq.${up.json[0].id}`, z, { published: false })).status,
      ).toBe(204);
      expect((await api('PATCH', `forum_threads?id=eq.${T.alice}`, z, { pinned: true })).status).toBe(204);
      expect((await api('PATCH', `forum_threads?id=eq.${T.alice}`, z, { published: false })).status).toBe(
        204,
      );
      expect((await api('PATCH', `comments?id=eq.${C.bob}`, z, { published: false })).status).toBe(204);
      const users = await api('GET', 'profiles?select=*&order=created_at.desc&limit=500', z);
      expect(users.status).toBe(200);
      const set = await api('POST', 'rpc/admin_set_user', z, {
        target: U.bob,
        new_role: 'user',
        new_banned: true,
      });
      expect([200, 204], JSON.stringify(set.json)).toContain(set.status);
      expect(
        (await api('POST', 'rpc/admin_set_user', z, { target: U.bob, new_role: 'user', new_banned: false }))
          .status,
      ).toBeLessThan(300);
    });
    it('V72 发现的漏洞：迁移前存在、迁移后被拒绝', async () => {
      const a = tok(U.alice);
      const r = await api('PATCH', `forum_threads?id=eq.${T.alice}`, a, { pinned: true, cat: '公告' });
      if (migrated) expect(r.status).toBe(403);
      else expect(r.status).toBe(204);
      const forged = await api(
        'POST',
        'forum_threads',
        a,
        { cat: '产品讨论', title: 'x', body: 'b', author: U.alice, created_at: '2000-01-01T00:00:00Z' },
        'return=representation',
      );
      if (migrated) expect(forged.status).toBe(403);
      else expect(forged.status).toBe(201);
    });

    it.runIf(migrated)('v2：限流返回 HTTP 429，越权返回 403，匿名写入 401', async () => {
      const b = tok(U.bob);
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push(
          (await api('POST', 'comments', b, { page_key: 'article:x', body: `c${i}`, author: U.bob })).status,
        );
      }
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(statuses[5]).toBe(429);
      // 改别人的主题：RLS 把目标行过滤掉，PostgREST 返回 204 但没有任何行被修改
      expect(
        (await api('PATCH', `forum_threads?id=eq.${T.bob}`, tok(U.alice), { locked: true })).status,
      ).toBe(204);
      const check = await api('GET', `forum_threads?id=eq.${T.bob}&select=locked`, ANON);
      expect(check.json[0].locked).toBe(false);
      expect((await api('POST', 'comments', ANON, { page_key: 'article:x', body: 'c' })).status).toBe(401);
    });
    it.runIf(migrated)('v2：通知嵌入 actor（用外键提示消歧）、点赞汇总 RPC', async () => {
      const a = tok(U.bob);
      await api('POST', 'forum_replies', tok(U.alice), { thread: T.bob, body: 'ping' });
      const n = await api(
        'GET',
        'notifications?select=id,kind,excerpt,read_at,created_at,thread_key,actor:profiles!notifications_actor_fkey(display_name)&order=created_at.desc',
        a,
      );
      expect(n.status, JSON.stringify(n.json)).toBe(200);
      expect(n.json.some((x: { kind: string }) => x.kind === 'reply')).toBe(true);
      const s = await api('POST', 'rpc/like_summary', a, { p_target_type: 'thread', p_ids: [T.bob] });
      expect(s.status, JSON.stringify(s.json)).toBe(200);
      expect(s.json[0]).toMatchObject({ target_id: T.bob, likes: 5, liked: true });
    });
  });
});

if (!BIN) {
  describe('PostgREST 重放 V72 请求', () => {
    it.skip('未设置 POSTGREST_BIN，跳过（CI 中会运行）', () => {});
  });
}
