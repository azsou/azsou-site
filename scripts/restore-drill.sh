#!/usr/bin/env bash
# =============================================================================
# 恢复演练（本地 / CI）：建一个有数据的源库 → scripts/db-backup.sh 备份 →
#   A. 整库恢复：新库只跑 Supabase 环境模拟（shim）→ pg_restore 账户 + 完整 public → post-restore.sql
#   B. 换库恢复：新库跑 shim + 全部迁移 → 只导数据（--data-only --disable-triggers）
# → 逐表核对行数（源库 = A = B）、A 的策略 / 函数 / 授权与源库一致 → 以 A 为模板跑 RLS / 后台 / 回归测试。
#
# 用法：DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres scripts/restore-drill.sh
# 需要：超级用户连接、与服务器同版本或更新的 pg_dump / pg_restore / psql、node（跑 vitest）。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN=${DATABASE_URL:?需要 DATABASE_URL（超级用户）}
db_url() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$ADMIN" "$1"; }
SRC=azsou_drill_src
FULL=azsou_drill_full
DATA=azsou_drill_data
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

recreate() { psql "$ADMIN" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $1 with (force)" -c "create database $1"; }
run_sql() { psql "$(db_url "$1")" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$2" >/dev/null; }

echo "== 1. 源库：shim + 迁移 + 示例数据"
recreate $SRC
run_sql $SRC db/shim/plain.sql
for f in db/migrations/*.sql; do run_sql $SRC "$f"; done
run_sql $SRC db/restore/drill-seed.sql

echo "== 2. 备份"
BACKUP_INCLUDE_AUTH=1 BACKUP_PASSPHRASE= bash scripts/db-backup.sh "$(db_url $SRC)" "$OUT" >/dev/null
PUB=$(ls "$OUT"/azsou-public-*.dump)
AUTH=$(ls "$OUT"/azsou-auth-users-*.dump)
# 注意：不能写成 `(…) && echo`——set -e 不会因 && 链里前一条失败而退出，校验和不一致会被吞掉
(cd "$OUT" && sha256sum -c azsou-SHA256SUMS-*.txt >/dev/null) || { echo "✗ 备份校验和不一致" >&2; exit 1; }
echo "   校验和 OK：$(ls "$OUT" | tr '\n' ' ')"

echo "== 3A. 整库恢复（scripts/db-restore.sh）"
recreate $FULL
run_sql $FULL db/shim/plain.sql
bash scripts/db-restore.sh "$(db_url $FULL)" "$PUB" "$AUTH" >/dev/null

echo "== 3B. 换库恢复（迁移建结构 + 只导数据）"
recreate $DATA
run_sql $DATA db/shim/plain.sql
for f in db/migrations/*.sql; do run_sql $DATA "$f"; done
pg_restore --data-only --disable-triggers --no-owner --exit-on-error -d "$(db_url $DATA)" "$AUTH"
# 迁移已经写入的种子行（论坛种子主题、存储桶等）先清掉，再导备份里的数据
psql "$(db_url $DATA)" -Xq -v ON_ERROR_STOP=1 -c "
  do \$\$ declare t text; begin
    for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop
      execute 'truncate ' || t || ' cascade';
    end loop; end \$\$;"
pg_restore --data-only --disable-triggers --no-owner --exit-on-error -d "$(db_url $DATA)" "$PUB"

echo "== 4. 核对"
counts() {
  # ON_ERROR_STOP：任何一张表数不出来都要让演练失败，而不是少一行后两边「一致」
  psql "$(db_url "$1")" -XAt -v ON_ERROR_STOP=1 -F ' ' <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables where schemaname in ('public') order by relname
\gexec
select 'auth.users', count(*) from auth.users;
SQL
}
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
for t in $FULL $DATA; do
  counts $t > "$OUT/$t.txt"
  if diff -u "$OUT/src.txt" "$OUT/$t.txt"; then echo "   行数一致：$t（$(wc -l < "$OUT/src.txt") 张表）"; else echo "✗ 行数不一致：$t"; fail=1; fi
done
grep -q '^public.forum_threads [1-9]' "$OUT/src.txt" || { echo '✗ 源库没有数据'; fail=1; }
shape $SRC > "$OUT/src-shape.txt"
shape $FULL > "$OUT/full-shape.txt"
if diff -u "$OUT/src-shape.txt" "$OUT/full-shape.txt"; then
  echo "   结构一致：$(grep -c '^policy' "$OUT/src-shape.txt") 条策略、$(grep -c '^func' "$OUT/src-shape.txt") 个函数（含授权）、触发器、RLS 开关、表授权"
else
  echo '✗ 整库恢复后的策略 / 函数 / 授权与源库不同'; fail=1
fi
# 恢复后的库仍可正常注册（auth 触发器被 post-restore 补回）
psql "$(db_url $FULL)" -XqAt -v ON_ERROR_STOP=1 -c "insert into auth.users (email) values ('after-restore@example.com')" \
  -c "select 1 from public.profiles p join auth.users u on u.id = p.id where u.email = 'after-restore@example.com'" | grep -q 1 \
  && echo '   恢复后新用户注册正常（profiles 自动创建）' || { echo '✗ 恢复后注册触发器缺失'; fail=1; }
psql "$(db_url $FULL)" -Xq -v ON_ERROR_STOP=1 -c "delete from auth.users where email = 'after-restore@example.com'"
[ $fail = 0 ] || exit 1

echo "== 5. 以整库恢复的库（去掉演练数据，保留恢复出的结构 / 策略 / 授权）为模板跑 RLS 角色矩阵 / 后台 RPC / 回归 / P5 / P6 测试"
TPL=azsou_drill_tpl
psql "$ADMIN" -Xq -v ON_ERROR_STOP=1 -c "drop database if exists $TPL with (force)" -c "create database $TPL template $FULL"
psql "$(db_url $TPL)" -Xq -v ON_ERROR_STOP=1 <<'SQL'
delete from public.forum_replies where author in (select id from auth.users where email like 'drill-%');
delete from public.forum_threads where author in (select id from auth.users where email like 'drill-%');
delete from public.comments where author in (select id from auth.users where email like 'drill-%');
delete from public.reports where reporter in (select id from auth.users where email like 'drill-%');
delete from auth.users where email like 'drill-%';
delete from public.site_content where kind = 'setting';
delete from public.audit_log;
delete from public.rate_limit_events;
delete from public.app_reviews;
delete from public.app_download_counts;
delete from storage.objects where name like 'd0000000-%';
SQL
DB_TEST_TEMPLATE=$TPL npx vitest run -c vitest.db.config.ts \
  tests/db/rls-matrix.test.ts tests/db/admin.test.ts tests/db/regression.test.ts tests/db/p5.test.ts tests/db/p6.test.ts

psql "$ADMIN" -Xq -c "drop database if exists $SRC with (force)" -c "drop database if exists $DATA with (force)" -c "drop database if exists $FULL with (force)" -c "drop database if exists $TPL with (force)"
echo "✓ 恢复演练通过"
