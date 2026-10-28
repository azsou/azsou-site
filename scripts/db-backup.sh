#!/usr/bin/env bash
# =============================================================================
# 数据库 + Storage 备份（站长 2026-10-27 方案 C 的「独立加密 dump」一半；PITR 付费附加项另批）。
# 站长第三轮（2026-10-28）：统一快照、Storage 文件本体纳入恢复范围。
# 受保护的手动工作流（.github/workflows/db-backup.yml）与本地手动备份共用。
#
# 用法：BACKUP_PASSPHRASE=… scripts/db-backup.sh <数据库连接串> <输出目录>
#
# 统一快照：先开一个 REPEATABLE READ READ ONLY 事务并 pg_export_snapshot()，整个备份期间一直持有；
#   public / private / auth / storage 元数据四个 pg_dump 都用 --snapshot=<同一个快照>，
#   行数清单、逐表校验和、schema 版本、globals、Storage 对象清单也都在 SET TRANSACTION SNAPSHOT 的同一快照里读。
#   → 所有范围是同一时刻的数据；备份期间的并发写入要么全部可见、要么全部不可见，不会出现跨范围不一致。
#   快照 id、LSN、快照时间写进 manifest；Storage 文件清单就是这个快照里的 storage.objects，清单时间 = 快照时间。
#
# 强制加密：没有 BACKUP_PASSPHRASE 直接失败，什么都不导出。唯一例外：本机隔离测试库（127.0.0.1 / localhost / ::1）
#   且显式 BACKUP_ALLOW_PLAINTEXT=1（只给恢复演练 / 负面用例）。加密后逐个确认目录里只剩 .gpg。
# 生产项目（abryflgoljltyakthtql）：只在受保护环境 backup-production 里运行（环境变量 BACKUP_ENVIRONMENT_GUARD=backup-production
#   只在该环境里由站长配置）；否则拒绝。真正的闸门是该环境的「必需审批人」。
#
# 产物（每项一个文件，均进 SHA256SUMS、均加密）：
#   manifest     JSON：格式版本、备份时间、快照 id / LSN / 快照时间、服务器版本、schema 版本、各范围文件、Storage 文件统计
#   public       完整 schema（结构 + 数据 + RLS 策略 + 函数 + 触发器 + ACL），自定义格式
#   private      完整 schema（存在时）
#   auth         auth.users + auth.identities 数据
#   storage      storage.buckets + storage.objects（结构 + 数据；恢复时取行与 RLS 策略）
#   storage-buckets / storage-listing   快照里的桶与对象清单（TSV）
#   storage-files.tsv + storage-files.tar   对象文件本体与逐对象 sha256（经 Storage API 下载）
#   checksums    每个范围每张表：行数 + 内容 md5（列顺序固定、按 C 排序）+ 参与计算的列
#   rowcounts / globals / schema（public 结构 SQL，人工对比用）
#
# Storage 文件本体需要 STORAGE_URL（https://<ref>.supabase.co/storage/v1）+ STORAGE_SERVICE_KEY（service_role，Secret 注入）。
#   快照里有对象却没给这两个 → 失败（不会产出缺文件的备份）。只有显式 BACKUP_STORAGE_FILES=skip 才只备份元数据，
#   manifest 记 storage_files.status = "skipped"，恢复时必须显式 --storage-metadata-only。
# 需要 pg_dump / psql ≥ 服务器版本（Supabase 目前 Postgres 17）。连接串用 Session pooler（5432）或直连，不能用 6543。
# =============================================================================
set -euo pipefail
URL=${1:?用法：BACKUP_PASSPHRASE=… scripts/db-backup.sh <连接串> <输出目录>}
OUT=${2:?缺少输出目录}
PREFIX=${BACKUP_PREFIX:-azsou}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# shellcheck source=ops/backup-lib.sh
. "$HERE/ops/backup-lib.sh"

host=$(url_host "$URL")
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if is_local_host "$host"; then
    if [ "${BACKUP_ALLOW_PLAINTEXT:-0}" != 1 ]; then
      echo "::error title=拒绝备份::没有 BACKUP_PASSPHRASE。本机隔离测试库如确需明文，显式设置 BACKUP_ALLOW_PLAINTEXT=1" >&2
      exit 2
    fi
    echo "注意：本机隔离库明文备份（仅限演练，BACKUP_ALLOW_PLAINTEXT=1）"
  else
    echo "::error title=拒绝备份::没有 BACKUP_PASSPHRASE——非本机库的备份必须加密（站长 2026-10-27：独立加密备份），本次未导出任何数据" >&2
    exit 2
  fi
