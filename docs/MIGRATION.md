# 生产切换手册（V72 → v2）

目标：在不中断 V72 的前提下把生产数据库（Supabase 项目 `abryflgoljltyakthtql`，Postgres 17）迁移到 v2 结构，
然后把 Vercel 生产环境切到 v2。全程约 30–60 分钟，建议选访问量低的时段。

**原则**

- 先备份，再动库。每个迁移文件自带 `begin … commit`：中途出错整文件回滚，库停在上一步的状态。
- 每个文件都可以重复执行（`if not exists` / `create or replace` / `on conflict`）。执行失败修正后直接重跑。
- 0002–0014 全部向后兼容 V72（CI 用 PostgREST 重放 V72 的全部请求验证）：迁移过程中和迁移之后，V72 都能正常读写。
- **不要执行 `0001_baseline.sql`**——它是生产现状的精确还原，只用于本地 / CI 建库。

当前状态（2026-10-24 只读核对）：`db/verify/status.sql` 的 17 项检查全部为 `false`，即 0002–0011 都还没有执行。
P6 新增 0012（应用商店：评价 + 下载计数）、0013（AI 工具页评论）与 0014（视频页评论），核对项增加到 21 项。

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
  BACKUP_PASSPHRASE='<自选口令>' bash scripts/db-backup.sh "$DB" backups/$(date +%F)
  ```

产物：`azsou-public-*.dump`（public 全部结构 + 数据 + 策略）、`azsou-auth-*.dump`（账户 + 第三方登录绑定）、`azsou-private-*.dump`、`azsou-storage-*.dump`（元数据）、globals 清单（全部 gpg 加密，见 BACKUP.md §2B）、结构 SQL、行数清单、校验和。
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

## 5A. 应用商店（0012，P6）

```bash
run db/migrations/0012_app_store.sql;             status   # app_reviews + app_review_stats + app_download_counts + app_count_download
```

0012 新增的对象（全部是新表 / 新函数，不改动 V72 用到的任何东西）：

- `public.app_reviews`：应用评价（1–5 星 + 标题 / 正文，每人每个应用一条），RLS 与评论相同（公开读已发布；本人可改删；版主可隐藏 / 删除；被封禁不能写）；
- `public.app_review_stats`：每个应用已发布评价的条数、平均分、1–5 星分布（视图，只统计 `published`）；
- `public.app_download_counts` + `public.app_count_download(app, platform)`：真实下载计数（去重、限流、过滤爬虫，只存加盐哈希不存 IP）；
- `private.app_download_events`（访客事件，保留 2 天）与 `private.app_settings` 里的 `download_salt`（随机生成，API 读不到）；
- `reports.target_type` 允许 `review`；`mod_handle_reports` 的「隐藏」覆盖评价；`az_target_author` / `az_audit_moderation` 认识评价。

**验证**：

```sql
select count(*) from public.app_reviews;                              -- 0（不预置任何评价）
select * from public.app_review_stats;                                -- 0 行
select public.app_count_download('fablemotion', 'web');               -- 直连（没有请求头）不计数，返回 0
select count(*) from public.app_download_counts;                      -- 0
select pg_get_constraintdef(oid) from pg_constraint where conname = 'reports_target_type_check';  -- 含 'review'
```

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

| 情况                            | 做法                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某个迁移文件执行报错            | 文件在事务里，已自动回滚；看报错修正后**重跑同一个文件**。库停在上一步，V72 不受影响                                                                                                                                                                                                                                                                 |
| 迁移完成但 V72 出现异常         | 先确认是否为预期变化（例如 V72 的作者现在不能自己置顶 —— 这是安全修复）；如需撤销某项权限收紧，联系开发者针对性修复，**不要**整库恢复                                                                                                                                                                                                                |
| v2 前端上线后有严重问题         | Vercel → Deployments → 选 V72 的最后一个生产部署 → **Instant Rollback**（或把 Production Branch 改回 `main` 的 V72 提交）。数据库不用动                                                                                                                                                                                                              |
| 注册钩子误拦正常用户            | Dashboard → Authentication → Hooks → Before User Created → Disable（立即生效）；或清空 `private.app_settings` 里的密钥（钩子放行所有人）                                                                                                                                                                                                             |
| 数据被误删 / 库损坏（灾难恢复） | 新建一个 Supabase 项目 → `bash scripts/db-restore.sh "<新库连接串>" azsou-public-*.dump azsou-auth-*.dump --private azsou-private-*.dump --storage azsou-storage-*.dump`（先 gpg -d 解密） → Vercel 改 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY` 指向新项目并 Redeploy；Auth / Storage 设置按 CONFIG.md 重配。脚本已在 CI 里演练（见 BACKUP.md） |

