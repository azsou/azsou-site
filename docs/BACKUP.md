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

### 定时备份（GitHub Actions）

工作流 `.github/workflows/db-backup.yml`（脚本 `scripts/db-backup.sh`，本地也能直接用）：

| 项目 | 设置                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 时间 | **每周一 03:30（北京时间）**，cron `30 19 * * 0`（UTC 周日 19:30）；也可在 Actions 页面手动运行                                    |
| 保留 | 产物上传为 workflow artifact `db-backup-<run id>`，**保留 30 天**，过期由 GitHub 自动删除                                          |
| 内容 | 见 §2B「恢复范围」：public / private / auth（账户 + 第三方绑定）/ storage 元数据 / globals 清单 / 结构 SQL / 行数清单 / SHA256     |
| 加密 | **强制**：全部产物 gpg AES256 对称加密，上传前闸门 `scripts/ops/assert-encrypted.sh` 只放行 `.gpg`；解密：`gpg -d 文件.gpg > 文件` |
| 需要 | 仓库 Secret `SUPABASE_DB_URL`（Session pooler，端口 5432）**与** `BACKUP_PASSPHRASE`；缺任何一个工作流**失败**、不导出任何数据     |

- 定时触发只在默认分支 `main` 上生效；合并前可在 Actions → DB backup → Run workflow 选 `v2/astro` 手动运行。
- 30 天 ≈ 最近 4–5 份周备份。需要更久的留档：每月下载一份放到自己的加密存储里。
- 批量删除、导入、生产迁移之前，先手动运行一次。

### 2A. RPO / RTO：站长目标、现状与差距（2026-10-27）

站长目标（2026-10-27 定稿）：**RPO ≤ 1 小时**（最多丢 1 小时数据）、**RTO ≤ 4 小时**（4 小时内恢复服务）、
**独立加密备份至少保留 30 天**、内容版本历史保留 90 天。

| 项目           | 目标              | 现状（只写已经存在的东西）                                                                                                                                                                                                                                       | 差距                                   |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 自动备份频率   | 至少每小时        | 工作流写的是**每周一 03:30（北京时间）一次**；但它**还没有生效**：定时触发只在默认分支 `main` 上运行，而 `db-backup.yml` 还不在 `main` 上（Actions 里只注册了 CI 工作流），仓库 Secret 也未确认。截至 2026-10-27，仓库里**没有任何一份生产备份产物**             | 现在 = 没有自动备份；合并后 = RPO 7 天 |
| 平台备份       | —                 | 项目在 Supabase 免费档：没有平台自带的每日备份，也没有 PITR（Supabase 官方：Pro 及以上才有每日备份，PITR 是另付费的附加项）                                                                                                                                      | 无                                     |
| RTO            | ≤ 4 小时          | 恢复脚本（`scripts/db-restore.sh`）在本机 / CI 每次都演练，演练库几秒内恢复完；但**从未用真实生产备份演练**（没有产物），新建 Supabase 项目 + 配置（Auth、密钥、Vercel 环境变量）的耗时也没实测                                                                  | 未验证                                 |
| 备份保留       | ≥ 30 天、独立加密 | artifact `retention-days: 30`（工作流层面）；配置 `BACKUP_PASSPHRASE` 后 gpg AES256 加密。仓库级的「Artifact and log retention」上限我们读不到（需要站长在 Settings → Actions → General 确认 ≥ 30 天，否则会被截短）；artifact 与仓库同在 GitHub，不是异地第二份 | 仓库级设置待确认；没有第二个存放位置   |
| 恢复演练吞错误 | 任何失败都标红    | 已修（批次 2 跟进 3）：`tests/ops/drill-negative.sh` 30 个负面 / 对照用例每次 CI 运行                                                                                                                                                                            | 无                                     |

**结论：RPO ≤ 1 小时、RTO ≤ 4 小时目前都没有达到，不能对外这样写。**

#### 待站长批准的方案（本仓库没有改任何生产设置，下面任何一项都需要批准后由站长执行）

