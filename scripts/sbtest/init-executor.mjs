#!/usr/bin/env node
/**
 * azsou-test（隔离 Supabase 测试项目，ref ovvfwkmqlejcpatmfqcd）初始化执行器——站长 2026-10-28 第五轮 ⑤。
 * **默认 dry-run**：不发任何网络请求，只核对钉住的源 SHA 与迁移文件 sha256、打印执行计划与影响清单。
 * 真正执行（--execute）另需站长批准；本仓库任何 CI / 测试都不会对真实项目执行。说明见 ops/SBTEST-INIT.md。
 *
 * 通道：Supabase Management API（不是 Postgres 协议，所以**不是** pg_dump / 恢复通道——恢复通道仍未决定）。
 *   写：POST https://api.supabase.com/v1/projects/{ref}/database/query            body { query }
 *   读：POST https://api.supabase.com/v1/projects/{ref}/database/query/read-only  body { query }（预检、执行后核对）
 *   令牌：SBTEST_MGMT_TOKEN = **只授权 azsou-test** 的细粒度令牌（database_read / database_write）；
 *         预检 GET /v1/projects 必须只看得到 azsou-test，看得到任何别的项目（尤其生产）→ 拒绝。
 *   托管账号：Auth Admin API POST https://<ref>.supabase.co/auth/v1/admin/users（email_confirm: true，不发邮件）——
 *         不直接写 auth.users / auth.identities，不伪造 OAuth 身份（OAuth 真实登录只能由 I01 人工证据证明）。
 *   文件：Storage API POST https://<ref>.supabase.co/storage/v1/object/ugc-images/<路径>（x-upsert: false）。
 *   SBTEST_SERVICE_KEY = azsou-test 的 service_role / secret key（只在请求头里，不打印、不落盘）。
 *
 * 子命令：
 *   plan     [--source-sha <40 位>] [--out <目录>]     dry-run（默认）：钉 SHA + 校验 + 计划 + 影响清单，零网络
 *   manifest --source-sha <40 位> [--write]           从 git 对象库读 <SHA> 的 0001–0019 计算 sha256（--write 写 ops/sbtest/init-manifest.json）
 *   execute  --source-sha <40 位> --confirm-ref ovvfwkmqlejcpatmfqcd   需要 SBTEST_MGMT_TOKEN、SBTEST_SERVICE_KEY、SBTEST_OWNER_APPROVAL
 * 退出码：0 成功（dry-run = 计划有效）；1 执行失败（已停在失败的文件，之前的文件已提交且有记录）；2 用法 / 拒绝（ref、令牌范围、钉住校验）；
 *         3 结果不确定（超时后无法判断是否提交——不重试，交人工核对）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_REF = 'ovvfwkmqlejcpatmfqcd';
export const PROD_REF = 'abryflgoljltyakthtql';
export const MGMT = 'https://api.supabase.com';
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, UNKNOWN: 3 });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_PATH = path.join(ROOT, 'ops/sbtest/init-manifest.json');
export const MIGRATIONS = Object.freeze(Array.from({ length: 19 }, (_, i) => String(i + 1).padStart(4, '0')));
/** 每个迁移文件的语句超时；HTTP 客户端超时比它多 30 秒，超时后一律先核对是否已提交 */
export const STATEMENT_TIMEOUT_S = 300;
export const LOCK_TIMEOUT_S = 15;

export class Refused extends Error {}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** ref 允许清单：只有 azsou-test */
export function assertRef(ref) {
  if (ref === PROD_REF) throw new Refused(`拒绝：${ref} 是生产项目`);
  if (ref !== TEST_REF)
    throw new Refused(`拒绝：ref ${ref} 不是 azsou-test（${TEST_REF}）——执行器只对 azsou-test 生效`);
}

