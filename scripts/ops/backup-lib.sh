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

# =============================================================================
# 失败清理的所有权（站长 2026-10-28 第五轮）：清理只能删除**本次运行自己新建**的库。
#   预先存在的库（哪怕名字相同、哪怕是空的）一律不碰；删除前同时核对 OID 与创建标记，名字被别人占用 / 被重建过都不删。
#   az_run_id                          本次运行 id（AZ_RUN_ID 未设置时生成；写进库注释作创建标记）
#   az_create_owned_db <管理连接串> <库名> [模板库]   库已存在 → 返回 3、不创建不删除；否则 create database + 注释标记 + 记 OID 到所有权清单
#   az_adopt_owned_db <管理连接串> <库名>    子进程（同一 AZ_RUN_ID）新建的库：核对创建标记后登记到本进程的清单
#   az_drop_owned_db <管理连接串> <库名>     只有清单里有、且当前 OID 与注释标记都对得上才删；否则拒绝并说明（返回 4）
#   az_drop_all_owned <管理连接串>         逆序删除清单里的全部库（每个都走 az_drop_owned_db 的核对）
#   az_is_owned_db <库名>                  在本次运行的所有权清单里 → 0
# 清单在 $AZ_OWNED_LEDGER（默认临时文件；只记库名与 OID，不含连接串 / 口令）。
# =============================================================================
az_run_id() {
  if [ -z "${AZ_RUN_ID:-}" ]; then
    AZ_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
    export AZ_RUN_ID
  fi
  printf '%s\n' "$AZ_RUN_ID"
}
az_ledger() {
  if [ -z "${AZ_OWNED_LEDGER:-}" ]; then
    AZ_OWNED_LEDGER=$(mktemp "${TMPDIR:-/tmp}/azsou-owned.XXXXXX")
    export AZ_OWNED_LEDGER
  fi
  printf '%s\n' "$AZ_OWNED_LEDGER"
}
az_valid_dbname() { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
az_create_owned_db() {
  local admin=$1 name=$2 tpl=${3:-} rid oid ex
  az_valid_dbname "$name" || { echo "✗ 库名不合法：$name" >&2; return 2; }
  [ -z "$tpl" ] || az_valid_dbname "$tpl" || { echo "✗ 模板库名不合法：$tpl" >&2; return 2; }
  az_run_id >/dev/null # 在当前 shell 里生成并导出（不能放进 $(…) 子 shell，否则标记与后面的核对用的不是同一个 id）
  rid=$AZ_RUN_ID
  az_ledger >/dev/null
  ex=$(psql "$admin" -XAt -v ON_ERROR_STOP=1 -c "select count(*) from pg_database where datname = '$name'") || return 2
  if [ "$ex" != 0 ]; then
    echo "✗ 库 $name 已存在：不是本次运行创建的，不会使用、也不会删除它（换一个库名，或先人工确认后自行处理）" >&2
    return 3
  fi
  # create database 本身是原子的：同名库已存在（含与上面检查之间的竞态）时失败，不会接管别人的库
  psql "$admin" -Xq -v ON_ERROR_STOP=1 -c "create database \"$name\"${tpl:+ template \"$tpl\"}" >/dev/null || return 3
  oid=$(psql "$admin" -XAt -v ON_ERROR_STOP=1 -c "select oid from pg_database where datname = '$name'") || return 2
  printf '%s\t%s\n' "$name" "$oid" >>"$AZ_OWNED_LEDGER"
  psql "$admin" -Xq -v ON_ERROR_STOP=1 -c "comment on database \"$name\" is 'azsou-run:$rid'" >/dev/null || return 2
}
az_adopt_owned_db() {
  local admin=$1 name=$2 oid mark
  az_valid_dbname "$name" || return 2
  az_run_id >/dev/null
  az_ledger >/dev/null
  IFS=$'\t' read -r oid mark < <(psql "$admin" -XAt -F $'\t' -v ON_ERROR_STOP=1 \
    -c "select oid, coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '$name'") || true
  if [ -z "${oid:-}" ] || [ "$mark" != "azsou-run:$AZ_RUN_ID" ]; then
    echo "✗ 不登记 $name：不存在或创建标记不是本次运行（「${mark:-}」）" >&2
    return 4
  fi
  printf '%s\t%s\n' "$name" "$oid" >>"$AZ_OWNED_LEDGER"
}
az_is_owned_db() { [ -n "${AZ_OWNED_LEDGER:-}" ] && [ -f "$AZ_OWNED_LEDGER" ] && cut -f1 "$AZ_OWNED_LEDGER" | grep -qxF "$1"; }
az_drop_owned_db() {
  local admin=$1 name=$2 want cur mark
  az_valid_dbname "$name" || { echo "✗ 库名不合法：$name" >&2; return 2; }
  want=$( [ -n "${AZ_OWNED_LEDGER:-}" ] && [ -f "$AZ_OWNED_LEDGER" ] && awk -F'\t' -v n="$name" '$1 == n {print $2}' "$AZ_OWNED_LEDGER" | tail -1)
  if [ -z "$want" ]; then
    echo "拒绝删除 $name：不是本次运行创建的库（不在所有权清单里）" >&2
    return 4
  fi
  IFS=$'\t' read -r cur mark < <(psql "$admin" -XAt -F $'\t' -v ON_ERROR_STOP=1 \
    -c "select oid, coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '$name'") || true
  if [ -z "${cur:-}" ]; then
    echo "  $name 已不存在（无需清理）" >&2
    return 0
  fi
  az_run_id >/dev/null
  if [ "$cur" != "$want" ] || [ "$mark" != "azsou-run:$AZ_RUN_ID" ]; then
    echo "拒绝删除 $name：OID / 创建标记与本次运行记录不符（OID $cur ≠ $want 或标记「$mark」）——它可能已被别人重建，保持原样" >&2
    return 4
  fi
  psql "$admin" -Xq -v ON_ERROR_STOP=1 -c "drop database \"$name\" with (force)" >/dev/null
}
az_drop_all_owned() {
  local admin=$1 rc=0 n
  [ -n "${AZ_OWNED_LEDGER:-}" ] && [ -f "$AZ_OWNED_LEDGER" ] || return 0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    az_drop_owned_db "$admin" "$n" || rc=$?
  done < <(cut -f1 "$AZ_OWNED_LEDGER" | tac | awk '!seen[$0]++')
  return $rc
}
