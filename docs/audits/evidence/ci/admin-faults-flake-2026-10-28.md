# admin-faults.spec.ts:277「故障 3」首跑失败：根因分析（2026-10-28）

用例：`tests/e2e/admin-faults.spec.ts:277`「故障 3：删除模块用到的函数 / 表（重命名 + 重载结构）→ PostgREST 真实回 404 PGRST202 / PGRST205 → 「数据库未就绪」；还原后「重新检测」恢复」，[chromium-desktop]，任务 `e2e (chromium, 1)`。
错误：`PostgREST B 在 rpc/mod_list_content 上没有达到预期状态`（第 309 行，还原后的 `waitB`，10 秒）。

| 出现                  | run         | 任务（job）  | 首跑 | 重试 |
| --------------------- | ----------- | ------------ | ---- | ---- |
| PR #4 push（cdee2ca） | 40574058724 | 122437907289 | ✘    | ✓    |
| PR #5 push（e066055） | 40574415909 | 122438714889 | ✘    | ✓    |

原假设（多次 `NOTIFY pgrst` 合并 / 重叠、重载太慢）**不成立**。真实原因是**测试的探测请求本身无效**，触发与否取决于基线里浏览器请求的先后顺序（竞态）。

## 1. 结论

1. 故障 3 每个模块只拿「基线里第一个出现的端点」做探测，对函数一律发 `POST rpc/<名字>`、请求体 `{}`。
2. `mod_list_content` 有 10 个参数、只有 9 个有默认值（`p_type` 必填；迁移 0017）。空体调用在**健康状态下也是 404 PGRST202**
   「Could not find the function public.mod_list_content without parameters」。本机库实测：
   `mod_list_content 10|9`，其余 7 个后台 RPC 参数全部有默认值（`mod_list_users 8|8`、`admin_list_friend_links 1|1`、其他 0|0）。
3. 于是当内容模块的第一个端点恰好是 `rpc/mod_list_content` 时：
   - 故障阶段「等 404」**立即通过**——根本没等 PostgREST 重载；
   - 还原阶段「等非 404」**永远等不到**——PostgREST 早已重载完、函数也回来了，但这个探测请求永远是 404 → 10 秒后报错。
     这一步是**确定性**失败，不是慢。
4. 第一个端点是谁，取决于打开 `/admin/content/` 时外壳请求（举报角标 `reports`、通知数 `rpc/unread_notification_count`）与模块请求 `rpc/mod_list_content` 谁先发出——
   这是页面并发请求的先后，每次不同。顺序是 `reports` / `unread_notification_count` 在前时，探测打的是一个有效请求，用例通过。→ 表现为「偶发、重试通过」。
5. 应用的「重新检测」路径没有问题：所有失败里 PostgREST 都已按时重载（日志见 §3），浏览器侧从未走到 `retryAll`。

## 2. 证据：顺序与成败一一对应

日志里 `[faults] endpoints` 打印的是基线记录的端点（Set，按首次请求顺序）。

| 来源                                         | 内容模块第一个端点              | 结果                                             |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| CI #4 job 122437907289 首跑                  | `rpc/mod_list_content`          | ✘ 309 行                                         |
| CI #4 同 job 重试                            | `rpc/unread_notification_count` | ✓                                                |
| CI #5 job 122438714889 首跑                  | `rpc/mod_list_content`          | ✘ 309 行                                         |
| CI #5 同 job 重试                            | `reports`                       | ✓                                                |
| 本机旧代码 6 次（`--repeat-each`、1 worker） | 2 次 `rpc/mod_list_content`     | 这 2 次全部 ✘，另外 4 次（`reports` 在前）全部 ✓ |

- CI 摘录：`admin-faults-flake-ci-log-122437907289.txt`、`admin-faults-flake-ci-log-122438714889.txt`（Actions logs API 下载，只保留相关行）。
- 本机：`admin-faults-flake-local-repro.txt`。临时把 `waitB` 改成失败时打印最后一次响应，拿到的是：
  `404 {"code":"PGRST202","details":"Searched for the function public.mod_list_content without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.","hint":null,...}`
  ——`hint: null`、「without parameters」：缓存里有这个函数，只是空体调用匹配不上。

## 3. 证据：PostgREST 日志（排除「重载合并 / 太慢」）

`PGRST_TEST_LOG=<前缀>` 让测试里的每个 PostgREST 以 info 级别把日志写到文件（本次新增的排查开关，默认关闭）。失败那次 PostgREST B 的日志（UTC）：

```
03:04:13 Received a schema cache reload message on the "pgrst" channel     ← 内容模块：改名为 __fault 后的 NOTIFY
03:04:13 "POST /rpc/mod_list_content" 404 309 "node"                       ← 「等 404」：重载还没完成就通过了（309 字节 = 上面的 PGRST202 无参数）
03:04:13 Schema cache queried in 135.4 milliseconds
03:04:13 "POST /rpc/mod_list_content" 404 428 "Mozilla…"                   ← 浏览器：重载后的真 PGRST202（带 hint 指向 __fault），错误条正确
03:04:14 Received a schema cache reload message on the "pgrst" channel     ← 还原后的 NOTIFY
03:04:14 Schema cache queried in 81.0 milliseconds                         ← 不到 0.1 秒就重载完
03:04:14 … 03:04:24 "POST /rpc/mod_list_content" 404 309 "node" × 100      ← 探测一直 404（同一个「无参数」404），直到 10 秒超时
```

