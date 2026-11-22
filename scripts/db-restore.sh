#!/usr/bin/env bash
# =============================================================================
# 精确恢复（站长第三轮 2026-10-28）：把 scripts/db-backup.sh 的一份备份恢复进**空的**目标，恢复后与备份时完全一致——
#   同一 schema 版本、**不执行任何迁移**；逐范围逐表核对行数 + 内容校验和，全部一致才提交。
#   升级到更新的 schema 是另一个、必须显式调用的步骤：scripts/db-upgrade.sh（本脚本从不隐式升级）。
#
# 用法：scripts/db-restore.sh <目标连接串> <备份目录> [选项]
#   备份目录：db-backup.sh 的输出（.gpg 时用环境变量 BACKUP_PASSPHRASE 解密到临时目录；口令不进日志）
#   --accept-backup-version NNNN  备份的 schema 版本 ≠ 当前代码的最新迁移时，必须显式写出备份的版本号才继续
#                                 （否则拒绝，退出码 4）。恢复结果仍是 NNNN，不会被升级。
#   --storage-api                 Storage 文件本体经 Storage API 恢复（STORAGE_URL + STORAGE_SERVICE_KEY 指向**目标**项目）：
#                                 建桶 → 上传每个对象 → 回填 owner → 下载比对 sha256 / 清单 / 身份列校验和
#   --storage-metadata-only       只恢复 storage.buckets / objects 行（没有文件本体）。备份里有文件时也必须显式选择二者之一
#   --fresh-db NAME               <目标连接串> 是本机超级用户连接：新建库 NAME（已存在 → 拒绝）+ db/shim/plain.sql，再恢复进去
#   --drop-target-on-failure      已废除（第五轮）：失败清理只删除本次运行用 --fresh-db 新建的库（OID + 创建标记核对），
#                                 预先存在的目标永远不删；单独使用 → 拒绝（退出码 2）
#
# 事务：pre-restore（扩展）→ auth 数据 → public（结构 + 数据 + 策略）→ post-restore（auth 触发器 / 收回默认授权）→ ACL →
#   private → storage 策略（+ metadata-only 时的行）→ 核对（行数 / md5 / 行数清单 / schema 版本）全部在**一个事务**里；
#   任何错误或核对不一致 → ROLLBACK，目标保持为空。没有触发器式的「删除保护 / 回滚」：中止 = 回滚事务，必要时删掉新目标。
# 目标要求：Supabase 新项目（自带 anon / authenticated / service_role、auth、storage），或跑过 db/shim/plain.sql 的 Postgres；
#   public 里没有任何表 / 视图 / 函数、private 不存在或为空、auth.users / storage.buckets / storage.objects 为空——否则拒绝（退出码 3）。
# 永远不对生产项目 abryflgoljltyakthtql 执行。
# 退出码：0 成功；1 恢复或核对失败（已回滚）；2 用法 / 环境；3 目标非空；4 schema 版本不符且未显式确认。
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=ops/backup-lib.sh
. scripts/ops/backup-lib.sh
usage() { echo "用法：scripts/db-restore.sh <目标连接串> <备份目录> [--accept-backup-version NNNN] [--storage-api|--storage-metadata-only] [--fresh-db NAME] [--drop-target-on-failure]" >&2; exit 2; }
TARGET=${1:-}
DIR=${2:-}
[ -n "$TARGET" ] && [ -n "$DIR" ] || usage
shift 2
ACCEPT="" STORAGE_MODE="" FRESH="" DROP=0 DROP_FLAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --accept-backup-version) ACCEPT=${2:?--accept-backup-version 需要版本号}; shift 2 ;;
    --storage-api) [ -z "$STORAGE_MODE" ] || usage; STORAGE_MODE=api; shift ;;
    --storage-metadata-only) [ -z "$STORAGE_MODE" ] || usage; STORAGE_MODE=metadata; shift ;;
    --fresh-db) FRESH=${2:?--fresh-db 需要库名}; DROP=1; shift 2 ;;
    --drop-target-on-failure) DROP_FLAG=1; shift ;;
    *) echo "✗ 未知参数：$1" >&2; usage ;;
  esac
done
refuse_prod_target "$TARGET" "精确恢复"
if [ "$DROP_FLAG" = 1 ] && [ -z "$FRESH" ]; then
  # 旧版会在失败时 DROP 目标库——包括预先存在、有数据的库（tests/ops/cleanup-safety.sh C1）。现在只删本次新建的库。
  echo "✗ --drop-target-on-failure 不能单独使用：失败清理只删除本次运行用 --fresh-db 新建的库，预先存在的目标永远不删" >&2; exit 2
