# images.spec.ts:90（webkit-iphone）首跑失败：根因分析（2026-10-28）

范围：PR #5 run 40522111734 attempt 3，任务 `e2e (webkit, 2)`（job 122323351413）。
用例：`tests/e2e/images.spec.ts:90`「工具栏选图 → 压缩为 1600×800 → 填写替代文字 → 插入 → 发布后主题页显示图片」，[webkit-iphone] 首跑失败、重试通过。
同时复核：#6 `9f16831`（community.spec 工具栏 / 超长用例只加了「等预览渲染」）。

## 0. 产物情况（先说清楚拿到了什么）

- **这次失败的 Playwright trace 没有上传，拿不到。** 该任务在 attempt 2、3 都是被 50 分钟任务上限**取消**的
  （apt 安装卡 19–25 分钟 + 约 30 分钟测试），而上传步骤条件是 `!cancelled()` → `Run actions/upload-artifact` = skipped；
  run 的产物列表里没有 `playwright-report-webkit-2`（只有 webkit-1 / chromium / firefox）。
- 能拿到的证据：
  1. 该任务的完整日志（Actions logs API），含失败用例的 Playwright 调用日志 → `images-flake-ci-log-122323351413.txt`；
  2. 本机 WebKit 27.2（与 CI 同一 Playwright 1.64.1 / webkit v2370 构建号）对同一用例录的 trace，逐条读 action / log / network；
  3. 本机计时实验（三组，见 §3）。
- 这一点本身也是 CI 问题：本轮把安装与测试拆成独立步骤、各自 `timeout-minutes`，步骤超时算失败而不是任务取消，
  报告与首跑 trace 照样上传（`docs/CI.md`）。

## 1. CI 日志里的失败

```
Error: expect(page).toHaveURL(expected) failed
Expected pattern: /\/forum\/t\/\?id=[0-9a-f-]{36}$/
Received string:  "http://127.0.0.1:4321/forum/new/?cat=tech"
Timeout: 7000ms
Call log:
  - Expect "toHaveURL" with timeout 7000ms
    - waiting for navigation to finish...
    - navigated to "http://127.0.0.1:4321/forum/t/?id=7a2f018e-2b31-48a2-b747-067a2240df2d"
  > 142 |     await expect(page).toHaveURL(/\/forum\/t\/\?id=[0-9a-f-]{36}$/);
```

首跑 16.5 s（失败），重试 5.9 s（通过）。

读法（对照 Playwright 1.64.1 源码 `playwright-core/lib/coreBundle.js`）：

- `toHaveURL(RegExp)` 走 `frame._expect('to.have.url')`，在页面里执行注入脚本读 `document.location.href`，失败时报告**最后一次成功读到的值**。
- 「waiting for navigation to finish… / navigated to …」来自 `_performWaitForNavigationCheck`：expect 开始时已有一个挂起的导航，
  随后**导航提交到了新主题 `7a2f018e-…`**——也就是说：点击生效了、写库成功了（新 id 是服务器返回的）、浏览器也已经切到新主题页。
- 但直到 7 秒用完，注入脚本在**新文档**里一次都没有返回结果，报告里只剩下旧页（/forum/new/）的读数。

所以失败不是：

- ✗ 预览防抖让按钮移动——点击确实提交了表单（产生了新主题和导航）；
- ✗ 图片上传未完成——用例在点「发布」之前已断言「上传完成」、`uploads` 长度 1、正文里有图片地址；
- ✗ 图片加载造成的布局偏移——同上，点击已生效；
- ✗ 重复提交——只有一个新 id、一次导航。

失败的是：**新主题页的文档在 WebKit 上 7 秒内没有变成可执行脚本的状态**。

## 2. 本机 trace：新文档在 WebKit 上要等模块脚本跑完才能被读取

同一用例、webkit-iphone、`--trace=on`（通过的一次），`test.trace` 中的时间点（毫秒，自测试开始）：

| 时间              | 事件                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| 10344             | click「发布主题」开始                                                                             |
| 11212             | `POST /rest/v1/forum_threads` → 201（75 ms）                                                      |
| 11250             | click action done                                                                                 |
| 11296             | toHaveURL 开始：`waiting for navigation to finish...`                                             |
| 11327             | `GET /forum/t/?id=22475fa9-…` → 200（25 ms）                                                      |
| 11392             | `navigated to "…/forum/t/?id=22475fa9-…"`（导航已提交）                                           |
| 11461–11475       | 新页 3 个入口模块（UserMenu / Base / 主题页脚本）下载完                                           |
| **11475 → 14160** | **约 2.7 s 没有任何网络活动**：入口模块的静态依赖（preload-helper、index、routes…）迟迟没有被请求 |
| 14143             | toHaveURL 才拿到新文档的地址 → 通过                                                               |
| 14160 起          | 模块依赖开始下载；随后 rest/v1 读取主题、h1 渲染                                                  |

导航提交后，**toHaveURL 的读取与页面自己的模块加载被同一段 ~2.7 s 卡住**；这次 2.7 s 落在 7 s 内所以通过。
CI 首跑同一段超过了「7 s − 点击后写库与导航已花掉的时间」，就失败了。

## 3. 计时实验（本机，2 workers，与 CI 同为 2 并发）

用临时用例测「点发布 → 新主题页」各段耗时（`PerformanceNavigationTiming`，原始数据见同目录 txt）：

