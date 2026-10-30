# azsou-test 初始化执行器与计划（第五轮 2026-10-28，第六轮 – 第十轮 2026-10-29 更新）——**未执行初始化；只做过只读预检**

> 执行器：`scripts/sbtest/init-executor.mjs`；钉住清单：`ops/sbtest/init-manifest.json`；影响清单：`ops/sbtest/init-impact.md`（数据 `ops/sbtest/init-impact.json`，由 `scripts/sbtest/impact-local.mjs` 在本机生成）。
> 测试：`tests/unit/sbtest-init-executor.test.ts`、`tests/unit/sbtest-init-r7.test.ts`（假 Management API / Auth Admin / Storage，不连任何项目）；`tests/db/sbtest-accounts-gotrue.test.ts`（本机官方 GoTrue 二进制，证明无邮件建号 / 改密 / 接管核对）。
> 执行需要站长单独批准（`SBTEST_OWNER_APPROVAL`）；本仓库的 CI / 测试永远不会对真实项目执行。

## 1. 目标与边界

- 只对 **azsou-test（`ovvfwkmqlejcpatmfqcd`）**：执行器硬编码允许清单，任何其他 ref（尤其生产 `abryflgoljltyakthtql`）→ 拒绝（退出码 2）。
- 只对**空**项目：预检（只读）要求 public 无表 / 视图 / 序列 / 函数、private 不存在、auth.users / storage.buckets / storage.objects 为 0、没有 `az_init`。不满足 → 停，**不清空、不覆盖**。
- 不启用 pg_cron、不执行 `db/ops/`；不发任何邮件；合成数据全部 `@example.com`。
- **从不删除、清空或重新创建测试项目**——不论成功、失败还是续跑，执行器和本手册都不把它当作回退或修复手段。

## 2. 执行通道、凭据与准入（第六轮 ①②，第七轮 ①②）

| 用途                       | 端点                                                                                                                               | 凭据（线路注入）                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 目标身份                   | `GET https://api.supabase.io/v1/projects/{ref}`：ref / name `azsou-test` / region `ap-southeast-1` / `ACTIVE_HEALTHY` 必须完全一致 | 项目级 PAT（Project Settings Read）                  |
| 范围记录（不依赖）         | `GET /v1/projects`：403 / 200 只记录；**403 不能证明令牌范围**——范围只以站长提供的令牌配置记录为准                                 | 同上                                                 |
| 预检 / 验收 / 清点（只读） | `POST /v1/projects/{ref}/database/query/read-only`（以 `supabase_read_only_user` 执行）                                            | 项目级 PAT：Database Read                            |
| **项目服务准入（只读）**   | `GET https://ovvfwkmqlejcpatmfqcd.supabase.co/auth/v1/admin/users?per_page=1` → **200 且 `{users:[…]}`**                           | service_role / secret key（`apikey` 头）             |
| 迁移 / 种子（写）          | `POST /v1/projects/{ref}/database/query`                                                                                           | 项目级 PAT：Database Read-write（**另批，未申请**）  |
| 托管账号                   | `POST …/auth/v1/admin/users`（`email_confirm: true` + 运行标记）；接管时 `PUT …/auth/v1/admin/users/{id}`（只改密码）              | service_role / secret key：`apikey` 头（旧版 + JWT） |
| 文件                       | `POST …/storage/v1/object/ugc-images/<路径>`（`x-upsert: false`）；验收 `GET …/storage/v1/object/authenticated/…`                  | 同上                                                 |

**项目服务准入（第七轮 ①）**：preflight 与 execute 共用同一段代码；**第一次写之前**（全新执行与 `--resume` 都一样）必须通过。
只认 `GET /auth/v1/admin/users?per_page=1` 返回 HTTP 200 且响应是 `{users:[…]}`（这个端点只读、且需要 service_role）；401 / 403 / 5xx / 非 JSON / 形状不符 → **不接受（not accepted）→ 拒绝（退出码 2），一个写请求都不发**。
`/auth/v1/settings` 成功（anon 就能读）或 `/storage/v1/bucket` 返回空列表（任何被接受的 Bearer 都可能）**都不算**准入；`--probe-project` 仍会探测这两个，但只作信息。
运行记录只写状态与返回条数，不写用户数据。2026-10-29 的真实只读结果：**不接受（401）**；当时对 `/auth/v1/settings`、`/rest/v1/` 的无头探测返回 `No API key found`（= apikey 没有到达），自带无效 apikey 返回 `Invalid API key`——见 `docs/audits/evidence/sbtest/readonly-admission-2026-10-29.md`、`credential-binding-2026-10-29.md`。

**401 分类（第八轮 B3）**：401 **不一律**解释为「没有注入」。执行器读响应正文按 `classify401` 区分并写进运行记录：
`no_api_key`（Kong `No API key found in request` = apikey 头没有到达）、`invalid_api_key`（Kong `Invalid API key` = apikey 已送达但值无效 / 不属于该项目）、
`other`（GoTrue `bad_jwt` / `invalid JWT`、Management API `Unauthorized` 等 = 无法区分缺失 / 无效 / 签名错误）。三类都拒绝（退出码 2）。

**结果解析（第八轮 B1）**：所有 `/database/query[/read-only]` 结果都经同一个解析器 `parseOneRow`：必须恰好 1 行、行是对象、字段存在（值可以是合法的 `null`，例如 `json_agg` 空集）；
`[]`、`[{}]`、多行、缺字段、值类型不对 → `Uncertain`：写之前 = 拒绝（2），写之后 = 不确定（3），**之后不再发任何写请求**。V1.status 只有 `rows: null` 才算「全部 true」。

