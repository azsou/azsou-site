#!/usr/bin/env bash
# Lighthouse CI 一档（mobile / desktop）：collect → assert → 归档并核对 → upload → 摘要 → 证据核对 → 退出码记录 → 清单。
# 产物各自独立，后跑的档不能覆盖、也不能清理先跑的档。
#
#   bash scripts/ci/lhci-tier.sh <档名> <lighthouserc 配置> [输出根目录，默认 lhci-out] [<页数>x<每页次数>]
#
# 输出（<输出根目录>/<档名>/）：
#   raw/             LHCI 工作目录 .lighthouseci 的原样副本：每次运行的 lhr-*.json / .html + assertion-results.json
#   reports/         lhci upload --target=filesystem 的报告（*.report.json / .html + manifest.json）
#   summary.json/md  每页每次的 LCP / CLS / TBT / 体积 / 四项分数 + 中位数（scripts/ci/lhci-summary.mjs；聚合方式不变）
#   verify.json      证据完整性核对结果（scripts/ci/lhci-verify.mjs；给了 <页数>x<每页次数> 才跑）
#   exit-codes.json  每一步的结果与本档结论（与本脚本的最终退出码一致）
#   manifest.sha256  本档全部文件的 sha256（最后写；lhci-gate.sh 复核）
#
# 规则（r14：每个文件操作都检查）：
#   - 输出目录已存在 → 拒绝（退出码 2），一个字节都不写；
#   - .lighthouseci 在本档开始前存在（上一档没归档成功、按规则留下了）→ 拒绝（退出码 2），不读、不删、不覆盖它；
#     这时本档自己的输出目录（不存在才建）里只写一份 exit-codes.json 说明被拒；
#   - mkdir / 归档复制 / 归档核对 / summary / verify / exit-codes / manifest 任一失败 → 记录（::error + exit-codes.json 能写就写）并非 0；
#   - 归档核对（逐文件 sha256 比对 .lighthouseci 与 raw/）通过之前绝不删除 .lighthouseci；归档失败就把它原样留下（后一档会因此拒绝启动）；
#   - 退出码不吞：collect / assert / upload 任一非 0 → 本档非 0；collect 失败不跑 assert（记 not-run）；assert 退出 0 但没写
#     assertion-results.json 也判失败（缺失 ≠ 空数组）。
# 最终退出码：0 通过；1 测量 / 断言 / 证据不完整；2 拒绝运行；3 本档的文件操作失败（证据可能不全）。
# LHCI 命令可用环境变量 LHCI 覆盖（单元测试用假 lhci），默认 npx --yes @lhci/cli@0.15.x。
set -uo pipefail

tier="${1:?用法：lhci-tier.sh <档名> <配置> [输出根目录] [<页数>x<每页次数>]}"
cfg="${2:?缺配置文件}"
root="${3:-lhci-out}"
expect="${4:-}"
out="$root/$tier"
work=".lighthouseci"
LHCI="${LHCI:-npx --yes @lhci/cli@0.15.x}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

err() { echo "::error title=Lighthouse ${tier}${2:+（$2）}::$1"; }

if [[ ! "$tier" =~ ^[a-z0-9-]+$ ]]; then err "档名只允许 a-z0-9-"; exit 2; fi
if [ -n "$expect" ] && [[ ! "$expect" =~ ^[0-9]+x[0-9]+$ ]]; then err "期望样本格式应为 <页数>x<每页次数>：$expect"; exit 2; fi
if [ -e "$out" ] || [ -L "$out" ]; then
  err "输出目录 $out 已存在，不会覆盖先前的结果" "拒绝覆盖"
  exit 2
fi
if [ -e "$work" ] || [ -L "$work" ]; then
  err "$work 已存在：上一档没有归档成功（按规则原样保留），拒绝运行，不读、不删、不覆盖它" "工作目录未清理"
  if mkdir -p "$out"; then
    printf '{"tier":"%s","config":"%s","status":"refused","reason":"workdir-present"}\n' "$tier" "$cfg" > "$out/exit-codes.json" \
      || err "拒绝记录写不进 $out/exit-codes.json" "记录失败"
  fi
  exit 2
fi

# 每一步的结果；"0" = 成功，其他 = 失败原因或退出码
collect_rc="not-run"; assert_rc="not-run"; assert_file="not-checked"; archive="not-run"; upload_rc="not-run"
cleanup="not-run"; summary_rc="not-run"; verify_rc="not-run"; fileop=0

if ! mkdir -p "$out/raw" "$out/reports"; then
  err "建不了输出目录 $out/raw、$out/reports" "文件操作失败"
  # 能写就留一份记录；写不进也照样非 0
  [ -d "$out" ] && printf '{"tier":"%s","config":"%s","mkdir":"fail","status":"fail"}\n' "$tier" "$cfg" > "$out/exit-codes.json" 2>/dev/null
  exit 3
fi

echo "== Lighthouse ${tier}：collect（$cfg）"
$LHCI collect --config="$cfg"
collect_rc=$?
if [ "$collect_rc" -eq 0 ]; then
  echo "== Lighthouse ${tier}：assert"
  $LHCI assert --config="$cfg"
  assert_rc=$?
  if [ -f "$work/assertion-results.json" ]; then assert_file="present"; else
    assert_file="missing"
    err "assert 退出码 $assert_rc，但没有写 $work/assertion-results.json（缺失不能当作「全部通过」）"
  fi
