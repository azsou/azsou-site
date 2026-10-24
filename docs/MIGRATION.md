# 生产切换手册（V72 → v2）

目标：在不中断 V72 的前提下把生产数据库（Supabase 项目 `abryflgoljltyakthtql`，Postgres 17）迁移到 v2 结构，
然后把 Vercel 生产环境切到 v2。全程约 30–60 分钟，建议选访问量低的时段。

**原则**

- 先备份，再动库。每个迁移文件自带 `begin … commit`：中途出错整文件回滚，库停在上一步的状态。
- 每个文件都可以重复执行（`if not exists` / `create or replace` / `on conflict`）。执行失败修正后直接重跑。
- 0002–0011 全部向后兼容 V72（CI 用 PostgREST 重放 V72 的全部请求验证）：迁移过程中和迁移之后，V72 都能正常读写。
- **不要执行 `0001_baseline.sql`**——它是生产现状的精确还原，只用于本地 / CI 建库。

当前状态（2026-10-24 只读核对）：`db/verify/status.sql` 的 17 项检查全部为 `false`，即 0002–0011 都还没有执行。

---

## 0. 准备（切换前一天）

- [ ] PR #2 的 CI 全绿；在 Vercel 预览上按 [ACCEPTANCE.md](ACCEPTANCE.md) 走一遍。
- [ ] 准备好：Supabase Dashboard 管理员账号、数据库密码（Project Settings → Database）、Vercel 项目管理员。
- [ ] Vercel 环境变量已按 [DEPLOY.md](DEPLOY.md) §2 配好（`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`；`SIGNUP_TICKET_SECRET` 先生成好，第 6 步再用）。
- [ ] Supabase Auth 的 URL、邮件模板、SMTP、OAuth 已按 [CONFIG.md](CONFIG.md) 配好（这些不影响 V72）。
- [ ] 本地有 Postgres 17 客户端（`psql --version` ≥ 17），或者只用 Supabase SQL 编辑器。

连接串（psql 方式）：Supabase → Project Settings → Database → Connection string → **Session pooler**（端口 5432）。

```bash
# 主机名以 Dashboard 显示为准（形如 aws-0-ap-southeast-1.pooler.supabase.com）
export DB='postgresql://postgres.abryflgoljltyakthtql:<数据库密码>@<pooler 主机>:5432/postgres'
run() { psql "$DB" -v ON_ERROR_STOP=1 -f "$1"; }
status() { psql "$DB" -f db/verify/status.sql; }
```

SQL 编辑器方式：打开文件 → 全选复制 → 粘贴到 Supabase → SQL Editor → Run。下文的「验证」同样粘贴执行。

## 1. 备份（必须）

任选其一，**确认拿到文件再继续**：

- GitHub Actions：仓库 Settings → Secrets → Actions 添加 `SUPABASE_DB_URL`（上面的连接串）和 `BACKUP_PASSPHRASE`，
  然后 Actions → **DB backup** → Run workflow（分支选 `v2/astro`），下载 artifact `db-backup-<run id>`。
- 本地：

  ```bash
  BACKUP_INCLUDE_AUTH=1 BACKUP_PASSPHRASE='<自选口令>' bash scripts/db-backup.sh "$DB" backups/$(date +%F)
  ```

产物：`azsou-public-*.dump`（public 全部结构 + 数据 + 策略）、`azsou-auth-users-*.dump`（账户）、结构 SQL、行数清单、校验和。
另外记下当前行数，供之后对比：

```sql
select (select count(*) from auth.users) users, (select count(*) from public.profiles) profiles,
       (select count(*) from public.forum_threads) threads, (select count(*) from public.forum_replies) replies,
       (select count(*) from public.comments) comments, (select count(*) from public.site_content) content;
```

## 2. 环境检查

```bash
run db/shim/supabase.sql      # 只检查 anon / authenticated / auth.uid() / auth.users 是否存在，不创建任何东西
```

验证：无报错即可。报「这不是 Supabase 库」说明连错了库。

## 3. 结构与权限（0002 → 0006，按顺序）

| 顺序 | 文件                          | 做了什么                                                                           |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------- |
| 3.1  | `0002_roles_columns.sql`      | 角色加 moderator；主题 locked / featured / edited_at；回复真外键；种子主题表；索引 |
| 3.2  | `0003_social_tables.sql`      | 点赞、收藏、举报、通知、审计日志、限流计数表（建好即收回默认权限，不暴露数据）     |
| 3.3  | `0004_functions_triggers.sql` | 权限辅助函数、限流、列守卫触发器、回复通知、审计                                   |
| 3.4  | `0005_privileges.sql`         | 收紧表 / 列 / 函数权限（anon 只读；authenticated 按列授权；回收 TRUNCATE 等）      |
| 3.5  | `0006_rls.sql`                | 重写全部行级安全策略                                                               |

