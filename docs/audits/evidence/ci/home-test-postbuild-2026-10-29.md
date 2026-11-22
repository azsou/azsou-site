# 第六轮 ④：home.test 构建产物盲区（2026-10-29）

## 问题

`tests/unit/home.test.ts` 里 3 条断言读 `dist/client/index.html`，用 `it.skipIf(!html)` 保护。CI 的 build 任务顺序是
`npm run test:unit` → `npm run build` → … → `npm run test:ld`，所以**单元阶段永远没有产物，这 3 条在 CI 里从来没跑过**。
本机先 build 再跑单元时其中一条失败（第五轮记为 33 vs 46；本机这份产物是 45 vs 32）。

## 修复前（8f647f5）

- 无产物（= CI 单元阶段）：`Tests 19 passed | 3 skipped (22)` —— 3 条被跳过。
- 有产物（本机先 build）：`× 首页没有装饰图标墙 / 平台胶囊区 / 大 CTA，货架条目都有类型徽标 → expected 45 to be 32`。

## 根因

不是首页漏了徽标，是断言口径错：它只数 `<article class="entry entry--(tile|mini)">`（22 + 10 = 32），却数页面上**全部**
`entry__type` 徽标。P10 打磨后首页还渲染 `entry--row`（最新网格 8 个）和编辑精选 bento（5 个 `<li class="bento-tile">`，徽标在卡片底部），
所以徽标 45 = 22 + 10 + 8 + 5，每个条目恰好一个——计数两边口径不同才对不上。

## 修复

- 3 条断言搬到 `tests/built/home.test.ts`，由 `npm run test:ld`（vitest.built.config.ts）在 **build 之后**执行；没有产物直接抛错，不跳过。
- 徽标断言改成「每个货架条目（tile / mini / row / bento）各自恰好一个徽标，bento 徽标类型 = 卡片 data-type，页面徽标总数 = 条目数，四种形态都在」。
- 单元测试加守卫：`tests/unit/*.ts` 不得读取构建产物（会在 CI 里被跳过）。

## 修复后

- `npx vitest run tests/unit/home.test.ts`（无产物）：`Tests 20 passed (20)`，0 跳过。
- `npx vitest run -c vitest.built.config.ts tests/built/home.test.ts`（有产物）：`Tests 4 passed (4)`。
- CI：build 任务的 `npm run test:ld` 步骤（ci.yml 第 49 行，在 `npm run build` 之后）包含 tests/built/home.test.ts。
