#!/usr/bin/env bash
# =============================================================================
# B04 / T004 迁移演练（只在隔离测试库上执行，绝不连接生产库）
#
#   DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres bash scripts/db/rehearse-migrations.sh <输出目录>
#
# 步骤：
#   1. 建「类生产」库：db/shim/plain.sql + 0001_baseline.sql（= 生产库当前结构，0002–0018 均未执行；
#      见 docs/audits/evidence/batch1/prod-status.json 的只读核对）+ 合成数据（V72 时代形状，无真实用户）
#   2. 迁移前：status.sql、各表行数、RLS 策略、表 / 函数授权快照；pg_dump 一份「迁移前备份」
#   3. 按 docs/MIGRATION.md 顺序执行 0002 → 0018（每步后 status.sql）
#   4. 迁移后：同一套快照 → 与迁移前 diff（行数必须不变；策略 / 授权差异全部列出供审计）
#   5. 幂等：再执行一遍 0017、0018，以及整套 0002 → 0018 → 快照必须与第 4 步完全一致
#   6. 回滚 / 恢复演练：把第 2 步的备份恢复到新库 → 行数与迁移前一致、status 回到迁移前
#
# 拒绝：连接串主机不是 127.0.0.1 / localhost / ::1 时直接退出（防止误连生产）。
# =============================================================================
set -euo pipefail
OUT=${1:-rehearsal-out}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${DATABASE_URL:?需要 DATABASE_URL（本地隔离 Postgres 超级用户连接）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in
  127.0.0.1 | localhost | ::1) ;;
  *) echo "拒绝执行：$host 不是本机地址。本脚本只用于隔离测试库，生产迁移按 docs/MIGRATION.md 经站长批准后手工执行。" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
NAME=azsou_rehearsal_$$
RESTORED=azsou_rehearsal_restored_$$
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
DB=$(url "$NAME")
RDB=$(url "$RESTORED")
psqlq() { psql "$1" -X -q -v ON_ERROR_STOP=1 "${@:2}"; }
run() { psqlq "$DB" -f "$1" >/dev/null; }
cleanup() {
  psqlq "$DATABASE_URL" -c "drop database if exists $NAME with (force)" -c "drop database if exists $RESTORED with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/rehearsal.txt"; }
: >"$OUT/rehearsal.txt"

# 集群级角色（与 tests/db/global-setup.ts 相同）
psqlq "$DATABASE_URL" >/dev/null <<'SQL'
do $$ declare r record; begin
  for r in select * from (values ('anon','create role anon nologin noinherit'),
    ('authenticated','create role authenticated nologin noinherit'),
    ('service_role','create role service_role nologin noinherit bypassrls'),
    ('authenticator','create role authenticator login noinherit password ''authenticator''')) t(n, ddl) loop
    if not exists (select 1 from pg_roles where rolname = r.n) then execute r.ddl; end if;
  end loop; end $$;
grant anon, authenticated, service_role to authenticator;
SQL

cleanup
psqlq "$DATABASE_URL" -c "create database $NAME" >/dev/null
log "1. 类生产库：plain shim + 0001_baseline"
run "$ROOT/db/shim/plain.sql"
run "$ROOT/db/migrations/0001_baseline.sql"
log "   合成数据（V72 形状，全部为虚构账号 / 内容）"
psqlq "$DB" >/dev/null <<'SQL'
insert into auth.users (id, email, raw_user_meta_data)
select ('00000000-0000-4000-a000-' || lpad(g::text, 12, '0'))::uuid, 'user' || g || '@example.com',
       jsonb_build_object('name', '合成用户' || g)
  from generate_series(1, 60) g;
update public.profiles set role = 'admin' where id = '00000000-0000-4000-a000-000000000001';
update public.profiles set banned = true where id = '00000000-0000-4000-a000-000000000060';
insert into public.site_content (kind, slug, data, published)
select 'setting', 'site-' || g, jsonb_build_object('n', g), true from generate_series(1, 5) g;
insert into public.forum_threads (cat, title, body, author, created_at)
select (array['技术交流','站务反馈','作品展示'])[1 + g % 3], '合成主题 ' || g, repeat('正文 ', 20),
       ('00000000-0000-4000-a000-' || lpad((1 + g % 59)::text, 12, '0'))::uuid, now() - (g || ' hours')::interval
  from generate_series(1, 40) g;
insert into public.forum_replies (thread_id, body, author)
select t.id::text, '合成回复 ' || g, ('00000000-0000-4000-a000-' || lpad((1 + g % 59)::text, 12, '0'))::uuid
  from generate_series(1, 120) g join lateral (select id from public.forum_threads order by created_at offset g % 40 limit 1) t on true;
insert into public.comments (page_key, body, author)
select 'article:post-' || (g % 15), '合成评论 ' || g, ('00000000-0000-4000-a000-' || lpad((1 + g % 59)::text, 12, '0'))::uuid
  from generate_series(1, 200) g;
SQL

