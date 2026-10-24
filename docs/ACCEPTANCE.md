# 上线验收清单（P5 + P6 应用商店）

每一项都写明**证据**（自动化测试 / CI 任务 / 文档）与**状态**。

- ✅ 已通过：有自动化测试或 CI 证据，在 PR #2 的 CI 上全绿
- 🟡 待站长：需要 Supabase / Vercel / GitHub 的管理员权限，开发侧已准备好步骤与验证方法
- ⚪ 不在本期：明确不做，原因见备注

CI：`.github/workflows/ci.yml`，每次推送到 `v2/astro` 与 PR #2 都会跑 build、db（含恢复演练）、lighthouse、e2e（3 引擎 × 2 分片）共 9 个任务。
最近一次全绿的运行见 PR #2 上的 P5 评论。

---

## 1. 代码质量与构建

| #   | 检查项                                     | 证据                                                      | 状态 |
| --- | ------------------------------------------ | --------------------------------------------------------- | ---- |
| 1.1 | ESLint + Prettier 无错误                   | CI build：`npm run lint`                                  | ✅   |
| 1.2 | TypeScript / Astro 类型检查 0 错误 0 警告  | CI build：`npm run check`（190 个文件）                   | ✅   |
| 1.3 | 单元测试                                   | CI build：`npm run test:unit`（Vitest，14 个文件 205 例） | ✅   |
| 1.4 | 构建成功，96 个路由                        | CI build：`npm run build` + `npm run size`                | ✅   |
| 1.5 | 无死链、无坏锚点                           | CI build：`npm run test:links`                            | ✅   |
| 1.6 | HTML 校验                                  | CI build：`npm run test:html`（html-validate）            | ✅   |
| 1.7 | 每页首屏 JS ≤ 50 KB（gzip）                | CI build：`npm run size`（最大 `/forum/t/` 46.2 KB）      | ✅   |
| 1.8 | CSP 内联脚本哈希与构建产物一致、安全头齐全 | CI build：`npm run test:csp`（`scripts/check-csp.mjs`）   | ✅   |

## 2. 全量回归（所有端 × 所有角色）

浏览器：Chromium / Firefox / WebKit（≈ Safari）；视口：桌面 1440、iPad 834、iPhone 390、安卓 360，共 12 个组合。
社区、后台、图片、角色用例连接真实 Postgres 17 + PostgREST 14（与生产同一大版本），不是模拟数据。

| #    | 检查项                                                                                          | 证据                                                                   | 状态 |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| 2.1  | 全部页面能打开、无控制台错误、标题 / canonical / JSON-LD 正确                                   | `tests/e2e/pages.spec.ts`、`features.spec.ts`（12 个组合）             | ✅   |
| 2.2  | 旧 hash 链接（`#/article/…`、`#project` 等）与旧路径（`/forgot-password`、`/index.html`）跳转   | `features.spec.ts`、`tests/unit/hash-redirect.test.ts`                 | ✅   |
| 2.3  | 登录 / 注册 / 找回密码 / Turnstile / 注册开关                                                   | `tests/e2e/auth.spec.ts`                                               | ✅   |
| 2.4  | 论坛：发主题、回复、编辑、删除、点赞、收藏、举报、@提及、通知、搜索、分页                       | `tests/e2e/community.spec.ts`                                          | ✅   |
| 2.5  | 角色矩阵：匿名 / 普通用户 / 被封禁 / 版主 / 管理员 × 主题页、发帖页、通知页、后台权限门与菜单   | `tests/e2e/roles.spec.ts`（12 个组合全部跑）                           | ✅   |
| 2.6  | 管理后台：概览、举报队列（单条 / 批量）、内容、用户（角色 / 封禁 / 警告）、审计、设置、导入导出 | `tests/e2e/admin.spec.ts`                                              | ✅   |
| 2.7  | 编辑器图片上传：选图压缩、粘贴、拖入、替代文字、失败提示、发布后显示                            | `tests/e2e/images.spec.ts`（Storage 接口模拟，帖子写真实库）           | ✅   |
| 2.8  | 无障碍：axe 无违规（亮色 + 暗色）                                                               | `tests/e2e/a11y.spec.ts`、`admin.spec.ts`（暗色），各用例内的 axe 检查 | ✅   |
| 2.9  | 404 状态与 noindex、离线回退页、旧 Service Worker 自毁                                          | `tests/e2e/security.spec.ts`、`features.spec.ts`                       | ✅   |
| 2.10 | 在 Vercel 预览站上人工走一遍 2.3–2.7（真实 Supabase、真实 Storage）                             | 预览地址见 PR #2 的 Vercel 评论；步骤见 MIGRATION.md §7                | 🟡   |