/** 从 git 对象库读钉住 SHA 下的文件（不读工作区，工作区被改过也不影响） */
export function gitShow(sha, rel, cwd = ROOT) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refused(`源 SHA 必须是完整 40 位：${sha}`);
  return execFileSync('git', ['show', `${sha}:${rel}`], { cwd, maxBuffer: 64 << 20 });
}
export function gitLs(sha, dir, cwd = ROOT) {
  return execFileSync('git', ['ls-tree', '--name-only', `${sha}`, `${dir}/`], { cwd, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => path.basename(p));
}

/** 按钉住 SHA 计算清单：0001–0019 每个文件的 sha256（文件名必须恰好是这 19 个编号，多一个少一个都拒绝） */
export function buildManifest(
  sha,
  read = (rel) => gitShow(sha, rel),
  list = () => gitLs(sha, 'db/migrations'),
) {
  const names = list()
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const nums = names.map((n) => n.slice(0, 4));
  if (JSON.stringify(nums) !== JSON.stringify(MIGRATIONS))
    throw new Refused(`源 SHA ${sha} 的 db/migrations 不是恰好 0001–0019：${nums.join(',')}`);
  const files = names.map((name) => {
    const buf = read(`db/migrations/${name}`);
    return { name, sha256: sha256(buf), bytes: buf.length };
  });
  const status = read('db/verify/status.sql');
  return {
    format: 1,
    project_ref: TEST_REF,
    source_sha: sha,
    migrations: files,
    status_sql_sha256: sha256(status),
  };
}

/** 校验：钉住 SHA 下的内容 = 仓库里提交的清单（哈希、大小、顺序、status.sql） */
export function verifyPinned(
  manifest,
  sha,
  read = (rel) => gitShow(sha, rel),
  list = () => gitLs(sha, 'db/migrations'),
) {
  if (manifest.project_ref !== TEST_REF) throw new Refused('清单的 project_ref 不是 azsou-test');
  if (manifest.source_sha !== sha)
    throw new Refused(`清单钉住的源 SHA 是 ${manifest.source_sha}，不是 ${sha}`);
  const got = buildManifest(sha, read, list);
  const bad = [];
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const a = manifest.migrations[i];
    const b = got.migrations[i];
    if (!a || a.name !== b.name || a.sha256 !== b.sha256 || a.bytes !== b.bytes) bad.push(b.name);
  }
  if (manifest.migrations.length !== MIGRATIONS.length) bad.push('文件数');
  if (manifest.status_sql_sha256 !== got.status_sql_sha256) bad.push('db/verify/status.sql');
  if (bad.length) throw new Refused(`钉住校验失败（与清单不符）：${bad.join('、')}`);
  return got;
}

/**
 * 每个迁移文件 = 一个事务。文件本身以 `begin;` 开头、`commit;` 结尾（各恰好一次）；执行器去掉这两行，换成自己的事务外壳：
 *   begin; set local statement_timeout / lock_timeout; <文件正文>; insert into az_init.applied（运行 id、文件、sha256）; commit;
 * 账本行与迁移在同一事务里：超时 / 断线后查账本就能确定「提交了还是没提交」。
 */
export function wrapMigration(sql, { name, sha, runId }) {
  const text = sql.toString('utf8');
  const lines = text.split('\n');
  const isStmt = (l) => !/^\s*(--.*)?$/.test(l);
  const first = lines.findIndex(isStmt);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (isStmt(lines[i])) {
      last = i;
      break;
    }
  const count = lines.filter((l) => /^\s*(begin|commit)\s*;\s*$/i.test(l)).length;
  if (
    first < 0 ||
    !/^\s*begin\s*;\s*$/i.test(lines[first]) ||
    !/^\s*commit\s*;\s*$/i.test(lines[last]) ||
    count !== 2
  )
    throw new Refused(
      `${name}：必须以单独一行 begin; 开头、commit; 结尾且各只有一次，执行器才能把它包进单个事务`,
    );
  const body = lines.slice(first + 1, last).join('\n');
  const tag = `az-init:${runId}:${name}`;
  return [
    `/* ${tag} */`,
    'begin;',
    `set local statement_timeout = '${STATEMENT_TIMEOUT_S}s';`,
    `set local lock_timeout = '${LOCK_TIMEOUT_S}s';`,
    `set local application_name = '${tag}';`,
    body,
    `insert into az_init.applied (run_id, file, sha256) values ('${runId}', '${name}', '${sha}');`,
    'commit;',
  ].join('\n');
}

