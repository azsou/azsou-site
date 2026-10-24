# AZ Studio v2 — 整站重构方案与任务清单

## 0. 现状诊断（V72，2026-10-24）

| 维度 | 现状 | 问题 |
|---|---|---|
| 架构 | 单文件 index.html 1.1MB（JS 678KB / CSS 319KB），27 段 `vNN` 补丁脚本 + 12 段样式层叠 | 后加补丁覆盖前面逻辑，难维护；首屏需解析 1MB；源码树 az-studio-src 不在仓库 |
| 路由 | 16 个 hash 视图：home/apps/games/articles/works/project/article/archive/work/game/forum/login/register/forgot-password/admin/user | `#/...` 对搜索引擎是同一页；sitemap 只有首页 |
| 内容 | AZ_DATA：8 应用、9 游戏、12 文章、12 作品、7 论坛种子、6 更新 | 只有 FableMotion 有详情页，其他 7 个应用无链接；日期/计数写死在 7 月 |
| 后端 | Supabase：profiles / site_content / comments / forum_threads / forum_replies + rpc admin_set_user | RLS 策略未审计；Turnstile 是假 UI；无限流、无举报、无通知 |
| 缺页 | 关于、联系、隐私、条款、编辑规范（页脚死链）、404、搜索结果、标签/节点、设置、通知、收藏/历史（“即将开放”）、路线图/更新日志 | |
| 设计 | 已有 backdrop-filter 毛玻璃（59 处）、reduced-motion、密度切换 | 暗色模式只有 3 处规则；无 safe-area 统一处理 |

## 1. 目标架构

- **框架**：Astro 5 + TypeScript。内容页全部静态生成（SSG）；论坛/用户页用 Vercel 按需渲染 + CDN 缓存（ISR 式）；交互部分用小型 island（原生 TS / Preact），零框架首屏。
- **真实 URL**：`/apps/[slug]` `/games/[slug]` `/articles/[slug]` `/works/[slug]` `/tags/[tag]` `/forum` `/forum/[category]` `/forum/t/[id]` `/u/[username]` `/search` `/login` `/register` `/reset-password` `/settings` `/notifications` `/admin/*` `/about` `/contact` `/privacy` `/terms` `/editorial` `/changelog` `/roadmap` `/404`。旧 `#/xxx` 链接由一段小脚本 301 式跳转到新路径。
- **内容来源**：Git 内容集合（Markdown/MDX + Zod schema 校验）= 官方内容；Supabase = 用户内容（论坛、评论、资料）+ 后台可编辑的覆盖项。后台改官方内容 → 写库 → 触发 Vercel Deploy Hook 重建。
- **数据库可迁移**：
  - 所有 SQL 放 `db/migrations/*.sql`，只用标准 Postgres（无 Supabase 专有扩展依赖），可直接迁到 Neon / RDS / 自建 PG。
  - 前端只调用 `src/lib/data/` 里的仓储接口（`ForumRepo`、`CommentRepo`、`UserRepo`、`ContentRepo`、`AuthProvider`），Supabase 只是其中一个适配器；换库 = 新写一个适配器。
  - 权限在数据库层（RLS + SECURITY DEFINER 函数）强制，前端只做体验层判断。
- **论坛系统**：分类、主题、回复、Markdown（服务端/客户端双重净化）、置顶/锁定/精华、点赞、举报、@提及与通知、分页、全文搜索（pg_trgm）、限流（数据库函数按用户/分钟计数）、Turnstile 服务端校验（Vercel Function）、软删除与审核队列。
- **全站管理系统**：仪表盘（数据统计）、内容 CRUD + 发布/草稿、论坛与评论审核、举报处理、用户与角色（admin/mod/user/banned）、站点设置、SEO 工具（重建、sitemap）、数据导入导出、操作审计日志。
- **设计系统（macOS / iOS 风格）**：系统字体栈（-apple-system / PingFang SC）、设计令牌（CSS 变量 + @layer）、毛玻璃导航与侧栏（带不支持时的实色回退）、亮/暗自动切换、圆角与层级阴影、44px 触控目标、safe-area、iOS 风格分段控件/开关/底部 Tab、弹簧动效（尊重 reduced-motion）、视图转场（View Transitions API）。
- **SEO 最大化**：每页独立 title/description/canonical；构建期生成 OG 图；JSON-LD（WebSite+SearchAction、Article、SoftwareApplication、VideoGame、BreadcrumbList、DiscussionForumPosting、ProfilePage）；sitemap-index（内容/论坛分开）；RSS（全站/文章/论坛）；语义化 HTML；Core Web Vitals 预算（LCP < 2.0s、CLS < 0.05、首屏 JS < 50KB）；百度/必应站长验证位。