## 3. 数据库与权限

| #   | 检查项                                                               | 证据                                                                          | 状态 |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---- |
| 3.1 | 迁移 0002–0013 在 0001 基线（生产现状）上可执行、可重复执行          | CI db：`npm run test:db`（`tests/db/baseline.test.ts`、`regression.test.ts`） | ✅   |
| 3.2 | RLS 角色矩阵（匿名 / 用户 / 被封禁 / 版主 / 管理员 × 每张表的读写）  | `tests/db/rls-matrix.test.ts`（96 例），结果表作为 CI 产物 `rls-matrix` 上传  | ✅   |
| 3.3 | V72 旧前端的全部请求在迁移后仍可用                                   | `tests/db/postgrest-v72.test.ts`（PostgREST 14 重放）                         | ✅   |
| 3.4 | 图片存储 RLS：只能传到自己的目录、2 MB、类型、文件名、限流、删除权限 | `tests/db/p5.test.ts`（0010，含「没有 Storage 的纯 Postgres」场景）           | ✅   |
| 3.5 | 停用的论坛分类在数据库层拦截（版主除外）                             | `tests/db/p5.test.ts`（0011）                                                 | ✅   |
| 3.6 | 迁移状态核对脚本 `db/verify/status.sql` 逐步正确                     | `tests/db/verify.test.ts`（逐个迁移执行后核对）                               | ✅   |
| 3.7 | 生产库执行迁移（顺序见下方第 7 节）                                  | MIGRATION.md；2026-10-24 只读核对：17 项全部为 `false`（尚未执行）            | 🟡   |

## 4. 安全

| #   | 检查项                                                                                 | 证据                                                                       | 状态 |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---- |
| 4.1 | 严格 CSP（脚本只允许自身 + 哈希，禁止 `unsafe-inline` 脚本）、HSTS、X-Frame-Options 等 | `vercel.json`；`npm run test:csp`；`security.spec.ts`（无拦截 + 注入被拦） | ✅   |
| 4.2 | 用户内容先转义再渲染 + DOMPurify 二次净化；图片只允许本站 `ugc-images` 桶              | `tests/unit/markdown.test.ts`、`images.test.ts`                            | ✅   |
| 4.3 | 限流（发帖 / 回复 / 举报 / 上传）由数据库强制，前端显示中文提示                        | `tests/db/regression.test.ts`、`p5.test.ts`、`community.spec.ts`           | ✅   |
| 4.4 | 注册钩子（0007）：只放行带票据的注册；关闭注册开关后直连 GoTrue 也被拒                 | `tests/db/signup-hook.test.ts`、`admin.test.ts`（注册开关）                | ✅   |
| 4.5 | 上线后线上响应头与 `vercel.json` 一致                                                  | `node scripts/check-csp.mjs --url https://azsou.com`（MIGRATION.md §6）    | 🟡   |
| 4.6 | 启用 Before User Created 钩子、开启邮箱确认                                            | MIGRATION.md §6                                                            | 🟡   |

## 5. 性能与 SEO

| #   | 检查项                                                                                                                                              | 证据                                                                   | 状态 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| 5.1 | Lighthouse 移动端（慢速 4G + 4× CPU）16 个页面：性能 / 无障碍 / 最佳实践 ≥ 95；可收录页面 SEO ≥ 95（发帖 / 搜索 / 登录 / 404 为 noindex，SEO 不计） | CI lighthouse（`lighthouserc.cjs`，每页 3 次取中位数），报告为 CI 产物 | ✅   |
| 5.2 | LCP < 2.0 s、CLS < 0.05（同上，逐页断言）                                                                                                           | 同上                                                                   | ✅   |
| 5.3 | 每页独立 title / description / canonical、OG 图、JSON-LD、sitemap-index、RSS、robots.txt                                                            | `tests/unit/dates-routes-seo.test.ts`、`features.spec.ts`              | ✅   |
| 5.4 | 提交站点地图到 Google / Bing / 百度                                                                                                                 | MIGRATION.md §8                                                        | 🟡   |

## 6. 备份与恢复

