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
#   （LH_EVIDENCE=1 时另有，r18）
#   env.json         宿主环境与 LHCI 选用的浏览器路径 / 版本（scripts/ci/lhci-env.mjs；白名单字段，不含凭据）
#   attempts/        每次 Lighthouse 子进程尝试一个目录 attempt-NNN/：stdout.json（LHR 原文）、stderr.log、saveAssets 写的
#                    <前缀>-0.trace.json / -0.devtoolslog.json；attempts.jsonl 记录计划样本序号、退出码、CHROME_PATH、GitHub run_attempt
#                    （scripts/ci/lhci-attempt-hook.cjs；失败尝试也保留；LHCI 内部重试被阻止、不测量）
#   evidence-map.json 计划样本 × 实际尝试 → LHR / trace / devtools 日志的对应表（scripts/ci/lhci-evidence.mjs）
#   stray-assets/    （只在出问题时）collect 后仓库根目录出现的游离 trace / devtools 文件，移到这里并判失败
#
# 规则（r14：每个文件操作都检查）：
#   - 输出目录已存在 → 拒绝（退出码 2），一个字节都不写；
#   - .lighthouseci 在本档开始前存在（上一档没归档成功、按规则留下了）→ 拒绝（退出码 2），不读、不删、不覆盖它；
#     这时本档自己的输出目录（不存在才建）里只写一份 exit-codes.json 说明被拒；
#   - mkdir / 归档复制 / 归档核对 / summary / verify / exit-codes / manifest 任一失败 → 记录（::error + exit-codes.json 能写就写）并非 0；
#   - 归档核对（逐文件 sha256 比对 .lighthouseci 与 raw/）通过之前绝不删除 .lighthouseci；归档失败就把它原样留下（后一档会因此拒绝启动）；
#   - 退出码不吞：collect / assert / upload 任一非 0 → 本档非 0；collect 失败不跑 assert（记 not-run）；assert 退出 0 但没写
#     assertion-results.json 也判失败（缺失 ≠ 空数组）。
#   - （r18，LH_EVIDENCE=1）开始前仓库根目录已有 *.trace.json / *.devtoolslog.json → 拒绝（退出码 2），不碰它们；
#     证据对应表不完整（失败样本、没尝试到的样本、缺 trace / devtools、LHR 对不上、内部重试被阻止、环境记录失败）→ 本档失败（1），
#     证据留存再完整也不会把断言失败变成通过，断言 / collect 失败也不会因为证据完整而通过。
#   - （r19，LH_EVIDENCE=1）证据留存前提（样本期望、钩子、核对脚本、环境记录、attempts 目录）任一不满足 → 不调用 collect
#     （collect=not-run，不做断言 / 归档 / 上传），exit-codes.json 记 precondition 原因与 producedBeforeStop（已产生的文件），退出码 4；
#     failureKinds 分开列出 precondition / collection / assertion / evidence / fileop / upload，不互相替代。
#   - （r20）正常走完全部收尾（summary、verify、evidence-map、exit-codes.json、manifest 都处理完）之后，最后一步写
#     <输出根目录>/<档名>.handoff.json（scripts/ci/lhci-handoff.mjs；记录本档退出码与结论，包括性能断言失败），然后立即退出。
#     不在 trap / 异常路径里写：本档被中断 / 超时 / 被杀 → 没有交接记录。本档开始前交接记录已存在 → 拒绝（退出码 2）。
#   - （r20）设了 LH_HANDOFF_FROM=<前一档名>（桌面档用 mobile）时，前一档的交接记录必须存在且有效（lhci-handoff.mjs check），
#     否则不调用 collect（前提不满足，precondition 记 handoff-missing-or-invalid，退出码 4）。只要求前一档正常走完，不要求它通过。
# 最终退出码：0 通过；1 测量 / 断言 / 证据不完整；2 拒绝运行；3 本档的文件操作失败（证据可能不全）；4 证据留存前提不满足、collect 未运行（r19）。
# LHCI 命令可用环境变量 LHCI 覆盖（单元测试用假 lhci）；默认用 tools/lhci 里按 package-lock 固定的 @lhci/cli 0.15.1
# （依赖 lighthouse 12.6.1；先 npm ci --prefix tools/lhci）。没装就拒绝运行，不再临时 npx 解析 0.15.x 范围。
set -uo pipefail

