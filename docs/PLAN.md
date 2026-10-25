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

### P4 管理后台——2026-10-24 完成（v2/astro）
- [x] T4.1 后台框架与权限守卫——`/admin/*` 8 个页面（noindex、robots Disallow），侧栏导航（iPad / 手机为横向分段导航），客户端权限门只管体验，权限由 RLS + 0009 RPC 强制；版主看到概览 / 举报 / 内容 / 用户 / 官方内容，管理员另有审计 / 设置 / 导入导出
- [x] T4.2 仪表盘统计——`admin_stats()`：用户 / 主题 / 回复 / 评论（含隐藏数）/ 待处理举报 / 近 7、30 天注册 / 封禁数；30 天注册与发帖柱状图（原生 SVG，无图表库，附可访问数据表）
- [x] T4.3 内容管理——**范围调整**：官方内容留在 Git / Markdown（不做 CMS 写入，改动走 PR 与预览站，合并后 Vercel 自动重建）；后台「官方内容」只读清单链接 GitHub 编辑页与历史。用户内容（主题 / 回复 / 评论）表格：搜索、分类 / 隐藏 / 被举报 / 作者筛选、分页、隐藏 / 恢复 / 删除、置顶 / 精华 / 锁定、批量操作
- [x] T4.4 举报队列——状态筛选（待处理 / 已处理 / 已驳回）、目标预览、单条与批量处理（隐藏 / 锁定 / 警告 / 封禁 N 天 / 驳回 + 处理说明，`mod_handle_reports()` 一个事务完成并写审计）
- [x] T4.5 用户与角色、封禁——列表 / 搜索（管理员可搜邮箱）、详情页（资料、他的内容、封禁记录）、改角色（仅管理员，`admin_set_user`，不能改自己）、封禁 / 解封（原因 + 到期时间，`user_bans`，到期立即失效）、警告（站内通知）；版主只能封禁普通用户
- [x] T4.6 站点设置（公告条、注册开关、论坛分类启用 / 顺序、限流只读展示）、导入导出（UGC JSON / CSV 不含邮箱；设置 JSON 导入导出）、审计日志（筛选 + CSV）；备份方案见 `docs/BACKUP.md`
- [x] @提及：回复 / 评论里的 `@昵称` → `mention` 通知（最长前缀匹配，重名不通知，每条最多 5 人）
- [x] 编辑器图片上传（Supabase Storage）——P4 未做（本地 / CI 没有 storage-api），已在 P5 完成（0010，见下）

### P5 上线与交付——2026-10-24 开发侧完成（v2/astro，PR #2）；切换生产由站长执行
- [x] 编辑器图片上传——0010：Supabase Storage 公开读桶 `ugc-images`（2 MB，jpeg/png/webp/gif）+ 存储 RLS（只能传到自己的 `<uid>/` 目录、文件名白名单、10 分钟 10 张 / 24 小时 50 张限流、本人或版主删除）；编辑器工具栏选图 / 粘贴 / 拖入，客户端缩到最长边 1600 并转 WebP，填写替代文字（默认取文件名）；渲染与净化只放行本站桶的图。本地 / CI 用 `db/shim/plain.sql` 的 Storage 替身测 RLS，E2E 模拟 storage-api；**真实 Storage 需在 Vercel 预览上人工验证一次**（ACCEPTANCE 2.10）
- [x] 0011：停用的论坛分类在数据库层拦截新主题 / 移入（版主除外，V72 兼容）
- [x] T5.1 全量回归（所有端、所有角色）——角色矩阵 E2E（匿名 / 用户 / 被封禁 / 版主 / 管理员 × 3 引擎 × 4 视口）、图片上传 E2E、安全 E2E；CI 的 E2E 每个引擎分 2 片
- [x] T5.2 性能与 SEO 最终验收（Lighthouse ≥ 95）——16 个页面移动端性能 / 无障碍 / 最佳实践 ≥ 95、可收录页面 SEO ≥ 95（noindex 页面不计 SEO）、LCP < 2.0 s、CLS < 0.05；严格 CSP（内联脚本哈希，`scripts/check-csp.mjs` 校验构建产物与线上）
- [x] T5.3 数据库备份 Action（pg_dump，每周一 03:30 北京时间，产物保留 30 天，可选 gpg 加密）、恢复脚本与每次 CI 的恢复演练、迁移状态核对 `db/verify/status.sql`、迁移手册（docs/MIGRATION.md、PORTABILITY.md）
- [x] T5.4 运维文档、管理员手册、交付清单——docs/ACCEPTANCE.md、DEPLOY.md、CONFIG.md、OPERATIONS.md、BACKUP.md、README
- [ ] T5.5 切换生产、提交 sitemap 到 Google / Bing / 百度——**站长执行**，步骤见 docs/MIGRATION.md（顺序见下方 §4）