export const BOOTSTRAP_SQL = `begin;
create schema if not exists az_init;
comment on schema az_init is 'azsou-test 初始化执行器账本（scripts/sbtest/init-executor.mjs）；可整体 drop schema az_init cascade';
create table if not exists az_init.applied (
  run_id text not null, file text not null, sha256 text not null, applied_at timestamptz not null default now(),
  primary key (file)
);
revoke all on schema az_init from public, anon, authenticated;
-- 只读端点以 supabase_read_only_user 执行：超时后的「提交了没有」核对要能读账本
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    grant usage on schema az_init to supabase_read_only_user;
    grant select on az_init.applied to supabase_read_only_user;
  end if;
end $$;
commit;`;

/** 预检（只读）：项目必须是空的——任何一项不满足都停，不清空、不覆盖 */
export const PREFLIGHT_SQL = `select json_build_object(
  'server_version', current_setting('server_version'),
  'public_relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')),
  'public_functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
  'private_schema', to_regnamespace('private') is not null,
  'az_init_schema', to_regnamespace('az_init') is not null,
  'auth_users', (select count(*) from auth.users),
  'storage_buckets', (select count(*) from storage.buckets),
  'storage_objects', (select count(*) from storage.objects),
  'cron_extension', exists (select 1 from pg_extension where extname = 'pg_cron'),
  'extensions', (select json_agg(extname order by extname) from pg_extension)
) as preflight`;

export function preflightProblems(p) {
  const bad = [];
  if (Number(String(p.server_version).split('.')[0]) < 15) bad.push(`Postgres ${p.server_version} < 15`);
  for (const k of [
    'public_relations',
    'public_functions',
    'auth_users',
    'storage_buckets',
    'storage_objects',
  ])
    if (Number(p[k]) !== 0) bad.push(`${k} = ${p[k]}（必须为 0）`);
  if (p.private_schema) bad.push('private schema 已存在');
  if (p.az_init_schema) bad.push('az_init schema 已存在（之前跑过？不重跑，人工核对）');
  return bad;
}

/** 合成账号（全部 @example.com，经 Auth Admin API 建；随机密码只在本次运行内存里） */
export const SYNTHETIC_USERS = Object.freeze([
  { key: 'admin', email: 'sbtest-admin@example.com', name: '测试管理员', role: 'admin' },
  { key: 'moderator', email: 'sbtest-moderator@example.com', name: '测试版主', role: 'moderator' },
  { key: 'user', email: 'sbtest-user@example.com', name: '测试用户', role: 'user' },
  { key: 'banned', email: 'sbtest-banned@example.com', name: '被限制用户', role: 'user', banned: true },
]);
/** 合成文件：1×1 PNG（b 末尾多 6 字节，sha256 不同），经 Storage API 上传到 ugc-images/<测试用户 id>/ */
export function syntheticFiles() {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4580000000049454e44ae426082',
    'hex',
  );
  return [
    { name: '202610-sbtest-a-1x1.png', body: png },
    { name: '202610-sbtest-b-1x1.png', body: Buffer.concat([png, Buffer.from('sbtest')]) },
  ].map((f) => ({ ...f, sha256: sha256(f.body), bytes: f.body.length }));
}
/** 内容种子（引用 Auth Admin API 返回的真实用户 id；单事务） */
export function contentSeedSql(ids, runId) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `/* az-init:${runId}:seed */
begin;
set local statement_timeout = '${STATEMENT_TIMEOUT_S}s';
update public.profiles set role = 'admin' where id = ${q(ids.admin)};
update public.profiles set role = 'moderator' where id = ${q(ids.moderator)};
update public.profiles set banned = true where id = ${q(ids.banned)};
insert into public.forum_threads (cat, title, body, author, pinned) values
  ('技术交流', '测试项目主题', '合成数据（azsou-test）', ${q(ids.user)}, false),
  ('公告', '测试项目公告', '合成数据（azsou-test）', ${q(ids.admin)}, true);
insert into public.forum_replies (thread_id, body, author)
  select id, '合成回复 @测试用户', ${q(ids.admin)} from public.forum_threads where title = '测试项目主题';
insert into public.comments (page_key, body, author) values ('article:pinyin-initial-search', '合成评论', ${q(ids.user)});
insert into public.reports (reporter, target_type, target_id, reason, detail)
  select ${q(ids.user)}, 'thread', id, 'spam', '合成举报' from public.forum_threads where title = '测试项目公告';
insert into public.user_bans (user_id, reason, expires_at, created_by) values (${q(ids.banned)}, '合成封禁', now() + interval '7 days', ${q(ids.admin)});
insert into public.guestbook_entries (nickname, body, status) values ('测试访客', '合成留言（待审）', 'pending'), ('测试访客二', '合成留言（已通过）', 'approved');
insert into public.friend_links (name, url, description, status) values ('合成友链', 'https://example.com/', '合成数据', 'pending');
insert into public.subscribers (email, lang, status, unsubscribe_hash)
  values ('sbtest-sub@example.com', 'zh', 'pending', encode(sha256(convert_to('sbtest-unsub-${runId}', 'UTF8')), 'hex'));
insert into az_init.applied (run_id, file, sha256) values ('${runId}', 'seed', 'n/a');
commit;`;
}