tier="${1:?用法：lhci-tier.sh <档名> <配置> [输出根目录] [<页数>x<每页次数>]}"
cfg="${2:?缺配置文件}"
root="${3:-lhci-out}"
expect="${4:-}"
out="$root/$tier"
work=".lighthouseci"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pin_cli="$here/../../tools/lhci/node_modules/@lhci/cli/src/cli.js"
LHCI="${LHCI:-node $pin_cli}"
evidence_on="${LH_EVIDENCE:-0}"
handoff_from="${LH_HANDOFF_FROM:-}"
handoff_file="$root/$tier.handoff.json"

err() { echo "::error title=Lighthouse ${tier}${2:+（$2）}::$1"; }
# r20：收到中断 / 终止信号就立即退出，绝不继续走到最后写交接记录（这里不写任何记录，只退出）
# shellcheck disable=SC2317 # 由 trap 调用
on_sig() { err "收到 SIG$1，立即退出（不写交接记录，后一档不会测量）" "中断"; exit "$2"; }
trap 'on_sig INT 130' INT
trap 'on_sig TERM 143' TERM
trap 'on_sig HUP 129' HUP

if [[ ! "$tier" =~ ^[a-z0-9-]+$ ]]; then err "档名只允许 a-z0-9-"; exit 2; fi
if [ -n "$expect" ] && [[ ! "$expect" =~ ^[0-9]+x[0-9]+$ ]]; then err "期望样本格式应为 <页数>x<每页次数>：$expect"; exit 2; fi
if [ -e "$out" ] || [ -L "$out" ]; then
  err "输出目录 $out 已存在，不会覆盖先前的结果" "拒绝覆盖"
  exit 2
fi
if [ -e "$handoff_file" ] || [ -L "$handoff_file" ] || [ -e "$handoff_file.tmp" ]; then
  err "交接记录 $handoff_file 在本档开始前已存在（来源不明），拒绝运行，不读、不删、不覆盖" "拒绝覆盖"
  exit 2
fi
if [ -n "$handoff_from" ] && [[ ! "$handoff_from" =~ ^[a-z0-9-]+$ ]]; then err "LH_HANDOFF_FROM 只允许 a-z0-9-"; exit 2; fi
if [ "$LHCI" = "node $pin_cli" ] && [ ! -f "$pin_cli" ]; then
  err "没有固定版本的 @lhci/cli（先 npm ci --prefix tools/lhci）；不会临时解析版本范围" "工具未安装"
  exit 2
