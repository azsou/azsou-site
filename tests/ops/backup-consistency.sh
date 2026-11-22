#!/usr/bin/env bash
# =============================================================================
# 站长第三轮 ②：统一快照的一致性测试（本机隔离库）。
#   源库（shim + 全部迁移）上一边持续跑「跨范围写入」事务（同一事务里写 auth.users → 触发器建 public.profiles、
#   private.app_settings、storage.objects、public.audit_log），一边用 scripts/db-backup.sh 备份；
#   另用测试钩子 BACKUP_TEST_HOLD_DIR 在「快照已导出、public 已导出、其余范围还没导出」时确定性地提交一条跨范围标记事务。
# 断言（精确恢复后的库）：
#   C1 标记事务在源库里已提交，但在恢复库的**任何**范围里都不存在（它晚于快照）
#   C2 后台写入的每个编号要么在 auth / profiles / private / storage / audit 五处同时存在，要么都不存在
#   C3 后台写入在备份期间确实在跑（源库最终编号数 > 恢复库编号数 > 0）
#   C4 manifest 有快照 id / LSN / 时间，Storage 清单时间 = 快照时间，清单对象数 = 恢复库 storage.objects 行数
# 对照组（证明 C1/C2 检测得出问题）：不共享快照的「逐个 pg_dump」在同一位置插入标记 → 恢复后必然跨范围不一致，检测必须报错。
#
#   DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres bash tests/ops/backup-consistency.sh
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${DATABASE_URL:?需要 DATABASE_URL（本机隔离 Postgres 超级用户）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in 127.0.0.1 | localhost | ::1) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
SRC=azsou_cons_src
DST=azsou_cons_dst
NAIVE=azsou_cons_naive
W=$(mktemp -d)
WRITER=""
cleanup() {
  [ -n "$WRITER" ] && kill "$WRITER" 2>/dev/null || true
  for d in $SRC $DST $NAIVE; do psql "$DATABASE_URL" -Xqc "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  rm -rf "$W"
}
trap cleanup EXIT
q() { psql "$1" -XAt -v ON_ERROR_STOP=1 -c "$2"; }
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }

# 一条跨范围写入事务（编号 $2）
xwrite() {
  psql "$1" -Xq -v ON_ERROR_STOP=1 >/dev/null <<SQL
begin;
with u as (insert into auth.users (email, raw_user_meta_data) values ('cons-$2@example.com', '{"name":"cons-$2"}') returning id)
insert into storage.objects (bucket_id, name, owner_id, metadata) select 'ugc-images', u.id || '/cons-$2.webp', u.id::text, '{"size":1,"mimetype":"image/webp"}' from u;
insert into private.app_settings (key, value) values ('cons-$2', 'x');
insert into public.audit_log (action, target_type, target_id) values ('cons.write', 'system', 'cons-$2');
commit;
SQL
}
# 跨范围一致性：五处的编号集合必须完全相同（输出不一致的编号，空 = 一致）
inconsistent() {
  q "$1" "
with a as (select substring(email from 'cons-([^@]+)@') k from auth.users where email like 'cons-%'),
     p as (select substring(display_name from 'cons-(.+)') k from public.profiles where display_name like 'cons-%'),
     v as (select substring(key from 'cons-(.+)') k from private.app_settings where key like 'cons-%'),
     s as (select substring(name from 'cons-([^.]+)\.webp') k from storage.objects where name like '%/cons-%'),
     l as (select substring(target_id from 'cons-(.+)') k from public.audit_log where action = 'cons.write'),
     allk as (select k from a union select k from p union select k from v union select k from s union select k from l)
select string_agg(k, ',' order by k) from allk
 where (k in (select k from a))::int + (k in (select k from p))::int + (k in (select k from v))::int
     + (k in (select k from s))::int + (k in (select k from l))::int not in (0, 5)"
}
nkeys() { q "$1" "select count(*) from auth.users where email like 'cons-%'"; }

