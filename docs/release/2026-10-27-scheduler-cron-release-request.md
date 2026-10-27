# 放行申请 ②：开启定时发布调度（pg_cron）与心跳告警

> **状态：待站长批准。未执行。** 仓库里没有任何会自动创建 cron 任务的脚本或工作流；`db/ops/workflow-cron.sql`
> 只是操作单。本申请**依赖申请 ①（生产迁移 0002 → 0018）已完成并观察通过**，两者分开审批、分开执行。

| 项目     | 内容                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 申请日期 | 2026-10-27                                                                                                                                           |
| 对象     | 生产 Supabase 库：启用 `pg_cron` 扩展，新建 2 个（可选第 3 个）cron 任务                                                                             |
| 现状     | 定时发布只在版主打开后台时补偿执行（`mod_workflow_tick()`），不是无人值守                                                                            |
| 承诺     | 到期内容 2 分钟内公开；同一条只发布一次（双 worker、`SKIP LOCKED`）；隐藏中的内容不会被调度公开（锁内复核）；调度停摆 > 2 分钟（心跳 > 2× 间隔）告警 |
| 任务     | `az-workflow-tick` 每分钟 `mod_workflow_tick_job('pg_cron', 60)`；`az-workflow-health` 每 5 分钟 `az_workflow_alert()`                               |
| 不包含   | 内容版本清理定时任务（见 §7，单独勾选）；外部 Webhook 告警（需要站长提供地址）；备份频率变更（BACKUP.md §2A 另提）                                   |

## 1. 前置条件

- [ ] 申请 ① 已执行完：`db/verify/status.sql` 全部 true（含 0018 行：`workflow_scheduler_heartbeat`、`mod_workflow_tick_job(text,integer)`、`az_prune_content_versions(integer)`）。
- [ ] 申请 ① 完成后至少观察 24 小时，无 0018 相关错误（审计里无异常 `content.workflow.failed`）。
- [ ] 后台「内容」页确认当前排程清单（`status = review` 且有时间的条目），站长知道哪些会在开启后被发布：

```sql
select target_type, target_id, scheduled_at from public.content_workflow
 where status = 'review' and scheduled_at is not null and orphaned_at is null order by scheduled_at;
```

- [ ] **已到期但未发布的积压**：开启后第一分钟会全部发布。若不希望，先在后台改期或取消对应排程。
- [ ] Supabase 套餐允许 `pg_cron`（免费档可用；以 Dashboard → Database → Extensions 显示为准）。

## 2. 备份

调度只改内容的公开状态，但首次开启会批量发布积压，因此执行前：

```bash
# Actions → DB backup → Run workflow（v2/astro 或合并后的 main）→ 绿色；记录 run id：________
# 下载产物并在本机验证（与申请 ① §2 相同）：
BACKUP_PASSPHRASE='<口令>' bash scripts/db-verify-backup.sh backups/pre-cron --restore postgres://postgres:postgres@127.0.0.1:54529/azsou_precron_restore
```

## 3. 执行（Supabase → SQL Editor，项目所有者身份；或本机 `psql "$PROD"`）

```sql
-- 3.1 扩展
create extension if not exists pg_cron;
-- 3.2 每分钟发布到期内容 + 写心跳（来源 pg_cron，期望间隔 60 秒）
select cron.schedule('az-workflow-tick', '* * * * *', $$select public.mod_workflow_tick_job('pg_cron', 60)$$);
-- 3.3 每 5 分钟健康检查 + 站内告警（积压 > 2 分钟 / 最近运行失败 / 心跳 > 120 秒 → 通知所有管理员，1 小时去重）
select cron.schedule('az-workflow-health', '*/5 * * * *', $$select public.az_workflow_alert()$$);
```

与 `db/ops/workflow-cron.sql` 第 1–3 段相同；**不要**执行其中第 5 段（Webhook），除非站长另给地址并批准。

## 4. 验证（开启后 5 分钟内）

```sql
select jobid, jobname, schedule, active from cron.job where jobname like 'az-workflow-%';          -- 2 行，active = true
select status, return_message, start_time from cron.job_run_details
 where jobid in (select jobid from cron.job where jobname like 'az-workflow-%') order by start_time desc limit 10;  -- succeeded
select source, beat_at, interval_seconds, beats from public.workflow_scheduler_heartbeat;          -- pg_cron，beats 每分钟 +1
select id, source, due, published, orphaned, failed, error from public.workflow_tick_runs order by id desc limit 5;  -- failed = 0
select public.az_workflow_health();   -- ok = true, scheduler_configured = true, heartbeat_stale = false
```

