# azsou-test 初始化执行器与计划（第五轮 2026-10-28，第六轮 2026-10-29 更新）——**未执行初始化；只做过只读预检**

> 执行器：`scripts/sbtest/init-executor.mjs`；钉住清单：`ops/sbtest/init-manifest.json`；影响清单：`ops/sbtest/init-impact.md`（数据 `ops/sbtest/init-impact.json`，由 `scripts/sbtest/impact-local.mjs` 在本机生成）。
> 测试：`tests/unit/sbtest-init-executor.test.ts`（假 Management API，不连任何项目）。
> 执行需要站长单独批准（`SBTEST_OWNER_APPROVAL`）；本仓库的 CI / 测试永远不会对真实项目执行。

## 1. 目标与边界

- 只对 **azsou-test（`ovvfwkmqlejcpatmfqcd`）**：执行器硬编码允许清单，任何其他 ref（尤其生产 `abryflgoljltyakthtql`）→ 拒绝（退出码 2）。
- 只对**空**项目：预检（只读）要求 public 无表 / 视图 / 序列 / 函数、private 不存在、auth.users / storage.buckets / storage.objects 为 0、没有 `az_init`。不满足 → 停，**不清空、不覆盖**。
- 不启用 pg_cron、不执行 `db/ops/`；不发任何邮件；合成数据全部 `@example.com`。

## 2. 执行通道与凭据（第六轮 ①②）

| 用途                       | 端点                                                                                                                               | 凭据（线路注入）                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 目标身份                   | `GET https://api.supabase.io/v1/projects/{ref}`：ref / name `azsou-test` / region `ap-southeast-1` / `ACTIVE_HEALTHY` 必须完全一致 | 项目级 PAT（只读即可）                             |
| 范围记录（不依赖）         | `GET /v1/projects`：**403 记为 project-scoped、照常继续**；200 时必须只看得到 azsou-test（看得到生产 / 别的 → 拒绝）               | 同上                                               |
| 预检 / 验收 / 清点（只读） | `POST /v1/projects/{ref}/database/query/read-only`（以 `supabase_read_only_user` 执行）                                            | 项目级 PAT：Database read                          |
| 迁移 / 种子（写）          | `POST /v1/projects/{ref}/database/query`                                                                                           | 项目级 PAT：Database write（**另批，现在不申请**） |
| 托管账号                   | `POST https://ovvfwkmqlejcpatmfqcd.supabase.co/auth/v1/admin/users`（`email_confirm: true`，不发邮件）                             | service_role / secret key：`apikey` 头（+ Bearer） |
| 文件                       | `POST …/storage/v1/object/ugc-images/<路径>`（`x-upsert: false`）；验收 `GET …/storage/v1/object/authenticated/…`                  | 同上                                               |

**凭据模式**（`--mode` / `SBTEST_CRED_MODE`）：

- `injected`（真实运行默认）：执行器**不带 Authorization / apikey 头**，vault 按主机名在线路上注入。进程环境里**不需要也不允许**
  `SBTEST_MGMT_TOKEN` / `SBTEST_SERVICE_KEY`（出现即拒绝）。Management API 基址只允许 `https://api.supabase.io`，项目基址只允许
  `https://ovvfwkmqlejcpatmfqcd.supabase.co`（`SBTEST_MGMT_BASE` / `SBTEST_PROJECT_BASE` 可设，但出了允许清单就拒绝）。
  **`api.supabase.com` 归生产 PAT 连接器，任何模式都不向它发请求**；任何含生产 ref 的基址拒绝。
  任何请求得到 **401 = 线路上没有注入凭据 → 拒绝（退出码 2）**，不当成执行失败、不重试；写操作开始后的 401 附打码清点。
  沙箱里 Node 的全局 `fetch` 默认不走注入代理：运行时加 `NODE_USE_ENV_PROXY=1`（不加就会 401 → 拒绝，见证据 `readonly-channel-2026-10-29-no-injection.md`）。
- `env-token`：只给本机假服务器测试；基址必须是回环地址，所以真实令牌永远到不了真实主机。

运行记录（`--record <md>`）只写方法 / 路径 / 状态 / 耗时 + 目标身份 / 范围 / 打码身份 / C0，不写请求头、正文、令牌。

