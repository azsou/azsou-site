#!/usr/bin/env bash
# =============================================================================
# 批次 2 跟进 3：备份 / 恢复演练「不吞错误」的负面用例。
# 每个用例注入一种故障，断言脚本以非 0 退出、并且没有打印成功字样；另有正向对照（好备份必须通过），
# 防止「什么都失败」也算通过。只连本机隔离库（DATABASE_URL 必须是 127.0.0.1 / localhost 超级用户）。
#
#   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bash tests/ops/drill-negative.sh
#
# 需要与服务器同版本的 pg_dump / pg_restore / psql、gpg、node（restore-drill 用）。CI：db 任务里装完 PG17 客户端后运行。
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${DATABASE_URL:?需要 DATABASE_URL（本机隔离 Postgres 超级用户）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in 127.0.0.1 | localhost | ::1) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
REAL_PSQL=$(command -v psql)
REAL_PG_RESTORE=$(command -v pg_restore)
REAL_SHA=$(command -v sha256sum)
W=$(mktemp -d)
SRC=azsou_neg_src
NOAUTH=azsou_neg_noauth
TGT=azsou_neg_tgt
OLD=azsou_neg_old
FRESH=azsou_neg_fresh
PROD_URL="postgresql://postgres.abryflgoljltyakthtql:not-a-password@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" # 只测拒绝，从不连接
cleanup() {
  for d in $SRC $NOAUTH $TGT $OLD $FRESH; do "$REAL_PSQL" "$DATABASE_URL" -Xqc "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  rm -rf "$W"
}
trap cleanup EXIT
pass=0
failn=0
results=()
# expect_fail <名称> <不应出现的成功字样> -- 命令…
expect_fail() {
  local name=$1 bad=$2
  shift 3
  local rc=0
  "$@" >"$W/out.txt" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && ! grep -qF -- "$bad" "$W/out.txt"; then
    pass=$((pass + 1)); results+=("✓ $name（退出码 $rc）")
  else
    failn=$((failn + 1)); results+=("✗ $name：退出码 $rc，输出：$(tail -3 "$W/out.txt" | tr '\n' ' ')")
  fi
}
# expect_code <名称> <退出码> -- 命令…：退出码必须正好等于给定值
expect_code() {
  local name=$1 want=$2
  shift 3
  local rc=0
  "$@" >"$W/out.txt" 2>&1 || rc=$?
  if [ "$rc" -eq "$want" ]; then pass=$((pass + 1)); results+=("✓ $name（退出码 $rc）"); else
    failn=$((failn + 1)); results+=("✗ $name：期望退出码 $want，实际 $rc：$(tail -2 "$W/out.txt" | tr '\n' ' ')"); fi
}
expect_ok() {
  local name=$1
  shift 2
  local rc=0
  "$@" >"$W/out.txt" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then pass=$((pass + 1)); results+=("✓ $name（正向对照）"); else
    failn=$((failn + 1)); results+=("✗ $name：正向对照失败 $rc：$(tail -3 "$W/out.txt" | tr '\n' ' ')"); fi
}
# 跑一个长脚本，看到某一行（说明错误被吞、继续往下走了）就杀掉并判失败
expect_stop_before() {
  local name=$1 marker=$2 limit=$3
  shift 4
  local log="$W/long-$RANDOM.txt"
  "$@" >"$log" 2>&1 &
  local pid=$! t=0 rc
  while kill -0 "$pid" 2>/dev/null; do
    if grep -qF -- "$marker" "$log"; then
      kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
      failn=$((failn + 1)); results+=("✗ $name：故障被吞，脚本继续到了「$marker」"); return
    fi
    sleep 1; t=$((t + 1))
    if [ $t -ge "$limit" ]; then kill "$pid" 2>/dev/null || true; failn=$((failn + 1)); results+=("✗ $name：超时"); return; fi
  done
  rc=0; wait "$pid" || rc=$?
  if [ "$rc" -ne 0 ] && ! grep -qF -- "$marker" "$log"; then
    pass=$((pass + 1)); results+=("✓ $name（退出码 $rc）")
  else
    failn=$((failn + 1)); results+=("✗ $name：退出码 $rc：$(tail -3 "$log" | tr '\n' ' ')")
  fi
}