snapshot() { # $1 = 库连接串 $2 = 标签
  local d=$1 tag=$2
  psqlq "$d" -A -F, -t -c "
    select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1" >"$OUT/counts-$tag.csv"
  psqlq "$d" -A -F, -t -c "select count(*) from auth.users" | sed 's/^/auth.users,/' >>"$OUT/counts-$tag.csv"
  psqlq "$d" -A -F' | ' -t -c "
    select tablename, policyname, cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '')
      from pg_policies where schemaname in ('public', 'storage') order by 1, 2" >"$OUT/policies-$tag.txt"
  psqlq "$d" -A -F' | ' -t -c "
    select table_name, grantee, privilege_type, coalesce(column_name, '*') from (
      select table_name, grantee, privilege_type, null::text as column_name from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      union all
      select table_name, grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and grantee in ('anon', 'authenticated')
         and (table_name, grantee, privilege_type) not in (select table_name, grantee, privilege_type
               from information_schema.role_table_grants where table_schema = 'public')) g order by 1, 2, 3, 4" >"$OUT/grants-$tag.txt"
  psqlq "$d" -A -F' | ' -t -c "
    select p.oid::regprocedure::text, r.rolname, p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), '')
      from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
     where p.pronamespace = 'public'::regnamespace and has_function_privilege(r.rolname, p.oid, 'execute')
     order by 1, 2" >"$OUT/function-grants-$tag.txt"
  psqlq "$d" -A -F' | ' -t -f "$ROOT/db/verify/status.sql" >"$OUT/status-$tag.txt"
}

log "2. 迁移前快照 + 备份（pg_dump -Fc，含 auth.users）"
snapshot "$DB" before
pg_dump "$DB" -Fc -n public -n auth -n private -f "$OUT/.pre-migration.dump" 2>/dev/null || pg_dump "$DB" -Fc -n public -n auth -f "$OUT/.pre-migration.dump"
sha256sum "$OUT/.pre-migration.dump" | awk '{print $1}' >"$OUT/pre-migration.sha256"

log "3. 执行 0002 → 0018（每步后 status）"
: >"$OUT/status-each-step.txt"
for f in "$ROOT"/db/migrations/00*.sql; do
  b=$(basename "$f")
  [ "$b" = 0001_baseline.sql ] && continue
  t0=$(date +%s%N)
  run "$f"
  ms=$(((($(date +%s%N) - t0)) / 1000000))
  pending=$(psqlq "$DB" -A -t -f "$ROOT/db/verify/status.sql" | awk -F'|' '$3=="f"' | wc -l)
  log "   $b 完成（${ms} ms），status 未通过项 $pending"
  echo "$b ${ms}ms pending=$pending" >>"$OUT/status-each-step.txt"
done
snapshot "$DB" after

log "4. 迁移前后差异"
diff "$OUT/counts-before.csv" "$OUT/counts-after.csv" >"$OUT/diff-counts.txt" || true
diff "$OUT/policies-before.txt" "$OUT/policies-after.txt" >"$OUT/diff-policies.txt" || true
diff "$OUT/grants-before.txt" "$OUT/grants-after.txt" >"$OUT/diff-grants.txt" || true
diff "$OUT/function-grants-before.txt" "$OUT/function-grants-after.txt" >"$OUT/diff-function-grants.txt" || true
# 原有表的行数必须一致（新表从 0 开始，不算变化）
python3 - "$OUT" <<'PY'
import csv, sys, json
out = sys.argv[1]
b = dict(csv.reader(open(f"{out}/counts-before.csv")))
a = dict(csv.reader(open(f"{out}/counts-after.csv")))
changed = {k: (b[k], a.get(k)) for k in b if a.get(k) != b[k]}
new = {k: a[k] for k in a if k not in b}
json.dump({"existing_tables_changed": changed, "new_tables": new}, open(f"{out}/counts-check.json", "w"), ensure_ascii=False, indent=1)
print("   原有表行数变化：", changed or "无")
if changed: sys.exit(3)
PY

log "5. 幂等：重跑 0017、0018，再重跑整套 0002 → 0018"
run "$ROOT/db/migrations/0017_admin_crm.sql"
run "$ROOT/db/migrations/0018_state_consistency.sql"
for f in "$ROOT"/db/migrations/00*.sql; do
  [ "$(basename "$f")" = 0001_baseline.sql ] || run "$f"
done
snapshot "$DB" rerun
idem=ok
for k in counts:csv policies:txt grants:txt function-grants:txt status:txt; do
  n=${k%%:*} e=${k##*:}
  if ! diff -q "$OUT/$n-after.$e" "$OUT/$n-rerun.$e" >/dev/null; then idem=fail; diff "$OUT/$n-after.$e" "$OUT/$n-rerun.$e" >"$OUT/diff-rerun-$n.txt" || true; fi
done
log "   重跑后快照与首次迁移后一致：$idem"
[ "$idem" = ok ] || exit 4

log "6. 回滚演练：迁移前备份恢复到新库"
psqlq "$DATABASE_URL" -c "create database $RESTORED" >/dev/null
psqlq "$RDB" -f "$ROOT/db/shim/plain.sql" >/dev/null 2>&1 || true
pg_restore -d "$RDB" --no-owner --clean --if-exists "$OUT/.pre-migration.dump" 2>"$OUT/restore-stderr.txt" || true
snapshot "$RDB" restored
if diff -q "$OUT/counts-before.csv" "$OUT/counts-restored.csv" >/dev/null && diff -q "$OUT/status-before.txt" "$OUT/status-restored.txt" >/dev/null; then
  log "   恢复后行数与 status 与迁移前一致：ok"
else
  log "   恢复后与迁移前不一致：见 diff"; diff "$OUT/counts-before.csv" "$OUT/counts-restored.csv" >"$OUT/diff-restored.txt" || true; exit 5
fi
rm -f "$OUT/.pre-migration.dump"
log "完成。生产库未连接、未改动。"