| 方案 | 做法                                                                                                              | RPO                                                            | 费用 / 代价                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A    | Supabase 升级 Pro + 开启 PITR 附加项（保留 7 天）                                                                 | 秒级～分钟级（WAL 连续归档）                                   | Pro 月费 + PITR 附加约 $100/月（7 天档），且要求至少 Small 计算规格；开启 PITR 后平台不再做每日备份（PITR 取代） |
| B    | 把 `db-backup.yml` 的定时改为**每小时**（文件里已留注释行 `'17 * * * *'`，未启用），产物加密、保留 30 天          | 名义 ≤ 1 小时；GitHub 定时任务高峰期会延迟甚至跳过，**不保证** | 免费额度内的 Actions 分钟数；30 天 ≈ 720 份产物，需核对账户的 Actions 存储额度；每小时对生产库做一次 pg_dump     |
| C    | A + 保留每日（或每周）一次独立加密 pg_dump 到 GitHub artifact（以及站长自己的异地存储），满足「独立备份 ≥ 30 天」 | 同 A                                                           | A 的费用                                                                                                         |

建议：预算允许选 **C**（RPO 有平台保证、另有独立副本）；否则选 **B**，并加一个独立于 GitHub 的心跳监控
（例如外部 uptime 服务检查最近一次备份产物时间），把「GitHub 跳过定时」变成可见的告警。
批准后：按 `docs/release/` 的放行申请格式另提一份「备份频率变更」申请，先在 `v2/astro` 手动运行通过、
下载产物用 `scripts/db-verify-backup.sh … --restore <本机库>` 实测恢复耗时，再改定时。

### 2B. 方案 C 仓库侧落地：强制加密 + 完整恢复范围（站长 2026-10-27 21:06 选定）

方案 C = **Supabase PITR（付费附加项）+ 独立加密 dump**。仓库这边只做「独立加密 dump」与监控；
**PITR 附加项的购买 / 开启、生产 Secret、生产执行均未做，待站长批准**（见 §2D）。

**强制加密**：`scripts/db-backup.sh` 没有 `BACKUP_PASSPHRASE` 就退出（退出码 2，不建目录、不连库）；明文只允许本机隔离测试库
并显式 `BACKUP_ALLOW_PLAINTEXT=1`（恢复演练 / 负面用例用），远程库（生产）永远产不出明文。工作流缺口令直接失败；
上传前 `scripts/ops/assert-encrypted.sh` 逐个检查文件是 gpg 对称加密包（看 OpenPGP 包头，改名成 `.gpg` 的明文也拦得住），
上传路径只匹配 `backup/*.gpg`。测试：`tests/unit/backup-encryption.test.ts`、`tests/ops/drill-negative.sh` E1–E5。

**恢复范围**（每项一个文件，全部进 SHA256SUMS、全部加密；`scripts/db-restore.sh` 按顺序恢复，`db-verify-backup.sh --restore` 与 `restore-drill.sh` 逐表核对并按范围汇总）：

| 范围    | 文件                    | 内容                                                                                                         | 恢复方式                                                      |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| public  | `azsou-public-*.dump`   | 全部结构 + 数据 + RLS 策略 + 函数 + 触发器 + 授权（ACL）                                                     | pg_restore（去掉 ACL）→ post-restore.sql → 只恢复备份里的 ACL |
| private | `azsou-private-*.dump`  | 整个 schema：票据 / 下载盐等密钥（`app_settings`）、提交记录、下载事件                                       | pg_restore 整 schema（迁移重跑时 `on conflict` 不覆盖）       |
| auth    | `azsou-auth-*.dump`     | `auth.users`（邮箱、密码哈希）+ `auth.identities`（GitHub / Google 等第三方登录绑定）数据                    | pg_restore 只导数据（结构属于 Supabase Auth）                 |
| storage | `azsou-storage-*.dump`  | `storage.buckets` + `storage.objects` 元数据行                                                               | pg_restore 只导数据，在迁移重跑之前                           |
| globals | `azsou-globals-*.tsv`   | 扩展（名称 / 版本 / schema）、非平台自定义角色（无密码）、各 schema 的 RLS 开关 / 策略数 / 函数数 / 表授权数 | 核对用：目标库缺自定义角色 → 失败；缺扩展 → 提示              |
| 行数    | `azsou-rowcounts-*.tsv` | 上面每个范围每张表的行数                                                                                     | 恢复后逐表核对                                                |

