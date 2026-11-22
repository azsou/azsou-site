#!/usr/bin/env bash
# =============================================================================
# 显式升级（站长第三轮 2026-10-28）：对一个**已精确恢复**的副本，按顺序执行更新的迁移。
# 与精确恢复（scripts/db-restore.sh）分开，永远不会被恢复脚本隐式调用。
#
# 用法：scripts/db-upgrade.sh <目标连接串> --from NNNN --to MMMM --apply-migrations [--confirm-remote-host <主机>]
#   --from      目标当前的 schema 版本（按 db/verify/status.sql 计算，必须与实际一致，否则拒绝）
#   --to        要升级到的版本（≤ 当前代码最新迁移，> --from）
#   --apply-migrations  必须显式给出，表示确认执行迁移；缺少 → 拒绝（退出码 4）
#   非本机目标还必须 --confirm-remote-host <主机>（与连接串主机完全一致）；生产项目 abryflgoljltyakthtql 永远拒绝
#     ——生产迁移按 docs/release/ 的放行申请经站长批准后手工执行，不走本脚本。
# 每个迁移文件自带 begin … commit；每执行一个就重算 schema 版本，必须正好等于该文件编号，否则停止。
# 退出码：0 成功；1 迁移失败 / 版本不符；2 用法；4 未显式确认。
# =============================================================================
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=ops/backup-lib.sh
. scripts/ops/backup-lib.sh
usage() { echo "用法：scripts/db-upgrade.sh <目标连接串> --from NNNN --to MMMM --apply-migrations [--confirm-remote-host 主机]" >&2; exit 2; }
TARGET=${1:-}
[ -n "$TARGET" ] || usage
shift
FROM="" TO="" APPLY=0 CONFIRM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=${2:-}; shift 2 ;;
    --to) TO=${2:-}; shift 2 ;;
    --apply-migrations) APPLY=1; shift ;;
    --confirm-remote-host) CONFIRM=${2:-}; shift 2 ;;
    *) echo "✗ 未知参数：$1" >&2; usage ;;
  esac
done
refuse_prod_target "$TARGET" "显式升级"
[[ "$FROM" =~ ^[0-9]{4}$ ]] && [[ "$TO" =~ ^[0-9]{4}$ ]] || usage
HEAD=$(repo_head_version "$ROOT")
[ "$TO" \> "$FROM" ] || { echo "✗ --to $TO 必须大于 --from $FROM" >&2; exit 2; }
[ ! "$TO" \> "$HEAD" ] || { echo "✗ --to $TO 超过当前代码最新迁移 $HEAD" >&2; exit 2; }
if [ "$APPLY" != 1 ]; then
  echo "✗ 升级会对目标执行迁移 $FROM → $TO：需要显式 --apply-migrations（精确恢复从不隐式升级）" >&2; exit 4
fi
host=$(url_host "$TARGET")
if ! is_local_host "$host" && [ "$CONFIRM" != "$host" ]; then
  echo "✗ 目标 $host 不是本机：需要 --confirm-remote-host $host" >&2; exit 4
fi
version() { psql "$TARGET" -XAt -F '|' -v ON_ERROR_STOP=1 -f db/verify/status.sql | schema_version_from_status; }
cur=$(version) || { echo "✗ 连不上目标库" >&2; exit 1; }
if [ "$cur" != "$FROM" ]; then
  echo "✗ 目标当前 schema 版本是 $cur，不是 --from $FROM，拒绝" >&2; exit 1
fi
echo "升级：$FROM → $TO（目标 $host）"
for f in db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  n=$(basename "$f" | cut -c1-4)
  [ "$n" \> "$FROM" ] && [ ! "$n" \> "$TO" ] || continue
  psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "$f" >/dev/null || { echo "✗ 迁移 $(basename "$f") 失败（该文件已整体回滚，目标停在上一版本）" >&2; exit 1; }
  now=$(version)
  [ "$now" = "$n" ] || { echo "✗ 执行 $(basename "$f") 后 schema 版本是 $now，不是 $n，停止" >&2; exit 1; }
  echo "  ✓ $(basename "$f") → 版本 $now"
done
echo "✓ 升级完成：$FROM → $TO"