0002–0015 没有「down」脚本：它们只增加列 / 表 / 函数 / 策略，不删除数据；撤销它们反而会再次暴露 V72 时代的权限问题。
需要回到迁移前的精确状态时，用第 1 步的备份恢复到新项目（上表最后一行），不要在生产库上手工删除对象。

## 5B. AI 工具评论（0013，T6.6）

```bash
run db/migrations/0013_tool_comments.sql;        status   # comments_page_key_check 允许 tool:<slug>
```

- 只替换一条约束：`comments.page_key` 在原有 `article / game / work / project` 之外允许 `tool:<slug>`（/ai/<slug>/ 的讨论区）。V72 的读写不受影响，已有数据全部满足新约束；可重复执行。
- AI 工具的评分评价与「跳转」计数复用 0012 的 `app_reviews` / `app_count_download`：0012 只校验 slug 格式，不需要迁移（应用与工具的 slug 由 `tests/unit/content.test.ts` 保证不重名）。
- 没执行 0013 之前，/ai/ 页面照常可用，只是在工具页发评论会被数据库拒绝（页面提示发布失败）。

**验证**：

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'comments_page_key_check';  -- 含 tool
```

## 5C. 视频页评论（0014，T6.7）

```bash
run db/migrations/0014_video_comments.sql;       status   # comments_page_key_check 允许 video:<slug>
```

- 只替换一条约束：`comments.page_key` 在 `article / game / work / project / tool` 之外允许 `video:<slug>`（/videos/<slug>/ 的讨论区）。V72 的读写不受影响；可重复执行。
- 带保护：执行前先统计不符合新约束的 `page_key`。理论上不会有（0013 的约束更严）；万一有，迁移**跳过替换并给出 warning**，不会让整个文件失败——先人工检查那些行再重跑。
- 视频页没有评分与下载，不涉及 0012 的表。没执行 0014 之前，/videos/ 页面照常可用，只是在视频页发评论会被数据库拒绝（页面提示发布失败）。

**验证**：

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'comments_page_key_check';  -- 同时含 tool 与 video
```

## 5D. 留言板与友链申请（0015，T7.3 / T7.4）

```bash
run db/migrations/0015_guestbook.sql;            status   # guestbook_entries / friend_links（RLS）+ 提交 RPC
```

- 新增两张表：`guestbook_entries`（访客留言）与 `friend_links`（友链申请）。公开只读 `approved`；友链的联系方式任何 API 角色都读不到（只有管理员 RPC `admin_list_friend_links` 返回）。
- 写入只能经 `guestbook_submit` / `friend_link_submit`，而且必须带本站 Vercel Function（`/api/submit/<kind>`，服务端校验 Turnstile）签发的 HMAC 票据：10 分钟有效、一次性、绑定内容摘要；写入的一律是 `pending`。限流按带密钥的访客摘要（不存 IP）：留言 3 次 / 10 分钟、10 次 / 天；友链 2 次 / 天；待审核上限 200 / 50。
- 审核：留言由版主或管理员（`mod_guestbook_set_status` / `mod_guestbook_delete`），友链仅管理员（`admin_friend_link_*`）；每个动作写 `audit_log`。
- **必须配置票据密钥，否则提交一律被拒（页面提示「暂未开放」）**：

```bash
SECRET=$(openssl rand -hex 32)
# Vercel → Settings → Environment Variables：COMMUNITY_TICKET_SECRET=$SECRET（Production + Preview）
psql "$PROD" -c "insert into private.app_settings (key, value) values ('community_ticket_secret', '$SECRET')
  on conflict (key) do update set value = excluded.value, updated_at = now();"
```