**不在备份里的东西（以及原因）**：

| 不包含                                                                                         | 原因                                                              | 怎么补                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Storage 文件本体（`ugc-images` 里的图片）                                                      | 存在 Supabase Storage（S3），不在 Postgres 里，pg_dump 拿不到     | PITR 也不含文件。需要时另批「Storage 同步」（S3 兼容接口 + rclone 到异地加密存储），待站长决定 |
| 平台角色（`anon` / `authenticated` / `service_role` / `authenticator` / `supabase_*`）与其密码 | Supabase 新项目自带、由平台管理；导出密码哈希没有意义且是敏感数据 | 新项目自带；globals 里出现的**自定义**角色要先手工建                                           |
| Auth 服务的其他表（sessions、refresh_tokens、mfa、audit_log_entries 等）                       | 会话 / 令牌恢复到新项目无效且是敏感数据；用户重新登录即可         | 不需要                                                                                         |
| Supabase 项目设置（Auth 提供方、Site URL、SMTP、钩子开关、API 密钥）                           | 不在数据库里                                                      | 按 `docs/CONFIG.md` 重配                                                                       |
| 扩展本身                                                                                       | 由平台安装；`db/restore/pre-restore.sql` 建 pgcrypto / pg_trgm    | globals 清单列出名称 / 版本供核对                                                              |
| `cron` schema（pg_cron 任务）                                                                  | 调度尚未批准启用；启用后任务定义在 `db/ops/workflow-cron.sql`     | 恢复后按调度放行申请重新执行                                                                   |

### 2C. 独立监控

`.github/workflows/backup-monitor.yml`（逻辑 `scripts/ops/backup-monitor.mjs`）每 6 小时运行一次，与备份工作流**互不依赖**：
在 DB backup 最近的成功运行里找未过期、非空的 `db-backup-<run id>` 产物；找不到（从未运行 / 全部失败 / 产物过期 / 工作流不在默认分支）
或最新一份超过阈值 → 打开（或更新）一个 `backup-alert` 标签的 issue 并让本次运行失败（GitHub 失败通知是第二条通道）；恢复后自动留言并关闭。
阈值 = 仓库变量 `BACKUP_MAX_AGE_HOURS`，默认 **192 小时**（每周一次 + 1 天余量）；站长批准更高频率后改为「频率 + 余量」。
判定逻辑用夹具测过（`tests/unit/backup-monitor.test.ts`，`tests/fixtures/backup-monitor/`）。
局限：监控本身也跑在 GitHub Actions 上——GitHub 整体不可用时两者同时停；需要完全独立于 GitHub 的心跳时，另接外部 uptime 服务（待站长决定）。

### 2D. 仍待站长批准 / 执行（仓库里没有做，也不能替站长做）

1. Supabase 升级 Pro 并开启 **PITR 附加项**（付费；约 $100/月 7 天档，需 Small 及以上计算规格）——RPO ≤ 1 小时只能靠它保证。
2. 在仓库 Settings → Secrets 配置 `SUPABASE_DB_URL`、`BACKUP_PASSPHRASE`（口令离线另存一份）；Settings → Actions → General 确认 artifact 保留上限 ≥ 30 天。
3. 审批并合并运维 PR #8「运维：备份与监控工作流（需站长审批，勿自动合并）」（https://github.com/azsou/azsou-site/pull/8，分支 `ops/backup-workflow-2026-10-27`，基于 main）（只含备份 + 监控工作流与脚本）——GitHub 只运行默认分支上的定时 / 手动工作流。
4. 合并后手动运行一次 DB backup，再用 CI 的 `backup-restore`（`backup_run_id`）做云端真实恢复验收，实测 RTO。
5. 如需 Storage 文件本体的备份，另批「Storage 同步」。

## 3. 恢复 / 换库（任意标准 Postgres：Neon、RDS、自建）

**推荐用脚本**（与恢复演练同一套）：

