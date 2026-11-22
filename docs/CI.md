# CI 策略：安装与测试分开、首跑失败单独跟踪

站长第三轮拍板（2026-10-28）：安装超时与测试首跑失败分开处理；图片用例先分析失败 trace，不能只加等待。
本文是 `.github/workflows/ci.yml` 的运行规则。

## 1. 安装（基础设施）与测试分开计时、分开报告

| 任务                 | 安装步骤（`timeout-minutes`）          | 测试步骤（`timeout-minutes`） | 任务上限（兜底） |
| -------------------- | -------------------------------------- | ----------------------------- | ---------------- |
| e2e（3 引擎 × 2 片） | 安装浏览器与系统依赖（基础设施）25     | E2E 测试 45                   | 85               |
| design（2 片）       | 安装 Chromium + 中文字体（基础设施）25 | 设计门禁 + 视觉回归 25        | 55               |
| devices（3 引擎）    | 安装浏览器 + 中文字体（基础设施）25    | 设备矩阵测试 15               | 50               |
| db                   | PostgreSQL 17 客户端（基础设施）10     | 恢复演练（任务上限内）        | 25               |

- 以前 e2e 只有一个 50 分钟的任务上限：PR #5 run 40522111734 的 webkit 第 2 片，apt 安装卡了 19–25 分钟，
  剩下的时间不够跑完约 30 分钟的测试，任务被整体取消——看起来像测试挂了，实际上一个用例都没失败，而且取消时报告也没上传。
- 安装：`scripts/ci/pw-install.sh <浏览器> [apt 包…]`
  - 浏览器二进制：`~/.cache/ms-playwright` 按 **Playwright 版本 + 引擎** 缓存（`actions/cache`），命中时几秒完成；下载每次 ≤ 5 分钟、最多 3 次。
  - 系统依赖（apt）：每次 ≤ 8 分钟、最多 3 次；第 2 次换 `archive.ubuntu.com`、第 3 次换 `mirrors.edge.kernel.org`
    （默认 azure 镜像偶发极慢）；单个连接 30 秒无响应即重试（`Acquire::http::Timeout`）。重试前清理残留 apt / dpkg 进程与锁。
  - 用尽重试：脚本打 `::error title=安装超时（基础设施）::` 注解并写任务摘要；步骤超时则由紧随其后的
    「安装超时（基础设施）」步骤注解。两种情况测试步骤都不会运行（显示为 skipped）。
- 测试：测试步骤自己 45 分钟上限。超时且没写出报告时，「测试超时」步骤单独注解（不是安装问题）。
- 报告上传用 `!cancelled()`：步骤超时属于失败而非取消，报告与首跑失败的 trace 照样上传。

### 安装超时怎么处理

1. 任务注解是「安装超时（基础设施）」、测试步骤为 skipped → **只重跑一次该任务**（Re-run failed jobs）。
2. 重跑仍是安装超时 → 记到 PR 评论（任务名、run id、卡在哪个包 / 镜像），不再重跑；不改测试、不跳过任务。
3. 安装超时从不计作测试通过：PR 需要所有任务真正跑过测试并通过。

## 2. 首跑失败（flaky）：重试保留，但不再被重试藏起来

- 重试策略不变：e2e 与 devices 在 CI 上 `retries: 1`；design（视觉回归 / 设计门禁）`retries: 0`。**没有移除重试，也没有放宽断言。**
- 新增：Playwright 在 CI 额外写 JSON 报告（`reports/e2e-results.json` / `reports/devices-results.json`），
  `scripts/ci/flaky-report.mjs` 读取后：
  - 每个「首跑失败、重试通过」的用例打 `::warning title=首跑失败（flaky）::` 注解（文件:行、项目、首跑错误第一行）；
  - 任务摘要里两张表：⚠️ 首跑失败（flaky）、❌ 失败（含重试仍失败）；
  - 写 `reports/flaky.json`，上传为产物 `flaky-e2e-<引擎>-<片>` / `flaky-devices-<引擎>`，保留 30 天。
- 判定：**硬失败（重试仍失败）让任务失败；flaky 不让任务失败，但必须处理。**
  - 每个 flaky 在 PR 评论里登记（用例、项目、run id、首跑错误），并下载 `playwright-report-*` 里的首跑 trace（`trace: retain-on-failure`）分析根因。
  - 修根因：等真实信号（请求返回、导航提交、DOMContentLoaded、按钮状态），或修应用本身（例如按钮在点击时移动、提交后未锁定）。
    **不接受**：只加固定等待 / 预览等待、放宽断言或预算、扩大截图遮罩、盲目接受基线、删除用例。
  - 同一用例连续两次 run 出现 flaky 且根因未明：在 PR 里标为阻塞项。

## 3. 已按此策略处理的 flaky