/** 执行计划（dry-run 输出；execute 按同一顺序） */
export function plan(manifest, runId = 'dry-run') {
  const steps = [
    {
      step: 'P0',
      what: '令牌范围：GET /v1/projects 只看得到 azsou-test（看得到生产 / 别的项目 → 拒绝）',
      channel: 'Management API（只读）',
    },
    {
      step: 'P1',
      what: '预检（只读端点）：空项目、Postgres 版本、pg_cron 未启用、无 az_init',
      channel: 'POST /database/query/read-only',
    },
    { step: 'B0', what: '建账本 schema az_init.applied（单事务）', channel: 'POST /database/query' },
  ];
  for (const m of manifest.migrations)
    steps.push({
      step: m.name.slice(0, 4),
      what: `${m.name}（sha256 ${m.sha256.slice(0, 12)}…，${m.bytes} B）单事务 + statement_timeout ${STATEMENT_TIMEOUT_S}s + 账本行；之后 status.sql 该步及之前全 true`,
      channel: 'POST /database/query；核对走 read-only',
    });
  steps.push(
    {
      step: 'C0',
      what: '确认没有任何调度任务：pg_cron 未启用或 cron.job = 0；不执行 db/ops/',
      channel: 'read-only',
    },
    {
      step: 'U1',
      what: `合成账号 ×${SYNTHETIC_USERS.length}（${SYNTHETIC_USERS.map((u) => `${u.email}/${u.role}${u.banned ? '/banned' : ''}`).join('、')}）`,
      channel: 'Auth Admin API POST /auth/v1/admin/users（email_confirm: true，不发信）',
    },
    { step: 'S1', what: '内容种子（单事务，引用 U1 返回的用户 id）', channel: 'POST /database/query' },
    {
      step: 'F1',
      what: `合成文件 ×2 → ugc-images/<测试用户 id>/（逐个记 sha256）`,
      channel: 'Storage API（x-upsert: false）',
    },
    {
      step: 'V1',
      what: '最终核对：status.sql 全 true、行数与影响清单一致、2 个对象下载比对 sha256',
      channel: 'read-only + Storage API',
    },
  );
  return { run_id: runId, project_ref: TEST_REF, source_sha: manifest.source_sha, steps };
}