- Turnstile 复用注册页已有的 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`（同一个小组件即可，action 分别为 `guestbook` / `link`）。预览站没有真实密钥时设 `TURNSTILE_ALLOW_TEST_KEYS=1`。
- 纯增量、可重复执行，不改任何已有表；没执行 0015 之前，/guestbook/ 与 /links/ 照常打开，只是列表显示「暂时无法加载」、提交返回「数据库还没有执行 0015 迁移」。

**验证**：

```sql
select relname, relrowsecurity from pg_class where relname in ('guestbook_entries', 'friend_links');  -- 都是 true
select count(*) from private.app_settings where key = 'community_ticket_secret';                    -- 1
```

## 5E. 邮件订阅（0016，T7.8）

```bash
run db/migrations/0016_subscribers.sql;          status   # subscribers（RLS，无公开读写）+ 订阅 / 确认 / 退订 / 计数 RPC
```

- 依赖 0015（复用 `community_ticket_secret` 与票据函数）；纯增量、可重复执行，不改任何已有表。
- 新表 `subscribers`：邮箱、语言（zh / en）、状态（pending → confirmed → unsubscribed）。**任何 API 角色（含版主、管理员）都不能直接读写**；
  管理员只能用 `admin_subscriber_counts()` 看按状态 × 语言的数量，没有任何列出 / 导出邮箱的接口。
- 不存明文令牌：确认令牌 32 字节随机数，只出现在确认邮件里，表里存 sha256（48 小时有效、用过即清空）；
  退订令牌 = HMAC-SHA256(`COMMUNITY_TICKET_SECRET`, `'unsubscribe|' + 邮箱`)，同样只存 sha256——以后群发时用同一个密钥重新算出链接（换密钥会让旧退订链接失效）。
- 写入只经 `/api/subscribe`（Turnstile + 票据）：每个访客 3 次 / 小时、10 次 / 天；同一邮箱 10 分钟内不重复发信；已订阅的邮箱再提交不发信，对访客的回答与新订阅相同（不泄露是否订阅）。
- 确认 / 退订页是静态页面，带 `#token=` 调 `subscribe_confirm` / `subscribe_unsubscribe`（anon 可调用；需要访客点按钮，邮件客户端的链接预取不会误操作）。
- **发信服务没配置时 `/api/subscribe` 返回 503，不写数据库、不发任何邮件**（页面提示改用 RSS）。配置方法见 DEPLOY.md §2A。

**验证**：

```sql
select relrowsecurity from pg_class where relname = 'subscribers';                      -- true
select has_table_privilege('anon', 'public.subscribers', 'select');                     -- false
select has_table_privilege('authenticated', 'public.subscribers', 'select');            -- false
```

## 5F. 后台 CRM（0017，P10 PR H）

```bash
run db/migrations/0017_admin_crm.sql;            status   # admin_notes / admin_user_tags / content_workflow / content_versions + 排序 / 画像 / 流程 RPC
```

- 纯增量、可重复执行：只新建表、函数、触发器。`mod_list_content` / `mod_list_users` 追加可选参数 `p_sort` / `p_dir`
  （PostgreSQL 不能原地追加参数，所以先 `drop function` 旧签名再建新签名——只删函数定义，不碰任何数据；不带新参数的旧调用照常）。
- 新表全部开启 RLS，只有版主 / 管理员可读；备注只能删自己的（管理员可删全部）。
- 定时发布：`mod_workflow_tick()` 由后台页面加载时调用；也可在 Supabase 开 pg_cron 后每 5 分钟执行 `select public.mod_workflow_tick();`。
- 用户画像的「登录记录」读 `auth.sessions`（存在时）；IP 只对管理员返回。批量邮件只有草稿与预览，**数据库与前端都没有发信接口**。

## 5G. 状态一致性 / 调度 / 权限（0018，交接批次 2）——**站长尚未批准，生产未执行**

> 生产执行走放行申请 ①：[docs/release/2026-10-27-prod-migrations-0002-0019-release-request.md](release/2026-10-27-prod-migrations-0002-0019-release-request.md)；
> 开启调度走放行申请 ②（独立审批）：[docs/release/2026-10-27-scheduler-cron-release-request.md](release/2026-10-27-scheduler-cron-release-request.md)。

```bash
run db/migrations/0018_state_consistency.sql;    status   # 统一状态接口 / 调度运行记录 / 分页 envelope / 正文编辑 RPC / 同步与孤儿触发器
```

- 纯增量、可重复执行：新增 `workflow_tick_runs`、`workflow_scheduler_heartbeat`、`admin_idempotency` 三张表（RLS 开启）、`content_workflow.orphaned_at` 一列，
  新增函数与触发器；替换 0017 的 `mod_set_workflow` / `mod_workflow_tick` 函数体（签名不变，旧前端照常）。不删列、不改已有数据。
