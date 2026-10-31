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
#   - （r24，LH_EVIDENCE=1）逐样本调度：不再用一次 collect 跑完 <页数>×<每页次数>，而是按原顺序（同一配置、同一页序，
#     每页连续 numberOfRuns 次）为每个计划样本单独调用一次 `collect --additive --url=<该样本 URL> --numberOfRuns=1`
#     （配置文件不改；--additive 保证不清除先前样本）。每个样本有明确身份 档 / pageIndex / runIndex，调用前后各记一条台账
#     <档目录>/slots.jsonl（scripts/ci/lhci-slots.mjs），钩子按样本身份阻止同一样本的第二次调用：
#       · 样本正常结束 → 继续；样本采集失败（正好 1 次真实尝试、退出码非 0，如 NO_NAVSTART）→ 原样记录，不重试、不替补，
#         继续下一个计划样本（同一页的下一个计划样本是独立样本，不是替补），分母不变，本档最终仍失败（collect=1）；
#       · 其他一切（没有尝试 / 多次真实尝试 / 尝试属于别的样本或 URL 不符 / 钩子或留存写入出错 / collect 与尝试结果矛盾 /
#         先前 lhr 被清 / 台账写不进或拒绝 / 上个样本的服务器还占着端口）→ 停止本档采集（scheduler=stop:…，collect=stopped），
#         照常归档已有证据，但**不写交接记录**（退出码 5），后一档不测量；收到信号 / 超时 → 立即退出，也不交接。
#     任一样本失败或缺失：collect≠0 → 不跑 assert（not-run），不会用 2 个值的中位数冒充 3 次验收。
#   - （r24）收尾不完整（归档 / 删除 .lighthouseci 失败，cleanup ∉ {0, not-run}）→ 不写交接记录，后一档不测量。
#   - （r25）样本之间的产物闸门：每个样本结束后、下一个样本开始前，lhci-slots.mjs end 用整档对应表的同一套检查核对本样本的实际产物
#     （LHR / trace / devtools 归属于计划页面、已留存、能解析、stdout LHR ↔ 工作目录 lhr 一一对应）。可确认的正常测量失败（如真实
#     NO_NAVSTART：LHR 带 runtimeError，身份与已产生的证据可核对）→ 记 collection-failed、不重试，继续下一个独立样本；产物属于别的页面、
#     留存写入失败、证据解析不了或归属不了、无法分类的异常 → 停止（不交接）。不是「两个退出码都非 0」就算正常失败。
#   - （r25）收尾可核对才交接：summary.json / summary.md、verify.json（与 verify 退出码一致）、evidence-map.json（与证据结论一致）、
#     exit-codes.json（能解析、与本档一致）、manifest.sha256（逐文件复核通过且正好覆盖本档目录）任一没生成或不可核对，或任何文件操作失败
#     → 收尾故障（failureKinds 含 finishing、fileop；exit-codes.json 的 finishing 记具体项），不写交接记录，后一档不测量。
#     测量结论失败（采集失败 / 断言失败 / 证据不完整）而收尾完整 → 照常交接。verify 正常报告样本失败（1）≠ verify.json 写不进。
#   - （r25）证据对应表在摘要之前生成；摘要按对应表给出每页计划 / 有效 / 失败 / 未尝试 / 证据不完整，不完整页不给中位数。
# 最终退出码：0 通过；1 测量 / 断言 / 证据不完整；2 拒绝运行；3 本档的文件操作失败（证据可能不全）；4 证据留存前提不满足、collect 未运行（r19）；
#   5 逐样本调度停止（r24，不交接）。
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
sched="off"; slots_planned=0; slots_measured=0; slots_failed=0; slots_done=0

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
  echo "== Lighthouse ${tier}：逐样本 collect（$cfg；saveAssets，逐次尝试留存，同一样本第二次调用被阻止）"
  # saveAssets 走 LHCI 支持的 collect.settings（node-runner.js 把 settings 写进 --cli-flags-path 传给 Lighthouse）；
  # 用命令行 --settings.saveAssets（不带值 = 布尔 true）合并进配置里的 settings，配置文件本身不改。
  # r24：每个计划样本单独一次 collect（--additive：不清除先前样本；--url / --numberOfRuns=1：只测本样本），其余设置全部来自原配置。
  abs_work="$PWD/$work"
  slot_plan=""
  if slot_plan=$(node "$here/lhci-slots.mjs" plan "$cfg" "$expect" </dev/null); then sched="running"; else sched="stop:plan-failed"; fi
  [ -n "$slot_plan" ] && slots_planned=$(printf '%s\n' "$slot_plan" | wc -l)
  while [ "$sched" = running ] && IFS=$'\t' read -r -u 3 s_planned s_page s_run s_url; do
    if ! node "$here/lhci-slots.mjs" portfree "$s_url" </dev/null; then
      sched="stop:port-busy-#$s_planned"
      node "$here/lhci-slots.mjs" stop "$abs_out" "$sched" </dev/null || sched="$sched+ledger-write-failed"
      break
    fi
    if ! node "$here/lhci-slots.mjs" begin "$abs_out" "$tier" "$s_planned" "$s_page" "$s_run" "$s_url" "$abs_work" </dev/null; then
      sched="stop:begin-refused-#$s_planned"; break
    fi
    s_rc=0
    LH_ATTEMPT_DIR="$abs_out/attempts" LH_ATTEMPT_TIER="$tier" \
      LH_SLOT_PLANNED="$s_planned" LH_SLOT_PAGE="$s_page" LH_SLOT_RUN="$s_run" LH_SLOT_URL="$s_url" \
      NODE_OPTIONS="--require $here/lhci-attempt-hook.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}" \
      $LHCI collect --config="$cfg" --settings.saveAssets --additive --url="$s_url" --numberOfRuns=1 </dev/null || s_rc=$?
    slots_done=$((slots_done + 1))
    s_end=0
    node "$here/lhci-slots.mjs" end "$abs_out" "$tier" "$s_planned" "$s_page" "$s_run" "$s_url" "$abs_work" "$s_rc" "$cfg" </dev/null || s_end=$?
    case "$s_end" in
      0) slots_measured=$((slots_measured + 1)) ;;
      10) slots_failed=$((slots_failed + 1)) ;;
      *) sched="stop:slot-#$s_planned-end-rc$s_end"; break ;;
    esac
  done 3<<<"$slot_plan"
  if [ "$sched" = running ]; then
    if [ "$slots_done" -eq "$slots_planned" ] && [ "$slots_planned" -gt 0 ]; then sched="complete"; else sched="stop:plan-short-$slots_done-of-$slots_planned"; fi
  fi
  if [ "$sched" = complete ]; then
    if [ "$slots_failed" -eq 0 ]; then collect_rc=0; else collect_rc=1; fi
  else
    collect_rc="stopped"
    err "逐样本调度停止（$sched）：已测 $slots_measured、采集失败 $slots_failed、计划 $slots_planned；不再调用 collect，本档不交接" "调度停止"
  fi
  echo "Lighthouse ${tier}：逐样本调度 $sched（计划 $slots_planned，已调用 $slots_done，测成 $slots_measured，采集失败 $slots_failed，未尝试 $((slots_planned - slots_done))）"
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
elif [ "$collect_rc" = "0" ]; then
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