---

## 3A. 产品方向调整（站长，2026-10-24）

站点从「作品档案站」升级为：**个人应用商店**（全部应用上架、用户下载、访客互动、完整 App Store 式设计）+ **个人综合站**（产品、文章、游戏、视频、软件、AI 工具、论坛、留言板），用 **Google AdSense** 变现。

v2 原则不变：

- **只用真实数据**：不伪造评分、下载量、评论；没有数据就显示「暂无」。下载数来自真实计数（Supabase RPC），评分来自真实用户评价。
- **静态优先**：内容页全部 SSG，交互用按需加载的 island。
- **Lighthouse ≥ 90**：接入广告前保持现有 ≥ 95；广告上线后性能分允许降到 ≥ 90，无障碍 / 最佳实践 / SEO 仍 ≥ 95。
- **无障碍、安全**：axe 无违规、严格 CSP（广告域名单独白名单）、权限全部在数据库层。
- **下载安全**：第三方软件只链官方 / 商店 / GitHub Release，不自行托管再分发；自研软件直链必须附 SHA-256；下载按钮附近不放广告。

### P6 应用商店核心
- [x] T6.1 应用数据模型升级——真实图标图片、副标题、开发者 {name, url, self | third-party}、分类 + 标签、`platforms[]`（每项 {os: ios | android | windows | macos | linux | web | cli | browser-ext | ai-bot | mcp, version, size, minOS / requirements, linkType: direct | official | store | github | web, url, sha256?, arch?}）、`screenshots[]`（按设备尺寸）、价格 / 许可 / 是否开源、官网 / 源码仓库、隐私说明、按版本的更新日志、FAQ、featured 推荐标记、releaseDate / updated
- [x] T6.2 App Store 风格详情页——头部（图标 + 名称 + 开发者 + 评分 + 下载按钮，自动识别访客平台）、截图轮播 + 灯箱、介绍、新功能（What's New）、信息表、版本历史、相关应用、评价
- [x] T6.3 下载中转 `/go/[app]/[platform]/`——外链提示中间页、SHA-256、真实下载计数（Supabase RPC）、限流、过滤爬虫、按钮附近不放广告
- [x] T6.4 评分与评论——迁移 0012：`app_reviews`（1–5 星 + 文字，每人每个应用一条，RLS，复用举报 / 审核）、聚合视图、`app_download_counts` 表 + 计数 RPC
- [x] T6.5 应用目录——按平台 / 分类 / 价格筛选，按热门 / 最新 / 评分排序，静态分页 `/apps/page/2/`，分类与平台落地页
- [x] T6.6 AI 工具栏目 `/ai/`——AI Agent、Vibe Coding、CLI、AI Bot、MCP；瀑布流卡片；只链官方地址（2026-10-25：内容集合 `tools` 30 个工具，原创介绍 + 逐个核对官网；分类页 `/ai/category/<分类>/`、价格 / 开源筛选；详情页与应用共用布局、评价与 `/go/` 计数；迁移 0013 让讨论区挂在 `tool:<slug>`）。同日按站长授权补齐 8 个自研应用的图标家族、概念图截图与默认档案，下载按钮改为「即将推出 + 上线通知」
- [x] T6.7 视频栏目 `/videos/`——B 站 / YouTube 轻量嵌入（点击才加载播放器的 facade，保证性能）（2026-10-25：内容集合 `videos` 24 个官方频道视频，逐个用 oEmbed 核对标题 / 频道 / 可嵌入，发布时间取自频道 RSS、时长取自频道 / 播放列表页，查不到就不写，不显示播放量；原创中文导读 + 要点 + 作者给出的章节；分类页 `/videos/category/<分类>/`、时长 / 频道筛选写进查询串；详情页隐私 facade——本地 AVIF / WebP 缩略图，点击前不向视频平台发任何请求，点击后才插入 youtube-nocookie.com 播放器；CSP frame-src 只加 youtube-nocookie.com；VideoObject / Clip / ItemList / 面包屑；迁移 0014 让讨论区挂在 `video:<slug>`。仓库与 V72 数据里没有站长本人的视频或频道，「我的视频」区暂不显示，见 CONTENT.md §6B）
- [x] T6.8 首页改版——轮播 Hero、搜索 + 热门词、平台快捷入口、编辑推荐、热门应用、排行榜、AI 工具、游戏、最新文章、视频、社区动态、最新留言、友情链接（2026-10-25：首页改成应用商店 + 内容门户，只用内容集合里的真实数据，`src/lib/home.ts` 整理、Vitest 覆盖；区块：hero（价值说明 + 搜索框 + Ctrl/⌘K + 「试试」示例词 + 平台 / AI 分类快捷入口，附真实数量）→ 编辑精选（featured 的自研应用 + AI 工具，横向轮播）→ 自研应用 → AI 工具（按编辑顺序，如实标注「暂无足够真实下载数据，不做热度排行」）→ 最近更新（档案里的更新日期）→ 分类浏览（真实数量）→ 精选视频 → 游戏 → 最新文章 → 作品 → 论坛最新话题 → 关于作者 / RSS 订阅。没有数据的区块整块不渲染：「最新上架」（还没有应用写 `releaseDate`）、iOS / Android / macOS / Linux 平台入口（没有自研应用、目录页不生成）。不做「热门词」（没有真实搜索统计，改为示例词）、「排行榜」（没有真实下载 / 评分数据）、「最新留言」「友情链接」（T7.3 / T7.4 之后再接）。横向行 scroll-snap + 上一组 / 下一组按钮（溢出才显示、到头禁用、aria-controls、减少动态效果时不平滑滚动）；首页只有一个小模块脚本，无框架 island；图片全部懒加载（AVIF / WebP），首屏 LCP 是文字；结构化数据 WebSite + SearchAction、Person、Organization、编辑精选 ItemList）
- [x] T6.9 视觉升级——图标体系、渐变封面、卡片动效、App Store 式排版（2026-10-25：色相扩到 6 个（新增 purple，FableMotion / 职业技能树改用紫色，Claude / Claude Code 用橙色；AI 工具可选 `hue`，默认跟随主分类）；纯 CSS 渐变封面——应用 / 工具卡片一角柔光、游戏 / 作品卡片图片底色 + 正文淡色、详情页头部横幅，不新增图片；统一卡片动效：悬停上浮 2px + 阴影 + 图标放大 1.06 / 封面图 1.03，只用 transform / box-shadow（CLS 0），只在 `hover: hover` 设备上，减少动态效果时关闭；键盘焦点环（深色模式改为更亮的链接色）；所有卡片 / 列表图标改用 AVIF + WebP 1x / 2x `<picture>` 并带宽高（含目录浏览器端渲染的卡片）；首页图标墙按链接 / 文件 / 品牌 / 图片内容去重（不再出现两个 OpenAI 标志），「试试」改为动画编辑器 / Cursor / 塔防 / MCP（应用副标题进入站内搜索）；空状态统一 `.empty-state`，区块标题字号统一）
- [x] T6.10 结构化数据——SoftwareApplication / MobileApplication / VideoGame / VideoObject / Article / BreadcrumbList（2026-10-25：每页 WebSite + SearchAction、Organization（logo）、Person；除首页 / 404 / 离线页外每页 BreadcrumbList（≥ 2 项、末项 = 本页，修了后台用户详情与登录回跳两页）；SoftwareApplication 的 offers 只在价格明确时写（免费 0、付费可解析金额），aggregateRating 只接受构建期真实评价（条数 ≥ 1，当前没有 → 不写）；VideoGame 补 operatingSystem / applicationCategory；BlogPosting 作者内联姓名、publisher = Organization；/apps/、/games/、/articles/、/works/ 补 ItemList。没有自研移动应用，暂不输出 MobileApplication。`npm run test:ld` 解析构建产物逐页校验必填字段并保证没有评分 / 计数，CI build 任务在构建后运行）