- **行为变化（需站长知悉）**：
  - 版主（以及管理员）不能再直接 PATCH 他人内容的 `title` / `body` / `cat`；版主只调整审核标志（隐藏 / 置顶 / 锁定 / 精华）。
    管理员改他人内容走 `mod_edit_content()`（理由必填，写版本、审计、通知作者）。前台「编辑」按钮只对作者本人显示。（A04，站长 2026-10-27 已定）
  - 手工隐藏「待审 + 定时」内容会**取消**定时发布（开关 `az_hide_cancels_schedule()`，默认 true，站长 2026-10-27 已定）；
    **恢复不复活旧排程**：`scheduled_at` 清空，被取消的时间只记在审计（`cancelled_scheduled_at`）。
    （0018 里恢复 = 立即公开；站长 2026-10-27 21:06 改为「恢复回到待审 + 显式发布」，由 0019 实现，见 5I。）
  - 锁顺序统一为「先内容行、后排程行」：tick 对内容行 `FOR UPDATE SKIP LOCKED` 并在锁内复核，隐藏与 tick 交错不再死锁、
    也不会把正在隐藏的内容公开（`tests/db/b2-tick-lock.test.ts`）。
  - 调度心跳：`mod_workflow_tick_job(source, interval)` 每次写 `workflow_scheduler_heartbeat`，超过 2× 间隔 → `az_workflow_health().heartbeat_stale`、告警。
  - 内容版本保留 90 天：`az_prune_content_versions(90)`（只建函数，不排任务）。
  - 任何路径改 `published`（旧版后台、前台版主按钮、举报处理）都会同步 `content_workflow`，不再出现「后台显示待审、前台已公开」。
- 依赖 0017；0016 及以前的库请先补 0017。前端对缺 0018 的库自动退回旧接口（逐项结果与状态同步不可用，后台显示降级提示）。
- 调度：0018 **不创建任何 cron 任务**。启用无人值守调度见 `db/ops/workflow-cron.sql` 与 OPERATIONS.md「4A」，同样需站长批准。

## 5I. 恢复回到待审 + 显式发布 + 90 天内不按上限删版本（0019，站长第二轮 2026-10-27 21:06）——**站长尚未批准，生产未执行**

```bash
run db/migrations/0019_restore_review_version_window.sql;    status   # 恢复 → 待审 / mod_publish_content / 版本上限只裁 90 天前
```

- 纯增量、可重复执行：替换 0018 的 `mod_set_visibility` 函数体（签名、授权不变），新增 `mod_publish_content(text, uuid[], text)`（只授予 authenticated，函数内要求版主 / 管理员）。
- **行为变化（站长已定）**：
  - 「恢复」（`mod_set_visibility(..., true)`）不再公开：被隐藏 / 下线 / 草稿的内容恢复后 `published = false`、流程状态「待审」、`scheduled_at` 为空（永不复活旧排程）；对已公开内容点恢复 = unchanged。
  - 公开必须走显式「发布」`mod_publish_content`：逐项结果、去重、上限 200、幂等键；写 `content.published` 审计（来源状态、被清掉的排程时间）。后台内容表：已隐藏 → 「恢复」，待审 / 草稿 → 「发布」，批量条新增「发布」。
  - 旧前端直接 PATCH `published=true` 仍等同一次发布（明确改公开标志，只有版主 / 管理员能做）；新后台不走这条路。
- **90 天内不按上限删版本**：替换 0017 的触发器函数 `az_save_content_version`（不改 0017 文件）——每条内容「最多 50 个版本」的上限只裁剪排在最新 50 条之外**且早于 90 天**的版本；90 天内的版本一条不删（51 次 / 100 次编辑全部保留）。`az_prune_content_versions(p_days ≥ 90)` 不变。
- 依赖 0018。前端对缺 0019 的库：「发布」按钮报「缺少迁移 0019」（不退回 PATCH，避免绕过「恢复 → 待审」）。

## 5H. B04 迁移演练与回滚 / 恢复预案（0017 / 0018 / 0019）

**演练（隔离库，已执行）**：`DATABASE_URL=<本机 Postgres> bash scripts/db/rehearse-migrations.sh <输出目录>`。
脚本拒绝非本机地址。步骤：类生产库（plain shim + 0001 + 合成数据）→ 迁移前快照（status / 行数 / 策略 / 表与列授权 / 函数授权）与
`pg_dump` → 0002 → 0019（每步 status）→ 迁移后快照与 diff（原有表行数必须不变）→ 重跑 0017、0018、0019 与整套 0002 → 0019
（快照必须完全一致）→ 用迁移前备份恢复到新库（行数与 status 回到迁移前）。2026-10-27 的结果在
`docs/audits/evidence/batch2/b04/`：原有 5 张表与 auth.users 行数无变化；status 未通过项 23 → 0；重跑一致；恢复一致。