# r25：证据对应表移到摘要之前生成（它只读 attempts / raw / slots.jsonl / env.json，不读摘要、verify），
# 这样摘要能按「计划样本 ↔ 证据」对应表给出每页的计划 / 有效 / 失败 / 未尝试 / 证据不完整数，而不是只数 raw 里成功的 LHR。
if [ "$evidence_on" = 1 ] && [ "$evidence" = "off" ] && [ "$precondition" = "0" ]; then
  if [ -z "$expect" ]; then evidence="no-expect"; err "证据对应表需要 <页数>x<每页次数>" "证据"
  elif node "$here/lhci-evidence.mjs" build "$out" "$cfg" "$expect"; then evidence="0"
  elif [ -f "$out/evidence-map.json" ]; then evidence="incomplete"
  else evidence="map-failed"; fileop=1; err "evidence-map.json 没写成" "文件操作失败"
  fi
fi
steps=$(printf '{"collect":"%s","assert":"%s","assertionResultsFile":"%s","archive":"%s","upload":"%s","cleanup":"%s"}' \
  "$collect_rc" "$assert_rc" "$assert_file" "$archive" "$upload_rc" "$cleanup")
if LHCI_STEPS="$steps" node "$here/lhci-summary.mjs" "$out"; then summary_rc="0"; else
  summary_rc="fail"
  err "summary.json / summary.md 没写成" "摘要失败"
