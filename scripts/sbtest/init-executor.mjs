#!/usr/bin/env node
/**
 * azsou-test（隔离 Supabase 测试项目，ref ovvfwkmqlejcpatmfqcd）初始化执行器——站长 2026-10-28 第五轮 ⑤。
 * **默认 dry-run**：不发任何网络请求，只核对钉住的源 SHA 与迁移文件 sha256、打印执行计划与影响清单。
 * 真正执行（--execute）另需站长批准；本仓库任何 CI / 测试都不会对真实项目执行。说明见 ops/SBTEST-INIT.md。
 *
 * 通道：Supabase Management API（不是 Postgres 协议，所以**不是** pg_dump / 恢复通道——恢复通道仍未决定）。
 *   凭据（第六轮 ②）：默认 injected 模式——执行器不带 Authorization / apikey 头，vault 按主机名在线路上注入；
 *     Management API 只允许 https://api.supabase.io；api.supabase.com 是公共 Management API 域名，当前有一个生产范围的连接器绑在上面
 *     （vault 里还有一条只读 PAT 也写着这个范围，注入哪一条不可枚举），所以执行器永不使用它。
 *     项目 API 只允许 https://ovvfwkmqlejcpatmfqcd.supabase.co；任何 401 → 拒绝，并按响应区分（第八轮）：No API key found = 没有 apikey、
 *     Invalid API key = apikey 已送达但无效、其他 401（含 Management API 的 Unauthorized）= 无法区分缺失 / 无效。env-token 模式只给本机假服务器测试。
 *   第八轮：所有查询结果经单一共享解析器 parseOneRow（恰好 1 行、对象、字段存在）；任何不确定 → Uncertain，不再写。
 *   第七轮：所有请求 redirect: 'manual'，任何 3xx（含同主机）→ 拒绝；第一次写之前必须通过项目服务准入
 *     （GET /auth/v1/admin/users?per_page=1 → 200 且 {users:[…]}；Auth settings / Storage 列桶成功都不算）。
 *   读：POST /v1/projects/{ref}/database/query/read-only（预检、执行后验收、清点）；写：POST /v1/projects/{ref}/database/query。
 *   权限预检（第六轮 ①）：GET /v1/projects/{ref} 核对 ref / name / region / 状态；GET /v1/projects 只记录（403 照常继续，但 403 **不能证明**令牌范围；范围只以站长提供的令牌配置记录为准）。
 *   托管账号：Auth Admin API POST /auth/v1/admin/users（email_confirm: true，不发邮件）——不直接写 auth.users / auth.identities，不伪造 OAuth 身份。
 *   文件：Storage API POST /storage/v1/object/ugc-images/<路径>（x-upsert: false），验收时 GET /storage/v1/object/authenticated/… 重新下载比对 sha256。
 *
 * 子命令：
 *   plan     [--source-sha <40 位>] [--out <目录>]     dry-run（默认）：钉 SHA + 校验 + 计划 + 影响清单，零网络
 *   manifest --source-sha <40 位> [--write]           从 git 对象库读 <SHA> 的 0001–0019 计算 sha256（--write 写 ops/sbtest/init-manifest.json）
 *   preflight [--record <md>]                          只读：目标身份 + 范围 + 身份 + C0（不发任何写请求），写打码运行记录
 *   execute  --execute --confirm-ref ovvfwkmqlejcpatmfqcd [--resume] [--record <md>]   需要 SBTEST_OWNER_APPROVAL；成功 = V1 全部通过
 * 退出码：0 成功（dry-run = 计划有效；execute = V1 验收全部通过）；1 执行失败（已停在失败的文件，之前的文件已提交且有记录）；2 用法 / 拒绝（ref、令牌范围、钉住校验）；
 *         3 结果不确定（超时后无法判断是否提交——不重试，交人工核对）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as FS,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TEST_REF = 'ovvfwkmqlejcpatmfqcd';
export const PROD_REF = 'abryflgoljltyakthtql';
/**
 * 退出码。第十一轮新增 INCOMPLETE = 4：原执行成功（V1 全部通过），但必需的交接 / 清理收尾失败（例如空交接文件删不掉、运行记录写不出）——
 * 不是「完全完成」，云端写操作不需要、也不得重跑，只按收尾错误人工处理。收尾错误从不改变非 0 的原退出码（1 / 2 / 3 原样保留，3 绝不降成 1 或 0）。
 */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, UNKNOWN: 3, INCOMPLETE: 4 });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_PATH = path.join(ROOT, 'ops/sbtest/init-manifest.json');
export const MIGRATIONS = Object.freeze(Array.from({ length: 19 }, (_, i) => String(i + 1).padStart(4, '0')));
/** 每个迁移文件的语句超时；HTTP 客户端超时比它多 30 秒，超时后一律先核对是否已提交 */
export const STATEMENT_TIMEOUT_S = 300;
export const LOCK_TIMEOUT_S = 15;

export class Refused extends Error {}
/**
 * 第八轮 B1：结果不确定（查询返回的形状不能可靠判断）。继承 Refused：写之前出现 → 拒绝（退出码 2，一个写请求都不发）；
 * 写之后出现 → execute 判为不确定（退出码 3），不再发任何写请求。
 */
export class Uncertain extends Refused {
  constructor(msg) {
    super(`结果不确定：${msg}`);
  }
}

/**
 * 第八轮 B1 单一共享解析器：Management API 查询（/database/query 与 /read-only）的结果必须是**恰好 1 行**的数组，
 * 行是普通对象，且字段 key 真实存在（值可以是 null——json_agg 空集是合法的 null，与「缺字段」不同）。
 * 其余一律 Uncertain：[]、[{}]、多行、null、非数组、行不是对象。
 */
export function parseOneRow(json, key) {
  if (!Array.isArray(json))
    throw new Uncertain(`查询结果不是数组：${String(JSON.stringify(json)).slice(0, 80)}`);
  if (json.length !== 1) throw new Uncertain(`查询结果应恰好 1 行，实际 ${json.length} 行`);
  const row = json[0];
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Uncertain(`查询结果行不是对象：${String(JSON.stringify(row)).slice(0, 80)}`);
  if (!Object.prototype.hasOwnProperty.call(row, key))
    throw new Uncertain(`查询结果缺字段 ${key}（与合法的 null 不同）`);
  return row[key];
}
/** 解析 + 校验值：check(v) 返回 true 才接受，否则 Uncertain */
export function parseChecked(json, key, check, what = key) {
  const v = parseOneRow(json, key);
  if (!check(v)) throw new Uncertain(`${what} 的值不确定：${String(JSON.stringify(v)).slice(0, 80)}`);
  return v;
}
export const isCount = (x) =>
  (typeof x === 'number' && Number.isInteger(x) && x >= 0) || (typeof x === 'string' && /^\d+$/.test(x));
export const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
export const isArr = Array.isArray;
export const isArrOrNull = (x) => x === null || Array.isArray(x);
/** status.sql 的 `json_agg(...) where not ok`：全部 true = null；有问题 = 非空数组；[] 不可能出现 → 不确定 */
export const isRows = (x) => x === null || (Array.isArray(x) && x.length > 0);

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** ref 允许清单：只有 azsou-test */
export function assertRef(ref) {
  if (ref === PROD_REF) throw new Refused(`拒绝：${ref} 是生产项目`);
  if (ref !== TEST_REF)
    throw new Refused(`拒绝：ref ${ref} 不是 azsou-test（${TEST_REF}）——执行器只对 azsou-test 生效`);
}

/** 从 git 对象库读钉住 SHA 下的文件（不读工作区，工作区被改过也不影响） */
/**
 * 钉住的提交必须在本地 git 对象库里（浅克隆 / 没 fetch 到 → 拒绝并说明怎么补，而不是当成执行失败）。
 * @param {string} sha
 * @param {string} cwd
 */
export function assertCommitPresent(sha, cwd = ROOT) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refused(`源 SHA 必须是完整 40 位：${sha}`);
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' });
  } catch {
    throw new Refused(
      `钉住的源提交 ${sha} 不在本地 git 对象库里（浅克隆？）：先 git fetch origin ${sha}（或完整克隆）再运行`,
    );
  }
}
export function gitShow(sha, rel, cwd = ROOT) {
  assertCommitPresent(sha, cwd);
  return execFileSync('git', ['show', `${sha}:${rel}`], { cwd, maxBuffer: 64 << 20 });
}
export function gitLs(sha, dir, cwd = ROOT) {
  assertCommitPresent(sha, cwd);
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
set local lock_timeout = '${LOCK_TIMEOUT_S}s';
set local application_name = 'az-init:${runId}:seed';
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
      what: '目标身份：GET /v1/projects/{ref} 的 ref / name azsou-test / region ap-southeast-1 / ACTIVE_HEALTHY；GET /v1/projects 只记录（403 不能证明令牌范围）',
      channel: 'Management API（只读，injected）',
    },
    {
      step: 'P1',
      what: '只读身份（current_database / version / 主机打码）+ C0 空库：无业务表、无 cron、无 supabase_migrations、auth / storage 计数为 0、无 az_init',
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
      what: 'V1 验收（成功的唯一条件）：无 cron、status.sql 全 true、影响清单对象齐全、账本 20 行 sha256 一致、4 个账号角色、种子行数、2 个对象重新下载 sha256 一致',
      channel: 'read-only + Storage API',
    },
  );
  return { run_id: runId, project_ref: TEST_REF, source_sha: manifest.source_sha, steps };
}

// ---------------------------------------------------------------- 凭据通道与端点（第六轮 ②）
/**
 * 两种凭据模式：
 *   injected（真实运行的默认值）：执行器**不带任何 Authorization / apikey 头**，凭据由 vault 按主机名在线路上注入；
 *     进程环境里不需要、也不允许有 SBTEST_MGMT_TOKEN / SBTEST_SERVICE_KEY。Management API 基址只允许
 *     https://api.supabase.io（只读 PAT 以服务 sbtest-mgmt-ro 绑在这个主机；api.supabase.com 归生产 PAT 连接器，永不使用），
 *     项目基址只允许 https://ovvfwkmqlejcpatmfqcd.supabase.co。任何请求得到 401 → 拒绝（退出码 2），按响应分类（classify401），不一律当成「没有注入」。
 *   env-token（只给本机假服务器测试）：令牌从环境变量来、自己加头；基址必须是本机回环地址，所以真实令牌永远走不到真实主机。
 */
export const TARGET = Object.freeze({ ref: TEST_REF, name: 'azsou-test', region: 'ap-southeast-1' });
export const MGMT_INJECTED_BASE = 'https://api.supabase.io';
export const PROJECT_BASE = `https://${TEST_REF}.supabase.co`;
export const MODES = Object.freeze(['injected', 'env-token']);
/**
 * api.supabase.com 是公共 Management API 域名（不是「生产 API」）：当前有生产范围的连接器绑在这个主机上，
 * 而 vault 里 azsou-test 只读 PAT 的范围也写的是它——线路上注入哪一条从沙箱里不可枚举。执行器在任何模式下都不向它发请求。
 */
export const FORBIDDEN_HOSTS = Object.freeze(['api.supabase.com']);

/**
 * 第八轮 B3：401 不能一律解释为「没有注入」。按响应正文分类：
 *   no_api_key      Kong「No API key found in request」——apikey 头没有到达（未注入）
 *   invalid_api_key Kong「Invalid API key」——apikey 已送达但无效（注入了错误的值，或值不属于该项目）
 *   other           其他 401（GoTrue bad_jwt / invalid JWT、Management API「Unauthorized」等）——无法区分缺失 / 无效 / 错签名
 */
export function classify401(text) {
  const t = String(text ?? '');
  if (/no api key found/i.test(t))
    return { kind: 'no_api_key', label: 'No API key found——apikey 头没有到达（未注入）' };
  if (/invalid api key/i.test(t))
    return {
      kind: 'invalid_api_key',
      label: 'Invalid API key——apikey 已送达但无效（值错误 / 不属于该项目）',
    };
  return {
    kind: 'other',
    label: `其他 401（other）——无法区分凭据缺失 / 无效 / 签名错误：${t.replace(/\s+/g, ' ').slice(0, 120) || '（无正文）'}`,
  };
}
/** HTTP 401（kind 见 classify401）；NoInjection 只用于明确的 no_api_key */
export class Unauthorized extends Refused {
  constructor(msg, kind = 'other') {
    super(msg);
    this.kind = kind;
  }
}
export class NoInjection extends Unauthorized {}
/**
 * 第十二轮：收到 3xx（从不跟随）。仍是拒绝（读请求 / 写之前的闸门照旧 exit 2）；但写请求**已经发出**后才收到的 3xx
 * 说明服务器可能已经处理了这次写——createUsers / rotateAdopted 按「结果未知」（exit 3）处理，不当成拒绝。
 */