**不跟随重定向（第七轮 ②）**：每个请求都以 `redirect: 'manual'` 发出；任何 3xx（同主机或跨主机）→ 拒绝（退出码 2），不向 Location 发请求。
**例外（第十二轮）**：Auth Admin 建号（`POST /auth/v1/admin/users`）/ 显式改密（`PUT /auth/v1/admin/users/{id}`）请求**已经发出**后才收到的 3xx 仍然不跟随，但服务器可能已经处理了这次写，所以按**结果未知（退出码 3）**处理，不是拒绝（见 §10.1「执行状态与证据一致」）。读请求和写之前的闸门收到 3xx 照旧是拒绝（退出码 2）。
**例外（第十三轮）**：B0 建账本、迁移 / 种子事务（`POST …/database/query`）、Storage 上传（`POST /storage/v1/object/ugc-images/…`）请求**已经发出**后才收到的 3xx 同样不跟随、**不当成写之前的拒绝**：B0 与迁移 / 种子按 §4 核对账本（只用允许清单内的只读端点，从不访问 Location 主机），Storage 按结果未知（退出码 3）。
线路注入只按主机名绑定，跟随跨主机重定向可能把请求带到另一条绑定上。2026-10-29 无凭据实测 `api.supabase.io` 的 `/`、`/v1/projects/{ref}`、`/v1/projects` 都没有重定向（最终主机仍是 `api.supabase.io`，见 `credential-binding-2026-10-29.md`）。

**凭据模式**（`--mode` / `SBTEST_CRED_MODE`）：

- `injected`（真实运行默认）：执行器**不带 Authorization / apikey 头**，vault 按主机名在线路上注入。进程环境里**不需要也不允许**
  `SBTEST_MGMT_TOKEN` / `SBTEST_SERVICE_KEY`（出现即拒绝）。Management API 基址只允许 `https://api.supabase.io`，项目基址只允许
  `https://ovvfwkmqlejcpatmfqcd.supabase.co`（`SBTEST_MGMT_BASE` / `SBTEST_PROJECT_BASE` 可设，但出了允许清单就拒绝）。
  **`api.supabase.com` 是公共 Management API 域名**（不是「生产 API」）：当前有一个生产范围的连接器绑在上面，而 vault 里 azsou-test 只读 PAT 的范围也写着它，
  线路上注入哪一条不可枚举——所以执行器在任何模式下都不向它发请求；任何含生产 ref 的基址拒绝。
  任何请求得到 **401 → 拒绝（退出码 2）**，并按上面的 401 分类写明是哪一类（不一律当成「没有注入」），不当成执行失败、不重试；写操作开始后的 401 附打码清点。
  沙箱里 Node 的全局 `fetch` 默认不走注入代理：运行时加 `NODE_USE_ENV_PROXY=1`（不加时项目主机通常回 `No API key found`，Management API 回 401 `Unauthorized`——都拒绝）。
- `env-token`：只给本机假服务器 / 本机 GoTrue 测试；基址必须是回环地址，所以真实令牌永远到不了真实主机。

**凭据绑定声明**（打码，2026-10-29）：见 `docs/audits/evidence/sbtest/credential-binding-2026-10-29.md`。vault 条目可以列出（id 前缀、标签、vault 范围）；
**connect_service 的服务绑定从沙箱里不可枚举**（没有列出绑定的工具），所以每个主机「是哪条密钥、哪个头、是否覆盖请求头」只写观测到的行为，来源一律写 **unknown**。

**未来初始化 PAT 的权限**（站长在 Supabase 创建，执行器只核对行为，不核对范围）：只授权 azsou-test；**Project Settings Read + Database Read-write**，其他一概不给；
不要账号级 Projects 权限，不要旧版（Legacy）令牌。`GET /v1/projects` 返回 403 **不是**范围证明；范围证明 = 站长提供的令牌配置记录（截图或导出）。

运行记录（`--record <md>`）只写方法 / 路径 / 状态 / 耗时 + 目标身份 / 范围 / 打码身份 / C0 / 准入结果，不写请求头、正文、令牌、密码。

**Management API 不是 pg_dump / pg_restore 通道。** 备份恢复演练需要 Postgres 协议，执行通道仍未决定；目标也必须是另一个全新的空项目，azsou-test 不做恢复目标。

## 3. 钉住源 SHA 与迁移文件

- `ops/sbtest/init-manifest.json` 记录 `source_sha`（完整 40 位）与 `db/migrations/0001…0019` 每个文件的 sha256 / 字节数，以及 `db/verify/status.sql` 的 sha256。
- 执行器**从 git 对象库**读 `source_sha` 下的文件（不读工作区），逐个比对清单：文件不是恰好 0001–0019、任何哈希 / 大小不符 → 拒绝。
- 换候选版本时：`node scripts/sbtest/init-executor.mjs manifest --source-sha <新 SHA> --write`，清单变化随 PR 审阅。

## 4. 每个文件一个事务 + 超时 + 「提交了没有」核对（第七轮 ③ 收紧；第十三轮：B0 / Storage / 写后 3xx / 两层结果）

- 每个迁移文件本身以单独一行 `begin;` 开头、`commit;` 结尾（执行器校验各恰好一次，否则拒绝）。执行器去掉这两行，换成：
  `begin; set local statement_timeout = '300s'; set local lock_timeout = '15s'; set local application_name = 'az-init:<运行 id>:<文件>'; <正文>; insert into az_init.applied (run_id, file, sha256) …; commit;`
- **种子事务同样带运行标记**：`set local lock_timeout`、`set local application_name = 'az-init:<运行 id>:seed'`，超时核对与迁移完全相同。
- HTTP 失败 / 断线 / 客户端超时（330 s）/ **发出后收到 3xx（第十三轮，不跟随）**后，执行器先用只读端点查 `{ledger, running}`：
  - 两个字段都必须是非负整数，否则（`[{}]`、`[]`、缺键、`null`、账本行数 > 1）→ **不确定（unknown）**，退出码 3——**绝不当成「未提交」**；
  - `running > 0` → 仍在跑，退出码 3；`ledger = 1` → 已提交，继续；`ledger = 0` 且 `running = 0` → 未提交，退出码 1。
  - 核对请求本身出错（非 2xx、3xx、401、形状不符、网络）→ 无法核对，退出码 3（第十三轮：写已发出，核对失败不当成拒绝）。
  - 所以 5xx 并不一律映射成 3：账本证明已提交 → 继续；证明未提交 → 1；仍在跑 / 查不到 → 3。
