#!/usr/bin/env bash
# =============================================================================
# 备份 / 精确恢复 / 显式升级共用的小函数（被 source，不单独执行）。
#   url_host <连接串>          主机名
#   is_local_host <主机>       127.0.0.1 / localhost / ::1 → 0
#   refuse_prod_target <连接串> <用途>   连接串指向生产项目 abryflgoljltyakthtql → 拒绝（恢复 / 升级永远不对生产执行）
#   schema_version_from_status         stdin = db/verify/status.sql 的输出（step|item|ok）→ 打印 schema 版本
#   repo_head_version <仓库根>          db/migrations 里最大的编号
# schema 版本 = 「0002…N 的 status 检查全部为 true、N 之后全部为 false」的 N；一个都没有 = 0001（基线）；
# 不连续（中间有 false、后面又有 true）= mixed:<为 true 的编号>，升级脚本拒绝处理。
# =============================================================================
AZ_PROD_REF=abryflgoljltyakthtql
url_host() { python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$1" 2>/dev/null || true; }
is_local_host() { case "$1" in 127.0.0.1 | localhost | ::1) return 0 ;; *) return 1 ;; esac; }
url_mentions_prod() { case "$1" in *"$AZ_PROD_REF"*) return 0 ;; *) return 1 ;; esac; }
refuse_prod_target() {
  if url_mentions_prod "$1"; then
    echo "::error title=拒绝::目标连接串指向生产项目 $AZ_PROD_REF——$2 永远不对生产库执行（恢复只进新的空项目）" >&2
    exit 2
  fi
}
schema_version_from_status() {
  awk -F'|' '
    NF >= 3 { s = $1; seen[s] = 1; if ($3 != "t") bad[s] = 1 }
    END {
      n = 0; for (s in seen) steps[++n] = s
      # 简单排序（编号都是 4 位数字）
      for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (steps[j] < steps[i]) { t = steps[i]; steps[i] = steps[j]; steps[j] = t }
      ver = "0001"; gap = 0; mixed = ""; okl = ""
      for (i = 1; i <= n; i++) {
        s = steps[i]; ok = !(s in bad)
        if (ok) okl = okl (okl ? "," : "") s
        if (ok && !gap) ver = s
        else if (!ok) gap = 1
        else mixed = 1
      }
      if (n == 0) { print "unknown"; exit }
      print (mixed ? "mixed:" okl : ver)
    }'
}
repo_head_version() { ls "$1"/db/migrations/ | sed -nE 's/^([0-9]{4})_.*\.sql$/\1/p' | sort | tail -1; }
