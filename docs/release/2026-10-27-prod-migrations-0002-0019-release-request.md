# 放行申请 ①：生产库执行迁移 0002 → 0019

> **状态：待站长批准。未执行。** 本文件只是申请与操作单，仓库里没有任何会自动执行它的脚本、工作流或定时任务。
> 与「开启定时发布调度（pg_cron）」是**两份独立申请**（见 [2026-10-27-scheduler-cron-release-request.md](2026-10-27-scheduler-cron-release-request.md)）：
> 本申请批准后迁移执行完，调度仍然关闭；调度要等本申请完成并观察通过后另行批准。

| 项目         | 内容                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 申请日期     | 2026-10-27                                                                                                                                          |
| 对象         | 生产 Supabase 库（public / private / storage 对象）                                                                                                 |
| 变更         | 按顺序执行 `db/migrations/0002_*.sql` … `0019_restore_review_version_window.sql`（**永不执行 0001**）                                               |
| 现状         | 只读核对（`db/verify/status.sql`）：0002–0017 全部未执行（`docs/audits/evidence/batch1/prod-status.json`）；0018、0019 也未执行                     |
| 演练证据     | `scripts/db/rehearse-migrations.sh`（隔离库）：原有表行数不变、status 未通过 23 → 0、重跑一致、迁移前备份可恢复；`docs/audits/evidence/batch2/b04/` |
| 预计停写窗口 | 约 10–15 分钟（冻结后台审核写操作；前台只读不受影响）                                                                                               |
| 不包含       | 启用 pg_cron / 外部调度器；启用注册钩子（0007 的钩子仍关闭，切换时另做）；任何 Supabase / Vercel 设置变更；备份频率变更                             |

## 1. 前置条件（全部满足才开始）

- [ ] PR #4、PR #5 已合并到 `v2/astro`，CI 全绿；执行用的是合并后的提交（记录 SHA：`__________`）。
- [ ] 仓库 Secret `SUPABASE_DB_URL`、`BACKUP_PASSPHRASE` 已配置，`DB backup` 工作流在 `v2/astro` 上手动运行**成功过一次**，
      且已按 §2 下载并在本机恢复验证（`db-verify-backup.sh --restore` 通过）。
- [ ] 本机 `psql` / `pg_dump` 版本 ≥ 服务器版本（Supabase 当前 17）。
- [ ] 连接串只在本机终端输入（`read -s`），**不写进任何文件、截图或聊天**。
- [ ] 已通知版主：执行窗口内暂停审核操作。
- [ ] 记录当前 Vercel 生产部署 ID：`__________`（回滚前端用）。
- [ ] 测试账号（普通用户 / 版主 / 管理员各一，非真实用户）已准备好，用于 §5 canary。

## 2. 备份（必须，先于任何写操作）

```bash
# 2.1 GitHub Actions 备份（含 db-verify-backup.sh 的校验和 / 解密 / pg_restore --list / 行数清单）
#     Actions → DB backup → Run workflow → 分支 v2/astro → 等待绿色；记录 run id：________
# 2.2 下载 artifact db-backup-<run id> 到本机 backups/pre-0002-0019/，然后在本机隔离库实测恢复：
BACKUP_PASSPHRASE='<口令，本机输入>' bash scripts/db-verify-backup.sh backups/pre-0002-0019 \
  --restore postgres://postgres:postgres@127.0.0.1:54529/azsou_prerelease_restore
#     必须输出「校验通过」和「恢复演练通过」，否则停止。
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

| 情况                          | 做法                                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某个文件报错                  | 该文件已整体回滚；记录报错，停止。修正后从这个文件重跑（每个文件可重复执行）                                                                                                                                                                         |
| 0018 行为不被接受             | 不回退迁移：停用触发器 `drop trigger az_workflow_sync / az_workflow_orphan / az_content_edit_guard on forum_threads / forum_replies / comments`（回到 0017 行为）                                                                                    |
| 前端异常                      | Vercel → Deployments → 把 §1 记录的部署 Promote 回生产                                                                                                                                                                                               |
| 数据损坏 / 必须精确回到迁移前 | 用 §2 的已校验备份恢复到**新** Supabase 项目：`scripts/db-restore.sh <新库> azsou-public-*.dump azsou-auth-*.dump --private azsou-private-*.dump --storage azsou-storage-*.dump`（先 gpg -d 解密），再切换 Vercel 环境变量；不要在生产库上手工删对象 |

## 7. 站长签字

- [ ] 我已阅读本申请，批准在 `____年__月__日 __:__`（北京时间）执行 0002 → 0019。
- [ ] 我确认 §1 前置条件全部满足，§2 备份已在本机恢复验证。
- [ ] 我确认本次**不**启用调度（pg_cron / 外部调度器），调度另走申请 ②。
- [ ] 执行人：________　复核人：________　签字：________
- [ ] 执行结果（§5 全部勾选）：通过 / 失败（附原因）________