// ---------------------------------------------------------------- 执行（只有 --execute 才走到这里）
export function client({
  token,
  serviceKey,
  fetchImpl = fetch,
  ref = TEST_REF,
  timeoutMs = (STATEMENT_TIMEOUT_S + 30) * 1000,
}) {
  assertRef(ref);
  const call = async (url, init) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('client-timeout')), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  };
  const mg = (p, body) =>
    call(`${MGMT}/v1${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  const project = `https://${ref}.supabase.co`;
  return {
    listProjects: () => mg('/projects'),
    query: (query) => mg(`/projects/${ref}/database/query`, { query }),
    readOnly: (query) => mg(`/projects/${ref}/database/query/read-only`, { query }),
    adminCreateUser: (u, password) =>
      call(`${project}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: u.email,
          password,
          email_confirm: true,
          user_metadata: { name: u.name },
        }),
      }),
    upload: (objPath, body) =>
      call(`${project}/storage/v1/object/ugc-images/${objPath}`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': 'image/png',
          'x-upsert': 'false',
        },
        body,
      }),
  };
}

/** 令牌必须只绑定 azsou-test：能列出的项目恰好就是它 */
export async function assertTokenScope(c) {
  const r = await c.listProjects();
  if (!r.ok) throw new Refused(`GET /v1/projects → HTTP ${r.status}`);
  const refs = (await r.json()).map((p) => p.ref ?? p.id).sort();
  if (refs.includes(PROD_REF))
    throw new Refused('拒绝：令牌能访问生产项目——必须换成只授权 azsou-test 的细粒度令牌');
  if (JSON.stringify(refs) !== JSON.stringify([TEST_REF]))
    throw new Refused(`拒绝：令牌能访问的项目是 [${refs.join(', ')}]，必须恰好只有 azsou-test`);
}

/**
 * 执行一个迁移文件；失败 / 超时 / 断线一律先查账本判断有没有提交：
 *   committed → 当成功继续；not-committed → 停（exit 1）；still-running / 查不到 → 停（exit 3），不重试。
 */
export async function applyOne(c, m, sql, runId) {
  let err;
  try {
    const r = await c.query(wrapMigration(sql, { name: m.name, sha: m.sha256, runId }));
    if (r.ok) return { file: m.name, outcome: 'committed', via: 'response' };
    err = `HTTP ${r.status} ${(await r.text()).slice(0, 300)}`;
  } catch (e) {
    err = String(e?.message ?? e);
  }
  // 结果不确定：查账本（同一事务写入的行）与仍在跑的会话
  try {
    const v = await c.readOnly(
      `select json_build_object('ledger', (select count(*) from az_init.applied where file = '${m.name}' and run_id = '${runId}'),
        'running', (select count(*) from pg_stat_activity where application_name = 'az-init:${runId}:${m.name}' and state <> 'idle')) as v`,
    );
    if (!v.ok) return { file: m.name, outcome: 'unknown', error: err, verify: `HTTP ${v.status}` };
    const row = (await v.json())[0]?.v ?? {};
    if (Number(row.running) > 0) return { file: m.name, outcome: 'still-running', error: err };
    return {
      file: m.name,
      outcome: Number(row.ledger) === 1 ? 'committed' : 'not-committed',
      via: 'ledger',
      error: err,
    };
  } catch (e) {
    return { file: m.name, outcome: 'unknown', error: err, verify: String(e?.message ?? e) };
  }
}

export async function execute({
  sha,
  manifest,
  c,
  runId,
  read = (rel) => gitShow(sha, rel),
  log = console.log,
}) {
  await assertTokenScope(c);
  const pf = await c.readOnly(PREFLIGHT_SQL);
  if (!pf.ok) throw new Refused(`预检失败：HTTP ${pf.status}`);
  const pre = (await pf.json())[0]?.preflight ?? {};
  const problems = preflightProblems(pre);
  if (problems.length) throw new Refused(`预检不通过（不清空、不覆盖）：${problems.join('；')}`);
  const b = await c.query(BOOTSTRAP_SQL);
  if (!b.ok) return { exit: EXIT.FAILED, results: [{ file: 'az_init', outcome: 'not-committed' }] };
  const results = [];
  const statusSql = read('db/verify/status.sql').toString('utf8').replace(/;\s*$/, '');
  for (const m of manifest.migrations) {
    const r = await applyOne(c, m, read(`db/migrations/${m.name}`), runId);
    results.push(r);
    log(`${r.outcome.padEnd(13)} ${m.name}${r.error ? ` — ${r.error}` : ''}`);
    if (r.outcome === 'not-committed') return { exit: EXIT.FAILED, results };
    if (r.outcome !== 'committed') return { exit: EXIT.UNKNOWN, results };
    const step = m.name.slice(0, 4);
    if (step !== '0001') {
      const s = await c.readOnly(
        `select json_agg(x) as rows from (${statusSql}) x where step <= '${step}' and not ok`,
      );
      const rows = s.ok ? (await s.json())[0]?.rows : 'HTTP ' + s.status;
      if (rows)
        return {
          exit: EXIT.FAILED,
          results: [...results, { file: m.name, outcome: 'status-check-failed', detail: rows }],
        };
    }
  }
  // U1 合成账号（Auth Admin API）→ S1 内容种子 → F1 文件（Storage API）
  const ids = {};
  for (const u of SYNTHETIC_USERS) {
    const r = await c.adminCreateUser(u, randomBytes(18).toString('base64url'));
    if (!r.ok)
      return {
        exit: EXIT.FAILED,
        results: [...results, { file: `user:${u.email}`, outcome: `HTTP ${r.status}` }],
      };
    ids[u.key] = (await r.json()).id;
    results.push({ file: `user:${u.email}`, outcome: 'created' });
  }
  const seed = await c.query(contentSeedSql(ids, runId));
  if (!seed.ok)
    return { exit: EXIT.FAILED, results: [...results, { file: 'seed', outcome: `HTTP ${seed.status}` }] };
  results.push({ file: 'seed', outcome: 'committed' });
  for (const f of syntheticFiles()) {
    const r = await c.upload(`${ids.user}/${f.name}`, f.body);
    if (!r.ok)
      return { exit: EXIT.FAILED, results: [...results, { file: f.name, outcome: `HTTP ${r.status}` }] };
    results.push({ file: f.name, outcome: 'uploaded', sha256: f.sha256 });
  }
  return { exit: EXIT.OK, results };
}

// ---------------------------------------------------------------- 影响清单
/** 影响清单：迁移建的对象（来自本机按同一 SHA 跑出的目录差异，见 ops/sbtest/init-impact.json）+ 种子 / 账号 / 桶 / 文件 */
export function impactMarkdown(impact, manifest) {
  const files = syntheticFiles();
  const L = [];
  L.push('# azsou-test 初始化影响清单（dry-run 产物，未执行）', '');
  L.push(`- 目标：azsou-test \`${TEST_REF}\`（执行器拒绝任何其他 ref）`);
  L.push(
    `- 源：钉住提交 \`${manifest.source_sha}\`，迁移 0001–0019 的 sha256 见 \`ops/sbtest/init-manifest.json\``,
  );
  L.push(
    `- 迁移对象来源：本机 Postgres ${impact.local.server_version} + db/shim/supabase-like（plain.sql）按同一 SHA 执行 0001–0019 前后的系统目录差异（${impact.local.generated_at}）。`,
  );
  L.push(
    '  托管 Supabase 上 auth / storage / extensions 由平台提供，下面只列本仓库迁移在 public / private / storage / auth 里新建或改动的对象。',
    '',
  );
  L.push('## 1. 数据库对象（迁移 0001–0019 新建）', '');
  L.push('| 类别 | schema | 数量 | 名称 | 可逆性 |', '| --- | --- | --- | --- | --- |');
  for (const g of impact.objects)
    L.push(
      `| ${g.kind} | ${g.schema} | ${g.names.length} | ${g.names.join(', ').slice(0, 900)}${g.names.join(', ').length > 900 ? ' …（全表见 init-impact.json）' : ''} | ${g.reversible} |`,
    );
  L.push('', '## 2. 迁移本身写入的行（种子 / 默认设置）', '');
  L.push('| 表 | 行数 | 可逆性 |', '| --- | --- | --- |');
  for (const r of impact.migration_rows) L.push(`| ${r.table} | ${r.rows} | ${r.reversible} |`);
  L.push('', '## 3. 执行器自己的账本', '');
  L.push(
    `| schema az_init、表 az_init.applied | ${MIGRATIONS.length + 1} 行（0001–0019 + seed） | drop schema az_init cascade |`,
  );
  L.push('', '## 4. 合成账号（Auth Admin API，email_confirm: true，不发邮件）', '');
  L.push('| 邮箱 | 角色 | 由谁建 | 可逆性 |', '| --- | --- | --- | --- |');
  for (const u of SYNTHETIC_USERS)
    L.push(
      `| ${u.email} | ${u.role}${u.banned ? '（banned）' : ''} | auth.users + auth.identities（email，GoTrue 自动建）+ public.profiles（0001 触发器） | DELETE /auth/v1/admin/users/<id>（级联删 profiles 及其内容） |`,
    );
  L.push(
    '',
    '不建任何 OAuth（GitHub）身份：真实 OAuth 登录只能由 I01 人工证据证明，不能用伪造的 auth.identities 代替。',
    '',
  );
  L.push('## 5. 内容种子（单事务；行数 = 本机跑同一段 SQL 的实测增量，含触发器产生的行）', '');
  L.push('| 表 | 新增行数 | 可逆性 |', '| --- | --- | --- |');
  for (const r of impact.users_rows ?? []) L.push(`| ${r.table} | ${r.rows}（账号） | 删用户级联 |`);
  for (const r of impact.seed_rows ?? [])
    L.push(`| ${r.table} | ${r.rows} | 按本次 run 的用户 id / 标题删除；或删用户级联 |`);
  L.push('| public.profiles（role / banned 更新） | 3 行被更新 | 改回 user / false |');
  L.push('', '## 6. Storage', '');
  L.push('| 对象 | 大小 | sha256 | 可逆性 |', '| --- | --- | --- | --- |');
  L.push(
    '| 桶 ugc-images | — | — | 0010 建（storage.buckets 行）；清空后 DELETE /storage/v1/bucket/ugc-images |',
  );
  for (const f of files)
    L.push(
      `| ugc-images/<测试用户 id>/${f.name} | ${f.bytes} B | ${f.sha256} | DELETE /storage/v1/object/ugc-images |`,
    );
  L.push('', '## 7. 不做的事', '');
  L.push(
    '- 不启用 pg_cron、不执行 db/ops/（调度另批）；不发任何邮件；不碰生产；不清空 azsou-test（预检非空即停）。',
  );
  L.push('- 迁移没有 down 脚本：整体回退 = 删除 / 重建 azsou-test 项目（站长操作）；逐项回退按上表。');
  L.push(
    '- Management API 不是 pg_dump / pg_restore 通道：备份恢复演练的执行通道仍未决定（见 ops/SBTEST-INIT.md）。',
  );
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI
function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const sha = arg(argv, 'source-sha') ?? manifest.source_sha;
    if (cmd === 'manifest') {
      const m = buildManifest(sha);
      if (argv.includes('--write')) writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
      console.log(JSON.stringify(m, null, 2));
      return EXIT.OK;
    }
    verifyPinned(manifest, sha);
    if (cmd === 'plan') {
      const p = plan(manifest);
      console.log(`dry-run（零网络）：源 ${sha}，0001–0019 sha256 与清单一致`);
      for (const s of p.steps) console.log(`  ${s.step.padEnd(4)} ${s.what}  [${s.channel}]`);
      const out = arg(argv, 'out');
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, 'plan.json'), JSON.stringify(p, null, 2) + '\n');
        const impact = JSON.parse(readFileSync(path.join(ROOT, 'ops/sbtest/init-impact.json'), 'utf8'));
        writeFileSync(path.join(out, 'impact.md'), impactMarkdown(impact, manifest));
        console.log(`计划与影响清单已写到 ${out}`);
      }
      return EXIT.OK;
    }
    if (cmd === 'execute') {
      if (!argv.includes('--execute')) throw new Refused('execute 需要显式 --execute');
      assertRef(arg(argv, 'confirm-ref') ?? '');
      if (!env.SBTEST_OWNER_APPROVAL)
        throw new Refused('缺 SBTEST_OWNER_APPROVAL（站长批准记录）：初始化必须站长单独批准');
      if (!env.SBTEST_MGMT_TOKEN || !env.SBTEST_SERVICE_KEY)
        throw new Refused('缺 SBTEST_MGMT_TOKEN / SBTEST_SERVICE_KEY（vault 注入）');
      const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
      const c = client({ token: env.SBTEST_MGMT_TOKEN, serviceKey: env.SBTEST_SERVICE_KEY });
      const r = await execute({ sha, manifest, c, runId });
      console.log(`结果：${['成功', '失败（已停）', '拒绝', '不确定（不重试，人工核对）'][r.exit]}`);
      return r.exit;
    }
    throw new Refused(`未知子命令 ${cmd}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return e instanceof Refused ? EXIT.REFUSED : EXIT.FAILED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
