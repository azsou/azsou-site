# azsou.com · AZ Studio v2

Astro 5 + TypeScript 静态站，部署在 Vercel。重构计划与进度见 [docs/PLAN.md](docs/PLAN.md)。

> 当前分支 `v2/astro` 已完成 **P1 静态站 + P2 数据层与账户 + P3 论坛与评论**。后台（P4）与上线验收（P5）完成、
> 且生产库执行完迁移（顺序见 docs/PLAN.md §4）之前，不要合并到 `main`：合并即上线。

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
npm run test:lhci    # Lighthouse CI 预算
```

- 社区（发帖/回帖/通知…）用例连真实后端：设置 `DATABASE_URL`（Postgres 超级用户，`npm run db:local` 可起一个）与
  `POSTGREST_BIN`（PostgREST 14 可执行文件），globalSetup 会建临时库、跑全部迁移、起 PostgREST，浏览器的 `/rest/v1` 请求被转发过去；
  未设置时这些用例跳过（CI 设 `E2E_REQUIRE_DB=1`，缺少即失败）。默认只在桌面与 iPhone 视口跑，`COMMUNITY_ALL=1` 跑全部 4 个视口
- 数据库测试：`DATABASE_URL=… POSTGREST_BIN=… npm run test:db`
- 只跑某个引擎：`PW_BROWSERS=webkit npm run test:e2e`
- Linux arm64 上 Playwright 没有 Chromium 构建：`CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e`
- 在全部 12 个项目上跑 axe：`A11Y_ALL=1 npm run test:e2e`
- CI（`.github/workflows/ci.yml`）在每个 PR 上跑以上全部。

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
| `scripts/`                                     | 内容迁移、静态服务器、死链检查、体积报告、图标生成                                   |
| `tests/unit`、`tests/e2e`                      | Vitest 与 Playwright                                                                 |
| `legacy/`                                      | V72 单文件站点与提取出的数据，仅供参考，不参与构建                                   |

## 内容更新

- 改文章/项目：直接编辑 `src/content/**.md` → 提交 → Vercel 预览 → 合并上线。
- `npm run migrate:content` 会从 `legacy/az_data.json` 重新生成内容（会覆盖手工修改，FableMotion 档案除外），一般不需要再跑。
- 标签在 `src/lib/tags.ts` 登记；站点导航与页脚在 `src/lib/site.ts`。

## 原则

不伪造评分、下载量、用户数或评论。没有数据的地方留空或标注「待作者补充」。
