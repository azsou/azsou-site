/**
 * azsou-test 初始化执行器（scripts/sbtest/init-executor.mjs）——站长 2026-10-28 第五轮 ⑤。
 * 不连任何真实项目：Management API / Auth Admin / Storage 都由本文件里的假服务器回答（execute 只在站长批准后对 azsou-test 跑）。
 * 测：ref 允许清单、令牌范围、钉住 SHA + sha256、dry-run 零网络、每文件事务外壳、超时后核对「提交了没有」、不重试。
 */
import { describe, expect, it } from 'vitest';
import {
  EXIT,
  MIGRATIONS,
  PROD_REF,
  Refused,
  TEST_REF,
  applyOne,
  assertRef,
  buildManifest,
  client,
  execute,
  main,
  preflightProblems,
  verifyPinned,
  wrapMigration,
} from '../../scripts/sbtest/init-executor.mjs';

const SHA = 'a'.repeat(40);
const FILES = Object.fromEntries(
  MIGRATIONS.map((n) => [
    `db/migrations/${n}_m.sql`,
    Buffer.from(`-- ${n}\nbegin;\ncreate table t${n} (x int);\ncommit;\n`),
  ]),
);
FILES['db/verify/status.sql'] = Buffer.from("select '0002' as step, 'x' as item, true as ok;\n");
const read = (rel: string) =>
  FILES[rel] ??
  (() => {
    throw new Error(`no ${rel}`);
  })();
const list = () => MIGRATIONS.map((n) => `${n}_m.sql`);

describe('ref 允许清单', () => {
  it('只有 azsou-test', () => {
    expect(() => assertRef(TEST_REF)).not.toThrow();
    expect(() => assertRef(PROD_REF)).toThrow(/生产/);
    expect(() => assertRef('aaaaaaaaaaaaaaaaaaaa')).toThrow(Refused);
    expect(() => client({ token: 't', serviceKey: 'k', ref: PROD_REF })).toThrow(/生产/);
  });
});

describe('钉住 SHA + sha256', () => {
  const m = buildManifest(SHA, read, list);
  it('清单列出 0001–0019 各自的 sha256', () => {
    expect(m.migrations.map((x: { name: string }) => x.name.slice(0, 4))).toEqual([...MIGRATIONS]);
    expect(m.source_sha).toBe(SHA);
  });
  it('内容一致 → 通过；任何一个文件被改 → 拒绝', () => {
    expect(() => verifyPinned(m, SHA, read, list)).not.toThrow();
    const tampered = (rel: string) =>
      rel.includes('0007') ? Buffer.from('begin;\ndrop table x;\ncommit;\n') : read(rel);
    expect(() => verifyPinned(m, SHA, tampered, list)).toThrow(/0007/);
  });
  it('SHA 与清单钉住的不同 → 拒绝；不是 40 位 → 拒绝', () => {
    expect(() => verifyPinned(m, 'b'.repeat(40), read, list)).toThrow(/钉住/);
    expect(() => buildManifest('abc', undefined, list)).toThrow(/40 位/);
  });
  it('多一个 / 少一个迁移文件 → 拒绝', () => {
    expect(() => buildManifest(SHA, read, () => [...list(), '0020_x.sql'])).toThrow(/0001–0019/);
    expect(() => buildManifest(SHA, read, () => list().slice(1))).toThrow(/0001–0019/);
  });
});

describe('每个文件一个事务 + 超时 + 账本', () => {
  it('去掉文件自带的 begin / commit，换成带超时与账本行的单事务', () => {
    const w = wrapMigration(read('db/migrations/0003_m.sql'), {
      name: '0003_m.sql',
      sha: 'f'.repeat(64),
      runId: 'r1',
    });
    expect(w.match(/^begin;$/gm)).toHaveLength(1);
    expect(w.match(/^commit;$/gm)).toHaveLength(1);
    expect(w).toMatch(/set local statement_timeout = '300s'/);
    expect(w).toMatch(/insert into az_init\.applied .*'r1', '0003_m\.sql'/);
    expect(w.indexOf('create table t0003')).toBeLessThan(w.indexOf('insert into az_init.applied'));
  });
  it('文件结构不是单个 begin…commit → 拒绝（不猜）', () => {
    expect(() =>
      wrapMigration(Buffer.from('create table x();\n'), { name: 'x', sha: '', runId: 'r' }),
    ).toThrow(Refused);
    expect(() =>
      wrapMigration(Buffer.from('begin;\nbegin;\ncommit;\n'), { name: 'x', sha: '', runId: 'r' }),
    ).toThrow(Refused);
  });
});

/** 假 Management API：按规则回答，记录每个请求 */
function fakeApi(opts: {
  projects?: string[];
  onQuery?: (q: string) => Response | Promise<Response>;
  onReadOnly?: (q: string) => unknown;
}) {
  const calls: { url: string; body: string }[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (url.endsWith('/v1/projects'))
      return Response.json((opts.projects ?? [TEST_REF]).map((ref) => ({ ref })));
    const q = url.includes('/database/query') && init.body ? JSON.parse(String(init.body)).query : '';
    if (url.endsWith('/database/query/read-only'))
      return Response.json([opts.onReadOnly?.(q) ?? {}], { status: 201 });
    if (url.endsWith('/database/query'))
      return opts.onQuery ? opts.onQuery(q) : Response.json([], { status: 201 });
    if (url.includes('/auth/v1/admin/users')) return Response.json({ id: crypto.randomUUID() });
    if (url.includes('/storage/v1/object/')) return Response.json({ Key: 'x' });
    return new Response('?', { status: 404 });
  };
  return { calls, fetchImpl: f as unknown as typeof fetch };
}
const EMPTY = {
  preflight: {
    server_version: '17.6',
    public_relations: 0,
    public_functions: 0,
    private_schema: false,
    az_init_schema: false,
    auth_users: 0,
    storage_buckets: 0,
    storage_objects: 0,
  },
};

