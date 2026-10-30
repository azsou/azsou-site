#!/usr/bin/env node
/**
 * azsou-test 初始化影响清单（本机生成，**不连任何真实项目**）——站长 2026-10-28 第五轮 ⑤。
 * 在本机 Postgres 上建一个**本次新建**的临时库（OID + 库注释标记；结束只删它自己），按钉住 SHA 从 git 对象库取
 * db/shim/plain.sql 与 0001–0019 依次执行，对比执行前后的系统目录，得到迁移新建的每个对象；再用本机 auth.users 行模拟
 * Auth Admin API 建的 4 个合成账号，执行执行器的内容种子 SQL（同时验证它能跑通），统计每张表的行数变化（含触发器产生的行）。
 * 输出 ops/sbtest/init-impact.json（执行器 plan --out 据此生成 impact.md）。
 *
 * 用法：DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres node scripts/sbtest/impact-local.mjs [--source-sha <40 位>]
 * 只接受本机库。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, SYNTHETIC_USERS, contentSeedSql, gitShow, verifyPinned } from './init-executor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error('需要 DATABASE_URL（本机超级用户）');
const host = new URL(ADMIN).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`只允许本机库：${host}`);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const i = process.argv.indexOf('--source-sha');
const sha = i > 0 ? process.argv[i + 1] : manifest.source_sha;
verifyPinned(manifest, sha);

const psql = (url, args, input) =>
  execFileSync('psql', [url, '-XAtq', '-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
const dbUrl = (name) => {
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return u.toString();
};
const runId = `impact-${randomBytes(4).toString('hex')}`;
const DB = `azsou_impact_${randomBytes(4).toString('hex')}`;
if (psql(ADMIN, ['-c', `select count(*) from pg_database where datname = '${DB}'`]).trim() !== '0')
  throw new Error(`${DB} 已存在`);
psql(ADMIN, ['-c', `create database ${DB}`]);
const OID = psql(ADMIN, ['-c', `select oid from pg_database where datname = '${DB}'`]).trim();
psql(ADMIN, ['-c', `comment on database ${DB} is 'azsou-run:${runId}'`]);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'az-impact-'));
const dropOwned = () => {
  const row = psql(ADMIN, [
    '-F',
    '\t',
    '-c',
    `select oid, coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '${DB}'`,
  ]).trim();
  if (row === `${OID}\tazsou-run:${runId}`) psql(ADMIN, ['-c', `drop database ${DB} with (force)`]);
  else if (row) console.error(`不删 ${DB}：OID / 标记与本次不符（${row}）`);
  rmSync(tmp, { recursive: true, force: true });
};

const CATALOG = `
with ns as (select oid, nspname from pg_namespace where nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%')
select kind || E'\\t' || schema || E'\\t' || name from (
  select case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'materialized view'
              when 'S' then 'sequence' when 'i' then 'index' when 'I' then 'index' when 'f' then 'foreign table' end kind,
         ns.nspname schema, c.relname::text name
    from pg_class c join ns on ns.oid = c.relnamespace where c.relkind in ('r','p','v','m','S','i','I','f')
  union all select 'function', ns.nspname, p.oid::regprocedure::text from pg_proc p join ns on ns.oid = p.pronamespace
  union all select 'trigger', ns.nspname, c.relname || '.' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join ns on ns.oid = c.relnamespace where not t.tgisinternal
  union all select 'policy', schemaname, tablename || '.' || policyname from pg_policies
  union all select 'type', ns.nspname, t.typname::text from pg_type t join ns on ns.oid = t.typnamespace where t.typtype in ('e', 'd') or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c')
  union all select 'extension', '-', extname::text from pg_extension
  union all select 'schema', nspname, nspname from ns
  union all select 'role', '-', rolname::text from pg_roles where rolname !~ '^pg_'
) x where kind is not null order by 1`;
const snapshot = (url) => new Set(psql(url, ['-c', CATALOG]).split('\n').filter(Boolean));
const COUNTS = `select table_schema || '.' || table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public', 'private', 'storage', 'auth') order by 1`;
const counts = (url) => {
  const out = {};
  for (const t of psql(url, ['-c', COUNTS]).split('\n').filter(Boolean)) {
    const [s, n] = t.split('.');
    out[t] = Number(psql(url, ['-c', `select count(*) from "${s}"."${n}"`]).trim());
  }
  return out;
};
const REVERSIBLE = {
  table: 'drop table（含数据）',
  view: 'drop view',
  'materialized view': 'drop materialized view',
  sequence: 'drop sequence（随表）',
  index: 'drop index（随表）',
  function: 'drop function',
  trigger: 'drop trigger（auth.users 上的 on_auth_user_created 属平台 schema，回退需同时删）',
  policy: 'drop policy',
  type: 'drop type',
  extension: 'drop extension（pgcrypto / pg_trgm，平台自带可保留）',
  schema: 'drop schema … cascade',
  role: 'drop role（Supabase 平台角色已存在，不新建）',
};

try {
  const url = dbUrl(DB);
  const run = (rel, buf) => {
    const f = path.join(tmp, path.basename(rel));
    writeFileSync(f, buf ?? gitShow(sha, rel));
    psql(url, ['-c', 'set client_min_messages = warning', '-f', f]);
  };
  run('db/shim/plain.sql');
  const before = snapshot(url);
  for (const m of manifest.migrations) run(`db/migrations/${m.name}`);
  const after = snapshot(url);
  const rowsAfterMigrations = counts(url);
  const added = [...after].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !after.has(x));
  const groups = new Map();
  for (const x of added) {
    const [kind, schema, name] = x.split('\t');
    const k = `${kind}\t${schema}`;
    if (!groups.has(k))
      groups.set(k, { kind, schema, names: [], reversible: REVERSIBLE[kind] ?? '手工删除' });
    groups.get(k).names.push(name);
  }
  // 模拟 Auth Admin API 建的账号（本机才这样直接写 auth.users；执行器在 azsou-test 上只走 Admin API）
  const ids = {};
  for (const u of SYNTHETIC_USERS) {
    ids[u.key] = randomUUID();
    psql(url, [
      '-c',
      `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ('${ids[u.key]}', '${u.email}', '{"name":"${u.name}"}', now())`,
    ]);
  }
  psql(url, [
    '-c',
    'create schema az_init; create table az_init.applied (run_id text, file text primary key, sha256 text, applied_at timestamptz default now())',
  ]);
  const rowsAfterUsers = counts(url);
  psql(url, ['-f', '-'], contentSeedSql(ids, runId));
  const rowsAfterSeed = counts(url);
  const delta = (a, b) =>
    Object.entries(b)
      .map(([t, n]) => ({ table: t, rows: n - (a[t] ?? 0) }))
      .filter((r) => r.rows !== 0);
  const impact = {
    format: 1,
    source_sha: sha,
    local: {
      server_version: psql(url, ['-c', 'show server_version']).trim(),
      generated_at: new Date().toISOString(),
      note: '本机 Postgres + db/shim/plain.sql 模拟 Supabase 平台对象；托管项目上平台自带的 auth / storage / 扩展不计入「新建」',
    },
    objects: [...groups.values()].sort((a, b) => (a.kind + a.schema).localeCompare(b.kind + b.schema)),
    objects_total: added.length,
    objects_removed_by_migrations: removed,
    migration_rows: Object.entries(rowsAfterMigrations)
      .filter(([, n]) => n > 0)
      .map(([table, rows]) => ({ table, rows, reversible: 'delete / 随表 drop' })),
    users_rows: delta(rowsAfterMigrations, rowsAfterUsers),
    seed_rows: delta(rowsAfterUsers, rowsAfterSeed),
  };
  writeFileSync(path.join(ROOT, 'ops/sbtest/init-impact.json'), JSON.stringify(impact, null, 2) + '\n');
  console.log(
    `影响清单：迁移新建 ${added.length} 个对象（${groups.size} 组），迁移写入行 ${impact.migration_rows.length} 张表；种子 SQL 在本机跑通（${impact.seed_rows.length} 张表有新增行）`,
  );
} finally {
  dropOwned();
}
