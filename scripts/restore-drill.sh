#!/usr/bin/env bash
# =============================================================================
# 恢复演练（本地 / CI）——站长第三轮（2026-10-28）：精确恢复与显式升级分开、统一快照、无触发器式回滚。
#   1. 源库（shim + 全部迁移 + 演练数据）→ scripts/db-backup.sh **加密**备份（统一快照；每次随机口令，不落盘、不打印）
#      → 只有 .gpg → 解密核对校验和
#   2. 精确恢复（scripts/db-restore.sh --fresh-db）：新库只跑 shim，单事务恢复全部范围并在事务内逐表核对行数 + 内容校验和
#   3. 旧版本备份：源库只到 0017 → 备份 → 不带确认的精确恢复必须被拒（版本不符）→ --accept-backup-version 0017 精确恢复
#      （结果仍是 0017，未执行迁移）→ scripts/db-upgrade.sh 显式升级 0017 → 0019
#   4. 核对：源库 = 精确恢复（行数、策略 / 函数 / 授权 / 触发器 / RLS）；升级后的副本与全新 0019 库结构一致、数据行数不变
#   5. 以精确恢复的库为模板跑 RLS / 后台 / 回归测试
# 旧的「换库恢复：迁移建结构 + --disable-triggers 只导数据 + truncate 种子行」已删除（触发器被整体关掉、外键不校验）。
# Storage 文件本体的往返在 tests/ops/storage-roundtrip.sh（真实 storage-api 本地集成测试）。
#
# 用法：DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres scripts/restore-drill.sh
# 需要：超级用户连接、与服务器同版本或更新的 pg_dump / pg_restore / psql、gpg、node（跑 vitest）。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN=${DATABASE_URL:?需要 DATABASE_URL（超级用户）}
db_url() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$ADMIN" "$1"; }
SRC=azsou_drill_src
FULL=azsou_drill_full
OLD=azsou_drill_old
UPG=azsou_drill_upg
OUT=$(mktemp -d)
drop_all() { for d in $SRC $FULL $OLD $UPG azsou_drill_tpl; do psql "$ADMIN" -Xq -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done; }
trap 'rm -rf "$OUT"' EXIT

