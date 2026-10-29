#!/usr/bin/env bash
# Lighthouse CI 一档（mobile / desktop）：collect → assert → upload，产物各自独立，后跑的档不能覆盖先跑的档。
#
#   bash scripts/ci/lhci-tier.sh <档名> <lighthouserc 配置> [输出根目录，默认 lhci-out]
#
# 输出（<输出根目录>/<档名>/）：
#   raw/          LHCI 工作目录 .lighthouseci 的原样副本：每次运行的 lhr-*.json / .html + assertion-results.json
#   reports/      lhci upload --target=filesystem 的报告（*.report.json / .html + manifest.json）
#   summary.json  每页每次的 LCP / CLS / TBT / 脚本体积 / 四项分数 + 中位数 + 未通过断言（scripts/ci/lhci-summary.mjs）
#   summary.md    同上的人读版（也追加到任务摘要）
#   exit-codes.json  collect / assert / upload 各自的退出码与本档结论
#   manifest.sha256  本档全部文件的 sha256（最后写；之后 lhci-gate.sh 复核，证明没被后面的档改动）
#
# 规则：
#   - 输出目录已存在 → 拒绝（退出码 2），绝不覆盖；
#   - LHCI 工作目录 .lighthouseci 在本档开始前必须不存在（上一档已归档并移走），否则拒绝，不替别人删；
#   - 退出码不吞：collect / assert / upload 任一非 0 → 本档非 0；collect 失败时不跑 assert，assert 记为 "not-run"，本档失败。
#   - LHCI 命令可用环境变量 LHCI 覆盖（单元测试用假 lhci），默认 npx --yes @lhci/cli@0.15.x。
set -uo pipefail

tier="${1:?用法：lhci-tier.sh <档名> <配置> [输出根目录]}"
cfg="${2:?缺配置文件}"
root="${3:-lhci-out}"
out="$root/$tier"
work=".lighthouseci"
LHCI="${LHCI:-npx --yes @lhci/cli@0.15.x}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! "$tier" =~ ^[a-z0-9-]+$ ]]; then echo "::error title=Lighthouse ${tier}::档名只允许 a-z0-9-"; exit 2; fi
if [ -e "$out" ]; then
  echo "::error title=Lighthouse ${tier}（拒绝覆盖）::输出目录 $out 已存在，不会覆盖先前的结果"
  exit 2
fi
if [ -e "$work" ]; then
  echo "::error title=Lighthouse ${tier}（工作目录未清理）::$work 已存在：上一档没有归档移走，拒绝运行（不替别人删）"
  exit 2
fi
mkdir -p "$out/raw" "$out/reports"

echo "== Lighthouse ${tier}：collect（$cfg）"
$LHCI collect --config="$cfg"
collect_rc=$?
assert_rc="not-run"
if [ "$collect_rc" -eq 0 ]; then
  echo "== Lighthouse ${tier}：assert"
  $LHCI assert --config="$cfg"
  assert_rc=$?
else
  echo "::error title=Lighthouse ${tier}::collect 退出码 $collect_rc，不做断言（本档判失败）"
fi

# 原始 LHR 与断言结果先归档（upload 之前），之后再上传报告
if [ -d "$work" ]; then cp -a "$work/." "$out/raw/"; fi
upload_rc="not-run"
if ls "$out/raw"/lhr-*.json >/dev/null 2>&1; then
  echo "== Lighthouse ${tier}：upload → $out/reports"
  $LHCI upload --config="$cfg" --target=filesystem --outputDir="$out/reports"
  upload_rc=$?
fi
# 工作目录移走：下一档从空目录开始，不可能读到 / 覆盖本档
rm -rf "$work"

status="pass"
if [ "$collect_rc" != "0" ] || [ "$assert_rc" != "0" ] || [ "$upload_rc" != "0" ]; then status="fail"; fi
printf '{"tier":"%s","config":"%s","collect":"%s","assert":"%s","upload":"%s","status":"%s"}\n' \
  "$tier" "$cfg" "$collect_rc" "$assert_rc" "$upload_rc" "$status" > "$out/exit-codes.json"

node "$here/lhci-summary.mjs" "$out" || { echo "::error title=Lighthouse ${tier}::summary 生成失败"; status="fail"; }
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$out/summary.md" ]; then cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi

# 清单最后写（覆盖本档全部文件）
( cd "$out" && find . -type f ! -name manifest.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ) > "$out/manifest.sha256"

echo "Lighthouse ${tier}：collect=$collect_rc assert=$assert_rc upload=$upload_rc → $status"
[ "$status" = "pass" ] || exit 1