| #   | 检查项                                                                                      | 证据                                                                 | 状态 |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| 6.1 | 每周一 03:30（北京时间）自动备份，产物保留 30 天，可选 gpg 加密                             | `.github/workflows/db-backup.yml`、`scripts/db-backup.sh`；BACKUP.md | ✅   |
| 6.2 | 恢复演练：备份 → 整库恢复 / 换库恢复 → 行数、策略、函数、授权核对 → 在恢复库上跑 RLS 测试   | CI db：`scripts/restore-drill.sh`（每次 CI 都跑）                    | ✅   |
| 6.3 | 添加仓库 Secret `SUPABASE_DB_URL`、`BACKUP_PASSPHRASE`，手动运行一次「DB backup」并下载产物 | OPERATIONS.md §4                                                     | 🟡   |
| 6.4 | 生产迁移前完成一次备份并确认拿到文件                                                        | MIGRATION.md §1                                                      | 🟡   |

## 7. 生产切换顺序（站长执行）

```
备份 → db/shim/supabase.sql
     → 0002 → 0003 → 0004 → 0005 → 0006
     → 0007（注册钩子函数，先不启用）
     → 0008 → 0009 → 0010 → 0011 → 0012（P6 应用商店）→ 0013（AI 工具页评论）
     （每执行一个文件，跑一次 db/verify/status.sql）
     → 合并 PR #2 → check-csp --url
     → 写入 signup_ticket_secret，启用 Before User Created 钩子，开启邮箱确认
     → 上线检查 → 提交站点地图
```

**永远不要在生产执行 `0001_baseline.sql`**（它是生产现状的还原，只给本地 / CI 建库用）。详细命令与回滚方案见 [MIGRATION.md](MIGRATION.md)。

## 8. 交付文档

| 文档                             | 内容                                                              | 状态 |
| -------------------------------- | ----------------------------------------------------------------- | ---- |
| [README.md](../README.md)        | 本地开发、测试命令、目录、文档索引                                | ✅   |
| [DEPLOY.md](DEPLOY.md)           | Vercel 项目设置、环境变量、域名、部署后检查、回滚、CSP            | ✅   |
| [CONFIG.md](CONFIG.md)           | Supabase Auth / SMTP / 中文邮件模板 / OAuth / Turnstile / Storage | ✅   |
| [MIGRATION.md](MIGRATION.md)     | 生产切换手册（逐步命令 + 验证 + 回滚）                            | ✅   |
| [OPERATIONS.md](OPERATIONS.md)   | 运维与管理员手册：角色、审核、封禁、备份、换密钥、监控            | ✅   |
| [BACKUP.md](BACKUP.md)           | 备份、导出、恢复、恢复演练                                        | ✅   |
| [PORTABILITY.md](PORTABILITY.md) | 离开 Supabase：换库、自建 PostgREST、认证、图片存储               | ✅   |
| [CONTENT.md](CONTENT.md)         | 内容指南：添加 / 更新一个应用（字段、图标、截图、下载地址）       | ✅   |

## 9. 不在本期

| 项目                          | 原因                                                                             | 状态 |
| ----------------------------- | -------------------------------------------------------------------------------- | ---- |
| 后台编辑官方内容（CMS 写入）  | 官方内容留在 Git，改动走 PR + 预览站（P4 范围调整）                              | ⚪   |
| 浏览历史                      | P3 标为可选，未做                                                                | ⚪   |
| 数据库主题页服务端渲染（ISR） | 静态外壳 + 客户端渲染 + 主题 sitemap 已满足收录；主题量变大后再改（PLAN.md §4）  | ⚪   |
| Storage 图片文件的自动备份    | 数据库备份只含图片元数据；文件可用 S3 兼容接口 `rclone sync`（OPERATIONS.md §4） | ⚪   |

## 10. P6 应用商店（第一部分：T6.1–T6.5）