- **B0 建账本（第十三轮）**：单事务，C0 已证明 `az_init` 不存在。2xx → 继续；4xx → 显式拒绝、未提交（1）；5xx / 其他非 2xx / 超时 / 断线 / 发出后 3xx →
  只读查 `az_init.applied` 是否存在：存在 → 已提交（只能是本次 B0），继续；**不存在 → 不确定（3）**——B0 没有运行标记，不能排除仍在运行 / 延迟提交，**不是「确定未提交」**；核对失败 → 3。
- **Storage 上传（第十三轮）**：2xx → 已存储；4xx（例如 409 已存在、413）→ 显式拒绝（1）；5xx / 其他非 2xx / 超时 / 断线 / 发出后 3xx → **结果未知（3）**，
  立即停止后续一切写；不自动重传、不覆盖、不删除（对象可能已存储，也可能不完整），由人工按清点 `storage_objects` 核对。
- **结果两层（第十三轮）**：B0、迁移 / 种子、Storage 的逐项结果都分开写 ① `http`（原始 HTTP 状态 / 传输错误：`{status}`、`{status, redirect_followed: false}`、`{error: timeout | network}`，**不含服务器正文**）
  与 ② `verification`（核对结论 `committed` / `not-committed` / `still-running` / `unverifiable` / `not-verified` / `rejected` + 依据）；`outcome` 是业务结论。
  例：HTTP 503 + 账本 1 行 → `http: {status: 503}`、`verification: committed`，业务结果 = committed，继续。运行记录写成「结果 0005_… committed（HTTP 503；核对：committed，账本 1 行…）」。
- 每个文件提交后跑 `db/verify/status.sql`：该步及之前全为 true 才继续；有 false → 失败（1）。**status 查询本身出错**（网络错误、非 2xx、JSON 错误、形状不符）→ 不确定（3）。
- C0（执行前）：所有键必须存在且类型正确（版本是数字版本串、计数是非负整数、标志是布尔值、扩展是数组）；`{}`、缺键、`null`、版本无效 → **拒绝（2）**，不当成「空库」。
- 写操作开始后的**任何意外异常**也归为不确定（3），同样写出阶段、已知结果与打码清点（见 §9）。

## 5. 合成账号、内容、文件

| 项      | 内容                                                                                                                                                       | 通道                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 账号 ×4 | `sbtest-admin@example.com`（admin）、`sbtest-moderator@example.com`（moderator）、`sbtest-user@example.com`、`sbtest-banned@example.com`（banned）         | Auth Admin API；`email_confirm: true`；运行标记见 §10        |
| 内容    | 主题 2、回复 1、评论 1、举报 1、封禁 1（+ 触发器同步 1）、留言 2、友链 1、订阅 1、通知 1（触发器）——种子新增行合计 12；另更新 3 行 profiles（角色 / 封禁） | `database/query`（单事务，引用 Admin API 返回的真实用户 id） |
| 文件 ×2 | `ugc-images/<测试用户 id>/202610-sbtest-{a,b}-1x1.png`（sha256 见影响清单）                                                                                | Storage API                                                  |

**不直接写 `auth.users` / `auth.identities`，不伪造 OAuth 身份**——真实 GitHub OAuth 登录只能由 I01 的人工证据证明。

## 6. 影响清单

`ops/sbtest/init-impact.md`（由 `impactMarkdown` 从同一版本的 `init-impact.json` 生成，单测核对两者一致）分开列：
迁移新建的对象（341 个 / 15 组）、**迁移自带的行（合计 9）**、执行器账本（20 行）、**账号及关联行**（auth.users 4、public.profiles 4、auth.identities 4）、
**种子新增行（合计 12）**、**资料更新（3 行，不新增）**、桶与文件（sha256），每项的可逆方式。迁移没有 down 脚本：逐项回退按清单，回退本身另行批准。

## 7. 用法

```bash
node scripts/sbtest/init-executor.mjs plan [--out <目录>]          # dry-run：零网络，核对钉住 + 打印计划 + 写 plan.json / impact.md
NODE_USE_ENV_PROXY=1 node scripts/sbtest/init-executor.mjs preflight [--probe-project] --record docs/audits/evidence/sbtest/<名字>.md
                                                                   # 只读：目标身份 + 范围 + 身份 + C0 + 项目服务准入（不接受 → 退出码 2）
DATABASE_URL=postgres://postgres@127.0.0.1:<端口>/postgres node scripts/sbtest/impact-local.mjs   # 重新生成影响清单（只连本机库）
# 只有站长批准、写权限 PAT 与 service_role 绑定就位、preflight 准入为「接受」之后：
SBTEST_OWNER_APPROVAL='<批准记录>' NODE_USE_ENV_PROXY=1 \
  node scripts/sbtest/init-executor.mjs execute --execute --confirm-ref ovvfwkmqlejcpatmfqcd \
  --handoff-file ~/.azsou-sbtest/<日期>-accounts.jsonl --record <md>
# 部分完成后的受控续跑：同上加 --resume（交接文件换一个新路径；已存在的文件不覆盖）；被接管账号默认不改密
# 只有确实要换某些被接管账号的密码时（例如上次交接文件丢了），显式列出并单独确认，两份列表必须逐字相同：
#   --resume --rotate-passwords sbtest-admin@example.com --confirm-rotate sbtest-admin@example.com
```

`execute` **必须用交接文件**：`--handoff-file <仓库外绝对路径>`。**正式初始化（injected 真实目标）不允许 `--handoff discard`**（第八轮 B2，拒绝且一个请求都不发）；
`discard` 只允许本机假服务器 / 演练（env-token + 回环地址）。都没给 → 拒绝（2）。
每次调用生成新的 `attempt_id`（全新执行时 `run_id = attempt_id`；续跑沿用账本里的 `run_id`），两者都写进运行记录与交接文件的每一行。

## 8. 执行后验收 V1（第六轮 ③，成功的唯一条件）

`execute` 在 F1 之后自动跑 V1（全部只读 + Storage 下载）；**7 项全部通过才返回 0**，任何一项不通过 → 1：

