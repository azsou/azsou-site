#!/usr/bin/env bash
# CI：安装 Playwright 浏览器 + 系统依赖。apt 偶发卡住：每次最多 10 分钟，最多 3 次；
# 超时后 timeout 只杀掉 npx，sudo apt-get 子进程仍持有 dpkg 锁，下一次必然 "Could not get lock"——
# 所以重试前先结束残留的 apt / dpkg 并修复半装状态。
set -u
for i in 1 2 3; do
  timeout 600 npx playwright install --with-deps "$@" && exit 0
  echo "playwright install 第 $i 次失败 / 超时，清理 apt 锁后重试"
  sudo pkill -x apt-get || true
  sudo pkill -x dpkg || true
  sleep 3
  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock
  sudo dpkg --configure -a || true
done
exit 1
