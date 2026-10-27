#!/usr/bin/env bash
# =============================================================================
# 本地集成测试用：在本机起一个 **真实的 Supabase storage-api**（github.com/supabase/storage，源码构建，file 后端），
# 连到一个本机隔离 Postgres 库。不是 mock：上传 / 下载 / 建桶走的是 storage-api 本身的代码路径（RLS、storage.objects 写行）。
# 但它也**不是真实验收**：没有 Kong 网关、没有 S3、不是 Supabase 托管项目——结论只能标「本地集成测试」。
#
# 用法：
#   STORAGE_API_DIR=/path/to/storage-api(已 npm ci + node build.js + resolve-tspaths)
#   tests/ops/storage-api-local.sh start <数据库连接串> <端口> <文件目录>   → 打印 PID；等 /status 就绪
#   tests/ops/storage-api-local.sh stop <PID>                                  → 只按 PID 结束
#   tests/ops/storage-api-local.sh jwt <角色>                                  → 用本地 JWT 密钥签一个 HS256 token
# 只接受本机库（127.0.0.1 / localhost）。JWT 密钥是本地测试常量，不是任何真实项目的密钥。
# =============================================================================
set -euo pipefail
LOCAL_JWT_SECRET=${LOCAL_JWT_SECRET:-azsou-local-storage-test-secret-not-real-000000}
jwt() {
  node -e '
    const c = require("node:crypto");
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = b({ alg: "HS256", typ: "JWT" });
    const p = b({ role: process.argv[1], iss: "azsou-local-test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 });
    const s = c.createHmac("sha256", process.argv[2]).update(h + "." + p).digest("base64url");
    console.log(h + "." + p + "." + s);
  ' "$1" "$LOCAL_JWT_SECRET"
}
case "${1:-}" in
  jwt) jwt "${2:?角色}" ;;
  start)
    URL=${2:?数据库连接串} PORT=${3:?端口} DIR=${4:?文件目录}
    : "${STORAGE_API_DIR:?需要 STORAGE_API_DIR（已构建的 supabase/storage 源码目录）}"
    host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$URL")
    case "$host" in 127.0.0.1 | localhost) ;; *) echo "只允许本机库" >&2; exit 2 ;; esac
    [ -f "$STORAGE_API_DIR/dist/start/server.js" ] || { echo "storage-api 未构建：$STORAGE_API_DIR/dist/start/server.js" >&2; exit 2; }
    mkdir -p "$DIR"
    log="$DIR.log"
    # API 角色是整个集群共享的：先按 db/shim/plain.sql 的方式建好（已存在则跳过），storage-api 不再自己建
    # （它的 DB_INSTALL_ROLES=true 在角色已存在时会迁移失败）
    psql "$URL" -Xq -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
do $$
declare r record;
begin
  for r in select * from (values
    ('anon', 'create role anon nologin noinherit'),
    ('authenticated', 'create role authenticated nologin noinherit'),
    ('service_role', 'create role service_role nologin noinherit bypassrls')) as t(name, ddl) loop
    if not exists (select 1 from pg_roles where rolname = r.name) then
      begin execute r.ddl; exception when duplicate_object or unique_violation then null; end;
    end if;
  end loop;
end $$;
SQL
    (
      cd "$STORAGE_API_DIR"
      exec env -i PATH="$PATH" HOME="${HOME:-/tmp}" NODE_ENV=production \
        SERVER_HOST=127.0.0.1 SERVER_PORT="$PORT" SERVER_ADMIN_PORT=$((PORT + 1)) SERVER_REGION=local \
        AUTH_JWT_SECRET="$LOCAL_JWT_SECRET" AUTH_JWT_ALGORITHM=HS256 \
        ANON_KEY="$(jwt anon)" SERVICE_KEY="$(jwt service_role)" \
        TENANT_ID=azsou-local DATABASE_URL="$URL" DATABASE_POOL_URL= DATABASE_CONNECTION_TIMEOUT=5000 \
        DB_INSTALL_ROLES=false DB_ANON_ROLE=anon DB_SERVICE_ROLE=service_role DB_AUTHENTICATED_ROLE=authenticated \
        DB_SUPER_USER=postgres DB_ALLOW_MIGRATION_REFRESH=true DB_MIGRATIONS_FREEZE_AT= \
        STORAGE_BACKEND=file STORAGE_FILE_BACKEND_PATH="$DIR" STORAGE_FILE_ETAG_ALGORITHM=md5 \
        GLOBAL_S3_BUCKET=azsou-local FILE_SIZE_LIMIT=52428800 UPLOAD_FILE_SIZE_LIMIT=52428800 \
        IMAGE_TRANSFORMATION_ENABLED=false LOG_LEVEL=warn \
        node dist/start/server.js
    ) >"$log" 2>&1 &
    pid=$!
    for _ in $(seq 1 60); do
      if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then echo "$pid"; exit 0; fi
      kill -0 "$pid" 2>/dev/null || { echo "storage-api 启动失败：" >&2; tail -20 "$log" >&2; exit 1; }
      sleep 1
    done
    echo "storage-api 60 秒未就绪" >&2; tail -20 "$log" >&2; kill "$pid" 2>/dev/null || true; exit 1 ;;
  stop) kill "${2:?PID}" 2>/dev/null || true ;;
  *) echo "用法：$0 start|stop|jwt" >&2; exit 2 ;;
esac