| 日期          | 用例                                                  | 根因                                                                                                                                                                                                                                                   | 修复                                                                                                                                                                                                                                        | 证据                                                       |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 2026-10-28    | `admin-faults.spec.ts:277` 故障 3（chromium-desktop） | 探测请求无效：只拿基线第一个端点、空体 `{}` 调用；`mod_list_content` 的 `p_type` 必填，健康时也是 404 PGRST202 → 「等 404」不等重载就过、「等非 404」永远等不到；第一个端点是谁取决于页面并发请求先后（竞态）。PostgREST 重载本身正常（每次 < 0.25 s） | 测试：重载信号用 PostgREST 管理端口 `/metrics` 的结构缓存加载计数 + 重放基线里全部端点的真实请求（故障 = PGRST202/205、还原 = 2xx）；浏览器 404 先等全部读完再按端点类型断言；测试端口改由系统分配 + 就绪检查认进程标记（并行压测发现撞号） | `docs/audits/evidence/ci/admin-faults-flake-2026-10-28.md` |
| 2026-10-28    | `images.spec.ts:90`（webkit-iphone）                  | 导航已提交到新主题，但新文档在 WebKit 上 7 秒内没跑完模块脚本，`toHaveURL` 只拿到旧页地址；同时发现发布成功后按钮立即恢复、跳转期间可重复提交                                                                                                          | 测试按真实信号分段等待（写库 201 → 新主题文档请求 → DOMContentLoaded，`publishThread`）；应用：提交锁保持到离开本页                                                                                                                         | `docs/audits/evidence/ci/images-flake-2026-10-28.md`       |
| 2026-10-27/28 | `community.spec.ts` 工具栏 / 超长（webkit-desktop）   | 宽屏预览 200ms 防抖渲染后变高，把「发布主题」往下推，点击落在按钮移走前的位置                                                                                                                                                                          | 应用：并排预览不撑高表单（`contain: size` + 框内滚动，可聚焦）；去掉 #6 9f16831 里只等预览的临时等待                                                                                                                                        | 同上                                                       |

## 4. 视觉基线与 Lighthouse 产物（r13）

- **视觉基线门禁**（design 任务，`scripts/ci/visual-baseline-gate.mjs`）：push / PR 时基线目录缺失、为空（0 个 .png）、缺任何必需快照（按 visual 项目用例标题推出）、或出现推不出快照名的新标题 → **失败**。不再在空目录时自动 `--update-snapshots=all`；比较一律 `--update-snapshots=none`（缺快照只失败、不写入）。门禁结果 `reports/visual-gate.json` 随 `design-report-*` 上传。
- **候选基线**：只有手动 `workflow_dispatch` 勾选 `update_visual` 才会另跑 `visual-candidate` 任务，产物 `visual-candidate-baseline`。它**没有和任何基线比较**，任务成功只表示生成完毕，不算视觉门禁通过、不算验收；人工审阅后才可提交。同一次运行里 design 任务照常比较已提交的基线。
- **Lighthouse 两档分开存证**（`scripts/ci/lhci-tier.sh`）：移动档 → `lhci-out/mobile`（产物 `lighthouse-mobile`），桌面档 → `lhci-out/desktop`（产物 `lighthouse-desktop`）。每档含 `raw/`（原始 lhr-*.json + assertion-results.json）、`reports/`、`summary.json` / `summary.md`、`exit-codes.json`、`manifest.sha256`。输出目录已存在或 `.lighthouseci` 有残留就拒绝运行，后跑的档不能覆盖先跑的档；两个产物都 `if: always()` 上传；最后一步 `lhci-gate.sh` 复核两档清单，任一档失败 / 缺档 / 归档被改动 → 任务失败。

## 5. Lighthouse 归档完整性（r14）

- **每个文件操作都检查**（`lhci-tier.sh`）：建目录、归档复制（`.lighthouseci` → `raw/`，复制后逐文件 sha256 比对）、upload、清理、摘要、证据核对、`exit-codes.json`、`manifest.sha256`（先写临时文件再改名）任一失败 → 记录（`::error` + `exit-codes.json` 能写就写）并非 0。最终退出码：0 通过；1 测量 / 断言 / 证据不完整；2 拒绝运行；3 本档文件操作失败。`exit-codes.json` 的 `status` 与退出码一致。
- **归档核对通过之前绝不删除 `.lighthouseci`**。归档失败就原样留下：后一档因此拒绝启动（只写一份 `status: refused` 记录），但绝不读、删、覆盖先前档的任何证据；留下的工作目录由 `lighthouse-unarchived-workdir` 产物单独上传。
- **证据完整性不只是哈希**（`lhci-verify.mjs`，`lhci-tier.sh` 写清单前跑一次，`lhci-gate.sh` 按自己的期望再跑一次）：`raw/assertion-results.json` 必须存在且是可解析的数组（合法 `[]` = 没有未通过的断言；缺失 / 解析失败 / 不是数组 → 失败，分开记录）；配置的页面清单与期望页数一致、`numberOfRuns` 与期望次数一致（移动 `32x3`、桌面 `12x1`，写在 ci.yml 的 gate 参数里）；每页样本数正好等于期望；任何 `runtimeError`、缺失或非有限数的必需指标（LCP、CLS、TBT、四项分数、脚本 / 整页体积）→ 失败，绝不过滤掉再按剩下的样本判断；报告清单条目数与摘要 `lhrCount` 一致；`manifest.sha256` 必须正好覆盖目录里的全部文件。
- **预算与聚合方式不变**：仍由 `lighthouserc.cjs` / `lighthouserc.desktop.cjs` 决定（中位数聚合）。
- **命名**：LHCI 的 `assertion-results.json` 只列未通过（含 warn 级）的断言，所以 `summary.json` 里的字段叫 `failedOrWarnAssertionEntries`（条目数），不代表执行过的断言总数；`assertionResults` 记录文件状态（`missing` / `unparseable` / `not-array` / `present-empty` / `present`）。
