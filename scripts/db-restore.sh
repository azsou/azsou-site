#!/usr/bin/env bash
# =============================================================================
# 整库恢复：把 scripts/db-backup.sh 产出的 public 备份恢复到一个新库（Supabase 新项目或任意 Postgres）。
#
# 用法：scripts/db-restore.sh <目标库连接串> <azsou-public-*.dump> [azsou-auth-users-*.dump]
#
# 目标库要求：
#   * Supabase：新项目即可（自带 anon / authenticated / service_role、auth.users、storage）。
#   * 其他 Postgres：先执行 db/shim/plain.sql。
#   * public schema 里还没有本站的表（全新库）。
# 步骤：pre-restore.sql（扩展）→ 账户数据（可选）→ 完整 public（去掉 CREATE SCHEMA public）→
#       post-restore.sql（auth 触发器 + 撤销默认权限带来的多余授权）→ 只恢复备份里的 ACL →
#       重跑 0002 起的迁移（补 private schema、storage 桶与策略）。
# 换库并想用迁移文件重建结构时，改用 docs/PORTABILITY.md 里的「迁移 + 只导数据」方式。
# 加密的备份先解密：gpg -d 文件.gpg > 文件
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
URL=${1:?用法：scripts/db-restore.sh <连接串> <public.dump> [auth-users.dump]}
PUB=${2:?缺少 public 备份文件}
AUTH=${3:-}
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
  echo "恢复账户（auth.users）…"
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
# public 以外的对象不在备份里：private.app_settings（注册钩子密钥表，密钥需重新写入）、
# storage 的 ugc-images 桶与策略、各函数的最终版本——按顺序重跑 0002 起的迁移（每个文件可重复执行）补齐
echo "重跑迁移 0002+（补 private / storage 对象）…"
for f in db/migrations/*.sql; do
  case "$(basename "$f")" in 0001_*) continue ;; esac
  sql "$f"
done
echo "✓ 恢复完成。接着按 docs/MIGRATION.md 的「验证 SQL」核对。"
