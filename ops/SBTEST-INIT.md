# azsou-test 初始化执行器与计划（第五轮 2026-10-28，第六轮 / 第七轮 2026-10-29 更新）——**未执行初始化；只做过只读预检**

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
运行记录只写状态与返回条数，不写用户数据。2026-10-29 的真实只读结果：**不接受（401，apikey 没有注入）**——见 `docs/audits/evidence/sbtest/readonly-admission-2026-10-29.md`。

**不跟随重定向（第七轮 ②）**：每个请求都以 `redirect: 'manual'` 发出；任何 3xx（同主机或跨主机）→ 拒绝（退出码 2），不向 Location 发请求。
线路注入只按主机名绑定，跟随跨主机重定向可能把请求带到另一条绑定上。2026-10-29 无凭据实测 `api.supabase.io` 的 `/`、`/v1/projects/{ref}`、`/v1/projects` 都没有重定向（最终主机仍是 `api.supabase.io`，见 `credential-binding-2026-10-29.md`）。

**凭据模式**（`--mode` / `SBTEST_CRED_MODE`）：

- `injected`（真实运行默认）：执行器**不带 Authorization / apikey 头**，vault 按主机名在线路上注入。进程环境里**不需要也不允许**
  `SBTEST_MGMT_TOKEN` / `SBTEST_SERVICE_KEY`（出现即拒绝）。Management API 基址只允许 `https://api.supabase.io`，项目基址只允许
  `https://ovvfwkmqlejcpatmfqcd.supabase.co`（`SBTEST_MGMT_BASE` / `SBTEST_PROJECT_BASE` 可设，但出了允许清单就拒绝）。
  **`api.supabase.com` 是公共 Management API 域名**（不是「生产 API」）：当前有一个生产范围的连接器绑在上面，而 vault 里 azsou-test 只读 PAT 的范围也写着它，
  线路上注入哪一条不可枚举——所以执行器在任何模式下都不向它发请求；任何含生产 ref 的基址拒绝。
  任何请求得到 **401 = 线路上没有注入凭据 → 拒绝（退出码 2）**，不当成执行失败、不重试；写操作开始后的 401 附打码清点。
  沙箱里 Node 的全局 `fetch` 默认不走注入代理：运行时加 `NODE_USE_ENV_PROXY=1`（不加就会 401 → 拒绝）。
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
# 部分完成后的受控续跑：同上加 --resume（交接文件换一个新路径；已存在的文件不覆盖）
```

`execute` **必须显式选择交接方式**：`--handoff-file <仓库外绝对路径>` 或 `--handoff discard`；都没给 → 拒绝（2），一个请求都不发。

## 8. 执行后验收 V1（第六轮 ③，成功的唯一条件）

`execute` 在 F1 之后自动跑 V1（全部只读 + Storage 下载）；**7 项全部通过才返回 0**，任何一项不通过 → 1：

| 项          | 内容                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1.cron     | 没有 pg_cron 扩展、没有 cron schema / 任务                                                                                                              |
| V1.status   | `db/verify/status.sql` 全为 true                                                                                                                        |
| V1.objects  | `init-impact.json` 里 public / private / storage / auth 的每个对象都存在（341 个中除 extensions 函数），且 pg_trgm 扩展存在                             |
| V1.ledger   | `az_init.applied` 恰好 20 行：0001–0019 名称与 sha256 = 清单；seed 1 行且 **sha256 = 按真实账号 id + run_id 重算的期望种子哈希**；run_id 一致；无未知行 |
| V1.accounts | 4 个合成账号存在、邮箱已确认、只有 email 身份；角色 admin / moderator / user / user + banned（且有生效封禁）                                            |
| V1.seed     | 种子相关表行数 = 影响清单期望（迁移自带行 + 账号行 + 种子新增行）                                                                                       |
| V1.storage  | ugc-images 恰好 2 个对象，路径 = `<测试用户 id>/<文件名>`，重新下载 sha256 一致                                                                         |

## 9. 失败处理、清点与续跑矩阵（第七轮 ③④）

- 写操作开始后任何非成功出口（失败 1 / 不确定 3 / 写后被拒 2 / V1 不通过 1 / 意外异常 3）都返回并写进运行记录：**阶段**（P0 / P1 / PS / B0 / 0001…0019 / U1 / S1 / F1 / V1）、
  **逐项已知结果**（文件 / 账号 / 对象 + 结果，不含正文与密码）、**打码资源清点**（账本行、合成账号 + 打码 id、种子表行数、Storage 对象、仍在运行的 az-init 会话数）。查不到的项标 `unknown`，整体状态 `unknown`，**不推断**。
- **从不自动重试，从不清空 / 删除测试项目或账号。** 人工核对后才 `--resume`。
- 「账号部分建成」与「4 个账号已建、种子未提交」不再要求人工删除：续跑按运行标记核对后**接管**（§10）。

续跑矩阵（`RESUME_MATRIX`，与代码逐字一致，单测核对）：

| 状态                                                                      | 续跑动作                                 |
| ------------------------------------------------------------------------- | ---------------------------------------- |
| 没有 az_init（B0 前失败）                                                 | --resume 拒绝；C0 仍为空时按全新执行     |
| 账本为空（B0 已提交、无迁移）                                             | 拒绝：人工核对后决定                     |
| 账本是清单的严格前缀                                                      | 从下一个迁移续跑，沿用原 run_id          |
| 账本乱序 / 未知文件 / sha256 不符 / 多个 run_id                           | 拒绝：人工处理                           |
| 仍有 az-init 会话在运行                                                   | 拒绝：等会话结束后人工确认               |
| pg_cron 已启用                                                            | 拒绝：状态与执行器不符                   |
| 迁移未完成却已有合成账号                                                  | 拒绝：状态矛盾                           |
| 部分账号已建（1–3 个）、种子未提交                                        | 逐个核对后接管，补建缺的账号，再提交种子 |
| 4 个账号已建、种子未提交                                                  | 全部核对后接管，不建号，提交种子         |
| 已有账号核对不通过（运行标记缺失或不符、未确认、非 email 身份、名称不符） | 拒绝接管：人工核对，不删除账号           |
| 种子已提交、合成账号不是 4 个                                             | 拒绝：状态矛盾                           |
| 种子已提交、账本哈希 ≠ 期望种子哈希                                       | 拒绝：人工处理（哈希不符）               |
| 种子已提交、文件缺失或部分上传                                            | 只补传缺的文件，再跑 V1                  |
| 已存在的文件内容不符                                                      | 拒绝：不覆盖                             |

续跑前的人工核对步骤（全部只读）：

1. `preflight --record <md>`：准入必须「接受」，C0 形状有效。
2. 看上次运行记录里的**阶段**与**清点**；对照账本（`az_init.applied`）、`auth.users` 里 4 个 `sbtest-*@example.com` 的 `raw_app_meta_data->>'az_init_run'`、`email_confirmed_at`、`auth.identities.provider`。
3. 清点为 `unknown` 或有 az-init 会话在跑时，等会话结束（`pg_stat_activity`）再重新清点；仍不确定就停下交站长。
4. 符合矩阵里的「续跑」行才加 `--resume`，并给一个**新的**交接文件路径。

## 10. 测试账号：无邮件路径与凭据交接（第七轮 ④）

- **不依赖任何邮件**：`@example.com` 收不到信，重置邮件 / 魔法链接都不可用，也不该用。
- 建号：执行器用 `crypto.randomBytes(18)`（24 字符 base64url）生成密码，经 `POST /auth/v1/admin/users` 一次设置：
  `{ email, password, email_confirm: true, user_metadata: { name }, app_metadata: { az_init_run: <运行 id> } }`。不发信。
- 接管（续跑）：核对邮箱属于合成清单、`app_metadata.az_init_run` = 账本 run_id、邮箱已确认、只有 email 身份、名称一致；用 `--handoff-file` 时再经 `PUT /auth/v1/admin/users/{id}` `{ password }` 换新密码（原密码在上次运行里已丢弃或已在旧交接文件里）。
- 交接：`--handoff-file <仓库外绝对路径>`——目录不存在则以 0700 创建（已存在且他人可写 → 拒绝），文件以 `wx` + 0600 创建（已存在 → 拒绝，不覆盖），每行 `{email, password, user_id, project_ref, run_id, set_at}`。
  站长把 4 条导入 vault（Hark Secured Login，按账号各存一条），确认后删除文件。`--handoff discard` 则密码用完即丢（之后要登录只能再跑一次带交接文件的续跑换密码）。
- 密码**不进**日志、运行记录、清点、退出信息、trace（单测断言）。
- 在本机官方 GoTrue（v2.197.0）上证明：`tests/db/sbtest-accounts-gotrue.test.ts` 用执行器同一段代码建号 → 交接文件里的密码能 `grant_type=password` 登录、邮箱已确认、运行标记在 `app_metadata`；`PUT` 改密后旧密码 400、新密码 200；准入端点形状是 `{users:[…]}`。

## 11. 测试

- `tests/unit/sbtest-init-executor.test.ts`（第五 / 六轮）+ `tests/unit/sbtest-init-r7.test.ts`（第七轮：准入 401/403/5xx/形状、重定向、C0 收紧、超时核对形状、写后意外 → 阶段 / 清点 / 运行记录、种子哈希、种子运行标记、交接文件、续跑接管、矩阵与文档一致、影响清单分组）。
- `tests/db/sbtest-accounts-gotrue.test.ts`：本机 GoTrue，需要 `DATABASE_URL`（与 `npm run test:db` 相同）。
