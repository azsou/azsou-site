#!/usr/bin/env bash
# 固定目标桌面采样（r16，/search/ 与 /apps/ 共用）：参数与原运行 lighthouserc.desktop.cjs 的 collect.settings 相同，只测 DIAG_TARGET_URL 这一页。
# DIAG_TARGET_URL 必须是 http://127.0.0.1:4324/<路径>/ 形式（本地静态服务器）；否则不采样（退出 1）。
# 固定计划 3 个样本：每个样本都按计划尝试一次，单独记录退出码与起止时间；
# 失败样本不补跑、不重试；不丢弃第一次（不做预热丢弃）。分母永远是 3。
# 退出码只表示「采集过程」是否完整（计划内样本都尝试过、记录已写出），与 CLS 是否达标无关：
#   0 = 3 个样本都尝试过且 collection.json 已写出（个别样本 lighthouse 失败也算采集完成，样本记无效）
#   1 = 计划参数不对 / 服务器没起来（样本记为未尝试）
#   3 = collection.json 写不出来
set -u
PLANNED=3
OUT="${OUT_DIR:-out}"
SAMPLE_TIMEOUT="${SAMPLE_TIMEOUT:-150}"   # 单个样本上限（秒）；3×150 s 远小于任务 15 min
if [ "${SAMPLES:-3}" != "$PLANNED" ]; then echo "::error::SAMPLES 必须固定为 $PLANNED（现为 ${SAMPLES:-}）"; exit 1; fi
LH="$RUNNER_TEMP/lh/node_modules/.bin/lighthouse"
URL="${DIAG_TARGET_URL:-}"
if [[ ! "$URL" =~ ^http://127\.0\.0\.1:4324/([a-z0-9-]+/)*$ ]]; then echo "::error::DIAG_TARGET_URL 必须是 http://127.0.0.1:4324/<路径>/（现为 '${URL}'）"; exit 1; fi
mkdir -p "$OUT" || exit 3

# 每个样本一行：编号 计划 尝试 退出码 开始 结束（UTC 毫秒）
declare -a ATT RC T0 T1
for i in 1 2 3; do ATT[i]=false; RC[i]=null; T0[i]=null; T1[i]=null; done
server_status=not_started
collection_status=failed

write_record() {
  local tmp="$OUT/collection.json.tmp"
  {
    printf '{\n  "schema": "diag-cls/collection@r16",\n  "planned": %s,\n' "$PLANNED"
    printf '  "url": "%s",\n  "server": "%s",\n  "status": "%s",\n  "samples": [\n' "$URL" "$server_status" "$collection_status"
    for i in 1 2 3; do
      printf '    { "sample": %s, "planned": true, "attempted": %s, "exitCode": %s, "startMs": %s, "endMs": %s }' \
        "$i" "${ATT[$i]}" "${RC[$i]}" "${T0[$i]}" "${T1[$i]}"
      [ "$i" -lt 3 ] && printf ','
      printf '\n'
    done
    printf '  ]\n}\n'
  } > "$tmp" && mv -f "$tmp" "$OUT/collection.json"
}

( cd orig && exec node scripts/serve.mjs 4324 dist/client ) > "$OUT/server.log" 2>&1 &
srv=$!
for _ in $(seq 1 60); do grep -q serving "$OUT/server.log" && break; sleep 0.5; done
if ! grep -q serving "$OUT/server.log"; then
  echo "::error::静态服务器 30 s 内没有启动：3 个样本都未尝试（不测量）"
  server_status=failed
  kill "$srv" 2>/dev/null
  write_record || { echo "::error::collection.json 写入失败"; exit 3; }
  exit 1
fi
server_status=ok

for i in 1 2 3; do
  ATT[i]=true
  T0[i]=$(date +%s%3N)
  timeout --kill-after=10 "$SAMPLE_TIMEOUT" "$LH" "$URL" \
    --preset=desktop \
    --chrome-flags="--no-sandbox --headless=new" \
    --blocked-url-patterns='*supabase.co*' \
    --disable-full-page-screenshot \
    --output=json --output=html --output-path="$OUT/sample-$i" \
    --save-assets --quiet
  RC[i]=$?
  T1[i]=$(date +%s%3N)
  echo "sample $i/$PLANNED rc=${RC[$i]}（124/137 = 超时）"
done
kill "$srv" 2>/dev/null
collection_status=ok
write_record || { echo "::error::collection.json 写入失败"; exit 3; }
echo "采集完成：3/3 已尝试（是否有效由 shifts.mjs 判定）"
exit 0