fi
fail() { echo "✗ $*" >&2; exit 1; }
[ -d "$DIR" ] || { echo "✗ 备份目录不存在：$DIR" >&2; exit 2; }
if [ "$DROP" = 1 ] && ! is_local_host "$(url_host "$TARGET")"; then
  echo "✗ --fresh-db / --drop-target-on-failure 只允许本机库（远程项目失败时按 docs/BACKUP.md 手动删除新项目）" >&2; exit 2
fi

W=$(mktemp -d)
AZ_OWNED_LEDGER="$W/owned.tsv"
export AZ_OWNED_LEDGER
az_run_id >/dev/null
DROP_URL="" DROP_NAME=""
on_exit() {
  rc=$?
  # 只删本次运行新建、且 OID / 创建标记仍对得上的库（scripts/ops/backup-lib.sh az_drop_owned_db）
  if [ $rc -ne 0 ] && [ -n "$DROP_NAME" ] && az_is_owned_db "$DROP_NAME"; then
    if az_drop_owned_db "$DROP_URL" "$DROP_NAME"; then echo "已中止：本次新建的目标库 $DROP_NAME 已删除" >&2
    else echo "已中止：本次新建的目标库 $DROP_NAME 没有删除（见上面的原因），请人工确认" >&2; fi
  fi
  if [ $rc -ne 0 ] && [ -s "$W/storage-created.tsv" ]; then
    node scripts/ops/storage-files.mjs cleanup "$W/storage-created.tsv" >&2 || echo "已中止：本次上传的 Storage 对象 / 新建的桶没有清理干净，请人工确认（清单 $W/storage-created.tsv 已打印在上面）" >&2
  fi
  rm -rf "$W"
  exit $rc
}
trap on_exit EXIT