```bash
run db/migrations/0002_roles_columns.sql;      status
run db/migrations/0003_social_tables.sql;      status
run db/migrations/0004_functions_triggers.sql; status
run db/migrations/0005_privileges.sql;         status
run db/migrations/0006_rls.sql;                status
```

**验证**：每一步之后 `db/verify/status.sql` 里该步及之前的行全部为 `true`、之后的为 `false`。0006 之后再确认 V72 仍可用：

```sql
-- 匿名能读主题（V72 首页 / 论坛）
begin; set local role anon; select count(*) from public.forum_threads where published; rollback;
-- 行数与第 1 步一致（迁移不删数据）
select (select count(*) from public.forum_threads) threads, (select count(*) from public.forum_replies) replies,
       (select count(*) from public.comments) comments;
```

并在浏览器打开当前线上站（V72）的论坛，确认列表、主题、登录照常。

## 4. 注册钩子函数（0007，先不启用）

```bash
run db/migrations/0007_signup_guard.sql; status
```

只创建 `public.az_hook_before_user_created` 与 `private.app_settings`；**此时不要在 Dashboard 启用钩子**（V72 的注册不带票据，启用后 V72 无法注册）。

## 5. 搜索、后台、图片、分类（0008 → 0011）

```bash
run db/migrations/0008_forum_search.sql;          status   # pg_trgm + search_threads / thread_reply_counts
run db/migrations/0009_admin.sql;                 status   # 封禁记录、版主 RPC、后台统计、@提及、注册开关
run db/migrations/0010_ugc_images.sql;            status   # ugc-images 公开读桶（2 MB，jpeg/png/webp/gif）+ 存储 RLS
run db/migrations/0011_forum_category_guard.sql;  status   # 数据库拦截「已停用」论坛分类
```

**验证**：`status` 全部为 `true`。另外：

```sql
-- 0010：桶配置
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ugc-images';
-- 0010：存储策略
select policyname, cmd from pg_policies where schemaname = 'storage' and policyname like 'az_ugc_images_%';
-- 0011：没有论坛设置时任何分类都能发（与 V72 相同）
select public.az_forum_category_disabled('技术交流');   -- false
-- 后台：给自己设管理员（把邮箱换成站长的）
update public.profiles set role = 'admin' where id = (select id from auth.users where email = '<站长邮箱>');
select id, display_name, role from public.profiles where role in ('admin', 'moderator');
```

Dashboard → Storage 里应能看到 `ugc-images` 桶（Public）。

## 6. 切换前端到 v2

1. **合并 PR #2 到 `main`**（站长操作；合并即触发生产部署）。
   或者不合并、临时切换：Vercel → Settings → Git → Production Branch 改为 `v2/astro` → Redeploy。
2. 等部署完成（Vercel → Deployments 显示 Ready），立刻：

   ```bash
   node scripts/check-csp.mjs --url https://azsou.com    # 线上响应头 = vercel.json
   ```

3. 启用注册钩子（v2 已上线，注册会带票据）：

   ```sql
   insert into private.app_settings (key, value) values ('signup_ticket_secret', '<与 Vercel SIGNUP_TICKET_SECRET 相同>')
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```

   确认 Vercel 生产环境已设置同一个 `SIGNUP_TICKET_SECRET` 并已 Redeploy；然后 Supabase Dashboard → Authentication → Hooks →
   **Before User Created** → Postgres → `public.az_hook_before_user_created` → Enable。
   验证：在 `https://azsou.com/register/` 用新邮箱注册成功；用 curl 直接调 GoTrue 注册被拒：

   ```bash
   curl -s https://abryflgoljltyakthtql.supabase.co/auth/v1/signup -H "apikey: <publishable key>" \
     -H 'content-type: application/json' -d '{"email":"bot@example.com","password":"x1234567"}'
   # → 403「请在 azsou.com 的注册页面完成人机验证后注册。」
   ```

4. 打开邮箱确认（如果第 0 步还没开）：Authentication → Providers → Email → Confirm email = On。

## 7. 上线后检查（15 分钟内）