fi
if [ -n "$expect" ]; then
  v_rc=0; node "$here/lhci-verify.mjs" "$out" "$cfg" "$expect" --json "$out/verify.json" || v_rc=$?
  # r25：verify 正常报告证据不完整 = 1；其他退出码（用法错误 / 崩溃）单独记，不当成「正常报告」
  case "$v_rc" in 0) verify_rc="0" ;; 1) verify_rc="1" ;; *) verify_rc="error-$v_rc" ;; esac
fi

# r25：收尾文件必须真的生成且可核对（不只看步骤退出码）：summary.json 能解析、summary.md 非空；verify.json 能解析且 ok
# 与 verify 退出码一致（verify 正常报告样本失败 ≠ verify.json 写不进）；evidence-map.json 能解析且 status 与证据结论一致。
# 任一不满足 = 收尾故障（finishing），本档不交接（下面还有 exit-codes.json / manifest.sha256 的核对）。
jget() { node -e '
  try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const k = process.argv[2];
        process.stdout.write(k ? String(v === null || typeof v !== "object" ? "<not-object>" : v[k]) : "<parsed>"); }
  catch { process.stdout.write("<unparseable>"); }' "$1" "${2:-}"; }
fin=()
{ [ "$summary_rc" = "0" ] && [ "$(jget "$out/summary.json")" = "<parsed>" ] && [ -s "$out/summary.md" ] && [ -f "$out/summary.md" ]; } || fin+=("summary")
if [ -n "$expect" ]; then
  case "$verify_rc" in 0) v_want=true ;; 1) v_want=false ;; *) v_want="<none>" ;; esac
  [ "$(jget "$out/verify.json" ok)" = "$v_want" ] || fin+=("verify")
fi
if [ "$evidence_on" = 1 ] && [ "$precondition" = "0" ]; then
  case "$evidence" in 0) e_want=complete ;; incomplete) e_want=incomplete ;; *) e_want="<none>" ;; esac
  [ "$(jget "$out/evidence-map.json" status)" = "$e_want" ] || fin+=("evidence-map")
