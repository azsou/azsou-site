#!/usr/bin/env bash
# =============================================================================
# 上传备份前的最后一道闸：目录里每个文件都必须是 gpg 对称加密产物，否则非 0 退出（工作流标红、不上传）。
#   bash scripts/ops/assert-encrypted.sh <目录>
# 判定：非空目录；没有子目录；每个文件名以 .gpg 结尾，且第一个 OpenPGP 包是「对称密钥加密会话密钥包」（tag 3），
# 也就是 `gpg --symmetric` 的输出——改名成 .gpg 的明文、gpg 公钥加密 / 签名文件、空文件都不算。
# 只读文件头，不需要口令，不解密。
# =============================================================================
set -euo pipefail
DIR=${1:?用法：assert-encrypted.sh <目录>}
fail() { echo "::error title=备份未加密::$*" >&2; exit 1; }
[ -d "$DIR" ] || fail "目录不存在：$DIR"
shopt -s nullglob dotglob
files=("$DIR"/*)
[ ${#files[@]} -gt 0 ] || fail "目录为空：$DIR"
n=0
for f in "${files[@]}"; do
  b=$(basename "$f")
  [ -f "$f" ] || fail "不允许子目录或特殊文件：$b"
  case "$b" in *.gpg) ;; *) fail "明文文件：$b（只允许上传 .gpg）" ;; esac
  python3 - "$f" <<'PY' || fail "不是 gpg 对称加密产物：$b"
import sys
with open(sys.argv[1], 'rb') as fh:
    head = fh.read(1)
if not head:
    sys.exit(1)
b = head[0]
if not b & 0x80:
    sys.exit(1)                       # 不是 OpenPGP 二进制包（明文 / ASCII）
tag = (b & 0x3F) if b & 0x40 else ((b >> 2) & 0x0F)
sys.exit(0 if tag == 3 else 1)        # 3 = Symmetric-Key Encrypted Session Key
PY
  n=$((n + 1))
done
echo "全部加密：$n 个 .gpg 文件"