- [ ] 首页、文章、应用、游戏、作品、论坛、搜索都能打开；移动端底部 Tab 正常。
- [ ] **旧 hash 链接**跳转：依次打开下面的地址，应落到右边的新地址：

  | 旧地址                                              | 新地址                             |
  | --------------------------------------------------- | ---------------------------------- |
  | `https://azsou.com/#/article/pinyin-initial-search` | `/articles/pinyin-initial-search/` |
  | `https://azsou.com/#/game/emberdeep`                | `/games/emberdeep/`                |
  | `https://azsou.com/#project`                        | `/apps/fablemotion/`               |
  | `https://azsou.com/#/forum/t-announce`              | `/forum/t/t-announce/`             |
  | `https://azsou.com/forgot-password`                 | `/reset-password/`（308）          |
  | `https://azsou.com/index.html`                      | `/`（308）                         |

- [ ] 用已有账号登录（V72 的登录状态会被 v2 直接沿用）；发一个测试主题、回复、上传一张图片，然后在后台隐藏 / 删除它。
- [ ] 后台 `/admin/`：概览数字与第 1 步的行数一致；举报队列、用户、审计日志可打开。
- [ ] 旧 Service Worker 已自毁：在之前访问过 V72 的浏览器里刷新两次，页面是新版（DevTools → Application → Service Workers 只有 `/sw.js`）。
- [ ] Supabase → Logs：没有持续的 4xx/5xx；Advisors（Security / Performance）没有新的高危项。

## 8. 提交站点地图

站点地图：`https://azsou.com/sitemap-index.xml`（页面）与 `https://azsou.com/forum/sitemap-threads.xml`（论坛主题，每小时更新）。
`robots.txt` 已声明前者。

1. **Google Search Console**：添加资源（网域 `azsou.com`，DNS TXT 验证）→ 站点地图 → 提交 `sitemap-index.xml` 与 `forum/sitemap-threads.xml`；
   网址检查 → 首页 → 请求编入索引。
2. **Bing Webmaster Tools**：可直接「从 Google Search Console 导入」；或添加站点后提交同样两个地址。
3. **百度搜索资源平台**：添加站点并验证（文件或 HTML 标签验证；需要标签时在 `src/layouts/Base.astro` 的 `<head>` 加 `<meta name="baidu-site-verification">`）→
   普通收录 → sitemap 提交 `https://azsou.com/sitemap-index.xml`。
4. 一周后查看「网页索引编制」报告；旧的 `/#/…` 地址对搜索引擎是同一个首页，不需要单独处理。

## 9. 回滚方案

| 情况                            | 做法                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某个迁移文件执行报错            | 文件在事务里，已自动回滚；看报错修正后**重跑同一个文件**。库停在上一步，V72 不受影响                                                                                                                                                                                       |
| 迁移完成但 V72 出现异常         | 先确认是否为预期变化（例如 V72 的作者现在不能自己置顶 —— 这是安全修复）；如需撤销某项权限收紧，联系开发者针对性修复，**不要**整库恢复                                                                                                                                      |
| v2 前端上线后有严重问题         | Vercel → Deployments → 选 V72 的最后一个生产部署 → **Instant Rollback**（或把 Production Branch 改回 `main` 的 V72 提交）。数据库不用动                                                                                                                                    |
| 注册钩子误拦正常用户            | Dashboard → Authentication → Hooks → Before User Created → Disable（立即生效）；或清空 `private.app_settings` 里的密钥（钩子放行所有人）                                                                                                                                   |
| 数据被误删 / 库损坏（灾难恢复） | 新建一个 Supabase 项目 → `bash scripts/db-restore.sh "<新库连接串>" azsou-public-*.dump azsou-auth-users-*.dump` → Vercel 改 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY` 指向新项目并 Redeploy；Auth / Storage 设置按 CONFIG.md 重配。脚本已在 CI 里演练（见 BACKUP.md） |

0002–0011 没有「down」脚本：它们只增加列 / 表 / 函数 / 策略，不删除数据；撤销它们反而会再次暴露 V72 时代的权限问题。
需要回到迁移前的精确状态时，用第 1 步的备份恢复到新项目（上表最后一行），不要在生产库上手工删除对象。

## 附：最终执行顺序

```
备份 → db/shim/supabase.sql
     → 0002_roles_columns → 0003_social_tables → 0004_functions_triggers → 0005_privileges → 0006_rls
     → 0007_signup_guard（钩子先不启用）
     → 0008_forum_search → 0009_admin → 0010_ugc_images → 0011_forum_category_guard
     → 每步后 db/verify/status.sql
     → 合并 PR #2（或切 Production Branch）→ check-csp --url
     → 写入 signup_ticket_secret + 启用 Before User Created 钩子 → 开启邮箱确认
     → 上线检查 → 提交站点地图
```
