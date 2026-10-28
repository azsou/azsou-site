# azsou-test 初始化执行器与计划（第五轮，2026-10-28）——**只有 dry-run，未对任何真实项目执行**

> 执行器：`scripts/sbtest/init-executor.mjs`；钉住清单：`ops/sbtest/init-manifest.json`；影响清单：`ops/sbtest/init-impact.md`（数据 `ops/sbtest/init-impact.json`，由 `scripts/sbtest/impact-local.mjs` 在本机生成）。
> 测试：`tests/unit/sbtest-init-executor.test.ts`（假 Management API，不连任何项目）。
> 执行需要站长单独批准（`SBTEST_OWNER_APPROVAL`）；本仓库的 CI / 测试永远不会对真实项目执行。

## 1. 目标与边界

- 只对 **azsou-test（`ovvfwkmqlejcpatmfqcd`）**：执行器硬编码允许清单，任何其他 ref（尤其生产 `abryflgoljltyakthtql`）→ 拒绝（退出码 2）。
- 只对**空**项目：预检（只读）要求 public 无表 / 视图 / 序列 / 函数、private 不存在、auth.users / storage.buckets / storage.objects 为 0、没有 `az_init`。不满足 → 停，**不清空、不覆盖**。
- 不启用 pg_cron、不执行 `db/ops/`；不发任何邮件；合成数据全部 `@example.com`。

## 2. 执行通道：Supabase Management API

| 用途                      | 端点                                                                                                         | 令牌权限                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 令牌范围核对              | `GET https://api.supabase.com/v1/projects`：必须**恰好只**看得到 azsou-test；看得到生产或任何别的项目 → 拒绝 | 细粒度令牌，只授权 azsou-test                     |
| 预检 / 执行后核对（只读） | `POST /v1/projects/{ref}/database/query/read-only`（以 `supabase_read_only_user` 执行，表名须带 schema）     | `database_read`                                   |
| 迁移 / 种子（写）         | `POST /v1/projects/{ref}/database/query`                                                                     | `database_write`                                  |
| 托管账号                  | `POST https://<ref>.supabase.co/auth/v1/admin/users`（`email_confirm: true`，不发邮件）                      | service_role / secret key（`SBTEST_SERVICE_KEY`） |
| 文件                      | `POST https://<ref>.supabase.co/storage/v1/object/ugc-images/<路径>`（`x-upsert: false`）                    | 同上                                              |

令牌 / key 只经 vault 注入请求头，不打印、不写文件。两个 Management API 端点在官方文档中标为 Beta / experimental。

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
DATABASE_URL=postgres://postgres@127.0.0.1:<端口>/postgres node scripts/sbtest/impact-local.mjs   # 重新生成影响清单（只连本机库）
# 只有站长批准后：
SBTEST_OWNER_APPROVAL='<批准记录>' SBTEST_MGMT_TOKEN=… SBTEST_SERVICE_KEY=… \
  node scripts/sbtest/init-executor.mjs execute --execute --confirm-ref ovvfwkmqlejcpatmfqcd
```
