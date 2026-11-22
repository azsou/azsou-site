#!/usr/bin/env bash
# =============================================================================
# 失败清理安全回归（站长 2026-10-28 第五轮）：备份 / 恢复 / 演练脚本失败时，清理只能删除**本次运行新建**的库。
#   预先存在的目标（有数据）+ 注入失败 → 数据逐字节不变（pg_dump --data-only 的 sha256 + OID 不变）；
#   本次运行新建的目标 + 注入失败 → 被删除。
# 只连本机库（DATABASE_URL = 本机超级用户）。用法：DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres bash tests/ops/cleanup-safety.sh
# =============================================================================
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${DATABASE_URL:?需要 DATABASE_URL（本机隔离 Postgres 超级用户）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in 127.0.0.1 | localhost | ::1) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
W=$(mktemp -d)
SUF=$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')
PRE=azsou_cs_pre_$SUF          # 预先存在、有数据的「别人的」库
FRESH=azsou_cs_fresh_$SUF      # 本次运行应新建的库
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
exists() { [ "$(psql "$DATABASE_URL" -XAt -c "select count(*) from pg_database where datname = '$1'")" = 1 ]; }
fingerprint() { # <库> → OID + 数据 sha256（库不存在 → gone）。pg_dump 17.6+ 每次输出随机的 \restrict 口令行，去掉后才可比
  exists "$1" || { echo gone; return; }
  echo "$(psql "$DATABASE_URL" -XAt -c "select oid from pg_database where datname = '$1'") $(pg_dump "$(url "$1")" --data-only --no-owner | grep -v -e '^--' -e '^\\restrict ' -e '^\\unrestrict ' | sha256sum | cut -c1-64)"
}
mk_pre() { # <库> → 预先存在的库：shim + 一张有数据的表（模拟别人的数据）
  psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "create database $1" >/dev/null
  psql "$(url "$1")" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null
  psql "$(url "$1")" -Xq -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table public.precious (id int primary key, note text);
insert into public.precious select g, md5(g::text) from generate_series(1, 500) g;
insert into auth.users (email) values ('pre-existing@example.com');
SQL
}
cleanup() {
  for d in "$PRE" "$FRESH" azsou_drill_src azsou_drill_full azsou_drill_old azsou_drill_upg azsou_drill_tpl; do
    # 只删本测试自己建的（名字带本次随机后缀）或本测试预置的演练旧名库
    case "$d" in *"$SUF"* | azsou_drill_*) [ -f "$W/made-$d" ] && psql "$DATABASE_URL" -Xqc "drop database if exists $d with (force)" >/dev/null 2>&1 ;; esac
  done
  rm -rf "$W"
}
trap cleanup EXIT
made() { touch "$W/made-$1"; }

