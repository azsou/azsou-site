/**
 * azsou-test 初始化执行器——第九轮（站长 2026-10-29 round 9）回归：先在当前代码上写失败用例（走真实调用路径 execute → acceptV1），
 * 记录失败，再修。
 *  V1.cron 严格：以前 `!p.cron_extension && !p.cron_schema && Number(p.cron_jobs) === 0` 会把缺字段、null 标志、null 计数、
 *  字符串 "0"、[0] 等当成「没有 cron」放行。现在复用 C0 的类型校验（标志必须是布尔值、计数必须是有限非负整数），
 *  形状不对 → 不确定（exit 3，不是通过）；类型正确时才要求 false / false / 0；明确的 true 或 >0 → 不通过（不是不确定）。
 *  V1 在初始化之后运行，**不**套用初始化前的「空库」要求（业务表 / 账号 / 对象非 0 照常通过）。
 */
import { describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import { answer, fresh, mk, run, type State } from './sbtest-fake';

const E = X as any;
const { EXIT } = E;

/** 只改 V1 那一次 C0 查询（初始化前的 preflight 不受影响：那时 az_init 还不存在） */
const v1Cron =
  (st: State, patch: (p: Record<string, unknown>) => unknown, raw = false) =>
  (q: string) => {
    if (!q.includes('as preflight') || !st.azInit) return undefined;
    const base = { ...(answer(st, q).preflight as Record<string, unknown>) };
    const p = patch(base) ?? base;
    if (!raw) return { preflight: p };
    // NaN / Infinity 不能经 JSON 传输：直接让 Response.json() 交出这个值（仍走 ro → parseOneRow → acceptV1 的真实路径）
    const r = Response.json([{ preflight: null }], { status: 201 });
    Object.defineProperty(r, 'json', { value: async () => [{ preflight: p }] });
    return r;
  };

const runV1 = async (patch: (p: Record<string, unknown>) => unknown, raw = false) => {
  const st = fresh();
  const { c } = mk(st, { onReadOnly: v1Cron(st, patch, raw) });
  const r = await run(c);
  const chk = r.v1?.checks?.find((x: { id: string }) => x.id === 'V1.cron');
  return { r, chk };
};
const del = (k: string) => (p: Record<string, unknown>) => {
  delete p[k];
};
const set = (k: string, v: unknown) => (p: Record<string, unknown>) => {
  p[k] = v;
};

describe('第九轮 V1.cron 严格类型校验（形状不对 → 不确定，不是通过）', () => {
  const malformed: [string, (p: Record<string, unknown>) => unknown, boolean?][] = [
    ['缺 cron_extension', del('cron_extension')],
    ['缺 cron_schema', del('cron_schema')],
    ['缺 cron_jobs', del('cron_jobs')],
    ['cron_extension = null', set('cron_extension', null)],
    ['cron_schema = null', set('cron_schema', null)],
    ['cron_jobs = null', set('cron_jobs', null)],
    ['cron_jobs = "0"（字符串）', set('cron_jobs', '0')],
    ['cron_jobs = NaN', set('cron_jobs', NaN), true],
    ['cron_jobs = Infinity', set('cron_jobs', Infinity), true],
    ['cron_jobs = -1', set('cron_jobs', -1)],
    ['cron_jobs = 0.5', set('cron_jobs', 0.5)],
    ['cron_jobs = [0]（数组）', set('cron_jobs', [0])],
    ['cron_jobs = {}', set('cron_jobs', {})],
    ['cron_jobs = false', set('cron_jobs', false)],
    ['cron_extension = "false"（字符串）', set('cron_extension', 'false')],
    ['cron_extension = 0', set('cron_extension', 0)],
    ['cron_schema = []', set('cron_schema', [])],
    ['cron_extension = {}', set('cron_extension', {})],
    ['C0 结果是数组', (p) => [p]],
    ['C0 结果是 {}', () => ({})],
  ];
  for (const [label, patch, raw] of malformed)
    it(`execute → V1 收到 ${label} → V1.cron 不通过且标记不确定，整次 exit 3`, async () => {
      const { r, chk } = await runV1(patch, raw);
      expect(chk.ok).toBe(false);
      expect(chk.detail?.uncertain).toBe(true);
      expect(r.exit).toBe(EXIT.UNKNOWN);
    });
});

describe('第九轮 V1.cron 合法对照', () => {
  it('false / false / 0 → 通过（整次 exit 0）', async () => {
    const { r, chk } = await runV1(() => undefined);
    expect(chk.ok).toBe(true);
    expect(r.exit).toBe(EXIT.OK);
  });
  it('初始化之后的非空库（业务表 / 账号 / 对象 / 迁移 schema 非 0）不影响 V1.cron：仍通过', async () => {
    const { r, chk } = await runV1((p) => {
      Object.assign(p, {
        public_relations: 57,
        public_functions: 120,
        private_schema: true,
        az_init_schema: true,
        auth_users: 4,
        auth_identities: 4,
        storage_buckets: 1,
        storage_objects: 2,
      });
    });
    expect(chk.ok).toBe(true);
    expect(r.exit).toBe(EXIT.OK);
  });
  it('多出无关字段 → 不影响（通过）', async () => {
    const { r, chk } = await runV1(set('extra_field', 'x'));
    expect(chk.ok).toBe(true);
    expect(r.exit).toBe(EXIT.OK);
  });
  for (const [label, patch] of [
    ['cron_extension = true', set('cron_extension', true)],
    ['cron_schema = true', set('cron_schema', true)],
    ['cron_jobs = 2', set('cron_jobs', 2)],
    [
      'cron_extension = true 且 cron_jobs = null（明确的 true 已足以判定不通过）',
      (p: Record<string, unknown>) => Object.assign(p, { cron_extension: true, cron_jobs: null }),
    ],
  ] as [string, (p: Record<string, unknown>) => unknown][])
    it(`${label} → V1.cron 明确不通过（不是不确定），整次 exit 1`, async () => {
      const { r, chk } = await runV1(patch);
      expect(chk.ok).toBe(false);
      expect(chk.detail?.uncertain).not.toBe(true);
      expect(r.exit).toBe(EXIT.FAILED);
    });
});

describe('第九轮 V1.cron 共享校验函数', () => {
  it('cronShapeProblems：只看 3 个 cron 字段，复用 C0 的布尔判断，计数要求有限非负整数（number）', () => {
    expect(E.cronShapeProblems({ cron_extension: false, cron_schema: false, cron_jobs: 0 })).toEqual([]);
    expect(E.cronShapeProblems({ cron_extension: false, cron_schema: false, cron_jobs: '0' }).length).toBe(1);
    expect(E.cronShapeProblems({}).length).toBe(3);
    expect(E.cronShapeProblems(null).length).toBe(1);
  });
});
