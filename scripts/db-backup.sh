#!/usr/bin/env bash
# =============================================================================
# 数据库备份：pg_dump → 压缩的自定义格式文件 + 结构 SQL + 行数清单 + 校验和（可选 gpg 加密）。
# GitHub Action（.github/workflows/db-backup.yml）与本地手动备份共用。
#
# 用法：scripts/db-backup.sh <数据库连接串> <输出目录>
# 环境变量：
#   BACKUP_INCLUDE_AUTH=1   另外导出 auth.users（邮箱 + 密码哈希，换库保留登录用）。
#                           Action 里只有配置了 BACKUP_PASSPHRASE 才会打开，避免明文账户数据进 artifact。
#   BACKUP_PASSPHRASE=…     设置后用 gpg AES256 对称加密所有产物（原文件删除），解密：gpg -d 文件.gpg > 文件
#   BACKUP_PREFIX=azsou     文件名前缀
# 需要 pg_dump / psql 版本 ≥ 服务器（Supabase 目前是 Postgres 17）。
# Supabase 连接串用 Session pooler（5432）或直连；pg_dump 不能走 Transaction pooler（6543）。
# =============================================================================
set -euo pipefail
URL=${1:?用法：scripts/db-backup.sh <连接串> <输出目录>}
OUT=${2:?缺少输出目录}
PREFIX=${BACKUP_PREFIX:-azsou}
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
cd "$OUT"

echo "pg_dump: $(pg_dump --version)"
server=$(psql "$URL" -XAtc 'show server_version' | cut -d. -f1)
client=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
if [ "$client" -lt "$server" ]; then
  echo "::error::pg_dump $client 低于服务器版本 $server，请安装 postgresql-client-$server" >&2
  exit 1
fi

# ① 完整的 public schema（结构 + 数据 + 策略 + 授权），自定义格式、最高压缩，用于整库恢复或选择性恢复
pg_dump "$URL" --schema=public --no-owner --format=custom --compress=9 \
  --file="$PREFIX-public-$TS.dump"
# ② 结构（纯 SQL，gzip）：便于人工查看 / 对比，不用于恢复
pg_dump "$URL" --schema=public --schema-only --no-owner | gzip -9 > "$PREFIX-schema-$TS.sql.gz"
# ③ 账户（可选）
if [ "${BACKUP_INCLUDE_AUTH:-0}" = "1" ]; then
  pg_dump "$URL" --table=auth.users --data-only --format=custom --compress=9 \
    --file="$PREFIX-auth-users-$TS.dump"
fi
# ④ 行数清单（恢复后核对用）
psql "$URL" -XAt -F $'\t' -v ON_ERROR_STOP=1 > "$PREFIX-rowcounts-$TS.tsv" <<'SQL'
select format('select %L, count(*) from %I.%I', schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables where schemaname = 'public' order by relname
\gexec
select 'auth.users', count(*) from auth.users;
SQL

sha256sum "$PREFIX"-*"$TS"* > "$PREFIX-SHA256SUMS-$TS.txt"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  for f in "$PREFIX"-*"$TS"*; do
    gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$f.gpg" "$f" 3<<<"$BACKUP_PASSPHRASE"
    rm -f "$f"
  done
  echo "已加密（gpg AES256）"
fi

ls -l
echo "备份完成：$OUT"
