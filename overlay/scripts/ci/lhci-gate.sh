#!/usr/bin/env bash
# Lighthouse 总结论（lighthouse 任务最后一步，if: always()）。只读，不改任何文件。
#
#   bash scripts/ci/lhci-gate.sh <输出根目录> <档名>=<配置>:<页数>x<每页次数> ...
#   例：bash scripts/ci/lhci-gate.sh lhci-out mobile=lighthouserc.cjs:32x3 desktop=lighthouserc.desktop.cjs:12x1
#
# 每个要求的档都必须同时满足（任一不满足 → 退出码 1，任务失败；缺档 = 失败）：
#   1. exit-codes.json 存在、能解析，tier / config / expect 与这里的要求一致，status = pass，且每一步（collect / assert /
#      archive / upload / cleanup / summary / verify）都是 "0"、assertionResultsFile = present；
#   2. manifest.sha256 存在，sha256sum -c 通过，而且清单正好覆盖目录里的全部文件（多出或少列的文件都算被改动）；
#   3. lhci-verify.mjs 按这里给的期望重新核对证据：assertion-results.json 存在且可解析（合法 [] ≠ 缺失）、页面集合与配置一致、
#      每页样本数 = 期望、无 runtimeError、必需指标齐全、报告清单与摘要一致（不信任档里自带的 verify.json）；
#   4. 工作目录 .lighthouseci 不存在（存在说明某档没归档成功）。
#   5. （r18/r19，环境变量 LH_EVIDENCE=1 时）exit-codes.json 的 precondition（r19）/ env / evidence / strayAssets 都是 "0"，并用 lhci-evidence.mjs check
#      重新计算「计划样本 → 尝试 → LHR / trace / devtools」对应表、与档里的 evidence-map.json 逐项一致（不信任档里自带的结论）；
#      仓库根目录没有游离的 *.trace.json / *.devtoolslog.json。
# 不带期望的旧写法（只给档名）直接判失败：不知道该有多少样本，就不能放行。
set -uo pipefail
root="${1:?用法：lhci-gate.sh <输出根目录> <档名>=<配置>:<页数>x<每页次数> ...}"
shift
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -eq 0 ] && { echo "::error title=Lighthouse 结论::没有给出任何档的期望 → 失败"; exit 1; }

fail=0
bad() { echo "::error title=Lighthouse 结论（$1）::$2"; fail=1; }
field() { node -e '
  try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; process.stdout.write(v === undefined ? "<missing>" : String(v)); }
  catch { process.stdout.write("<unparseable>"); }' "$1" "$2"; }

for spec in "$@"; do
  if [[ ! "$spec" =~ ^([a-z0-9-]+)=([^:]+):([0-9]+x[0-9]+)$ ]]; then
    bad "$spec" "期望格式应为 <档名>=<配置>:<页数>x<每页次数>（旧写法只给档名，不知道样本数，不放行）"
    continue
  fi
  t="${BASH_REMATCH[1]}"; cfg="${BASH_REMATCH[2]}"; exp="${BASH_REMATCH[3]}"
  d="$root/$t"
  if [ ! -f "$d/exit-codes.json" ]; then
    bad "$t" "没有 exit-codes.json（步骤没跑、被打断或记录写失败）"
    continue
  fi
  echo "$t：$(cat "$d/exit-codes.json")"
  [ "$(field "$d/exit-codes.json" status)" = "pass" ] || bad "$t" "status = $(field "$d/exit-codes.json" status)"
  [ "$(field "$d/exit-codes.json" tier)" = "$t" ] || bad "$t" "exit-codes.json 的 tier 不是 $t"
  [ "$(field "$d/exit-codes.json" config)" = "$cfg" ] || bad "$t" "exit-codes.json 的 config = $(field "$d/exit-codes.json" config)，要求 $cfg"
  [ "$(field "$d/exit-codes.json" expect)" = "$exp" ] || bad "$t" "exit-codes.json 的 expect = $(field "$d/exit-codes.json" expect)，要求 $exp"
  for k in collect assert archive upload cleanup summary verify; do
    v="$(field "$d/exit-codes.json" "$k")"
    [ "$v" = "0" ] || bad "$t" "步骤 $k = $v"
  done
  [ "$(field "$d/exit-codes.json" assertionResultsFile)" = "present" ] || bad "$t" "assertionResultsFile = $(field "$d/exit-codes.json" assertionResultsFile)"

  if [ ! -f "$d/manifest.sha256" ]; then
    bad "$t" "缺 manifest.sha256"
  else
    (cd "$d" && sha256sum --quiet --strict -c manifest.sha256) || bad "$t" "文件在归档后被改动或缺失（manifest 复核不符）"
    listed=$(sed -E 's/^[0-9a-f]{64}  //' "$d/manifest.sha256" | LC_ALL=C sort)
    actual=$(cd "$d" && find . -type f ! -name manifest.sha256 | LC_ALL=C sort)
    [ "$listed" = "$actual" ] || bad "$t" "manifest 没有正好覆盖目录里的文件（有未列入或已删除的文件）"
  fi

  node "$here/lhci-verify.mjs" "$d" "$cfg" "$exp" || bad "$t" "证据核对不通过（见上面逐条）"
  if [ "${LH_EVIDENCE:-0}" = 1 ]; then
    for k in precondition env evidence strayAssets; do
      v="$(field "$d/exit-codes.json" "$k")"
      [ "$v" = "0" ] || bad "$t" "证据留存步骤 $k = $v"
    done
    node "$here/lhci-evidence.mjs" check "$d" "$cfg" "$exp" || bad "$t" "证据对应表核对不通过（见上面逐条）"
  fi
done
if [ "${LH_EVIDENCE:-0}" = 1 ]; then
  shopt -s nullglob
  left=( ./*.trace.json ./*.devtoolslog.json )
  shopt -u nullglob
  [ "${#left[@]}" -eq 0 ] || bad "工作目录" "仓库根目录有 ${#left[*]} 个游离 trace / devtools 文件"
fi
if [ -e .lighthouseci ] || [ -L .lighthouseci ]; then
  bad "工作目录" ".lighthouseci 仍存在：某档的原始数据没归档成功"
fi
if [ "$fail" -ne 0 ]; then
  echo "Lighthouse：至少一档失败或证据不完整 → 任务失败"
  exit 1
fi
echo "✓ Lighthouse：$* 全部通过，证据完整，归档未被改动"
