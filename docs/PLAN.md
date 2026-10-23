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
- [x] T1.6 SEO：meta、canonical、OG 图、JSON-LD、sitemap、RSS、robots（OG：文章用现有 og/*.png，游戏/作品用其 SVG 图，其余用站点默认图；带文字的构建期 OG 图生成留到 P5）
- [x] T1.7 旧 hash 链接跳转、PWA 与离线外壳（含旧 az-sw.js 自毁替身）
- [x] T1.8 测试：Vitest + Playwright 多端 + axe + Lighthouse 预算 + CI

### P2 数据层与账户
- [ ] T2.1 `db/migrations` 标准化建表（兼容现有表）+ 索引
- [ ] T2.2 RLS 全量审计与重写 + 角色矩阵测试
- [ ] T2.3 仓储接口 + Supabase 适配器 + 内存适配器（测试用）——只读部分已在 P1 完成（`src/lib/data/`），写入与 AuthProvider/UserRepo 待做
- [ ] T2.4 登录 / 注册 / 找回密码 / 邮箱验证 / OAuth（GitHub、Google）
- [ ] T2.5 真 Turnstile（Vercel Function 校验）+ 限流

### P3 论坛与评论
- [ ] T3.1 论坛列表、分类、主题页（服务端渲染 + 缓存，可被收录）
- [ ] T3.2 发帖/回帖编辑器、Markdown 净化、图片上传（Storage）
- [ ] T3.3 点赞、置顶/锁定/精华、举报、软删除
- [ ] T3.4 通知（回复、@提及）、收藏、浏览历史
- [ ] T3.5 文章/作品/游戏评论区统一组件
- [ ] T3.6 论坛搜索（pg_trgm）

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