echo "== 准备：源库（shim + 全部迁移 + 演练数据）与两份备份（明文 / 加密）"
"$REAL_PSQL" "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $SRC with (force)" -c "create database $SRC" >/dev/null
for f in db/shim/plain.sql db/migrations/*.sql db/restore/drill-seed.sql; do
  "$REAL_PSQL" "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null
done
# 明文只允许本机隔离库 + 显式 BACKUP_ALLOW_PLAINTEXT=1（这里要篡改文件内容做负面用例）
# 本机没有 storage-api：显式只备份 Storage 元数据（文件本体往返见 tests/ops/storage-roundtrip.sh）
export BACKUP_STORAGE_FILES=skip
BACKUP_ALLOW_PLAINTEXT=1 BACKUP_PASSPHRASE='' bash scripts/db-backup.sh "$(url $SRC)" "$W/good" >/dev/null
BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-backup.sh "$(url $SRC)" "$W/enc" >/dev/null
# 旧 schema 版本（只到 0017）的备份：精确恢复的版本确认用例
"$REAL_PSQL" "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $OLD with (force)" -c "create database $OLD" >/dev/null
for f in db/shim/plain.sql db/migrations/*.sql db/restore/drill-seed.sql; do
  case "$(basename "$f")" in 0018_* | 0019_*) continue ;; esac
  "$REAL_PSQL" "$(url $OLD)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null
done
BACKUP_ALLOW_PLAINTEXT=1 BACKUP_PASSPHRASE='' bash scripts/db-backup.sh "$(url $OLD)" "$W/old" >/dev/null
copy() { rm -rf "${W:?}/$1"; cp -r "$W/good" "$W/$1"; }
resum() { (cd "$W/$1" && rm -f azsou-SHA256SUMS-*.txt && ts=$(ls azsou-public-*.dump | sed -E 's/.*-([0-9TZ]+)\.dump/\1/') && "$REAL_SHA" azsou-*"$ts"* >"azsou-SHA256SUMS-$ts.txt"); }
tgt_tables() { "$REAL_PSQL" "$(url $TGT)" -XAt -c "select count(*) from pg_class where relnamespace = 'public'::regnamespace"; }
fresh_tgt() { "$REAL_PSQL" "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $TGT with (force)" -c "create database $TGT" >/dev/null
  "$REAL_PSQL" "$(url $TGT)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null; }

echo "== db-verify-backup.sh"
fresh_tgt
expect_ok "V0 好备份 + 恢复到隔离库：通过" -- bash scripts/db-verify-backup.sh "$W/good" --restore "$(url $TGT)"
expect_ok "V0b 加密备份 + 正确口令：通过" -- env BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-verify-backup.sh "$W/enc"
copy t1; printf 'X' | dd of="$(ls "$W"/t1/azsou-public-*.dump)" bs=1 seek=200 conv=notrunc 2>/dev/null
expect_fail "V1 备份文件被改动（校验和不一致）" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t1"
expect_fail "V2 加密备份但没给口令" "校验通过" -- env -u BACKUP_PASSPHRASE bash scripts/db-verify-backup.sh "$W/enc"
expect_fail "V3 加密备份口令错误" "校验通过" -- env BACKUP_PASSPHRASE=wrong bash scripts/db-verify-backup.sh "$W/enc"
copy t4; head -c 4096 /dev/urandom >"$(ls "$W"/t4/azsou-public-*.dump)"; resum t4
expect_fail "V4 dump 损坏但校验和重算过（pg_restore 读不出目录）" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t4"
copy t5; rm "$W"/t5/azsou-rowcounts-*.tsv; resum t5
expect_fail "V5 缺行数清单" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t5"
copy t6; echo junk >"$W/t6/unlisted.txt"
expect_fail "V6 目录里有 SHA256SUMS 未登记的文件" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t6"
expect_fail "V7 --restore 指向非本机库" "恢复演练通过" -- bash scripts/db-verify-backup.sh "$W/good" --restore "postgres://u:p@db.example.com:5432/x"
copy t8; f=$(ls "$W"/t8/azsou-rowcounts-*.tsv); awk -F'\t' 'BEGIN{OFS="\t"} $1=="public.forum_threads"{$2=$2+1}1' "$f" >"$f.n" && mv "$f.n" "$f"; resum t8; fresh_tgt
expect_fail "V8 恢复后行数与清单不一致" "恢复演练通过" -- bash scripts/db-verify-backup.sh "$W/t8" --restore "$(url $TGT)"
copy t9; f=$(ls "$W"/t9/azsou-rowcounts-*.tsv); printf 'public.az_no_such_table\t0\n' >>"$f"; resum t9; fresh_tgt
expect_fail "V9 恢复库里数不出某张表（psql 出错必须冒泡）" "恢复演练通过" -- bash scripts/db-verify-backup.sh "$W/t9" --restore "$(url $TGT)"

copy t10; rm "$W"/t10/azsou-auth-*.dump; resum t10
expect_fail "V10 缺 auth 范围（账户 / 第三方绑定）" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t10"
copy t11; rm "$W"/t11/azsou-globals-*.tsv; resum t11
expect_fail "V11 缺 globals 清单（扩展 / 角色）" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t11"
copy t12; f=$(ls "$W"/t12/azsou-rowcounts-*.tsv); awk -F'\t' 'BEGIN{OFS="\t"} $1=="auth.identities"{$2=$2+1}1' "$f" >"$f.n" && mv "$f.n" "$f"; resum t12; fresh_tgt
expect_fail "V12 恢复后 auth.identities 行数不一致（auth 范围也逐表核对）" "恢复演练通过" -- bash scripts/db-verify-backup.sh "$W/t12" --restore "$(url $TGT)"
copy t13; f=$(ls "$W"/t13/azsou-rowcounts-*.tsv); awk -F'\t' 'BEGIN{OFS="\t"} $1=="storage.objects"{$2=$2+1}1' "$f" >"$f.n" && mv "$f.n" "$f"; resum t13; fresh_tgt
expect_fail "V13 恢复后 storage.objects 行数不一致（storage 元数据也逐表核对）" "恢复演练通过" -- bash scripts/db-verify-backup.sh "$W/t13" --restore "$(url $TGT)"

copy t14; rm "$W"/t14/azsou-manifest-*.json; resum t14
expect_fail "V14 缺 manifest（统一快照 / schema 版本）" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t14"
copy t15; f=$(ls "$W"/t15/azsou-manifest-*.json); python3 - "$f" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); m['storage_listing_time'] = '1999-01-01T00:00:00Z'; json.dump(m, open(sys.argv[1], 'w'))
PY
resum t15
expect_fail "V15 Storage 清单时间 ≠ 快照时间" "校验通过" -- bash scripts/db-verify-backup.sh "$W/t15"

echo "== 强制加密"
expect_fail "E1 非本机库没有口令：拒绝且不导出任何文件" "备份完成" -- bash scripts/db-backup.sh "postgres://u:p@db.example.com:5432/x" "$W/e1"
[ ! -e "$W/e1" ] && { pass=$((pass + 1)); results+=("✓ E1b 拒绝时没有建输出目录"); } || { failn=$((failn + 1)); results+=("✗ E1b 拒绝时仍产生了 $W/e1"); }
expect_fail "E2 本机库没有口令、也没声明 BACKUP_ALLOW_PLAINTEXT：拒绝" "备份完成" -- env -u BACKUP_ALLOW_PLAINTEXT BACKUP_PASSPHRASE= bash scripts/db-backup.sh "$(url $SRC)" "$W/e2"
expect_fail "E3 明文备份目录过不了上传前闸门" "全部加密" -- bash scripts/ops/assert-encrypted.sh "$W/good"
mkdir -p "$W/e4"; cp "$(ls "$W"/good/azsou-public-*.dump)" "$W/e4/azsou-public-x.dump.gpg"
expect_fail "E4 明文改名成 .gpg 也过不了闸门（检查 OpenPGP 包头）" "全部加密" -- bash scripts/ops/assert-encrypted.sh "$W/e4"
expect_ok "E5 加密备份目录通过闸门" -- bash scripts/ops/assert-encrypted.sh "$W/enc"

echo "== db-backup.sh"
expect_fail "B1 源库连不上" "备份完成" -- env BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-backup.sh "postgres://postgres:postgres@127.0.0.1:1/none" "$W/b1"
"$REAL_PSQL" "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $NOAUTH with (force)" -c "create database $NOAUTH" >/dev/null
expect_fail "B2 账户范围导出失败（库里没有 auth.users）" "备份完成" -- env BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-backup.sh "$(url $NOAUTH)" "$W/b2"
[ -z "$(ls -A "$W/b2" 2>/dev/null)" ] && { pass=$((pass + 1)); results+=("✓ B2b 失败的备份不留半份产物"); } || { failn=$((failn + 1)); results+=("✗ B2b 失败后输出目录里留下了文件"); }
expect_code "B3 生产项目不在受保护环境里：拒绝（不连接）" 2 -- env BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-backup.sh "$PROD_URL" "$W/b3"
expect_code "B4 有 Storage 对象却没有 Storage API 凭据、也没声明 skip：拒绝" 3 -- env -u BACKUP_STORAGE_FILES BACKUP_PASSPHRASE=neg-test-pass bash scripts/db-backup.sh "$(url $SRC)" "$W/b4"
[ -z "$(ls -A "$W/b4" 2>/dev/null)" ] && { pass=$((pass + 1)); results+=("✓ B4b 拒绝后不留任何（明文）产物"); } || { failn=$((failn + 1)); results+=("✗ B4b 拒绝后输出目录里留下了文件"); }

echo "== db-restore.sh（精确恢复）"
expect_code "R1 目标库不是空库（已有数据）：拒绝" 3 -- bash scripts/db-restore.sh "$(url $SRC)" "$W/good" --storage-metadata-only
expect_fail "R2 目标库连不上" "恢复完成" -- bash scripts/db-restore.sh "postgres://postgres:postgres@127.0.0.1:1/none" "$W/good" --storage-metadata-only
copy r3; head -c 4096 /dev/urandom >"$(ls "$W"/r3/azsou-public-*.dump)"; resum r3; fresh_tgt
expect_fail "R3 备份文件损坏（校验和已重算）" "恢复完成" -- bash scripts/db-restore.sh "$(url $TGT)" "$W/r3" --storage-metadata-only
fresh_tgt
expect_code "R4 备份 schema 0017 ≠ 代码最新，没有显式确认：拒绝" 4 -- bash scripts/db-restore.sh "$(url $TGT)" "$W/old" --storage-metadata-only
expect_code "R5 --accept-backup-version 写错（0019 ≠ 备份 0017）：拒绝" 4 -- bash scripts/db-restore.sh "$(url $TGT)" "$W/old" --storage-metadata-only --accept-backup-version 0019
[ "$(tgt_tables)" = 0 ] && { pass=$((pass + 1)); results+=("✓ R4b 版本被拒时目标未写入"); } || { failn=$((failn + 1)); results+=("✗ R4b 版本被拒后目标里出现了表"); }
expect_code "R6 备份没有 Storage 文件本体，却没选 --storage-metadata-only：拒绝" 2 -- bash scripts/db-restore.sh "$(url $TGT)" "$W/good"
copy r7; f=$(ls "$W"/r7/azsou-checksums-*.tsv); awk -F'\t' 'BEGIN{OFS="\t"} $1=="public.forum_threads"{$3="00000000000000000000000000000000"}1' "$f" >"$f.n" && mv "$f.n" "$f"; resum r7; fresh_tgt
expect_fail "R7 内容校验和不一致：事务回滚" "恢复完成" -- bash scripts/db-restore.sh "$(url $TGT)" "$W/r7" --storage-metadata-only
[ "$(tgt_tables)" = 0 ] && { pass=$((pass + 1)); results+=("✓ R7b 回滚后目标仍为空（public 0 个对象）"); } || { failn=$((failn + 1)); results+=("✗ R7b 核对失败后目标里留下了表"); }
expect_fail "R8 --fresh-db 核对失败：删除新建的目标库" "恢复完成" -- bash scripts/db-restore.sh "$DATABASE_URL" "$W/r7" --storage-metadata-only --fresh-db $FRESH
[ "$("$REAL_PSQL" "$DATABASE_URL" -XAt -c "select count(*) from pg_database where datname = '$FRESH'")" = 0 ] \
  && { pass=$((pass + 1)); results+=("✓ R8b 中止后新目标库已删除"); } || { failn=$((failn + 1)); results+=("✗ R8b 中止后新目标库仍在"); }
expect_code "R9 目标是生产项目：拒绝（不连接）" 2 -- bash scripts/db-restore.sh "$PROD_URL" "$W/good" --storage-metadata-only
copy r10; rm "$W"/r10/azsou-manifest-*.json; resum r10; fresh_tgt
expect_fail "R10 旧格式备份（没有 manifest）：拒绝" "恢复完成" -- bash scripts/db-restore.sh "$(url $TGT)" "$W/r10" --storage-metadata-only
fresh_tgt
expect_ok "R0 正向对照：0017 备份 + 显式确认 → 精确恢复" -- bash scripts/db-restore.sh "$(url $TGT)" "$W/old" --storage-metadata-only --accept-backup-version 0017

echo "== db-upgrade.sh（显式升级）"
expect_code "U1 没有 --apply-migrations：拒绝" 4 -- bash scripts/db-upgrade.sh "$(url $TGT)" --from 0017 --to 0019
expect_code "U2 --from 与目标实际版本不符：拒绝" 1 -- bash scripts/db-upgrade.sh "$(url $TGT)" --from 0018 --to 0019 --apply-migrations
expect_code "U3 目标是生产项目：拒绝（不连接）" 2 -- bash scripts/db-upgrade.sh "$PROD_URL" --from 0017 --to 0019 --apply-migrations
expect_code "U4 远程目标没有 --confirm-remote-host：拒绝（不连接）" 4 -- bash scripts/db-upgrade.sh "postgres://u:p@db.example.com:5432/x" --from 0017 --to 0019 --apply-migrations
expect_ok "U0 正向对照：0017 → 0019" -- bash scripts/db-upgrade.sh "$(url $TGT)" --from 0017 --to 0019 --apply-migrations

echo "== restore-drill.sh（PATH 前置假命令注入故障）"
mkdir -p "$W/fake-sha" "$W/fake-psql" "$W/fake-restore"
cat >"$W/fake-sha/sha256sum" <<EOF
#!/usr/bin/env bash
# 校验（-c）一律失败，生成清单照常
for a in "\$@"; do [ "\$a" = -c ] && { echo "注入：校验和不一致" >&2; exit 1; }; done
exec "$REAL_SHA" "\$@"
EOF
cat >"$W/fake-psql/psql" <<EOF
#!/usr/bin/env bash
# restore-drill 的 counts()（-F ' '，从 stdin 读 \\gexec）前面插一条必然失败的查询
args=("\$@"); inject=0
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -F ] && [ "\${args[i+1]:-}" = ' ' ] && inject=1; done
if [ \$inject = 1 ]; then { echo 'select * from az_injected_missing_table;'; cat; } | exec "$REAL_PSQL" "\$@"; fi
exec "$REAL_PSQL" "\$@"
EOF
cat >"$W/fake-restore/pg_restore" <<EOF
#!/usr/bin/env bash
# rehearse 第 6 步（--single-transaction 恢复进新库）：照常恢复，但像「errors ignored on restore」一样以 1 退出
"$REAL_PG_RESTORE" "\$@"; rc=\$?
for a in "\$@"; do [ "\$a" = --single-transaction ] && { echo "pg_restore: warning: errors ignored on restore: 1（注入）" >&2; exit 1; }; done
exit \$rc
EOF
chmod +x "$W"/fake-*/*
expect_stop_before "D1 演练里备份校验和不一致必须停在第 2 步" "== 3A" 300 -- env PATH="$W/fake-sha:$PATH" bash scripts/restore-drill.sh
expect_stop_before "D2 演练核对行数时 psql 出错必须失败（不能两边都少一行算一致）" "== 5" 300 -- env PATH="$W/fake-psql:$PATH" bash scripts/restore-drill.sh

echo "== scripts/db/rehearse-migrations.sh"
expect_fail "M1 回滚演练 pg_restore 报错（以前 || true 吞掉）" "完成。生产库未连接" -- env PATH="$W/fake-restore:$PATH" bash scripts/db/rehearse-migrations.sh "$W/m1"
expect_fail "M2 连接串不是本机：拒绝执行" "完成。生产库未连接" -- env DATABASE_URL="postgres://u:p@db.example.com:5432/postgres" bash scripts/db/rehearse-migrations.sh "$W/m2"

echo
printf '%s\n' "${results[@]}"
echo "负面用例：通过 $pass，失败 $failn"
[ "$failn" -eq 0 ]