| 项          | 内容                                                                                                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.cron     | 没有 pg_cron 扩展、没有 cron schema / 任务。第九轮严格：`cron_extension` / `cron_schema` 必须是布尔值、`cron_jobs` 必须是有限非负整数（number），只有 false / false / 0 通过；明确的 true 或 > 0 → 不通过；缺字段 / null / `"0"` / NaN / 数组等形状不对 → **不确定（exit 3）**。不套用初始化前的空库要求 |
| V1.status   | `db/verify/status.sql` 全为 true                                                                                                                                                                                                                                                                         |
| V1.objects  | `init-impact.json` 里 public / private / storage / auth 的每个对象都存在（341 个中除 extensions 函数），且 pg_trgm 扩展存在                                                                                                                                                                              |
| V1.ledger   | `az_init.applied` 恰好 20 行：0001–0019 名称与 sha256 = 清单；seed 1 行且 **sha256 = 按真实账号 id + run_id 重算的期望种子哈希**；run_id 一致；无未知行                                                                                                                                                  |
| V1.accounts | 4 个合成账号存在、邮箱已确认、只有 email 身份；角色 admin / moderator / user / user + banned（且有生效封禁）                                                                                                                                                                                             |
| V1.seed     | 种子相关表行数 = 影响清单期望（迁移自带行 + 账号行 + 种子新增行）                                                                                                                                                                                                                                        |
| V1.storage  | ugc-images 恰好 2 个对象，路径 = `<测试用户 id>/<文件名>`，重新下载 sha256 一致                                                                                                                                                                                                                          |

## 9. 失败处理、清点与续跑矩阵（第七轮 ③④）

- 写操作开始后任何非成功出口（失败 1 / 不确定 3 / 写后被拒 2 / V1 不通过 1 / 意外异常 3）都返回并写进运行记录：**阶段**（P0 / P1 / PS / B0 / 0001…0019 / U1 / S1 / F1 / V1）、
  **逐项已知结果**（文件 / 账号 / 对象 + 结果，不含正文与密码）、**打码资源清点**（账本行、合成账号 + 打码 id、种子表行数、Storage 对象、仍在运行的 az-init 会话数）。查不到的项标 `unknown`，整体状态 `unknown`，**不推断**。
- **从不自动重试，从不清空 / 删除测试项目或账号。** 人工核对后才 `--resume`。
- 「账号部分建成」与「4 个账号已建、种子未提交」不再要求人工删除：续跑按运行标记核对后**接管**（§10）。

续跑矩阵（`RESUME_MATRIX`，与代码逐字一致，单测核对）：

| 状态                                                                      | 续跑动作                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 没有 az_init（B0 前失败）                                                 | --resume 拒绝；C0 仍为空时按全新执行                                                                      |
| 账本为空（B0 已提交、无迁移）                                             | 拒绝：人工核对后决定                                                                                      |
| 账本是清单的严格前缀                                                      | 从下一个迁移续跑，沿用原 run_id                                                                           |
| 账本乱序 / 未知文件 / sha256 不符 / 多个 run_id                           | 拒绝：人工处理                                                                                            |
| 仍有 az-init 会话在运行                                                   | 拒绝：等会话结束后人工确认                                                                                |
| pg_cron 已启用                                                            | 拒绝：状态与执行器不符                                                                                    |
| 迁移未完成却已有合成账号                                                  | 拒绝：状态矛盾                                                                                            |
| 部分账号已建（1–3 个）、种子未提交                                        | 逐个核对后接管，补建缺的账号，再提交种子                                                                  |
| 4 个账号已建、种子未提交                                                  | 全部核对后接管，不建号，提交种子                                                                          |
| 已有账号核对不通过（运行标记缺失或不符、未确认、非 email 身份、名称不符） | 拒绝接管：人工核对，不删除账号                                                                            |
| 种子已提交、合成账号不是 4 个                                             | 拒绝：状态矛盾                                                                                            |
| 种子已提交、账本哈希 ≠ 期望种子哈希                                       | 拒绝：人工处理（哈希不符）                                                                                |
| 种子已提交、文件缺失或部分上传                                            | 只补传缺的文件，再跑 V1                                                                                   |
| 已存在的文件内容不符                                                      | 拒绝：不覆盖                                                                                              |
| 被接管的已有账号（任何续跑）                                              | 默认不改密；只有 --rotate-passwords 与 --confirm-rotate 逐字列出的账号才经 Admin PUT 改密并写进新交接文件 |

续跑前的人工核对步骤（全部只读）：

1. `preflight --record <md>`：准入必须「接受」，C0 形状有效。
2. 看上次运行记录里的**阶段**与**清点**；对照账本（`az_init.applied`）、`auth.users` 里 4 个 `sbtest-*@example.com` 的 `raw_app_meta_data->>'az_init_run'`、`email_confirmed_at`、`auth.identities.provider`。
3. 清点为 `unknown` 或有 az-init 会话在跑时，等会话结束（`pg_stat_activity`）再重新清点；仍不确定就停下交站长。
4. 符合矩阵里的「续跑」行才加 `--resume`，并给一个**新的**交接文件路径。

## 10. 测试账号：无邮件路径与凭据交接（第七轮 ④，第八轮 B2）

- **不依赖任何邮件**：`@example.com` 收不到信，重置邮件 / 魔法链接都不可用，也不该用。
- 建号：执行器用 `crypto.randomBytes(18)`（24 字符 base64url）生成密码，经 `POST /auth/v1/admin/users` 一次设置：
  `{ email, password, email_confirm: true, user_metadata: { name }, app_metadata: { az_init_run: <运行 id> } }`。不发信。
- 接管（续跑）：核对邮箱属于合成清单、`app_metadata.az_init_run` = 账本 run_id、邮箱已确认、只有 email 身份、名称一致。
  **被接管账号默认不改密**（密码在上次运行的交接文件 / vault 里；种子已提交 + 只补文件的续跑也一样）。只有 `--rotate-passwords <邮箱,…>` 与 `--confirm-rotate <同一列表>`
  逐字一致时，才对列出的账号经 `PUT /auth/v1/admin/users/{id}` `{ password }` 改密并写进**新的**交接文件；列表里有不在本次接管范围的账号 → 拒绝，不写。