else
  err "collect 退出码 $collect_rc，不做断言（本档判失败）"
fi

# 原始 LHR 与断言结果先归档并逐文件核对（upload 之前）
sha_list() { ( cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ); }
if [ ! -d "$work" ]; then
  archive="no-workdir"
  err "collect 之后没有 $work，没有可归档的原始数据"
else
  if ! cp -a "$work/." "$out/raw/"; then
    archive="copy-failed"
    err "复制 $work → $out/raw 失败（可能只复制了一部分）；$work 原样保留" "归档失败"
  else
    src_sum=$(sha_list "$work") || src_sum="__err_src__"
    dst_sum=$(sha_list "$out/raw") || dst_sum="__err_dst__"
    if [ "$src_sum" = "$dst_sum" ] && [ -n "$src_sum" ]; then archive="0"; else
      archive="verify-failed"
      err "$out/raw 与 $work 逐文件 sha256 不一致或为空；$work 原样保留" "归档核对失败"
    fi
  fi
fi

if [ "$archive" = "0" ] && ls "$out/raw"/lhr-*.json >/dev/null 2>&1; then
  echo "== Lighthouse ${tier}：upload → $out/reports"
  $LHCI upload --config="$cfg" --target=filesystem --outputDir="$out/reports"
  upload_rc=$?
fi

# 只有归档核对通过才移走工作目录；删除失败也记下来（下一档会因残留拒绝启动）
if [ "$archive" = "0" ]; then
  if rm -rf "$work" && [ ! -e "$work" ]; then cleanup="0"; else
    cleanup="rm-failed"
    err "归档已核对，但删不掉 $work" "清理失败"
  fi
else
  cleanup="kept-unarchived"
fi

steps=$(printf '{"collect":"%s","assert":"%s","assertionResultsFile":"%s","archive":"%s","upload":"%s","cleanup":"%s"}' \
  "$collect_rc" "$assert_rc" "$assert_file" "$archive" "$upload_rc" "$cleanup")
if LHCI_STEPS="$steps" node "$here/lhci-summary.mjs" "$out"; then summary_rc="0"; else
  summary_rc="fail"
  err "summary.json / summary.md 没写成" "摘要失败"
fi
if [ -n "$expect" ]; then
  if node "$here/lhci-verify.mjs" "$out" "$cfg" "$expect" --json "$out/verify.json"; then verify_rc="0"; else verify_rc="1"; fi
fi

status="pass"
for v in "$collect_rc" "$assert_rc" "$upload_rc"; do [ "$v" = "0" ] || status="fail"; done
[ "$assert_file" = "present" ] || status="fail"
if [ "$archive" != "0" ] || [ "$cleanup" != "0" ] || [ "$summary_rc" != "0" ]; then status="fail"; fileop=1; fi
if [ -n "$expect" ] && [ "$verify_rc" != "0" ]; then status="fail"; fi

write_codes() { # $1 = manifest 结果（"pending" 表示马上写清单）
  printf '{"tier":"%s","config":"%s","expect":"%s","collect":"%s","assert":"%s","assertionResultsFile":"%s","archive":"%s","upload":"%s","cleanup":"%s","summary":"%s","verify":"%s","manifest":"%s","status":"%s"}\n' \
    "$tier" "$cfg" "$expect" "$collect_rc" "$assert_rc" "$assert_file" "$archive" "$upload_rc" "$cleanup" "$summary_rc" "$verify_rc" "$1" "$status" > "$out/exit-codes.json"
}
codes_ok=1
if ! write_codes "pending"; then codes_ok=0; status="fail"; fileop=1; err "exit-codes.json 写不进去" "记录失败"; fi

# 清单最后写（覆盖本档全部文件）；先写临时文件，成功再改名。"pending" 由 lhci-gate.sh 结合清单是否存在 / 复核通过来解读
manifest="0"
if ! ( cd "$out" && find . -type f ! -name manifest.sha256 ! -name manifest.sha256.tmp -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) > "$out/manifest.sha256.tmp" \
  || ! mv -f "$out/manifest.sha256.tmp" "$out/manifest.sha256" || [ ! -f "$out/manifest.sha256" ]; then
  manifest="fail"; status="fail"; fileop=1
  err "manifest.sha256 没写成（本档证据无法复核）" "清单失败"
  # 结论改成失败再记一次（这时没有有效清单，gate 也会判失败）
  if [ "$codes_ok" = 1 ]; then write_codes "fail" || err "exit-codes.json 改写失败" "记录失败"; fi
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$out/summary.md" ]; then
  { cat "$out/summary.md"; echo; echo "**本档结论：$status**（$steps，summary=$summary_rc，verify=$verify_rc，manifest=$manifest）"; echo; } >> "$GITHUB_STEP_SUMMARY" || true
fi

echo "Lighthouse ${tier}：collect=$collect_rc assert=$assert_rc assertion-results=$assert_file archive=$archive upload=$upload_rc cleanup=$cleanup summary=$summary_rc verify=$verify_rc manifest=$manifest → $status"
[ "$status" = "pass" ] && exit 0
[ "$fileop" = 1 ] && exit 3
exit 1