echo "== 准备源库"
psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $SRC with (force)" -c "create database $SRC" >/dev/null
for f in db/shim/plain.sql db/migrations/*.sql; do psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null; done
# profiles 的昵称列名以实际表结构为准（handle_new_user 从 raw_user_meta_data.name 取）
q "$(url $SRC)" "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name'" | grep -q 1 \
  || { echo "profiles 没有 display_name 列，测试需要调整" >&2; exit 2; }
for i in $(seq 1 5); do xwrite "$(url $SRC)" "pre$i"; done
[ -z "$(inconsistent "$(url $SRC)")" ] || { echo "源库自身就不一致，测试前提不成立" >&2; exit 2; }

echo "== 备份期间持续跨范围写入 + 快照后确定性标记"
( i=0; while [ ! -e "$W/stop" ]; do i=$((i + 1)); xwrite "$(url $SRC)" "w$i" || exit 1; done ) &
WRITER=$!
mkdir -p "$W/hold"
(
  for _ in $(seq 1 120); do [ -e "$W/hold/ready" ] && break; sleep 0.25; done
  [ -e "$W/hold/ready" ] || exit 1
  xwrite "$(url $SRC)" marker
  sleep 0.5 # 让后台写入在快照之后再提交几条
  touch "$W/hold/go"
) &
MARK=$!
BACKUP_TEST_HOLD_DIR="$W/hold" BACKUP_STORAGE_FILES=skip BACKUP_ALLOW_PLAINTEXT=1 BACKUP_PASSPHRASE='' \
  bash scripts/db-backup.sh "$(url $SRC)" "$W/bk" >"$W/backup.log"
wait "$MARK" || { echo "标记事务没有执行" >&2; exit 1; }
touch "$W/stop"
wait "$WRITER" || true
WRITER=""
src_n=$(nkeys "$(url $SRC)")

echo "== 精确恢复并断言"
bash scripts/db-restore.sh "$DATABASE_URL" "$W/bk" --fresh-db $DST --storage-metadata-only | sed 's/^/  /'
D=$(url $DST)
[ "$(q "$(url $SRC)" "select count(*) from auth.users where email = 'cons-marker@example.com'")" = 1 ] || bad "标记事务没有在源库提交（测试无效）"
m=$(q "$D" "select (select count(*) from auth.users where email = 'cons-marker@example.com') + (select count(*) from public.profiles where display_name = 'cons-marker')
            + (select count(*) from private.app_settings where key = 'cons-marker') + (select count(*) from storage.objects where name like '%/cons-marker.webp')
            + (select count(*) from public.audit_log where target_id = 'cons-marker')")
[ "$m" = 0 ] && ok "C1 快照之后提交的跨范围标记在恢复库的 5 处都不存在" || bad "C1 标记出现在恢复库里 $m 处（范围之间不是同一快照）"
inc=$(inconsistent "$D")
[ -z "$inc" ] && ok "C2 后台写入的每个编号在 auth / profiles / private / storage / audit 五处同时存在或同时不存在" || bad "C2 跨范围不一致的编号：$inc"
dst_n=$(nkeys "$D")
[ "$src_n" -gt "$dst_n" ] && [ "$dst_n" -ge 5 ] && ok "C3 备份期间写入在跑：源库最终 $src_n 个编号，快照里 $dst_n 个" || bad "C3 源库 $src_n / 恢复库 $dst_n（写入没有与备份并发）"
python3 - "$W"/bk/azsou-manifest-*.json "$W"/bk/azsou-storage-listing-*.tsv "$(q "$D" "select count(*) from storage.objects")" <<'PY' && ok "C4 manifest 有快照 id / LSN / 时间；Storage 清单时间 = 快照时间；清单对象数 = 恢复库 storage.objects" || bad "C4 manifest / Storage 清单与快照不符"
import json, re, sys
m = json.load(open(sys.argv[1])); s = m['snapshot']
n = sum(1 for _ in open(sys.argv[2])) - 1
assert re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', s['id']) and re.fullmatch(r'[0-9A-F]+/[0-9A-F]+', s['lsn']) and s['time']
assert m['storage_listing_time'] == s['time']
assert n == int(sys.argv[3]) == m['storage_files']['objects'], (n, sys.argv[3], m['storage_files'])
PY

echo "== 对照组：不共享快照的逐个 pg_dump（同一位置插入标记）必须被检测出不一致"
xwrite "$(url $SRC)" pre-naive >/dev/null
mkdir -p "$W/naive"
pg_dump "$(url $SRC)" --schema=public --no-owner -Fc -f "$W/naive/public.dump"
xwrite "$(url $SRC)" naive-marker
pg_dump "$(url $SRC)" --schema=private --no-owner -Fc -f "$W/naive/private.dump"
pg_dump "$(url $SRC)" --table=auth.users --table=auth.identities --data-only -Fc -f "$W/naive/auth.dump"
pg_dump "$(url $SRC)" --table=storage.buckets --table=storage.objects --data-only -Fc -f "$W/naive/storage.dump"
psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $NAIVE with (force)" -c "create database $NAIVE" >/dev/null
N=$(url $NAIVE)
psql "$N" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null
psql "$N" -Xq -v ON_ERROR_STOP=1 -f db/restore/pre-restore.sql >/dev/null
pg_restore --data-only --no-owner --exit-on-error -d "$N" "$W/naive/auth.dump"
pg_restore -l "$W/naive/public.dump" | grep -vE ' SCHEMA - public | COMMENT - SCHEMA public ' >"$W/naive/pub.list"
pg_restore --no-owner --exit-on-error -L "$W/naive/pub.list" -d "$N" "$W/naive/public.dump" 2>/dev/null || true
pg_restore --no-owner --exit-on-error -d "$N" "$W/naive/private.dump"
pg_restore --data-only --no-owner --exit-on-error -d "$N" "$W/naive/storage.dump"
ninc=$(inconsistent "$N")
case ",$ninc," in
  *,naive-marker,*) ok "对照组：逐个 pg_dump 的备份被检测出跨范围不一致（naive-marker 只在部分范围里）" ;;
  *) bad "对照组没有检测出不一致（检测本身无效）：$ninc" ;;
esac

[ $fail = 0 ] && echo "✓ 统一快照一致性测试通过" || { echo "✗ 统一快照一致性测试失败"; exit 1; }
