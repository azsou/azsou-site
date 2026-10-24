# 部署（Vercel）

本站是 Astro 5 静态站 + 3 个 Vercel Function（`/api/auth/*`、`/forum/sitemap-threads.xml`），由 `@astrojs/vercel` 适配器输出到
`.vercel/output`。数据库、登录、图片存储在 Supabase（见 [CONFIG.md](CONFIG.md)）。

> 合并到 `main` = 上线。上线前先按 [MIGRATION.md](MIGRATION.md) 完成数据库迁移，再按 [ACCEPTANCE.md](ACCEPTANCE.md) 验收。

## 1. 项目设置（Vercel → Project → Settings）

| 位置                       | 值                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| General → Framework Preset | **Astro**                                                                                       |
| General → Build Command    | `npm run build`（`vercel.json` 已写，保持默认即可）                                             |
| General → Install Command  | `npm ci`                                                                                        |
| General → Output Directory | 留空（适配器写 `.vercel/output`）                                                               |
| General → Root Directory   | 留空（仓库根目录）                                                                              |
| General → Node.js Version  | **22.x**（`package.json` 要求 ≥ 20.3；CI 用 22）                                                |
| Git → Production Branch    | `main`                                                                                          |
| Git → Ignored Build Step   | 默认                                                                                            |
| General → Vercel Toolbar   | **Disabled（预览与生产都关）**——工具栏脚本来自 vercel.live，会被本站 CSP 拦截并在控制台报错     |
| Deployment Protection      | 预览可开启 Vercel Authentication；生产关闭                                                      |
| Functions → Region         | **`sin1`（新加坡）**——Supabase 项目在 `ap-southeast-1`，`/api/auth/*` 与线程 sitemap 都要访问它 |

`vercel.json` 负责：安全响应头（CSP、HSTS、nosniff、Referrer-Policy、X-Frame-Options、COOP、Permissions-Policy）、
静态资源缓存头、Service Worker 头、旧地址重定向（`/index.html`、`/forgot-password`、`/project`、`/sitemap.xml`、`/forum/thread`）。
旧版 `#/xxx` 链接由页面里的小脚本跳到新地址（不经过服务器）。

## 2. 环境变量（Settings → Environment Variables）

| 变量                        | 环境                 | 必需   | 说明                                                                                                                                          |
| --------------------------- | -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SITE_KEY`        | Production / Preview | 是     | Cloudflare Turnstile **站点密钥**（公开值，构建时写进注册 / 找回密码页）。未设置时用 Cloudflare 测试 key（总是通过）                          |
| `TURNSTILE_SECRET_KEY`      | Production / Preview | 是     | Turnstile **私钥**，只在 `/api/auth/*` 服务端使用。部署环境缺少它时注册 / 找回密码接口拒绝服务（防止误用测试 key 上线）                       |
| `SIGNUP_TICKET_SECRET`      | Production           | 切换时 | 注册票据 HMAC 密钥（`openssl rand -hex 32`），与数据库 `private.app_settings` 里的值相同；启用 0007 注册钩子时才需要，见 MIGRATION.md 第 6 步 |
| `PUBLIC_SUPABASE_URL`       | 全部                 | 否     | 默认 `https://abryflgoljltyakthtql.supabase.co`（代码里的默认值）；换项目 / 换库时设置                                                        |
| `PUBLIC_SUPABASE_KEY`       | 全部                 | 否     | Supabase **publishable key**（公开值，权限由 RLS 决定）；默认值写在 `src/lib/supabase-config.ts`。**绝不要**填 secret / service_role key      |
| `PUBLIC_IMAGE_HOSTS`        | 全部                 | 否     | 帖子里允许显示的额外图片主机（逗号分隔），换图片存储时用；同时要改 `vercel.json` CSP 的 `img-src`                                             |
| `TURNSTILE_ALLOW_TEST_KEYS` | Preview              | 否     | 设为 `1` 时预览环境允许使用测试密钥（预览域名不在 Turnstile 白名单里时用）。**生产不要设置**                                                  |
| `PUBLIC_DATA_ADAPTER`       | —                    | 否     | 只用于本地演示（`memory`）。**生产与预览都不要设置**                                                                                          |

`PUBLIC_*` 变量在**构建时**写入页面，修改后需要 Redeploy 才生效。

## 3. 域名（Settings → Domains）

1. `azsou.com` → Production（主域名）。
2. `www.azsou.com` → **Redirect to `azsou.com`（308）**。站点的 canonical、sitemap、OG 地址都是 `https://azsou.com`（`astro.config.mjs` 的 `SITE`）。
3. DNS：apex 用 A 记录 `76.76.21.21`（或按 Vercel 页面提示），`www` 用 CNAME `cname.vercel-dns.com`。
4. 证书由 Vercel 自动签发；HSTS（2 年）由 `vercel.json` 下发，不含 `includeSubDomains`、不提交 preload 列表（避免影响其他子域）。
5. 换域名时同时修改：`astro.config.mjs` 的 `SITE`、Supabase Auth 的 Site URL / Redirect URLs、Turnstile 主机名、OAuth 应用回调（见 CONFIG.md）。

## 4. 部署后检查

```bash
# 安全头与 CSP：线上响应头必须与 vercel.json 一致（Vercel 会把 vercel.json 的 headers 合并进适配器输出）
node scripts/check-csp.mjs --url https://<预览或生产域名>
# 关键地址
curl -sI https://azsou.com/forgot-password | grep -i location   # → /reset-password/
curl -s  https://azsou.com/robots.txt | grep Sitemap
curl -s  https://azsou.com/forum/sitemap-threads.xml | head
```

再在浏览器打开 `https://azsou.com/#/article/pinyin-initial-search`，应跳到 `/articles/pinyin-initial-search/`（旧 hash 链接）。

## 5. 回滚

- Vercel → Deployments → 选上一个生产部署 → **Instant Rollback**（秒级，不需要重新构建）。
- v2 上线后若要整体退回 V72：Promote V72 时代的最后一个生产部署。数据库迁移全部向后兼容 V72（CI 的 `postgrest-v72` 测试用 PostgREST 重放 V72 的全部请求），
  退回前端不需要回滚数据库。

## 6. 内联脚本与 CSP

CSP 的 `script-src` 不含 `'unsafe-inline'`，页面里仅有的三段内联脚本（Service Worker 注册、首页旧 hash 跳转、视频详情页 facade——Astro 会把很小的脚本内联）以 sha256 哈希放行。
改了这些脚本或新增内联脚本后：

```bash
npm run build && npm run csp:update   # 重新计算哈希写入 vercel.json
```

CI 的 `npm run test:csp` 会在哈希不匹配时失败，防止上线后脚本被拦。

CSP 单独一条规则 `/((?!_astro/).*)`：只下发给页面、404 与 Service Worker 脚本，不加到 `/_astro/` 下带哈希的 JS / CSS 上（CSP 只对文档与 Worker 生效；省掉每个资源约 700 字节响应头）。其余安全头（nosniff 等）仍由 `/(.*)` 下发给所有响应。`test:csp` 与 `security.spec.ts` 会检查这个拆分。