- 交接文件路径检查（第八轮 B2）：必须是绝对路径；逐个路径分量 `lstat`，遇到符号链接就解析真实路径——**任何分量指向仓库（按仓库真实路径比较）→ 拒绝**；
  最终目录的真实路径在仓库里 → 拒绝；目录必须**正好 0700**（已存在但不是 0700 → 拒绝，不替你改权限）、文件**正好 0600**，二者属主都必须是当前用户；
  文件以 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建（已存在 / 是链接 → 拒绝）。每行 `{email, password, user_id, project_ref, run_id, attempt_id, set_at}`，`run_id` = 实际沿用的账本 run_id。
- **0600 文件写好 ≠ 交接完成。** 交接完成 = 文件里的每一行（N 条，见 §10.1）都已存进站长的 Hark vault，且沙箱里的文件已覆盖删除（尽力而为，不保证云端残留不可恢复）。密码**禁止**出现在聊天、附件、GitHub（PR / 评论 / 提交 / Actions 产物）、运行记录与日志里。

### 10.1 交接完成的具体路径（文件在 Hark 沙箱里，不在站长电脑上；第九轮按实际行数核对）

执行器跑在 Hark 的沙箱里，交接文件也在沙箱里（例如 `/workspace/.azsou-sbtest/<日期>-accounts.jsonl`，在仓库 `/workspace/work/…` 之外）。站长不需要、也不应该把文件下载到自己电脑。

**N = 本次运行成功写入交接文件的记录条数**（第十二轮措辞），**不是**云端建号 / 改密的次数：建号 / 改密成功但交接行没写成功的账号不计入 N（见下表「交接错误」）。正常情况下这些记录来自本次**真正新建**的账号 + 经 `--rotate-passwords` / `--confirm-rotate` **显式改密**的账号。被接管但没改密的账号不在文件里（它们的密码仍是上次交接 / vault 里的那条）。
N 可以是 0–4 中任何一个数（全新执行通常是 4，部分账号续跑可能是 1–3），**不是固定 4 条**；执行器的运行记录与输出写明本次实际的 N。

**N = 0 只表示「本次运行没有成功写入任何交接行」（第十一轮更正第十轮）**，不等于「没有建号、没有改密」。执行器按**本次执行证据**（客户端请求记录里的 `POST /auth/v1/admin/users` / `PUT /auth/v1/admin/users/{id}` 及其状态 + 逐项结果）下结论，交接结论写在运行记录单独一节「交接与收尾（与执行结论分开记录）」里：

| 本次执行证据                                                                                                                                             | 运行记录 / 输出写什么                                                                                                                                 | 交接文件                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 请求记录里**没有任何** Auth Admin 建号 / 改密请求（例如种子已提交 + 只补文件的续跑，且没有 `--rotate-passwords` / `--confirm-rotate`；或写之前就被拒绝） | 「N = 0（本次请求记录里没有发出任何 Auth Admin 建号 / 改密请求：本次没有新建账号，也没有改密…）——不需要任何 save_login / vault 保存，不得为凑数改密」 | 核对仍是 0 字节普通文件后删除                                                |
| 请求全部被 HTTP 4xx 拒绝（响应证明未生效）                                                                                                               | 「N = 0（…全部被 HTTP 4xx 拒绝，按响应未建号、未改密）——不需要 save_login」                                                                           | 同上，核对后删除                                                             |
| 有请求**已发出但结果未知**（响应丢失 / 连接断开 / 超时 / 3xx / 5xx）                                                                                     | 「账号状态未知：…账号可能已创建 / 密码可能已被改，状态未知，需人工核对」+「N = 0 只表示本次没有成功写入任何交接行，不表示没有建号 / 改密」；退出码 3  | **保留**（证据），不删                                                       |
| 请求**已生效（2xx）但交接文件写入失败**（磁盘满、只读、I/O 错误…）                                                                                       | **交接错误**：列出已创建 / 已改密但密码未交接的账号与错误码；执行器在这一个账号上立即停下（不建下一个、不改密、不重试），退出码 3                     | **保留**，不删；可能为空，也可能已部分写入（可能含密码片段）→ 按敏感文件处理 |
| 没有执行证据（拿不到请求记录）                                                                                                                           | 不下「没有建号」的结论，写状态未知、需人工核对                                                                                                        | 保留                                                                         |

- 「已创建但密码未交接」：这些账号的密码没有完整、可核对地写进交接文件，**不能据此存进 vault**；但交接文件可能已经部分写入（可能含密码片段），所以一律按敏感文件处理——保持 0600、只留在沙箱里、不读出、不外传、不贴进任何记录 / 聊天 / GitHub，保留作证据交站长。不能断言密码「哪里都没有」。处理方式只能是站长批准后经 `--resume --rotate-passwords <邮箱> --confirm-rotate <同一列表>` 显式改密（新密码同样走本节流程）。执行器与 Hark 都**不会**自动重试建号、自动改密或做任何其他写操作来「补」交接。
- N = 0 且证据证明没有建号 / 改密时，被接管账号的密码仍是上次交接 / vault 里的那条；不调用任何 `save_login`，不为凑数改密。
- N = 0 但文件不是空的（本次没写，却有内容）→ 不删，保留并作为收尾错误要求人工核对；Hark 不存、不删，交站长。
- N 以**本次运行的实际交接记录**（运行记录里的那一行 + 文件实际行数）为准，不按上次的 N、也不按账号总数推算。

**执行状态与证据一致（第十二轮，createUsers / rotateAdopted 执行层）。** 写请求一旦**已经发出**，只有服务器的明确回答才能下「生效 / 未生效」的结论：

| 建号 POST / 显式改密 PUT 发出后的结果                              | 结论                                          | 退出码        | 之后                                                              |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| 2xx                                                                | 已生效（账号已建 / 密码已改），写交接行       | —             | 继续下一步                                                        |
| 4xx（例如 422 已存在、403；401 另按凭据拒绝）                      | 显式拒绝，按响应未生效                        | 1（401 为 2） | 立即停止                                                          |
| 5xx、超时、连接断开 / 响应丢失、**发出后收到 3xx**（3xx 永不跟随） | **结果未知**：账号可能已创建 / 密码可能已被改 | **3**         | 立即停止后续一切写；保留已确认 + 未知状态；不自动重试、不隐式改密 |