P6 完成（2026-10-25）。

### P7 社区与体验
- [x] T7.1 Ctrl+K 即时搜索（Pagefind）（2026-10-25：构建后 `scripts/pagefind.mjs` 只索引内容详情页——应用 / AI 工具 / 视频 / 游戏 / 文章 / 作品 / 论坛种子主题，共 103 页，Pagefind extended 中文分词；全站 Ctrl/⌘K 与导航搜索按钮打开原生 `<dialog>` 面板（combobox + listbox，↑↓ / Enter / Esc），面板与 Pagefind 只在第一次打开时下载（约 92 KB，预算 120 KB）；`/search/` 也用它，拼音首字母仍由站内 JSON 索引补上；WASM 在 Pagefind 自己的 Worker 里运行，`'wasm-unsafe-eval'` 只放在 `/pagefind/` 的响应 CSP 上，页面 CSP 不变）
- [x] T7.2 标签云（2026-10-25：`/tags/` 汇总应用 / AI 工具 / 视频 / 文章的全部标签，数量为真实条目数，字号按对数 5 档且数量同时显示、可访问名称含数量；`/tags/<标签>/` 按类型分组；只有 1 个条目的标签页 noindex 且不进 sitemap；全部标签在 `src/lib/tags.ts` 登记中文 / 品牌名，单元测试检查）
- [x] T7.3 访客留言板 `/guestbook/`（允许匿名，需 Turnstile；审核；迁移 0015——0014 已用于 T6.7 视频页评论）（2026-10-25：昵称 + 留言，Turnstile 服务端校验后由 `/api/submit/guestbook` 签发 HMAC 票据，数据库 RPC 核对票据 / 一次性 / 限流后写入 pending；公开只读 approved；后台 `/admin/guestbook/` 版主 / 管理员通过、拒绝、退回、删除，写审计；登录用户不自动通过（规格未要求）。生产需配置 `COMMUNITY_TICKET_SECRET`，见 MIGRATION.md §5D）
- [x] T7.4 SNS 图标与友链页 `/links/`（含友链申请表单）（2026-10-25：作者账号只显示能核实的——GitHub `azsou`（本仓库所有者）与本站 RSS；B 站 / YouTube 找不到地址，整项隐藏（`src/data/social.json`）；Person.sameAs 同步；友链申请与留言同一套 Turnstile + 票据，存 0015 的 `friend_links`（同一迁移，见 MIGRATION.md §5D），联系方式只有管理员可见，`/admin/links/` 仅管理员审核）
- [x] T7.5 主题跟随系统 + 手动切换（2026-10-25：导航按钮在 跟随系统 → 浅色 → 深色 间切换，存 localStorage `az-theme`，跨标签页同步；`<head>` 内联脚本首帧前写入 `data-theme`（CSP 哈希），无闪烁；深色变量 = 系统深色且未手动选浅色，或手动深色；theme-color 同步）
- [x] T7.6 中英双语 `/en/`（2026-10-25：Astro i18n，中文默认在根路径、英文在 `/en/`；只有写了英文文案的条目才有英文页（内容集合新增可选 `en` 字段：8 个应用、30 个 AI 工具、24 个视频、9 个游戏全部人工翻译副标题 / 简介，正文仍是中文，英文详情页明确链接「阅读中文版」）；英文首页、应用、AI 工具、视频、游戏列表与详情，文章只列标题并标「Chinese only」链接中文原文（不机翻）；`<html lang>`、hreflang zh-CN / en / x-default（= 中文）、og:locale、保留路径的语言切换（没有英文版的页面切到 `/en/`）、英文导航 / 页脚 / 面包屑 / 搜索面板；每页 WebPage.inLanguage，英文详情的 SoftwareApplication / VideoGame 写 inLanguage en；sitemap 用 xhtml:link 互相标注；Pagefind 按 `<html lang>` 自动分中英两套索引，英文页只搜英文，各自 ≤ 120 KB；英文 RSS `/en/rss.xml`）
- [x] T7.7 可视化内容后台（2026-10-25：选 **Decap CMS**，不用 Keystatic——Keystatic 需要 React + 按需渲染的 `/keystatic` 与 `/api/keystatic` 路由（本地 / CI 的静态测试链没有等价运行时），而且只能把 frontmatter 写成 YAML，会把仓库现有的 JSON frontmatter 全部改写；Decap 是纯静态单页，`format: json-frontmatter` 原样读写。`/cms/`：应用 / AI 工具 / 文章三个集合，字段与 zod schema 对应（单元测试检查选项一致、现有字段都声明了，保存不丢字段）；GitHub 存储 `azsou/azsou-site` + 编辑工作流（每次保存开 PR，CI 通过后站长合并）；本地 `npx decap-server` 直接读写文件；登录经 `/api/cms/auth` → GitHub OAuth App（`CMS_GITHUB_CLIENT_ID` / `CMS_GITHUB_CLIENT_SECRET`，未配置 503），state Cookie 防 CSRF，回调页 nonce 脚本只向同源 postMessage；Decap 3.17.1 从 jsDelivr 加载并带 SRI；`/cms/` 单独一条 CSP（Decap 的 schema 校验要 `'unsafe-eval'`，只放在这一条上），全站 CSP 不变；noindex + X-Robots-Tag + robots Disallow，不进 sitemap / Pagefind / 逐页检查）
- [x] T7.8 邮件 / RSS 订阅（2026-10-25：新增 `/apps/rss.xml`、`/videos/rss.xml`、`/en/rss.xml` 与 JSON Feed 1.1 `/feed.json`（原有全站 / 文章 / 论坛 RSS 保留）；`/subscribe/` 与 `/en/subscribe/`：邮件订阅（双重确认）+ 全部订阅源；迁移 0016（`subscribers`，任何角色都不能直接读写，不存明文令牌，限流，确认 48 小时有效，退订幂等）；Vercel Function `/api/subscribe`：Turnstile + 与留言板同一套票据，发信抽象 Resend / SMTP（`EMAIL_PROVIDER`、`EMAIL_FROM`、`RESEND_API_KEY` 或 `SMTP_*`），**没配置就 503，不写库不发信**；CI 与 E2E 用内存发信器，从不真的发信；确认 / 退订页（中英，noindex，点按钮才执行）；后台 `/admin/subscribers/` 只显示数量，没有导出邮箱的接口）