# ---- 1. 取出备份（解密）并校验 ----
shopt -s nullglob
enc=("$DIR"/*.gpg)
mkdir -p "$W/b"
if [ ${#enc[@]} -gt 0 ]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "✗ 备份已加密，需要环境变量 BACKUP_PASSPHRASE" >&2; exit 2; }
  for f in "${enc[@]}"; do
    gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt --output "$W/b/$(basename "${f%.gpg}")" "$f" 3<<<"$BACKUP_PASSPHRASE" \
      || fail "解密失败：$(basename "$f")"
  done
else
  cp "$DIR"/* "$W/b/" 2>/dev/null || fail "备份目录为空"
fi
B="$W/b"
sums=("$B"/*-SHA256SUMS-*.txt)
[ ${#sums[@]} -eq 1 ] || fail "找不到唯一的 SHA256SUMS 清单"
(cd "$B" && sha256sum --quiet -c "$(basename "${sums[0]}")") || fail "校验和不一致（备份损坏或被改动）"
man=("$B"/*-manifest-*.json)
[ ${#man[@]} -eq 1 ] || fail "没有 manifest：这是旧格式备份（第三轮之前），不支持精确恢复——请用新脚本重新备份"
eval "$(python3 - "${man[0]}" <<'PY'
import json, sys, shlex
m = json.load(open(sys.argv[1]))
if m.get('format') != 2: sys.exit('manifest 格式不是 2')
s = m['scopes']; f = m['storage_files']
def out(k, v): print(f'{k}={shlex.quote(str(v))}')
out('VER', m['schema_version']); out('SNAP', m['snapshot']['id']); out('SNAPTIME', m['snapshot']['time']); out('LSN', m['snapshot']['lsn'])
out('PUB', s['public']); out('AUTH', s['auth']); out('PRIV', s.get('private', '')); out('STOR', s.get('storage', ''))
out('SBUCKETS', s.get('storage_buckets', '')); out('SLISTING', s.get('storage_listing', ''))
out('CHK', m['checksums']); out('RC', m['rowcounts'])
out('FST', f['status']); out('FOBJ', f['objects']); out('FARCH', f.get('archive', '')); out('FLIST', f.get('list', ''))
PY
)" || fail "manifest 读不出来"
for x in "$PUB" "$AUTH" "$CHK" "$RC" ${PRIV:+"$PRIV"} ${STOR:+"$STOR"} ${FARCH:+"$FARCH"} ${FLIST:+"$FLIST"}; do
  [ -s "$B/$x" ] || fail "manifest 列出的文件不在备份里：$x"
done
echo "备份：快照 $SNAP（$SNAPTIME，LSN $LSN），schema 版本 $VER，Storage 文件 $FST（$FOBJ 个对象）"

# ---- 2. schema 版本：精确恢复不升级；与当前代码不同须显式确认 ----
HEAD=$(repo_head_version "$ROOT")
if [ -n "$ACCEPT" ] && [ "$ACCEPT" != "$VER" ]; then
  echo "✗ --accept-backup-version $ACCEPT 与备份的 schema 版本 $VER 不符，拒绝" >&2; exit 4
fi
if [ "$VER" != "$HEAD" ] && [ -z "$ACCEPT" ]; then
  echo "✗ 备份的 schema 版本是 $VER，当前代码的最新迁移是 $HEAD。精确恢复会得到 $VER 的库（不会自动执行迁移）。" >&2
  echo "  确认要按 $VER 精确恢复：加 --accept-backup-version $VER；之后需要升级时另行显式运行 scripts/db-upgrade.sh。" >&2
  exit 4
fi

# ---- 3. Storage 方式 ----
if [ "$FST" = included ] && [ -z "$STORAGE_MODE" ]; then
  echo "✗ 备份里有 $FOBJ 个 Storage 文件：必须显式选择 --storage-api（恢复文件本体）或 --storage-metadata-only（只恢复行）" >&2; exit 2
fi
if [ "$FST" = skipped ] && [ "$STORAGE_MODE" != metadata ]; then
  echo "✗ 这份备份没有 Storage 文件本体（备份时 BACKUP_STORAGE_FILES=skip）：只能 --storage-metadata-only" >&2; exit 2
fi
[ -n "$STORAGE_MODE" ] || STORAGE_MODE=metadata
if [ "$STORAGE_MODE" = api ]; then
  [ -n "${STORAGE_URL:-}" ] && [ -n "${STORAGE_SERVICE_KEY:-}" ] || { echo "✗ --storage-api 需要 STORAGE_URL / STORAGE_SERVICE_KEY（目标项目）" >&2; exit 2; }
  refuse_prod_target "$STORAGE_URL" "Storage 恢复"
  [ -n "$STOR" ] || fail "备份没有 storage 范围，不能 --storage-api"
fi

# ---- 4. 目标：新建（--fresh-db）或检查为空 ----
if [ -n "$FRESH" ]; then
  [[ "$FRESH" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "✗ 库名不合法：$FRESH" >&2; exit 2; }
  crc=0
  az_create_owned_db "$TARGET" "$FRESH" || crc=$?
  case $crc in 0) ;; 3) echo "✗ 库 $FRESH 已存在：--fresh-db 只建新库（不会使用或删除已有库）" >&2; exit 3 ;; *) fail "建库 $FRESH 失败" ;; esac
  DROP_URL=$TARGET DROP_NAME=$FRESH
  TARGET=$(python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$TARGET" "$FRESH")
  psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null
fi
EMPTY_CHECK=$(cat <<'SQL'
do $$
declare n bigint; why text := '';
begin
  select count(*) into n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f');
  if n > 0 then why := why || format(' public 已有 %s 个表 / 视图 / 序列;', n); end if;
  select count(*) into n from pg_proc where pronamespace = 'public'::regnamespace;
  if n > 0 then why := why || format(' public 已有 %s 个函数;', n); end if;
  if to_regnamespace('private') is not null then
    select count(*) into n from pg_class where relnamespace = 'private'::regnamespace and relkind in ('r', 'p');
    if n > 0 then why := why || format(' private 已有 %s 张表;', n); end if;
  end if;
  if to_regclass('auth.users') is null then
    raise exception '目标不是 Supabase 项目 / 没跑过 db/shim/plain.sql（缺 auth.users）';
  end if;
  execute 'select count(*) from auth.users' into n;
  if n > 0 then why := why || format(' auth.users 已有 %s 行;', n); end if;
  if to_regclass('storage.objects') is not null then
    execute 'select count(*) from storage.objects' into n;
    if n > 0 then why := why || format(' storage.objects 已有 %s 行;', n); end if;
    execute 'select count(*) from storage.buckets' into n;
    if n > 0 then why := why || format(' storage.buckets 已有 %s 行;', n); end if;
  end if;
  if why <> '' then raise exception 'AZ_TARGET_NOT_EMPTY:%', why; end if;
end $$;
SQL
)
if ! out=$(psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -c "$EMPTY_CHECK" 2>&1); then
  if grep -q AZ_TARGET_NOT_EMPTY <<<"$out"; then
    echo "✗ 目标不是空的，精确恢复只进空目标：$(sed -n 's/.*AZ_TARGET_NOT_EMPTY://p' <<<"$out" | head -1)" >&2; exit 3
  fi
  echo "$out" | tail -3 >&2; fail "连不上目标库或目标不满足要求"
fi

# ---- 5. 生成单事务恢复脚本 ----
pg_restore -l "$B/$PUB" >"$W/pub.list" || fail "pg_restore 读不出 $PUB"
grep -vE ' SCHEMA - public | COMMENT - SCHEMA public | ACL ' "$W/pub.list" >"$W/pub-main.list" || true
{ grep -E ' ACL ' "$W/pub.list" || true; } | { grep -vE ' ACL - SCHEMA public ' || true; } >"$W/pub-acl.list"
if [ -n "$STOR" ]; then
  pg_restore -l "$B/$STOR" >"$W/stor.list" || fail "pg_restore 读不出 $STOR"
  if [ "$STORAGE_MODE" = metadata ]; then
    { grep -E ' (TABLE DATA|POLICY|ROW SECURITY) storage ' "$W/stor.list" || true; } >"$W/stor-sel.list"
  else
    { grep -E ' (POLICY|ROW SECURITY) storage ' "$W/stor.list" || true; } >"$W/stor-sel.list"
  fi
fi
status_body=$(sed -e 's/;[[:space:]]*$//' db/verify/status.sql)
S="$W/restore.sql"
{
  echo '\set ON_ERROR_STOP 1'
  echo 'begin;'
  echo 'set local client_min_messages = warning;'
  echo "$EMPTY_CHECK"
  cat db/restore/pre-restore.sql
  pg_restore --data-only --no-owner -f - "$B/$AUTH"
  pg_restore --no-owner -L "$W/pub-main.list" -f - "$B/$PUB"
  cat db/restore/post-restore.sql
  [ -s "$W/pub-acl.list" ] && pg_restore --no-owner -L "$W/pub-acl.list" -f - "$B/$PUB"
  [ -n "$PRIV" ] && pg_restore --no-owner -f - "$B/$PRIV"
  [ -n "$STOR" ] && [ -s "$W/stor-sel.list" ] && pg_restore --no-owner -L "$W/stor-sel.list" -f - "$B/$STOR"
  echo "select pg_catalog.set_config('search_path', 'public', true);"
  # Storage 经 API 恢复时，0010 的 status 检查依赖桶行（提交后才由 API 建），版本核对放到 Storage 恢复之后
  if [ "$STORAGE_MODE" = api ]; then echo "set local azsou.expected_version = 'defer';"; else echo "set local azsou.expected_version = '$VER';"; fi
  echo 'create temp table _exp (tbl text, n bigint, md5 text, cols text) on commit drop;'
  echo "\\copy _exp from '$B/$CHK'"
  echo 'create temp table _rc (tbl text, n bigint) on commit drop;'
  echo "\\copy _rc from '$B/$RC'"
  if [ "$STORAGE_MODE" = api ]; then
    # 经 API 恢复的 storage 行在提交后才写入，单独核对（身份列校验和 + 文件 sha256）
    echo "delete from _exp where tbl like 'storage.%'; delete from _rc where tbl like 'storage.%';"
  else
    echo "delete from _exp where tbl like 'storage.%#identity';"
  fi
  echo 'create temp table _got (tbl text, n bigint, md5 text) on commit drop;'
  cat <<'SQL'
select format($q$insert into _got select %L, count(*), md5(coalesce(string_agg(x, E'\n' order by x collate "C"), '')) from (select row(%s)::text as x from %s t) s$q$,
              tbl, cols, split_part(tbl, '#', 1)) from _exp order by tbl collate "C"
\gexec
SQL
  echo "create temp table _st on commit drop as $status_body;"
  cat <<'SQL'
do $$
declare bad text; ver text; fb text;
begin
  select string_agg(format('%s（备份 %s 行 / %s，恢复 %s 行 / %s）', e.tbl, e.n, left(e.md5, 8), g.n, left(g.md5, 8)), '；' order by e.tbl)
    into bad from _exp e left join _got g using (tbl)
   where g.tbl is null or g.n is distinct from e.n or g.md5 is distinct from e.md5;
  if bad is not null then raise exception '精确恢复核对失败（行数 / 内容校验和），事务回滚、目标保持为空：%', bad; end if;
  select string_agg(format('%s（清单 %s，恢复 %s）', r.tbl, r.n, g.n), '；' order by r.tbl)
    into bad from _rc r left join _got g using (tbl) where g.tbl is null or g.n is distinct from r.n;
  if bad is not null then raise exception '精确恢复核对失败（行数清单），事务回滚、目标保持为空：%', bad; end if;
  with s as (select step, bool_and(ok) ok from _st group by step)
  select min(step) filter (where not ok) into fb from s;
  with s as (select step, bool_and(ok) ok from _st group by step)
  select case
           when not bool_or(ok) then '0001'
           when fb is not null and bool_or(ok and step > fb) then 'mixed:' || string_agg(step, ',' order by step) filter (where ok)
           else max(step) filter (where ok) end
    into ver from s;
  if current_setting('azsou.expected_version') <> 'defer' and ver is distinct from current_setting('azsou.expected_version') then
    raise exception '恢复后的 schema 版本 % 与备份 % 不一致，事务回滚', ver, current_setting('azsou.expected_version');
  end if;
end $$;
\echo 核对通过（事务内）：
select format('  范围 %s：%s 张表 / %s 行，行数与内容校验和一致', split_part(tbl, '.', 1), count(*), sum(n))
  from _got where tbl not like '%#%' group by split_part(tbl, '.', 1) order by 1;
SQL
  echo 'commit;'
} >"$S"

echo "恢复中（单事务）…"
if ! psql "$TARGET" -X -q -At -v ON_ERROR_STOP=1 -f "$S" >"$W/restore.out" 2>"$W/restore.err"; then
  grep -E 'ERROR|错误|FATAL' "$W/restore.err" | head -5 >&2 || tail -5 "$W/restore.err" >&2
  fail "恢复失败：事务已回滚，目标未写入任何数据"
fi
sed -n '/^核对通过/,$p' "$W/restore.out"

# ---- 6. Storage 文件本体（API）：建桶 → 上传 → 回填 owner → 核对 ----
if [ "$STORAGE_MODE" = api ]; then
  mkdir -p "$W/files"
  if [ -n "$FARCH" ]; then tar -xf "$B/$FARCH" -C "$W/files"; else printf 'bucket\tname\tsize\tsha256\tcontent_type\tcache_control\n' >"$W/files.tsv"; FLIST=../files.tsv; fi
  STORAGE_CREATED_LEDGER="$W/storage-created.tsv" node scripts/ops/storage-files.mjs upload "$B/$SBUCKETS" "$W/files" "$B/$FLIST" || fail "Storage 恢复失败"
  psql "$TARGET" -Xq -v ON_ERROR_STOP=1 >/dev/null <<SQL || fail "回填 Storage 对象 owner 失败"
begin;
create temp table _l (bucket_id text, name text, size text, mimetype text, cache_control text, owner_id text) on commit drop;
\copy _l from '$B/$SLISTING' with (format text, header true)
update storage.objects o
   set owner_id = nullif(l.owner_id, ''),
       owner = case when l.owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then l.owner_id::uuid end
  from _l l where o.bucket_id = l.bucket_id and o.name = l.name;
commit;
SQL
  node scripts/ops/storage-files.mjs verify "$B/$FLIST" "$B/$SBUCKETS" || fail "Storage 核对失败"
  # 身份列（桶设置 / 对象名 / owner）与备份快照逐行一致
  bad=$(psql "$TARGET" -XAtq -v ON_ERROR_STOP=1 <<SQL
create temp table _exp (tbl text, n bigint, md5 text, cols text);
\copy _exp from '$B/$CHK'
delete from _exp where tbl not like 'storage.%#identity';
create temp table _got (tbl text, n bigint, md5 text);
select format(\$q\$insert into _got select %L, count(*), md5(coalesce(string_agg(x, E'\n' order by x collate "C"), '')) from (select row(%s)::text as x from %s t) s\$q\$, tbl, cols, split_part(tbl, '#', 1)) from _exp
\gexec
select string_agg(e.tbl || ' 备份 ' || e.n || ' 恢复 ' || coalesce(g.n::text, '-'), '; ') from _exp e left join _got g using (tbl)
 where g.tbl is null or g.n <> e.n or g.md5 <> e.md5;
SQL
) || fail "Storage 身份列核对失败"
  [ -z "$bad" ] || fail "Storage 身份列与备份不一致：$bad"
  echo "  范围 storage（API）：桶设置 / 对象名 / owner 与备份快照一致，文件 sha256 一致"
  now=$(psql "$TARGET" -XAt -F '|' -v ON_ERROR_STOP=1 -f db/verify/status.sql | schema_version_from_status) || fail "读不出恢复后的 schema 版本"
  [ "$now" = "$VER" ] || fail "恢复后的 schema 版本 $now 与备份 $VER 不一致"
fi
echo "✓ 精确恢复完成：schema 版本 $VER（未执行任何迁移），快照 $SNAP。需要升级到 $HEAD 时另行显式运行 scripts/db-upgrade.sh。"