- 每次 NOTIFY 都有对应的「Received … / Schema cache queried」，没有丢失或合并；重载耗时 55–220 ms，远小于 10 秒。
- PostgREST 14.18 源码（`src/PostgREST/AppState.hs`）：结构重载用 `mkDebounce … leadingEdge`、间隔 0.1 秒——冷却期内到达的通知会在冷却结束后**再跑一次**，不会丢。
- 另一个潜在问题同时确认：对表的探测，「等 404」在重载前就能满足（旧缓存执行 SQL 时 Postgres 回 42P01，PostgREST 也映射成 404），所以旧逻辑在任何顺序下都不是真正的「等重载」，只是 404 来源不同。

## 4. 修复（测试侧；应用无需改）

`tests/e2e/admin-faults.spec.ts`、`tests/db/postgrest.ts`：

1. **重载信号用 PostgREST 自己的**：PostgREST B 开管理端口（`PGRST_ADMIN_SERVER_PORT`），`schemaCacheLoads()` 读 `/metrics` 的
   `pgrst_schema_cache_loads_total{status="SUCCESS"}`。改名前读一次，NOTIFY 后必须看到计数增加，才算「NOTIFY 之后的重载完成了」。
2. **状态用真实请求判断**：基线记录每个端点**第一次真实请求**（方法 + 路径查询 + 请求体），故障 3 原样重放模块的**全部**端点：
   - 故障阶段：每个都必须是 404 且 `PGRST202`（函数）/ `PGRST205`（表）——这两个码只来自结构缓存查找，DB 层的 42883 / 42P01 不算；
   - 还原阶段：每个都必须 2xx。
     与端点顺序无关，也不再依赖空体调用。超时仍是 100 × 100 ms（没有加长）。失败信息写明是「重载未完成」还是「已重载但某端点状态不对」及其响应。
3. **断言收紧且去掉竞态**：浏览器 404 的响应体是异步读的，旧代码在错误条出现后立即 `page.off`，可能漏记。现在错误条出现后等网络静止、
   等全部响应读完，再逐个断言「函数 404 = PGRST202、表 404 = PGRST205」（旧代码只要求每个码属于二者之一），并保留「用到函数的模块必须看到 PGRST202」。
   （修复过程中的一次并行压测里，「PGRST202 必须出现」在旧的立即 `page.off` 写法下漏记过一次；改为先等再断言后未再出现。）
4. **测试端口改由操作系统分配**（`freePort()` → `listen(0)`）。旧实现「随机起点 + 每次 +7」不查占用；本机 2 worker 并行压测实测撞号：
   `postgrest: Network.Socket.bind: resource busy (Address already in use)`，而 `startPostgrest` 的就绪检查（任意 < 500 即可）被占着该端口的另一个 worker 的
   PostgREST 管理端口答复了 → 该 worker 的 `/profiles` 全部 404、基线失败。现在就绪检查要求：进程未退出，且 OpenAPI 里能看到本进程独有的标记
   （`PGRST_OPENAPI_SERVER_PROXY_URI=http://pgrst-<uuid>.invalid`）；开了管理端口时 `/live` 也要通。`adapter.test.ts`、`postgrest-v72.test.ts` 同步改为 `await freePort()`。
   CI 上这个撞号还没出现过（单个 spec 只起 2 个进程），但它与本次修复新增的管理端口叠加后概率会上升，所以一起修掉。
5. `PGRST_TEST_LOG=<前缀>`：可选的 PostgREST 日志开关（默认关闭，CI 不设）。

没有做的事：没有加长任何等待；没有放宽断言；没有串行化其他用例（故障共享的是本 spec 自己的 PostgREST B，`describe.configure({ mode: 'serial' })` 本来就串行）。

## 5. 修复后验证（本机，PostgREST 14.18 / Postgres 17 / Chromium，2 核）

| 运行    | 方式                                                                                       | 结果                | 内容模块第一个端点为 `rpc/mod_list_content` 的次数 |
| ------- | ------------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------- |
| fix1    | 基线 + 故障 3，`--repeat-each=6`，1 worker                                                 | 12/12 ✓             | 1（旧代码下必失败的顺序）                          |
| stress2 | 整个 spec，`--repeat-each=2`，2 workers + 2 个 CPU 满载循环                                | 12/12 ✓             | 1                                                  |
| fix3    | 基线 + 故障 3，`--repeat-each=8`，2 workers（含端口与断言修复）                            | 16/16 ✓             | 0                                                  |
| stress3 | 整个 spec（基线 + 故障 1–5），`--repeat-each=3`，2 workers + 2 个 CPU 满载循环（最终代码） | 18/18 ✓（7.6 分钟） | —                                                  |

（fix2 是端口与断言修复之前的中间版本：16 条里 2 条失败、1 条因此未跑，分别就是 §4 第 3、4 点的两个问题，据此修复。）

## 6. 复现方法

```bash
source /workspace/work/flk-env.sh     # 沙箱：本地 PG 54329、PostgREST 14.18、系统 Chromium、端口 4611
PGRST_TEST_LOG=/tmp/flk/pg npx playwright test tests/e2e/admin-faults.spec.ts --project=chromium-desktop \
  -g "基线|故障 3" --repeat-each=8 --workers=2
```