fi
if url_mentions_prod "$URL" && [ "${BACKUP_ENVIRONMENT_GUARD:-}" != backup-production ]; then
  echo "::error title=拒绝备份::生产项目 $AZ_PROD_REF 只能在受保护环境 backup-production（必需审批人）里备份；本次未连接" >&2
  exit 2
fi
HOLD=""
if [ -n "${BACKUP_TEST_HOLD_DIR:-}" ]; then
  is_local_host "$host" || { echo "::error::BACKUP_TEST_HOLD_DIR 只允许本机测试库" >&2; exit 2; }
  HOLD=$BACKUP_TEST_HOLD_DIR
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
# 先写进输出目录下的临时目录，全部成功（且加密）后才移出来；任何失败都删掉临时目录——不留半份 / 明文产物
STAGE=$(mktemp -d "$OUT/.staging.XXXXXX")
cd "$STAGE"
STMP=$(mktemp -d)
SNAP_PID=""
cleanup() {
  [ -n "$SNAP_PID" ] && kill "$SNAP_PID" 2>/dev/null || true
  rm -rf "$STMP" "$STAGE"
}
trap cleanup EXIT

echo "pg_dump: $(pg_dump --version)"
server=$(psql "$URL" -XAtc 'show server_version' | cut -d. -f1)
client=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
if [ "$client" -lt "$server" ]; then
  echo "::error::pg_dump $client 低于服务器版本 $server，请安装 postgresql-client-$server" >&2
  exit 1
fi

# ---- 统一快照：持有事务的 psql 会话（协进程），备份结束才提交 ----
coproc SNAPSQL { exec psql "$URL" -XAtq -v ON_ERROR_STOP=1 2>&1; }
SNAP_PID=$SNAPSQL_PID
printf '%s\n' "begin isolation level repeatable read read only;" \
  "select pg_export_snapshot(), (case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end)::text, to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), current_setting('server_version');" \
  >&"${SNAPSQL[1]}"
IFS='|' read -r -t 60 SNAP LSN SNAPTIME SVER <&"${SNAPSQL[0]}" || { echo "::error::导出快照失败" >&2; exit 1; }
case "$SNAP" in [0-9A-F]*-*-*) ;; *) echo "::error::导出快照失败：$SNAP" >&2; exit 1 ;; esac
echo "统一快照：$SNAP（LSN $LSN，$SNAPTIME）"
# 在同一快照里执行 SQL（-c / -f 按顺序在一个会话里执行）
in_snap() { psql "$URL" -XAtq -v ON_ERROR_STOP=1 -F $'\t' -c "begin isolation level repeatable read read only" -c "set transaction snapshot '$SNAP'" "$@" -c commit; }
q1() { in_snap -c "$1"; }
has() { [ "$(q1 "select to_regclass('$1') is not null")" = t ]; }
has_schema() { [ "$(q1 "select to_regnamespace('$1') is not null")" = t ]; }
dump() { pg_dump "$URL" --snapshot="$SNAP" "$@"; }

# ① public
dump --schema=public --no-owner --format=custom --compress=9 --file="$PREFIX-public-$TS.dump"
if [ -n "$HOLD" ]; then # 测试钩子：快照已导出、第一个范围已导出；等测试在中间提交跨范围写入
  touch "$HOLD/ready"
  for _ in $(seq 1 120); do [ -e "$HOLD/go" ] && break; sleep 0.5; done
  [ -e "$HOLD/go" ] || { echo "::error::测试钩子超时" >&2; exit 1; }
fi
# ② private
HAS_PRIVATE=false
if has_schema private; then
  HAS_PRIVATE=true
  dump --schema=private --no-owner --format=custom --compress=9 --file="$PREFIX-private-$TS.dump"
fi
# ③ auth 数据
auth_tables=(--table=auth.users)
has auth.identities && auth_tables+=(--table=auth.identities)
dump "${auth_tables[@]}" --data-only --format=custom --compress=9 --file="$PREFIX-auth-$TS.dump"
# ④ storage 表（结构 + 数据 + RLS 策略）
HAS_STORAGE=false
if has storage.buckets && has storage.objects; then
  HAS_STORAGE=true
  dump --table=storage.buckets --table=storage.objects --no-owner --format=custom --compress=9 --file="$PREFIX-storage-$TS.dump"