**生产执行清单（站长批准后，按顺序；任何一步不符合预期就停）**：

1. 冻结后台写操作（通知版主暂停审核约 10 分钟）；记录当前 Vercel 生产部署 ID。
2. 备份：Actions → DB backup → Run workflow（需要 `SUPABASE_DB_URL` + `BACKUP_PASSPHRASE`），确认工作流绿色——
   它已包含 `scripts/db-verify-backup.sh` 的校验和 / 解密 / `pg_restore --list` / 行数清单检查；下载 artifact 留本地一份。
3. 迁移前快照（只读，SQL 编辑器）：`db/verify/status.sql`、第 1 节的行数 SQL、
   `select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1, 2;`，结果另存。
4. 按「附：最终执行顺序」只执行缺失的迁移（status 为 false 的那些），每个文件后跑 `status`。
5. 迁移后快照，与第 3 步对比：原有表行数必须一致；策略差异应与演练的 `diff-policies.txt` 同类（新表 / 收紧的写策略）。
6. 真实角色 canary（用测试账号，不动真实用户数据）：匿名读首页论坛 → 普通用户发 / 删自己的一条测试回复 → 版主隐藏 / 恢复该回复
   → 管理员打开后台 8 个模块（概览 / 内容 / 用户 / 举报 / 留言 / 友链 / 订阅 / 审计，清单 `tests/e2e/admin-modules.ts`）无错误（A15）。完成后删除测试回复。
7. 解除冻结；观察 30 分钟审计日志与错误。

**回滚 / 恢复**：

| 情况                                              | 做法                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某个迁移文件报错                                  | 文件在事务里，已整体回滚；修正后重跑同一文件。库停在上一步                                                                                                                                                                                                             |
| 0018 的行为变化不被接受（例如要让版主改他人正文） | 不回退迁移；按站长决定改策略：版主改正文 = 调整 `az_content_edit_guard()` 判断并放开 `mod_edit_content()` 给版主；隐藏不取消排程 = 把 `az_hide_cancels_schedule()` 改为 `select false`                                                                                 |
| 0019 行为不被接受                                 | 不回退迁移：恢复 → 待审是 `mod_set_visibility` 的函数体，可按站长决定再替换；版本上限同理替换 `az_save_content_version`                                                                                                                                                |
| 只想停用 0018 的触发器                            | `drop trigger az_workflow_sync / az_workflow_orphan / az_content_edit_guard on <表>`（三张表各一）——前端照常工作，回到 0017 行为                                                                                                                                       |
| 数据损坏 / 需要精确回到迁移前                     | 用第 2 步的备份恢复到**新** Supabase 项目：`scripts/db-restore.sh <新库> azsou-public-*.dump azsou-auth-*.dump --private azsou-private-*.dump --storage azsou-storage-*.dump`（先 gpg -d 解密），再切换 Vercel 环境变量（见第 9 节最后一行）。不要在生产库上手工删对象 |

## 附：最终执行顺序

```
备份 → db/shim/supabase.sql
     → 0002_roles_columns → 0003_social_tables → 0004_functions_triggers → 0005_privileges → 0006_rls
     → 0007_signup_guard（钩子先不启用）
     → 0008_forum_search → 0009_admin → 0010_ugc_images → 0011_forum_category_guard
     → 0012_app_store（应用商店：评价 + 下载计数）
     → 0013_tool_comments（AI 工具页的评论）
     → 0014_video_comments（视频页的评论）
     → 0015_guestbook（留言板 + 友链申请；写入 community_ticket_secret）
     → 0016_subscribers（邮件订阅，双重确认；依赖 0015 的密钥）
     → 0017_admin_crm（后台：服务端排序、备注、用户标签 / 画像、内容流程 + 定时发布、版本历史）
     → 0018_state_consistency（统一状态接口、调度运行记录 / 心跳 / 告警、他人正文只经管理员 RPC、批量逐项结果；待站长批准，放行申请 ①）
     → 0019_restore_review_version_window（恢复 → 待审 + 显式发布；版本 50 条上限只裁 90 天前；待站长批准，放行申请 ①）
     → （另需批准，放行申请 ②）db/ops/workflow-cron.sql 启用 pg_cron 调度
     → 每步后 db/verify/status.sql
     → 合并 PR #2（或切 Production Branch）→ check-csp --url
     → 写入 signup_ticket_secret + 启用 Before User Created 钩子 → 开启邮箱确认
     → 上线检查 → 提交站点地图
```