recreate() { psql "$ADMIN" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $1 with (force)" -c "create database $1"; }
run_sql() { psql "$(db_url "$1")" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$2" >/dev/null; }
drop_all

echo "== 1. 源库：shim + 迁移 + 示例数据"
recreate $SRC
run_sql $SRC db/shim/plain.sql
for f in db/migrations/*.sql; do run_sql $SRC "$f"; done
run_sql $SRC db/restore/drill-seed.sql

echo "== 2. 备份（统一快照 + 强制加密：与生产工作流同一路径）"
PASS=$(head -c 24 /dev/urandom | base64)
# 演练库没有 storage-api：文件本体由 tests/ops/storage-roundtrip.sh 覆盖，这里显式只备份 Storage 元数据
BACKUP_STORAGE_FILES=skip BACKUP_PASSPHRASE=$PASS bash scripts/db-backup.sh "$(db_url $SRC)" "$OUT/enc" >/dev/null
bash scripts/ops/assert-encrypted.sh "$OUT/enc"
mkdir -p "$OUT/plain"
for f in "$OUT"/enc/*.gpg; do
  gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt --output "$OUT/plain/$(basename "${f%.gpg}")" "$f" 3<<<"$PASS"
done
# 注意：不能写成 `(…) && echo`——set -e 不会因 && 链里前一条失败而退出，校验和不一致会被吞掉
(cd "$OUT/plain" && sha256sum -c azsou-SHA256SUMS-*.txt >/dev/null) || { echo "✗ 备份校验和不一致" >&2; exit 1; }
grep -q '"id": "[0-9A-F]*-[0-9A-F]*-[0-9]*"' "$OUT"/plain/azsou-manifest-*.json || { echo "✗ manifest 没有快照 id" >&2; exit 1; }
echo "   校验和 OK，manifest 快照 $(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(m["snapshot"]["id"], m["snapshot"]["lsn"], "schema", m["schema_version"])' "$OUT"/plain/azsou-manifest-*.json)"

echo "== 3A. 精确恢复（scripts/db-restore.sh --fresh-db：单事务 + 事务内核对）"
BACKUP_PASSPHRASE=$PASS bash scripts/db-restore.sh "$ADMIN" "$OUT/enc" --fresh-db $FULL --storage-metadata-only | sed 's/^/   /'

echo "== 3B. 旧版本备份：精确恢复（不升级）→ 显式升级"
recreate $OLD
run_sql $OLD db/shim/plain.sql
for f in db/migrations/*.sql; do
  case "$(basename "$f")" in 0018_* | 0019_*) continue ;; esac
  run_sql $OLD "$f"
done
run_sql $OLD db/restore/drill-seed.sql
BACKUP_STORAGE_FILES=skip BACKUP_PASSPHRASE=$PASS bash scripts/db-backup.sh "$(db_url $OLD)" "$OUT/old" >/dev/null
rc=0
BACKUP_PASSPHRASE=$PASS bash scripts/db-restore.sh "$ADMIN" "$OUT/old" --fresh-db $UPG --storage-metadata-only >"$OUT/refuse.txt" 2>&1 || rc=$?
[ $rc = 4 ] || { echo "✗ 0017 备份不带确认应被拒（退出码 4），实际 $rc：$(tail -2 "$OUT/refuse.txt")" >&2; exit 1; }
echo "   不带 --accept-backup-version：已拒绝（退出码 4）"
BACKUP_PASSPHRASE=$PASS bash scripts/db-restore.sh "$ADMIN" "$OUT/old" --fresh-db $UPG --storage-metadata-only --accept-backup-version 0017 | tail -1 | sed 's/^/   /'
v=$(psql "$(db_url $UPG)" -XAt -F '|' -v ON_ERROR_STOP=1 -f db/verify/status.sql | bash -c '. scripts/ops/backup-lib.sh; schema_version_from_status')
[ "$v" = 0017 ] || { echo "✗ 精确恢复后版本应仍为 0017，实际 $v（恢复脚本不得隐式迁移）" >&2; exit 1; }
echo "   精确恢复后 schema 版本仍为 0017（未执行迁移）"
bash scripts/db-upgrade.sh "$(db_url $UPG)" --from 0017 --to 0019 --apply-migrations | sed 's/^/   /'
unset PASS

echo "== 4. 核对"
counts() {
  # ON_ERROR_STOP：任何一张表数不出来都要让演练失败，而不是少一行后两边「一致」
  psql "$(db_url "$1")" -XAt -v ON_ERROR_STOP=1 -F ' ' <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables where schemaname in ('public', 'private') order by schemaname, relname
\gexec
select 'auth.users', count(*) from auth.users;
select 'auth.identities', count(*) from auth.identities;
select 'storage.buckets', count(*) from storage.buckets;
select 'storage.objects', count(*) from storage.objects;
SQL
}
# 按范围汇总一份 counts 输出：范围 表数 行数
by_scope() { awk '{split($1, a, "."); t[a[1]]++; r[a[1]] += $2} END {for (k in t) printf "%s %d %d\n", k, t[k], r[k]}' "$1" | sort; }
shape() {
  psql "$(db_url "$1")" -XAt -v ON_ERROR_STOP=1 <<'SQL'
select 'policy ' || tablename || '.' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
  from pg_policies where schemaname = 'public'
union all
select 'func ' || p.oid::regprocedure::text || ' definer=' || p.prosecdef || ' acl=' || coalesce(array_to_string(array(select unnest(p.proacl)::text order by 1), ','), '')
  from pg_proc p where p.pronamespace = 'public'::regnamespace
union all
select 'rls ' || relname || ' ' || relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
union all
select 'grant ' || grantee || ' ' || table_name || ' ' || privilege_type
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')
union all
select 'trigger ' || event_object_schema || '.' || event_object_table || ' ' || trigger_name
  from information_schema.triggers where event_object_schema in ('public', 'auth')
order by 1
SQL
}
fail=0
counts $SRC > "$OUT/src.txt"
for t in $FULL; do
  counts $t > "$OUT/$t.txt"
  if diff -u "$OUT/src.txt" "$OUT/$t.txt"; then
    echo "   行数一致：$t（$(wc -l < "$OUT/src.txt") 张表）"
    by_scope "$OUT/$t.txt" | while read -r sc nt nr; do echo "     范围 $sc：$nt 张表 / $nr 行"; done
  else echo "✗ 行数不一致：$t"; fail=1; fi
done
grep -q '^public.forum_threads [1-9]' "$OUT/src.txt" || { echo '✗ 源库没有数据'; fail=1; }
# 每个范围都必须有数据，否则「一致」没有意义
for k in auth.identities private.app_settings storage.buckets storage.objects; do
  grep -qE "^$k [1-9]" "$OUT/src.txt" || { echo "✗ 源库 $k 没有数据（演练覆盖不到该范围）"; fail=1; }
done
shape $SRC > "$OUT/src-shape.txt"
shape $FULL > "$OUT/full-shape.txt"
if diff -u "$OUT/src-shape.txt" "$OUT/full-shape.txt"; then
  echo "   结构一致：$(grep -c '^policy' "$OUT/src-shape.txt") 条策略、$(grep -c '^func' "$OUT/src-shape.txt") 个函数（含授权）、触发器、RLS 开关、表授权"
else
  echo '✗ 精确恢复后的策略 / 函数 / 授权与源库不同'; fail=1
fi
# 旧版本备份 → 精确恢复 → 显式升级：数据行数与 0017 源库一致（源库有的表），结构与全新 0019 源库一致
counts $OLD > "$OUT/old.txt"
counts $UPG > "$OUT/upg.txt"
if join <(sort "$OUT/old.txt") <(sort "$OUT/upg.txt") | awk '$2 != $3 {bad = 1; print "  " $0} END {exit bad}' \
  && [ "$(wc -l <"$OUT/old.txt")" -le "$(join <(sort "$OUT/old.txt") <(sort "$OUT/upg.txt") | wc -l)" ]; then
  echo "   升级副本：0017 源库的 $(wc -l <"$OUT/old.txt") 张表行数全部保留"
else echo '✗ 升级副本的数据行数与 0017 源库不一致'; fail=1; fi
shape $UPG > "$OUT/upg-shape.txt"
if diff -u "$OUT/src-shape.txt" "$OUT/upg-shape.txt"; then
  echo "   升级副本结构与全新 0019 库一致（策略 / 函数 / 授权 / 触发器 / RLS）"
else echo '✗ 0017 精确恢复 + 显式升级后的结构与全新 0019 库不同'; fail=1; fi
# 恢复后的库仍可正常注册（auth 触发器被 post-restore 补回）
psql "$(db_url $FULL)" -XqAt -v ON_ERROR_STOP=1 -c "insert into auth.users (email) values ('after-restore@example.com')" \
  -c "select 1 from public.profiles p join auth.users u on u.id = p.id where u.email = 'after-restore@example.com'" | grep -q 1 \
  && echo '   恢复后新用户注册正常（profiles 自动创建）' || { echo '✗ 恢复后注册触发器缺失'; fail=1; }
psql "$(db_url $FULL)" -Xq -v ON_ERROR_STOP=1 -c "delete from auth.users where email = 'after-restore@example.com'"
[ $fail = 0 ] || exit 1

echo "== 5. 以精确恢复的库（去掉演练数据，保留恢复出的结构 / 策略 / 授权）为模板跑 RLS 角色矩阵 / 后台 RPC / 回归 / P5 / P6 测试"
TPL=azsou_drill_tpl
psql "$ADMIN" -Xq -v ON_ERROR_STOP=1 -c "drop database if exists $TPL with (force)" -c "create database $TPL template $FULL"
psql "$(db_url $TPL)" -Xq -v ON_ERROR_STOP=1 <<'SQL'
delete from public.forum_replies where author in (select id from auth.users where email like 'drill-%');
delete from public.forum_threads where author in (select id from auth.users where email like 'drill-%');
delete from public.comments where author in (select id from auth.users where email like 'drill-%');
delete from public.reports where reporter in (select id from auth.users where email like 'drill-%');
delete from auth.users where email like 'drill-%';
delete from private.app_settings where key = 'drill_secret';
delete from public.site_content where kind = 'setting';
delete from public.audit_log;
delete from public.rate_limit_events;
delete from public.app_reviews;
delete from public.app_download_counts;
delete from storage.objects where name like 'd0000000-%';
SQL
DB_TEST_TEMPLATE=$TPL npx vitest run -c vitest.db.config.ts \
  tests/db/rls-matrix.test.ts tests/db/admin.test.ts tests/db/regression.test.ts tests/db/p5.test.ts tests/db/p6.test.ts

drop_all
echo "✓ 恢复演练通过"
