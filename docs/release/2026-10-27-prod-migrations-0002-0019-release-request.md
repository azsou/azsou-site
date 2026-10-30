# 放行申请 ①：生产库执行迁移 0002 → 0019

> **状态：待站长批准。未执行。** 本文件只是申请与操作单，仓库里没有任何会自动执行它的脚本、工作流或定时任务。
> 与「开启定时发布调度（pg_cron）」是**两份独立申请**（见 [2026-10-27-scheduler-cron-release-request.md](2026-10-27-scheduler-cron-release-request.md)）：
> 本申请批准后迁移执行完，调度仍然关闭；调度要等本申请完成并观察通过后另行批准。

| 项目         | 内容                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 申请日期     | 2026-10-27（2026-10-28 第三轮更新：备份改为 #8 受保护手动工作流、回滚改为精确恢复 / 显式升级、合并条件改为统一候选 SHA；第五轮：删除「停用保护触发器 / 回到 0017」式回滚）                                                                         |
| 对象         | 生产 Supabase 库（public / private / storage 对象）                                                                                                                                                                                                |
| 变更         | 按顺序执行 `db/migrations/0002_*.sql` … `0019_restore_review_version_window.sql`（**永不执行 0001**）                                                                                                                                              |
| 现状         | 只读核对（`db/verify/status.sql`）：0002–0017 全部未执行（`docs/audits/evidence/batch1/prod-status.json`）；0018、0019 也未执行                                                                                                                    |
| 演练证据     | 本机隔离库：`scripts/db/rehearse-migrations.sh` 通过（原有表行数不变、status 未通过 23 → 0、重跑一致、迁移前备份可恢复；`docs/audits/evidence/batch2/b04/`）。**真实 azsou-test 项目演练：待执行**（等站长确认初始化计划；证据路径：`__________`） |
| 预计停写窗口 | 约 10–15 分钟（冻结后台审核写操作；前台只读不受影响）                                                                                                                                                                                              |
| 不包含       | 启用 pg_cron / 外部调度器；启用注册钩子（0007 的钩子仍关闭，切换时另做）；任何 Supabase / Vercel 设置变更；备份频率变更；PITR 开启与 Storage 文件定期同步（§7 单独签字）                                                                           |

## 1. 前置条件（全部满足才开始）

- [ ] 执行用的是**同一个统一候选 SHA**：`<统一候选 SHA，候选重建后填写>`——#4 / #5 / #6 的修复都在这一个提交里，
      它的代码、CI（全绿）、真实预览（azsou-test）与恢复证据是同一版本；按站长批准合入 `v2/astro` 后的提交与它的树一致（记录：`__________`）。
- [ ] 真实 azsou-test 项目上的迁移演练已完成并附证据（目前：**待执行**，见上表「演练证据」）。
- [ ] 运维 PR #8（受保护的手动备份工作流，仅 `workflow_dispatch`，无定时）已经站长批准合并到 **`main`**。
- [ ] 环境 `backup-production` 已按 `ops/BACKUP-OPS.md` §1 建好：Required reviewers = 站长、Deployment branches 只允许 `main`、
      变量 `BACKUP_ENVIRONMENT_GUARD`、四个 Environment secrets（`SUPABASE_DB_URL`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`BACKUP_PASSPHRASE`）；
      Settings → Actions → Artifact and log retention **≥ 30 天**。
- [ ] 本机 `psql` / `pg_dump` 版本 ≥ 服务器版本（Supabase 当前 17）。
- [ ] 连接串只在本机终端输入（`read -s`），**不写进任何文件、截图或聊天**。
- [ ] 已通知版主：执行窗口内暂停审核操作。
- [ ] 记录当前 Vercel 生产部署 ID：`__________`（回滚前端用）。
- [ ] 测试账号（普通用户 / 版主 / 管理员各一，非真实用户）已准备好，用于 §5 canary。

## 2. 备份（必须，先于任何写操作）

按 `ops/BACKUP-OPS.md` 操作（第三轮：只能在 `main` 上手动触发、每次审批；不合并 #8 就没有任何备份会运行）。