fi
# ⑥ 结构 SQL（人工对比用）
dump --schema=public --schema-only --no-owner | gzip -9 >"$PREFIX-schema-$TS.sql.gz"
# schema 版本（status.sql 在同一快照里）
# 不是本站结构的库（status.sql 引用的表不存在）记为 unknown：备份照做，精确恢复时必须显式 --accept-backup-version unknown
if ! SCHEMA_VERSION=$(in_snap -F '|' -f "$ROOT/db/verify/status.sql" 2>"$STMP/status.err" | schema_version_from_status); then
  SCHEMA_VERSION=unknown
  echo "注意：db/verify/status.sql 在这个库上执行失败（$(grep -m1 ERROR "$STMP/status.err" || true)），schema 版本记为 unknown"
fi
echo "schema 版本：$SCHEMA_VERSION"
# ⑤ globals 清单（种类 \t 名称 \t 值）
in_snap >"$PREFIX-globals-$TS.tsv" -f - <<'SQL'
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
# ⑦ 行数 + 逐表内容校验和（同一快照）
in_snap >"$PREFIX-checksums-$TS.tsv" -f "$ROOT/db/restore/checksums.sql"
awk -F'\t' '$1 !~ /#/ {print $1 "\t" $2}' "$PREFIX-checksums-$TS.tsv" >"$PREFIX-rowcounts-$TS.tsv"
# ⑧ Storage 桶与对象清单（同一快照 = 清单时间与数据库一致）
OBJECTS=0
if [ "$HAS_STORAGE" = true ]; then
  in_snap -c "do \$\$ begin if exists (select 1 from storage.objects where name ~ '[[:cntrl:]]' or bucket_id ~ '[[:cntrl:]]') then
                raise exception '对象名含控制字符（制表符 / 换行），无法写入清单'; end if; end \$\$" >/dev/null
  { printf 'id\tname\tpublic\tfile_size_limit\tallowed_mime_types\n'
    in_snap -c "select id, name, public, coalesce(file_size_limit::text, ''), coalesce(to_json(allowed_mime_types)::text, '') from storage.buckets order by id collate \"C\""
  } >"$PREFIX-storage-buckets-$TS.tsv"
  { printf 'bucket_id\tname\tsize\tmimetype\tcache_control\towner_id\n'
    in_snap -c "select bucket_id, name, coalesce(metadata->>'size', ''), coalesce(metadata->>'mimetype', ''), coalesce(metadata->>'cacheControl', ''), coalesce(owner_id, owner::text, '') from storage.objects order by bucket_id collate \"C\", name collate \"C\""
  } >"$PREFIX-storage-listing-$TS.tsv"
  # 第五轮 ②：同一快照里每个对象的 eTag / lastModified / updated_at / version——下载时据此发现快照之后的**同尺寸改写**
  { printf 'bucket_id\tname\tsize\tetag\tlast_modified\tupdated_at\tversion\n'
    in_snap -c "select bucket_id, name, coalesce(metadata->>'size', ''), coalesce(metadata->>'eTag', ''), coalesce(metadata->>'lastModified', ''), coalesce(to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ''), coalesce(to_jsonb(o)->>'version', '') from storage.objects o order by bucket_id collate \"C\", name collate \"C\""
  } >"$PREFIX-storage-etags-$TS.tsv"
  OBJECTS=$(($(wc -l <"$PREFIX-storage-listing-$TS.tsv") - 1))
fi
# 数据库部分全部读完：释放快照
printf 'commit;\n' >&"${SNAPSQL[1]}"
snap_fd=${SNAPSQL[1]}
eval "exec ${snap_fd}>&-"
wait "$SNAP_PID" || { echo "::error::快照会话异常结束" >&2; exit 1; }
SNAP_PID=""