fi
for f in "${fin[@]}"; do err "收尾文件 $f 没有生成或不可核对，本档不交接" "收尾故障"; done
[ "${#fin[@]}" -gt 0 ] && fileop=1

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
# r25：每次写 exit-codes.json 前重新计算（清单 / exit-codes 本身出问题时也要反映进来，不会留下空的 failureKinds）；
#      收尾故障单独列为 finishing（同时是 fileop）
pre_failed=0; { [ "$precondition" != "0" ] && [ "$precondition" != "off" ]; } && pre_failed=1
if [ "${sched#stop:}" != "$sched" ]; then status="fail"; fi
calc_kinds() {
  local k; fail_kinds=()
  [ "$pre_failed" = 1 ] && fail_kinds+=("precondition")
  if [ "${sched#stop:}" != "$sched" ]; then fail_kinds+=("stopped"); fi
  if [ "$collect_rc" != "not-run" ] && [ "$collect_rc" != "0" ]; then fail_kinds+=("collection"); fi
  if [ "$collect_rc" = "0" ] && { [ "$assert_rc" != "0" ] || [ "$assert_file" != "present" ]; }; then fail_kinds+=("assertion"); fi
  if [ "$evidence_on" = 1 ] && [ "$precondition" = "0" ] && { [ "$evidence" != "0" ] || [ "$stray" != "0" ]; }; then fail_kinds+=("evidence"); fi
  [ "$fileop" = 1 ] && fail_kinds+=("fileop")
  [ "${#fin[@]}" -gt 0 ] && fail_kinds+=("finishing")
  if [ "$collect_rc" = "0" ] && [ "$upload_rc" != "0" ]; then fail_kinds+=("upload"); fi
  [ "$status" != "pass" ] && [ "${#fail_kinds[@]}" -eq 0 ] && fail_kinds+=("unclassified")
  kinds_json="[$(for k in "${fail_kinds[@]}"; do printf '"%s",' "$k"; done | sed 's/,$//')]"
  if [ "${#fin[@]}" -eq 0 ]; then fin_json="0"; else fin_json="$(IFS=,; echo "${fin[*]}")"; fi
}
# 前提不满足时把已产生的文件列进记录（本档目录里，除 exit-codes.json / 清单本身）
produced_json="[]"
if [ "$pre_failed" = 1 ]; then
  produced_json="[$( (cd "$out" && find . -mindepth 1 ! -name exit-codes.json ! -name 'manifest.sha256*' -printf '"%y:%P"\n' 2>/dev/null) | LC_ALL=C sort | paste -sd, -)]"
fi
write_codes() { # $1 = manifest 结果（"pending" 表示马上写清单）
  calc_kinds
  printf '{"tier":"%s","config":"%s","expect":"%s","precondition":"%s","collect":"%s","assert":"%s","assertionResultsFile":"%s","archive":"%s","upload":"%s","cleanup":"%s","summary":"%s","verify":"%s","env":"%s","evidence":"%s","strayAssets":"%s","scheduler":"%s","slots":{"planned":%s,"called":%s,"measured":%s,"collectionFailed":%s,"notAttempted":%s},"failureKinds":%s,"finishing":"%s","producedBeforeStop":%s,"manifest":"%s","status":"%s"}\n' \
    "$tier" "$cfg" "$expect" "$precondition" "$collect_rc" "$assert_rc" "$assert_file" "$archive" "$upload_rc" "$cleanup" "$summary_rc" "$verify_rc" "$envrec" "$evidence" "$stray" "$sched" "$slots_planned" "$slots_done" "$slots_measured" "$slots_failed" "$((slots_planned - slots_done))" "$kinds_json" "$fin_json" "$produced_json" "$1" "$status" > "$out/exit-codes.json"
}
codes_ok=1
[ "${#fin[@]}" -gt 0 ] && status="fail"
if ! write_codes "pending"; then codes_ok=0; status="fail"; fileop=1; fin+=("exit-codes"); err "exit-codes.json 写不进去" "记录失败"; fi

# 清单最后写（覆盖本档全部文件）；先写临时文件，成功再改名。"pending" 由 lhci-gate.sh 结合清单是否存在 / 复核通过来解读
manifest="0"
if ! ( cd "$out" && find . -type f ! -name manifest.sha256 ! -name manifest.sha256.tmp -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) > "$out/manifest.sha256.tmp" \
  || ! mv -f "$out/manifest.sha256.tmp" "$out/manifest.sha256" || [ ! -f "$out/manifest.sha256" ]; then
  manifest="fail"; status="fail"; fileop=1; fin+=("manifest")
  err "manifest.sha256 没写成（本档证据无法复核）" "清单失败"
  # 结论改成失败再记一次（这时没有有效清单，gate 也会判失败）
  if [ "$codes_ok" = 1 ]; then write_codes "fail" || err "exit-codes.json 改写失败" "记录失败"; fi
fi