```bash
# 2.1 Actions → DB backup → Run workflow → 分支 main → confirm_project_ref 填生产项目 ref
#     → 环境 backup-production 的审批人（站长）批准 → 等待绿色；记录 run id：________
#     闸门 scripts/ops/backup-guard.sh 在连接数据库之前检查：手动触发 / 处在受保护环境 / 四个 Secret 齐全 / 输入 ref = 连接串 ref = API ref
# 2.2 下载产物 db-backup-<run id>（只有 .gpg，保留 30 天；统一快照的 public / private / auth / storage + Storage 文件本体 + 校验和 + manifest）
#     到本机 backups/pre-0002-0019/，校验并在本机隔离库精确恢复：
BACKUP_PASSPHRASE='<口令，本机输入>' bash scripts/db-verify-backup.sh backups/pre-0002-0019 \
  --restore postgres://postgres:postgres@127.0.0.1:54529/azsou_prerelease_restore
#     必须输出「校验通过」和「恢复演练通过」，否则停止。记录产物名与 manifest 里的快照时间 / schema 版本：________
```

## 3. 迁移前快照（只读）

```bash
read -s PROD   # 粘贴 Session pooler 连接串（端口 5432），不回显
psql "$PROD" -X -v ON_ERROR_STOP=1 -f db/shim/supabase.sql                       # 只检查前提，不创建任何东西
psql "$PROD" -X -A -F' | ' -t -v ON_ERROR_STOP=1 -f db/verify/status.sql > release-before-status.txt
psql "$PROD" -X -A -t -v ON_ERROR_STOP=1 -c "
  select 'users', count(*) from auth.users union all select 'profiles', count(*) from public.profiles
  union all select 'threads', count(*) from public.forum_threads union all select 'replies', count(*) from public.forum_replies
  union all select 'comments', count(*) from public.comments union all select 'site_content', count(*) from public.site_content" > release-before-counts.txt
psql "$PROD" -X -A -t -v ON_ERROR_STOP=1 -c "
  select tablename, policyname, cmd, roles::text from pg_policies where schemaname = 'public' order by 1, 2" > release-before-policies.txt
```

## 4. 执行（逐个文件，每个后跑 status；任何一步报错或 status 不符合预期就停）

每个迁移文件自带 `begin … commit`：报错时整个文件回滚，库停在上一步。

```bash
for f in 0002_roles_columns 0003_social_tables 0004_functions_triggers 0005_privileges 0006_rls \
         0007_signup_guard 0008_forum_search 0009_admin 0010_ugc_images 0011_forum_category_guard \
         0012_app_store 0013_tool_comments 0014_video_comments 0015_guestbook 0016_subscribers \
         0017_admin_crm 0018_state_consistency 0019_restore_review_version_window; do
  echo "== $f"
  psql "$PROD" -X -q -v ON_ERROR_STOP=1 -c 'set client_min_messages = warning' -f "db/migrations/$f.sql" || { echo "✗ $f 失败，停止"; break; }
  psql "$PROD" -X -A -F' | ' -t -v ON_ERROR_STOP=1 -f db/verify/status.sql | awk -F' [|] ' -v s="${f%%_*}" '$1 <= s && $3 != "t" {bad=1; print "  未通过：" $0} END {exit bad}' \
    || { echo "✗ $f 之后 status 有未通过项，停止"; break; }
done
```

- 0007：只建钩子函数，**不在 Dashboard 启用** Before User Created 钩子（切换时另做，MIGRATION.md §4）。
- 0015 / 0016：执行后按 MIGRATION.md §5D / §5E 写入 `community_ticket_secret`（密钥只在本机生成、只写进 `private.app_settings` 与 Vercel 环境变量）。
- 0018：只建函数 / 表 / 触发器，**不创建任何 cron 任务**；隐藏取消排程（站长已定）、恢复不复活排程、他人正文仅管理员经 `mod_edit_content`。
- 0019（站长第二轮 2026-10-27 21:06）：恢复回到「待审」、显式「发布」`mod_publish_content`；0017 的 50 条版本上限只裁剪早于 90 天的版本（90 天内一条不删）。只替换 / 新增函数，不改数据、不建 cron。

## 5. 验证