| 场景                                                             | WebKit 新主题页 domInteractive | WebKit DOMContentLoaded | 点击 → 能读到新地址 |
| ---------------------------------------------------------------- | ------------------------------ | ----------------------- | ------------------- |
| 发布后跳转，trace 录制开（CI 配置 `retain-on-failure` = 一直录） | 0.14–2.4 s                     | **2.6–8.7 s**           | 3.8–**12.7 s**      |
| 发布后跳转，trace 关                                             | 0.03–0.13 s                    | 1.3–2.4 s               | 1.9–3.2 s           |
| 不发帖，直接 `location.assign` 到同一主题页（trace 开）          | 0.04–0.17 s                    | 0.3–1.9 s（偶发 4.8 s） | —                   |
| Chromium，发布后跳转（trace 开）                                 | 0.28–0.80 s                    | 0.70–1.27 s             | 1.0–2.7 s           |

结论：

- WebKit 在 HTML 解析完（domInteractive）之后，要到入口模块及其依赖全部跑完（DOMContentLoaded）才回应 Playwright 的读取；
  这一段在 WebKit + trace 录制 + 2 并发下可达 8.7 s，与有无图片无关（withImage=false 也出现 8.7 s）。
- 原用例让**一个 7 s 的 `toHaveURL` 同时覆盖三段**：写库请求 + 导航 + 新文档模块脚本执行完。
  在 Chromium 上三段加起来通常 1–3 s，所以只在 WebKit 慢机上偶发。
- 这是**测试等错了信号**：URL 断言本身没问题，但它真正依赖的是「写库返回 → 导航发出 → 新文档就绪」这三个事件，
  而这三个事件都有确定的信号可等。

## 4. 修复

### 4.1 测试：按真实信号分段等待（`tests/e2e/community-fixtures.ts` 的 `publishThread`）

```
写库：waitForResponse(POST /rest/v1/forum_threads) → 断言 201
导航：waitForRequest(主框架的导航请求 /forum/t/?id=…) → 取出新主题地址，断言 /forum/t/?id=<uuid>
就绪：waitForURL(该地址, { waitUntil: 'domcontentloaded' }) → toHaveURL(该地址)
```

- 断言**更严**：以前只要求「某个 uuid」，现在要求就是这次写库后浏览器导航去的那个地址；7 s 的 expect 只用于页面内容（h1 等）。
- 不是「加预览等待 / 固定等待」：没有 `waitForTimeout`，每一段都等一个具体事件；导航沿用 Playwright 的导航超时（= 用例超时 30 s）。
- 用在 `images.spec.ts:90` 与 `community.spec.ts` 发帖主流程（同一模式、同一隐患）。

### 4.2 应用：发布成功到页面离开之间保持锁定（`src/scripts/community/new-thread.ts`）

分析中发现的真实问题：以前 `busy()` 在写库返回后**立刻恢复**「发布主题」按钮，而跳到新主题页在 WebKit / 慢机上要 1–8 s；
这段时间按钮可再点、Ctrl+Enter 可再提交（正文已被清空 → 闪出「正文不能为空」）。

- 现在：从发出请求到页面离开一直 `disabled` + `aria-busy="true"`，重复提交直接忽略；写库失败才解锁并显示原因；
  从新主题页「返回」且页面从往返缓存恢复（`pageshow.persisted`）时解锁。
- 新测试 `tests/e2e/composer-stability.spec.ts`「发布成功到页面离开之间…」：新主题页文档请求回 204（浏览器按规范留在原页）把这段时间固定住，
  断言按钮禁用、`aria-busy`、再提交 / Ctrl+Enter 不出错误、只发 1 次写库请求、库里只有 1 条、主题可打开。
  修复前 chromium-desktop / webkit-desktop / webkit-iphone 3/3 失败（`disabled: false, busy: null`），修复后通过。

## 5. 复核 #6 `9f16831`（community.spec「工具栏…超出长度时阻止提交」）

`9f16831` 的分析是对的：宽屏（容器 ≥ 640px）编辑区与预览并排，预览在输入后 200 ms 防抖渲染，4001 字的预览把这一行撑高、
「发布主题」被往下推；Playwright 判定按钮「稳定」后、真正点下去前，防抖渲染把按钮移走，点击落在正文区，没有提交。
但它的修法**只是加等待**（先等预览渲染完再点）——用户同样会遇到「按钮在手指下移走」。这与 images 的根因不同（images 的点击已生效），
但同属「点下去时状态在变」，按要求换成根因修复：

- 应用（`src/styles/community.css` + `editor.ts`）：并排时预览 `contain: size` + `overflow-y: auto`——行高只由编辑区决定，
  预览在框内滚动，不再推动下面的按钮；预览加 `tabindex="0"`（可滚动区域可用键盘聚焦）。
- 新测试 `composer-stability.spec.ts`「宽屏：预览渲染出长正文后『发布主题』位置不变」：按钮文档坐标前后差 ≤ 1 px，
  且预览确实可在框内滚动、可聚焦。修复前 chromium-desktop 2517 px、webkit-desktop 2603 px 位移（失败），修复后 0 px。
- #6 上：撤掉 `9f16831` 加的 3 行等待（断言不变），由上面的应用修复 + 新测试覆盖。

## 6. 验证（本机，修复后构建）

`composer-stability` + `images` + `community`，chromium-desktop / webkit-desktop / webkit-iphone：68 通过、1 跳过（窄屏布局用例按设计跳过），0 失败
（`composer-images-community-after.txt`）。CI 结果见 PR #4 / #6 评论。

## 7. 仍未确定 / 限制

- CI 那次首跑的原始 trace 不存在（见 §0），§2 的时间线来自本机同版本 WebKit 的 trace；CI 日志里的调用日志与之一致（导航已提交、读取超时）。
- WebKit 在 domInteractive → DOMContentLoaded 之间那段空闲（无网络、无读取）的内部原因没有进一步定位到 WebKit 源码层；
  trace 录制会把它放大 2–4 倍。它不影响结论：测试现在等的是这一段结束的确定信号，而不是赌它在 7 s 内结束。
