#!/usr/bin/env bash
# =============================================================================
# 运维 PR #8 与 PR #5 共用的备份脚本端到端用例（本机隔离 Postgres + tests/ops/fixtures/mini-supabase.sql）。
#   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bash tests/ops/backup-ops-e2e.sh
# 覆盖 db-backup.sh（统一快照 manifest、逐表校验和、强制加密、拒绝路径）、db-verify-backup.sh、assert-encrypted.sh。
# Storage 文件本体的真实往返在 PR #5 的 tests/ops/storage-roundtrip.sh（真实 storage-api 本地集成测试）。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${DATABASE_URL:?需要 DATABASE_URL（本机隔离 Postgres 超级用户）}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$DATABASE_URL")
case "$host" in 127.0.0.1 | localhost | ::1) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
url() { python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$DATABASE_URL" "$1"; }
DB=azsou_ops_e2e
W=$(mktemp -d)
trap 'psql "$DATABASE_URL" -Xqc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
psql "$(url $DB)" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f tests/ops/fixtures/mini-supabase.sql >/dev/null
PROD_URL="postgresql://postgres.abryflgoljltyakthtql:not-a-password@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
pass=0 failn=0
res() { if [ "$1" = 0 ]; then pass=$((pass + 1)); echo "✓ $2"; else failn=$((failn + 1)); echo "✗ $2：$(tail -2 "$W/out.txt" 2>/dev/null | tr '\n' ' ')"; fi; }
# is <名称> <条件命令…>：条件成立记通过（set -e 下也不会因条件失败而中途退出）
is() { local n=$1; shift; if "$@"; then res 0 "$n"; else res 1 "$n"; fi; }
empty_or_absent() { [ -z "$(ls -A "$1" 2>/dev/null)" ]; }
code() { local rc=0; "$@" >"$W/out.txt" 2>&1 || rc=$?; echo $rc; }

rc=$(code env BACKUP_STORAGE_FILES=skip BACKUP_ALLOW_PLAINTEXT=1 BACKUP_PASSPHRASE='' bash scripts/db-backup.sh "$(url $DB)" "$W/plain")
res $rc "P1 本机明文备份（显式 BACKUP_ALLOW_PLAINTEXT=1 + 只要 Storage 元数据）"
p1b() { python3 - "$W"/plain/azsou-manifest-*.json "$W"/plain/azsou-checksums-*.tsv <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1])); s = m['snapshot']
assert m['format'] == 2 and re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', s['id']) and re.fullmatch(r'[0-9A-F]+/[0-9A-F]+', s['lsn'])
assert m['storage_listing_time'] == s['time'] and m['storage_files'] == {'status': 'skipped', 'objects': 1, 'bytes': 0}
t = {l.split('\t')[0]: int(l.split('\t')[1]) for l in open(sys.argv[2])}
want = {'public.posts': 2, 'private.app_settings': 1, 'auth.users': 2, 'auth.identities': 1, 'storage.buckets': 1, 'storage.objects': 1,
        'storage.buckets#identity': 1, 'storage.objects#identity': 1}
assert all(t.get(k) == v for k, v in want.items()), t
PY
}
is "P1b manifest：快照 id / LSN / 时间、Storage 清单时间 = 快照时间；每个范围逐表行数 + 校验和" p1b
rc=$(code bash scripts/db-verify-backup.sh "$W/plain"); res $rc "P1c db-verify-backup.sh 通过"
rc=$(code env BACKUP_STORAGE_FILES=skip BACKUP_PASSPHRASE=ops-e2e-pass bash scripts/db-backup.sh "$(url $DB)" "$W/enc"); res $rc "P2 加密备份"
rc=$(code bash scripts/ops/assert-encrypted.sh "$W/enc"); res $rc "P2b 上传前闸门：只有 gpg 对称加密产物"
rc=$(code env BACKUP_PASSPHRASE=ops-e2e-pass bash scripts/db-verify-backup.sh "$W/enc"); res $rc "P2c 加密备份校验通过"
rc=$(code env BACKUP_PASSPHRASE=wrong bash scripts/db-verify-backup.sh "$W/enc"); is "N1 口令错误：校验失败" [ "$rc" != 0 ]
rc=$(code bash scripts/ops/assert-encrypted.sh "$W/plain"); is "N2 明文目录过不了上传前闸门" [ "$rc" != 0 ]
rc=$(code env -u BACKUP_STORAGE_FILES BACKUP_PASSPHRASE=ops-e2e-pass bash scripts/db-backup.sh "$(url $DB)" "$W/n3")
n3() { [ "$rc" = 3 ] && empty_or_absent "$W/n3"; }
is "N3 有 Storage 对象但没有 Storage API 凭据、也没声明 skip：拒绝（退出码 3），不留任何产物" n3
rc=$(code env BACKUP_PASSPHRASE='' bash scripts/db-backup.sh "postgres://u:p@db.example.com:5432/x" "$W/n4")
n4() { [ "$rc" = 2 ] && [ ! -e "$W/n4" ]; }
is "N4 远程库没有口令：拒绝（退出码 2），不建目录" n4
rc=$(code env BACKUP_PASSPHRASE=x bash scripts/db-backup.sh "$PROD_URL" "$W/n5")
n5() { [ "$rc" = 2 ] && [ ! -e "$W/n5" ]; }
is "N5 生产项目不在受保护环境里：拒绝（退出码 2），不连接" n5
cp -r "$W/plain" "$W/n6"; printf 'X' | dd of="$(ls "$W"/n6/azsou-public-*.dump)" bs=1 seek=100 conv=notrunc 2>/dev/null
rc=$(code bash scripts/db-verify-backup.sh "$W/n6"); is "N6 备份被改动：校验失败" [ "$rc" != 0 ]
cp -r "$W/plain" "$W/n7"; rm "$W"/n7/azsou-manifest-*.json
(cd "$W/n7" && ts=$(ls azsou-public-*.dump | sed -E 's/.*-([0-9TZ]+)\.dump/\1/') && grep -v manifest "azsou-SHA256SUMS-$ts.txt" >s && mv s "azsou-SHA256SUMS-$ts.txt")
rc=$(code bash scripts/db-verify-backup.sh "$W/n7"); is "N7 缺 manifest：校验失败" [ "$rc" != 0 ]
echo "运维备份端到端：通过 $pass，失败 $failn"
[ $failn = 0 ]
