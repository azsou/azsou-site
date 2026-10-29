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

## 4. 每个文件一个事务 + 超时 + 「提交了没有」核对（第七轮 ③ 收紧）

- 每个迁移文件本身以单独一行 `begin;` 开头、`commit;` 结尾（执行器校验各恰好一次，否则拒绝）。执行器去掉这两行，换成：
  `begin; set local statement_timeout = '300s'; set local lock_timeout = '15s'; set local application_name = 'az-init:<运行 id>:<文件>'; <正文>; insert into az_init.applied (run_id, file, sha256) …; commit;`
- **种子事务同样带运行标记**：`set local lock_timeout`、`set local application_name = 'az-init:<运行 id>:seed'`，超时核对与迁移完全相同。
- HTTP 失败 / 断线 / 客户端超时（330 s）后，执行器先用只读端点查 `{ledger, running}`：
  - 两个字段都必须是非负整数，否则（`[{}]`、`[]`、缺键、`null`、账本行数 > 1）→ **不确定（unknown）**，退出码 3——**绝不当成「未提交」**；
  - `running > 0` → 仍在跑，退出码 3；`ledger = 1` → 已提交，继续；`ledger = 0` 且 `running = 0` → 未提交，退出码 1。
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

**N = 交接文件的实际行数** = 本次运行**真正新建**的账号 + 经 `--rotate-passwords` / `--confirm-rotate` **显式改密**的账号。被接管但没改密的账号不在文件里（它们的密码仍是上次交接 / vault 里的那条）。
N 可以是 0–4 中任何一个数（全新执行通常是 4，部分账号续跑可能是 1–3），**不是固定 4 条**；执行器的运行记录与输出写明本次实际的 N。

**N = 0（第十轮）**：账号与种子都已完成、本次只补文件的续跑，且**没有**显式改密（没有 `--rotate-passwords` / `--confirm-rotate`）——本次没有新建账号、没有改密，交接文件实际 0 行。
此时**不调用任何 `save_login`**、**不为凑数改密**（不重跑、不新建、不改密去「补」出 N 条）；被接管账号的密码仍是上次交接 / vault 里的那条。
执行器核对空交接文件仍是 0 字节的普通文件后直接删除，运行记录与输出写「账号密码交接：N = 0 …不需要任何 save_login / vault 保存，不得为凑数改密；空交接文件 … 已核对为 0 字节并删除」，不会留下一个看起来需要存进 vault 的文件。
N = 0 但文件不是空的（本次没写，却有内容）→ 执行器不删，保留并写明需要人工核对；Hark 不存、不删，交站长。
N 以**本次运行的实际交接记录**（运行记录里的那一行 + 文件实际行数）为准，不按上次的 N、也不按账号总数推算。

1. 执行器结束后，先读本次运行记录里的交接行：写的是 N = 0 → 按上面 N = 0 处理（核对文件确实已不存在），到此结束，下面 2–5 步都不做。N > 0 → Hark 在沙箱里读这个 0600 文件，先核对：行数 = 运行记录里的 N；每行 `project_ref` = `ovvfwkmqlejcpatmfqcd`、`run_id` = 账本 run_id、邮箱在合成清单里且不重复。任何一项不符 → 停下，不存、不删除文件。
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
  超时：纯逻辑用例用 vitest 默认 5s；只有经 CLI `main` 大量起 git 子进程（每个 42–128 次）的 CLI 用例单独 30s（`SPAWN_TIMEOUT`，第十轮共 10 个：第九轮的 9 个 + 第十轮 N = 0 CLI 用例）。
  「钉住的提交不在本地」只起 2 次 git（单实例、非空闲 37–61 ms），第十轮起回到默认 5s。耗时均为单实例、非空闲（共享 `HEAVY.lock` 下，load1 约 4–6，2 vCPU）实测，不是空闲机器。
- `tests/unit/sbtest-init-r10.test.ts`（第十轮：交接 N = 0——种子已提交 + 只补文件、不改密时不建号 / 不改密 / 交接 0 行；运行记录与输出写 N = 0、不需要 save_login；空文件核对后删除；0 行但文件非空 → 保留人工核对；N > 0 文件保留）。
- `tests/unit/sbtest-init-r8.test.ts`（第八轮：共享解析器 / V1.status `[{}]` `[]` / 续跑运行中会话 n 缺失 / status 核对缺字段；交接 run_id = 账本 run_id + attempt_id、符号链接 / 0700 / 0600 / 属主、不隐式改密、显式改密双列表、真实目标禁止 discard；401 分类、403 措辞）。
- `tests/unit/sbtest-init-executor.test.ts`（第五 / 六轮）+ `tests/unit/sbtest-init-r7.test.ts`（第七轮：准入 401/403/5xx/形状、重定向、C0 收紧、超时核对形状、写后意外 → 阶段 / 清点 / 运行记录、种子哈希、种子运行标记、交接文件、续跑接管、矩阵与文档一致、影响清单分组）。
- `tests/db/sbtest-accounts-gotrue.test.ts`：本机 GoTrue，需要 `DATABASE_URL`（与 `npm run test:db` 相同）。