## 2. 测试与质量

- Vitest：工具函数、仓储接口、Markdown 净化、拼音搜索。
- Playwright E2E：Chromium / Firefox / WebKit（≈ Safari）× 桌面 1440 / 平板 834 / iPhone 390 / 安卓 360，覆盖全部页面与登录、发帖、回帖、后台流程。
- axe 无障碍检查、Lighthouse CI 性能/SEO 预算、HTML 校验、死链检查。
- 数据库：本地 Postgres 跑迁移 + RLS 测试（匿名/用户/版主/管理员各角色读写矩阵）。
- GitHub Actions：每个 PR 跑全部测试；Vercel 预览；主分支才上线。

## 3. 任务清单

### P0 准备
- [x] T0.1 现状体检与内容提取（AZ_DATA → JSON）
- [x] T0.2 PR #1：移除假 Turnstile、安全头、Supabase 保活
- [ ] T0.3 拿到数据库现有结构与 RLS（需 Supabase 访问）

### P1 静态站骨架（v2 分支）——2026-10-24 完成，PR 见 v2/astro
- [x] T1.1 Astro + TS 项目、目录规范、ESLint/Prettier（Astro 5.18 + @astrojs/vercel 8，static 输出，`trailingSlash: always`）
- [x] T1.2 设计令牌与基础组件（导航、毛玻璃、卡片、按钮、分段控件、底部 Tab、暗色）
- [x] T1.3 内容集合 schema + 迁移脚本（8 应用、9 游戏、12 文章、12 作品）
- [x] T1.4 全部内容页：首页、列表、详情、标签、归档、搜索（论坛/评论为只读 island）
- [x] T1.5 补齐页面：关于、联系、隐私、条款、编辑规范、更新日志、路线图、404（初稿，待站长审阅）
- [x] T1.6 SEO：meta、canonical、OG 图、JSON-LD、sitemap、RSS、robots（OG：文章用现有 og/*.png；应用/游戏/作品在构建期把 SVG 素材栅格化为 PNG；其余页用站点默认图。带标题文字的 OG 卡片留到 P5）
- [x] T1.7 旧 hash 链接跳转、PWA 与离线外壳（含旧 az-sw.js 自毁替身）
- [x] T1.8 测试：Vitest + Playwright 多端 + axe + Lighthouse 预算 + CI

### P2 数据层与账户
- [x] T2.1 `db/migrations` 标准化建表（兼容现有表）+ 索引（0001 baseline 精确还原生产结构，0002–0008 增量迁移；生产执行待站长批准，顺序见 §4）
- [x] T2.2 RLS 全量审计与重写 + 角色矩阵测试（tests/db/rls-matrix，CI db 任务，PostgREST 重放 V72 请求）
- [x] T2.3 仓储接口 + Supabase 适配器 + 内存适配器（测试用）——Auth/Profiles/Forum/Comments/Reports/Notifications（`src/lib/data/`），内存适配器不进生产包
- [x] T2.4 登录 / 注册 / 找回密码 / 邮箱验证 / OAuth（GitHub、Google）——/login、/register、/reset-password、/settings、/auth/callback、顶栏用户菜单（OAuth 提供方需在 Supabase Dashboard 开启）
- [x] T2.5 真 Turnstile（Vercel Function 校验）+ 限流——/api/auth/[action]；可选 before-user-created 钩子（0007，上线切换时启用）

### P3 论坛与评论——2026-10-24 完成（v2/astro）
- [x] T3.1 论坛列表、分类、主题页——种子主题 SSG 可收录；数据库主题 `/forum/t/?id=` 静态外壳 + 客户端渲染（SEO 标签 / JSON-LD 由脚本写入）+ `/forum/sitemap-threads.xml`（Vercel Function，CDN 缓存 1h）；列表「社区主题」区游标分页（加载更多）、置顶在前（方案见 §4）
- [x] T3.2 发帖/回帖编辑器（工具栏、快捷键、实时预览、字数与数据库约束一致、localStorage 草稿）、Markdown 双重净化（先转义的白名单渲染器 + DOMPurify）。**图片上传（Storage）未做，留到 P4/P5**
- [x] T3.3 点赞、置顶/锁定/精华/隐藏（版主；种子主题可锁定）、举报（原因选择 → reports）、删除（作者/版主）、编辑（edited_at 显示「已编辑」）
- [x] T3.4 通知页 `/notifications/`（回复我的主题、举报结果、版主操作）+ 顶栏未读角标；收藏 `/bookmarks/`。@提及与浏览历史未做（可选，留到 P4）
- [x] T3.5 文章/应用/游戏/作品评论区统一组件（page_key 与 V72 一致，同一编辑器）
- [x] T3.6 论坛搜索（0008：pg_trgm GIN 索引 + `search_threads` RPC，中文子串；旧库自动退回 ILIKE）；`/search/` 同时显示站内索引与社区主题
- [x] 个人主页 `/u/?id=`（昵称、角色、加入时间、发过的主题分页、举报用户）
- [x] 限流（PT429 / HTTP 429）按数据库给出的 detail 显示中文「每 N 分钟最多 M 次」
- [x] 测试：Vitest（净化器 32 例 XSS/语法、编辑器、仓储契约）、DB（0008 搜索/计数 RPC、PostgREST 适配器 P3 读写与旧库降级）、Playwright 社区流程连真实 Postgres + PostgREST（3 引擎 × 桌面/iPhone）

### P4 管理后台
- [ ] T4.1 后台框架与权限守卫
- [ ] T4.2 仪表盘统计
- [ ] T4.3 内容 CRUD + 草稿/发布 + 触发重建
- [ ] T4.4 论坛/评论审核、举报队列
- [ ] T4.5 用户与角色、封禁
- [ ] T4.6 站点设置、导入导出、审计日志

### P5 上线与交付
- [ ] T5.1 全量回归（所有端、所有角色）
- [ ] T5.2 性能与 SEO 最终验收（Lighthouse ≥ 95）
- [ ] T5.3 数据库备份 Action（pg_dump）与迁移手册（换库步骤）
- [ ] T5.4 运维文档、管理员手册、交付清单
- [ ] T5.5 切换生产、提交 sitemap 到 Google / Bing / 百度

## 4. P3 设计说明与上线顺序

### 动态页面方案：静态外壳 + 客户端渲染（而不是按需 SSR）

- **种子主题**（站点预置的 7 个）照旧 SSG：`/forum/t/t-xxx/`，正文与预置回复在 HTML 里，零 JS 可读、可收录。
- **数据库主题**：`/forum/t/?id=<uuid>` 是一个静态外壳页，island 从 Supabase 读取后渲染，并写入
  `<title>` / description / canonical（含 `?id=`）/ OG / `DiscussionForumPosting` JSON-LD；不存在或被隐藏时追加 `noindex`。
  `/forum/sitemap-threads.xml`（Vercel Function，`s-maxage=3600, stale-while-revalidate`）列出全部已发布主题，供搜索引擎发现；
  Google 会执行 JS 渲染这类页面。
- 为什么不用 `prerender = false` 的按需渲染：
  1. 全站是 static 输出 + CDN，论坛页一旦走函数，每次访问都多一次冷启动和一次服务端到 Supabase 的往返，首屏反而变慢；
  2. 生产库在 v2 上线前仍是旧结构，Vercel 预览直连生产库，服务端渲染要同时兼容两套结构，失败时整页 500，而客户端 island 失败只降级为只读提示；
  3. 测试链（静态服务器 + Playwright + Lighthouse）能完整覆盖静态外壳；SSR 路由在本地/CI 没有等价运行时。
- 以后用户主题量大、需要更强收录时，可把 `/forum/t/[id]` 改成 ISR（Vercel `isr: { expiration }`），仓储层与渲染组件可直接复用。

### 列表与分页
- 论坛首页/分类页：站点主题静态在上，「社区主题」区预留骨架高度（不推动上方内容），置顶在前，其余 `created_at desc, id desc` keyset 游标分页；
  回复 `created_at asc, id asc` 游标分页（每页 30）；回复数用 `thread_reply_counts` RPC 一次取回。

### 生产数据库执行顺序（站长批准后，在 Supabase SQL 编辑器按顺序执行；每个文件可重复执行）
1. `db/shim/supabase.sql`（只做存在性检查）
2. `0002_roles_columns.sql` → `0003_social_tables.sql` → `0004_functions_triggers.sql` → `0005_privileges.sql` → `0006_rls.sql`
3. `0007_signup_guard.sql`（钩子默认不生效；v2 切换时再写入密钥并在 Dashboard 启用）
4. `0008_forum_search.sql`（P3：pg_trgm 扩展 + 三元组索引 + `search_threads` / `thread_reply_counts` RPC；纯增量，V72 不受影响）

（`0001_baseline.sql` 是生产现状的精确还原，只用于本地/CI 建库，**不要**在生产执行。）

