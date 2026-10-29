/**
 * azsou-test 初始化执行器（scripts/sbtest/init-executor.mjs）——第五轮 ⑤ + 第六轮 ①②③。
 * 不连任何真实项目：Management API / Auth Admin / Storage 都由本文件里的有状态假服务器回答。
 * 测：ref 允许清单、钉住 SHA + sha256、dry-run 零网络、每文件事务外壳、超时后核对、不重试；
 *     第六轮：权限预检（403 列项目照常继续、名称 / ref / 区域不符拒绝）、injected 凭据通道（不带头、401 拒绝、主机允许清单）、
 *     V1 验收接入 execute（每项失败都非零）、超时清点、--resume、测试账号密码不进日志 / 记录。
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as XX from '../../scripts/sbtest/init-executor.mjs';
import * as F from './sbtest-fake';
import type { State } from './sbtest-fake';
import {
  EXIT,
  MIGRATIONS,
  MGMT_INJECTED_BASE,
  NoInjection,
  Unauthorized,
  PROD_REF,
  PROJECT_BASE,
  Refused,
  TEST_REF,
  analyzeLedger,
  applyOne,
  assertRef,
  buildManifest,
  client,
  execute,
  main,
  preflight,
  preflightProblems,
  resolveEndpoints,
  runRecordMarkdown,
  syntheticFiles,
  verifyPinned,
  verifyTarget,
  wrapMigration,
} from '../../scripts/sbtest/init-executor.mjs';

// 第七轮：假服务器抽到 ./sbtest-fake.ts（与 sbtest-init-r7.test.ts 共用）
const { FAKE_MG, FAKE_PJ, IMPACT, MANIFEST, SHA, fakeApi, fresh, list, mk, read, run } = F;

// CLI 用例要从 git 对象库读钉住的迁移（机器忙时单个用例 > 5s；第八轮放宽，避免环境性超时）
vi.setConfig({ testTimeout: 30_000 });

describe('ref 允许清单', () => {
  it('只有 azsou-test', () => {
    expect(() => assertRef(TEST_REF)).not.toThrow();
    expect(() => assertRef(PROD_REF)).toThrow(/生产/);
    expect(() => assertRef('aaaaaaaaaaaaaaaaaaaa')).toThrow(Refused);
    expect(() =>
      client({
        mode: 'env-token',
        token: 't',
        serviceKey: 'k',
        mgmtBase: FAKE_MG,
        projectBase: FAKE_PJ,
        ref: PROD_REF,
      }),
    ).toThrow(/生产/);
  });
});

describe('钉住 SHA + sha256', () => {
  const m = MANIFEST;
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
  it('钉住的提交不在本地 git 对象库（浅克隆）→ 拒绝并提示先 fetch', () => {
    const absent = '0'.repeat(40);
    expect(() => buildManifest(absent)).toThrow(Refused);
    expect(() => buildManifest(absent)).toThrow(/不在本地 git 对象库/);
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

describe('第六轮 ② 凭据通道：injected（默认）/ env-token（只给本机假服务器）', () => {
  it('injected 默认基址 = api.supabase.io + 测试项目主机；api.supabase.com / 生产 ref / 其他主机一律拒绝', () => {
    expect(resolveEndpoints({})).toEqual({
      mode: 'injected',
      mgmtBase: MGMT_INJECTED_BASE,
      projectBase: PROJECT_BASE,
    });
    expect(() => resolveEndpoints({ mgmtBase: 'https://api.supabase.com' })).toThrow(/生产 PAT 连接器/);
    expect(() => resolveEndpoints({ mgmtBase: 'https://evil.example' })).toThrow(/只允许/);
    expect(() => resolveEndpoints({ projectBase: `https://${PROD_REF}.supabase.co` })).toThrow(/生产/);
    expect(() => resolveEndpoints({ projectBase: 'https://other.supabase.co' })).toThrow(/只允许/);
  });
  it('env-token 只允许回环地址：拿真实令牌指向真实主机 → 拒绝', () => {
    expect(() =>
      resolveEndpoints({ mode: 'env-token', mgmtBase: MGMT_INJECTED_BASE, projectBase: FAKE_PJ }),
    ).toThrow(/回环/);
    expect(() =>
      resolveEndpoints({ mode: 'env-token', mgmtBase: 'https://api.supabase.com', projectBase: FAKE_PJ }),
    ).toThrow(/生产 PAT/);
    expect(resolveEndpoints({ mode: 'env-token', mgmtBase: FAKE_MG, projectBase: FAKE_PJ }).mgmtBase).toBe(
      FAKE_MG,
    );
  });
  it('injected 模式不接受进程内令牌；CLI 环境里有 SBTEST_MGMT_TOKEN → 拒绝', async () => {
    expect(() => client({ mode: 'injected', token: 't' })).toThrow(/不接受进程内令牌/);
    const err = console.error;
    console.error = () => {};
    const code = await main(['preflight'], { SBTEST_MGMT_TOKEN: 'x' });
    console.error = err;
    expect(code).toBe(EXIT.REFUSED);
  });
  it('injected 模式发出的请求不带 Authorization / apikey 头', async () => {
    const st = fresh();
    const api = fakeApi(st);
    // injected 只允许真实主机：用 fetchImpl 截住，不出网
    const c = client({ fetchImpl: api.fetchImpl });
    await preflight(c);
    expect(api.calls.length).toBeGreaterThan(0);
    // 第七轮：preflight 还会对项目主机做只读准入（GET /auth/v1/admin/users?per_page=1）
    expect(
      api.calls.every((x) => x.url.startsWith(MGMT_INJECTED_BASE) || x.url.startsWith(PROJECT_BASE)),
    ).toBe(true);
    expect(api.calls.some((x) => 'authorization' in x.headers || 'apikey' in x.headers)).toBe(false);
  });
  it('401 → Unauthorized 拒绝（第八轮：按正文分类，「no auth」= other，不断言没注入），不继续发后面的请求', async () => {
    const st = fresh();
    const api = fakeApi(st, { unauthorized: () => true });
    const c = client({ fetchImpl: api.fetchImpl });
    await expect(preflight(c)).rejects.toThrow(Unauthorized);
    const e1 = await preflight(
      client({ fetchImpl: fakeApi(fresh(), { unauthorized: () => true }).fetchImpl }),
    ).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(Unauthorized);
    expect(e1).not.toBeInstanceOf(NoInjection);
    expect(api.calls).toHaveLength(1);
    const st2 = fresh();
    const api2 = fakeApi(st2, { unauthorized: (u) => u.includes('/auth/v1/') });
    const c2 = client({ fetchImpl: api2.fetchImpl });
    // 管理面已注入、项目面 Auth 没注入：第七轮起在第一次写之前的项目服务准入就拒绝（不再等迁移跑完到 U1）
    // 第八轮：真实目标必须用交接文件（discard 被拒），这里给一个仓库外临时文件，确认拒绝来自准入
    const hf = path.join(mkdtempSync(path.join(os.tmpdir(), 'r6-401-')), 'h', 'a.jsonl');
    await expect(run(c2, { handoff: (XX as any).fileHandoff(hf, { attemptId: 'a1' }) })).rejects.toThrow(
      /不接受/,
    );
    expect(api2.calls.some((x) => x.url.endsWith('/database/query'))).toBe(false);
    expect(
      api2.calls.filter((x) => x.url.includes('/auth/v1/admin/users') && x.method === 'POST'),
    ).toHaveLength(0);
  });
  it('运行记录只有方法 / 路径 / 状态 / 耗时，不含令牌', async () => {
    const trace: { path: string }[] = [];
    const { c } = mk(fresh(), {}, trace);
    const pre = await preflight(c);
    const md = runRecordMarkdown({
      title: 't',
      when: 'now',
      mode: 'env-token',
      endpoints: c.endpoints,
      pre,
      trace,
      verdict: 'ok',
    });
    expect(md).not.toMatch(/SECRET|Bearer|apikey:/);
    expect(md).toMatch(/\| GET \| \/v1\/projects\/ovvfwkmqlejcpatmfqcd \| 200 \|/);
    expect(md).toMatch(/403 不能证明令牌范围/);
    expect(md).not.toContain('10.1.2.3');
  });
});

describe('第六轮 ① 权限预检：固定目标身份，不要求列项目', () => {
  it('GET /v1/projects → 403：只记录、照常继续（第八轮：403 不能证明令牌范围）', async () => {
    const { c } = mk(fresh({ listStatus: 403 }));
    const r = await verifyTarget(c);
    expect(r.scope.list_projects).toBe(403);
    expect(r.scope.verdict).toMatch(/不能证明/);
    expect(r.target.organization_id).not.toBe('org1234567890');
  });
  it('名称 / ref / 区域任何一项不符 → 拒绝；状态不是 ACTIVE_HEALTHY → 拒绝', async () => {
    for (const bad of [
      { name: 'azsou' },
      { ref: 'bbbbbbbbbbbbbbbbbbbb', id: 'bbbbbbbbbbbbbbbbbbbb' },
      { region: 'us-east-1' },
      { status: 'PAUSED' },
    ]) {
      const st = fresh();
      st.project = { ...st.project, ...bad };
      const { c } = mk(st);
      await expect(verifyTarget(c)).rejects.toThrow(Refused);
    }
  });
  it('列项目 200 且看得到生产或别的项目 → 拒绝；只看得到 azsou-test → 通过', async () => {
    await expect(
      verifyTarget(mk(fresh({ listStatus: 200, listRefs: [TEST_REF, PROD_REF] })).c),
    ).rejects.toThrow(/生产/);
    await expect(
      verifyTarget(mk(fresh({ listStatus: 200, listRefs: [TEST_REF, 'b'.repeat(20)] })).c),
    ).rejects.toThrow(/2 个项目/);
    expect((await verifyTarget(mk(fresh({ listStatus: 200 })).c)).scope.list_projects).toBe(200);
  });
  it('C0：非空 / 有 cron / 有 az_init → 预检问题，execute 拒绝且一个写请求都不发', async () => {
    // 第七轮：C0 必须完整（缺键 / null 另有用例），这里用完整对象只改要测的键
    const full = (o: Record<string, unknown>) => ({
      server_version: '17',
      ...Object.fromEntries(
        [
          'public_relations',
          'public_functions',
          'cron_jobs',
          'auth_users',
          'auth_identities',
          'auth_sessions',
          'auth_refresh_tokens',
          'storage_buckets',
          'storage_objects',
        ].map((k) => [k, 0]),
      ),
      ...Object.fromEntries(
        [
          'private_schema',
          'az_init_schema',
          'supabase_migrations_schema',
          'cron_extension',
          'cron_schema',
          'pg_net_extension',
        ].map((k) => [k, false]),
      ),
      extensions: [],
      ...o,
    });
    expect(preflightProblems(full({ auth_users: 3, public_relations: 2 }))).toHaveLength(2);
    expect(preflightProblems(full({ cron_extension: true }))).toHaveLength(1);
    const st = fresh({ publicTables: 1 });
    const { api, c } = mk(st);
    await expect(run(c)).rejects.toThrow(/预检不通过/);
    expect(api.calls.some((x) => x.url.endsWith('/database/query'))).toBe(false);
  });
});

describe('超时 / 断线后先核对是否提交，不重试', () => {
  const m = { name: '0005_m.sql', sha256: 'f'.repeat(64) };
  const sql = read('db/migrations/0005_m.sql');
  const withVerify = (ledger: number, running: number) =>
    mk(fresh(), {
      onQuery: () => {
        throw new Error('client-timeout');
      },
      onReadOnly: (q: string) => (q.includes('as v') ? { v: { ledger, running } } : undefined),
    }).c;
  it('超时但账本有行 → 已提交', async () => {
    expect((await applyOne(withVerify(1, 0), m, sql, 'r')).outcome).toBe('committed');
  });
  it('超时且账本没有行、也没在跑 → 未提交', async () => {
    expect((await applyOne(withVerify(0, 0), m, sql, 'r')).outcome).toBe('not-committed');
  });
  it('超时且会话还在跑 → still-running（不重试）', async () => {
    expect((await applyOne(withVerify(0, 1), m, sql, 'r')).outcome).toBe('still-running');
  });
  it('执行中途某个文件失败 → 停在那里（exit 1），后面的文件不发，附打码清点', async () => {
    const queries: string[] = [];
    const st = fresh();
    const { c } = mk(st, {
      onQuery: (q: string) => {
        queries.push(q);
        return q.includes('0004_m.sql') ? new Response('boom', { status: 400 }) : undefined;
      },
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.FAILED);
    expect(queries.some((q) => q.includes('0005_m.sql'))).toBe(false);
    expect(r.inventory.status).toBe('determined');
    expect(r.inventory.items.ledger.map((x: { file: string }) => x.file)).toEqual([
      '0001_m.sql',
      '0002_m.sql',
      '0003_m.sql',
    ]);
  });
  it('超时且核对不出结果 → exit 3，清点状态 unknown，不重试同一文件', async () => {
    const st = fresh();
    let sent0006 = 0;
    const { c } = mk(st, {
      onQuery: (q: string) => {
        if (q.includes('0006_m.sql')) {
          sent0006++;
          throw new Error('client-timeout');
        }
        return undefined;
      },
      onReadOnly: (q: string) => (q.includes('as v') ? new Response('gateway', { status: 504 }) : undefined),
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(sent0006).toBe(1);
    expect(r.inventory.status).toBe('unknown');
    expect(r.results.at(-1).outcome).toBe('unknown');
  });
  it('建账号超时 → exit 3（unknown），清点列出已建账号（id 打码）', async () => {
    const st = fresh();
    const { c } = mk(st, {
      onUser: (b: { email: string }) => {
        if (b.email.startsWith('sbtest-moderator')) throw new Error('client-timeout');
        return undefined;
      },
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(r.inventory.status).toBe('unknown');
    const acc = r.inventory.items.accounts;
    expect(acc).toHaveLength(1);
    expect(acc[0].id).not.toBe(st.users[0].id);
    expect(acc[0].id).toMatch(/…/);
  });
});

describe('第六轮 ③ V1 验收接入 execute：只有全部通过才 exit 0', () => {
  it('全部成功 → exit 0，7 项 V1 全过；账号经 Auth Admin API、文件经 Storage API、重新下载核对', async () => {
    const st = fresh();
    const { api, c } = mk(st);
    const r = await run(c);
    expect(r.exit).toBe(EXIT.OK);
    expect(r.v1.checks.map((x: { id: string }) => x.id)).toEqual([
      'V1.cron',
      'V1.status',
      'V1.objects',
      'V1.ledger',
      'V1.accounts',
      'V1.seed',
      'V1.storage',
    ]);
    expect(r.v1.checks.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(st.ledger).toHaveLength(20);
    expect(
      api.calls.filter((x) => x.url.includes('/auth/v1/admin/users') && x.method === 'POST'),
    ).toHaveLength(4);
    expect(
      api.calls.filter((x) => x.url.includes('/storage/v1/object/authenticated/ugc-images/')),
    ).toHaveLength(2);
    expect(api.calls.map((x) => x.body).join('\n')).not.toMatch(/insert into auth\.(users|identities)/i);
  });
  const cases: [string, (st: State) => Record<string, unknown> | void, string][] = [
    [
      'cron 被启用',
      () => {
        // 执行后才出现 cron（C0 时没有）
        let n = 0;
        return {
          onReadOnly: (q: string) =>
            q.includes('as preflight') && ++n > 1
              ? { preflight: { cron_extension: true, cron_schema: true, cron_jobs: 1 } }
              : undefined,
        };
      },
      'V1.cron',
    ],
    [
      'status.sql 有未生效项',
      () => {
        let n = 0;
        return {
          onReadOnly: (q: string) =>
            q.includes('as rows') && !q.includes('step <=') && ++n
              ? { rows: [{ step: '0019', item: 'x', ok: false }] }
              : undefined,
        };
      },
      'V1.status',
    ],
    ['影响清单里的对象缺失', (st) => void (st.missingObjects = 3), 'V1.objects'],
    [
      '账本 sha256 不符',
      (st) => ({
        onQuery: (q: string) =>
          q.includes("'0009_m.sql'")
            ? (st.ledger.push({ run_id: 'r1', file: '0009_m.sql', sha256: 'bad' }),
              Response.json([], { status: 201 }))
            : undefined,
      }),
      'V1.ledger',
    ],
    ['账号角色不对', (st) => void (st.roleOverride['sbtest-moderator@example.com'] = 'user'), 'V1.accounts'],
    ['种子行数不对', (st) => void (st.countsDelta['public.forum_threads'] = 1), 'V1.seed'],
    ['重新下载 sha256 不符', (st) => void (st.corruptDownload = true), 'V1.storage'],
  ];
  for (const [label, setup, id] of cases)
    it(`${label} → exit 1（${id} 不通过），附清点`, async () => {
      const st = fresh();
      const hooks = setup(st) ?? {};
      const { c } = mk(st, hooks);
      const r = await run(c);
      expect(r.exit).toBe(EXIT.FAILED);
      expect(r.v1.checks.find((x: { id: string }) => x.id === id).ok).toBe(false);
      expect(r.inventory).toBeDefined();
    });
});

describe('第六轮 ③ --resume：按账本续跑，不一致就拒绝', () => {
  const ledgerUpTo = (n: number, runId = 'old1') =>
    MANIFEST.migrations
      .slice(0, n)
      .map((m: { name: string; sha256: string }) => ({ run_id: runId, file: m.name, sha256: m.sha256 }));
  it('analyzeLedger：严格前缀 → 下一个位置；sha 不符 / 乱序 / 未知条目 / 多个 run_id / seed 早于迁移 → 拒绝', () => {
    expect(analyzeLedger(ledgerUpTo(7), MANIFEST)).toEqual({ runId: 'old1', next: 7, seedDone: false });
    const badSha = ledgerUpTo(3);
    badSha[2].sha256 = 'x';
    expect(() => analyzeLedger(badSha, MANIFEST)).toThrow(/sha256/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { run_id: 'old1', file: '9999_x.sql', sha256: 'y' }], MANIFEST),
    ).toThrow(/未知/);
    expect(() => analyzeLedger([ledgerUpTo(2)[1]], MANIFEST)).toThrow(/未知/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { ...ledgerUpTo(3)[2], run_id: 'other' }], MANIFEST),
    ).toThrow(/多个 run_id/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { run_id: 'old1', file: 'seed', sha256: 'z' }], MANIFEST),
    ).toThrow(/矛盾/);
    expect(() => analyzeLedger(null, MANIFEST)).toThrow(/没有 az_init/);
  });
  it('账本到 0007 → 从 0008 续跑（沿用原 run_id），完成后 V1 全过', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(7) });
    const queries: string[] = [];
    const { c } = mk(st, { onQuery: (q: string) => void queries.push(q) });
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    expect(r.runId).toBe('old1');
    expect(queries.some((q) => q.includes('0007_m.sql'))).toBe(false);
    expect(queries.some((q) => q.includes('0008_m.sql'))).toBe(true);
    expect(queries.some((q) => q.includes('create schema if not exists az_init'))).toBe(false);
  });
  it('种子未提交但已有部分合成账号且没有本次运行标记 → 拒绝接管（第七轮：带标记的会被接管，见 r7），不发写请求', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: [{ email: 'sbtest-admin@example.com', id: crypto.randomUUID(), key: 'admin' }],
    });
    const { api, c } = mk(st);
    await expect(run(c, { resume: true })).rejects.toThrow(/不能接管/);
    expect(
      api.calls.some(
        (x) => x.url.endsWith('/database/query') || (x.url.includes('/admin/users') && x.method !== 'GET'),
      ),
    ).toBe(false);
  });
  it('种子已提交、文件缺 1 个 → 只补传缺的那个，再 V1', async () => {
    const st = fresh();
    const { c } = mk(st);
    // 先完整跑一遍得到真实状态，再删掉一个对象模拟「F1 中途断」
    expect((await run(c)).exit).toBe(EXIT.OK);
    st.objects.pop();
    const { api, c: c2 } = mk(st);
    const r = await run(c2, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    expect(
      api.calls.filter((x) => x.method === 'POST' && x.url.includes('/storage/v1/object/ugc-images/')),
    ).toHaveLength(1);
    expect(api.calls.some((x) => x.url.includes('/admin/users') && x.method !== 'GET')).toBe(false);
  });
  it('已存在的对象内容不符 → 拒绝（不覆盖）', async () => {
    const st = fresh();
    expect((await run(mk(st).c)).exit).toBe(EXIT.OK);
    st.objects[0].body = Buffer.from('tampered');
    const { api, c } = mk(st);
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.REFUSED);
    expect(r.refused).toMatch(/内容不符/);
    expect(
      api.calls.some((x) => x.method === 'POST' && x.url.includes('/storage/v1/object/ugc-images/')),
    ).toBe(false);
  });
  it('还有 az-init 会话在跑 → 拒绝；没有账本 → 拒绝；全新执行遇到已有 az_init → 拒绝并提示 --resume', async () => {
    await expect(
      run(mk(fresh({ azInit: true, ledger: ledgerUpTo(3), running: 1 })).c, { resume: true }),
    ).rejects.toThrow(/会话在运行/);
    await expect(run(mk(fresh()).c, { resume: true })).rejects.toThrow(/az_init 不存在/);
    await expect(run(mk(fresh({ azInit: true, ledger: ledgerUpTo(3) })).c)).rejects.toThrow(/--resume/);
  });
});

describe('第六轮 ③ 测试账号凭据：密码由执行器生成，不进日志 / 运行记录 / 清点', () => {
  it('默认 discard：密码只出现在 Admin API 请求体里；handoff 通道拿到 4 个各不相同的密码', async () => {
    const st = fresh();
    const logs: string[] = [];
    const trace: unknown[] = [];
    const got: Record<string, string> = {};
    const { api, c } = mk(st, {}, trace);
    const r = await execute({
      sha: SHA,
      manifest: MANIFEST,
      impact: IMPACT,
      c,
      runId: 'r1',
      read,
      log: (s: string) => logs.push(s),
      handoff: { write: (e: string, p: string) => void (got[e] = p) },
    });
    expect(r.exit).toBe(EXIT.OK);
    const pw = api.calls
      .filter((x) => x.url.includes('/admin/users') && x.method === 'POST')
      .map((x) => JSON.parse(x.body).password);
    expect(new Set(pw).size).toBe(4);
    expect(Object.values(got).sort()).toEqual([...pw].sort());
    const blob = JSON.stringify({ logs, trace, r });
    for (const p of pw) expect(blob).not.toContain(p);
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
  it('syntheticFiles 两个对象 sha256 不同', () => {
    const f = syntheticFiles();
    expect(f[0].sha256).not.toBe(f[1].sha256);
  });
});