echo "== 0. 准备：一份真实的加密备份（源库 shim + 全部迁移 + 演练数据）"
SRC=azsou_cs_src_$SUF
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "create database $SRC" >/dev/null && made "$SRC"
psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null
for f in db/migrations/*.sql; do psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null; done
psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/restore/drill-seed.sql >/dev/null
PASS=$(head -c 18 /dev/urandom | base64)
BACKUP_STORAGE_FILES=skip BACKUP_PASSPHRASE=$PASS bash scripts/db-backup.sh "$(url $SRC)" "$W/bk" >/dev/null || { echo "备份失败" >&2; exit 1; }
psql "$DATABASE_URL" -Xqc "drop database $SRC with (force)" >/dev/null

echo "== 1. db-restore.sh：预先存在、有数据的目标 + --drop-target-on-failure（目标非空 → 失败）"
mk_pre "$PRE" && made "$PRE"
before=$(fingerprint "$PRE")
rc=0
BACKUP_PASSPHRASE=$PASS bash scripts/db-restore.sh "$(url "$PRE")" "$W/bk" --storage-metadata-only --drop-target-on-failure >"$W/c1.txt" 2>&1 || rc=$?
after=$(fingerprint "$PRE")
[ "$rc" != 0 ] && [ "$after" = "$before" ] && ok "C1 失败（退出码 $rc），预先存在的库 OID 与数据 sha256 不变" \
  || bad "C1 退出码 $rc；之前 [$before] 之后 [$after]：$(tail -2 "$W/c1.txt" | tr '\n' ' ')"

echo "== 2. db-restore.sh --fresh-db <已存在的库名>（有数据）"
rc=0
BACKUP_PASSPHRASE=$PASS bash scripts/db-restore.sh "$DATABASE_URL" "$W/bk" --storage-metadata-only --fresh-db "$PRE" >"$W/c2.txt" 2>&1 || rc=$?
after=$(fingerprint "$PRE")
[ "$rc" = 3 ] && [ "$after" = "$before" ] && ok "C2 拒绝（退出码 3），已存在的库不变" || bad "C2 退出码 $rc；之前 [$before] 之后 [$after]"

echo "== 3. db-restore.sh --fresh-db <新库名> + 事务内注入失败（行数清单被改、校验和重算）→ 新库被删除"
mkdir -p "$W/tamper"
for f in "$W"/bk/*.gpg; do gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d -o "$W/tamper/$(basename "${f%.gpg}")" "$f" 3<<<"$PASS"; done
rcf=$(ls "$W"/tamper/azsou-rowcounts-*.tsv)
awk -F'\t' 'BEGIN{OFS="\t"} NR == 1 {$2 = $2 + 1}1' "$rcf" >"$rcf.n" && mv "$rcf.n" "$rcf"
(cd "$W/tamper" && ts=$(ls azsou-public-*.dump | sed -E 's/.*-([0-9TZ]+)\.dump/\1/') && rm -f azsou-SHA256SUMS-*.txt && sha256sum azsou-*"$ts"* >"azsou-SHA256SUMS-$ts.txt")
rc=0
bash scripts/db-restore.sh "$DATABASE_URL" "$W/tamper" --storage-metadata-only --fresh-db "$FRESH" >"$W/c3.txt" 2>&1 || rc=$?
exists "$FRESH" && made "$FRESH"
[ "$rc" = 1 ] && ! exists "$FRESH" && ok "C3 恢复核对失败（退出码 1），本次新建的 $FRESH 已删除" \
  || bad "C3 退出码 $rc，$FRESH 是否还在：$(exists "$FRESH" && echo 是 || echo 否)；$(tail -2 "$W/c3.txt" | tr '\n' ' ')"
[ "$(fingerprint "$PRE")" = "$before" ] && ok "C3 期间无关的预先存在库不变" || bad "C3 期间预先存在库变了"

echo "== 4. 所有权核对（backup-lib.sh）：同名库被别人重建 / 不在清单里 → 不删"
if grep -q az_create_owned_db scripts/ops/backup-lib.sh; then
  IMP=azsou_cs_imp_$SUF
  out=$(
    # shellcheck source=../../scripts/ops/backup-lib.sh
    . scripts/ops/backup-lib.sh
    AZ_OWNED_LEDGER=$W/ledger AZ_RUN_ID=cs-$SUF
    export AZ_OWNED_LEDGER AZ_RUN_ID
    az_create_owned_db "$DATABASE_URL" "$IMP" || echo "create-failed"
    # 别人把它删了又建了一个同名库，放进自己的数据
    psql "$DATABASE_URL" -Xqc "drop database $IMP with (force)" -c "create database $IMP" >/dev/null
    psql "$(url "$IMP")" -Xqc "create table t (x int); insert into t values (42)" >/dev/null
    az_drop_owned_db "$DATABASE_URL" "$IMP" 2>&1; echo "rc=$?"
    az_drop_owned_db "$DATABASE_URL" "$PRE" 2>&1; echo "rc=$?"
  )
  made "$IMP"
  if grep -q 'rc=4' <<<"$out" && [ "$(grep -c 'rc=4' <<<"$out")" = 2 ] && exists "$IMP" && [ "$(psql "$(url "$IMP")" -XAt -c 'select x from t')" = 42 ] \
    && [ "$(fingerprint "$PRE")" = "$before" ]; then
    ok "C4 OID 不符的同名库、清单外的库都拒绝删除，数据不变"
  else bad "C4：$out"; fi
  psql "$DATABASE_URL" -Xqc "drop database if exists $IMP with (force)" >/dev/null
else
  bad "C4 backup-lib.sh 没有所有权函数（az_create_owned_db / az_drop_owned_db）"
fi

echo "== 5. restore-drill.sh：预先存在的同名演练库（旧的固定库名）+ 注入失败 → 不碰；本次新建的库全部删除"
pre_drill=()
for d in azsou_drill_src azsou_drill_full; do
  if exists "$d"; then echo "  （跳过 C5：$d 已存在于本机，不是本测试建的，不动它）"; pre_drill=(); break; fi
  mk_pre "$d" && made "$d" && pre_drill+=("$d")
done
if [ ${#pre_drill[@]} = 2 ]; then
  b5=$(for d in "${pre_drill[@]}"; do fingerprint "$d"; done)
  dbs_before=$(psql "$DATABASE_URL" -XAt -c "select string_agg(datname, ',' order by datname) from pg_database")
  rc=0
  AZ_FAIL_AFTER_STEP=1 timeout 100 bash scripts/restore-drill.sh >"$W/c5.txt" 2>&1 || rc=$?
  a5=$(for d in "${pre_drill[@]}"; do fingerprint "$d"; done)
  dbs_after=$(psql "$DATABASE_URL" -XAt -c "select string_agg(datname, ',' order by datname) from pg_database")
  [ "$rc" != 0 ] && [ "$a5" = "$b5" ] && ok "C5 演练失败（退出码 $rc），预先存在的 azsou_drill_src / azsou_drill_full 数据不变" \
    || bad "C5 退出码 $rc；之前 [$b5] 之后 [$a5]"
  [ "$dbs_after" = "$dbs_before" ] && ok "C5 本次演练新建的库已全部删除（库列表与演练前相同）" || bad "C5 演练后多出 / 少了库：前 [$dbs_before] 后 [$dbs_after]"
fi

[ $fail = 0 ] && echo "✓ 失败清理安全回归通过" || { echo "✗ 失败清理安全回归失败"; exit 1; }
