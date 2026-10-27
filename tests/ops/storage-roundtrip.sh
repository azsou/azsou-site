#!/usr/bin/env bash
# =============================================================================
# 站长第三轮 ④：Storage 文件本体的备份 → 精确恢复往返。**本地集成测试，不是真实验收。**
#   用真实的 Supabase storage-api（github.com/supabase/storage v1.19.0 源码构建，file 后端）分别挂在源库与目标库上，
#   备份经 Storage API 下载对象 → 加密归档（逐对象 sha256 清单）→ 精确恢复经 Storage API 建桶 / 上传 / 回填 owner → 下载比对。
#   没有 Kong 网关、没有 S3、不是 Supabase 托管项目；真实验收需要隔离的 Supabase 测试项目（见 docs/BACKUP.md §2B）。
#
#   STORAGE_API_DIR=<已构建的 storage-api> DATABASE_URL=postgres://postgres@127.0.0.1:54529/postgres bash tests/ops/storage-roundtrip.sh
# 端口：4510 / 4520 / 4530（各占 +1 作管理端口）。只连本机库；只按 PID 结束自己起的 storage-api。
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
: "${DATABASE_URL:?需要 DATABASE_URL（本机隔离 Postgres 超级用户）}"
: "${STORAGE_API_DIR:?需要 STORAGE_API_DIR（已 npm ci + node build.js + resolve-tspaths 的 supabase/storage 源码目录）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in 127.0.0.1 | localhost | ::1) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
export NO_PROXY=${NO_PROXY:-localhost,127.0.0.1}
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
SRC=azsou_st_src DST=azsou_st_dst DST2=azsou_st_dst2
PA=4510 PB=4520 PC=4530
W=$(mktemp -d)
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  sleep 0.5
  for d in $SRC $DST $DST2; do psql "$DATABASE_URL" -Xqc "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  rm -rf "$W"
}
trap cleanup EXIT
fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
KEY=$(bash tests/ops/storage-api-local.sh jwt service_role)
api() { curl -sS --noproxy '*' -H "Authorization: Bearer $KEY" -H "apikey: $KEY" "$@"; }
newdb() { psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $1 with (force)" -c "create database $1" >/dev/null; }
start_api() { # <库> <端口> → 起 storage-api（它会在库里建 storage schema），再跑 shim（已存在的 storage 表不动）
  local pid
  pid=$(bash tests/ops/storage-api-local.sh start "$(url "$1")" "$2" "$W/files-$1")
  PIDS+=("$pid")
  psql "$(url "$1")" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f db/shim/plain.sql >/dev/null
}

echo "== 1. 源：Postgres + 真实 storage-api（:$PA）+ 全部迁移 + 经 API 上传的对象"
newdb $SRC
start_api $SRC $PA
for f in db/migrations/*.sql; do psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null; done
U1=$(psql "$(url $SRC)" -XAt -v ON_ERROR_STOP=1 -c "insert into auth.users (email, raw_user_meta_data) values ('st-1@example.com', '{\"name\":\"st-1\"}') returning id" | head -1)
python3 - "$W/in" <<'PY'
import os, sys, zlib, struct
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
def png(w, h, seed):
    raw = b''.join(b'\x00' + bytes(((x * seed + y) % 256) for x in range(w * 3)) for y in range(h))
    c = lambda t, b: struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + c(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + c(b'IDAT', zlib.compress(raw)) + c(b'IEND', b'')
open(f'{d}/a.png', 'wb').write(png(64, 48, 7))
open(f'{d}/b.png', 'wb').write(png(300, 200, 13))
open(f'{d}/c.bin', 'wb').write(os.urandom(70000))
open(f'{d}/d.txt', 'wb').write('中文内容 / 第二个桶\n'.encode())
PY
up() { # <桶> <对象名> <文件> <类型> [cache-control]
  local r
  r=$(api -X POST -H "content-type: $4" ${5:+-H "cache-control: $5"} --data-binary "@$3" "http://127.0.0.1:$PA/object/$1/$2")
  grep -q '"Key"' <<<"$r" || { echo "上传失败 $1/$2：$r" >&2; exit 1; }
}
up ugc-images "$U1/202610-aaaaaa-64x48.png" "$W/in/a.png" image/png "max-age=3600"
up ugc-images "$U1/202610-bbbbbb-300x200.png" "$W/in/b.png" image/png
r=$(api -X POST -H 'content-type: application/json' -d '{"id":"backup-test","name":"backup-test","public":false}' "http://127.0.0.1:$PA/bucket")
grep -q backup-test <<<"$r" || { echo "建桶失败：$r" >&2; exit 1; }
up backup-test "deep/nested/path/blob.bin" "$W/in/c.bin" application/octet-stream
up backup-test "docs/read%20me%20(1).txt" "$W/in/d.txt" "text/plain;charset=UTF-8"
# 模拟用户自己上传：owner 指向用户（经 service key 上传时为空）
psql "$(url $SRC)" -Xq -v ON_ERROR_STOP=1 -c "update storage.objects set owner = '$U1', owner_id = '$U1' where bucket_id = 'ugc-images'"
n=$(psql "$(url $SRC)" -XAt -c "select count(*) from storage.objects")
[ "$n" = 4 ] && ok "源 storage.objects 4 个对象（2 个桶，含多级目录、名字含空格 / 括号；storage-api 不接受非 ASCII 对象名）" || bad "源对象数 $n"

echo "== 2. 备份（统一快照 + Storage API 下载 + 加密）"
PASS=$(head -c 18 /dev/urandom | base64)
STORAGE_URL="http://127.0.0.1:$PA" STORAGE_SERVICE_KEY=$KEY BACKUP_PASSPHRASE=$PASS \
  bash scripts/db-backup.sh "$(url $SRC)" "$W/bk" | tail -1 | sed 's/^/  /'
BACKUP_PASSPHRASE=$PASS bash scripts/db-verify-backup.sh "$W/bk" | sed 's/^/  /'

echo "== 3. 精确恢复到新的空目标（Postgres + 真实 storage-api :$PB）"
newdb $DST
start_api $DST $PB
STORAGE_URL="http://127.0.0.1:$PB" STORAGE_SERVICE_KEY=$KEY BACKUP_PASSPHRASE=$PASS \
  bash scripts/db-restore.sh "$(url $DST)" "$W/bk" --storage-api --drop-target-on-failure | sed 's/^/  /'
for f in a b; do
  name=$(psql "$(url $DST)" -XAt -c "select name from storage.objects where bucket_id = 'ugc-images' and name like '%-$( [ $f = a ] && echo aaaaaa || echo bbbbbb)-%'")
  curl -sS --noproxy '*' "http://127.0.0.1:$PB/object/public/ugc-images/$name" -o "$W/out-$f.png"
  cmp -s "$W/in/$f.png" "$W/out-$f.png" && ok "公开桶对象 $f.png 经目标 storage-api 公开地址下载，与原文件逐字节一致" || bad "$f.png 内容不同"
done
api "http://127.0.0.1:$PB/object/backup-test/docs/read%20me%20(1).txt" -o "$W/out-d.txt"
cmp -s "$W/in/d.txt" "$W/out-d.txt" && ok "私有桶对象（名字含空格 / 括号，内容为中文）往返一致" || bad "私有桶对象内容不同"
o=$(psql "$(url $DST)" -XAt -c "select count(*) from storage.objects where bucket_id = 'ugc-images' and owner_id = '$U1' and owner = '$U1'")
[ "$o" = 2 ] && ok "owner / owner_id 按备份回填（RLS 依赖它判断「自己的图片」）" || bad "owner 回填 $o/2"
p=$(psql "$(url $DST)" -XAt -c "select count(*) from pg_policies where schemaname = 'storage' and policyname like 'az_ugc_images_%'")
[ "$p" = 3 ] && ok "storage.objects 上 3 条 az_ugc_images_* RLS 策略随精确恢复回来（未执行迁移）" || bad "storage 策略 $p/3"
cc=$(curl -sS --noproxy '*' -D - -o /dev/null "http://127.0.0.1:$PB/object/public/ugc-images/$(psql "$(url $DST)" -XAt -c "select name from storage.objects where name like '%aaaaaa%'")" | tr -d '\r' | sed -n 's/^cache-control: //Ip')
[ "$cc" = "max-age=3600" ] && ok "cache-control 保留（$cc）" || bad "cache-control 变成了「$cc」"

echo "== 4. 负面：目标桶已存在 / 归档被改 / 快照之后对象被删"
rc=0
STORAGE_URL="http://127.0.0.1:$PB" STORAGE_SERVICE_KEY=$KEY BACKUP_PASSPHRASE=$PASS \
  bash scripts/db-restore.sh "$(url $DST)" "$W/bk" --storage-api >"$W/neg1.txt" 2>&1 || rc=$?
[ $rc = 3 ] && ok "S1 目标已有数据 / 桶：拒绝（退出码 3）" || bad "S1 退出码 $rc"
mkdir -p "$W/tamper"
for f in "$W"/bk/*.gpg; do gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d -o "$W/tamper/$(basename "${f%.gpg}")" "$f" 3<<<"$PASS"; done
fl=$(ls "$W"/tamper/azsou-storage-files-*.tsv)
awk -F'\t' 'BEGIN{OFS="\t"} NR == 3 {$4 = "0000000000000000000000000000000000000000000000000000000000000000"}1' "$fl" >"$fl.n" && mv "$fl.n" "$fl"
(cd "$W/tamper" && rm -f azsou-SHA256SUMS-*.txt && ts=$(ls azsou-public-*.dump | sed -E 's/.*-([0-9TZ]+)\.dump/\1/') && sha256sum azsou-*"$ts"* >"azsou-SHA256SUMS-$ts.txt")
newdb $DST2
start_api $DST2 $PC
rc=0
STORAGE_URL="http://127.0.0.1:$PC" STORAGE_SERVICE_KEY=$KEY \
  bash scripts/db-restore.sh "$(url $DST2)" "$W/tamper" --storage-api --drop-target-on-failure >"$W/neg2.txt" 2>&1 || rc=$?
gone=$(psql "$DATABASE_URL" -XAt -c "select count(*) from pg_database where datname = '$DST2'")
[ $rc != 0 ] && [ "$gone" = 0 ] && ok "S2 归档文件与逐对象 sha256 不符：恢复失败并删除了新目标库" || bad "S2 退出码 $rc，目标库剩 $gone：$(tail -2 "$W/neg2.txt")"
mkdir -p "$W/hold"
victim=$(psql "$(url $SRC)" -XAt -c "select name from storage.objects where name like 'deep/%'")
( for _ in $(seq 1 120); do [ -e "$W/hold/ready" ] && break; sleep 0.25; done
  api -X DELETE "http://127.0.0.1:$PA/object/backup-test/$victim" >/dev/null; touch "$W/hold/go" ) &
rc=0
BACKUP_TEST_HOLD_DIR="$W/hold" STORAGE_URL="http://127.0.0.1:$PA" STORAGE_SERVICE_KEY=$KEY BACKUP_PASSPHRASE=$PASS \
  bash scripts/db-backup.sh "$(url $SRC)" "$W/bk-gone" >"$W/neg3.txt" 2>&1 || rc=$?
wait || true
[ $rc != 0 ] && [ -z "$(ls -A "$W/bk-gone" 2>/dev/null)" ] && grep -q '快照之后被删除' "$W/neg3.txt" \
  && ok "S3 快照之后对象被删：备份失败、不留产物（不会产出缺文件的备份）" || bad "S3 退出码 $rc：$(tail -2 "$W/neg3.txt")"

[ $fail = 0 ] && echo "✓ Storage 往返本地集成测试通过（真实 storage-api 本地实例；不是 Supabase 托管项目上的真实验收）" || { echo "✗ Storage 往返测试失败"; exit 1; }