# r25：清单写成之后再核对一次：exit-codes.json 能解析且 status / tier 与本档一致；manifest.sha256 逐文件复核通过且正好覆盖本档全部文件。
# 不通过 = 收尾故障，不交接；exit-codes.json 能写就改记一次（这时清单已不覆盖它，gate 也会判失败）。
if [ "$manifest" = "0" ]; then
  post_fin=()
  { [ "$(jget "$out/exit-codes.json" status)" = "$status" ] && [ "$(jget "$out/exit-codes.json" tier)" = "$tier" ]; } || post_fin+=("exit-codes")
  m_listed=$(sed -E 's/^[0-9a-f]{64}  //' "$out/manifest.sha256" 2>/dev/null | LC_ALL=C sort) || m_listed="__err__"
  m_actual=$(cd "$out" && find . -type f ! -name manifest.sha256 | LC_ALL=C sort) || m_actual="__err_actual__"
  { (cd "$out" && sha256sum --quiet --strict -c manifest.sha256 >/dev/null 2>&1) && [ "$m_listed" = "$m_actual" ]; } || post_fin+=("manifest")
  if [ "${#post_fin[@]}" -gt 0 ]; then
    fin+=("${post_fin[@]}"); status="fail"; fileop=1
    [[ " ${post_fin[*]} " == *" manifest "* ]] && manifest="unverifiable"
    err "收尾核对不通过（${post_fin[*]}），本档不交接" "收尾故障"
    write_codes "$manifest" || err "exit-codes.json 改写失败" "记录失败"
  fi
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$out/summary.md" ]; then
  { cat "$out/summary.md"; echo; echo "**本档结论：$status**（$steps，summary=$summary_rc，verify=$verify_rc，manifest=$manifest）"; echo; } >> "$GITHUB_STEP_SUMMARY" || true
fi

echo "Lighthouse ${tier}：scheduler=$sched collect=$collect_rc assert=$assert_rc assertion-results=$assert_file archive=$archive upload=$upload_rc cleanup=$cleanup summary=$summary_rc verify=$verify_rc env=$envrec evidence=$evidence stray=$stray manifest=$manifest → $status"
final_rc=1
if [ "$status" = "pass" ]; then final_rc=0
elif [ "${sched#stop:}" != "$sched" ]; then final_rc=5
elif [ "$pre_failed" = 1 ]; then final_rc=4
elif [ "$fileop" = 1 ]; then final_rc=3
fi
# r24：调度停止（计划没有正常走完）或收尾不完整（.lighthouseci 没归档 / 没删掉）→ 不交接，后一档不测量
if [ "$final_rc" = 5 ]; then
  err "逐样本调度停止（$sched），不写交接记录（后一档不会测量）" "交接"
  exit "$final_rc"
fi
if [ "$cleanup" != "0" ] && [ "$cleanup" != "not-run" ]; then
  err "收尾不完整（cleanup=$cleanup），不写交接记录（后一档不会测量）" "交接"
  exit "$final_rc"
fi
# r25：收尾文件（summary / verify / evidence-map / exit-codes / manifest）没有生成或不可核对、或任何文件操作失败 → 不交接。
# 测量结论失败（采集失败、断言失败、证据不完整）而收尾完整 → 照常交接；两者分开。
if [ "${#fin[@]}" -gt 0 ] || [ "$fileop" = 1 ]; then
  calc_kinds
  err "收尾没有可靠完成（finishing=$fin_json，fileop=$fileop），不写交接记录（后一档不会测量）" "交接"
  exit "$final_rc"
fi
# r20：正常走完全部收尾（上面 summary / verify / evidence-map / exit-codes / manifest 都已处理）→ 最后写交接记录，然后立即退出。
# 写不成只记错误、不改本档退出码（后一档会因为没有有效交接记录而不测量）。
node "$here/lhci-handoff.mjs" write "$root" "$tier" "$cfg" "$expect" "$final_rc" "$status" "$manifest" \
  || err "交接记录 $handoff_file 没写成（后一档不会测量）" "交接"
exit "$final_rc"