fi
if [ "$evidence_on" = 1 ]; then
  shopt -s nullglob
  pre_stray=( ./*.trace.json ./*.devtoolslog.json )
  shopt -u nullglob
  if [ "${#pre_stray[@]}" -gt 0 ]; then
    err "仓库根目录已有 ${#pre_stray[*]} 个 trace / devtools 文件（${pre_stray[*]}），来源不明，拒绝运行，不读、不删、不覆盖" "游离资产"
    if mkdir -p "$out"; then
      printf '{"tier":"%s","config":"%s","status":"refused","reason":"stray-assets-present"}\n' "$tier" "$cfg" > "$out/exit-codes.json" \
        || err "拒绝记录写不进 $out/exit-codes.json" "记录失败"
    fi
    exit 2
  fi
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
envrec="off"; evidence="off"; stray="off"; precondition="off"; pre_fail=()

if ! mkdir -p "$out/raw" "$out/reports"; then
  err "建不了输出目录 $out/raw、$out/reports" "文件操作失败"
  # 能写就留一份记录；写不进也照样非 0
  [ -d "$out" ] && printf '{"tier":"%s","config":"%s","mkdir":"fail","status":"fail"}\n' "$tier" "$cfg" > "$out/exit-codes.json" 2>/dev/null
  exit 3
fi

pre_fail=()
# r20：前一档必须正常走完（有有效交接记录）才测量本档；不要求前一档通过
if [ -n "$handoff_from" ]; then
  if node "$here/lhci-handoff.mjs" check "$root" "$handoff_from"; then echo "前一档 $handoff_from 的交接记录有效"; else
    pre_fail+=("handoff-missing-or-invalid"); err "前一档 $handoff_from 没有有效的交接记录（没有正常走完），不调用 collect" "交接"
  fi
fi
if [ "$evidence_on" = 1 ]; then
  # r19：证据留存前提（环境记录、attempts 目录、钩子与核对脚本、样本期望）全部满足之后才调用 collect；
  # 任一不满足 → 不调用 collect（collect=not-run），记录原因与已产生的文件，本档失败（退出码 4）。
  [ -n "$expect" ] || pre_fail+=("no-expect")
  [ -s "$here/lhci-attempt-hook.cjs" ] && [ -r "$here/lhci-attempt-hook.cjs" ] || pre_fail+=("hook-missing")
  [ -r "$here/lhci-evidence.mjs" ] || pre_fail+=("evidence-script-missing")
  # 宿主环境 + LHCI 选用的浏览器
  if node "$here/lhci-env.mjs" > "$out/env.json"; then envrec="0"; else
    envrec="fail"; pre_fail+=("env-record-failed"); err "环境记录不完整（见 $out/env.json 的 problems）" "环境记录"
  fi
  abs_out="$(cd "$out" && pwd)" || abs_out=""
  if [ -z "$abs_out" ] || ! mkdir "$abs_out/attempts"; then
    err "建不了 $out/attempts" "文件操作失败"; fileop=1; evidence="mkdir-failed"; pre_fail+=("attempts-mkdir-failed")
  fi
fi
if [ "${#pre_fail[@]}" -gt 0 ]; then
  precondition="$(IFS=,; echo "${pre_fail[*]}")"
  err "测量前提不满足（$precondition），不调用 collect；本档失败" "前提不满足"
  if [ "$evidence_on" = 1 ]; then
    [ "$evidence" = "off" ] && evidence="not-run"
    stray="not-run"
  fi
elif [ "$evidence_on" = 1 ]; then
  precondition="0"
  echo "== Lighthouse ${tier}：collect（$cfg；saveAssets，逐次尝试留存，内部重试阻止）"
  # saveAssets 走 LHCI 支持的 collect.settings（node-runner.js 把 settings 写进 --cli-flags-path 传给 Lighthouse）；
  # 用命令行 --settings.saveAssets（不带值 = 布尔 true）合并进配置里的 settings，配置文件本身不改
  LH_ATTEMPT_DIR="$abs_out/attempts" LH_ATTEMPT_TIER="$tier" \
    NODE_OPTIONS="--require $here/lhci-attempt-hook.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}" \
    $LHCI collect --config="$cfg" --settings.saveAssets
  collect_rc=$?
  # 钩子没生效时 saveAssets 会写到当前目录：移进本档 stray-assets/ 并判失败（不删）
  shopt -s nullglob
  post_stray=( ./*.trace.json ./*.devtoolslog.json )
  shopt -u nullglob
  stray="0"
  if [ "${#post_stray[@]}" -gt 0 ]; then
    stray="found-${#post_stray[@]}"
    err "collect 后仓库根目录出现 ${#post_stray[*]} 个游离 trace / devtools 文件（钩子未生效？），移到 $out/stray-assets/ 并判失败" "游离资产"
    if ! { mkdir -p "$out/stray-assets" && mv -n "${post_stray[@]}" "$out/stray-assets/"; }; then
      stray="move-failed"; fileop=1; err "游离资产移不进 $out/stray-assets/（原样留在仓库根目录）" "文件操作失败"
    fi
  fi
else
  echo "== Lighthouse ${tier}：collect（$cfg）"
  $LHCI collect --config="$cfg"
  collect_rc=$?
fi
if [ "$collect_rc" = "not-run" ]; then
  echo "Lighthouse ${tier}：collect 未运行（前提不满足），不做断言、归档、上传"
elif [ "$collect_rc" -eq 0 ]; then
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
if [ "$collect_rc" = "not-run" ]; then
  archive="not-run"
elif [ ! -d "$work" ]; then
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
elif [ "$archive" = "not-run" ]; then
  cleanup="not-run"
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
if [ "$evidence_on" = 1 ] && [ "$evidence" = "off" ] && [ "$precondition" = "0" ]; then
  if [ -z "$expect" ]; then evidence="no-expect"; err "证据对应表需要 <页数>x<每页次数>" "证据"
  elif node "$here/lhci-evidence.mjs" build "$out" "$cfg" "$expect"; then evidence="0"
  elif [ -f "$out/evidence-map.json" ]; then evidence="incomplete"
  else evidence="map-failed"; fileop=1; err "evidence-map.json 没写成" "文件操作失败"
  fi
fi

status="pass"
for v in "$collect_rc" "$assert_rc" "$upload_rc"; do [ "$v" = "0" ] || status="fail"; done
[ "$assert_file" = "present" ] || status="fail"
if [ "$collect_rc" = "not-run" ]; then status="fail"
elif [ "$archive" != "0" ] || [ "$cleanup" != "0" ] || [ "$summary_rc" != "0" ]; then status="fail"; fileop=1; fi
if [ -n "$expect" ] && [ "$verify_rc" != "0" ]; then status="fail"; fi
if [ "$evidence_on" = 1 ]; then
  for v in "$precondition" "$envrec" "$evidence" "$stray"; do [ "$v" = "0" ] || status="fail"; done
  [ "$fileop" = 1 ] && status="fail"
fi

# r19：失败分类分开记录（性能断言失败 ≠ 采集失败 ≠ 证据失败 ≠ 前提不满足）；只是记录，不改变上面的判定
fail_kinds=()
pre_failed=0; { [ "$precondition" != "0" ] && [ "$precondition" != "off" ]; } && pre_failed=1
[ "$pre_failed" = 1 ] && fail_kinds+=("precondition")
if [ "$collect_rc" != "not-run" ] && [ "$collect_rc" != "0" ]; then fail_kinds+=("collection"); fi
if [ "$collect_rc" = "0" ] && { [ "$assert_rc" != "0" ] || [ "$assert_file" != "present" ]; }; then fail_kinds+=("assertion"); fi
if [ "$evidence_on" = 1 ] && [ "$precondition" = "0" ] && { [ "$evidence" != "0" ] || [ "$stray" != "0" ]; }; then fail_kinds+=("evidence"); fi
[ "$fileop" = 1 ] && fail_kinds+=("fileop")
if [ "$collect_rc" = "0" ] && [ "$upload_rc" != "0" ]; then fail_kinds+=("upload"); fi
kinds_json="[$(for k in "${fail_kinds[@]}"; do printf '"%s",' "$k"; done | sed 's/,$//')]"
# 前提不满足时把已产生的文件列进记录（本档目录里，除 exit-codes.json / 清单本身）
produced_json="[]"
if [ "$pre_failed" = 1 ]; then
  produced_json="[$( (cd "$out" && find . -mindepth 1 ! -name exit-codes.json ! -name 'manifest.sha256*' -printf '"%y:%P"\n' 2>/dev/null) | LC_ALL=C sort | paste -sd, -)]"
fi
write_codes() { # $1 = manifest 结果（"pending" 表示马上写清单）
  printf '{"tier":"%s","config":"%s","expect":"%s","precondition":"%s","collect":"%s","assert":"%s","assertionResultsFile":"%s","archive":"%s","upload":"%s","cleanup":"%s","summary":"%s","verify":"%s","env":"%s","evidence":"%s","strayAssets":"%s","failureKinds":%s,"producedBeforeStop":%s,"manifest":"%s","status":"%s"}\n' \
    "$tier" "$cfg" "$expect" "$precondition" "$collect_rc" "$assert_rc" "$assert_file" "$archive" "$upload_rc" "$cleanup" "$summary_rc" "$verify_rc" "$envrec" "$evidence" "$stray" "$kinds_json" "$produced_json" "$1" "$status" > "$out/exit-codes.json"
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

echo "Lighthouse ${tier}：collect=$collect_rc assert=$assert_rc assertion-results=$assert_file archive=$archive upload=$upload_rc cleanup=$cleanup summary=$summary_rc verify=$verify_rc env=$envrec evidence=$evidence stray=$stray manifest=$manifest → $status"
final_rc=1
if [ "$status" = "pass" ]; then final_rc=0
elif [ "$pre_failed" = 1 ]; then final_rc=4
elif [ "$fileop" = 1 ]; then final_rc=3
fi
# r20：正常走完全部收尾（上面 summary / verify / evidence-map / exit-codes / manifest 都已处理）→ 最后写交接记录，然后立即退出。
# 写不成只记错误、不改本档退出码（后一档会因为没有有效交接记录而不测量）。
node "$here/lhci-handoff.mjs" write "$root" "$tier" "$cfg" "$expect" "$final_rc" "$status" "$manifest" \
  || err "交接记录 $handoff_file 没写成（后一档不会测量）" "交接"
exit "$final_rc"
