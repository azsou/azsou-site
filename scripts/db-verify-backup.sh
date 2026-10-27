#!/usr/bin/env bash
# =============================================================================
# Q06 / T057 / T086：校验一份备份「真的能用」，而不是「工作流跑完了」。
#   bash scripts/db-verify-backup.sh <备份目录> [--restore <隔离库连接串>]
#   BACKUP_PASSPHRASE=…  产物是 .gpg 时用来解密（不会写进日志）
# 检查：① 有 SHA256SUMS 且每个文件校验和一致 ② .gpg 能解密 ③ .dump 能被 pg_restore --list 读出目录
#       ④ 行数清单存在且非空 ⑤（可选 --restore）恢复到隔离库后行数与清单一致
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
listing=$(pg_restore --list "${dumps[0]}") || fail "pg_restore 读不出目录：${dumps[0]}"
tables=$(grep -c ' TABLE DATA public ' <<<"$listing" || true) # grep 无匹配返回 1，只对它放行
[ "$tables" -gt 0 ] || fail "备份里没有任何 public 表数据：${dumps[0]}"
size=$(du -b "${dumps[0]}" | cut -f1)
echo "校验通过：$(basename "${dumps[0]}")（${size} 字节，表数据 $tables 张），清单 $(wc -l <"${counts[0]}") 行"
if [ -n "$RESTORE_URL" ]; then
  host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$RESTORE_URL")
  case "$host" in 127.0.0.1 | localhost | ::1) ;; *) fail "--restore 只允许本机隔离库" ;; esac
  # 用正式恢复脚本（与灾难恢复同一路径：pre-restore → 账户 → public → post-restore → ACL → 重跑迁移）
  authd=(*-auth-users-*.dump)
  bash "$HERE/db-restore.sh" "$RESTORE_URL" "$work/${dumps[0]}" ${authd:+"$work/${authd[0]}"} >/dev/null 2>"$work/restore.err" \
    || { tail -5 "$work/restore.err" >&2; fail "恢复到隔离库失败"; }
  bad=0
  while IFS=$'\t' read -r t n; do
    [ "$t" = auth.users ] && continue
    got=$(psql "$RESTORE_URL" -XAt -v ON_ERROR_STOP=1 -c "select count(*) from $t") || fail "恢复库里数不出 $t 的行数"
    [ "$got" = "$n" ] || { echo "行数不一致：$t 备份 $n / 恢复 $got" >&2; bad=1; }
  done <"${counts[0]}"
  [ $bad = 0 ] || fail "恢复后行数与清单不一致"
  echo "恢复演练通过：行数与清单一致"
fi
