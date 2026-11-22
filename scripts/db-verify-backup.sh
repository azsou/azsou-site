#!/usr/bin/env bash
# =============================================================================
# Q06 / T057 / T086：校验一份备份「真的能用」，而不是「工作流跑完了」。
#   bash scripts/db-verify-backup.sh <备份目录> [--restore <隔离库连接串>]
#   BACKUP_PASSPHRASE=…  产物是 .gpg 时用来解密（不会写进日志）
# 检查：① 有 SHA256SUMS 且每个文件校验和一致 ② .gpg 能解密 ③ .dump 能被 pg_restore --list 读出目录
#       ④ 行数清单、globals 清单存在且非空，public 与 auth 两个范围必须都在
#       ④b manifest（格式 2）存在：统一快照 id / LSN / 时间、schema 版本；Storage 文件已包含时，
#          归档里每个对象的 sha256 / 大小与逐对象清单一致、数量与快照对象清单一致
#       ⑤（可选 --restore）用 db-restore.sh 精确恢复全部范围（public / auth / private / storage 行）到**空的**隔离库
#          （按备份自己的 schema 版本，不升级；Storage 文件本体不经 API 上传——那是 tests/ops/storage-roundtrip.sh / 正式恢复的事），
#          逐表核对行数（含 auth.users / auth.identities / storage.*），按范围汇总；globals 里的扩展 / 角色在目标库都存在
# 任何一步失败 → 非 0 退出（工作流标红），绝不打印「备份成功」。
# =============================================================================
set -euo pipefail
DIR=${1:?用法：db-verify-backup.sh <备份目录> [--restore <隔离库连接串>]}
RESTORE_URL=""
[ "${2:-}" = "--restore" ] && RESTORE_URL=${3:?--restore 需要连接串}
fail() { echo "::error title=备份校验失败::$*" >&2; exit 1; }
[ -d "$DIR" ] || fail "目录不存在：$DIR"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
shopt -s nullglob
enc=("$DIR"/*.gpg)
if [ ${#enc[@]} -gt 0 ]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || fail "产物已加密但没有提供 BACKUP_PASSPHRASE"
  for f in "${enc[@]}"; do
    out="$work/$(basename "${f%.gpg}")"
    gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt --output "$out" "$f" 3<<<"$BACKUP_PASSPHRASE" \
      || fail "解密失败：$(basename "$f")"
  done
else
  cp "$DIR"/* "$work"/ 2>/dev/null || fail "目录为空：$DIR"
fi
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$work"
sums=(*-SHA256SUMS-*.txt)
[ ${#sums[@]} -eq 1 ] || fail "找不到唯一的 SHA256SUMS 清单"
sha256sum --quiet -c "${sums[0]}" || fail "校验和不一致（文件损坏或被改动）"
# 清单必须覆盖目录里的每个产物（多出未登记的文件 = 来源不明）
for f in *; do
  case "$f" in "${sums[0]}" | restore.err) continue ;; esac
  awk '{sub(/^\*/, "", $2); print $2}' "${sums[0]}" | grep -qxF -- "$f" || fail "SHA256SUMS 未登记：$f"