P7 完成（2026-10-25）。生产还需：执行 0016、配置发信服务与 CMS 的 GitHub OAuth App（DEPLOY.md §2A / §2B）。

### P8 AdSense 变现
- [x] T8.1 清理所有占位内容 + 25–30 篇原创文章计划（docs/CONTENT-PLAN.md：28 篇计划 + 薄页面清单；已发布 3 篇原创长文）
- [x] T8.2 隐私政策 / Cookie / 广告条款、关于、联系页补全（中英文各一份，页脚可达，注明最后更新日期）
- [x] T8.3 `ads.txt` + AdSense 加载器 + CSP 白名单 + `AdSlot` 组件（预留尺寸，CLS 0）；位置：文内 / 侧栏 / 列表间；永远不靠近下载按钮；由环境变量 `PUBLIC_ADSENSE_CLIENT` 控制开关（默认关闭；广告开启变体在 CI 构建并测试）
- [x] T8.4 Google 认证 CMP（AdSense「隐私和消息」）+ Consent Mode v2（代码就位；「隐私和消息」消息需站长在 AdSense 后台发布，见 docs/ADSENSE.md §4）
- [ ] T8.5 Search Console / GA4 + 提交站点地图 —— 代码已完成（`PUBLIC_GA4_ID` / `PUBLIC_GSC_VERIFICATION`）；验证与提交站点地图待站长（docs/ADSENSE.md §2–3）
- [ ] T8.6 申请 AdSense —— 待站长：先满足 docs/ADSENSE.md §0（生产上线、≥ 25 篇长文）
- [x] T8.7 联盟链接 / 赞助（`sponsoredLinks` / `disclosure` 字段、披露标识、赞助位组件默认关闭，没有任何赞助方）

