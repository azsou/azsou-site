/**
 * 数据库测试工具：在本地 / CI 的 Postgres 上建临时库、跑 shim + 迁移、按角色执行 SQL。
 * 连接串：DATABASE_URL（需要超级用户，用来建库与模拟 Supabase 角色）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export const SHIM = join(ROOT, 'db/shim/plain.sql');
export const MIGRATIONS_DIR = join(ROOT, 'db/migrations');
export const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));

export function dbUrl(name: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

/** 新建一个空库并依次执行给定 SQL 文件；返回库名 */
export async function createDatabase(name: string, files: string[]): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // pool.end() 返回时刚关闭的连接可能还在断开中；先等它们真正断开（最多约 2.5s），再强制删库。
    // 否则 with (force) 会终止这些连接，已脱离连接池的客户端没有错误监听，抛出 57P01 未处理错误（CI db 偶发）。
    for (let i = 0; i < 50; i++) {
      const r = await admin.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [name],
      );
      if (!r.rows[0].n) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const c = new pg.Client({ connectionString: dbUrl(name) });
  await c.connect();
  try {
    await c.query('set client_min_messages = warning');
    for (const f of files) {
      try {
        await c.query(readFileSync(f, 'utf8'));
      } catch (e) {
        throw new Error(`执行 ${f} 失败：${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await c.end();
  }
  return name;
}

export async function dropDatabase(name: string) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}

export type Who = { role: 'anon' } | { role: 'authenticated'; uid: string } | { role: 'superuser' };

export type Outcome =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; code: string; message: string };

/**
 * 以某个 API 角色执行一条语句（与 PostgREST 完全一样：事务内 SET LOCAL ROLE + request.jwt.claims），
 * 执行完回滚，所以夹具数据保持不变。
 */
export async function run(
  pool: pg.Pool,
  who: Who,
  sql: string,
  params: unknown[] = [],
  opts: { commit?: boolean; before?: string[] } = {},
): Promise<Outcome> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (who.role !== 'superuser') {
      const claims = who.role === 'anon' ? { role: 'anon' } : { sub: who.uid, role: 'authenticated' };
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await c.query(`set local role ${who.role}`);
    }
    for (const b of opts.before ?? []) await c.query(b);
    try {
      const r = await c.query(sql, params);
      await c.query(opts.commit ? 'commit' : 'rollback');
      return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows };
    } catch (e) {
      await c.query('rollback');
      const err = e as { code?: string; message: string };
      return { ok: false, code: err.code ?? '?', message: err.message };
    }
  } finally {
    c.release();
  }
}

/** 在同一个事务里按顺序执行多条语句（限流测试用），返回每条的结果；最后回滚 */
export async function runSeq(
  pool: pg.Pool,
  who: Who,
  statements: [string, unknown[]?][],
): Promise<Outcome[]> {
  const c = await pool.connect();
  const out: Outcome[] = [];
  try {
    await c.query('begin');
    if (who.role !== 'superuser') {
      const claims = who.role === 'anon' ? { role: 'anon' } : { sub: who.uid, role: 'authenticated' };
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await c.query(`set local role ${who.role}`);
    }
    for (const [sql, params] of statements) {
      await c.query('savepoint s');
      try {
        const r = await c.query(sql, params ?? []);
        out.push({ ok: true, rowCount: r.rowCount ?? 0, rows: r.rows });
        await c.query('release savepoint s');
      } catch (e) {
        await c.query('rollback to savepoint s');
        const err = e as { code?: string; message: string };
        out.push({ ok: false, code: err.code ?? '?', message: err.message });
      }
    }
    await c.query('rollback');
  } finally {
    c.release();
  }
  return out;
}

/** allow = 语句成功且影响 ≥1 行；deny = 权限 / RLS 拒绝，或 RLS 过滤后 0 行 */
export function verdict(o: Outcome): 'allow' | 'deny' | `error:${string}` {
  if (o.ok) return o.rowCount > 0 ? 'allow' : 'deny';
  // 42501 insufficient_privilege（列权限、RLS with check、触发器 az_forbid）
  if (o.code === '42501') return 'deny';
  return `error:${o.code} ${o.message}`;
}