done
dumps=(*-public-*.dump)
[ ${#dumps[@]} -eq 1 ] || fail "找不到 public 备份文件"
for d in *.dump; do
  pg_restore --list "$d" >/dev/null 2>&1 || fail "pg_restore 读不出目录：$d"
done
counts=(*-rowcounts-*.tsv)
[ ${#counts[@]} -eq 1 ] && [ -s "${counts[0]}" ] || fail "行数清单缺失或为空"
globals=(*-globals-*.tsv)
[ ${#globals[@]} -eq 1 ] && [ -s "${globals[0]}" ] || fail "globals 清单（扩展 / 角色 / 策略数）缺失或为空"
authd=(*-auth-*.dump)
[ ${#authd[@]} -eq 1 ] || fail "找不到 auth 范围备份（auth.users / auth.identities）"
mans=(*-manifest-*.json)
[ ${#mans[@]} -eq 1 ] || fail "没有 manifest（统一快照 / schema 版本）——第三轮之前的旧格式备份，请重新备份"
VER=$(python3 - "${mans[0]}" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1]))
assert m.get('format') == 2, 'manifest 格式不是 2'
s = m['snapshot']
assert re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', s['id']), '快照 id 不合法'
assert re.fullmatch(r'[0-9A-F]+/[0-9A-F]+', s['lsn']), 'LSN 不合法'
assert s['time'] and m['storage_listing_time'] == s['time'], 'Storage 清单时间必须等于快照时间'
print(m['schema_version'])
PY
) || fail "manifest 不完整（快照 id / LSN / 时间 / schema 版本）"
FST=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["storage_files"]["status"])' "${mans[0]}")
if [ "$FST" = included ]; then
  tars=(*-storage-files-*.tar)
  lists=(*-storage-files-*.tsv)
  snaplist=(*-storage-listing-*.tsv)
  [ ${#tars[@]} -eq 1 ] && [ ${#lists[@]} -eq 1 ] && [ ${#snaplist[@]} -eq 1 ] || fail "manifest 说包含 Storage 文件，但缺归档 / 逐对象清单 / 快照对象清单"
  mkdir -p "$work/.files"
  tar -xf "${tars[0]}" -C "$work/.files" || fail "Storage 文件归档损坏"
  [ "$(($(wc -l <"${lists[0]}") - 1))" = "$(($(wc -l <"${snaplist[0]}") - 1))" ] || fail "Storage 文件数与快照对象清单不一致"
  awk -F'\t' 'NR > 1 {print $4 "  " $1 "/" $2}' "${lists[0]}" | (cd "$work/.files" && sha256sum --quiet -c -) || fail "Storage 文件 sha256 与逐对象清单不一致"
  n=$(find "$work/.files" -type f | wc -l)
  [ "$n" = "$(($(wc -l <"${lists[0]}") - 1))" ] || fail "Storage 归档里有清单之外的文件"
  rm -rf "$work/.files"
  echo "Storage 文件：$n 个对象，sha256 与清单一致"
fi
listing=$(pg_restore --list "${dumps[0]}") || fail "pg_restore 读不出目录：${dumps[0]}"
tables=$(grep -c ' TABLE DATA public ' <<<"$listing" || true) # grep 无匹配返回 1，只对它放行
[ "$tables" -gt 0 ] || fail "备份里没有任何 public 表数据：${dumps[0]}"
size=$(du -b "${dumps[0]}" | cut -f1)
echo "校验通过：$(basename "${dumps[0]}")（${size} 字节，表数据 $tables 张），清单 $(wc -l <"${counts[0]}") 行"
if [ -n "$RESTORE_URL" ]; then
  host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$RESTORE_URL")
  case "$host" in 127.0.0.1 | localhost | ::1) ;; *) fail "--restore 只允许本机隔离库" ;; esac
  # 用正式的精确恢复脚本（单事务、事务内核对；按备份自己的 schema 版本，不执行迁移）
  errf=$(mktemp)
  bash "$HERE/db-restore.sh" "$RESTORE_URL" "$work" --accept-backup-version "$VER" --storage-metadata-only >/dev/null 2>"$errf" \
    || { tail -5 "$errf" >&2; rm -f "$errf"; fail "恢复到隔离库失败"; }
  rm -f "$errf"
  bad=0
  declare -A scope_t=() scope_r=()
  while IFS=$'\t' read -r t n; do
    got=$(psql "$RESTORE_URL" -XAt -v ON_ERROR_STOP=1 -c "select count(*) from $t") || fail "恢复库里数不出 $t 的行数"
    [ "$got" = "$n" ] || { echo "行数不一致：$t 备份 $n / 恢复 $got" >&2; bad=1; }
    sc=${t%%.*}
    scope_t[$sc]=$((${scope_t[$sc]:-0} + 1))
    scope_r[$sc]=$((${scope_r[$sc]:-0} + n))
  done <"${counts[0]}"
  [ $bad = 0 ] || fail "恢复后行数与清单不一致"
  for sc in public private auth storage; do
    if [ -n "${scope_t[$sc]:-}" ]; then echo "  范围 $sc：${scope_t[$sc]} 张表 / ${scope_r[$sc]} 行，与清单一致"; fi
  done
  while IFS=$'\t' read -r kind name _; do
    case "$kind" in
      extension) [ "$(psql "$RESTORE_URL" -XAt -v ON_ERROR_STOP=1 -c "select count(*) from pg_extension where extname = '$name'")" = 1 ] \
        || echo "  提示：目标库没有扩展 $name（Supabase 新项目按需在 Dashboard 启用）" ;;
      role) [ "$(psql "$RESTORE_URL" -XAt -v ON_ERROR_STOP=1 -c "select count(*) from pg_roles where rolname = '$name'")" = 1 ] \
        || fail "目标库缺少自定义角色 $name（globals 清单里有；先按 docs/BACKUP.md §2B 建角色再恢复）" ;;
    esac
  done <"${globals[0]}"
  echo "恢复演练通过：行数与清单一致"
fi