| #     | 检查项                                                                                                                                                                                                                                                                                                                                                      | 证据                                                                                                                   | 状态 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| 10.1  | 应用数据模型（平台 / 链接类型 / 截图 / 价格 / 许可 / 隐私 / 更新日志 / FAQ）由 Zod 校验；直链必须附 SHA-256；示意图必须标注                                                                                                                                                                                                                                 | `src/content.config.ts`；`tests/unit/content.test.ts`                                                                  | ✅   |
| 10.2  | 8 个应用迁移到新结构，只保留真实信息；缺的素材写进 `ownerTodo`，占位图标 / 示意截图有明确标注；不出现任何评分 / 下载数字段                                                                                                                                                                                                                                  | `tests/unit/content.test.ts`（含「不伪造指标」）                                                                       | ✅   |
| 10.3  | 详情页：头部、平台识别推荐、截图轮播 + 灯箱（键盘、焦点归还）、新功能、评分分布、信息表、隐私、版本历史、FAQ、相关应用、结构化数据                                                                                                                                                                                                                          | `tests/e2e/apps.spec.ts`（3 引擎 × 4 视口）+ `pages.spec.ts` / `a11y.spec.ts`（全部路由）                              | ✅   |
| 10.4  | 下载中转 `/go/<应用>/<平台>/`：外链提示、SHA-256、先计数再跳转、计数不可达照常跳转、无地址时不出外链；noindex + robots Disallow + 不进 sitemap                                                                                                                                                                                                              | `tests/e2e/apps.spec.ts`（模拟）、`tests/e2e/apps-db.spec.ts`（真实 PostgREST，去重）                                  | ✅   |
| 10.5  | 0012：评价 RLS（匿名 / 用户 / 被封禁 / 版主）、一人一条、约束、限流、举报与「隐藏」处理、审计与通知；评分视图只统计已发布；下载计数去重 / 限流 / 爬虫过滤 / 不存 IP                                                                                                                                                                                         | `tests/db/p6.test.ts`（42 例），恢复演练也在恢复出的库上跑这一组                                                       | ✅   |
| 10.6  | 评价 E2E：写 / 改（已编辑）/ 删、一人一条、举报 → 版主隐藏 → 作者看到「已隐藏」、被封禁不能写                                                                                                                                                                                                                                                               | `tests/e2e/apps-db.spec.ts`（真实 Postgres + PostgREST）                                                               | ✅   |
| 10.7  | 目录：平台 / 分类 / 价格筛选、最新 / 热门 / 评分排序（真实统计；不可用时退回最新并提示）、静态分页 `/apps/page/N/`、分类页、平台页、查询串恢复                                                                                                                                                                                                              | `tests/e2e/apps.spec.ts`；`tests/unit/app-store.test.ts`                                                               | ✅   |
| 10.8  | Lighthouse：`/apps/`、`/apps/fablemotion/` 四项 ≥ 95、LCP < 2.0 s、CLS < 0.05、页面加载期间脚本 ≤ 50 KB。CI run 40106550994（`5570204`）实测：两页四项均 100，LCP 1.24 s / 1.32 s，CLS 0，脚本 46.7 KB / 47.8 KB。此前 `713a4f5`（run 40104781182）详情页脚本 58.3 KB 超预算（评价区、讨论区在空闲时就加载），已改为接近视口才加载                          | CI lighthouse（`lighthouserc.cjs`）                                                                                    | ✅   |
| 10.9  | 生产库执行 0012、0013                                                                                                                                                                                                                                                                                                                                       | MIGRATION.md §5A                                                                                                       | 🟡   |
| 10.10 | 自研应用素材（2026-10-25 站长授权代填）：统一风格的图标家族（1024 PNG + 512/256/128/64 AVIF / WebP）、每个应用 2–4 张标注「概念图」的 WebP 截图、默认价格 / 许可 / 隐私；没有安装包的平台显示「即将推出」+「上线通知」。剩下站长提供：真实下载地址（直链附 SHA-256）、可选真实截图、核对默认值                                                              | `tests/unit/content.test.ts`；`tests/e2e/apps.spec.ts`；[CONTENT.md](CONTENT.md) §6                                    | 🟡   |
| 10.11 | AI 工具栏目 `/ai/`（T6.6）：30 个第三方工具（官网 / GitHub / 应用商店逐个核对于 2026-10-25），原创介绍与点评，只链官方地址，本地化图标注明版权；瀑布流 + 分类标签页 + 价格 / 开源筛选（查询串恢复）；详情页复用应用布局（评价、讨论区、`/go/` 跳转计数）；SoftwareApplication / ItemList / BreadcrumbList 结构化数据；进导航、sitemap、站内搜索、Lighthouse | `tests/e2e/ai.spec.ts`、`tests/unit/content.test.ts`、`tests/unit/app-store.test.ts`、`tests/db/tools.test.ts`（0013） | ✅   |

E2E 构建说明：CI 的 build 任务设置 `AZ_E2E_FIXTURES=1`，额外加载 `src/content/apps/_e2e/` 里的测试夹具应用（带真实格式的直链、SHA-256、在线使用与「暂未提供」三种平台），用来测下载中转与平台识别。
Vercel 的生产 / 预览构建**不设**这个变量，夹具不会出现在线上（`tests/unit/content.test.ts` 也检查它不在正式内容目录里）。
