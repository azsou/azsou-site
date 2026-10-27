#!/usr/bin/env bash
# =============================================================================
# 数据库备份（站长 2026-10-27 选定方案 C 的「独立加密 dump」一半；另一半是 Supabase PITR 付费附加项，待批）。
# GitHub Action（.github/workflows/db-backup.yml）与本地手动备份共用。
#
# 用法：BACKUP_PASSPHRASE=… scripts/db-backup.sh <数据库连接串> <输出目录>
#
# 强制加密：没有 BACKUP_PASSPHRASE 直接失败，什么都不导出。唯一例外是本机隔离测试库
#   （连接串主机 127.0.0.1 / localhost / ::1）并显式设置 BACKUP_ALLOW_PLAINTEXT=1——只给恢复演练 / 负面用例用，
#   生产库（远程主机）永远不可能产出明文备份。加密后再逐个确认目录里只剩 .gpg（scripts/ops/assert-encrypted.sh）。
#
# 恢复范围（每项一个文件，均进 SHA256SUMS、均加密）：
#   ① public   完整 schema（结构 + 数据 + RLS 策略 + 函数 + 触发器 + 授权 ACL），自定义格式
#   ② private  完整 schema（注册 / 社区票据密钥 app_settings、提交记录、下载事件）——存在时
#   ③ auth     auth.users + auth.identities 数据（邮箱、密码哈希、第三方登录绑定；结构由 Supabase / shim 提供）
#   ④ storage  storage.buckets + storage.objects 元数据行（**不含文件本体**，见 docs/BACKUP.md §2B「不在备份里的东西」）
#   ⑤ globals  清单：扩展（名称 / 版本 / schema）、非平台角色（无密码）、各 schema 的 RLS 开关 / 策略数 / 函数数 / 授权数
#   ⑥ schema   public 结构 SQL（gzip，便于人工对比，不用于恢复）
#   ⑦ rowcounts 每个范围每张表的行数（恢复后逐表核对）
# 环境变量：BACKUP_PREFIX=azsou 文件名前缀
# 需要 pg_dump / psql 版本 ≥ 服务器（Supabase 目前是 Postgres 17）。
# Supabase 连接串用 Session pooler（5432）或直连；pg_dump 不能走 Transaction pooler（6543）。
# =============================================================================
set -euo pipefail
URL=${1:?用法：BACKUP_PASSPHRASE=… scripts/db-backup.sh <连接串> <输出目录>}
OUT=${2:?缺少输出目录}
PREFIX=${BACKUP_PREFIX:-azsou}
HERE=$(cd "$(dirname "$0")" && pwd)

host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$URL" 2>/dev/null || true)
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  case "$host" in
    127.0.0.1 | localhost | ::1)
      if [ "${BACKUP_ALLOW_PLAINTEXT:-0}" != 1 ]; then
        echo "::error title=拒绝备份::没有 BACKUP_PASSPHRASE。本机隔离测试库如确需明文，显式设置 BACKUP_ALLOW_PLAINTEXT=1" >&2
        exit 2
      fi
      echo "注意：本机隔离库明文备份（仅限演练，BACKUP_ALLOW_PLAINTEXT=1）" ;;
    *)
      echo "::error title=拒绝备份::没有 BACKUP_PASSPHRASE——非本机库的备份必须加密（站长 2026-10-27：独立加密备份），本次未导出任何数据" >&2
      exit 2 ;;
  esac
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
cd "$OUT"

echo "pg_dump: $(pg_dump --version)"
server=$(psql "$URL" -XAtc 'show server_version' | cut -d. -f1)
client=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
if [ "$client" -lt "$server" ]; then
  echo "::error::pg_dump $client 低于服务器版本 $server，请安装 postgresql-client-$server" >&2
  exit 1
fi
has() { [ "$(psql "$URL" -XAt -v ON_ERROR_STOP=1 -c "select to_regclass('$1') is not null")" = t ]; }
has_schema() { [ "$(psql "$URL" -XAt -v ON_ERROR_STOP=1 -c "select to_regnamespace('$1') is not null")" = t ]; }

# ① public：结构 + 数据 + 策略 + 函数 + 授权
pg_dump "$URL" --schema=public --no-owner --format=custom --compress=9 --file="$PREFIX-public-$TS.dump"
# ② private（存在时）
if has_schema private; then
  pg_dump "$URL" --schema=private --no-owner --format=custom --compress=9 --file="$PREFIX-private-$TS.dump"
fi
# ③ auth：账户 + 第三方登录绑定（只导数据；结构属于 Supabase Auth 服务）
auth_tables=(--table=auth.users)
has auth.identities && auth_tables+=(--table=auth.identities)
pg_dump "$URL" "${auth_tables[@]}" --data-only --format=custom --compress=9 --file="$PREFIX-auth-$TS.dump"
# ④ storage 元数据（存在时；文件本体不在数据库里）
if has storage.buckets && has storage.objects; then
  pg_dump "$URL" --table=storage.buckets --table=storage.objects --data-only --format=custom --compress=9 \
    --file="$PREFIX-storage-$TS.dump"
fi
# ⑥ 结构 SQL（人工对比用）
pg_dump "$URL" --schema=public --schema-only --no-owner | gzip -9 >"$PREFIX-schema-$TS.sql.gz"
# ⑤ globals 清单（种类 \t 名称 \t 值）
psql "$URL" -XAt -F $'\t' -v ON_ERROR_STOP=1 >"$PREFIX-globals-$TS.tsv" <<'SQL'
select 'extension', extname, extversion || '@' || extnamespace::regnamespace::text from pg_extension order by 2;
select 'role', rolname, concat_ws(',', case when rolcanlogin then 'login' end, case when rolbypassrls then 'bypassrls' end)
  from pg_roles
 where rolname !~ '^(pg_|supabase|postgres$|authenticator$|anon$|authenticated$|service_role$|dashboard_user$|pgbouncer$|pgsodium|cli_login_postgres$)'
 order by 2;
select 'rls', n.nspname, count(*) filter (where c.relrowsecurity) || '/' || count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r' and n.nspname in ('public', 'private', 'storage') group by n.nspname order by 2;
select 'policies', schemaname, count(*)::text from pg_policies where schemaname in ('public', 'private', 'storage') group by 1, 2 order by 2;
select 'functions', n.nspname, count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private') group by 1, 2 order by 2;
select 'table_grants', table_schema, count(*)::text from information_schema.role_table_grants
 where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role') group by 1, 2 order by 2;
SQL
# ⑦ 行数清单：每个范围每张表
psql "$URL" -XAt -F $'\t' -v ON_ERROR_STOP=1 >"$PREFIX-rowcounts-$TS.tsv" <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables where schemaname in ('public', 'private') order by schemaname, relname
\gexec
select 'auth.users', count(*) from auth.users;
select format('select %L, count(*) from %s', t, t) from unnest(array['auth.identities', 'storage.buckets', 'storage.objects']) t
 where to_regclass(t) is not null
\gexec
SQL

sha256sum "$PREFIX"-*"$TS"* >"$PREFIX-SHA256SUMS-$TS.txt"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  for f in "$PREFIX"-*"$TS"*; do
    gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$f.gpg" "$f" 3<<<"$BACKUP_PASSPHRASE"
    rm -f "$f"
  done
  bash "$HERE/ops/assert-encrypted.sh" . >/dev/null
  echo "已加密（gpg AES256），目录里只有 .gpg"
fi

ls -l
echo "备份完成：$OUT"