写之前的安全闸门（预检、C0、准入、交接方式、改密双列表等）拒绝 → 2；确定性失败（例如迁移明确未提交、status 核对不通过）→ 1。不是所有非 0 都映射成 3。
运行记录另有「写端点调用（按本次请求记录）」一节，按请求记录列出已确认 / 被拒 / 结果未知的写请求；「写端点一律未调用」只用于**只读预检阶段**（P0 / P1 / PS），并且同样按请求记录核对。

**交接 / 清理错误不掩盖原执行结果（第十一轮）。** 空交接文件删不掉、交接文件无法核对、运行记录写不出等收尾错误一律单独列为「收尾错误」，运行记录照常保留原执行结论、阶段、逐项结果与清点。

**运行记录（审计记录）写不出时的兜底回执（第十二轮）。** `--record` 写入失败（磁盘满、只读、权限……）时，执行器在 stderr 输出一行以 `{"receipt":"sbtest-run-fallback/v1"` 开头的 JSON，只取**白名单**字段：
`command`、`exit`、`run_id`、`attempt_id`、`phase`、`results`（逐项：文件 / 账号、结论、核对说明、错误，自由文本打码截断）、`confirmed_writes` 与 `unknown_writes`（只有阶段、方法、打码路径、状态）、`inventory`（已打码的清点）、`record_write_failure`（失败原因）。
**第十三轮：逐层白名单。** 每一层都按允许的字段名 + 类型投影，不认识的字段（任意层）直接丢弃，不转储：
`results[]` 只取 `file`（须是 az_init / seed / 迁移文件名 / 合成 PNG / 合成账号）、`outcome`（已知结论）、`http`（第 ① 层）、`verification`（第 ② 层：结论 + 依据）、`verify`、`error`；
`error` 只输出**受控错误码**（`http_status` / `redirect` / `timeout` / `network` / `unauthorized` / `uncertain_shape` / 文件系统码如 `ENOSPC` / `other`）+ 状态类别（`5xx`、`3xx`、`none`……）+ 阶段 + 端点，**不输出服务器原始正文**；
`inventory.items` 只认 `ledger`（file / run_id / 哈希前缀）、`accounts`（合成邮箱 + 打码 id；非合成邮箱隐藏）、`counts`（表名 → 非负整数）、`storage_objects`（打码对象名 + 大小）、`running_sessions`；`inventory.error` 同样只给错误码；
`record_write_failure` 只给错误码。仅剩的自由文本（核对依据）**先**替换已知秘密值（含 URL 编码形式），再按关键字打码（`password: v`、`"password" : "x"`、`token=…`、引号里带空格的值、Bearer、JWT、sb_ 密钥），**最后**才截断——秘密跨截断点也不留前缀。
**第十四轮：执行器统一受控输出（按构造的允许清单）。** 不只是回执——stdout / stderr、正常运行记录、兜底回执、执行器自己的异常消息，所有用户可见文本都只由两类东西拼成：
① 执行器源码字面量（`` S`…` `` 标签模板）；② 受控字段——整数、布尔值，或经 `F.*` 校验器放行的值：阶段、run / attempt id（只认 `YYYYMMDDTHHMMSS-6 位十六进制`）、
文件名（az_init / seed / 本进程钉住清单里的迁移名 / 合成 PNG / 合成账号）、合成邮箱、HTTP 状态、错误码、核对结论、清点计数、主机类别（「Management API（允许清单）」「azsou-test 项目主机」「本机回环地址」「允许清单外的主机」，**不输出完整 URL、主机名、凭据**）、本机交接 / 记录路径。
未经校验器的字符串（服务器正文、任意异常消息 / 对象、Location 主机、请求头……）插进去只会变成 `[已隐藏]`；`Refused` / `Uncertain` 等执行器异常的消息、`safeText()` / `safeJSON()` 输出口都只放行登记过的受控文本。
形状错误只说字段名、类型、行数（例如「identity 的值不确定（类型 string）」）；401 只给分类（no_api_key / invalid_api_key / other）+ 固定说明；只读查询非 2xx 只给状态码；3xx 只给状态码 + 同主机 / 跨主机。
正常运行记录与兜底回执共用同一投影层（`projectResult` / `projectInventory` / 请求记录的路径形状），身份核对与 C0 也按允许清单投影（版本只取数字部分、地址只留第一段、扩展名只列允许清单内的、其余只计数）。
**错误码**（`errorCode`）只从真实 `Error` 对象的 `err.code` 读（undici「fetch failed」再看一层 `cause.code`，同样要求是 `Error`），在允许清单（ENOENT、EACCES、EPERM、ENOSPC、EEXIST、EISDIR、ENOTDIR、EROFS、EMFILE、ECONNRESET、ECONNREFUSED、ETIMEDOUT、EPIPE、ENOTFOUND、EAI_AGAIN……，见 `ERROR_CODES`）内才返回，否则 `other`；
**从不**从消息 / 正文里正则抽取像错误码的文本。结果里的 `error_code` 字段由执行器写入时就是受控码，回执只认它（或第 ① 层 `http`），不解析 `error` 文本。安全性不依赖已知秘密值替换（injected 模式进程里根本没有秘密值），也不靠截断；`redactText` 只作兼容保留，输出路径不再使用。
plan / manifest 两个子命令零网络、只打印本地钉住清单与计划，不在本轮范围内。
**绝不**包含密码、令牌、请求头、完整原始响应、交接文件内容。preflight 与 execute（包括写之前就被拒绝）都一样。这一行就是本次运行的审计依据，保存它，交站长核对；不因此重跑任何写操作。退出码：

| 原执行结果            | 收尾无错误 | 收尾有错误                                                                                                                                                                                                               |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 成功（0）             | 0          | **4（INCOMPLETE）**：原结论成功（execute：V1 全部通过；preflight：预检通过）但必需的交接 / 清理 / 运行记录收尾未完成，不是「完全完成」；云端写操作不需要、也不得重跑，只按收尾错误（运行记录写不出时按兜底回执）人工处理 |
| 失败（1） / 拒绝（2） | 1 / 2      | 1 / 2（不变）                                                                                                                                                                                                            |
| 不确定（3）           | 3          | 3（**绝不**降成 1 或 0）                                                                                                                                                                                                 |