export class Redirected extends Refused {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const stripSlash = (u) => String(u).replace(/\/+$/, '');

/** 端点允许清单：injected 只认两个固定 https 基址；env-token 只认本机回环（假服务器） */
/** @param {{ mode?: string, mgmtBase?: string, projectBase?: string }} [o] */
export function resolveEndpoints({ mode = 'injected', mgmtBase, projectBase } = {}) {
  if (!MODES.includes(mode)) throw new Refused(`未知凭据模式 ${mode}（只有 ${MODES.join(' / ')}）`);
  const mg = stripSlash(mgmtBase ?? (mode === 'injected' ? MGMT_INJECTED_BASE : ''));
  const pj = stripSlash(projectBase ?? (mode === 'injected' ? PROJECT_BASE : ''));
  for (const u of [mg, pj]) {
    if (!u) throw new Refused(`${mode} 模式需要显式的基址（SBTEST_MGMT_BASE / SBTEST_PROJECT_BASE）`);
    if (u.includes(PROD_REF)) throw new Refused('拒绝：基址含生产项目 ref');
    let host;
    try {
      host = new URL(u).host;
    } catch {
      throw new Refused(`基址不是合法 URL：${u}`);
    }
    if (FORBIDDEN_HOSTS.includes(new URL(u).hostname))
      throw new Refused(`拒绝：${host} 当前绑着生产范围的连接器（生产 PAT 连接器），执行器永不使用`);
    if (mode === 'env-token' && !LOOPBACK.has(new URL(u).hostname))
      throw new Refused(`env-token 模式只允许本机假服务器（回环地址），拒绝 ${host}`);
  }
  if (mode === 'injected') {
    if (mg !== MGMT_INJECTED_BASE)
      throw new Refused(`injected 模式的 Management API 基址只允许 ${MGMT_INJECTED_BASE}，拒绝 ${mg}`);
    if (pj !== PROJECT_BASE) throw new Refused(`injected 模式的项目基址只允许 ${PROJECT_BASE}，拒绝 ${pj}`);
  }
  return { mode, mgmtBase: mg, projectBase: pj };
}

/** 打码：只留首尾少量字符，用于组织 id、用户 id、IP */
export function mask(v, keep = 4) {
  const s = String(v ?? '');
  if (!s) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/^(\d+)\..*$/, '$1.x.x.x');
  if (/^[0-9a-f]*:[0-9a-f:]+$/i.test(s)) return `${s.split(':')[0]}:x:x:…（IPv6 已打码）`;
  if (s.length <= keep * 2) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}…${s.slice(-2)}`;
}

/**
 * HTTP 客户端。每个请求只记 { phase, method, path, status, ms }——不记请求头、正文、查询串、令牌。
 * 任何 401 → Unauthorized（按 classify401 区分 no_api_key / invalid_api_key / other），调用方当作拒绝处理，不当成执行失败、不重试。
 */
/**
 * @param {{ mode?: string, token?: string, serviceKey?: string, mgmtBase?: string, projectBase?: string,
 *   fetchImpl?: typeof fetch, ref?: string, timeoutMs?: number, trace?: any[] }} o
 */
export function client({
  mode = 'injected',
  token,
  serviceKey,
  mgmtBase,
  projectBase,
  fetchImpl = fetch,
  ref = TEST_REF,
  timeoutMs = (STATEMENT_TIMEOUT_S + 30) * 1000,
  trace = [],
}) {
  assertRef(ref);
  const ep = resolveEndpoints({ mode, mgmtBase, projectBase });
  if (mode === 'injected' && (token || serviceKey))
    throw new Refused('injected 模式不接受进程内令牌（凭据只由 vault 在线路上注入）');
  if (mode === 'env-token' && (!token || !serviceKey))
    throw new Refused('env-token 模式（只用于本机假服务器）需要 token 与 serviceKey');
  let phase = 'init';
  const call = async (url, init, what) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('client-timeout')), timeoutMs);
    const u = new URL(url);
    const entry = { phase, method: init.method ?? 'GET', path: u.pathname, status: 0, ms: 0 };
    const t0 = Date.now();
    trace.push(entry);
    try {
      // 第七轮 ②：从不自动跟随重定向；任何 3xx（含同主机）都拒绝——注入凭据只按主机名绑定，跟随跨主机重定向可能把请求送到别的绑定上
      const r = await fetchImpl(url, { ...init, redirect: 'manual', signal: ac.signal });
      entry.status = r.status;
      if ((r.status >= 300 && r.status < 400) || r.type === 'opaqueredirect') {
        let to = '';
        try {
          to = new URL(r.headers?.get?.('location') ?? '', url).host;
        } catch {
          /* 没有 / 无效 Location */
        }
        throw new Redirected(
          `${what}：HTTP ${r.status || '3xx'} 重定向被拒（不自动跟随；${to && to !== u.host ? `跨主机 ${u.host} → ${to}` : `同主机 ${u.host}`}）`,
          r.status,
        );
      }
      if (r.status === 401) {
        let body = '';
        try {
          body = await r.text();
        } catch {
          /* 读不到正文 → other */
        }
        const k = classify401(body);
        const hint =
          k.kind === 'no_api_key'
            ? `（主机 ${u.host} 缺 apikey 绑定，或进程没走注入代理：Node 需 NODE_USE_ENV_PROXY=1）`
            : k.kind === 'invalid_api_key'
              ? `（主机 ${u.host} 收到了 apikey，但值无效）`
              : `（主机 ${u.host}；无法区分）`;
        const Cls = k.kind === 'no_api_key' ? NoInjection : Unauthorized;
        throw new Cls(`${what}：HTTP 401 [${k.kind}] ${k.label}${hint}`, k.kind);
      }
      return r;
    } catch (e) {
      if (!entry.status)
        entry.status = `ERR:${e?.message === 'client-timeout' || e?.name === 'AbortError' ? 'timeout' : (e?.name ?? 'error')}`;
      throw e;
    } finally {
      entry.ms = Date.now() - t0;
      clearTimeout(t);
    }
  };
  const mgHeaders = () =>
    mode === 'env-token'
      ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' };
  const pjHeaders = (extra = {}) =>
    mode === 'env-token'
      ? { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, ...extra }
      : { ...extra };
  const mg = (p, body, what) =>
    call(
      `${ep.mgmtBase}/v1${p}`,
      {
        method: body ? 'POST' : 'GET',
        headers: mgHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      },
      what,
    );
  const pj = (p, init, what) => call(`${ep.projectBase}${p}`, init, what);
  return {
    mode,
    endpoints: ep,
    trace,
    setPhase: (p) => (phase = p),
    getProject: () => mg(`/projects/${ref}`, undefined, 'GET /v1/projects/{ref}'),
    listProjects: () => mg('/projects', undefined, 'GET /v1/projects'),
    query: (query) => mg(`/projects/${ref}/database/query`, { query }, 'database/query'),
    readOnly: (query) =>
      mg(`/projects/${ref}/database/query/read-only`, { query }, 'database/query/read-only'),
    authSettings: () => pj('/auth/v1/settings', { method: 'GET', headers: pjHeaders() }, 'auth settings'),
    /** 第七轮 ① 项目服务准入：真正只读、需要 service_role 的端点 */
    authAdminList: () =>
      pj(
        '/auth/v1/admin/users?per_page=1',
        { method: 'GET', headers: pjHeaders() },
        'Auth Admin 列用户（只读准入）',
      ),
    storageBuckets: () => pj('/storage/v1/bucket', { method: 'GET', headers: pjHeaders() }, 'storage 列桶'),
    adminCreateUser: (u, password, runId) =>
      pj(
        '/auth/v1/admin/users',
        {
          method: 'POST',
          headers: pjHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            email: u.email,
            password,
            email_confirm: true,
            user_metadata: { name: u.name },
            // 运行标记：续跑时据此（加邮箱 / 名称 / 身份）判断这个账号是不是本次运行建的，才能接管
            app_metadata: { az_init_run: runId },
          }),
        },
        'Auth Admin 建账号',
      ),
    /** 只改密码（续跑接管账号、交接到文件时用）；不发邮件 */
    adminSetPassword: (id, password) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Refused(`用户 id 格式无效：${mask(id)}`);
      return pj(
        `/auth/v1/admin/users/${id}`,
        {
          method: 'PUT',
          headers: pjHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ password }),
        },
        'Auth Admin 设置密码',
      );
    },
    upload: (objPath, body) =>
      pj(
        `/storage/v1/object/ugc-images/${objPath}`,
        {
          method: 'POST',
          headers: pjHeaders({ 'content-type': 'image/png', 'x-upsert': 'false' }),
          body,
        },
        'Storage 上传',
      ),
    download: (objPath) =>
      pj(
        `/storage/v1/object/authenticated/ugc-images/${objPath}`,
        { method: 'GET', headers: pjHeaders() },
        'Storage 下载',
      ),
  };
}

/**
 * 只读查询 → 共享解析器 parseOneRow 取字段 key，再用 check 校验值（第八轮 B1：不再 `[0] ?? {}`）。
 * 非 2xx / 非 JSON / 形状不符 / 值不符 → Uncertain；网络层异常原样抛出。
 */
export async function ro(c, sql, key, check = () => true) {
  const r = await c.readOnly(sql);
  if (!r.ok) throw new Uncertain(`read-only HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  let json;
  try {
    json = await r.json();
  } catch {
    throw new Uncertain('read-only 响应不是 JSON');
  }
  return parseChecked(json, key, check);
}

// ---------------------------------------------------------------- 权限预检（第六轮 ①）
/**
 * 固定目标身份：GET /v1/projects/{ref} 必须 200 且 ref / name / region 与 TARGET 完全一致、状态 ACTIVE_HEALTHY。
 * 不要求、也不申请账号级范围：GET /v1/projects 只用来**记录**——403 照常继续，但 403 **不能证明**令牌只授权了哪些项目
 * （范围只以站长提供的令牌配置记录为准）；200 时能看到的必须恰好只有 azsou-test（看得到生产 / 别的项目 → 拒绝）；
 * 401 → 拒绝（Management API 的 401 无法区分令牌缺失 / 无效，见 classify401）。
 */
export async function verifyTarget(c) {
  c.setPhase?.('P0');
  const r = await c.getProject();
  if (r.status !== 200) throw new Refused(`目标身份：GET /v1/projects/{ref} → HTTP ${r.status}`);
  const p = await r.json();
  const bad = [];
  if ((p.ref ?? p.id) !== TARGET.ref) bad.push(`ref ${p.ref ?? p.id}`);
  if (p.name !== TARGET.name) bad.push(`name ${p.name}`);
  if (p.region !== TARGET.region) bad.push(`region ${p.region}`);
  if (bad.length)
    throw new Refused(
      `目标身份不符（期望 ${TARGET.ref} / ${TARGET.name} / ${TARGET.region}）：${bad.join('、')}`,
    );
  if (p.status !== 'ACTIVE_HEALTHY') throw new Refused(`目标项目状态 ${p.status}，不是 ACTIVE_HEALTHY`);
  const target = {
    ref: p.ref ?? p.id,
    name: p.name,
    region: p.region,
    status: p.status,
    organization_id: p.organization_id ? mask(p.organization_id) : '（未返回）',
    db_version: p.database?.version ?? '（未返回）',
  };
  let scope;
  const l = await c.listProjects();
  if (l.status === 403)
    scope = {
      list_projects: 403,
      verdict:
        '只记录：列项目被拒（403）照常继续；403 不能证明令牌范围（可能是项目级令牌，也可能是别的原因），范围只以站长提供的令牌配置记录为准',
    };
  else if (l.status === 200) {
    const list = await l.json().catch(() => null);
    if (!Array.isArray(list)) throw new Uncertain('GET /v1/projects 200 但响应不是数组');
    const refs = list.map((x) => x.ref ?? x.id).sort();
    if (refs.includes(PROD_REF))
      throw new Refused('拒绝：令牌能看到生产项目——只接受只授权 azsou-test 的令牌');
    if (JSON.stringify(refs) !== JSON.stringify([TEST_REF]))
      throw new Refused(`拒绝：令牌能看到 ${refs.length} 个项目，必须只授权 azsou-test`);
    scope = { list_projects: 200, verdict: '列项目只返回 azsou-test' };
  } else scope = { list_projects: l.status, verdict: '范围未确定（列项目返回非 200/403；不依赖它）' };
  return { target, scope };
}

/** 只读身份核对（主机地址打码） */
export const IDENTITY_SQL = `select json_build_object(
  'current_database', current_database(),
  'current_user', current_user,
  'version', split_part(version(), ' on ', 1),
  'server_addr', coalesce(host(inet_server_addr()), ''),
  'server_port', inet_server_port(),
  'in_recovery', pg_is_in_recovery()
) as identity`;

/** C0：初始化前的空库核对（只读；cron.job 只在 cron schema 存在时才查） */
export const C0_SQL = `select json_build_object(
  'server_version', current_setting('server_version'),
  'public_relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')),
  'public_functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
  'private_schema', to_regnamespace('private') is not null,
  'az_init_schema', to_regnamespace('az_init') is not null,
  'supabase_migrations_schema', to_regnamespace('supabase_migrations') is not null,
  'cron_extension', exists (select 1 from pg_extension where extname = 'pg_cron'),
  'cron_schema', to_regnamespace('cron') is not null,
  'cron_jobs', case when to_regclass('cron.job') is null then 0
    else (xpath('/row/c/text()', query_to_xml('select count(*) as c from cron.job', false, true, '')))[1]::text::int end,
  'pg_net_extension', exists (select 1 from pg_extension where extname = 'pg_net'),
  'auth_users', (select count(*) from auth.users),
  'auth_identities', (select count(*) from auth.identities),
  'auth_sessions', (select count(*) from auth.sessions),
  'auth_refresh_tokens', (select count(*) from auth.refresh_tokens),
  'storage_buckets', (select count(*) from storage.buckets),
  'storage_objects', (select count(*) from storage.objects),
  'extensions', (select json_agg(extname order by extname) from pg_extension)
) as preflight`;
/** 兼容旧名 */
export const PREFLIGHT_SQL = C0_SQL;

/** C0 每个键的类型（第七轮 ③：{} / 缺键 / null / 类型不对 / 版本无效 → 拒绝，不能当成「空库」） */
export const C0_COUNTS = Object.freeze([
  'public_relations',
  'public_functions',
  'cron_jobs',
  'auth_users',
  'auth_identities',
  'auth_sessions',
  'auth_refresh_tokens',
  'storage_buckets',
  'storage_objects',
]);
export const C0_FLAGS = Object.freeze([
  'private_schema',
  'az_init_schema',
  'supabase_migrations_schema',
  'cron_extension',
  'cron_schema',
  'pg_net_extension',
]);

/** C0 / V1 共用的类型判断：标志必须是布尔值 */
export const isFlag = (x) => typeof x === 'boolean';
/** 第九轮 V1.cron：计数必须是 number 且是有限非负整数（Number.isInteger 已排除 NaN / ±Infinity；字符串 "0"、[0]、null 都不算） */
export const isStrictCount = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const showVal = (v) => (v === undefined ? '缺失' : typeof v === 'number' ? String(v) : JSON.stringify(v));
/**
 * 第九轮 V1.cron 形状核对：只看 cron_extension / cron_schema / cron_jobs 三个字段（复用 C0 的布尔判断，计数更严：isStrictCount）。
 * 不套用初始化前的「空库」要求——V1 在初始化之后运行，业务表 / 账号 / 对象本来就不是 0。
 */
export function cronShapeProblems(p) {
  if (!isObj(p)) return ['C0 返回为空 / 不是对象（不能判断 cron）'];
  const bad = [];
  for (const k of ['cron_extension', 'cron_schema'])
    if (!isFlag(p[k])) bad.push(`${k} 不是布尔值：${showVal(p[k])}`);
  if (!isStrictCount(p.cron_jobs)) bad.push(`cron_jobs 不是有限非负整数：${showVal(p.cron_jobs)}`);
  return bad;
}

/** C0 形状问题（不论全新执行还是续跑都拒绝） */
export function c0ShapeProblems(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['C0 返回为空 / 不是对象（不能当成空库）'];
  const bad = [];
  if (typeof p.server_version !== 'string' || !/^\d+(\.\d+)*\b/.test(p.server_version))
    bad.push(`server_version 无效（版本无法判断）：${JSON.stringify(p.server_version ?? null)}`);
  for (const k of C0_COUNTS)
    if (!isCount(p[k])) bad.push(`${k} 缺失或不是非负整数：${JSON.stringify(p[k] ?? null)}`);
  for (const k of C0_FLAGS)
    if (!isFlag(p[k])) bad.push(`${k} 缺失或不是布尔值：${JSON.stringify(p[k] ?? null)}`);
  if (!Array.isArray(p.extensions)) bad.push('extensions 缺失或不是数组');
  return bad;
}

export function preflightProblems(p) {
  const shape = c0ShapeProblems(p);
  if (shape.length) return shape;
  const bad = [];
  if (Number(String(p.server_version).split('.')[0]) < 15) bad.push(`Postgres ${p.server_version} < 15`);
  for (const k of [
    'public_relations',
    'public_functions',
    'auth_users',
    'auth_identities',
    'auth_sessions',
    'auth_refresh_tokens',
    'storage_buckets',
    'storage_objects',
    'cron_jobs',
  ])
    if (p[k] !== undefined && Number(p[k]) !== 0) bad.push(`${k} = ${p[k]}（必须为 0）`);
  if (p.private_schema) bad.push('private schema 已存在');
  if (p.supabase_migrations_schema) bad.push('supabase_migrations schema 已存在');
  if (p.cron_extension || p.cron_schema) bad.push('pg_cron 已启用（初始化不启用调度）');
  if (p.az_init_schema)
    bad.push('az_init schema 已存在（之前跑过？用 --resume 按账本续跑或人工核对，不重跑）');
  return bad;
}

/** 只读预检（权限 + 身份 + C0 + 项目服务准入）——preflight 子命令与 execute 共用同一段代码 */
export async function preflight(c) {
  const { target, scope } = await verifyTarget(c);
  c.setPhase?.('P1');
  const id = await ro(c, IDENTITY_SQL, 'identity', isObj);
  const identity = { ...id, server_addr: id.server_addr ? mask(id.server_addr) : '' };
  const c0 = await ro(c, C0_SQL, 'preflight', isObj);
  let service;
  try {
    service = await admitProjectService(c);
  } catch (e) {
    if (!(e instanceof NotAdmitted)) throw e;
    service = { accepted: false, endpoint: ADMIN_PROBE, reason: e.message };
  }
  return { target, scope, identity, c0, c0_problems: preflightProblems(c0), service };
}

/**
 * 第七轮 ① 项目服务准入（第一次写之前，只读）：GET /auth/v1/admin/users?per_page=1。
 * 这个端点需要 service_role（Kong 要 apikey，GoTrue 要 service_role 的 Authorization），且只读。
 * 只有 HTTP 200 且响应是 {users:[…]} 才算接受；401 / 403 / 5xx / 非 JSON / 形状不符 → 不接受（NotAdmitted，拒绝）。
 * Auth settings 成功、Storage 列桶返回空数组都**不算**准入（前者 anon 就能读，后者可能是任何被接受的 Bearer）。
 * 只记录状态与返回条数，不记任何用户数据。
 */
