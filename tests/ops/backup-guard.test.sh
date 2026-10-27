#!/usr/bin/env bash
# =============================================================================
# scripts/ops/backup-guard.sh 的闸门用例（不连接任何库、不需要网络）。运维 PR #8 与 PR #5 共用。
#   bash tests/ops/backup-guard.test.sh
# 每个拒绝用例：非 0 退出、没有「闸门通过」、输出里不出现任何密钥值。正向对照：非生产项目与（经环境审批的）生产项目放行。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
G=scripts/ops/backup-guard.sh
REF=abcdefghijklmnopqrst
PROD=abryflgoljltyakthtql
SECRET_PASS='pp-should-never-print-1234'
SECRET_KEY='sk-should-never-print-5678'
DBPW='dbpw-should-never-print-9'
base() {
  env -i PATH="$PATH" GITHUB_EVENT_NAME=workflow_dispatch BACKUP_ENVIRONMENT_GUARD=backup-production \
    SUPABASE_DB_URL="postgresql://postgres.$1:$DBPW@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" \
    SUPABASE_URL="https://$1.supabase.co" SUPABASE_SERVICE_ROLE_KEY=$SECRET_KEY BACKUP_PASSPHRASE=$SECRET_PASS \
    CONFIRM_PROJECT_REF="$1" "${@:2}"
}
pass=0 failn=0
check() { # <名称> <期望 ok|fail> -- 命令…
  local name=$1 want=$2 rc=0 out
  shift 3
  out=$("$@" 2>&1) || rc=$?
  if grep -qE "$SECRET_PASS|$SECRET_KEY|$DBPW" <<<"$out"; then failn=$((failn + 1)); echo "✗ $name：输出泄露了密钥"; return; fi
  if { [ "$want" = ok ] && [ $rc = 0 ] && grep -q 闸门通过 <<<"$out"; } || { [ "$want" = fail ] && [ $rc != 0 ] && ! grep -q 闸门通过 <<<"$out"; }; then
    pass=$((pass + 1)); echo "✓ $name（退出码 $rc）"
  else failn=$((failn + 1)); echo "✗ $name：退出码 $rc：$(tail -1 <<<"$out")"; fi
}
check "G0 非生产项目、手动触发、环境与 Secret 齐全：放行" ok -- base $REF bash $G
check "G0b 生产项目（已在受保护环境中审批）：放行" ok -- base $PROD bash $G
check "G0c 直连主机 db.<ref>.supabase.co 也认得出 ref" ok -- base $REF env SUPABASE_DB_URL="postgresql://postgres:$DBPW@db.$REF.supabase.co:5432/postgres" bash $G
check "G1 push 触发：拒绝" fail -- base $REF env GITHUB_EVENT_NAME=push bash $G
check "G2 schedule 触发（手动工作流不允许定时）：拒绝" fail -- base $REF env GITHUB_EVENT_NAME=schedule bash $G
check "G2b 只有每日模板显式允许 schedule" ok -- base $REF env GITHUB_EVENT_NAME=schedule BACKUP_GUARD_ALLOW_SCHEDULE=1 bash $G
check "G3 不在受保护环境里（环境变量缺失 = 环境没建好 / 被自动建成无保护环境）：拒绝" fail -- base $REF env -u BACKUP_ENVIRONMENT_GUARD bash $G
check "G3b 生产项目不在受保护环境里：拒绝" fail -- base $PROD env BACKUP_ENVIRONMENT_GUARD=other bash $G
check "G4 输入的项目 ref 与 Secret 不一致：拒绝" fail -- base $REF env CONFIRM_PROJECT_REF=$PROD bash $G
check "G4b 没有输入项目 ref：拒绝" fail -- base $REF env CONFIRM_PROJECT_REF= bash $G
check "G5 SUPABASE_DB_URL 与 SUPABASE_URL 指向不同项目：拒绝" fail -- base $REF env SUPABASE_URL="https://$PROD.supabase.co" bash $G
for v in SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY BACKUP_PASSPHRASE; do
  check "G6 缺 $v：拒绝" fail -- base $REF env -u $v bash $G
done
check "G7 连接串认不出 ref（不是 Supabase 地址）：拒绝" fail -- base $REF env SUPABASE_DB_URL="postgresql://u:$DBPW@db.example.com:5432/x" bash $G
echo "闸门用例：通过 $pass，失败 $failn"
[ $failn = 0 ]
