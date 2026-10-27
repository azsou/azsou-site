#!/usr/bin/env bash
# =============================================================================
# 整库恢复：把 scripts/db-backup.sh 产出的 public 备份恢复到一个新库（Supabase 新项目或任意 Postgres）。
#
# 用法：scripts/db-restore.sh <目标库连接串> <azsou-public-*.dump> [azsou-auth-*.dump] \
#          [--private azsou-private-*.dump] [--storage azsou-storage-*.dump]
#   auth   = auth.users + auth.identities 数据（旧备份的 azsou-auth-users-*.dump 同样可用）
#   private = private schema（结构 + 数据：票据 / 下载盐等密钥、提交记录、下载事件）
#   storage = storage.buckets + storage.objects 元数据（文件本体不在备份里，见 docs/BACKUP.md §2B）
#
# 目标库要求：
#   * Supabase：新项目即可（自带 anon / authenticated / service_role、auth.users、storage）。
#   * 其他 Postgres：先执行 db/shim/plain.sql。
#   * public schema 里还没有本站的表（全新库）。
# 步骤：pre-restore.sql（扩展）→ 账户数据（可选）→ 完整 public（去掉 CREATE SCHEMA public）→
#       post-restore.sql（auth 触发器 + 撤销默认权限带来的多余授权）→ 只恢复备份里的 ACL →
#       private（可选，整 schema）→ storage 元数据（可选）→ 重跑 0002 起的迁移（补缺的 private / storage 桶与策略；
#       迁移里的 insert 都是 on conflict，不覆盖恢复出的密钥与对象行）。
# 换库并想用迁移文件重建结构时，改用 docs/PORTABILITY.md 里的「迁移 + 只导数据」方式。
# 加密的备份先解密：gpg -d 文件.gpg > 文件
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
URL=${1:?用法：scripts/db-restore.sh <连接串> <public.dump> [auth.dump] [--private f] [--storage f]}
PUB=${2:?缺少 public 备份文件}
shift 2
AUTH=""
PRIV=""
STOR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --private) PRIV=${2:?--private 需要文件}; shift 2 ;;
    --storage) STOR=${2:?--storage 需要文件}; shift 2 ;;
    -*) echo "✗ 未知参数：$1" >&2; exit 2 ;;
    *) [ -z "$AUTH" ] || { echo "✗ 多余参数：$1" >&2; exit 2; }; AUTH=$1; shift ;;
  esac
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sql() { psql "$URL" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$1" >/dev/null; }

# 连不上 / 查询失败必须直接失败（以前 `psql … | grep -q t` 在 psql 出错时等于「库是空的」继续往下走）
exists=$(psql "$URL" -XAt -v ON_ERROR_STOP=1 -c "select to_regclass('public.forum_threads') is not null") \
  || { echo "✗ 连不上目标库或查询失败" >&2; exit 1; }
if [ "$exists" = t ]; then
  echo "✗ 目标库已经有 public.forum_threads：整库恢复只用于全新库" >&2
  exit 1
fi
sql db/restore/pre-restore.sql
if [ -n "$AUTH" ]; then
  echo "恢复账户（auth.users / auth.identities）…"
  pg_restore --data-only --no-owner --exit-on-error -d "$URL" "$AUTH"
fi
echo "恢复 public（结构 + 数据 + 策略）…"
pg_restore -l "$PUB" > "$tmp/all.list"
grep -vE ' SCHEMA - public | COMMENT - SCHEMA public | ACL ' "$tmp/all.list" > "$tmp/main.list"
pg_restore --no-owner --exit-on-error -L "$tmp/main.list" -d "$URL" "$PUB"
sql db/restore/post-restore.sql
echo "恢复授权（ACL）…"
# 只对「没有 ACL 条目」（grep 无匹配）放行；pg_restore -l 本身的失败已在上面直接退出
{ grep -E ' ACL ' "$tmp/all.list" || true; } | { grep -vE ' ACL - SCHEMA public ' || true; } > "$tmp/acl.list"
pg_restore --no-owner --exit-on-error -L "$tmp/acl.list" -d "$URL" "$PUB"
if [ -n "$PRIV" ]; then
  echo "恢复 private（结构 + 数据）…"
  pg_restore --no-owner --exit-on-error -d "$URL" "$PRIV"
fi
if [ -n "$STOR" ]; then
  echo "恢复 storage 元数据（buckets / objects 行）…"
  pg_restore --data-only --no-owner --exit-on-error -d "$URL" "$STOR"
fi
# 没有随备份恢复的对象（旧备份没有 private / storage 文件时的 private.app_settings、storage 桶与策略、各函数的最终版本）
# ——按顺序重跑 0002 起的迁移（每个文件可重复执行，insert 都是 on conflict）补齐
echo "重跑迁移 0002+（补 private / storage 对象）…"
for f in db/migrations/*.sql; do
  case "$(basename "$f")" in 0001_*) continue ;; esac
  sql "$f"
done
echo "✓ 恢复完成。接着按 docs/MIGRATION.md 的「验证 SQL」核对。"