export class NotAdmitted extends Refused {}
export const ADMIN_PROBE = 'GET /auth/v1/admin/users?per_page=1';
export async function admitProjectService(c) {
  c.setPhase?.('PS');
  const no = (why) => new NotAdmitted(`项目服务凭据不接受（not accepted）：${ADMIN_PROBE} → ${why}`);
  let r;
  try {
    r = await c.authAdminList();
  } catch (e) {
    if (e instanceof Unauthorized) throw no(`HTTP 401 ${String(e.message).replace(/^.*?HTTP 401 /, '')}`);
    if (e instanceof Refused) throw e;
    throw no(`请求失败 ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (r.status !== 200) throw no(`HTTP ${r.status}`);
  let body;
  try {
    body = JSON.parse(await r.text());
  } catch {
    throw no('HTTP 200 但响应不是 JSON');
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.users))
    throw no('HTTP 200 但响应形状不是 {users:[…]}');
  return {
    accepted: true,
    endpoint: ADMIN_PROBE,
    status: 200,
    shape: '{users:[…]}',
    users_returned: body.users.length,
  };
}

/**
 * 项目主机的凭据注入探测（只读 GET，不调用任何写端点）：Auth Admin 与 Storage 写需要 service_role 以 apikey（Kong key-auth）
 * + Authorization 注入到 ovvfwkmqlejcpatmfqcd.supabase.co。这里只看两个只读端点得到什么：401 = 该头没注入。
 */
export async function probeProject(c) {
  c.setPhase?.('PJ');
  const out = {};
  for (const [k, fn] of [
    ['GET /auth/v1/settings（需要 apikey 头；仅信息，不算准入）', () => c.authSettings()],
    ['GET /storage/v1/bucket（需要 Authorization 头；仅信息，不算准入）', () => c.storageBuckets()],
  ]) {
    try {
      const r = await fn();
      out[k] = `HTTP ${r.status}（仅信息：不能证明 service_role 被接受，准入只看 ${ADMIN_PROBE}）`;
    } catch (e) {
      out[k] =
        e instanceof Unauthorized
          ? `HTTP 401 ${String(e.message)
              .replace(/^.*?HTTP 401 /, '')
              .slice(0, 160)}`
          : `错误 ${String(e?.message ?? e).slice(0, 80)}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 执行（只有 --execute 才走到这里）
/**
 * 第十三轮：传输层错误 → 受控短码（不带服务器正文 / 路径）。timeout = 客户端超时；network = 连接断开 / 响应丢失 / 无响应。
 * @param {any} e
 */
export function transportCode(e) {
  const m = `${e?.name ?? ''} ${e?.message ?? e ?? ''} ${e?.cause?.code ?? ''}`;
  if (/client-timeout|AbortError|timeout/i.test(m)) return 'timeout';
  return 'network';
}
/**
 * 第十三轮：写请求**已经发出**后的第 ① 层（原始 HTTP / 传输状态）。只有状态码 / 受控短码，绝不含服务器正文。
 *   { status: 503 } / { status: 307, redirect_followed: false } / { error: 'timeout' | 'network' }
 * @param {{ response?: any, error?: any }} o
 */
export function postSendHttp({ response, error }) {
  if (response) return { status: response.status };
  if (error instanceof Redirected) return { status: error.status, redirect_followed: false };
  return { error: transportCode(error) };
}
/** 第 ① 层 → 一句话（运行记录用；只有状态码 / 受控短码） */
export function httpText(h) {
  if (!h) return '';
  if (typeof h.status === 'number')
    return `HTTP ${h.status}${h.redirect_followed === false ? '，重定向未跟随' : ''}`;
  return h.error === 'timeout' ? '客户端超时' : '连接断开 / 无响应';
}
/** 写请求发出后，只读核对本身的错误 → 受控说明（核对请求 3xx / 401 / 非 2xx / 形状不符 / 网络都只算「无法核对」，不算拒绝） */
const verifyFailText = (e) =>
  e instanceof Redirected
    ? `核对请求 HTTP ${e.status}（重定向未跟随）`
    : e instanceof Unauthorized
      ? '核对请求 HTTP 401'
      : e instanceof Uncertain
        ? '核对结果形状无效'
        : `核对请求失败（${transportCode(e)}）`;
/**
 * 执行一个事务（迁移文件或种子）；失败 / 超时 / 断线 / **发出后收到 3xx**（第十三轮，不跟随）一律先查账本判断有没有提交：
 *   committed → 当成功继续；not-committed（账本 0 行且标记会话已结束）→ 停（exit 1）；still-running / 查不到 → 停（exit 3），不重试。
 * 第十三轮：结果分两层——http（第 ① 层：原始 HTTP / 传输状态，不含服务器正文）+ verification（第 ② 层：账本核对结论 + 依据）；
 * outcome = 业务结论。核对只用只读端点（Management API 允许清单内），从不访问 Location 主机；核对请求自身的 3xx / 401 /
 * 形状不符 / 网络错误 → 无法核对（unknown，exit 3），不当成拒绝。
 * 401（写请求本身）直接抛 Unauthorized（按 classify401 分类）：请求没被服务端接受，不需要核对。
 */
export async function runTx(c, file, wrappedSql, runId) {
  let http;
  try {
    const r = await c.query(wrappedSql);
    if (r.ok) return { file, outcome: 'committed', via: 'response', http: { status: r.status } };
    http = postSendHttp({ response: r });
    try {
      await r.text(); // 读完丢弃：服务器正文不进结果 / 记录 / 回执
    } catch {
      /* 读不到也无妨 */
    }
  } catch (e) {
    if (e instanceof Refused && !(e instanceof Redirected)) throw e;
    http = postSendHttp({ error: e });
  }
  const err = httpText(http);
  const unknown = (basis) => ({
    file,
    outcome: 'unknown',
    error: err,
    http,
    verification: { conclusion: 'unverifiable', basis },
  });
  try {
    const v = await c.readOnly(
      `select json_build_object('ledger', (select count(*) from az_init.applied where file = '${file}' and run_id = '${runId}'),
        'running', (select count(*) from pg_stat_activity where application_name = 'az-init:${runId}:${file}' and state <> 'idle')) as v`,
    );
    if (!v.ok) return unknown(`核对请求 HTTP ${v.status}`);
    // 第七轮 ③ / 第八轮 B1：共享解析器——恰好 1 行、字段 v 存在且 ledger / running 都是非负整数；否则 unknown（不是 not-committed）
    let row;
    try {
      row = parseChecked(
        await v.json(),
        'v',
        (x) => isObj(x) && isCount(x.ledger) && isCount(x.running),
        '提交核对',
      );
    } catch {
      return unknown('核对结果形状无效（不是恰好 1 行、ledger / running 非负整数）');
    }
    const n = Number(row.ledger);
    const basis = `账本 ${n} 行（run_id + 文件；与正文同一事务写入），标记会话 ${Number(row.running)} 个在运行`;
    if (Number(row.running) > 0)
      return {
        file,
        outcome: 'still-running',
        error: err,
        http,
        verification: { conclusion: 'still-running', basis },
      };
    if (n !== 0 && n !== 1) return unknown(`账本行数 ${n}（应为 0 或 1）`);
    const concl = n === 1 ? 'committed' : 'not-committed';
    return {
      file,
      outcome: concl,
      via: 'ledger',
      error: err,
      http,
      verification: { conclusion: concl, basis },
    };
  } catch (e) {
    return unknown(verifyFailText(e));
  }
}
/**
 * 第十三轮 B0（建账本，单事务；C0 已证明 az_init 不存在）。返回 undefined = 2xx 已提交（不记结果，与以前相同）；否则返回逐项结果：
 *  - 4xx（401 除外，401 照旧按凭据拒绝抛出）：显式拒绝 → not-committed（exit 1）；
 *  - 5xx / 其他非 2xx / 超时 / 断线 / **发出后收到 3xx**（不跟随）：只读核对 az_init.applied 是否存在——
 *    存在 → committed（B0 单事务，C0 时不存在，只能是本次提交的）→ 继续；
 *    不存在 → unknown（exit 3）：B0 事务没有运行标记，不能排除仍在运行 / 延迟提交，**不是「确定未提交」**；
 *    核对本身失败（非 2xx / 3xx / 401 / 形状 / 网络）→ unknown（exit 3）。
 * 两层：http（原始状态，不含正文）+ verification（结论 + 依据）。
 * @param {any} c
 */
export async function bootstrapLedger(c) {
  let http;
  try {
    const b = await c.query(BOOTSTRAP_SQL);
    if (b.ok) return undefined;
    http = postSendHttp({ response: b });
    try {
      await b.text();
    } catch {
      /* 丢弃正文 */
    }
    if (isRejection(b.status))
      return {
        file: 'az_init',
        outcome: 'not-committed',
        error: httpText(http),
        http,
        verification: {
          conclusion: 'rejected',
          basis: 'HTTP 4xx 显式拒绝（单事务，按响应未提交；未另行核对）',
        },
      };
  } catch (e) {
    if (e instanceof Refused && !(e instanceof Redirected)) throw e;
    http = postSendHttp({ error: e });
  }
  const base = { file: 'az_init', error: httpText(http), http };
  try {
    const led = await ro(c, LEDGER_SQL, 'ledger', isArrOrNull);
    if (Array.isArray(led))
      return {
        ...base,
        outcome: 'committed',
        via: 'ledger',
        verification: {
          conclusion: 'committed',
          basis: 'az_init.applied 已存在（C0 时 az_init 不存在；B0 是单事务，表只能由本次 B0 提交）',
        },
      };
    return {
      ...base,
      outcome: 'unknown',
      verification: {
        conclusion: 'unverifiable',
        basis:
          'az_init.applied 尚不存在，但 B0 事务没有运行标记，不能排除仍在运行 / 延迟提交——不能确认未提交',
      },
    };
  } catch (e) {
    return {
      ...base,
      outcome: 'unknown',
      verification: { conclusion: 'unverifiable', basis: verifyFailText(e) },
    };
  }
}
export async function applyOne(c, m, sql, runId) {
  return runTx(c, m.name, wrapMigration(sql, { name: m.name, sha: m.sha256, runId }), runId);
}

/** 种子 SQL 末尾的账本行带这段 SQL 自身的 sha256（去掉账本行后计算），V1 据此核对 */
export function seedTx(ids, runId) {
  const base = contentSeedSql(ids, runId);
  const marker = `insert into az_init.applied (run_id, file, sha256) values ('${runId}', 'seed', 'n/a');`;
  const body = base.replace(marker, '');
  const sha = sha256(Buffer.from(body));
  return {
    sql: base.replace(
      marker,
      `insert into az_init.applied (run_id, file, sha256) values ('${runId}', 'seed', '${sha}');`,
    ),
    sha,
  };
}

const SBTEST_EMAILS = () => SYNTHETIC_USERS.map((u) => `'${u.email}'`).join(', ');

/** 已存在的合成账号（只读）：email → { id, role, banned, confirmed, providers } */
export const ACCOUNTS_SQL = () => `select coalesce(json_agg(json_build_object(
  'email', u.email, 'id', u.id, 'confirmed', u.email_confirmed_at is not null,
  'role', p.role, 'banned', coalesce(p.banned, false),
  'providers', (select coalesce(json_agg(distinct i.provider), '[]'::json) from auth.identities i where i.user_id = u.id),
  'active_ban', exists (select 1 from public.user_bans b where b.user_id = u.id and (b.expires_at is null or b.expires_at > now()))
) order by u.email), '[]'::json) as accounts
from auth.users u left join public.profiles p on p.id = u.id where u.email in (${SBTEST_EMAILS()})`;
/** 合成账号（不依赖 public 表——迁移没跑完时也能查）：续跑接管要核对的字段（邮箱、确认、名称、运行标记、身份） */
export const ACCOUNTS_BARE_SQL = () => `select coalesce(json_agg(json_build_object(
  'email', u.email, 'id', u.id, 'confirmed', u.email_confirmed_at is not null,
  'name', u.raw_user_meta_data->>'name', 'run', u.raw_app_meta_data->>'az_init_run',
  'providers', (select coalesce(json_agg(distinct i.provider), '[]'::json) from auth.identities i where i.user_id = u.id)
) order by u.email), '[]'::json) as accounts
from auth.users u where u.email in (${SBTEST_EMAILS()})`;

/**
 * 第七轮 ④ 接管核对：已存在的合成账号只有全部满足才能被续跑接管——
 * 邮箱在合成清单里、运行标记 app_metadata.az_init_run = 账本 run_id、邮箱已确认、只有 email 身份、名称元数据一致。
 */
export function adoptionProblems(a, runId) {
  const u = SYNTHETIC_USERS.find((x) => x.email === a?.email);
  if (!u) return [`${a?.email ?? '（无邮箱）'} 不是合成账号`];
  const p = [];
  if (a.run !== runId) p.push(`${a.email} 运行标记 ${a.run ?? '（无）'} ≠ 账本 run_id ${runId}`);
  if (a.confirmed !== true) p.push(`${a.email} 邮箱未确认`);
  if (JSON.stringify(a.providers) !== JSON.stringify(['email']))
    p.push(`${a.email} 身份 ${JSON.stringify(a.providers)}（只允许 email）`);
  if (a.name !== u.name) p.push(`${a.email} 名称元数据不符`);
  if (!/^[0-9a-f-]{36}$/i.test(String(a.id ?? ''))) p.push(`${a.email} id 无效`);
  return p;
}

/** 期望的种子哈希：按账号的真实 id + run_id 重算 seedTx（账号不全 → null） */
export function expectedSeedSha(accounts, runId) {
  const ids = {};
  for (const a of accounts ?? []) {
    const u = SYNTHETIC_USERS.find((x) => x.email === a.email);
    if (u) ids[u.key] = a.id;
  }
  if (SYNTHETIC_USERS.some((u) => !ids[u.key])) return null;
  return seedTx(ids, runId).sha;
}
export const LEDGER_SQL = `select case when to_regclass('az_init.applied') is null then null else
  (xpath('/row/j/text()', query_to_xml('select coalesce(json_agg(json_build_object(''run_id'', run_id, ''file'', file, ''sha256'', sha256) order by applied_at, file), ''[]'') as j from az_init.applied', false, true, '')))[1]::text::json end as ledger`;
export const RUNNING_SQL = `select count(*) as n from pg_stat_activity where application_name like 'az-init:%' and state <> 'idle'`;

/** 种子涉及的表行数（V1 与清点共用） */
export const SEED_TABLES = Object.freeze([
  'public.comments',
  'public.forum_replies',
  'public.forum_threads',
  'public.friend_links',
  'public.guestbook_entries',
  'public.notifications',
  'public.reports',
  'public.subscribers',
  'public.user_bans',
  'public.profiles',
  'public.forum_seed_threads',
  'private.app_settings',
  'storage.buckets',
]);
export const COUNTS_SQL = () =>
  `select json_build_object(${SEED_TABLES.map(
    (t) =>
      `'${t}', case when to_regclass('${t}') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from ${t}', false, true, '')))[1]::text::int end`,
  ).join(',\n  ')}) as counts`;
export const OBJECTS_SQL = `select coalesce(json_agg(json_build_object('name', name, 'size', (metadata->>'size')::bigint)), '[]'::json) as objects
from storage.objects where bucket_id = 'ugc-images'`;

/** 系统目录快照（与 scripts/sbtest/impact-local.mjs 同口径），V1 用它核对影响清单里的对象都在 */
export const CATALOG_SQL = `with ns as (select oid, nspname from pg_namespace where nspname in ('public', 'private', 'storage', 'auth'))
select coalesce(json_agg(kind || '|' || schema || '|' || name), '[]'::json) as objects from (
  select case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'materialized view'
              when 'S' then 'sequence' when 'i' then 'index' when 'I' then 'index' when 'f' then 'foreign table' end kind,
         ns.nspname schema, c.relname::text name
    from pg_class c join ns on ns.oid = c.relnamespace where c.relkind in ('r','p','v','m','S','i','I','f')
  union all select 'function', ns.nspname, p.oid::regprocedure::text from pg_proc p join ns on ns.oid = p.pronamespace
  union all select 'trigger', ns.nspname, c.relname || '.' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join ns on ns.oid = c.relnamespace where not t.tgisinternal
  union all select 'policy', schemaname, tablename || '.' || policyname from pg_policies where schemaname in ('public', 'private', 'storage', 'auth')
  union all select 'schema', nspname, nspname from ns
  union all select 'extension', '-', extname::text from pg_extension
) x where kind is not null`;

/** 影响清单里期望出现的对象（extensions schema 里的 pg_trgm 函数按「扩展存在」核对，不逐个比函数签名） */
export function expectedObjects(impact) {
  const out = [];
  for (const g of impact.objects ?? []) {
    if (g.schema === 'extensions') continue;
    for (const n of g.names) out.push(`${g.kind}|${g.schema}|${n}`);
  }
  return out;
}

/** 期望行数：迁移写入的行 + 账号带来的行 + 种子增量（全部来自影响清单；执行前这些表为空） */
export function expectedCounts(impact) {
  const exp = Object.fromEntries(SEED_TABLES.map((t) => [t, 0]));
  for (const r of [
    ...(impact.migration_rows ?? []),
    ...(impact.users_rows ?? []),
    ...(impact.seed_rows ?? []),
  ])
    if (r.table in exp) exp[r.table] += Number(r.rows);
  return exp;
}

/**
 * V1 执行后验收（全部只读 + Storage 下载）。任何一项不通过 → execute 返回 exit 1。
 *   V1.cron      没有 pg_cron 扩展 / cron schema / 任务
 *   V1.status    db/verify/status.sql 全为 true
 *   V1.objects   影响清单里的每个对象都存在（含 pg_trgm 扩展）
 *   V1.ledger    az_init.applied 恰好 20 行：0001–0019 名称与 sha256 = 清单，seed 1 行（64 位 sha256），run_id 一致
 *   V1.accounts  4 个合成账号存在、邮箱已确认、只有 email 身份；角色 admin / moderator / user / user(banned + 生效封禁)
 *   V1.seed      种子相关表行数 = 影响清单期望
 *   V1.storage   ugc-images 恰好 2 个对象，路径 = <测试用户 id>/<文件名>，重新下载 sha256 一致
 */
export async function acceptV1(c, { manifest, impact, runId, statusSql, files = syntheticFiles() }) {
  c.setPhase?.('V1');
  const checks = [];
  let uncertain = false;
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const guard = async (id, fn) => {
    try {
      await fn();
    } catch (e) {
      // 第八轮 B1：结果不确定 → 该项不通过，并把整次 V1 标为不确定（exit 3）；V1 只读，不会再写
      if (e instanceof Uncertain) {
        uncertain = true;
        return add(id, false, { uncertain: true, detail: String(e.message).slice(0, 200) });
      }
      if (e instanceof Refused) throw e;
      add(id, false, `核对失败：${String(e?.message ?? e).slice(0, 200)}`);
    }
  };
  let accounts = [];
  await guard('V1.cron', async () => {
    // 第九轮：以前 `!x && !y && Number(n) === 0` 会把缺字段 / null / "0" / [0] 当成「没有 cron」放行。
    // 现在：明确的 true 或计数 > 0 → 不通过（证据已足够，不是不确定）；否则形状不对 → 不确定（exit 3）；
    // 只有 false / false / 0（类型都正确）才通过。
    const p = await ro(c, C0_SQL, 'preflight', isObj);
    const shape = cronShapeProblems(p);
    const detail = { cron_extension: p.cron_extension, cron_schema: p.cron_schema, cron_jobs: p.cron_jobs };
    const definite =
      p.cron_extension === true || p.cron_schema === true || (isStrictCount(p.cron_jobs) && p.cron_jobs > 0);
    if (definite) return add('V1.cron', false, shape.length ? { ...detail, shape_problems: shape } : detail);
    if (shape.length) throw new Uncertain(`V1.cron 形状不对：${shape.join('；')}`);
    add('V1.cron', p.cron_extension === false && p.cron_schema === false && p.cron_jobs === 0, detail);
  });
  await guard('V1.status', async () => {
    // 第八轮 B1：只有合法的 rows:null 才是「全部 true」；[{}]（缺字段）、[]、多行、非数组 → 不确定
    const rows = await ro(c, `select json_agg(x) as rows from (${statusSql}) x where not ok`, 'rows', isRows);
    add('V1.status', rows === null, rows ? rows.map((r) => `${r.step} ${r.item}`) : '全部 true');
  });
  await guard('V1.objects', async () => {
    const have = new Set(await ro(c, CATALOG_SQL, 'objects', isArr));
    const missing = expectedObjects(impact).filter((x) => !have.has(x));
    const ext = have.has('extension|-|pg_trgm');
    add('V1.objects', missing.length === 0 && ext, {
      expected: expectedObjects(impact).length,
      missing: missing.slice(0, 20),
      missing_total: missing.length,
      pg_trgm: ext,
    });
  });
  await guard('V1.ledger', async () => {
    const led = (await ro(c, LEDGER_SQL, 'ledger', isArrOrNull)) ?? [];
    const problems = [];
    if (led.length !== MIGRATIONS.length + 1)
      problems.push(`行数 ${led.length}（期望 ${MIGRATIONS.length + 1}）`);
    const byFile = new Map(led.map((r) => [r.file, r]));
    for (const m of manifest.migrations) {
      const r = byFile.get(m.name);
      if (!r) problems.push(`缺 ${m.name}`);
      else if (r.sha256 !== m.sha256) problems.push(`${m.name} sha256 不符`);
    }
    const seed = byFile.get('seed');
    if (!seed || !/^[0-9a-f]{64}$/.test(seed.sha256 ?? '')) problems.push('seed 行缺失或 sha256 无效');
    else {
      // 第七轮 ③：格式对还不够——按真实账号 id + run_id 重算本次种子 SQL 的哈希，必须相等
      const exp = expectedSeedSha(await ro(c, ACCOUNTS_BARE_SQL(), 'accounts', isArr), runId);
      if (!exp) problems.push('seed 期望哈希无法计算（合成账号不全）');
      else if (seed.sha256 !== exp) problems.push('seed sha256 ≠ 本次种子的期望哈希');
    }
    const runIds = [...new Set(led.map((r) => r.run_id))];
    if (runIds.length !== 1 || runIds[0] !== runId) problems.push(`run_id 不一致：${runIds.join(',')}`);
    const extra = led.filter((r) => r.file !== 'seed' && !manifest.migrations.some((m) => m.name === r.file));
    if (extra.length) problems.push(`未知账本行：${extra.map((r) => r.file).join(',')}`);
    add('V1.ledger', problems.length === 0, problems.length ? problems : `${led.length} 行一致`);
  });
  await guard('V1.accounts', async () => {
    accounts = await ro(c, ACCOUNTS_SQL(), 'accounts', isArr);
    const by = new Map(accounts.map((a) => [a.email, a]));
    const problems = [];
    for (const u of SYNTHETIC_USERS) {
      const a = by.get(u.email);
      if (!a) {
        problems.push(`缺 ${u.email}`);
        continue;
      }
      if (a.role !== u.role) problems.push(`${u.email} 角色 ${a.role}（期望 ${u.role}）`);
      if (!!a.banned !== !!u.banned) problems.push(`${u.email} banned=${a.banned}`);
      if (u.banned && !a.active_ban) problems.push(`${u.email} 没有生效的封禁记录`);
      if (!a.confirmed) problems.push(`${u.email} 邮箱未确认`);
      if (JSON.stringify(a.providers) !== JSON.stringify(['email']))
        problems.push(`${u.email} 身份 ${JSON.stringify(a.providers)}（只允许 email）`);
    }
    add(
      'V1.accounts',
      problems.length === 0 && accounts.length === SYNTHETIC_USERS.length,
      problems.length ? problems : accounts.map((a) => `${a.email}=${a.role}${a.banned ? '/banned' : ''}`),
    );
  });
  await guard('V1.seed', async () => {
    const got = await ro(c, COUNTS_SQL(), 'counts', isObj);
    const exp = expectedCounts(impact);
    const diff = Object.keys(exp).filter((t) => Number(got[t]) !== exp[t]);
    add('V1.seed', diff.length === 0, diff.length ? diff.map((t) => `${t} ${got[t]}≠${exp[t]}`) : '行数一致');
  });
  await guard('V1.storage', async () => {
    const user = accounts.find((a) => a.email === SYNTHETIC_USERS.find((u) => u.key === 'user').email);
    if (!user) return add('V1.storage', false, '找不到测试用户，无法定位对象路径');
    const objs = await ro(c, OBJECTS_SQL, 'objects', isArr);
    const problems = [];
    if (objs.length !== files.length) problems.push(`对象数 ${objs.length}（期望 ${files.length}）`);
    for (const f of files) {
      const p = `${user.id}/${f.name}`;
      if (!objs.some((o) => o.name === p)) problems.push(`缺 ${f.name}`);
      const r = await c.download(p);
      if (!r.ok) {
        problems.push(`${f.name} 下载 HTTP ${r.status}`);
        continue;
      }
      const got = sha256(Buffer.from(await r.arrayBuffer()));
      if (got !== f.sha256) problems.push(`${f.name} sha256 不符`);
    }
    add(
      'V1.storage',
      problems.length === 0,
      problems.length ? problems : `${files.length} 个对象下载 sha256 一致`,
    );
  });
  return { ok: checks.length === 7 && checks.every((x) => x.ok), uncertain, checks };
}

/**
 * 打码的资源清点（部分完成 / 超时 / V1 失败时写）：本次创建了什么，id 打码；查不到的项标 unknown，不推断。
 */
export async function inventory(c) {
  c.setPhase?.('INV');
  const inv = { status: 'determined', items: {} };
  const get = async (k, sql, key, check, fn = (x) => x) => {
    try {
      inv.items[k] = fn(await ro(c, sql, key, check));
    } catch (e) {
      if (e instanceof Refused && !(e instanceof Unauthorized) && !(e instanceof Uncertain)) throw e;
      inv.items[k] = 'unknown';
      inv.status = 'unknown';
    }
  };
  await get('ledger', LEDGER_SQL, 'ledger', isArrOrNull, (l) =>
    l === null
      ? '（无 az_init）'
      : l.map((r) => ({ file: r.file, run_id: r.run_id, sha256: `${String(r.sha256).slice(0, 12)}…` })),
  );
  await get('accounts', ACCOUNTS_BARE_SQL(), 'accounts', isArr, (a) =>
    a.map((x) => ({ email: x.email, id: mask(x.id) })),
  );
  await get('counts', COUNTS_SQL(), 'counts', isObj);
  await get('storage_objects', OBJECTS_SQL, 'objects', isArr, (o) =>
    o.map((x) => ({ name: String(x.name).replace(/^[0-9a-f-]{36}/, (m) => mask(m)), size: x.size })),
  );
  await get('running_sessions', RUNNING_SQL, 'n', isCount);
  return inv;
}

/**
 * 账本与状态一致性（--resume）：账本必须是清单的严格前缀（名称 + sha256 + 顺序），只有一个 run_id，
 * seed 只能在 0001–0019 全部之后；任何未知 / 不符的行 → 拒绝，交人工处理。
 */
export function analyzeLedger(ledger, manifest) {
  if (!Array.isArray(ledger)) throw new Refused('--resume：没有 az_init 账本，无从续跑（用全新执行）');
  if (ledger.length === 0) throw new Refused('--resume：账本为空（B0 后未提交任何文件）——人工核对后再决定');
  const runIds = [...new Set(ledger.map((r) => r.run_id))];
  if (runIds.length !== 1)
    throw new Refused(`--resume：账本有多个 run_id（${runIds.join(', ')}），需人工处理`);
  const migs = ledger.filter((r) => r.file !== 'seed');
  const seedRows = ledger.filter((r) => r.file === 'seed');
  migs.forEach((r, i) => {
    const m = manifest.migrations[i];
    if (!m || m.name !== r.file)
      throw new Refused(
        `--resume：账本第 ${i + 1} 行是 ${r.file}，清单期望 ${m?.name ?? '（无）'}——未知 / 乱序条目需人工处理`,
      );
    if (m.sha256 !== r.sha256) throw new Refused(`--resume：${r.file} 的 sha256 与清单不符——需人工处理`);
  });
  if (seedRows.length > 1) throw new Refused('--resume：seed 账本行重复');
  const seedDone = seedRows.length === 1;
  if (seedDone && migs.length !== manifest.migrations.length)
    throw new Refused('--resume：seed 已提交但迁移不完整——状态矛盾，需人工处理');
  return { runId: runIds[0], next: migs.length, seedDone };
}

/** 生成测试账号密码：只在内存里；绝不写日志 / 运行记录（24 字符 base64url = 144 位随机） */
export function genPassword() {
  return randomBytes(18).toString('base64url');
}

/** 每次调用的尝试 id（与 run_id 分开：续跑沿用账本 run_id，attempt_id 每次新生成） */
export function newAttemptId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
}

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * 第七轮 ④ / 第八轮 B2 测试账号凭据交接——不依赖任何邮件（@example.com 收不到信，重置邮件 / 魔法链接都不可用）：
 * 执行器生成强密码 → Auth Admin API 建号时直接设置（email_confirm: true）；被接管账号**只有显式要求**才用 PUT 改密 →
 * 写进**仓库外**的 0600 文件（目录 0700，文件不存在才创建，不覆盖）。
 * 第八轮路径检查：逐个路径分量 lstat，遇到符号链接就解析真实路径——指向仓库（按仓库真实路径比较）→ 拒绝；
 * 最终目录的真实路径在仓库里 → 拒绝；目录必须正好 0700、文件正好 0600，属主都必须是当前用户；文件以 O_EXCL | O_NOFOLLOW 创建。
 * 文件每行一个 JSON：{ email, password, user_id, project_ref, run_id, attempt_id, set_at }——run_id 由调用方按**实际沿用的账本 run_id** 传入。
 * 0600 文件写好 ≠ 交接完成：要等 Hark 把文件里的**每一行**（N = 本次成功写入交接文件的记录条数，不是云端建号 / 改密次数，也不是固定 4 条）存进 vault 并覆盖删除文件；
 * 部分失败 → 保留文件、停下，不重跑、不改密（ops/SBTEST-INIT.md §10.1）。覆盖删除不保证云端残留不可恢复。
 * @param {string} file 绝对路径，必须在仓库外
 * @param {{ repoRoot?: string, attemptId?: string, expectUid?: number }} [o]
 */
export function fileHandoff(file, { repoRoot = ROOT, attemptId = '', expectUid = process.getuid?.() } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw new Refused('交接文件必须是绝对路径（仓库外，例如 ~/.azsou-sbtest/<运行 id>.jsonl）');
  const abs = path.resolve(file);
  const lexRepo = path.resolve(repoRoot);
  const realRepo = realpathSync(lexRepo);
  if (inside(lexRepo, abs) || inside(realRepo, abs))
    throw new Refused('交接文件不能放在仓库里（会被 git 追踪 / 上传）');
  // 逐个分量解析符号链接（只读）：任何一个分量是指向仓库的符号链接 → 拒绝
  const segs = abs.split(path.sep).filter(Boolean);
  let cur = path.parse(abs).root;
  let i = 0;
  for (; i < segs.length; i++) {
    const next = path.join(cur, segs[i]);
    if (!lexists(next)) break;
    const st = lstatSync(next);
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(next);
      } catch {
        throw new Refused(`交接路径里有无法解析的符号链接：${next}`);
      }
      if (inside(realRepo, target))
        throw new Refused(`交接路径的符号链接 ${next} 指向仓库（${target}）——拒绝`);
      cur = target;
    } else cur = next;
  }
  const resolved = path.join(cur, ...segs.slice(i));
  if (inside(realRepo, resolved)) throw new Refused(`交接文件解析后在仓库里（${resolved}）——拒绝`);
  if (i >= segs.length) throw new Refused(`交接文件已存在（不覆盖）：${abs}`);
  const dir = path.dirname(resolved);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realDir = realpathSync(dir);
  if (inside(realRepo, realDir)) throw new Refused(`交接目录解析后在仓库里（${realDir}）——拒绝`);
  const ds = statSync(realDir);
  if ((ds.mode & 0o777) !== 0o700)
    throw new Refused(
      `交接文件所在目录权限是 ${(ds.mode & 0o777).toString(8)}，必须正好 700（不替你改权限：换一个只有自己能读写的目录）`,
    );
  if (expectUid !== undefined && ds.uid !== expectUid)
    throw new Refused(`交接文件所在目录的属主 uid ${ds.uid} 不是当前用户 ${expectUid}——拒绝`);
  const real = path.join(realDir, path.basename(resolved));
  let fd;
  try {
    fd = openSync(real, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    throw new Refused(`交接文件无法独占创建（已存在 / 是链接）：${abs}（${e?.code ?? e}）`);
  }
  try {
    fchmodSync(fd, 0o600);
    const fs = fstatSync(fd);
    if ((fs.mode & 0o777) !== 0o600) throw new Refused(`交接文件权限 ${(fs.mode & 0o777).toString(8)} ≠ 600`);
    if (expectUid !== undefined && fs.uid !== expectUid)
      throw new Refused(`交接文件属主 uid ${fs.uid} 不是当前用户 ${expectUid}`);
  } finally {
    closeSync(fd);
  }
  let n = 0;
  return {
    kind: 'file',
    path: real,
    attemptId,
    count: () => n,
    /** meta.run_id 必填（实际沿用的账本 run_id）；attempt_id 取 meta 或建文件时给的 attemptId */
    write(email, password, id, meta = {}) {
      const runId = meta?.run_id;
      const att = meta?.attempt_id || attemptId;
      if (typeof runId !== 'string' || !runId)
        throw new Refused('交接写入缺 run_id（必须是实际沿用的账本 run_id）');
      if (typeof att !== 'string' || !att) throw new Refused('交接写入缺 attempt_id');
      const line =
        JSON.stringify({
          email,
          password,
          user_id: id ?? null,
          project_ref: TEST_REF,
          run_id: runId,
          attempt_id: att,
          set_at: new Date().toISOString(),
        }) + '\n';
      const wfd = openSync(real, FS.O_WRONLY | FS.O_APPEND | (FS.O_NOFOLLOW ?? 0));
      try {
        // 第十二轮：短写 = 写入失败（文件可能已部分写入、含密码片段，按敏感文件处理），不计入 N
        const want = Buffer.byteLength(line);
        const got = writeSync(wfd, line);
        if (got !== want)
          throw Object.assign(new Error(`交接行只写入 ${got} / ${want} 字节（短写）`), {
            code: 'ESHORTWRITE',
          });
      } finally {
        closeSync(wfd);
      }
      n++;
    },
  };
}
const canHandoff = (h) => !!h && typeof h === 'object' && typeof h.write === 'function';

/** 文件系统 / 交接错误 → 短说明（只有错误码与消息，消息里只有路径，不含密码） */
const fsErr = (e) => {
  const m = String(e?.message ?? e);
  return (e?.code && !m.startsWith(String(e.code)) ? `${e.code} ${m}` : m).slice(0, 160);
};

/** 第十二轮：只有 4xx 是服务器显式拒绝（按响应未生效）；其余非 2xx（3xx、5xx、0）在写请求已发出后一律是「结果未知」 */
const isRejection = (status) => typeof status === 'number' && status >= 400 && status < 500;

const ADMIN_CREATE = /^\/auth\/v1\/admin\/users$/;
const ADMIN_UPDATE = /^\/auth\/v1\/admin\/users\/[^/]+$/;
const APPLIED = new Set(['created', 'password-set']);
const NOT_HANDED_OFF = new Set(['created-handoff-write-failed', 'password-set-handoff-write-failed']);
const ACC_UNKNOWN = new Set(['unknown', 'password-unknown']);

/**
 * 第十一轮：本次执行有没有发过 Auth Admin 建号 / 改密请求、结果如何——证据是客户端请求记录（trace，只有方法 / 路径 / 状态）
 * 加逐项结果（results，只有邮箱与结论）。状态分类：2xx = 已生效；4xx = 被拒（按响应未生效）；
 * 其余（0、ERR:*、3xx、5xx）= 结果未知，账号可能已创建 / 密码可能已改。
 * @param {any[]} trace
 * @param {any[]} [results]
 */
export function accountWriteEvidence(trace, results = []) {
  const sent = (trace ?? []).filter(
    (t) =>
      (t?.method === 'POST' && ADMIN_CREATE.test(String(t?.path))) ||
      (t?.method === 'PUT' && ADMIN_UPDATE.test(String(t?.path))),
  );
  const cls = (st) =>
    typeof st === 'number' && st >= 200 && st < 300
      ? 'applied'
      : typeof st === 'number' && st >= 400 && st < 500
        ? 'rejected'
        : 'unknown';
  const by = { applied: 0, rejected: 0, unknown: 0 };
  for (const t of sent) by[cls(t.status)]++;
  const acc = (results ?? []).filter((x) => String(x?.file ?? '').startsWith('user:'));
  const email = (x) => String(x.file).slice(5);
  const notHandedOff = acc.filter((x) => NOT_HANDED_OFF.has(x.outcome));
  const handedOff = acc.filter((x) => APPLIED.has(x.outcome));
  const unknown = acc.filter((x) => ACC_UNKNOWN.has(x.outcome));
  return {
    sent: sent.length,
    ...by,
    handedOff: handedOff.map(email),
    notHandedOff: notHandedOff.map((x) => ({ email: email(x), error: x.error ?? '' })),
    unknownEmails: unknown.map(email),
    /** 请求记录里 2xx / 未知的请求比逐项结果多出来的部分（没有归到任何账号）——一律按未交接 / 未知处理 */
    extraApplied: Math.max(0, by.applied - handedOff.length - notHandedOff.length),
    extraUnknown: Math.max(0, by.unknown - unknown.length),
  };
}

/**
 * 第十轮 / 第十一轮：运行结束时交接文件的结论。从不抛异常——任何交接 / 清理错误都放进 errors，与执行结论分开报告，不掩盖原执行结果。
 * N 只看本次运行**实际写进**交接文件的行数（handoff.count()）。**N = 0 只表示本次没有成功写入任何交接行**：
 *  - 只有执行证据证明没有发出任何 Auth Admin 建号 / 改密请求（或全部被 4xx 拒绝）时，才写「没有建号 / 改密」、不需要 save_login，
 *    并在核对空文件仍是 0 字节的普通文件后删除；删除失败 → errors（文件保留，执行结论不变）。
 *  - 有请求结果未知（响应丢失 / 超时 / 5xx）→ 写「可能已创建 / 可能已改密、状态未知、需人工核对」，不删文件。
 *  - 有请求已生效（2xx）但交接写入失败 → errors：哪些账号已创建 / 改密但密码未交接；不删文件（证据）。
 *  - 没有执行证据（evidence 缺失）→ 不下任何「没有建号」的结论，不删文件，交人工核对。
 * 返回 { n, notes, errors, deleted }（都不含密码）。
 * @param {any} handoff
 * @param {{ trace?: any[], results?: any[] } | undefined} evidence
 */
export function handoffConclusion(handoff, evidence) {
  /** @type {{ n: number, notes: string[], errors: string[], deleted: boolean }} */
  const out = { n: 0, notes: [], errors: [], deleted: false };
  if (!canHandoff(handoff)) return out;
  let n;
  try {
    n = handoff.count();
  } catch (e) {
    out.errors.push(`收尾错误：读取本次交接行数失败（${fsErr(e)}）——交接文件按原样保留，需人工核对`);
    return out;
  }
  out.n = n;
  const where = handoff.path ?? '（未知路径）';
  const ref = '（ops/SBTEST-INIT.md §10.1）';
  const ev =
    evidence && Array.isArray(evidence.trace) ? accountWriteEvidence(evidence.trace, evidence.results) : null;
  if (n > 0)
    out.notes.push(
      `账号密码交接文件：${where}（0600，N = ${n} 条 = 本次成功写入交接文件的记录条数，不是云端建号 / 改密次数；内容不在本记录里）——文件写好 ≠ 交接完成：${n} 条全部存进 vault 才覆盖删除文件；部分失败保留文件并停下，不重跑、不改密${ref}`,
    );
  let keep = false;
  if (!ev) {
    keep = true;
    out.notes.push(
      `本次执行证据不可用（没有请求记录）——不能断定是否发过 Auth Admin 建号 / 改密请求：账号状态未知，需人工核对；交接文件保留${ref}`,
    );
  } else {
    const unknownN = ev.unknownEmails.length + ev.extraUnknown;
    if (unknownN > 0) {
      keep = true;
      const who = [
        ...ev.unknownEmails,
        ...(ev.extraUnknown ? [`另有 ${ev.extraUnknown} 个未归到账号的请求`] : []),
      ].join('、');
      out.notes.push(
        `账号状态未知：${unknownN} 个 Auth Admin 建号 / 改密请求已发出但结果未知（响应丢失 / 超时 / 5xx 等）——${who}：账号可能已创建 / 密码可能已被改，状态未知，需人工核对（按运行标记与 auth.users 核对，见 ops/SBTEST-INIT.md §9）；执行器不自动重试建号 / 改密，也不为补交接改密`,
      );
    }
    const missing = ev.notHandedOff.length + ev.extraApplied;
    if (missing > 0) {
      keep = true;
      const who = [
        ...ev.notHandedOff.map((x) => `${x.email}${x.error ? `（${x.error}）` : ''}`),
        ...(ev.extraApplied ? [`另有 ${ev.extraApplied} 个已生效但没有交接记录的请求`] : []),
      ].join('、');
      out.errors.push(
        `交接错误：${missing} 个账号已创建 / 已改密（Auth Admin 返回 2xx），但密码未交接（交接文件写入失败）——${who}。这些账号的密码没有完整、可核对地写进交接文件，不能据此存进 vault；交接文件 ${where} 可能已部分写入（可能含密码片段），一律按敏感文件处理：保持 0600、只留在原机器上、不读出、不外传、不贴进任何记录 / 聊天，保留作证据，需人工处理：站长批准后才可经 --resume --rotate-passwords / --confirm-rotate 显式改密，执行器不自动重试、不自动改密${ref}`,
      );
    }
  }
  if (n > 0) return out;
  const noneSent = !!ev && ev.sent === 0;
  const rejectedOnly = !!ev && ev.sent > 0 && ev.applied === 0 && ev.unknown === 0 && !keep;
  if (keep || !(noneSent || rejectedOnly)) {
    out.notes.push(
      `账号密码交接：N = 0 只表示本次没有成功写入任何交接行，不表示没有建号 / 改密（见本节的状态未知 / 交接错误）；交接文件 ${where} 保留（本次 0 行），作为证据交人工核对，不删${ref}`,
    );
    return out;
  }
  const head = noneSent
    ? '账号密码交接：N = 0（本次请求记录里没有发出任何 Auth Admin 建号 / 改密请求：本次没有新建账号，也没有改密；被接管账号沿用上次交接 / vault 里的密码）——不需要任何 save_login / vault 保存，不得为凑数改密'
    : `账号密码交接：N = 0（本次发出的 ${ev.sent} 个 Auth Admin 建号 / 改密请求全部被 HTTP 4xx 拒绝，按响应未建号、未改密）——不需要任何 save_login / vault 保存，不得为凑数改密`;
  let st;
  try {
    st = handoff.path ? lstatSync(handoff.path) : undefined;
  } catch (e) {
    if (e?.code === 'ENOENT') {
      out.notes.push(`${head}；交接文件不存在（无需删除）${ref}`);
      return out;
    }
    out.notes.push(head);
    out.errors.push(
      `收尾错误：交接文件 ${where} 无法核对（${fsErr(e)}）——保留，需人工核对；执行结论不变，不重试任何写操作${ref}`,
    );
    return out;
  }
  if (!st || !st.isFile() || st.size !== 0) {
    out.notes.push(head);
    out.errors.push(
      `收尾错误：交接文件 ${where} 不是空的普通文件（本次未写入任何行）——不删，保留并要求人工核对；执行结论不变${ref}`,
    );
    return out;
  }
  try {
    unlinkSync(handoff.path);
  } catch (e) {
    out.notes.push(head);
    out.errors.push(
      `收尾错误：空交接文件 ${where} 删除失败（${fsErr(e)}）——文件保留（0 字节，不含密码），需人工删除；执行结论不变，不重试任何写操作${ref}`,
    );
    return out;
  }
  out.deleted = true;
  out.notes.push(`${head}；空交接文件 ${where} 已核对为 0 字节并删除${ref}`);
  return out;
}

/** 兼容第十轮的调用形状：只返回说明行（notes + errors），从不抛异常 */
export function finishHandoff(handoff, evidence) {
  const r = handoffConclusion(handoff, evidence);
  return [...r.notes, ...r.errors];
}

/**
 * 建缺的合成账号（Auth Admin API，email_confirm: true，带运行标记，不发信）。
 * 超时 / 断线 → unknown（不重试；续跑时按运行标记核对接管）；非 2xx → failed（例如 422 已存在 → 续跑接管）。
 */
export async function createUsers(c, missing, handoff, results, runId, attemptId) {
  const ids = {};
  for (const u of missing) {
    const password = genPassword();
    let r;
    try {
      r = await c.adminCreateUser(u, password, runId);
    } catch (e) {
      // 第十二轮：写请求已发出后收到 3xx（不跟随）→ 服务器可能已建号 → 结果未知（exit 3），不是拒绝；401 等其他拒绝照旧
      if (e instanceof Refused && !(e instanceof Redirected)) throw e;
      results.push({
        file: `user:${u.email}`,
        outcome: 'unknown',
        error: String(e?.message ?? e).slice(0, 160),
      });
      return { ids, outcome: 'unknown' };
    }
    if (!r.ok) {
      // 第十二轮：只有 4xx 是显式拒绝（按响应未建号 → 失败，exit 1）；5xx / 其他非 2xx = 请求已发出、结果未知 → exit 3
      if (!isRejection(r.status)) {
        results.push({
          file: `user:${u.email}`,
          outcome: 'unknown',
          error: `HTTP ${r.status}（建号请求已发出，结果未知：账号可能已创建）`,
        });
        return { ids, outcome: 'unknown' };
      }
      results.push({ file: `user:${u.email}`, outcome: `HTTP ${r.status}` });
      return { ids, outcome: 'failed' };
    }
    let id;
    try {
      id = (await r.json())?.id;
    } catch {
      /* 留空 */
    }
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) {
      results.push({ file: `user:${u.email}`, outcome: 'unknown', error: '建号响应里没有有效 id' });
      return { ids, outcome: 'unknown' };
    }
    ids[u.key] = id;
    if (canHandoff(handoff)) {
      // 第十一轮：账号已建、交接写入失败 → 不再写（不建下一个、不改密、不重试），按不确定停下；
      // 第十二轮：交接文件可能已部分写入（可能含密码片段）→ 按敏感文件处理，记录写明
      try {
        await handoff.write(u.email, password, id, { run_id: runId, attempt_id: attemptId });
      } catch (e) {
        results.push({ file: `user:${u.email}`, outcome: 'created-handoff-write-failed', error: fsErr(e) });
        return { ids, outcome: 'unknown' };
      }
    }
    results.push({ file: `user:${u.email}`, outcome: 'created' });
  }
  return { ids, outcome: 'ok' };
}

/**
 * 第八轮 B2：被接管账号**默认不改密**（密码在上次运行的交接文件里）。只有显式列出（--rotate-passwords）且单独确认
 * （--confirm-rotate 同一列表）的账号才经 Admin PUT 改密并写进新的交接文件。
 */
async function rotateAdopted(c, adopted, handoff, results, meta) {
  if (!adopted.length) return 'ok';
  if (!canHandoff(handoff)) throw new Refused('显式改密需要交接文件（--handoff-file）');
  for (const a of adopted) {
    const password = genPassword();
    let r;
    try {
      r = await c.adminSetPassword(a.id, password);
    } catch (e) {
      // 第十二轮：PUT 已发出后收到 3xx（不跟随）→ 密码可能已被改 → 结果未知（exit 3）
      if (e instanceof Refused && !(e instanceof Redirected)) throw e;
      results.push({
        file: `user:${a.email}`,
        outcome: 'password-unknown',
        error: String(e?.message ?? e).slice(0, 160),
      });
      return 'unknown';
    }
    if (!r.ok) {
      if (!isRejection(r.status)) {
        results.push({
          file: `user:${a.email}`,
          outcome: 'password-unknown',
          error: `HTTP ${r.status}（改密请求已发出，结果未知：密码可能已被改）`,
        });
        return 'unknown';
      }
      results.push({ file: `user:${a.email}`, outcome: `password HTTP ${r.status}` });
      return 'failed';
    }
    try {
      await handoff.write(a.email, password, a.id, meta);
    } catch (e) {
      results.push({
        file: `user:${a.email}`,
        outcome: 'password-set-handoff-write-failed',
        error: fsErr(e),
      });
      return 'unknown';
    }
    results.push({ file: `user:${a.email}`, outcome: 'password-set' });
  }
  return 'ok';
}

/**
 * 第八轮 B2 显式改密请求：accounts 与 confirm 必须是同一组（非空、都是合成账号、无重复）。返回排序后的邮箱列表；没给 → []。
 * @param {{ accounts?: string[], confirm?: string[] } | undefined} r
 */
export function rotationRequest(r) {
  if (!r || (!r.accounts?.length && !r.confirm?.length)) return [];
  const norm = (l) =>
    [...new Set((l ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort();
  const a = norm(r.accounts);
  const cf = norm(r.confirm);
  if (!a.length) throw new Refused('--confirm-rotate 只能和 --rotate-passwords 一起用');
  if (JSON.stringify(a) !== JSON.stringify(cf))
    throw new Refused('显式改密需要单独确认：--confirm-rotate 必须逐字列出与 --rotate-passwords 相同的账号');
  const known = SYNTHETIC_USERS.map((u) => u.email);
  const bad = a.filter((e) => !known.includes(e));
  if (bad.length) throw new Refused(`显式改密只能针对合成账号：${bad.join(', ')}`);
  return a;
}

/** 真实目标 = injected 模式或任何非回环基址；只有本机假服务器（env-token + 回环）允许 discard */
export function isRealTarget(c) {
  if (!c || c.mode !== 'env-token') return true;
  try {
    return ![c.endpoints?.mgmtBase, c.endpoints?.projectBase].every((u) => LOOPBACK.has(new URL(u).hostname));
  } catch {
    return true;
  }
}

async function uploadFiles(c, userId, files, existing, results) {
  for (const f of files) {
    const p = `${userId}/${f.name}`;
    if (existing.some((o) => o.name === p)) {
      // 续跑：已存在 → 下载核对，内容不同就拒绝（不覆盖）
      const d = await c.download(p);
      const got = d.ok ? sha256(Buffer.from(await d.arrayBuffer())) : null;
      if (got !== f.sha256) throw new Refused(`--resume：${f.name} 已存在但内容不符（不覆盖），需人工处理`);
      results.push({ file: f.name, outcome: 'already-present', sha256: f.sha256 });
      continue;
    }
    let r;
    // 第十三轮：上传已发出后结果不确定（5xx / 其他非 2xx / 超时 / 断线 / 发出后 3xx，不跟随）→ unknown（exit 3），立即停止后续写；
    // 不自动核对后重传、不覆盖、不删除（对象可能已存在，也可能不完整）——由人工按清点 storage_objects 核对
    const unknown = (http) => {
      results.push({
        file: f.name,
        outcome: 'unknown',
        error: `${httpText(http)}（上传请求已发出，结果未知：对象可能已存储）`,
        http,
        verification: {
          conclusion: 'not-verified',
          basis: 'Storage 写后不自动核对、不重传 / 覆盖 / 删除；见清点 storage_objects，需人工核对',
        },
      });
      return 'unknown';
    };
    try {
      r = await c.upload(p, f.body);
    } catch (e) {
      if (e instanceof Refused && !(e instanceof Redirected)) throw e;
      return unknown(postSendHttp({ error: e }));
    }
    if (!r.ok) {
      const http = postSendHttp({ response: r });
      try {
        await r.text();
      } catch {
        /* 丢弃正文 */
      }
      if (!isRejection(r.status)) return unknown(http);
      results.push({
        file: f.name,
        outcome: `HTTP ${r.status}`,
        http,
        verification: { conclusion: 'rejected', basis: 'HTTP 4xx 显式拒绝（按响应未存储；未另行核对）' },
      });
      return 'failed';
    }
    results.push({ file: f.name, outcome: 'uploaded', sha256: f.sha256, http: { status: r.status } });
  }
  return 'ok';
}

/**
 * 续跑矩阵（第七轮 ④；ops/SBTEST-INIT.md §9 逐字列出，单测核对文档与代码一致）。
 * 任何「拒绝」都只是停下：不删除、不清空、不重建，交人工核对。
 */
export const RESUME_MATRIX = Object.freeze([
  { state: '没有 az_init（B0 前失败）', action: '--resume 拒绝；C0 仍为空时按全新执行' },
  { state: '账本为空（B0 已提交、无迁移）', action: '拒绝：人工核对后决定' },
  { state: '账本是清单的严格前缀', action: '从下一个迁移续跑，沿用原 run_id' },
  { state: '账本乱序 / 未知文件 / sha256 不符 / 多个 run_id', action: '拒绝：人工处理' },
  { state: '仍有 az-init 会话在运行', action: '拒绝：等会话结束后人工确认' },
  { state: 'pg_cron 已启用', action: '拒绝：状态与执行器不符' },
  { state: '迁移未完成却已有合成账号', action: '拒绝：状态矛盾' },
  {
    state: '部分账号已建（1–3 个）、种子未提交',
    action: '逐个核对后接管，补建缺的账号，再提交种子',
  },
  { state: '4 个账号已建、种子未提交', action: '全部核对后接管，不建号，提交种子' },
  {
    state: '已有账号核对不通过（运行标记缺失或不符、未确认、非 email 身份、名称不符）',
    action: '拒绝接管：人工核对，不删除账号',
  },
  { state: '种子已提交、合成账号不是 4 个', action: '拒绝：状态矛盾' },
  { state: '种子已提交、账本哈希 ≠ 期望种子哈希', action: '拒绝：人工处理（哈希不符）' },
  { state: '种子已提交、文件缺失或部分上传', action: '只补传缺的文件，再跑 V1' },
  { state: '已存在的文件内容不符', action: '拒绝：不覆盖' },
  {
    state: '被接管的已有账号（任何续跑）',
    action:
      '默认不改密；只有 --rotate-passwords 与 --confirm-rotate 逐字列出的账号才经 Admin PUT 改密并写进新交接文件',
  },
]);

/**
 * 执行：P0 目标身份 → P1 C0 → PS 项目服务准入 → B0 账本 → 0001–0019（逐文件事务 + status 核对）→ U1 账号（建 / 接管）
 *   → S1 种子 → F1 文件 → V1 验收。只有 V1 全部通过才 exit 0。
 * 写操作开始后任何非成功出口（含意外异常）都附阶段、已知结果与打码清点。从不自动重试、从不清空 / 删除 / 重建 azsou-test。
 * resume = true：按账本续跑（矩阵见 RESUME_MATRIX）。
 */
/**
 * @param {any} opts
 * @returns {Promise<any>}
 */
export async function execute(opts) {
  const ctx = {
    wrote: false,
    results: [],
    runId: opts.runId,
    attemptId: opts.attemptId ?? newAttemptId(),
    stage: 'P0',
  };
  const snap = async () => {
    try {
      return await inventory(opts.c);
    } catch (e2) {
      return { status: 'unknown', error: String(e2?.message ?? e2) };
    }
  };
  try {
    return await executeInner(opts, ctx);
  } catch (e) {
    if (!ctx.wrote) throw e;
    // 第八轮 B1：写操作开始后结果不确定 → exit 3，不再写
    if (e instanceof Uncertain) {
      const inv = await snap();
      inv.status = 'unknown';
      return {
        exit: EXIT.UNKNOWN,
        error: String(e.message).slice(0, 300),
        stage: ctx.stage,
        results: ctx.results,
        runId: ctx.runId,
        attemptId: ctx.attemptId,
        inventory: inv,
      };
    }
    // 写操作开始后被拒绝（例如项目主机 401、重定向、续跑发现内容不符）：不重试，返回拒绝 + 打码清点
    if (e instanceof Refused)
      return {
        exit: EXIT.REFUSED,
        refused: e.message,
        stage: ctx.stage,
        results: ctx.results,
        runId: ctx.runId,
        attemptId: ctx.attemptId,
        inventory: await snap(),
      };
    // 第七轮 ③：写操作开始后的意外异常（网络错误、JSON 错误……）→ 不确定，写出阶段 / 已知结果 / 清点
    const inv = await snap();
    inv.status = 'unknown';
    return {
      exit: EXIT.UNKNOWN,
      error: String(e?.message ?? e).slice(0, 300),
      stage: ctx.stage,
      results: ctx.results,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      inventory: inv,
    };
  }
}

async function executeInner(
  {
    sha,
    manifest,
    impact,
    c,
    runId,
    read = (rel) => gitShow(sha, rel),
    log = console.log,
    resume = false,
    handoff,
    rotate,
  },
  ctx,
) {
  const results = ctx.results;
  const attemptId = ctx.attemptId;
  // 第八轮 B2：真实目标（injected / 非回环）不允许丢弃账号密码——正式初始化必须用交接文件；discard 只给本机假服务器 / 演练
  if (!canHandoff(handoff)) {
    if (handoff !== undefined && handoff !== 'discard') throw new Refused(`未知交接方式 ${String(handoff)}`);
    if (isRealTarget(c))
      throw new Refused(
        '正式初始化（真实目标）不允许 --handoff discard / 不交接：必须用 --handoff-file <仓库外绝对路径>',
      );
  }
  const rotateList = rotationRequest(rotate);
  if (rotateList.length && !resume) throw new Refused('显式改密只用于 --resume 接管已有账号');
  if (rotateList.length && !canHandoff(handoff)) throw new Refused('显式改密需要交接文件（--handoff-file）');
  let wrote = false;
  const phase = (p) => {
    ctx.stage = p;
    c.setPhase?.(p);
  };
  const markWrote = () => {
    wrote = true;
    ctx.wrote = true;
  };
  const finish = async (exit, extra = {}) => {
    const out = { exit, results, runId, attemptId, stage: ctx.stage, ...extra };
    if (exit !== EXIT.OK && wrote) {
      try {
        out.inventory = await inventory(c);
      } catch (e) {
        out.inventory = { status: 'unknown', error: String(e?.message ?? e) };
      }
      if (exit === EXIT.UNKNOWN) out.inventory.status = 'unknown';
    }
    return out;
  };
  const pre = await preflight(c);
  ctx.stage = 'PS';
  // 第七轮 ①：项目服务准入必须在第一次写之前通过（全新执行与续跑都一样）
  if (!pre.service?.accepted)
    throw new NotAdmitted(pre.service?.reason ?? '项目服务凭据不接受（not accepted）');
  const shape = c0ShapeProblems(pre.c0);
  if (shape.length) throw new Refused(`C0 无效（拒绝）：${shape.join('；')}`);
  const statusSql = read('db/verify/status.sql').toString('utf8').replace(/;\s*$/, '');
  let start = 0;
  let seedDone = false;
  /** 续跑时已存在、核对通过的合成账号 */
  let adopted = [];
  if (!resume) {
    if (pre.c0_problems.length)
      throw new Refused(`预检不通过（不清空、不覆盖）：${pre.c0_problems.join('；')}`);
    phase('B0');
    markWrote();
    const b0 = await bootstrapLedger(c);
    if (b0) {
      results.push(b0);
      if (b0.outcome === 'not-committed') return finish(EXIT.FAILED, { preflight: pre });
      if (b0.outcome !== 'committed') return finish(EXIT.UNKNOWN, { preflight: pre });
    }
  } else {
    if (!pre.c0.az_init_schema) throw new Refused('--resume：az_init 不存在，没有可续跑的账本');
    if (pre.c0.cron_extension || pre.c0.cron_schema)
      throw new Refused('--resume：pg_cron 已启用，状态与执行器不符，需人工处理');
    // 第八轮 B1：n 必须是非负整数；缺失 / null / 非数字 → Uncertain（拒绝），不再经 Number(...) > 0 放行
    if (Number(await ro(c, RUNNING_SQL, 'n', isCount)) > 0)
      throw new Refused('--resume：还有 az-init 会话在运行，先人工确认');
    const st = analyzeLedger(await ro(c, LEDGER_SQL, 'ledger', isArrOrNull), manifest);
    if (st.runId !== runId) runId = st.runId;
    ctx.runId = runId;
    start = st.next;
    seedDone = st.seedDone;
    const acc = await ro(c, ACCOUNTS_BARE_SQL(), 'accounts', isArr);
    if (acc.length && start < manifest.migrations.length)
      throw new Refused(
        `--resume：迁移未完成（账本到第 ${start} 个）却已有 ${acc.length} 个合成账号——状态矛盾，需人工处理`,
      );
    const probs = acc.flatMap((a) => adoptionProblems(a, runId));
    if (probs.length)
      throw new Refused(
        `--resume：已有合成账号不能接管（需人工核对，见 ops/SBTEST-INIT.md §9；不删除账号）：${probs.join('；')}`,
      );
    if (seedDone && acc.length !== SYNTHETIC_USERS.length)
      throw new Refused(`--resume：种子已提交但合成账号只有 ${acc.length} 个——状态矛盾，需人工处理`);
    if (seedDone) {
      const led = (await ro(c, LEDGER_SQL, 'ledger', isArrOrNull)) ?? [];
      const got = led.find((r) => r.file === 'seed')?.sha256;
      if (got !== expectedSeedSha(acc, runId))
        throw new Refused('--resume：seed 账本哈希与本次种子的期望哈希不符——需人工处理（哈希不符）');
    }
    adopted = acc;
    const notAdopted = rotateList.filter((e) => !acc.some((a) => String(a.email).toLowerCase() === e));
    if (notAdopted.length)
      throw new Refused(`显式改密列出的账号不在本次接管的账号里：${notAdopted.join(', ')}`);
    if (start > 0) {
      const step = manifest.migrations[start - 1].name.slice(0, 4);
      const rows = await ro(
        c,
        `select json_agg(x) as rows from (${statusSql}) x where step <= '${step}' and not ok`,
        'rows',
        isRows,
      );
      if (rows) throw new Refused(`--resume：账本到 ${step}，但 status.sql 该步及之前有未生效项——需人工处理`);
    }
    markWrote();
    log(
      `续跑：run_id ${runId}，账本已有 ${start} 个迁移${seedDone ? ' + seed' : ''}，接管 ${adopted.length} 个已有合成账号`,
    );
  }
  for (const m of manifest.migrations.slice(start)) {
    const step = m.name.slice(0, 4);
    phase(step);
    const r = await applyOne(c, m, read(`db/migrations/${m.name}`), runId);
    results.push(r);
    log(`${r.outcome.padEnd(13)} ${m.name}${r.error ? ` — ${r.error}` : ''}`);
    if (r.outcome === 'not-committed') return finish(EXIT.FAILED, { preflight: pre });
    if (r.outcome !== 'committed') return finish(EXIT.UNKNOWN, { preflight: pre });
    if (step !== '0001') {
      // 第七轮 ③：迁移已提交后 status 查询出错（网络 / HTTP / JSON / 形状）= 状态不确定 → exit 3，不当成失败、不重试
      let rows;
      try {
        const s = await c.readOnly(
          `select json_agg(x) as rows from (${statusSql}) x where step <= '${step}' and not ok`,
        );
        if (!s.ok) throw new Error(`status 查询 HTTP ${s.status}`);
        rows = parseChecked(await s.json(), 'rows', isRows, 'status 查询');
      } catch (e) {
        if (e instanceof Refused && !(e instanceof Uncertain)) throw e;
        results.push({
          file: m.name,
          outcome: 'status-check-unknown',
          error: String(e?.message ?? e).slice(0, 200),
        });
        return finish(EXIT.UNKNOWN, { preflight: pre });
      }
      if (rows) {
        results.push({ file: m.name, outcome: 'status-check-failed', detail: rows });
        return finish(EXIT.FAILED, { preflight: pre });
      }
    }
  }
  const files = syntheticFiles();
  const ids = {};
  for (const a of adopted) {
    ids[SYNTHETIC_USERS.find((u) => u.email === a.email).key] = a.id;
    const willRotate = rotateList.includes(String(a.email).toLowerCase());
    results.push({
      file: `user:${a.email}`,
      outcome: 'adopted',
      password: willRotate ? 'rotate-requested' : 'unchanged（沿用上次交接文件里的密码）',
    });
  }
  phase('U1');
  const rot = await rotateAdopted(
    c,
    adopted.filter((a) => rotateList.includes(String(a.email).toLowerCase())),
    handoff,
    results,
    { run_id: runId, attempt_id: attemptId },
  );
  if (rot !== 'ok') return finish(rot === 'unknown' ? EXIT.UNKNOWN : EXIT.FAILED, { preflight: pre });
  if (!seedDone) {
    const missing = SYNTHETIC_USERS.filter((u) => !ids[u.key]);
    const u = await createUsers(c, missing, handoff, results, runId, attemptId);
    Object.assign(ids, u.ids);
    if (u.outcome !== 'ok')
      return finish(u.outcome === 'unknown' ? EXIT.UNKNOWN : EXIT.FAILED, { preflight: pre });
    phase('S1');
    const seed = seedTx(ids, runId);
    const s = await runTx(c, 'seed', seed.sql, runId);
    results.push(s);
    if (s.outcome === 'not-committed') return finish(EXIT.FAILED, { preflight: pre });
    if (s.outcome !== 'committed') return finish(EXIT.UNKNOWN, { preflight: pre });
  }
  phase('F1');
  const existing = resume ? await ro(c, OBJECTS_SQL, 'objects', isArr) : [];
  const f = await uploadFiles(c, ids.user, files, existing, results);
  if (f !== 'ok') return finish(f === 'unknown' ? EXIT.UNKNOWN : EXIT.FAILED, { preflight: pre });
  phase('V1');
  const v1 = await acceptV1(c, { manifest, impact, runId, statusSql, files });
  for (const x of v1.checks) log(`${x.ok ? '✓' : '✗'} ${x.id}`);
  if (!v1.ok) return finish(v1.uncertain ? EXIT.UNKNOWN : EXIT.FAILED, { preflight: pre, v1 });
  return finish(EXIT.OK, { preflight: pre, v1 });
}

/** 第十二轮：只读预检阶段（preflight 子命令 = execute 的 P0 + P1 + PS 段；PJ = 只读项目主机探测） */
const PREFLIGHT_PHASES = new Set(['P0', 'P1', 'PS', 'PJ']);
/** 写请求 = 除 GET 与 database/query/read-only 以外的任何请求（database/query、Auth Admin 建号 / 改密、Storage 上传……） */
const isWriteCall = (t) =>
  !!t && t.method !== 'GET' && t.method !== 'HEAD' && !/\/database\/query\/read-only$/.test(String(t.path));
/** 写请求按状态分：2xx 已确认；4xx 被拒（按响应未生效）；其余（0、ERR:*、3xx、5xx）结果未知 */
function writeCalls(trace) {
  const all = (trace ?? []).filter(isWriteCall);
  const ok = (s) => typeof s === 'number' && s >= 200 && s < 300;
  return {
    all,
    confirmed: all.filter((t) => ok(t.status)),
    rejected: all.filter((t) => isRejection(t.status)),
    unknown: all.filter((t) => !ok(t.status) && !isRejection(t.status)),
  };
}
/** 路径里的 uuid（用户 id、对象路径前缀）打码 */
const maskPath = (p) =>
  String(p ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => mask(m));
const SECRET_KEYS =
  'authorization|apikey|api[_-]?key|password|passwd|pwd|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|service[_-]?(?:role[_-]?)?key';
const KV_RE = new RegExp(
  `(["']?)\\b(${SECRET_KEYS})\\b\\1(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|bearer\\s+[^\\s"',;}&]+|[^\\s"',;}&]+)`,
  'gi',
);
const BARE_RE = new RegExp(`\\b(${SECRET_KEYS})\\b(\\s+)(?![:=])([^\\s"',;}&]{6,})`, 'gi');
/**
 * 第十三轮：自由文本打码——**先**在完整字符串上替换调用方给出的已知秘密值（长的先换，含 URL 编码形式），
 * 再按关键字规则打码（`key: v`、`key=v`、`"key" : "v"`、`'key': 'v w'`、Bearer、JWT、sb_ 密钥），**最后**才截断到 max。
 * 这样跨截断点的秘密也不会留下前缀。关键字规则只是第二层：回执本身只投影白名单字段，自由文本只剩核对依据等执行器自己写的话。
 * @param {unknown} v
 * @param {unknown[]} [secrets]
 * @param {number} [max]
 */
export function redactText(v, secrets = [], max = 200) {
  let s = String(v ?? '');
  const known = [
    ...new Set(
      (secrets ?? [])
        .filter((x) => x !== undefined && x !== null && String(x).length >= 4)
        .flatMap((x) => [String(x), encodeURIComponent(String(x))]),
    ),
  ].sort((a, b) => b.length - a.length);
  for (const x of known) s = s.split(x).join('[已打码]');
  s = s
    .replace(KV_RE, (_m, q, k, sep) => `${q}${k}${q}${sep}[已打码]`)
    .replace(/bearer\s+[^\s"',;}&]+/gi, '[已打码]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[已打码]')
    .replace(/\bsb[a-z]?_[\w-]{6,}/gi, '[已打码]')
    .replace(BARE_RE, (_m, k, sp) => `${k}${sp}[已打码]`);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- 第十三轮：兜底回执逐层白名单（字段名 + 类型）；不认识的字段一律丢弃，不转储
const isInt = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const SYNTH_EMAILS = new Set(SYNTHETIC_USERS.map((u) => u.email));
const MASKED_ID = /^[0-9a-f]{4}…[0-9a-f-]{2}$/i;
const SAFE_ID = /^[\w.:-]{1,80}$/;
const FILE_RE = /^(az_init|seed|\d{4}_[\w.-]{1,80}\.sql|[\w.-]{1,80}\.png|user:[\w.+-]{1,64}@example\.com)$/;
const OUTCOME_RE =
  /^(committed|not-committed|still-running|unknown|status-check-unknown|status-check-failed|created|password-set|created-handoff-write-failed|password-set-handoff-write-failed|password-unknown|adopted|uploaded|already-present|(password )?HTTP \d{3})$/;
const CONCLUSIONS = new Set([
  'committed',
  'not-committed',
  'still-running',
  'unverifiable',
  'not-verified',
  'rejected',
]);
const TRANSPORT = new Set(['timeout', 'network']);
const PHASE_RE = /^(P0|P1|PS|PJ|B0|\d{4}|U1|S1|F1|V1|INV|init)$/;
const hidden = (what) => `[${what}格式不符，已隐藏]`;
const pick = (v, ok, fallback) => (ok(v) ? v : fallback);
/** 第 ① 层：{ status, redirect_followed } 或 { error }；其余字段丢弃 */
function projectHttp(h) {
  if (!isObj(h)) return undefined;
  const o = {};
  if (typeof h.status === 'number' && Number.isInteger(h.status) && h.status >= 100 && h.status <= 599)
    o.status = h.status;
  if (h.redirect_followed === false) o.redirect_followed = false;
  if (TRANSPORT.has(h.error)) o.error = h.error;
  return Object.keys(o).length ? o : undefined;
}
/** 逐项结果 → 阶段 / 端点（由文件种类推出，不取自由文本） */
function itemPhase(file, outcome) {
  if (file === 'az_init') return 'B0';
  if (file === 'seed') return 'S1';
  if (/^\d{4}_/.test(file)) return file.slice(0, 4);
  if (file.startsWith('user:')) return 'U1';
  if (/\.png$/.test(file)) return 'F1';
  return outcome ? 'unknown' : 'unknown';
}
/** @type {Record<string, string>} */
const ENDPOINT = {
  B0: 'POST /v1/projects/{ref}/database/query',
  S1: 'POST /v1/projects/{ref}/database/query',
  MIG: 'POST /v1/projects/{ref}/database/query',
  F1: 'POST /storage/v1/object/ugc-images/{id}/{name}',
  INV: 'POST /v1/projects/{ref}/database/query/read-only',
};
function itemEndpoint(file, outcome) {
  if (file.startsWith('user:'))
    return String(outcome).startsWith('password')
      ? 'PUT /auth/v1/admin/users/{id}'
      : 'POST /auth/v1/admin/users';
  const ph = itemPhase(file, outcome);
  return ENDPOINT[ph] ?? (/^\d{4}$/.test(ph) ? ENDPOINT.MIG : 'unknown');
}
/**
 * 错误（任意文本 / 对象）→ 受控错误码 + 状态类别；从不返回原文。
 * code：http_status | redirect | timeout | network | uncertain_shape | unauthorized | E…（文件系统错误码）| other
 */
export function errorCode(v) {
  if (typeof v !== 'string') return { code: 'other', status_class: 'none' };
  const st = v.match(/\bHTTP (\d)\d\d\b/);
  const cls = st ? `${st[1]}xx` : 'none';
  const fs = v.match(/\b(E[A-Z][A-Z0-9]{2,15})\b/);
  if (/重定向|redirect/i.test(v)) return { code: 'redirect', status_class: st ? cls : '3xx' };
  if (/\b401\b/.test(v) && /HTTP 401/.test(v)) return { code: 'unauthorized', status_class: '4xx' };
  if (/client-timeout|AbortError|超时|timeout/i.test(v)) return { code: 'timeout', status_class: cls };
  if (st) return { code: 'http_status', status_class: cls };
  if (fs && !/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(fs[1]))
    return { code: fs[1], status_class: 'none' };
  if (
    /fetch failed|socket|network|ECONN|EPIPE|ENOTFOUND|EAI_AGAIN|terminated|other side closed|连接断开|无响应|UND_ERR/i.test(
      v,
    )
  )
    return { code: 'network', status_class: 'none' };
  if (/结果不确定|形状/.test(v)) return { code: 'uncertain_shape', status_class: 'none' };
  return { code: 'other', status_class: 'none' };
}
const RESULT_KEYS = ['file', 'outcome', 'http', 'verification', 'verify', 'error'];
function projectResult(x, secrets) {
  if (!isObj(x)) return undefined;
  const file = typeof x.file === 'string' && FILE_RE.test(x.file) ? x.file : hidden('文件名');
  const outcome = typeof x.outcome === 'string' && OUTCOME_RE.test(x.outcome) ? x.outcome : 'other';
  /** @type {Record<string, any>} */
  const o = { file, outcome };
  const h = projectHttp(x.http);
  if (h) o.http = h;
  if (isObj(x.verification)) {
    o.verification = {
      conclusion: pick(x.verification.conclusion, (c) => CONCLUSIONS.has(c), 'other'),
      ...(x.verification.basis !== undefined
        ? { basis: redactText(x.verification.basis, secrets, 160) }
        : {}),
    };
  }
  if (x.verify !== undefined) o.verify = redactText(x.verify, secrets, 160);
  if (x.error !== undefined)
    o.error = {
      ...errorCode(x.error),
      phase: itemPhase(file, outcome),
      endpoint: itemEndpoint(file, outcome),
    };
  return Object.fromEntries(RESULT_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
/** 清点逐项的投影规则：只认识这 5 项；每项要么 'unknown'（或无账本说明），要么按字段名 + 类型逐层投影 */
const INV_ITEMS = {
  ledger: (v) =>
    v === '（无 az_init）'
      ? v
      : Array.isArray(v)
        ? v.filter(isObj).map((r) => ({
            file: typeof r.file === 'string' && FILE_RE.test(r.file) ? r.file : hidden('文件名'),
            run_id: pick(r.run_id, (x) => typeof x === 'string' && SAFE_ID.test(x), hidden('run_id')),
            sha256: pick(
              r.sha256,
              (x) => typeof x === 'string' && /^([0-9a-f]{1,12}|n\/a)…$/.test(x),
              hidden('哈希'),
            ),
          }))
        : undefined,
  accounts: (v) =>
    Array.isArray(v)
      ? v.filter(isObj).map((a) => ({
          email: SYNTH_EMAILS.has(a.email) ? a.email : '[非合成邮箱，已隐藏]',
          id: typeof a.id === 'string' && MASKED_ID.test(a.id) ? a.id : mask(a.id),
        }))
      : undefined,
  counts: (v) =>
    isObj(v)
      ? Object.fromEntries(
          Object.entries(v).filter(([k, n]) => /^[a-z_]{1,40}\.[a-z_]{1,60}$/.test(k) && isInt(n)),
        )
      : undefined,
  storage_objects: (v) =>
    Array.isArray(v)
      ? v.filter(isObj).map((o) => ({
          name:
            typeof o.name === 'string' && /^[0-9a-f]{4}…[0-9a-f-]{2}\/[\w.-]{1,80}$/i.test(o.name)
              ? o.name
              : hidden('对象名'),
          ...(isInt(o.size) ? { size: o.size } : {}),
        }))
      : undefined,
  running_sessions: (v) => (isInt(v) ? v : undefined),
};
function projectInventory(inv) {
  if (!isObj(inv)) return null;
  const out = { status: inv.status === 'determined' ? 'determined' : 'unknown' };
  if (isObj(inv.items)) {
    const items = {};
    for (const [k, f] of Object.entries(INV_ITEMS)) {
      if (!(k in inv.items)) continue;
      const v = inv.items[k];
      items[k] = v === 'unknown' ? 'unknown' : (f(v) ?? 'unknown');
    }
    out.items = items;
  }
  if (inv.error !== undefined) out.error = { ...errorCode(inv.error), phase: 'INV', endpoint: ENDPOINT.INV };
  return out;
}
/**
 * 第十二轮 / 第十三轮：运行记录（审计记录）写入失败时的兜底回执——一行结构化 JSON，**逐层白名单**：
 * receipt / command / exit / run_id / attempt_id / phase / results（逐项只取 file、outcome、http（第 ① 层：原始 HTTP / 传输状态）、
 * verification（第 ② 层：账本 / 资源核对结论 + 依据）、verify、error（受控错误码 + 状态类别 + 阶段 + 端点，不含原文））/
 * confirmed_writes / unknown_writes（只有阶段、方法、打码路径、状态）/ inventory（按字段名 + 类型逐层投影的清点）/
 * record_write_failure（只有错误码）。任何不认识的字段（任意层）都丢弃，不转储；自由文本先替换已知秘密值再按关键字打码，最后截断。
 * 绝不包含密码、令牌、请求头、服务器原始正文、交接文件内容。
 * @param {{ command: string, exit: number, result?: any, trace?: any[], recordError: string, secrets?: string[] }} o
 */
export function fallbackReceipt({ command, exit, result, trace, recordError, secrets = [] }) {
  const w = writeCalls(trace);
  const call = (t) => ({
    phase: pick(String(t.phase ?? ''), (x) => PHASE_RE.test(x), 'unknown'),
    method: pick(String(t.method ?? ''), (x) => /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(x), 'OTHER'),
    path: redactText(maskPath(t.path), secrets, 120),
    status:
      typeof t.status === 'number'
        ? t.status
        : pick(String(t.status ?? ''), (x) => /^ERR:[A-Za-z]{1,32}$/.test(x), 'ERR:other'),
  });
  const results = (Array.isArray(result?.results) ? result.results : [])
    .map((x) => projectResult(x, secrets))
    .filter(Boolean);
  const lastPhase = [...(trace ?? [])].reverse().find((t) => t?.phase)?.phase ?? null;
  const ph = result?.stage ?? lastPhase;
  const rid = (v) =>
    v === undefined || v === null
      ? null
      : pick(v, (x) => typeof x === 'string' && SAFE_ID.test(x), hidden('id'));
  return {
    receipt: 'sbtest-run-fallback/v1',
    command: pick(String(command), (x) => /^(preflight|execute|plan|manifest)$/.test(x), 'other'),
    exit: pick(exit, (x) => Number.isInteger(x) && x >= 0 && x <= 4, null),
    run_id: rid(result?.runId),
    attempt_id: rid(result?.attemptId),
    phase: ph === null ? null : pick(String(ph), (x) => PHASE_RE.test(x), 'unknown'),
    results,
    confirmed_writes: w.confirmed.map(call),
    unknown_writes: w.unknown.map(call),
    inventory: projectInventory(result?.inventory),
    record_write_failure: { error: errorCode(String(recordError ?? '')).code },
  };
}

/**
 * 运行记录（Markdown，已打码）：只含方法 / 路径 / 状态 / 耗时，不含任何请求头、正文、令牌。
 * 第十一轮：handoff（交接与收尾说明 / 错误）与 exitCode（最终退出码）可选，单独成节，不改写上面的执行结论。
 * 第十二轮：command（'preflight' / 'execute'）可选。「写端点未调用」只针对只读预检阶段（P0 / P1 / PS / PJ），并按请求记录核对；
 * execute 记录另起一节，按本次请求记录如实列出写端点调用（已确认 / 被拒 / 结果未知）。
 * @param {{ title: string, when: string, mode: string, endpoints?: any, pre?: any, trace: any[], verdict: string,
 *   notes?: string[], handoff?: { notes?: string[], errors?: string[] }, exitCode?: number, command?: string }} o
 */
export function runRecordMarkdown({
  title,
  when,
  mode,
  endpoints,
  pre,
  trace,
  verdict,
  notes = [],
  handoff,
  exitCode,
  command,
}) {
  const L = [`# ${title}`, ''];
  const pfWrites = (trace ?? []).filter((t) => PREFLIGHT_PHASES.has(t?.phase) && isWriteCall(t)).length;
  L.push(`- 时间：${when}`);
  L.push(
    `- 执行器：scripts/sbtest/init-executor.mjs（同一执行器，preflight 子命令 = execute 的 P0 + P1 + PS 段，只读）`,
  );
  L.push(`- 凭据模式：${mode}（执行器不带 Authorization / apikey 头；凭据由 vault 按主机名在线路上注入）`);
  if (endpoints)
    L.push(`- 端点：Management API ${endpoints.mgmtBase}（允许清单）；项目 ${endpoints.projectBase}`);
  L.push(`- 结论：${verdict}`, '');
  if (pre?.target) {
    L.push('## 目标身份（GET /v1/projects/{ref}）', '', '| 项 | 值 |', '| --- | --- |');
    for (const [k, v] of Object.entries(pre.target)) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  if (pre?.scope) {
    L.push('## 令牌范围', '', `- GET /v1/projects → ${pre.scope.list_projects}：${pre.scope.verdict}`);
    L.push(
      '- 能做：GET /v1/projects/{ref}、POST /v1/projects/{ref}/database/query/read-only（以 supabase_read_only_user 执行）',
    );
    L.push(
      '- 不能 / 未尝试：列出账号下全部项目（403）',
      pfWrites === 0
        ? '- 只读预检阶段（P0 / P1 / PS）：按本次请求记录，写端点调用 0 次（database/query、Auth Admin、Storage 写在只读预检阶段一律未调用；只读预检之后的写见「写端点调用」一节）'
        : `- **只读预检阶段（P0 / P1 / PS）：按本次请求记录出现 ${pfWrites} 次写端点调用——与只读预检不符，需人工核对**`,
      '- 注意：GET /v1/projects 返回 403 不能证明令牌范围；范围只以站长提供的令牌配置记录为准',
      '',
    );
  }
  if (pre?.service) {
    L.push('## 项目服务准入（第一次写之前，只读）', '');
    L.push(
      `- 端点：${pre.service.endpoint}（需要 service_role；Auth settings / Storage 列桶成功都不算准入）`,
    );
    L.push(
      pre.service.accepted
        ? `- 结果：接受（HTTP 200，形状 ${pre.service.shape}，返回 ${pre.service.users_returned} 条；不记录用户数据）`
        : `- 结果：**不接受**——${pre.service.reason}`,
      '',
    );
  }
  if (pre?.identity) {
    L.push('## 只读身份核对', '', '| 项 | 值 |', '| --- | --- |');
    for (const [k, v] of Object.entries(pre.identity)) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  if (pre?.c0) {
    L.push('## C0 空库核对', '', '| 项 | 值 |', '| --- | --- |');
    for (const [k, v] of Object.entries(pre.c0)) L.push(`| ${k} | ${Array.isArray(v) ? v.join(', ') : v} |`);
    L.push('', `C0 问题：${pre.c0_problems?.length ? pre.c0_problems.join('；') : '无（空库）'}`, '');
  }
  L.push(
    '## 请求记录（只有方法 / 路径 / 状态 / 耗时）',
    '',
    '| # | 阶段 | 方法 | 路径 | 状态 | 耗时 ms |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  trace.forEach((t, i) =>
    L.push(`| ${i + 1} | ${t.phase} | ${t.method} | ${t.path} | ${t.status} | ${t.ms} |`),
  );
  if (command === 'execute') {
    // 第十二轮：按本次请求记录如实描述写端点调用，不沿用只读预检的措辞
    const w = writeCalls(trace);
    L.push('', '## 写端点调用（按本次请求记录）', '');
    if (!w.all.length) L.push('- 本次执行按请求记录没有发出任何写请求');
    else {
      L.push(
        `- 共 ${w.all.length} 次：已确认 ${w.confirmed.length}（2xx）；被拒 ${w.rejected.length}（4xx，按响应未生效）；结果未知 ${w.unknown.length}（无响应 / 超时 / 3xx / 5xx：可能已生效，需人工核对）`,
      );
      for (const t of w.unknown)
        L.push(
          `- 结果未知：${t.phase} ${t.method} ${maskPath(t.path)} → ${t.status}（不重试、不跟随重定向）`,
        );
    }
  }
  if (notes.length) L.push('', '## 备注', '', ...notes.map((n) => `- ${n}`));
  // 第十一轮：交接 / 清理收尾与执行结论分开记录——收尾错误不改写上面的结论、阶段、逐项结果与清点
  if (handoff && (handoff.notes?.length || handoff.errors?.length || exitCode !== undefined)) {
    L.push('', '## 交接与收尾（与执行结论分开记录，不改变上面的执行结论）', '');
    for (const n of handoff.notes ?? []) L.push(`- ${n}`);
    for (const e of handoff.errors ?? []) L.push(`- **${e}**`);
    if (!handoff.errors?.length) L.push('- 收尾错误：无');
  }
  if (exitCode !== undefined) L.push('', `- 退出码 ${exitCode}：${EXIT_MEANING[exitCode] ?? '（未定义）'}`);
  return L.join('\n') + '\n';
}

/** 退出码含义（运行记录 / 输出用；ops/SBTEST-INIT.md §10.1 同表） */
export const EXIT_MEANING = Object.freeze({
  0: '成功（V1 全部通过，交接 / 收尾无错误）',
  1: '失败（已停，原执行结论；收尾错误不改变退出码）',
  2: '拒绝（原执行结论；收尾错误不改变退出码）',
  3: '不确定（原执行结论，不重试，人工核对；收尾错误不改变退出码，绝不降成 1 或 0）',
  4: '原结论成功（execute：V1 全部通过；preflight：预检通过）但必需的交接 / 清理 / 运行记录收尾未完成——不是「完全完成」；云端写操作不需要、也不得重跑，只按收尾错误（运行记录写入失败时按兜底回执）人工处理',
});

/** execute 结果 → 运行记录备注：阶段、逐项结果（文件 / 结果，不含正文与密码）、V1、清点 */
export function executeNotes(r) {
  return [
    `run_id ${r.runId}`,
    `attempt_id ${r.attemptId ?? '（无）'}`,
    `阶段：${r.stage ?? '（无）'}`,
    ...(r.refused ? [`拒绝原因：${r.refused}`] : []),
    ...(r.error ? [`意外错误：${r.error}`] : []),
    ...(r.results ?? []).map((x) => {
      // 第十三轮：两层——①（原始 HTTP / 传输状态）；核对：②（账本 / 资源核对结论，依据）；业务结论 = outcome
      const layers = x.verification
        ? `（${x.http ? httpText(x.http) : '无 HTTP 响应'}；核对：${x.verification.conclusion}${x.verification.basis ? `，${x.verification.basis}` : ''}）`
        : '';
      return `结果 ${x.file} ${x.outcome}${layers}${x.password ? `（密码 ${x.password}）` : ''}${x.verify ? `（核对：${x.verify}）` : ''}${x.error && !x.verification ? `（${String(x.error).slice(0, 120)}）` : ''}`;
    }),
    ...(r.v1 ? r.v1.checks.map((x) => `${x.ok ? '✓' : '✗'} ${x.id}`) : []),
    ...(r.inventory ? [`清点（${r.inventory.status}）：${JSON.stringify(r.inventory.items ?? {})}`] : []),
  ];
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
  const sum = (rows) => (rows ?? []).reduce((n, r) => n + Number(r.rows), 0);
  const SEED_NOTE = {
    'public.user_bans': '显式插入 1 + profiles.banned 更新由触发器同步 1',
    'public.notifications': '回复里的 @提及 由触发器产生',
  };
  L.push('', `## 2. 迁移自带的行（迁移文件自己写入，合计 ${sum(impact.migration_rows)}）`, '');
  L.push('| 表 | 行数 | 可逆性 |', '| --- | --- | --- |');
  for (const r of impact.migration_rows) L.push(`| ${r.table} | ${r.rows} | ${r.reversible} |`);
  L.push('', '## 3. 执行器自己的账本', '');
  L.push('| 对象 | 行数 | 可逆性 |', '| --- | --- | --- |');
  L.push(
    `| schema az_init、表 az_init.applied | ${MIGRATIONS.length + 1} 行（0001–0019 + seed） | drop schema az_init cascade |`,
  );
  L.push('', '## 4. 账号及关联行（Auth Admin API，email_confirm: true，不发邮件，带运行标记）', '');
  L.push('| 邮箱 | 角色 | 可逆性 |', '| --- | --- | --- |');
  for (const u of SYNTHETIC_USERS)
    L.push(
      `| ${u.email} | ${u.role}${u.banned ? '（banned）' : ''} | DELETE /auth/v1/admin/users/<id>（级联删 profiles 及其内容；另行批准） |`,
    );
  L.push('', '| 表 | 行数 | 来源 |', '| --- | --- | --- |');
  for (const r of impact.users_rows ?? [])
    L.push(
      `| ${r.table} | ${r.rows} | ${r.table === 'public.profiles' ? '0001 的 on_auth_user_created 触发器' : 'GoTrue Admin 建号'}（本机实测） |`,
    );
  L.push(
    `| auth.identities | ${SYNTHETIC_USERS.length} | GoTrue Admin 建号时为每个账号建 1 条 email 身份（本机 shim 不计量；V1.accounts 核对 providers = email） |`,
  );
  L.push(
    '',
    '不建任何 OAuth（GitHub）身份：真实 OAuth 登录只能由 I01 人工证据证明，不能用伪造的 auth.identities 代替。',
    '',
  );
  L.push(
    `## 5. 种子新增行（单事务，本机跑同一段 SQL 的实测增量，含触发器产生的行，合计 ${sum(impact.seed_rows)}）`,
    '',
  );
  L.push('| 表 | 新增行数 | 说明 | 可逆性 |', '| --- | --- | --- | --- |');
  for (const r of impact.seed_rows ?? [])
    L.push(
      `| ${r.table} | ${r.rows} | ${SEED_NOTE[r.table] ?? '种子 SQL 显式插入'} | 按本次 run 的用户 id / 标题删除；或删用户级联（另行批准） |`,
    );
  L.push('', '## 6. 资料更新（不新增行，3 行被更新）', '');
  L.push('| 表 | 更新 | 可逆性 |', '| --- | --- | --- |');
  L.push('| public.profiles | sbtest-admin → role admin | 改回 user |');
  L.push('| public.profiles | sbtest-moderator → role moderator | 改回 user |');
  L.push('| public.profiles | sbtest-banned → banned true | 改回 false |');
  L.push('', '## 7. Storage', '');
  L.push('| 对象 | 大小 | sha256 | 可逆性 |', '| --- | --- | --- | --- |');
  L.push(
    '| 桶 ugc-images | — | — | 0010 建（已计入第 2 节 storage.buckets 1 行）；清空后 DELETE /storage/v1/bucket/ugc-images |',
  );
  for (const f of files)
    L.push(
      `| ugc-images/<测试用户 id>/${f.name} | ${f.bytes} B | ${f.sha256} | DELETE /storage/v1/object/ugc-images |`,
    );
  L.push('', '## 8. 不做的事', '');
  L.push(
    '- 不启用 pg_cron、不执行 db/ops/（调度另批）；不发任何邮件；不碰生产；不清空测试项目（预检非空即停）。',
  );
  L.push(
    '- 迁移没有 down 脚本：逐项回退按上表，回退本身另行批准；执行器与本清单都不把删除或重新创建测试项目当作回退或修复手段。',
  );
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

/** 由 CLI 参数 / 环境建客户端；injected 模式下环境里出现令牌就拒绝（不允许进程内持有凭据） */
export function clientFromEnv(argv, env, fetchImpl = fetch) {
  const mode = arg(argv, 'mode') ?? env.SBTEST_CRED_MODE ?? 'injected';
  if (mode === 'injected' && (env.SBTEST_MGMT_TOKEN || env.SBTEST_SERVICE_KEY))
    throw new Refused(
      'injected 模式：请从环境中移除 SBTEST_MGMT_TOKEN / SBTEST_SERVICE_KEY（凭据只走线路注入）',
    );
  return client({
    mode,
    token: mode === 'env-token' ? env.SBTEST_MGMT_TOKEN : undefined,
    serviceKey: mode === 'env-token' ? env.SBTEST_SERVICE_KEY : undefined,
    mgmtBase: env.SBTEST_MGMT_BASE,
    projectBase: env.SBTEST_PROJECT_BASE,
    fetchImpl,
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  let c;
  const record = (pre, verdict, notes = [], handoff = undefined, exitCode = undefined) => {
    const out = arg(argv, 'record');
    if (!out || !c) return;
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(
      out,
      runRecordMarkdown({
        command: cmd,
        title: `azsou-test ${cmd} 运行记录（已打码）`,
        when: new Date().toISOString(),
        mode: c.mode,
        endpoints: c.endpoints,
        pre,
        trace: c.trace,
        verdict,
        notes,
        handoff,
        exitCode,
      }),
    );
  };
  /** 第十一轮：写运行记录失败只作为收尾错误返回，不掩盖执行结果（第十二轮：preflight 也走这里） */
  const safeRecord = (...a) => {
    try {
      record(...a);
      return undefined;
    } catch (e) {
      return fsErr(e);
    }
  };
  /**
   * 第十二轮：运行记录写入失败 → 收尾错误 + stderr 一行白名单兜底回执（fallbackReceipt）。原退出码 1 / 2 / 3 原样保留，
   * 只有原成功才变成 4（INCOMPLETE）。返回最终退出码。
   */
  const recordFailed = (recErr, exit, result) => {
    const fin = exit === EXIT.OK ? EXIT.INCOMPLETE : exit;
    console.error(
      `✗ 收尾错误：运行记录写入失败（${recErr}）——原结论不变；下一行是打码的兜底回执（白名单字段，不含密码 / 令牌 / 请求头 / 原始响应 / 交接内容）`,
    );
    try {
      console.error(
        JSON.stringify(
          fallbackReceipt({
            command: cmd,
            exit: fin,
            result,
            trace: c?.trace ?? [],
            recordError: recErr,
            secrets: [env.SBTEST_MGMT_TOKEN, env.SBTEST_SERVICE_KEY].filter(Boolean),
          }),
        ),
      );
    } catch (e) {
      console.error(`✗ 兜底回执生成失败（${fsErr(e)}）——原结论不变`);
    }
    return fin;
  };
  /** 第十一轮：交接结论从不抛异常（handoffConclusion 内部已兜底，这里再兜一层） */
  const conclude = (handoff, evidence) => {
    try {
      return handoffConclusion(handoff, evidence);
    } catch (e) {
      return {
        n: 0,
        notes: [],
        errors: [`收尾错误：交接结论生成失败（${fsErr(e)}）——交接文件按原样保留，需人工核对`],
        deleted: false,
      };
    }
  };
  const printHandoff = (hc) => {
    for (const l of hc.notes) console.log(l);
    for (const l of hc.errors) console.error(`✗ ${l}`);
  };
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const sha = arg(argv, 'source-sha') ?? manifest.source_sha;
    if (cmd === 'manifest') {
      const m = buildManifest(sha);
      if (argv.includes('--write')) writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
      console.log(JSON.stringify(m, null, 2));
      return EXIT.OK;
    }
    if (cmd === 'preflight') {
      // 只读：P0 目标身份 + 范围记录，P1 身份 + C0；只用 GET 与 /database/query/read-only
      c = clientFromEnv(argv, env, fetchImpl);
      let pre;
      try {
        pre = await preflight(c);
      } catch (e) {
        const re = safeRecord(null, `拒绝：${e.message}`);
        if (re) recordFailed(re, e instanceof Refused ? EXIT.REFUSED : EXIT.FAILED, undefined);
        throw e;
      }
      const empty = pre.c0_problems.length === 0;
      const admitted = !!pre.service?.accepted;
      const notes = [];
      if (argv.includes('--probe-project')) {
        const pj = await probeProject(c);
        for (const [k, v] of Object.entries(pj)) notes.push(`项目主机探测 ${k} → ${v}`);
        console.log(JSON.stringify({ project_probe: pj }, null, 2));
      }
      const verdicts = [];
      if (!empty) verdicts.push(`C0 不通过：${pre.c0_problems.join('；')}`);
      if (!admitted) verdicts.push(`项目服务准入不接受：${pre.service?.reason ?? '未知'}`);
      const pfRe = safeRecord(
        pre,
        verdicts.length
          ? `拒绝（未发任何写请求）——${verdicts.join('；')}`
          : '通过：目标身份一致，C0 空库，项目服务准入接受（未发任何写请求）',
        notes,
      );
      console.log(
        JSON.stringify(
          {
            target: pre.target,
            scope: pre.scope,
            identity: pre.identity,
            c0_problems: pre.c0_problems,
            service: pre.service,
          },
          null,
          2,
        ),
      );
      const pfExit = verdicts.length ? EXIT.REFUSED : EXIT.OK;
      return pfRe ? recordFailed(pfRe, pfExit, undefined) : pfExit;
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
      // 第八轮 B2：attempt_id 每次调用新生成；全新执行的 run_id = attempt_id，续跑沿用账本里的 run_id（交接文件按实际沿用的写）
      const attemptId = newAttemptId();
      const runId = attemptId;
      const resume = argv.includes('--resume');
      // 建客户端不发请求；先确定是不是真实目标，再决定交接方式（全部在任何网络请求之前）
      const cc = clientFromEnv(argv, env, fetchImpl);
      const hf = arg(argv, 'handoff-file');
      const hm = arg(argv, 'handoff');
      const list = (v) => (v ? String(v).split(',') : []);
      const rotate = {
        accounts: list(arg(argv, 'rotate-passwords')),
        confirm: list(arg(argv, 'confirm-rotate')),
      };
      const rotateList = rotationRequest(rotate);
      if (rotateList.length && !resume) throw new Refused('--rotate-passwords 只用于 --resume');
      if (rotateList.length && !hf) throw new Refused('--rotate-passwords 需要 --handoff-file');
      let handoff;
      if (hf && hm) throw new Refused('--handoff-file 与 --handoff 只能二选一');
      if (hf) handoff = fileHandoff(hf, { attemptId });
      else if (hm === 'discard') {
        if (isRealTarget(cc))
          throw new Refused(
            '正式初始化（真实目标）不允许 --handoff discard：必须用 --handoff-file <仓库外绝对路径>（discard 只给本机假服务器 / 演练）',
          );
        handoff = 'discard';
      } else
        throw new Refused(
          'execute 必须显式选择账号密码交接：--handoff-file <仓库外绝对路径>（0600；文件里每一行都存进 vault 后才覆盖删除，才算交接完成）',
        );
      c = cc;
      const impact = JSON.parse(readFileSync(path.join(ROOT, 'ops/sbtest/init-impact.json'), 'utf8'));
      let r;
      try {
        r = await execute({ sha, manifest, impact, c, runId, attemptId, resume, handoff, rotate });
      } catch (e) {
        // 写之前就停下（execute 只在第一次写之前重新抛出）：证据 = 本次请求记录；收尾错误单列，不改变原退出码
        const hc = conclude(handoff, { trace: c.trace, results: [] });
        printHandoff(hc);
        const re = safeRecord(
          null,
          `拒绝（写之前，未发任何写请求）：${e.message}`,
          [`attempt_id ${attemptId}`],
          hc,
        );
        if (re)
          recordFailed(re, e instanceof Refused ? EXIT.REFUSED : EXIT.FAILED, {
            runId,
            attemptId,
            results: [],
          });
        throw e;
      }
      const verdict = ['成功（V1 全部通过）', '失败（已停）', '拒绝', '不确定（不重试，人工核对）'][r.exit];
      // 第十一轮：交接结论按执行证据（请求记录 + 逐项结果）下；交接 / 清理错误单列，不掩盖原执行结果。
      // 原退出码非 0（1 / 2 / 3）一律原样保留；原成功 + 必需收尾失败 → 4（INCOMPLETE）。收尾失败不重试任何写操作。
      const hc = conclude(handoff, { trace: c.trace, results: r.results });
      let exit = r.exit;
      if (exit === EXIT.OK && hc.errors.length) exit = EXIT.INCOMPLETE;
      const re = safeRecord(r.preflight, verdict, executeNotes(r), hc, exit);
      printHandoff(hc);
      if (re) exit = recordFailed(re, exit, r);
      console.log(`结果：${verdict}`);
      if (exit !== r.exit) console.error(`✗ 退出码 ${exit}：${EXIT_MEANING[exit]}`);
      return exit;
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
