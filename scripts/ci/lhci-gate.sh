#!/usr/bin/env bash
# Lighthouse 总结论（lighthouse 任务最后一步，if: always()）：
#   - 每个要求的档（默认 mobile desktop）都必须有 exit-codes.json 且 status = pass，缺档 = 失败；
#   - 每档 manifest.sha256 复核（sha256sum -c）：证明后跑的档没有改动先跑的档；
#   任一不满足 → 退出码 1（任务失败）。只读，不改任何文件。
#   bash scripts/ci/lhci-gate.sh [输出根目录，默认 lhci-out] [档名...]
set -uo pipefail
root="${1:-lhci-out}"
shift || true
tiers=("$@")
[ ${#tiers[@]} -eq 0 ] && tiers=(mobile desktop)

fail=0
for t in "${tiers[@]}"; do
  d="$root/$t"
  if [ ! -f "$d/exit-codes.json" ]; then
    echo "::error title=Lighthouse 结论::$t 档没有结果（步骤没跑或中途被打断）→ 失败"
    fail=1
    continue
  fi
  st=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status))' "$d/exit-codes.json")
  echo "$t：$(cat "$d/exit-codes.json")"
  if [ "$st" != "pass" ]; then
    echo "::error title=Lighthouse 结论::$t 档未通过（$st）"
    fail=1
  fi
  if [ ! -f "$d/summary.json" ]; then
    echo "::error title=Lighthouse 结论::$t 档缺 summary.json"
    fail=1
  fi
  if [ -f "$d/manifest.sha256" ]; then
    if ! (cd "$d" && sha256sum --quiet -c manifest.sha256); then
      echo "::error title=Lighthouse 结论::$t 档文件在归档后被改动（manifest 不符）"
      fail=1
    fi
  else
    echo "::error title=Lighthouse 结论::$t 档缺 manifest.sha256"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "Lighthouse：至少一档失败或证据不完整 → 任务失败"
  exit 1
fi
echo "✓ Lighthouse：${tiers[*]} 全部通过，归档未被改动"