收尾失败从不自动重试建号、改密或任何其他写操作。回归：`tests/unit/sbtest-init-r11.test.ts`（真实本机 CLI 子进程 + 回环假服务器 + 合成数据：建号响应丢失、建号后交接写入失败、原成功 / 原不确定 + 空文件删除失败）；`tests/unit/sbtest-init-r12.test.ts`（发出后 3xx / 5xx → 3、4xx 不变；运行记录写入失败 → 兜底回执、原 1 / 2 / 3 不变、原成功 → 4）；`tests/unit/sbtest-init-r13.test.ts`（回执逐层白名单 / 受控错误码 / 先打码后截断；B0、迁移 / 种子、Storage 写后不确定性与两层结果）；`tests/unit/sbtest-init-r14.test.ts`（统一受控输出：正常记录 / stdout / stderr / 回执都不含服务器正文、异常消息、合成「错误码」ESECRETDEMO42；错误码允许清单）。

1. 执行器结束后，先读本次运行记录「交接与收尾」一节（运行记录没写成 → 读 stderr 里的兜底回执，按「收尾错误」停下交站长，不存、不删、不重跑）：写的是「N = 0（本次请求记录里没有发出任何 Auth Admin 建号 / 改密请求…）」或「…全部被 HTTP 4xx 拒绝…」且没有收尾错误 → 核对文件确实已不存在，到此结束，下面 2–5 步都不做；有「账号状态未知」「交接错误」或「收尾错误」→ 停下交站长人工核对（按上表），不存、不删、不重跑、不改密。N > 0 → Hark 在沙箱里读这个 0600 文件，先核对：行数 = 运行记录里的 N；每行 `project_ref` = `ovvfwkmqlejcpatmfqcd`、`run_id` = 账本 run_id、邮箱在合成清单里且不重复。任何一项不符 → 停下，不存、不删除文件。
2. **对每一行调用一次 Hark 的 `save_login`**（vault 工具），参数只有三项：
   `{"site": "<Preview 登录页所在域名，见下>", "username": "<该行 email>", "password": "<该行 password>"}`。
   Hark 不在聊天里复述密码、不附文件、不写进任何记录；工具返回的只是 vault 条目 id。
   （说明：密码会作为工具调用参数经过 Hark 的工具调用通道——这是存进 vault 的唯一入口，不经过聊天；这些参数在 Hark 平台侧的会话记录 / 日志里保留多久、谁能看到，沙箱里无法确认，按「可能被记录」对待。）
   `site` 应是浏览器验收时**实际输入密码的页面所在域名**（站点自己的 `/login/` 页，也就是候选 Preview 的稳定域名），而不是 `ovvfwkmqlejcpatmfqcd.supabase.co`：
   站点前端用 anon key 从登录页调用 Auth API，用户从不在 `*.supabase.co` 上输入密码，vault 按页面域名匹配自动填写。具体域名在候选 Preview 部署批准后确定。
3. **N 条全部返回 id** 后，Hark 删除文件：同长度随机内容覆盖 → `fsync` → 删除，再确认文件不存在；运行记录只写「已存 N 条 vault 条目（id 前缀）+ 本地文件已覆盖删除」。
   **覆盖删除只是尽力而为，不保证云端残留不可恢复**：`/workspace` 是 Hark 的持久云端工作区，底层存储的快照、副本、写时复制 / 日志型文件系统都可能保留旧块，沙箱里无法核实或清除。
   所以真正的保障是：这批密码只用于隔离测试项目的合成账号；若担心残留，站长可让 Hark 用 `--rotate-passwords` + `--confirm-rotate` 显式改密（新密码同样走本节流程），旧密码随即失效。
4. 站长在 Hark **设置 → 已连接账号（Connected accounts）** 里核对：上一步的 `site` 下有 N 条 `sbtest-*@example.com` 登录，邮箱与运行记录列出的新建 / 改密账号一一对应。之后浏览器验收用这些条目自动填写，不需要任何人看到明文。
5. **部分失败（例如 N = 4 只存进 3 条）**：立即停下，**不删除文件**（保持 0600 在沙箱里），告诉站长哪几条已存（vault id 前缀）、哪几条没存；只补存缺的那几条，全部存完再执行第 3 步。
   **不得**为了「补齐」而重跑执行器、重新建号或改密——任何改密都必须由站长明确要求并走 `--rotate-passwords` / `--confirm-rotate`，不会有静默改密。
   本机演示（假密码、本机 GoTrue、不碰 vault）：`tests/db/sbtest-accounts-gotrue.test.ts`「第八轮 B2 安全交接演示」——生成 → 权限核对 → 逐条 `save_login`（桩，只记调用形状）→ 覆盖删除；记录里没有任何密码。
   （第八轮演示的桩里 `site` 写的是 `ovvfwkmqlejcpatmfqcd.supabase.co`；第九轮起推荐改用 Preview 登录页域名，见第 2 步。桩只记调用形状，不影响演示结论。）

- 密码**不进**日志、运行记录、清点、退出信息、trace（单测断言）。
- 在本机官方 GoTrue（v2.197.0）上证明：`tests/db/sbtest-accounts-gotrue.test.ts` 用执行器同一段代码建号 → 交接文件里的密码能 `grant_type=password` 登录、邮箱已确认、运行标记在 `app_metadata`；`PUT` 改密后旧密码 400、新密码 200；准入端点形状是 `{users:[…]}`。

## 11. 测试

- `tests/unit/sbtest-init-r9.test.ts`（第九轮：V1.cron 严格类型——缺字段 / null / 字符串 "0" / NaN / Infinity / 负数 / 小数 / 数组 / 对象 → 不确定；false/false/0 通过；true 或 > 0 → 不通过；初始化后的非空库不影响）。
  超时：纯逻辑用例用 vitest 默认 5s；只有经 CLI `main` 大量起 git 子进程（每个 42–128 次）的 CLI 用例单独 30s（`SPAWN_TIMEOUT`，第十轮共 10 个：第九轮的 9 个 + 第十轮 N = 0 CLI 用例；第十一轮再加 4 个起 CLI 子进程的用例，共 14 个；第十二轮再加 6 个，共 20 个；第十三轮再加 6 个，共 26 个；第十四轮再加 6 个，共 32 个）。
  「钉住的提交不在本地」只起 2 次 git（单实例、非空闲 37–61 ms），第十轮起回到默认 5s。耗时均为单实例、非空闲（共享 `HEAVY.lock` 下，load1 约 4–6，2 vCPU）实测，不是空闲机器。
