#!/usr/bin/env bash
# 记录诊断环境（只读）。不打印任何令牌或环境变量全集。
set -u
echo "date_utc=$(date -u +%FT%TZ)"
echo "runner_os=${RUNNER_OS:-?} runner_arch=${RUNNER_ARCH:-?} image_os=${ImageOS:-?} image_version=${ImageVersion:-?}"
echo "uname=$(uname -srm)"
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
echo "nproc=$(nproc) cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)"
echo "mem=$(free -m | awk '/Mem:/{print $2" MiB"}')"
echo "node=$(node -v)"
echo "lighthouse=$("$RUNNER_TEMP/lh/node_modules/.bin/lighthouse" --version)"
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$c" >/dev/null && echo "chrome[$c]=$("$c" --version 2>/dev/null) path=$(command -v "$c")"
done
echo "CHROME_PATH=${CHROME_PATH:-}"
echo "fc-list 条目=$(fc-list | wc -l) 字体族=$(fc-list : family | sort -u | wc -l) sha256(sorted)=$(fc-list | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
echo "fc-list :lang=zh 条目=$(fc-list :lang=zh | wc -l)"
fc-list : family | LC_ALL=C sort -u > out/fc-families.txt
fc-match sans-serif; fc-match serif; fc-match monospace; fc-match 'sans-serif:lang=zh-cn'
