#!/usr/bin/env bash
# =============================================================================
# 受保护备份工作流的入口闸门（.github/workflows/db-backup.yml 第一步；tests/ops/backup-guard.test.sh 覆盖）。
#   bash scripts/ops/backup-guard.sh
# 读环境变量（工作流从 inputs / environment vars / environment secrets 注入；本脚本不打印任何密钥）：
#   CONFIRM_PROJECT_REF        手动运行时输入的项目 ref（必须与连接串里的 ref 完全一致）
#   SUPABASE_DB_URL            Session pooler（postgres.<ref>@…pooler.supabase.com:5432）或直连（db.<ref>.supabase.co）
#   SUPABASE_URL               https://<ref>.supabase.co（Storage API 用；ref 必须一致）
#   SUPABASE_SERVICE_ROLE_KEY  Storage 文件下载用（只检查非空）
#   BACKUP_PASSPHRASE          加密口令（只检查非空）
#   BACKUP_ENVIRONMENT_GUARD   只在站长创建的 backup-production 环境里配置的环境变量，值必须是 backup-production。
#                              用来证明这次运行确实处在那个「有必需审批人」的环境里——如果环境没建好，GitHub 会在首次引用时
#                              自动建一个**没有任何保护**的同名环境，这个变量就不存在，闸门拒绝。
#   GITHUB_EVENT_NAME          只接受 workflow_dispatch（每日模板另设 BACKUP_GUARD_ALLOW_SCHEDULE=1 时也接受 schedule，
#                              此时 CONFIRM_PROJECT_REF 来自环境变量 BACKUP_PROJECT_REF）
# 生产项目 abryflgoljltyakthtql：只要上面全部满足（=已经过环境审批）才放行；真正的闸门是环境的必需审批人。
# 输出：通过时把 ref 写到 $GITHUB_OUTPUT（ref=…）；任何一项不满足 → 非 0 退出，不连接任何库。
# =============================================================================
set -euo pipefail
fail() { echo "::error title=备份闸门::$*" >&2; exit 1; }
case "${GITHUB_EVENT_NAME:-}" in
  workflow_dispatch) ;;
  # 只有另行启用的每日模板（ops/disabled-workflows/db-backup-daily.yml）设置 BACKUP_GUARD_ALLOW_SCHEDULE=1；
  # 受保护的手动工作流 db-backup.yml 从不设置（tests/ops/test_workflows.py 断言）
  schedule) [ "${BACKUP_GUARD_ALLOW_SCHEDULE:-0}" = 1 ] || fail "只允许手动触发（workflow_dispatch），本次是 schedule" ;;
  *) fail "只允许手动触发（workflow_dispatch），本次是 ${GITHUB_EVENT_NAME:-未知}" ;;
esac
[ "${BACKUP_ENVIRONMENT_GUARD:-}" = backup-production ] \
  || fail "没有在受保护环境 backup-production 里运行（环境变量 BACKUP_ENVIRONMENT_GUARD 缺失）——站长需先按 ops/BACKUP-OPS.md 创建环境并设必需审批人"
missing=""
for v in SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY BACKUP_PASSPHRASE; do
  [ -n "${!v:-}" ] || missing="$missing $v"
done
[ -z "$missing" ] || fail "环境 backup-production 缺少 Secret:$missing（备份必须加密且包含 Storage 文件；本次未导出任何数据）"
ref_db=$(python3 - "$SUPABASE_DB_URL" <<'PY'
import re, sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
user, host = p.username or '', p.hostname or ''
m = re.fullmatch(r'postgres\.([a-z0-9]{20})', user) or re.fullmatch(r'db\.([a-z0-9]{20})\.supabase\.co', host)
print(m.group(1) if m else '')
PY
)
ref_api=$(python3 - "$SUPABASE_URL" <<'PY'
import re, sys, urllib.parse as u
m = re.fullmatch(r'([a-z0-9]{20})\.supabase\.co', u.urlparse(sys.argv[1]).hostname or '')
print(m.group(1) if m else '')
PY
)
[ -n "$ref_db" ] || fail "从 SUPABASE_DB_URL 认不出项目 ref（应为 Session pooler 用户 postgres.<ref> 或直连主机 db.<ref>.supabase.co）"
[ -n "$ref_api" ] || fail "从 SUPABASE_URL 认不出项目 ref（应为 https://<ref>.supabase.co）"
[ "$ref_db" = "$ref_api" ] || fail "SUPABASE_DB_URL 与 SUPABASE_URL 指向不同的项目"
input=${CONFIRM_PROJECT_REF:-}
[ -n "$input" ] || fail "没有输入要备份的项目 ref（确认输入）"
[ "$input" = "$ref_db" ] || fail "输入的项目 ref 与 Secret 指向的项目不一致——已拒绝（防止备份错项目）"
if [ "$ref_db" = abryflgoljltyakthtql ]; then
  echo "生产项目 $ref_db：已在受保护环境 backup-production 中经审批运行"
fi
echo "备份闸门通过：项目 $ref_db"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "ref=$ref_db" >>"$GITHUB_OUTPUT"
exit 0