### P9 设计系统与商业化视觉（2026-10-25 审计后新增）

依据：[DESIGN-AUDIT.md](./DESIGN-AUDIT.md)（现状评分 5.3/10、P0×7 / P1×12 / P2×8）、[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)（统一标准）、[DESIGN-QA.md](./DESIGN-QA.md)（门禁）。
顺序：token → 图标 / 图片管线 → 组件 → 页面 → 后台 / CMS → QA 门禁（QA 的基础设施 T9.2 提前，每个任务都带回归截图）。估时按 1 人日 = 6 小时有效编码。
外包并行（不阻塞代码）：T9.0 品牌与自研图标 / 游戏封面。

- [ ] **T9.0 外包：品牌与图标资源**（站长决定，可并行）——Logo 精修、品牌色确认、8 个自研应用图标 Figma 源文件、9 个游戏封面 16:9、OG 模板。验收：交付 1024 PNG + SVG/Figma 源，通过 T9.3 资源检查。依赖：无。估时：外部 1–2 周。
- [ ] **T9.1 设计 token 单一来源**——`tokens/*.json`（Style Dictionary 4）生成 `src/styles/tokens.css` / `src/lib/tokens.ts` / `public/cms/preview.css`；字阶 9 档（固定 px + zh/en 行高）、字重 3 档、色彩角色、间距 13 档、圆角 5 档、阴影 3 档、动效 4 档、z-index 7 档、断点 3 个；旧变量做别名过渡。验收：生成文件与 DESIGN-SYSTEM §2–5 数值一致（单测）；现有页面视觉差异只来自刻意调整（截图对比附 PR）；Lighthouse / axe 不回退。依赖：无。估时：1.5 天。
- [ ] **T9.2 QA 基础设施**——stylelint（Q1，先 warn）+ `tests/design/`（Q5 溢出 / 截断 / 单字断行、Q7 触控、Q8 排版统计、Q9 列数）+ Playwright 视觉回归（Q2，Docker 基线，51 页 × 4 宽 × 2 主题，Chromium）+ `/_kit/` 组件目录页（dev / preview 构建，noindex）。验收：CI 新增 design 任务；基线生成；当前已知问题以 `test.fixme` 登记并链接到对应 T9.x。依赖：T9.1。估时：2 天。
- [ ] **T9.3 图标规范化管线**——`scripts/design/normalize-icons.mjs`（sharp）：去底、底色分类（colored / light / transparent / dark-glyph）、主体缩放到安全区 72%、深色变体、输出 32/40/56/72/112 ×1/×2 AVIF+WebP + `icon-manifest.json`；`AppIcon` 改 5 档尺寸 + squircle 遮罩 + 垫板 / 描边；Monogram 规则（单字 / 首字母、hue 底）；`check-assets`（Q4）。验收：30 个第三方 + 8 个自研图标主体占比全部落在 68%–76%（插画型除外）；深色模式无白块；首页 / 列表无「EM」「地牢」；Q4 进 CI 阻断。依赖：T9.1。估时：2.5 天。
- [ ] **T9.4 封面 / 缩略图规范**——游戏封面统一 16:9、作品 4:3、文章 2:1；缺图用 hue 渐变 + 图标；`aspect-ratio` 固定、尺寸与体积预算（Q4）。验收：所有媒体卡比例统一、无拉伸；单张 400w ≤ 120 KB；缺图不出现空白或文字。依赖：T9.3（T9.0 交付后替换游戏封面）。估时：1 天。
- [ ] **T9.5 内容 schema 字数规格**——`zhLength()`；apps/tools 新增 `tagline`（6–16）、`developer.short`（≤ 12），`summary` 32–56，视频标题 ≤ 34（原题存 `originalTitle`）、文章标题 ≤ 36；改写现有 8 应用 + 30 工具 + 超长视频 / 文章标题（中英两份）；CMS 字段 hint / pattern / 字数 widget 同步。验收：`astro check` 字数校验通过；Q5 卡片截断 0 处（当前 62 处）；cms.test 一致性通过。依赖：T9.1。估时：2 天（含文案改写）。
- [ ] **T9.6 基础组件重构**——`Button`（主 / 次 / 文字 / 图标，五态 + loading）、`Chip`（筛选 / 标签 / 计数徽标）、`SectionHeader`、`PageHead`、`SegmentedControl`、`Select/Listbox`（替代原生 select 外观）、`EmptyState`、`Skeleton`、`Badge`（状态 4 色）、UI 图标统一线宽。验收：`/_kit/` 每个组件 × 五态 × 深浅色有截图基线；Q7 触控、Q8 排版通过；全站无 650/750/800 字重、无 10/11px 文字。依赖：T9.1、T9.2。估时：2.5 天。
- [ ] **T9.7 卡片家族与栅格**——行卡 / 磁贴 / 精选卡 / AI 工具卡 / 媒体卡 / 更新行 / 分类卡按 DESIGN-SYSTEM §10 解剖重写；统一栅格（`--cols` 断点表、等高）；整卡点击 + 单一 CTA（「获取 / 打开」）；hover 1.04 / pressed 0.98。验收：Q9 列数与等高通过；每种卡片高度固定或网格内等高（差 ≤ 1px）；悬停 CLS 0；中英列表列数一致。依赖：T9.3、T9.5、T9.6。估时：3 天。
- [ ] **T9.8 货架（轮播）组件**——整数张 + 48px peek、隐藏原生滚动条、边缘渐隐（到头不渐隐）、按钮禁用态、键盘聚焦滚入视图、减少动态。验收：Windows Chrome 无灰色滚动条（手动 + `scrollbar-width` 断言）；Q5 货架整数张检测通过；键盘可走完一行。依赖：T9.7。估时：1 天。
- [ ] **T9.9 导航与响应式骨架**——断点收敛为 600 / 900 / 1200 + 容器查询；导航 ≥1200 全量 / 900–1199 五项 + 更多 / <900 TabBar；`nowrap`；修复 /admin/data/、/forum/new/、回帖编辑器横向溢出；中文排版全局（`text-spacing-trim`、`text-wrap: balance/pretty`）。验收：4 宽度 × 全页面 `scrollWidth ≤ innerWidth`；768 无单字断行；CSS 中不再出现 767/599/700/960/1023 断点。依赖：T9.1。估时：1.5 天。
- [ ] **T9.10 首页改版（视觉）**——hero（H1 改文案无句中逗号、`text-wrap: balance`、「试试」改 chip、平台胶囊 ≤ 6）；编辑精选固定高 + 2 行简介 + 主按钮；AI 工具改网格（3 行 × 4 列，无横向滚动）；最近更新相对时间 + 30 天规则；分类卡单图标；区块间距 64/48。验收：DESIGN-AUDIT P0-3/P0-4/P1-2~P1-6 全部关闭；视觉回归基线更新并经站长确认；Lighthouse 移动 ≥ 95。依赖：T9.7、T9.8、T9.9。估时：2 天。
- [ ] **T9.11 列表页与详情页**——应用商店（单套筛选 + 「更多筛选」弹层、每页 24、无数据项隐藏）、AI 工具、视频、游戏、文章、作品、标签、搜索、论坛列表按统一栅格；详情页（头部 icon-xl + 主按钮、统计条只放有值项、评价空状态、截图货架、信息表 2 列）。验收：P1-7/P1-8/P1-9 关闭；全部列表页列数符合断点表；Q5/Q8/Q9 全绿。依赖：T9.7、T9.8。估时：3 天。
- [ ] **T9.12 后台 App Shell 与表格 / 表单**——独立后台外壳（侧栏 + 顶栏，无前台页脚）、统计卡等宽、数据表（52 行高、吸顶表头、「⋯」行操作、批量工具栏、摘要纯文本、窄屏卡片化）、表单规范（标签在上、字数计数、二次确认）、自定义 Listbox 筛选。验收：/admin/content/ 行高 ≤ 64px（当前 ~250）；复选框命中区 ≥ 32px；390 宽无溢出；现有 admin / roles e2e 全绿（选择器按需更新）。依赖：T9.6、T9.9。估时：3 天。
- [ ] **T9.13 CMS 体验**——`preview.css`（token 生成）+ 应用 / 工具 / 文章预览模板（复用卡片 CSS，显示截断效果）、`string-count` 字数 widget、图标预览 widget（56 / 112 + 安全区线）、字段 hint 统一。验收：test-repo 后端截图中预览与线上卡片一致；超字数保存被拦；cms.test 通过。依赖：T9.5、T9.7。估时：1.5 天。
- [ ] **T9.14 QA 门禁收紧与全站验收**——stylelint 从 warn 改 error；`test.fixme` 清零；Windows 双字重模拟截图评审；人工清单（DESIGN-QA §3）走查 1440/768/390 × 深浅；可选外部资深 UI 评审半天；更新 DESIGN-AUDIT 复评分。验收：Q1–Q10 全部阻断级通过；复评各维度 ≥ 8、综合 ≥ 8.5；改版前后对照图（contact-*.png）附 PR。依赖：T9.3–T9.13。估时：1.5 天。

