# 数据备份、导出与换库

v2 的数据分两类：

| 类型                                                                                               | 存放                                             | 备份方式                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| 官方内容（应用 / 游戏 / 文章 / 作品 / 论坛种子 / 页面）                                            | Git（`src/content/`、`src/data/`、`src/pages/`） | Git 本身；后台「官方内容」页只读并链接到 GitHub 编辑页         |
| 用户内容与站点状态（主题、回复、评论、资料、点赞、收藏、举报、通知、审计日志、封禁记录、站点设置） | Postgres（目前是 Supabase）                      | 下面的 `pg_dump`；后台「导入导出」页另可导出 UGC 的 JSON / CSV |

## 1. 后台导出（快速、无需数据库凭据）

管理员 → `/admin/data/`：

- **导出全部（JSON）**：`forum_threads`、`forum_replies`、`comments`（含已隐藏）与 `profiles`（昵称 / 角色 / 封禁 / 注册时间）。
  **不含邮箱或任何认证信息**——邮箱只在 `auth.users`，导出接口读不到。
- **CSV**：每张表一份，UTF-8 BOM（Excel 直接打开），单元格防公式注入（`=`、`+`、`-`、`@` 开头加 `'`）。
- **站点设置**：导出 / 导入 `site_content`（`kind = 'setting'`）的 JSON；导入前校验与清洗，只接受 `announcement` / `forum` / `registration`。

这类导出适合留档或迁移内容，但**不是完整备份**（不含审计日志、举报、通知、封禁记录、点赞 / 收藏、函数与策略）。

## 2. 完整备份：pg_dump

连接串：Supabase Dashboard → Project Settings → Database → Connection string（用 _Session pooler_ 或直连；`pg_dump` 不能走 Transaction pooler）。

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres'

# ① 结构 + 数据（public schema），自定义格式，便于选择性恢复
pg_dump "$DATABASE_URL" --schema=public --no-owner --no-privileges \
  --format=custom --file="azsou-$(date +%F).dump"

# ② 只要数据（结构由 db/migrations 重建，推荐用于换库）
pg_dump "$DATABASE_URL" --schema=public --data-only \
  --format=custom --file="azsou-data-$(date +%F).dump"

# ③ 用户账户（auth.users，含邮箱与密码哈希）——只在换库且要保留登录时需要，妥善保管
pg_dump "$DATABASE_URL" --schema=auth --table=auth.users --data-only \
  --format=custom --file="azsou-auth-users-$(date +%F).dump"