```bash
# 迁移状态（应全部 true，未因调度改变）
psql "$PROD" -X -A -F' | ' -t -v ON_ERROR_STOP=1 -f db/verify/status.sql | grep -c ' | f$'   # 0
```

功能 canary（测试账号）：

- [ ] 版主把一条测试主题设为「待审 + 2 分钟后发布」→ 2 分钟内匿名可见，审计有且只有一条 `content.workflow.scheduled`。
- [ ] 再建一条排程后点「隐藏」→ 到点**不**发布（隐藏取消排程，站长已定）；再「恢复」→ 立即公开，排程为空（不复活旧排程）。
- [ ] 心跳告警演练（可选，5 分钟）：`select cron.alter_job((select jobid from cron.job where jobname = 'az-workflow-tick'), active := false);`
      等 3 分钟 → `az_workflow_health()` 的 `heartbeat_stale = true` → 版主打开后台或下一次 `az-workflow-health` 运行后，管理员收到「调度心跳已 … 秒未更新」通知；
      然后 `active := true` 恢复，确认 `heartbeat_stale = false`。
- [ ] 删除测试主题。

## 5. 回滚 / 停用

```sql
select cron.unschedule('az-workflow-tick');
select cron.unschedule('az-workflow-health');
-- 可选：drop extension pg_cron;（会删除所有 cron 任务，确认没有其他任务再执行）
```

- 停用后后台打开时的补偿 tick 仍然有效（回到开启前的行为），数据不需要回滚。
- 心跳表会保留最后一次心跳；停用后 `heartbeat_stale` 会变 true 并在版主打开后台时告警一次（1 小时去重）。
  确认是有意停用时：`delete from public.workflow_scheduler_heartbeat where source = 'pg_cron';`（回到「未配置调度」，不再告警）。
- 若调度误发布了内容：后台按审计 `content.workflow.scheduled`（含 `run_id`）逐条隐藏；必要时用 §2 备份恢复到新项目核对。

## 6. 观察（开启后 24 小时）

- [ ] `workflow_tick_runs` 每分钟一行、`failed = 0`；`skipped` 偶尔非 0 是正常的（内容正被隐藏 / 编辑，下一分钟再处理）。
- [ ] 没有管理员收到误报告警；收到告警时按 OPERATIONS.md §4A 排查。
- [ ] 建议另配一个**独立于数据库**的外部监控（例如 uptime 服务以 service_role 每 5 分钟调 `rpc/az_workflow_health`，`ok = false` 报警），
      防止整个数据库 / pg_cron 停摆时站内告警也发不出去（需要站长选服务、自己保管 service_role 密钥）。

## 7. 可选：内容版本清理（站长定稿保留 90 天）——单独勾选

0018 只建了 `az_prune_content_versions(p_days ≥ 90)`，没有排任何任务。若批准，增加每周一次：

```sql
select cron.schedule('az-content-versions-prune', '20 19 * * 0', $$select public.az_prune_content_versions(90)$$);  -- UTC 周日 19:20 = 北京时间周一 03:20
-- 验证：select detail from public.audit_log where action = 'content.versions.pruned' order by id desc limit 1;
-- 回滚：select cron.unschedule('az-content-versions-prune');
```

注意：0017 另有「每条内容最多保留 50 个版本」上限，与 90 天先到为准；若站长希望 90 天内一个不删，需要另改 0017 的上限（未做）。

## 8. 站长签字

- [ ] 我确认申请 ① 已完成并观察 ≥ 24 小时，批准在 `____年__月__日 __:__`（北京时间）开启 `az-workflow-tick` 与 `az-workflow-health`。
- [ ] 我已看过 §1 的排程 / 积压清单，接受开启后立即发布已到期条目（或已先处理）。
- [ ] §7 内容版本清理：批准 / 不批准（圈选）。
- [ ] Webhook 站外告警：不启用 / 启用（地址由站长另行提供，不写进仓库）。
- [ ] 执行人：________　复核人：________　签字：________
- [ ] 执行结果（§4 全部勾选）：通过 / 失败（附原因）________