合计约 **28 人日**（不含外包 T9.0）。建议分 3 个 PR：A（T9.1–T9.5 基础 + 管线）、B（T9.6–T9.11 前台）、C（T9.12–T9.14 后台 / CMS / 收尾）。

### P10 上线与运营（原 P9，2026-10-25 顺延编号）
- [ ] T10.1 生产迁移 0002 → 最新（需站长批准）+ 配置 + 切换
- [ ] T10.2 每周内容与工具版本检查
- [ ] T10.3 月度数据复盘


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

### 生产切换顺序（站长批准后执行；详细命令、验证与回滚见 docs/MIGRATION.md）
1. **备份**：Actions → DB backup 手动运行（或 `scripts/db-backup.sh`），确认拿到文件
2. `db/shim/supabase.sql`（只做存在性检查）
3. `0002_roles_columns.sql` → `0003_social_tables.sql` → `0004_functions_triggers.sql` → `0005_privileges.sql` → `0006_rls.sql`
4. `0007_signup_guard.sql`（钩子函数，**先不启用**）
5. `0008_forum_search.sql` → `0009_admin.sql` → `0010_ugc_images.sql` → `0011_forum_category_guard.sql` → `0012_app_store.sql`（P6 应用商店）→ `0013_tool_comments.sql`（AI 工具页评论）→ `0014_video_comments.sql`（视频页评论）→ `0015_guestbook.sql`（留言板 + 友链，另需写入 `community_ticket_secret`）→ `0016_subscribers.sql`（邮件订阅，双重确认）
6. 每执行完一个文件跑一次 `db/verify/status.sql`：该步及之前的行都为 true
7. 合并 PR #2（合并即上线）→ `node scripts/check-csp.mjs --url https://azsou.com`
8. 写入 `signup_ticket_secret`，在 Dashboard 启用 Before User Created 钩子，开启邮箱确认
9. 上线检查（MIGRATION.md §7）→ 提交站点地图 `sitemap-index.xml` 与 `forum/sitemap-threads.xml`（Google / Bing / 百度）