```

建议：本地 `pg_dump` 版本 ≥ 服务器版本（Supabase 目前是 Postgres 15/17）；备份文件加密存放（`gpg -c`），不要提交进仓库。

### 受保护的手动备份（GitHub Actions，站长第三轮 2026-10-28）

工作流 `.github/workflows/db-backup.yml`（脚本 `scripts/db-backup.sh`，本地也能直接用）：

| 项目 | 设置                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发 | **仅手动触发**（`workflow_dispatch`），没有任何定时；运行时必须在输入框里亲手输入项目 ref，与 Secret 指向的项目不一致就拒绝                         |
| 闸门 | job 在环境 **`backup-production`** 里运行（必需审批人 = 站长，每次运行先等审批）；`scripts/ops/backup-guard.sh` 检查环境变量 / Secret / ref，见 §2E |
| 快照 | 统一快照：一个持有中的 REPEATABLE READ 只读事务导出快照，所有范围的 pg_dump 与清单都用它；manifest 记快照 id / LSN / 时间                           |
| 内容 | 见 §2B「恢复范围」：public / private / auth / storage 表与策略 / **Storage 文件本体** / globals / 逐表校验和 / 行数 / manifest / SHA256             |
| 加密 | **强制**：全部产物 gpg AES256 对称加密，上传前闸门 `scripts/ops/assert-encrypted.sh` 只放行 `.gpg`；解密：`gpg -d 文件.gpg > 文件`                  |
| 保留 | 产物 `db-backup-<run id>`，**保留 30 天**                                                                                                           |
| 并发 | `concurrency: db-backup`（不取消进行中的备份）；权限只有 `contents: read`                                                                           |

- 每日定时、外部存储上传、独立监控：在 `ops/disabled-workflows/`（GitHub 不运行这个目录），**默认不启用，另行启用**，每项都要站长单独批准、单独 PR（见该目录的 README）。
- 批量删除、导入、生产迁移之前，先手动运行一次。

### 2A. RPO / RTO：站长目标、现状与差距（2026-10-27，第三轮更新）

站长目标（2026-10-27 定稿）：**RPO ≤ 1 小时**（最多丢 1 小时数据）、**RTO ≤ 4 小时**（4 小时内恢复服务）、
**独立加密备份至少保留 30 天**、内容版本历史保留 90 天。

| 项目           | 目标              | 现状（只写已经存在的东西）                                                                                                                                                                          | 差距                                 |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 自动备份频率   | 至少每小时        | 站长第三轮决定：备份工作流**仅手动触发**（受保护环境审批），定时模板在 `ops/disabled-workflows/`，另行启用；工作流还不在 `main` 上、环境未创建。截至 2026-10-28，仓库里**没有任何一份生产备份产物** | 现在 = 没有自动备份                  |
| 平台备份       | —                 | 项目在 Supabase 免费档：没有平台自带的每日备份，也没有 PITR（Supabase 官方：Pro 及以上才有每日备份，PITR 是另付费的附加项）                                                                         | 无                                   |
| RTO            | ≤ 4 小时          | 精确恢复（`scripts/db-restore.sh`）在本机 / CI 每次都演练，演练库几秒内恢复完；Storage 文件往返只在本地真实 storage-api 上测过；**从未用真实生产备份演练**，新建 Supabase 项目 + 配置的耗时也没实测 | 未验证                               |
| 备份保留       | ≥ 30 天、独立加密 | artifact `retention-days: 30`；强制 gpg AES256。仓库级「Artifact and log retention」上限需要站长确认 ≥ 30 天；artifact 与仓库同在 GitHub，外部存储副本模板（`backup-offsite.yml`）默认不启用        | 仓库级设置待确认；没有第二个存放位置 |
| 恢复演练吞错误 | 任何失败都标红    | `tests/ops/drill-negative.sh` 52 个负面 / 对照用例每次 CI 运行（含精确恢复 / 显式升级的拒绝路径）                                                                                                   | 无                                   |

**结论：RPO ≤ 1 小时、RTO ≤ 4 小时目前都没有达到，不能对外这样写。**

#### 待站长批准的方案（本仓库没有改任何生产设置，下面任何一项都需要批准后由站长执行）

| 方案 | 做法                                                                                                                    | RPO                                                            | 费用 / 代价                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A    | Supabase 升级 Pro + 开启 PITR 附加项（保留 7 天）                                                                       | 秒级～分钟级（WAL 连续归档）                                   | Pro 月费 + PITR 附加约 $100/月（7 天档），且要求至少 Small 计算规格；开启 PITR 后平台不再做每日备份（PITR 取代） |
| B    | 另行启用一个**每小时**定时（仿 `ops/disabled-workflows/db-backup-daily.yml` 改 cron，未启用），产物加密、保留 30 天     | 名义 ≤ 1 小时；GitHub 定时任务高峰期会延迟甚至跳过，**不保证** | 免费额度内的 Actions 分钟数；30 天 ≈ 720 份产物，需核对账户的 Actions 存储额度；每小时对生产库做一次 pg_dump     |
| C    | A + 另行启用定时（默认不启用）的独立加密 pg_dump 到 GitHub artifact（以及站长自己的异地存储），满足「独立备份 ≥ 30 天」 | 同 A                                                           | A 的费用                                                                                                         |

建议：预算允许选 **C**（RPO 有平台保证、另有独立副本）；否则选 **B**，并加一个独立于 GitHub 的心跳监控
（例如外部 uptime 服务检查最近一次备份产物时间），把「GitHub 跳过定时」变成可见的告警。
批准后：按 `docs/release/` 的放行申请格式另提一份「备份频率变更」申请，先在 `v2/astro` 手动运行通过、
下载产物用 `scripts/db-verify-backup.sh … --restore <本机库>` 实测恢复耗时，再改定时。

### 2B. 恢复范围（方案 C 仓库侧；站长第三轮：统一快照 + Storage 文件纳入恢复范围）

方案 C = **Supabase PITR（付费附加项）+ 独立加密 dump**。仓库这边只做「独立加密 dump」；
**PITR 附加项的购买 / 开启、生产环境与 Secret、生产执行均未做，待站长批准**（见 §2D）。

**强制加密**：`scripts/db-backup.sh` 没有 `BACKUP_PASSPHRASE` 就退出（退出码 2，不建目录、不连库）；明文只允许本机隔离测试库
并显式 `BACKUP_ALLOW_PLAINTEXT=1`。备份先写进临时目录，全部成功并加密后才移出——任何失败都不留半份 / 明文产物。
上传前 `scripts/ops/assert-encrypted.sh` 逐个检查文件是 gpg 对称加密包，上传路径只匹配 `backup/*.gpg`。

**统一快照**：备份开始时开一个 REPEATABLE READ READ ONLY 事务、`pg_export_snapshot()`，整个备份期间一直持有；
四个 `pg_dump --snapshot=<同一快照>`，行数 / 校验和 / schema 版本 / globals / Storage 对象清单都在 `SET TRANSACTION SNAPSHOT` 下读。
备份期间的并发写入要么全部在备份里、要么全部不在，不会出现「profiles 有、auth.users 没有」这类跨范围不一致。
manifest 记快照 id、LSN、快照时间；**Storage 文件清单就是这个快照里的 `storage.objects`，清单时间 = 快照时间**；
快照之后被删 / 被改写的对象下载失败或大小不符 → 备份失败（不会产出缺文件的备份）。测试：`tests/ops/backup-consistency.sh`
（备份期间持续跨范围写入 + 快照后确定性标记；对照组「逐个 pg_dump」必须被检测出不一致）。

| 范围           | 文件                                                         | 内容                                                                                                                    | 精确恢复方式                                                                                                   |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| manifest       | `azsou-manifest-*.json`                                      | 格式 2：快照 id / LSN / 时间、服务器版本、**schema 版本**、各范围文件、Storage 文件统计                                 | 恢复前读取；schema 版本 ≠ 代码最新迁移时必须显式确认                                                           |
| public         | `azsou-public-*.dump`                                        | 全部结构 + 数据 + RLS 策略 + 函数 + 触发器 + 授权（ACL）                                                                | 单事务：pg_restore（去掉 ACL）→ post-restore.sql → 只恢复备份里的 ACL                                          |
| private        | `azsou-private-*.dump`                                       | 整个 schema：票据 / 下载盐等密钥（`app_settings`）、提交记录、下载事件                                                  | 同一事务，整 schema                                                                                            |
| auth           | `azsou-auth-*.dump`                                          | `auth.users`（邮箱、密码哈希）+ `auth.identities`（第三方登录绑定）数据                                                 | 同一事务，只导数据（结构属于 Supabase Auth）                                                                   |
| storage 表     | `azsou-storage-*.dump`                                       | `storage.buckets` + `storage.objects`（结构 + 数据 + **RLS 策略**）                                                     | 同一事务恢复 storage 上的 RLS 策略；行：`--storage-api` 时由 API 重建，`--storage-metadata-only` 时直接导入    |
| Storage 文件   | `azsou-storage-files-*.tar` + `azsou-storage-files-*.tsv`    | **对象文件本体**（经 Storage API 用 service key 下载）+ 逐对象 bucket / name / 大小 / **sha256** / 类型 / cache-control | `--storage-api`：建桶（同设置）→ 逐个上传（先核对 sha256）→ 回填 owner → 从目标下载比对 sha256 / 清单 / 身份列 |
| 桶 / 对象清单  | `azsou-storage-buckets-*.tsv`、`azsou-storage-listing-*.tsv` | 快照里的桶设置与对象清单（含 owner）                                                                                    | 建桶与回填 owner 的依据                                                                                        |
| 校验和         | `azsou-checksums-*.tsv`                                      | 每个范围每张表：行数 + 内容 md5（固定列序、C 排序）+ 列清单；另有 storage 身份列校验和                                  | **事务内**逐表复算，任何不一致 → ROLLBACK，目标保持为空                                                        |
| 行数 / globals | `azsou-rowcounts-*.tsv`、`azsou-globals-*.tsv`               | 行数清单；扩展 / 自定义角色 / RLS 开关 / 策略数 / 函数数 / 表授权数                                                     | 行数事务内核对；globals 缺自定义角色 → 失败、缺扩展 → 提示                                                     |

本地集成测试（**不是真实验收**）：`tests/ops/storage-roundtrip.sh` 用真实的 supabase/storage（v1.19.0 源码构建、file 后端）
分别挂在源库和目标库上做完整往返（含公开 / 私有桶、多级目录、owner、cache-control、RLS 策略，及「目标非空」「归档被改」「快照后对象被删」三个负面用例），
CI 任务 `storage-roundtrip` 每次运行。真实验收需要隔离的 Supabase 测试项目（ref、数据库密码、service key），见 §2D。

**不在备份里的东西（以及原因）**：

| 不包含                                                                                         | 原因                                                              | 怎么补                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| 平台角色（`anon` / `authenticated` / `service_role` / `authenticator` / `supabase_*`）与其密码 | Supabase 新项目自带、由平台管理；导出密码哈希没有意义且是敏感数据 | 新项目自带；globals 里出现的**自定义**角色要先手工建    |
| Auth 服务的其他表（sessions、refresh_tokens、mfa、audit_log_entries 等）                       | 会话 / 令牌恢复到新项目无效且是敏感数据；用户重新登录即可         | 不需要                                                  |
| Storage 对象的内部 id / 时间戳 / eTag                                                          | 经 API 上传时由 storage-api 重新生成                              | 不影响引用（站内按 bucket + name 引用）；身份列逐行核对 |
| 非 ASCII 对象名                                                                                | storage-api 不接受（上传时就会被拒），站内上传路径也只有 ASCII    | 不需要                                                  |
| Supabase 项目设置（Auth 提供方、Site URL、SMTP、钩子开关、API 密钥）                           | 不在数据库里                                                      | 按 `docs/CONFIG.md` 重配                                |
| 扩展本身                                                                                       | 由平台安装；`db/restore/pre-restore.sql` 建 pgcrypto / pg_trgm    | globals 清单列出名称 / 版本供核对                       |
| `cron` schema（pg_cron 任务）                                                                  | 调度尚未批准启用；启用后任务定义在 `db/ops/workflow-cron.sql`     | 恢复后按调度放行申请重新执行                            |

### 2C. 独立监控（默认不启用，另行启用）

`ops/disabled-workflows/backup-monitor.yml`（逻辑 `scripts/ops/backup-monitor.mjs`，夹具测试 `tests/unit/backup-monitor.test.ts`）：
每 6 小时检查**每日备份模板**（默认不启用）最近成功运行里未过期、非空的加密产物；找不到或超过阈值 → 打开 / 更新 `backup-alert` issue 并让本次运行失败。
它只有在每日备份也启用时才有意义（只启用手动备份时必然告警），所以与每日备份一起**另行启用**；阈值仓库变量 `BACKUP_MAX_AGE_HOURS`，模板默认 26 小时。
局限：监控本身也跑在 GitHub Actions 上——需要完全独立于 GitHub 的心跳时，另接外部 uptime 服务（待站长决定）。

### 2D. 仍待站长批准 / 执行（仓库里没有做，也不能替站长做）

1. Supabase 升级 Pro 并开启 **PITR 附加项**（付费；约 $100/月 7 天档，需 Small 及以上计算规格）——RPO ≤ 1 小时只能靠它保证。
2. 按 §2E 创建环境 `backup-production`（必需审批人、环境变量、四个环境 Secret）；Settings → Actions → General 确认 artifact 保留上限 ≥ 30 天。
3. 审批并合并运维 PR #8（https://github.com/azsou/azsou-site/pull/8，分支 `ops/backup-workflow-2026-10-27`，基于 main；只含受保护的手动备份工作流、脚本与它自己的运维测试）——GitHub 只运行默认分支上的手动工作流。
4. 合并后手动运行一次 DB backup（审批），再用 CI 的 `backup-restore`（`backup_run_id`）做云端恢复验收，并在**隔离的 Supabase 测试项目**上做一次 `--storage-api` 精确恢复，实测 RTO。
5. 是否启用每日定时 / 外部存储 / 监控（`ops/disabled-workflows/`），各自单独批准。

### 2E. 环境 backup-production（站长创建；工作流只引用，不会替你创建）

Settings → Environments → New environment，名字必须是 `backup-production`：

| 设置                  | 值                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required reviewers    | 站长本人（勾选「Prevent self-review」视需要）——**这是对生产库备份的真正闸门**                                                                                                       |
| Deployment branches   | Selected branches：只允许 `main`                                                                                                                                                    |
| Environment variables | `BACKUP_ENVIRONMENT_GUARD` = `backup-production`（闸门用它确认运行确实在这个受保护环境里；环境没建好时 GitHub 会自动建一个**无保护**的同名环境，此变量不存在 → 拒绝）               |
| Environment secrets   | `SUPABASE_DB_URL`（Session pooler，端口 5432）、`SUPABASE_URL`（`https://<ref>.supabase.co`）、`SUPABASE_SERVICE_ROLE_KEY`（Storage 文件下载）、`BACKUP_PASSPHRASE`（离线另存一份） |

运行：Actions → DB backup → Run workflow → 分支 `main` → 输入项目 ref → 等待审批 → 审批人确认后才开始连接数据库。
生产项目 `abryflgoljltyakthtql` 只在通过以上闸门后放行；`scripts/db-restore.sh` / `scripts/db-upgrade.sh` 永远拒绝生产项目。

## 3. 恢复：精确恢复 → （需要时）显式升级

两步分开，**恢复脚本永远不会隐式执行迁移**：

```bash
# 加密备份不必先手动解密：脚本用 BACKUP_PASSPHRASE 解密到临时目录
export BACKUP_PASSPHRASE='…'
# ① 精确恢复到一个**空的**目标（新的 Supabase 项目；或跑过 db/shim/plain.sql 的任意 Postgres）
#    Storage 文件本体经目标项目的 Storage API 恢复：
STORAGE_URL=https://<新项目 ref>.supabase.co/storage/v1 STORAGE_SERVICE_KEY='<新项目 service_role key>' \
  bash scripts/db-restore.sh "$NEW_DATABASE_URL" ./db-backup-<run id>/ --storage-api
#    备份的 schema 版本 ≠ 当前代码最新迁移时会被拒（退出码 4），确认要按备份版本恢复：加 --accept-backup-version <备份版本>
# ② 需要升级到当前代码的 schema 时，另行显式执行（每个迁移后核对版本；远程目标须 --confirm-remote-host）
bash scripts/db-upgrade.sh "$NEW_DATABASE_URL" --from <备份版本> --to <目标版本> --apply-migrations --confirm-remote-host <主机>
```

- 目标必须为空（public 无表 / 函数、private 空、auth.users / storage 空），否则拒绝（退出码 3）——精确恢复只进新目标，不在旧库上覆盖。
- 全部数据库范围在**一个事务**里恢复，并在提交前逐表核对行数 + 内容校验和 + schema 版本；任何错误或不一致 → ROLLBACK，目标保持为空。
  没有触发器式的「删除保护 / 回滚」，也不再用 `--disable-triggers` / `--clean`：中止 = 回滚事务；本机 `--fresh-db` 新建的目标库在失败时删除——只删**本次运行新建**、且 OID 与创建标记（库注释 `azsou-run:<运行 id>`）都对得上的库，预先存在的库永远不删（`--drop-target-on-failure` 已废除，单独使用会被拒绝）；`--storage-api` 失败时只撤销本次新建的桶与本次上传的对象（逐个核对 sha256），预先存在的桶 / 对象不动（`tests/ops/cleanup-safety.sh`、`tests/ops/storage-roundtrip.sh` S2）。
- Storage 经 API 恢复在数据库事务提交之后进行（API 不在数据库事务里）：失败时脚本非 0 退出；远程项目请直接删除这个新建的测试 / 恢复项目重来。
- 只要数据库、不要文件本体：`--storage-metadata-only`（备份时 `BACKUP_STORAGE_FILES=skip` 的备份只能这样恢复）。
- 换到非 Supabase 的 Postgres（Neon、RDS、自建）：先 `psql "$NEW" -f db/shim/plain.sql`，再同样精确恢复 + 显式升级；Storage 文件改放 S3 兼容存储时见 PORTABILITY.md。

之后部署 PostgREST（或任何实现了「事务内 `set local role` + `request.jwt.claims`」的 API 层），前端只需改 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY`；认证换成别的提供方时实现 `src/lib/data/types.ts` 的 `AuthProvider` 即可。

## 4. 恢复演练

`scripts/restore-drill.sh` 在**每次 CI**（db 任务）中自动运行，也可以本地运行：

1. 建源库：shim + 全部迁移 + 演练数据（`db/restore/drill-seed.sql`）；
2. `scripts/db-backup.sh` 统一快照 + **加密**备份（每次随机口令，不落盘不打印），过上传前闸门、解密、校验 SHA256、确认 manifest 有快照 id；
3. A. **精确恢复**：`scripts/db-restore.sh --fresh-db`（新库只跑 shim，单事务 + 事务内核对）；
   B. **旧版本备份**：源库只到 0017 → 备份 → 不带确认的精确恢复必须被拒（退出码 4）→ `--accept-backup-version 0017` 精确恢复（结果仍是 0017）→ `scripts/db-upgrade.sh` 显式升级到 0019；
4. 核对：每张表行数「源库 = A」，按范围汇总；A 的策略、函数（含授权）、触发器、RLS 开关、表授权与源库一致；B 的数据行数与 0017 源库一致、结构与全新 0019 库一致；恢复后新用户注册正常；
5. 以 A 为模板跑 RLS 角色矩阵、后台 RPC、回归、P5、P6 测试（`DB_TEST_TEMPLATE`）。

另有：`tests/ops/drill-negative.sh`（52 个负面 / 对照用例）、`tests/ops/backup-consistency.sh`（统一快照）、`tests/ops/storage-roundtrip.sh`（Storage 往返，本地集成测试）、
`tests/ops/backup-ops-e2e.sh` + `tests/ops/backup-guard.test.sh` + `tests/ops/test_workflows.py`（运维 PR #8 的自身测试，工作流 `Ops tests`）。

```bash
bash scripts/pg-local.sh start                                   # 一次性本地 Postgres
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm run db:drill
```

**云端恢复验收（不下载到个人电脑）**：Actions → CI → Run workflow，填 `backup_run_id` = 某次 DB backup 的 run id → 任务 `backup-restore`
下载该产物、解密、精确恢复到 CI 的临时 Postgres（按备份自己的 schema 版本，Storage 只恢复行），跑 `scripts/db-verify-backup.sh --restore`
并把表名 / 行数 / 恢复耗时 / status 汇总写进运行摘要。截至 2026-10-28 仓库里还没有任何 DB backup 产物，所以这项**阻塞**在「创建环境并成功运行一次 DB backup」。

**站长每季度做一次真实演练**：从 Actions 下载最近一份备份 → 在一个临时 Supabase 项目上 `--storage-api` 精确恢复 → 跑 `db/verify/status.sql` → 删除临时项目。