- `tests/unit/sbtest-init-r11.test.ts`（第十一轮：N = 0 只表示本次没有成功写入交接行——纯逻辑 5 个用例按默认 5s；4 个用例起真实 CLI 子进程 `node scripts/sbtest/init-executor.mjs execute`（env-token 模式只连本测试进程里的回环 HTTP 假服务器 = 共用 fakeApi 合成状态；文件系统故障用 `tests/fixtures/sbtest/fs-fault.mjs` 预加载注入）：建号响应丢失 → exit 3、写可能已创建 / 状态未知；建号后交接写入失败（ENOSPC）→ exit 3、交接错误列账号、保留文件；原成功 + 空文件删除失败（EACCES）→ exit 4；原不确定 + 删除失败 → 仍 exit 3。这 4 个 CLI 用例各自 30s（`SPAWN_TIMEOUT`）：每个起一个 node 子进程、经 CLI main 读钉住的 19 个迁移（再起 git 子进程）并走回环 HTTP 跑完整执行 / 续跑；单实例、非空闲实测见 docs/audits/evidence/sbtest/round11-2026-10-29.md）。
- `tests/unit/sbtest-init-r12.test.ts`（第十二轮：纯逻辑 5 个用例按默认 5s——进程内假 fetch 下建号 POST 发出后 302 / 307 / 500 / 503 → exit 3、422 → 1、401 → 2；显式改密 PUT 发出后 307 / 503 → 3、403 → 1；兜底回执只含白名单字段、无秘密；运行记录「写端点未调用」只限只读预检阶段；N / 敏感文件措辞。6 个用例起真实 CLI 子进程（各 30s）：建号 POST 发出后 302（Location 指向另一个回环端口，目标收到 0 次请求）→ 3；建号后 503 → 3；改密 PUT 后 307 → 3；原成功 + 运行记录写入失败（ENOSPC 预加载注入）→ 4 + 兜底回执；原不确定 + 记录失败 → 3 + 回执、不含交接文件里的密码；preflight 通过 / 拒绝 + 记录失败 → 4 / 2 + 回执）。
- `tests/unit/sbtest-init-r13.test.ts`（第十三轮：纯逻辑 7 个用例按默认 5s——兜底回执逐层白名单（未知嵌套字段丢弃、非合成邮箱 / 未打码 id 不原样输出、清点仍有用）；错误 → 受控错误码 + 阶段 + 端点 + 状态类别、无服务器正文；redactText 先打码后截断（秘密跨截断点不留 ≥4 字符前缀）、`password: v` / `"password" : "x"` / 带空格引号值 / 无关键字的已知秘密值；B0 发出后 503 / 307 / 断线 × 已提交 / 未提交 → 0 / 3、400 → 1；迁移 / 种子发出后 503 / 307 / 502 × 已提交 / 未提交 → 0 / 1，仍在运行 / 核对请求 307 → 3；Storage 发出后 503 / 307 / 302 / 断线 → 3、409 / 413 → 1，只 1 次上传、不删除；回执两层。全部只用合成秘密（SYNTH-…）。6 个用例起真实 CLI 子进程（各 30s）：B0 已提交 / 未提交 + 503 → 0 / 3；迁移 0007 已提交 + 307（Location 指向另一回环端口，0 次请求）→ 0、未提交 + 503 → 1；Storage 已存储 + 503 → 3；Storage 302 不跟随 → 3；种子已提交 + 502 → 0、断线未提交 → 1；运行记录写入失败 + 迁移 503 已提交 + Storage 503 → 3 + 两层兜底回执）。
- `tests/unit/sbtest-init-r14.test.ts`（第十四轮：纯逻辑 7 个用例按默认 5s——errorCode 允许清单（只读真实 Error 的 err.code / undici cause.code；字符串、普通对象、清单外的码 → other）；形状错误 / 401 分类 / C0 / 账号核对消息不回显服务器值；写后形状错误 / 意外异常 → exit 3 不变、备注只给「意外错误（码）」；通用 401 正文不进准入原因 / 探测结果；回执与正常记录不解析错误文本、只出受控值；按构造：S 插值 / Refused 原始字符串 / controlled() / 源码扫描。6 个用例起真实 CLI 子进程（各 30s）：preflight 通用 401 → 2；preflight 身份形状错误 → 2；0005 503 已提交 + status 形状错误、正常记录写成功 → 3；同场景 + 记录写入失败（清单外码 ESECRETDEMO42）→ 3 + 回执 other；记录 ENOSPC + 种子断线未提交 → 1 + 回执 ENOSPC；交接写入 ENOSPC → 3。四处（stdout / stderr / 记录 / 回执）扫描合成标记。合成值不作为 secrets 传给执行器）。
- `tests/unit/sbtest-init-r10.test.ts`（第十轮：交接 N = 0——种子已提交 + 只补文件、不改密时不建号 / 不改密 / 交接 0 行；运行记录与输出写 N = 0、不需要 save_login；空文件核对后删除；0 行但文件非空 → 保留人工核对；N > 0 文件保留）。
- `tests/unit/sbtest-init-r8.test.ts`（第八轮：共享解析器 / V1.status `[{}]` `[]` / 续跑运行中会话 n 缺失 / status 核对缺字段；交接 run_id = 账本 run_id + attempt_id、符号链接 / 0700 / 0600 / 属主、不隐式改密、显式改密双列表、真实目标禁止 discard；401 分类、403 措辞）。
- `tests/unit/sbtest-init-executor.test.ts`（第五 / 六轮）+ `tests/unit/sbtest-init-r7.test.ts`（第七轮：准入 401/403/5xx/形状、重定向、C0 收紧、超时核对形状、写后意外 → 阶段 / 清点 / 运行记录、种子哈希、种子运行标记、交接文件、续跑接管、矩阵与文档一致、影响清单分组）。
- `tests/db/sbtest-accounts-gotrue.test.ts`：本机 GoTrue，需要 `DATABASE_URL`（与 `npm run test:db` 相同）。
