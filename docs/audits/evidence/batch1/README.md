# 批次 0 + 批次 1 证据（A15 / A16，T091 / T092 / T095）

执行：Hark，2026-10-27（Asia/Shanghai）。所有证据已脱敏：不含密钥、令牌、cookie、真实邮箱或 IP。
「真实」只指本表写明的环境；本地 PostgREST 结果不等于生产 Supabase 验收。

## B01 版本锁定（T001）

| 项目                   | 值                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 审计基线               | `2794ccb62e016ee9cb2dbc419448427844c73485`（`v2/astro`）                                                                                                                                                                                      |
| 开工时 `v2/astro` head | `2794ccb`，与基线一致，无差异需要重现                                                                                                                                                                                                         |
| 交接文档               | PR #3，分支 `docs/hark-handoff-2026-10-27`（head `e65fcae`）                                                                                                                                                                                  |
| 基线的不可变预览部署   | GitHub Deployment `7341046343`（Preview，ref `2794ccb`，2026-10-27 03:07 CST）→ `azsou-site-24y46ck75-azsous-projects.vercel.app`                                                                                                             |
| 分支别名               | `azsou-site-git-v2-astro-azsous-projects.vercel.app`：v2/astro 最新部署即 `2794ccb`。别名受 Vercel 部署保护（匿名访问 302 到 vercel.com/login），无法匿名读取页面里的构建 commit，所以别名 → 部署的对应只能由 GitHub 部署记录推断，标注为推断 |
| 本批候选               | 分支 `fix/batch1-admin-read-settings-guard`；commit 见 PR                                                                                                                                                                                     |
| 构建环境（本地）       | Node 22.23.3，Astro 5，PostgreSQL 17 + PostgREST 14.18（aarch64），Chromium（系统包）；CI 环境见 `.github/workflows/ci.yml`                                                                                                                   |
| 功能开关               | 代码默认：`PUBLIC_SUPABASE_URL` = 生产项目 `abryflgoljltyakthtql`（`src/lib/supabase-config.ts`、`.env.example`）；Vercel 预览的环境变量无法从仓库读取，**未核实**预览是否覆盖了它                                                            |

### 生产迁移台账（只读）

用 Supabase Management API 的只读查询端点执行 `db/verify/status.sql`（文件本身只读）与 `pg_proc` / `information_schema` 查询，
没有执行任何写入、迁移或 DDL。`supabase_migrations` 台账为空（项目没有用 Supabase CLI 管迁移），以 `status.sql` 为准：

- `status.sql` 25 项检查**全部为 false**：0002 到 0017 一个都没有在生产库执行（[prod-status.json](prod-status.json)）。
- `public` 只有 5 张表：`comments, forum_replies, forum_threads, profiles, site_content`（V72 基线）。
- 后台相关函数只有 `admin_set_user(target uuid, new_role text, new_banned boolean)`（0001 基线）。

### 生产 PostgREST 匿名探测（只读，[prod-anon-probe.txt](prod-anon-probe.txt)）

用前端打包里公开的 publishable key 调用（都是读取或不存在的函数，不会产生写入）：

| 模块用到的对象                                                                                                                | 结果                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `rpc/admin_stats`、`rpc/mod_list_content`、`rpc/mod_list_users`、`rpc/admin_list_friend_links`、`rpc/admin_subscriber_counts` | **HTTP 404 `PGRST202`**（schema cache 里找不到函数） |
| `reports`、`audit_log`、`guestbook_entries`、`friend_links`、`subscribers`、`content_workflow`                                | **HTTP 404 `PGRST205`**（找不到表）                  |
| `site_content?kind=eq.setting`、`profiles`                                                                                    | HTTP 200（V72 已有）                                 |

## A15 根因（T091）

1. **数据库**：预览站按代码默认连生产 Supabase，而生产库停在 V72 基线；8 个模块依赖的 RPC / 表来自 0003 / 0009 / 0015 / 0016 / 0017，
   在 PostgREST 上全部是 404 `PGRST202` / `PGRST205`。登录识别能工作，是因为 `profiles` 在 V72 就存在。
2. **前端**：`supabase.ts` 把缺对象转成 `DataUnavailableError('数据库还没有执行管理后台迁移（0009）')`，但 `friendlyError()`
   对所有 `DataUnavailableError` 一律显示「网络或服务暂时不可用，请检查网络后重试。」——把迁移问题说成了网络问题；
   留言板 / 订阅接口同样如此；重试只会重复同一个 404。