describe('令牌范围与预检', () => {
  const manifest = buildManifest(SHA, read, list);
  it('令牌能看到生产项目 → 拒绝，一个写请求都不发', async () => {
    const api = fakeApi({ projects: [TEST_REF, PROD_REF] });
    const c = client({ token: 't', serviceKey: 'k', fetchImpl: api.fetchImpl });
    await expect(execute({ sha: SHA, manifest, c, runId: 'r', read, log: () => {} })).rejects.toThrow(
      /生产项目/,
    );
    expect(api.calls.some((x) => x.url.endsWith('/database/query'))).toBe(false);
  });
  it('令牌能看到别的项目 → 拒绝', async () => {
    const api = fakeApi({ projects: [TEST_REF, 'bbbbbbbbbbbbbbbbbbbb'] });
    const c = client({ token: 't', serviceKey: 'k', fetchImpl: api.fetchImpl });
    await expect(execute({ sha: SHA, manifest, c, runId: 'r', read, log: () => {} })).rejects.toThrow(
      /恰好只有 azsou-test/,
    );
  });
  it('项目不是空的 → 拒绝（不清空、不覆盖）', () => {
    expect(preflightProblems({ ...EMPTY.preflight, auth_users: 3, public_relations: 2 })).toHaveLength(2);
    expect(preflightProblems(EMPTY.preflight)).toEqual([]);
  });
});

describe('超时 / 断线后先核对是否提交，不重试', () => {
  const m = { name: '0005_m.sql', sha256: 'f'.repeat(64) };
  const sql = read('db/migrations/0005_m.sql');
  const withVerify = (ledger: number, running: number) =>
    client({
      token: 't',
      serviceKey: 'k',
      fetchImpl: fakeApi({
        onQuery: () => {
          throw new Error('client-timeout');
        },
        onReadOnly: () => ({ v: { ledger, running } }),
      }).fetchImpl,
    });
  it('超时但账本有行 → 已提交', async () => {
    expect((await applyOne(withVerify(1, 0), m, sql, 'r')).outcome).toBe('committed');
  });
  it('超时且账本没有行、也没在跑 → 未提交', async () => {
    expect((await applyOne(withVerify(0, 0), m, sql, 'r')).outcome).toBe('not-committed');
  });
  it('超时且会话还在跑 → still-running（不重试）', async () => {
    expect((await applyOne(withVerify(0, 1), m, sql, 'r')).outcome).toBe('still-running');
  });
  it('执行中途某个文件失败 → 停在那里（exit 1），后面的文件不发', async () => {
    const queries: string[] = [];
    const api = fakeApi({
      onQuery: (q) => {
        queries.push(q);
        return q.includes('0004_m.sql')
          ? new Response('boom', { status: 400 })
          : Response.json([], { status: 201 });
      },
      onReadOnly: (q) =>
        q.includes('preflight')
          ? EMPTY
          : q.includes('az_init.applied')
            ? { v: { ledger: 0, running: 0 } }
            : { rows: null },
    });
    const c = client({ token: 't', serviceKey: 'k', fetchImpl: api.fetchImpl });
    const r = await execute({
      sha: SHA,
      manifest: buildManifest(SHA, read, list),
      c,
      runId: 'r',
      read,
      log: () => {},
    });
    expect(r.exit).toBe(EXIT.FAILED);
    expect(queries.some((q) => q.includes('0005_m.sql'))).toBe(false);
  });
  it('全部成功 → 账号经 Auth Admin API、文件经 Storage API，不直接写 auth.users / auth.identities', async () => {
    const queries: string[] = [];
    const api = fakeApi({
      onQuery: (q) => {
        queries.push(q);
        return Response.json([], { status: 201 });
      },
      onReadOnly: (q) => (q.includes('preflight') ? EMPTY : { rows: null }),
    });
    const c = client({ token: 't', serviceKey: 'k', fetchImpl: api.fetchImpl });
    const r = await execute({
      sha: SHA,
      manifest: buildManifest(SHA, read, list),
      c,
      runId: 'r',
      read,
      log: () => {},
    });
    expect(r.exit).toBe(EXIT.OK);
    expect(api.calls.filter((x) => x.url.includes('/auth/v1/admin/users'))).toHaveLength(4);
    expect(
      api.calls
        .filter((x) => x.url.includes('/auth/v1/admin/users'))
        .every((x) => JSON.parse(x.body).email_confirm === true),
    ).toBe(true);
    expect(api.calls.some((x) => x.body.includes('sbtest-moderator@example.com'))).toBe(true);
    expect(api.calls.filter((x) => x.url.includes('/storage/v1/object/ugc-images/'))).toHaveLength(2);
    expect(queries.join('\n')).not.toMatch(/insert into auth\.(users|identities)/i);
  });
});

describe('CLI dry-run', () => {
  it('plan 不发任何网络请求（fetch 被替换成会抛错的哨兵）', async () => {
    const orig = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called++;
      throw new Error('NETWORK');
    }) as typeof fetch;
    try {
      const log = console.log;
      console.log = () => {};
      const code = await main(['plan']);
      console.log = log;
      expect(code).toBe(EXIT.OK);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
  it('execute 缺站长批准 / 确认 ref 不对 → 拒绝（exit 2）', async () => {
    const err = console.error;
    console.error = () => {};
    expect(await main(['execute', '--execute', '--confirm-ref', PROD_REF], {})).toBe(EXIT.REFUSED);
    expect(await main(['execute', '--execute', '--confirm-ref', TEST_REF], {})).toBe(EXIT.REFUSED);
    console.error = err;
  });
});