# ⑨ Storage 文件本体（按快照清单下载；快照之后被删 / 改——包括大小不变的同尺寸改写（eTag / md5 / Last-Modified 对不上）→ 失败）
FILES_STATUS=none
FILES_BYTES=0
if [ "$OBJECTS" -gt 0 ]; then
  if [ -n "${STORAGE_URL:-}" ] && [ -n "${STORAGE_SERVICE_KEY:-}" ]; then
    node "$HERE/ops/storage-files.mjs" download "$PREFIX-storage-listing-$TS.tsv" "$STMP/files" "$PREFIX-storage-files-$TS.tsv" "$PREFIX-storage-etags-$TS.tsv"
    tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf "$PREFIX-storage-files-$TS.tar" -C "$STMP/files" .
    rm -rf "$STMP/files"
    FILES_STATUS=included
    FILES_BYTES=$(awk -F'\t' 'NR > 1 {s += $3} END {print s + 0}' "$PREFIX-storage-files-$TS.tsv")
  elif [ "${BACKUP_STORAGE_FILES:-}" = skip ]; then
    FILES_STATUS=skipped
    echo "注意：快照里有 $OBJECTS 个 Storage 对象，BACKUP_STORAGE_FILES=skip——只备份元数据，文件本体不在本备份里"
  else
    echo "::error title=拒绝备份::快照里有 $OBJECTS 个 Storage 对象，但没有 STORAGE_URL / STORAGE_SERVICE_KEY——不产出缺文件的备份（只要元数据须显式 BACKUP_STORAGE_FILES=skip）" >&2
    exit 3
  fi
fi

# ⑩ manifest
M_TS=$TS M_STARTED=$STARTED M_SNAP=$SNAP M_LSN=$LSN M_SNAPTIME=$SNAPTIME M_SVER=$SVER M_VER=$SCHEMA_VERSION \
  M_PREFIX=$PREFIX M_PRIV=$HAS_PRIVATE M_STOR=$HAS_STORAGE M_OBJ=$OBJECTS M_FST=$FILES_STATUS M_FB=$FILES_BYTES \
  python3 - >"$PREFIX-manifest-$TS.json" <<'PY'
import json, os
e = os.environ
p, ts = e['M_PREFIX'], e['M_TS']
f = lambda k: f'{p}-{k}-{ts}'
scopes = {'public': f('public') + '.dump', 'auth': f('auth') + '.dump'}
if e['M_PRIV'] == 'true': scopes['private'] = f('private') + '.dump'
if e['M_STOR'] == 'true':
    scopes['storage'] = f('storage') + '.dump'
    scopes['storage_buckets'] = f('storage-buckets') + '.tsv'
    scopes['storage_listing'] = f('storage-listing') + '.tsv'
    scopes['storage_etags'] = f('storage-etags') + '.tsv'
files = {'status': e['M_FST'], 'objects': int(e['M_OBJ']), 'bytes': int(e['M_FB'])}
if e['M_FST'] == 'included':
    files['archive'] = f('storage-files') + '.tar'
    files['list'] = f('storage-files') + '.tsv'
print(json.dumps({
    'format': 2,
    'prefix': p, 'stamp': ts,
    'started_at': e['M_STARTED'],
    'snapshot': {'id': e['M_SNAP'], 'lsn': e['M_LSN'], 'time': e['M_SNAPTIME'], 'isolation': 'repeatable read read only',
                 'shared_by': ['public', 'private', 'auth', 'storage', 'checksums', 'rowcounts', 'globals', 'schema_version', 'storage_listing', 'storage_etags']},
    'storage_listing_time': e['M_SNAPTIME'],
    'server_version': e['M_SVER'],
    'schema_version': e['M_VER'],
    'scopes': scopes,
    'checksums': f('checksums') + '.tsv', 'rowcounts': f('rowcounts') + '.tsv', 'globals': f('globals') + '.tsv',
    'storage_files': files,
}, ensure_ascii=False, indent=2))
PY

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

# 不覆盖输出目录里已有的文件（-n）；移完核对每个文件都到位（预先存在的同名文件会让这里失败，而不是被覆盖）
for f in "$STAGE"/*; do
  [ ! -e "$OUT/$(basename "$f")" ] || { echo "::error::输出目录里已有同名文件 $(basename "$f")，不覆盖" >&2; exit 1; }
  mv -n "$f" "$OUT"/
done
cd "$OUT"
ls -l
echo "备份完成：$OUT（快照 $SNAP，schema $SCHEMA_VERSION，Storage 文件 $FILES_STATUS / $OBJECTS 个对象）"
