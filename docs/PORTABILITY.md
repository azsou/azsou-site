# 可移植性：离开 Supabase

本站对 Supabase 的依赖被刻意压到最小，换库 / 换认证 / 换存储都不需要改页面代码：

| 层       | 现在                             | 只依赖                                                                               | 换掉时改哪里                                                  |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 数据库   | Supabase Postgres 17             | 标准 Postgres ≥ 15 + `pgcrypto`、`pg_trgm`（都是官方 contrib 扩展）                  | 连接串；`db/shim/plain.sql` 模拟 Supabase 角色与 `auth.uid()` |
| 数据 API | PostgREST（Supabase `/rest/v1`） | 「事务内 `set local role` + `request.jwt.claims`」的 REST 层                         | `PUBLIC_SUPABASE_URL`；或在 `src/lib/data/` 写新适配器        |
| 认证     | Supabase Auth（GoTrue）          | `src/lib/data/types.ts` 的 `AuthProvider` 接口；数据库里 `auth.users` + JWT 的 `sub` | 新的 `AuthProvider` 实现 + 签发同格式 JWT                     |
| 图片     | Supabase Storage `ugc-images`    | `MediaRepo.uploadImage()` + 公开 URL；RLS 规则写在 0010                              | `MediaRepo` 实现、`PUBLIC_IMAGE_HOSTS`、CSP `img-src`         |
| 权限     | RLS + `SECURITY DEFINER` 函数    | 纯 Postgres                                                                          | 不用改                                                        |

## 1. 迁到 Neon / Amazon RDS / 自建 Postgres

```bash
export NEW='postgresql://<user>:<pass>@<host>:5432/<db>?sslmode=require'

# 1) 模拟 Supabase 环境：anon / authenticated / service_role 角色、auth.users、auth.uid()、extensions、Storage 替身
psql "$NEW" -v ON_ERROR_STOP=1 -f db/shim/plain.sql
# 2) 结构：0001 基线 + 全部增量迁移（按文件名顺序）
for f in db/migrations/*.sql; do psql "$NEW" -v ON_ERROR_STOP=1 -f "$f"; done
# 3) 数据：从 scripts/db-backup.sh 的备份导入（换库方式：迁移建结构 + 只导数据）
# 迁移会写入少量种子行（论坛种子主题等），备份里也有：先清空 public 的表再导入
psql "$NEW" -c "do \$\$ declare t text; begin for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop execute 'truncate ' || t || ' cascade'; end loop; end \$\$;"
pg_restore --data-only --disable-triggers --no-owner -d "$NEW" azsou-auth-users-<时间>.dump
pg_restore --data-only --disable-triggers --no-owner -d "$NEW" azsou-public-<时间>.dump
# 4) 核对
psql "$NEW" -f db/verify/status.sql          # 全部 true（没有 Storage 时 0010 的桶检查视为通过）
```

- `--disable-triggers` 需要超级用户（RDS 用 `rds_superuser` 不够时，去掉该参数并先导 `auth.users` 再导 public；通知 / 审计触发器只对 API 角色生效，导入不会重复写）。
- Neon：创建项目时选 Postgres 17；`pg_trgm`、`pgcrypto` 可直接 `create extension`。连接 PostgREST 用直连（非 pooler）地址或开启 pooler 的 session 模式。
- 也可以用「整库恢复」：`bash scripts/db-restore.sh "$NEW" azsou-public-*.dump azsou-auth-*.dump --private azsou-private-*.dump --storage azsou-storage-*.dump`（先 gpg -d 解密）（先跑 shim），
  它会处理默认权限、扩展、auth 触发器，并重跑 0002+ 补齐 public 以外的对象。CI 的恢复演练同时覆盖两种方式。
- 完整流程与核对方法在 `scripts/restore-drill.sh`，在本地对任何 Postgres 都可以跑：`DATABASE_URL=… npm run db:drill`。

## 2. 数据 API：自建 PostgREST

```ini
# postgrest.conf
db-uri = "postgresql://authenticator:<pass>@<host>:5432/<db>"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "<与认证服务相同的 HS256 密钥，或 JWKS>"
db-pre-request = ""
```

```sql
create role authenticator login noinherit password '<pass>';
grant anon, authenticated to authenticator;
```