**Management API 不是 pg_dump / pg_restore 通道。** 备份恢复演练（统一快照 pg_dump、精确恢复进新的空目标）需要 Postgres 协议，**恢复演练的执行通道仍未决定**（候选：GitHub Actions 一次性作业 + 仅测试用 Environment Secret，或站长本机）；目标也必须是另一个全新的空项目，azsou-test 永不清空。

## 3. 钉住源 SHA 与迁移文件

- `ops/sbtest/init-manifest.json` 记录 `source_sha`（完整 40 位）与 `db/migrations/0001…0019` 每个文件的 sha256 / 字节数，以及 `db/verify/status.sql` 的 sha256。
- 执行器**从 git 对象库**读 `source_sha` 下的文件（不读工作区），逐个比对清单：文件不是恰好 0001–0019、任何哈希 / 大小不符 → 拒绝。
- 换候选版本时：`node scripts/sbtest/init-executor.mjs manifest --source-sha <新 SHA> --write`，清单变化随 PR 审阅。

| 文件                                                                                                                                                                      | sha256 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 见 `ops/sbtest/init-manifest.json`（当前钉住 `5121b1ae9c41bc0ad13a2093c7729e333039089a`，即 PR #5 第四轮头；迁移内容与整合候选相同，执行前以最终候选 SHA 重新生成并比对） |        |

## 4. 每个文件一个事务 + 超时 + 「提交了没有」核对

- 每个迁移文件本身以单独一行 `begin;` 开头、`commit;` 结尾（执行器校验各恰好一次，否则拒绝）。执行器去掉这两行，换成：
  `begin; set local statement_timeout = '300s'; set local lock_timeout = '15s'; set local application_name = 'az-init:<运行 id>:<文件>'; <正文>; insert into az_init.applied (run_id, file, sha256) …; commit;`
- 账本行与迁移在**同一事务**里。HTTP 失败 / 断线 / 客户端超时（330 s）后，执行器先用只读端点查：
  - 账本有该文件的行 → **已提交**，继续下一个；
  - 账本没有、`pg_stat_activity` 里也没有 `az-init:<运行 id>:<文件>` 的活动会话 → **未提交**，停（退出码 1）；
  - 会话还在跑，或核对本身失败 → **不确定**，停（退出码 3），**不重试**，交人工核对。
- 每个文件提交后跑 `db/verify/status.sql`：该步及之前全为 true 才继续。

## 5. 合成账号、内容、文件

| 项      | 内容                                                                                                                                                     | 通道                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 账号 ×4 | `sbtest-admin@example.com`（admin）、`sbtest-moderator@example.com`（moderator，新增）、`sbtest-user@example.com`、`sbtest-banned@example.com`（banned） | Auth Admin API，随机密码只在本次运行内存里 |
| 内容    | 主题 2、回复 1、评论 1、举报 1、封禁 1、留言 2、友链 1、订阅 1（单事务，引用 Admin API 返回的真实用户 id）                                               | `database/query`                           |
| 文件 ×2 | `ugc-images/<测试用户 id>/202610-sbtest-{a,b}-1x1.png`（sha256 见影响清单）                                                                              | Storage API                                |

**不直接写 `auth.users` / `auth.identities`，不伪造 OAuth 身份**——真实 GitHub OAuth 登录只能由 I01 的人工证据证明（`docs/audits/evidence/batch1/i01/manual-evidence.md`）。

## 6. 影响清单

`ops/sbtest/init-impact.md`：迁移新建的每个对象（本机按同一 SHA 跑前后的系统目录差异，341 个对象 / 15 组）、迁移写入的行、执行器账本、账号、内容种子的实测行数（含触发器产生的通知 / 封禁同步）、桶与文件（sha256），每项的可逆方式。迁移没有 down 脚本：整体回退 = 删除 / 重建 azsou-test（站长操作）。

## 7. 用法

```bash
node scripts/sbtest/init-executor.mjs plan [--out <目录>]          # dry-run：零网络，核对钉住 + 打印计划 + 写 plan.json / impact.md
NODE_USE_ENV_PROXY=1 node scripts/sbtest/init-executor.mjs preflight [--probe-project] --record docs/audits/evidence/sbtest/readonly-channel-<日期>.md
                                                                   # 只读：目标身份 + 范围 + 身份 + C0（同一执行器、同一段代码）
DATABASE_URL=postgres://postgres@127.0.0.1:<端口>/postgres node scripts/sbtest/impact-local.mjs   # 重新生成影响清单（只连本机库）
# 只有站长批准、且写权限 PAT 与 service_role 绑定就位后：
SBTEST_OWNER_APPROVAL='<批准记录>' NODE_USE_ENV_PROXY=1 \
  node scripts/sbtest/init-executor.mjs execute --execute --confirm-ref ovvfwkmqlejcpatmfqcd --record <md>
# 部分完成后的受控续跑（同上，加 --resume）
```