（`0001_baseline.sql` 是生产现状的精确还原，只用于本地/CI 建库，**不要**在生产执行。0002–0016 均可重复执行、向后兼容 V72。）


## 5. P4 设计说明

- **权限只在数据库**：后台页面是静态外壳，权限门（未登录 / 无权限 / 仅管理员）只决定显示什么；所有读写都经 RLS 或 `SECURITY DEFINER` RPC（入口先 `az_require_moderator()`）。版主不能改角色、不能读审计日志、不能封禁版主 / 管理员；任何人不能封禁 / 降级自己。
- **封禁**：`profiles.banned` 仍是唯一标志（V72 读它）；每次封禁在 `user_bans` 记一行（原因、到期、操作人、解除时间 / 原因）。到期后 `is_admin()` / `can_write()` / `is_moderator()` / `current_app_role()` 立即视为未封禁；后台概览打开时调用 `mod_lift_expired_bans()` 清标志并记审计（也可放进 pg_cron）。
- **审计**：内容与举报的变更由 0004 的触发器记录；0009 的 RPC 额外写 `user.ban` / `user.unban` / `user.warn` / `report.action.*`；站点设置写 `content.*`。
- **站点设置**：`site_content`（`kind='setting'`）三行：`announcement`、`registration`、`forum`。公开页面空闲时匿名读取（sessionStorage 缓存 5 分钟），读不到按默认值工作；公告条固定定位，不推动布局（CLS 0）。注册关闭时注册页收起表单、`/api/auth/signup` 返回 403，启用注册钩子后 GoTrue 直连注册（含第三方首次登录）也被拒绝。论坛分类的「停用」目前只在发帖页生效（数据库不拦截旧客户端，V72 仍可发到任意分类）。
- **导出不含邮箱**：导出只读 `profiles` 等 public 表；邮箱只在 `auth.users`，只有 `mod_list_users()` 对管理员返回（用于搜索）。
- **测试隔离**：E2E 里站点设置是全局状态，公开页面读设置默认被截成「默认设置」，只有设置用例显式读真实值，且这些用例串行、只在桌面视口跑。