```bash
# 整库恢复（灾难恢复：恢复到新的 Supabase 项目 / 新库）
psql "$NEW_DATABASE_URL" -f db/shim/plain.sql      # 新的 Supabase 项目不需要这一步
bash scripts/db-restore.sh "$NEW_DATABASE_URL" azsou-public-*.dump azsou-auth-*.dump \
  --private azsou-private-*.dump --storage azsou-storage-*.dump      # 先 gpg -d 解密；旧备份的 azsou-auth-users-*.dump 同样可用
psql "$NEW_DATABASE_URL" -f db/verify/status.sql   # 全部为 true
```

下面是不用脚本时的手工步骤（换库：迁移建结构 + 只导数据）：

```bash
export NEW_DATABASE_URL='postgresql://…'
# 1) Supabase 环境模拟（角色 anon / authenticated / service_role、auth.users、auth.uid()）
psql "$NEW_DATABASE_URL" -f db/shim/plain.sql
# 2) 结构：0001 基线 + 全部增量迁移（按文件名顺序）
for f in db/migrations/*.sql; do psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
# 3) 用户账户（如需保留）再导数据；--disable-triggers 避免触发器重复写通知 / 审计
pg_restore --data-only --disable-triggers --no-owner -d "$NEW_DATABASE_URL" azsou-auth-users-YYYY-MM-DD.dump
pg_restore --data-only --disable-triggers --no-owner -d "$NEW_DATABASE_URL" azsou-data-YYYY-MM-DD.dump
# 4) 自增序列对齐
psql "$NEW_DATABASE_URL" -c "select setval(pg_get_serial_sequence('public.audit_log','id'), coalesce(max(id),1)) from public.audit_log"
```

（第 4 步对 `likes`、`bookmarks`、`notifications`、`rate_limit_events`、`user_bans` 同样执行。）

之后部署 PostgREST（或任何实现了「事务内 `set local role` + `request.jwt.claims`」的 API 层），前端只需改 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY`；认证换成别的提供方时实现 `src/lib/data/types.ts` 的 `AuthProvider` 即可。

## 4. 恢复演练

`scripts/restore-drill.sh` 在**每次 CI**（db 任务）中自动运行，也可以本地运行：

1. 建源库：shim + 全部迁移 + 演练数据（`db/restore/drill-seed.sql`）；
2. 用 `scripts/db-backup.sh` **加密**备份（每次随机口令，不落盘不打印；全部范围），过上传前闸门、解密、校验 SHA256；
3. A. **整库恢复**：新库只跑 shim → `scripts/db-restore.sh`（`pre-restore.sql` → pg_restore → `post-restore.sql`）；
   B. **换库恢复**：新库跑 shim + 全部迁移 → 只导数据（`--data-only --disable-triggers`）；
4. 核对：每张表行数「源库 = A = B」，按范围（public / private / auth / storage）汇总打印，每个范围源库必须有数据；A 的策略、函数（含授权）、触发器、RLS 开关、表授权与源库一致；恢复后新用户注册正常；
5. 以 A 为模板跑 RLS 角色矩阵、后台 RPC、回归、P5 测试（`DB_TEST_TEMPLATE`）。

```bash
bash scripts/pg-local.sh start                                   # 一次性本地 Postgres（端口 54329）
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm run db:drill
DATABASE_URL=… POSTGREST_BIN=… npm run test:db                   # 迁移 + RLS 矩阵 + 后台 RPC + 存储 RLS
```

**云端真实恢复验收（不下载到个人电脑）**：Actions → CI → Run workflow，分支选当前分支，填 `backup_run_id` = 某次
DB backup 的 run id → 任务 `backup-restore` 下载该产物、用仓库 Secret `BACKUP_PASSPHRASE` 解密、恢复到 CI 的临时 Postgres，
跑 `scripts/db-verify-backup.sh --restore` 并把表名 / 行数 / 恢复耗时 / status 汇总写进运行摘要（对生产只读，不输出数据或密钥）。
截至 2026-10-27 仓库里还没有任何 DB backup 产物，所以这项**阻塞**在「先配置 Secret 并成功运行一次 DB backup」。

**站长每季度做一次真实演练**：从 Actions 下载最近一份备份 → 解密 → 恢复到一个临时 Supabase 项目或本地 Postgres → 跑 `db/verify/status.sql`
并对比行数清单（`azsou-rowcounts-*.tsv`）→ 删除临时项目。
