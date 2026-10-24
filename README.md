# azsou.com · AZ Studio v2

Astro 5 + TypeScript 静态站，部署在 Vercel。重构计划与进度见 [docs/PLAN.md](docs/PLAN.md)。

> 当前分支 `v2/astro` 已完成 **P1 静态站、P2 数据层与账户、P3 论坛与评论、P4 管理后台、P5 上线准备**（图片上传、
> 全量回归、Lighthouse ≥ 95、CSP、备份与恢复演练、交付文档）。**合并到 `main` 即上线**：先按
> [docs/MIGRATION.md](docs/MIGRATION.md) 备份并执行生产库迁移（0002…0011，不执行 0001），验收见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 本地开发

```bash
npm ci
npm run dev          # http://localhost:4321
npm run build        # 产物：dist/（adapter 同时复制到 .vercel/output/static）
npm run serve        # 用模拟 Vercel 行为的静态服务器预览 dist/
```

## 测试

```bash
npm run lint         # ESLint + Prettier
npm run check        # astro check（类型）
npm run test:unit    # Vitest：搜索、hash 跳转、转义、SEO、数据仓储契约、内容完整性
npm run build
npm run test:links   # 死链与锚点检查（离线，针对 dist/）
npm run test:html    # html-validate
npm run size         # 首屏 JS / CSS 体积与预算
npx playwright install --with-deps
npm run test:e2e     # Playwright：chromium / firefox / webkit × 1440 / 834 / 390 / 360，全部路由 + axe
npm run test:csp     # CSP 内联脚本哈希与安全头（改了内联脚本后：npm run csp:update）
npm run test:lhci    # Lighthouse CI：16 个页面，四项 ≥ 95（noindex 页面不计 SEO）
```

- 社区（发帖/回帖/通知…）用例连真实后端：设置 `DATABASE_URL`（Postgres 超级用户，`npm run db:local` 可起一个）与
  `POSTGREST_BIN`（PostgREST 14 可执行文件），globalSetup 会建临时库、跑全部迁移、起 PostgREST，浏览器的 `/rest/v1` 请求被转发过去；
  未设置时这些用例跳过（CI 设 `E2E_REQUIRE_DB=1`，缺少即失败）。默认只在桌面与 iPhone 视口跑，`COMMUNITY_ALL=1` 跑全部 4 个视口
- 数据库测试：`DATABASE_URL=… POSTGREST_BIN=… npm run test:db`（迁移、RLS 角色矩阵、后台 RPC、存储 RLS、`db/verify/status.sql`）
- 备份恢复演练：`DATABASE_URL=… npm run db:drill`（需要 pg_dump / pg_restore 17）
- 只跑某个引擎：`PW_BROWSERS=webkit npm run test:e2e`
- Linux arm64 上 Playwright 没有 Chromium 构建：`CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`
- 在全部 12 个项目上跑 axe：`A11Y_ALL=1 npm run test:e2e`
- CI（`.github/workflows/ci.yml`）在每个 PR 上跑以上全部：build、db（含恢复演练）、lighthouse、e2e（3 引擎 × 2 分片）。
- 数据库备份：`.github/workflows/db-backup.yml` 每周一 03:30（北京时间）运行，产物保留 30 天（需要仓库 Secret，见 docs/OPERATIONS.md）。

## 目录

| 路径                                           | 作用                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/content/{apps,games,articles,works}/*.md` | 官方内容（frontmatter 用 JSON 书写，schema 见 `src/content.config.ts`；正文为 HTML） |
| `src/data/*.json`                              | 更新日志、论坛分类与种子主题、评论种子、生成式素材索引                               |
| `src/lib/data/`                                | 数据仓储接口 + Supabase 适配器 + 内存适配器（换库只需新写适配器）                    |
| `src/lib/`                                     | 路由、SEO（JSON-LD）、搜索（拼音首字母）、旧 hash 跳转、日期、转义                   |
| `src/components/`、`src/layouts/`              | 设计系统组件（导航、底部 Tab、卡片、分段控件、列表组…）                              |
| `src/styles/global.css`                        | 设计令牌与组件样式（`@layer`，零 `!important`）                                      |
| `src/scripts/community/`                       | 社区 island：论坛列表、主题页、发帖、评论、编辑器、通知、收藏、个人主页              |
| `src/lib/markdown.ts` · `src/lib/sanitize.ts`  | 先转义的白名单 Markdown 渲染器 + DOMPurify 二次净化                                  |
| `src/scripts/`                                 | 搜索页、顶栏用户菜单（未读角标）等脚本                                               |
| `src/pages/og/art/[slot].png.ts`               | 构建期把 SVG 素材栅格化为 PNG 分享图                                                 |
| `public/art/`                                  | 生成式 SVG 素材（从 V72 `AZ_ASSETS` 拆出）                                           |
| `public/sw.js` · `public/az-sw.js`             | 新离线外壳 · 旧 SW 的自毁替身（清掉 V72 缓存）                                       |
| `scripts/`                                     | 内容迁移、静态服务器、死链检查、体积报告、图标生成、CSP 检查、备份 / 恢复 / 演练     |
| `db/migrations/`                               | 0001 基线（生产现状，仅本地 / CI）+ 0002…0011 增量迁移                               |
| `db/shim/` · `db/verify/` · `db/restore/`      | Supabase 环境模拟 / 迁移状态核对 / 恢复用 SQL                                        |
| `tests/unit`、`tests/db`、`tests/e2e`          | Vitest（单元）、Vitest（数据库）与 Playwright                                        |
| `legacy/`                                      | V72 单文件站点与提取出的数据，仅供参考，不参与构建                                   |

## 文档

| 文档                                       | 内容                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| [docs/PLAN.md](docs/PLAN.md)               | 重构方案、任务清单与设计说明                                 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)   | 上线验收清单（每项的证据与状态）                             |
| [docs/MIGRATION.md](docs/MIGRATION.md)     | 生产切换手册（备份 → 迁移 → 合并 → 钩子 → 站点地图，含回滚） |
| [docs/DEPLOY.md](docs/DEPLOY.md)           | Vercel 部署、环境变量、域名、CSP                             |
| [docs/CONFIG.md](docs/CONFIG.md)           | Supabase Auth / 邮件 / OAuth / Turnstile / Storage 配置      |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)   | 运维与管理员手册                                             |
| [docs/BACKUP.md](docs/BACKUP.md)           | 备份、导出、恢复与恢复演练                                   |
| [docs/PORTABILITY.md](docs/PORTABILITY.md) | 离开 Supabase 的换库方案                                     |

## 内容更新

- 改文章/项目：直接编辑 `src/content/**.md` → 提交 → Vercel 预览 → 合并上线。
- `npm run migrate:content` 会从 `legacy/az_data.json` 重新生成内容（会覆盖手工修改，FableMotion 档案除外），一般不需要再跑。
- 标签在 `src/lib/tags.ts` 登记；站点导航与页脚在 `src/lib/site.ts`。

## 原则

不伪造评分、下载量、用户数或评论。没有数据的地方留空或标注「待作者补充」。