3. **复现**：本地真实 Postgres + PostgREST 建「shim + 0001」库（`0001_baseline.sql` 就是生产现状的逐项还原），
   在审计基线 `2794ccb` 上打开 8 个模块，得到与审计截图完全相同的文案（`before/v72-*.png`）。

证据边界：真实预览的已登录 Network 面板仍**阻塞**（没有管理员凭据，预览受 Vercel 部署保护）；
「预览连的就是生产库」来自代码默认值与生产库结构的一致，属推断。若预览改连了其他项目，请站长提供该项目的只读访问以复核。

## A15 八模块清单（2026-10-27 21:06 站长要求按真实后台纠正）

唯一清单：`tests/e2e/admin-modules.ts`（admin-read / admin-faults 两个 E2E 与 `tests/unit/admin-modules.test.ts` 共用）。
依据交接文档原文「概览、内容、用户、举报、留言、友链、订阅、审计」与真实后台侧栏 `src/lib/admin-nav.ts` 逐项对账（单测断言）；
「数据端点」= 健康库上该模块实际发出的请求（admin-faults 基线用例在真实 PostgREST 上记录并断言与清单**完全相等**），
另有每个后台页面都会发的外壳请求 `reports`（举报角标，0003）与 `rpc/unread_notification_count`（0004）。

| 交接文档 | 侧栏     | 路径                  | 数据端点（主对象在前）                                                             | 生产现状库错误条里的迁移 |
| -------- | -------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| 概览     | 概览     | `/admin/`             | `rpc/admin_stats`、`rpc/mod_lift_expired_bans`                                     | 0009                     |
| 内容     | 内容管理 | `/admin/content/`     | `rpc/mod_list_content`（排序参数 0017，缺时降级）、`rpc/mod_workflow_tick`（0017） | 0009                     |
| 用户     | 用户     | `/admin/users/`       | `rpc/mod_list_users`（排序参数 0017）                                              | 0009                     |
| 举报     | 举报队列 | `/admin/reports/`     | `reports`、`forum_threads`（被举报目标预览）                                       | 0003                     |
| 留言     | 留言审核 | `/admin/guestbook/`   | `guestbook_entries`                                                                | 0015                     |
| 友链     | 友链审核 | `/admin/links/`       | `rpc/admin_list_friend_links`                                                      | 0015                     |
| 订阅     | 邮件订阅 | `/admin/subscribers/` | `rpc/admin_subscriber_counts`                                                      | 0016                     |
| 审计     | 审计日志 | `/admin/audit/`       | `audit_log`                                                                        | 0003                     |

**不在** 8 模块里：站点设置（`site_content`，V72 已有；A16 另测）、导入导出（按需导出）、权限矩阵（静态）、官方内容（构建期 Git 清单）、用户详情（从用户列表进入）。

纠正记录：本 PR 的测试清单本来就与上表一致（只是分散在两个文件里，已合并为一份并加了对账测试）；
写错的是批次 2（PR #5）的放行申请 `docs/release/2026-10-27-prod-migrations-0002-0018-release-request.md` 验证清单那一行——
写成了「仪表盘、举报、内容、用户、审计、设置、数据、权限矩阵」（多了设置 / 数据 / 权限矩阵，漏了留言 / 友链 / 订阅）。
该文件只在 #5 分支上，已把正确写法交给 #5 负责人改（本 PR 不改 #5 的文件）。

**A15 仍然打开**：上表 8 个模块要在隔离的 Supabase 测试项目上用真实管理员会话逐个读出真实数据 / 真实空态才能关闭（另有负责人推进）；本地真实 PostgREST 结果不算真实预览验收。

## 修复（不需要执行生产迁移）

- `SchemaMissingError`：缺对象时带对象名、PostgREST 错误码和创建它的迁移编号（`src/lib/data/schema-map.ts`，单测逐项对账迁移文件）。
- 错误分 7 类：缺迁移 / 网络 / 超时 / 5xx / 登录失效 / 权限 / 其他；8 个模块的错误态显示标题 + 下一步 + `data-error-kind`，缺迁移时按钮是「重新检测」。
- 「重试」真的重新请求：概览以前是整页 `location.reload()`，改为只重读统计；订阅页以前只有一行状态文字且不能重试，补了错误态与重试。
- 库在 0016（缺 0017）时：内容 / 用户列表去掉 `p_sort` / `p_dir` 用 0009 旧签名重读，照常显示真实数据，并提示「服务端排序需要数据库迁移 0017」。
- 公开页面的 `friendlyError` 行为不变（访客不需要迁移细节）。