```bash
psql "$PROD" -X -A -F' | ' -t -v ON_ERROR_STOP=1 -f db/verify/status.sql > release-after-status.txt
grep -c ' | f$' release-after-status.txt     # 必须是 0（0002…0019 全部 true）
# 行数：与 release-before-counts.txt 对比，原有表必须完全一致
# 策略：与 release-before-policies.txt diff，差异应与演练 docs/audits/evidence/batch2/b04/diff-policies.txt 同类
psql "$PROD" -X -A -t -c "select count(*) from cron.job" 2>/dev/null || echo "pg_cron 未启用（预期）"   # 不应有本站任务
```

真实角色 canary（测试账号，不动真实用户数据）：

- [ ] 匿名：首页、论坛列表、主题页正常；看不到隐藏内容。
- [ ] 普通用户：发一条测试回复 → 编辑 → 删除，成功；直接改他人内容被拒。
- [ ] 版主：隐藏 / 恢复测试回复成功（审计里各一条 `content.visibility`）；改他人正文被拒（提示走管理员）。
- [ ] 管理员：后台 8 个模块（概览、内容、用户、举报、留言、友链、订阅、审计——唯一清单见 `tests/e2e/admin-modules.ts`，与交接文档 T091 一致）都能读出数据、无错误条（A15 关闭条件）。站点设置、导入导出、权限矩阵、官方内容不在这 8 个里（设置另按 A16 / T095 验）。
- [ ] 删除测试数据；解除冻结；观察 30 分钟审计日志与 Vercel / Supabase 错误日志。

## 6. 回滚

| 情况                          | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某个文件报错                  | 该文件已整体回滚；记录报错，停止。修正后从这个文件重跑（每个文件可重复执行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 0018 行为不被接受             | 不删除 / 停用任何保护触发器，也不「回到 0017」：保护触发器（内容版本、编辑守卫、排程同步）是 0018 的数据完整性保证，拆掉会让后台绕过审计与版本记录。行为问题按正常流程提交新的前向迁移修复（经测试库演练 + 站长批准）；在修复前如需止损，只能冻结对应后台写操作（同表头「预计停写窗口」的冻结做法），或按下一行用备份精确恢复到新的空项目。                                                                                                                                                                                                                                                                                                                                                                                              |
| 前端异常                      | Vercel → Deployments → 把 §1 记录的部署 Promote 回生产                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 数据损坏 / 必须精确回到迁移前 | 用 §2 的已校验备份**精确恢复**到一个**新的空** Supabase 项目（不执行任何迁移，结果 = 备份时的 schema 版本）：`STORAGE_URL=https://<新 ref>.supabase.co/storage/v1 STORAGE_SERVICE_KEY='<新项目 service_role>' BACKUP_PASSPHRASE='…' bash scripts/db-restore.sh <新库连接串> backups/pre-0002-0019 --storage-api`（文件本体经 Storage API 恢复）；只要数据库行时改用 `--storage-metadata-only`；备份版本 ≠ 代码最新迁移时须显式 `--accept-backup-version <备份版本>`。需要升级到更新 schema 是另一个显式步骤：`scripts/db-upgrade.sh <新库> --from <备份版本> --to <目标版本> --apply-migrations --confirm-remote-host <主机>`。核对后再切换 Vercel 环境变量。两个脚本都拒绝对生产项目执行；不要在生产库上手工删对象（docs/BACKUP.md §3） |

## 7. 站长签字

- [ ] 我已阅读本申请，批准在 `____年__月__日 __:__`（北京时间）执行 0002 → 0019。
- [ ] 我确认 §1 前置条件全部满足，§2 备份已在本机恢复验证。
- [ ] 我确认本次**不**启用调度（pg_cron / 外部调度器），调度另走申请 ②。
- [ ] **PITR**（Supabase Pro + PITR 付费附加项）：批准开启 / 暂不开启（圈选）。本申请不依赖它；未开启时只能回到 §2 手动备份那一刻，RPO ≤ 1 小时目标未达成（docs/BACKUP.md §2）。签字：________
- [ ] **Storage 文件同步 / 恢复**：确认 §2 产物含 Storage 文件本体（逐对象 sha256）；在隔离测试项目上用 `--storage-api` 做一次真实恢复验证：批准 / 暂不（圈选）；
      定期外部存储复制（`ops/disabled-workflows/backup-offsite.yml`）另行单独批准。签字：________
- [ ] 执行人：________　复核人：________　签字：________
- [ ] 执行结果（§5 全部勾选）：通过 / 失败（附原因）________
