#!/usr/bin/env bash
# CI：安装 Playwright 浏览器 + 系统依赖（只负责「基础设施」，与测试分开计时、分开报告，见 docs/CI.md）。
#
# 用法：scripts/ci/pw-install.sh <chromium|firefox|webkit> [额外 apt 包…]
#
# 两段，各自有界重试：
#  1. 浏览器二进制：~/.cache/ms-playwright 由 workflow 按 Playwright 版本缓存；命中时这一步几秒完成。
#     每次最多 5 分钟、最多 3 次。
#  2. 系统依赖（apt）：每次最多 8 分钟、最多 3 次；第 2、3 次换 apt 镜像（默认 azure 镜像偶发极慢，
#     PR #5 run 40522111734 两次各卡 10–20 分钟）。
#     timeout 只杀掉 npx，sudo apt-get 子进程仍持有 dpkg 锁，下一次必然 "Could not get lock"——
#     所以每次重试前先结束残留的 apt / dpkg 并修复半装状态。
# 任何一段用尽重试：打出 ::error title=安装超时（基础设施）:: 注解并以 75 退出（与测试失败区分）。
set -u
browser=${1:?用法：pw-install.sh <browser> [apt 包…]}
shift
extra_apt=("$@")

annotate_fail() {
  echo "::error title=安装超时（基础设施）::$1（不是测试失败；按 docs/CI.md 重跑一次该任务）"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### 安装超时（基础设施）"
      echo ""
      echo "- 任务：${GITHUB_JOB:-?} / 浏览器：${browser}"
      echo "- 原因：$1"
      echo "- 这不是测试失败：测试步骤没有运行。处理：重跑一次该任务（docs/CI.md「安装超时」）。"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 75
}

clean_apt() {
  sudo pkill -x apt-get || true
  sudo pkill -x dpkg || true
  sleep 3
  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock /var/lib/apt/lists/lock
  sudo dpkg --configure -a || true
}

# 把 Ubuntu 软件源换成另一个镜像（同时处理 deb822 的 ubuntu.sources 与旧式 sources.list）
switch_mirror() {
  local to=$1
  echo "切换 apt 镜像 → ${to}"
  for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    [ -f "$f" ] || continue
    sudo sed -i -E \
      -e "s#https?://[a-z0-9.-]*archive\.ubuntu\.com/ubuntu/?#${to}#g" \
      -e "s#https?://mirrors\.edge\.kernel\.org/ubuntu/?#${to}#g" \
      -e "s#file:/etc/apt/apt-mirrors\.txt#${to}#g" \
      "$f"
  done
}

# ---- 1. 浏览器二进制 ----
ok=0
for i in 1 2 3; do
  if timeout 300 npx playwright install "$browser"; then ok=1; break; fi
  echo "浏览器下载第 $i 次失败 / 超时"
  sleep 5
done
[ "$ok" = 1 ] || annotate_fail "Playwright ${browser} 浏览器下载 3 次失败 / 超时（每次 5 分钟）"

# ---- 2. 系统依赖（apt）----
# 单个连接 30 秒无响应就重试 / 换下一个地址，而不是挂到超时
echo 'Acquire::Retries "3"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/80-ci-retries >/dev/null
mirrors=("" "http://archive.ubuntu.com/ubuntu/" "http://mirrors.edge.kernel.org/ubuntu/")
ok=0
for i in 1 2 3; do
  m=${mirrors[$((i - 1))]}
  [ -n "$m" ] && switch_mirror "$m"
  if timeout 480 bash -c '
      set -e
      npx playwright install-deps "$0"
      if [ "$#" -gt 0 ]; then sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; fi
    ' "$browser" "${extra_apt[@]}"; then
    ok=1
    break
  fi
  echo "系统依赖安装第 $i 次失败 / 超时（镜像：${m:-默认}），清理 apt 锁后重试"
  clean_apt
done
[ "$ok" = 1 ] || annotate_fail "Playwright ${browser} 系统依赖（apt）3 次失败 / 超时（每次 8 分钟，已换 2 个镜像）"
echo "浏览器与系统依赖就绪：${browser}"