前面挂一个反向代理把 `/rest/v1/*` 转到 PostgREST（保持和 Supabase 相同的路径），再把 `PUBLIC_SUPABASE_URL` 指向代理域名。
`apikey` 头会被 PostgREST 忽略；匿名请求必须带 anon 角色的 JWT（`{"role":"anon"}`），或者在代理层把 publishable key 换成 anon JWT
（E2E 测试里的 `tests/e2e/community-fixtures.ts` 就是这么做的）。
CI 的 `tests/db/postgrest*.test.ts` 用 PostgREST 14 + 纯 Postgres 跑了全部读写与 V72 兼容请求，可作为参考配置（`tests/db/postgrest.ts`）。

## 3. 认证

### 方案 A：自建 Supabase Auth（GoTrue）——改动最小

GoTrue 是开源的（`supabase/auth`），可以单独部署在同一个 Postgres 上：`auth` schema 与现在完全一致，
`auth.users` 可直接从备份恢复（密码哈希为 bcrypt，用户无需重置密码），前端的 `src/lib/data/supabase-auth.ts` 不用改，
只把 `PUBLIC_SUPABASE_URL` 指向代理（`/auth/v1/*` → GoTrue）。邮件模板、OAuth、钩子按 CONFIG.md 在 GoTrue 的环境变量里配置。

### 方案 B：其他认证服务（Auth.js、Logto、Clerk、Keycloak…）

1. 实现 `AuthProvider`（`src/lib/data/types.ts`）：`getSession / signIn / signUp / signOut / accessToken / oauthUrl / …`，
   参照 `supabase-auth.ts`；`getRepository()` 里换成新实现。
2. 新服务登录后签发数据库能识别的 JWT：`sub` = 用户 uuid，`role` = `authenticated`，用 PostgREST 配置的密钥签名。
3. 用户建档：新用户首次登录时往 `auth.users` 插一行（`id`、`email`、`raw_user_meta_data.name`），`on_auth_user_created` 触发器会自动建 `profiles`。
   旧用户的 `id` 必须保持不变（帖子、角色都按 uuid 关联）；密码哈希是 bcrypt，多数服务支持导入。
4. 注册防机器人：0007 的钩子是 GoTrue 专用，换服务后把同样的「Turnstile 校验 → 签发票据」逻辑放进新服务的注册前回调，
   或直接在 `/api/auth/signup` 里完成校验后再调用新服务。

## 4. 图片存储

替代方案：Cloudflare R2、Amazon S3、阿里云 OSS、MinIO（都兼容 S3）。

1. 建公开读的桶，配置 CORS 允许 `https://azsou.com` 的 `PUT`。
2. 新增 Vercel Function `/api/media/sign`：校验用户 JWT（`can_write()` 等价逻辑：查 `profiles.banned`）、限流（可复用
   `az_rate_limit`）、文件名规则（与 0010 一致：`<uid>/<[a-z0-9-]>.(webp|png|jpg|jpeg|gif)`）、大小 ≤ 2 MB，然后返回预签名 PUT URL。
3. 在 `src/lib/data/` 新写 `MediaRepo` 实现：先请求签名，再 `PUT` 文件；返回公开 URL。
4. `src/lib/images.ts` 的 `parseImageUrl()` 目前只认 Supabase 的路径格式；新存储的路径格式需在这里加一条规则，
   并设置 `PUBLIC_IMAGE_HOSTS=<新域名>`、在 `vercel.json` 的 CSP `img-src` 加上新域名（`npm run test:csp` 会检查）。
5. 迁移旧图：`rclone sync supabase:ugc-images r2:ugc-images`（Supabase Storage 提供 S3 兼容接口：Project Settings → Storage → S3 Connection），
   再用 SQL 批量替换帖子正文里的旧域名：

   ```sql
   update public.forum_threads set body = replace(body, 'https://abryflgoljltyakthtql.supabase.co/storage/v1/object/public/ugc-images/', 'https://img.azsou.com/ugc-images/')
   where body like '%/storage/v1/object/public/ugc-images/%';
   -- forum_replies、comments 同理
   ```

## 5. 不需要搬的东西

- 官方内容在 Git 里，与数据库无关。
- 站点是静态文件 + 3 个小函数，可以部署到任何支持 Node 的平台（Netlify / Cloudflare Pages 需换 Astro 适配器，并把 `vercel.json` 的响应头与重定向改写成该平台的格式）。
