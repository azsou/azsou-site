#!/usr/bin/env bash
# 本地起一个一次性的 Postgres（数据放在 .pgdata/，端口 54329），给 npm run test:db 用。
#   bash scripts/pg-local.sh start   → 打印 DATABASE_URL
#   bash scripts/pg-local.sh stop
# 需要本机装有 Postgres 15+（Debian/Ubuntu: apt install postgresql；macOS: brew install postgresql@17）。
set -euo pipefail
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.pgdata"
PORT="${PGPORT:-54329}"
case "${1:-start}" in
  start)
    if [ ! -d "$DIR" ]; then initdb -D "$DIR" -U postgres --auth=trust -E UTF8 >/dev/null; fi
    pg_ctl -D "$DIR" -o "-p $PORT -k /tmp" -l "$DIR/log" status >/dev/null 2>&1 || pg_ctl -D "$DIR" -o "-p $PORT -k /tmp" -l "$DIR/log" -w start >/dev/null
    echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop) pg_ctl -D "$DIR" -m fast stop ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