**这不会让生产预览读到数据**：8 个模块要显示真实数据，生产库必须先执行 0002–0017（B04，需站长批准）。修复后预览会明确显示「数据库未就绪：缺少 X（迁移 N）」。

## A16（T092 / T095）

修复前（`2794ccb`）实测：设置读取失败 → toast + 填入默认值 + 保存可用；提交表单后发出 **3 个 POST**，
把本地测试库里的真实配置（关闭注册、自定义公告）覆盖成默认值（[e2e-before-t092.log](e2e-before-t092.log)）。

修复后：读取成功前表单和保存停用、不填默认值；失败时持续错误条 +「重试」；保存函数再用 `canSave()` 守卫（绕过按钮直接提交也不发写请求）；
「重新加载」按请求序号丢弃过期响应；已修改的表单遇到库值变化时保留输入并提示冲突（使用数据库中的值 / 保留我的修改），冲突未处理不能保存。

## 测试：失败前 → 修复后

| 用例                                                                        | 环境                                                                           | 2794ccb（修复前）         | 修复后  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------- | ------- |
| `tests/e2e/admin-read.spec.ts` 8 模块 × 生产等价库（T091）                  | 本地 PG17 + PostgREST 14，shim + 0001                                          | 16 失败（桌面 + iPhone）  | 16 通过 |
| 同上：缺 0017 库降级读取                                                    | shim + 0001…0016                                                               | 2 失败                    | 2 通过  |
| 同上：断网 / 5xx 分类 + 重试；概览重试不整页刷新                            | 全量库 + 路由注入断网 / 503                                                    | 4 失败                    | 4 通过  |
| 同上：真实空集 ≠ 错误                                                       | 全量库                                                                         | 2 通过（回归护栏）        | 2 通过  |
| 同上：全量库 8 模块读出真实数据                                             | 全量库 + 合成主题 / 举报                                                       | （修复后新增）            | 2 通过  |
| `tests/e2e/admin-settings-guard.spec.ts` T092                               | shim + 0001…0016（0017 不涉及 site_content），读取失败注入，pg advisory 锁串行 | 2 失败（3 个默认值 POST） | 2 通过  |
| 同上 T095                                                                   | 同上，503 → 延迟成功 → 编辑 → 他人改库 → 迟到 / 过期响应                       | 2 失败                    | 2 通过  |
| `tests/unit/admin-read-errors.test.ts`、`tests/unit/settings-guard.test.ts` | 假 fetch（单元层）                                                             | —                         | 46 通过 |

原始日志：[e2e-before-run1.log](e2e-before-run1.log)、[e2e-before-t092.log](e2e-before-t092.log)、[e2e-after.log](e2e-after.log)。
回归（chromium 4 视口，admin / admin-states / p7b / roles + 新用例）：[e2e-regression-chromium.log](e2e-regression-chromium.log) 136 通过、1 失败——
失败是本批改测试夹具引入的 `useRealSettings` 参数错位（`astro check` 在 CI 也报出），已修复，单独重跑通过。
本地只跑了 chromium；三引擎结果以 PR 的 CI 为准。

## 截图（本地真实 PostgREST，不是生产预览）

| 文件                                                                                                              | 内容                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `before-v72-8modules-1440.jpg` / `after-v72-8modules-1440.jpg`                                                    | 生产等价库 8 模块：修复前统一「网络或服务暂时不可用」→ 修复后「数据库未就绪：缺少 X（迁移 N）」 |
| `before-v72-content-1440.png` / `after-v72-content-1440.png`                                                      | 内容页单张对照                                                                                  |
| `before-v72-overview-390.png` / `after-v72-overview-390.png`                                                      | 概览 390 宽对照                                                                                 |
| `before-settings-load-error-1440.png` / `after-settings-load-error-1440.png`、`after-settings-load-error-390.png` | 设置读取失败：修复前默认值 + 可保存 → 修复后错误条 + 停用                                       |
| `after-settings-conflict-1440.png`                                                                                | 迟到响应冲突提示（输入保留）                                                                    |
| `before-pre17-content-sorted-1440.png` / `after-pre17-content-sorted-1440.png`                                    | 缺 0017：修复前整页报错 → 修复后数据 + 降级提示                                                 |
| `after-full-8modules-1440.jpg`                                                                                    | 全量库 8 模块真实数据 / 空态                                                                    |

已登录的**真实预览**截图：阻塞（缺管理员测试凭据；且预览库未迁移，修复部署后也只会显示「数据库未就绪」）。

## 回滚

纯前端改动，无迁移、无权限变化。回滚 = revert 本 PR 的两个 commit（测试 + 修复），不涉及数据。