## 8. 执行后验收 V1（第六轮 ③，成功的唯一条件）

`execute` 在 F1 之后自动跑 V1（全部只读 + Storage 下载）；**7 项全部通过才返回 0**，任何一项不通过 → 1：

| 项          | 内容                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| V1.cron     | 没有 pg_cron 扩展、没有 cron schema / 任务                                                                                  |
| V1.status   | `db/verify/status.sql` 全为 true                                                                                            |
| V1.objects  | `init-impact.json` 里 public / private / storage / auth 的每个对象都存在（341 个中除 extensions 函数），且 pg_trgm 扩展存在 |
| V1.ledger   | `az_init.applied` 恰好 20 行：0001–0019 名称与 sha256 = 清单；seed 1 行（种子 SQL 自身 sha256）；run_id 一致；无未知行      |
| V1.accounts | 4 个合成账号存在、邮箱已确认、只有 email 身份；角色 admin / moderator / user / user + banned（且有生效封禁）                |
| V1.seed     | 种子相关表行数 = 影响清单期望（迁移行 + 账号行 + 种子增量）                                                                 |
| V1.storage  | ugc-images 恰好 2 个对象，路径 = `<测试用户 id>/<文件名>`，重新下载 sha256 一致                                             |

C0（执行前）：无业务表 / 函数、无 private / supabase_migrations / az_init、无 pg_cron / cron 任务、auth 用户 / 身份 / 会话 / 刷新令牌与 storage 桶 / 对象为 0。

## 9. 部分完成、超时、续跑

- 写操作开始后任何非成功出口（失败 1 / 不确定 3 / 写后被拒 2 / V1 不通过 1）都附**打码资源清点**：账本行（文件、run_id、sha256 前 12 位）、合成账号（邮箱 + 打码 id）、种子表行数、Storage 对象（用户 id 打码）、仍在运行的 az-init 会话数。查不到的项标 `unknown`，整体状态 `unknown`，**不推断**。
- **从不自动重试，从不清空 / 删除 / 重建 azsou-test。**
- `--resume`：只在 `az_init` 存在时可用。拒绝条件（交人工处理）：账本不是清单的严格前缀（乱序 / 未知文件 / sha256 不符）、多个 run_id、seed 早于迁移完成、仍有 az-init 会话、种子未提交却已有部分合成账号、种子已提交但账号不是 4 个、status.sql 到账本那一步有未生效项、已存在的 Storage 对象内容不符（不覆盖）。通过后沿用原 run_id 从下一个文件继续，已存在且内容一致的文件跳过，最后跑 V1。
- 全新执行遇到已有 `az_init` → 拒绝并提示 `--resume`。

## 10. 测试账号凭据交接

- 4 个账号的密码由执行器用 `crypto.randomBytes(18)` 生成，只出现在 Auth Admin 建号请求体里；**不进日志、运行记录、清点、退出信息**（单测断言）。
- 默认 `handoff = 'discard'`：建号后密码即丢弃。需要登录时由站长在 Supabase Dashboard（Authentication → Users → 该用户 → Reset password / Send magic link，收件箱人工收信）重置，或由 Hark 先用 vault 表单（Hark Secured Login）收集站长选定的密码，再经 `PUT /auth/v1/admin/users/{id}`（service_role 线路注入）设置——密码只在 vault 与请求体里。
- 可选 `handoff = { write(email, password) }`：调用方提供安全通道（例：每个账号直接 `save_login` 进 vault），执行器不落盘。CLI 默认不开启。

## 11. 测试

`tests/unit/sbtest-init-executor.test.ts`（42 条，有状态假服务器）：凭据通道（不带头、401 拒绝、主机允许清单、env-token 只回环、injected 环境有令牌拒绝）、权限预检（403 列项目照常继续；名称 / ref / 区域 / 状态不符拒绝；200 看得到生产拒绝）、V1 每一项失败都非零、超时 → unknown 清点、建号超时 → unknown 清点、续跑各分支、密码不外泄、dry-run 零网络。
