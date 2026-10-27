-- =============================================================================
-- db/ops/workflow-cron.sql — A03 定时发布无人值守调度（**待站长批准，未在任何环境自动执行**）
--
-- 前提：生产库已执行 0018（db/verify/status.sql 的 0018 行为 true）。
-- 执行位置：Supabase → SQL Editor（项目所有者身份）。pg_cron 以表所有者身份运行，auth.uid() 为空，
--           mod_workflow_tick_job / az_workflow_alert 都允许这种调用。
-- 承诺：每分钟调度一次 → 到期内容 2 分钟内公开；双 worker 由 FOR UPDATE SKIP LOCKED 保证不重复发布（T062）。
-- 告警：每 5 分钟 az_workflow_alert()——积压超过 2 分钟或最近一次运行有失败 → 给所有管理员发站内通知
--       （1 小时内同类只发一次），并写 audit_log「content.workflow.alert」。站外告警见下方可选的 pg_net 段。
-- 回滚：select cron.unschedule('az-workflow-tick'); select cron.unschedule('az-workflow-health');
--       （停调度后后台页面打开时的补偿 tick 仍然有效，但不再是无人值守。）
-- =============================================================================

-- 1) 启用扩展（Supabase：Database → Extensions → pg_cron，或下面这句）
create extension if not exists pg_cron;

-- 2) 每分钟发布到期内容（运行记录写 public.workflow_tick_runs）
select cron.schedule('az-workflow-tick', '* * * * *', $$select public.mod_workflow_tick_job('pg_cron')$$);

-- 3) 每 5 分钟健康检查 + 站内告警
select cron.schedule('az-workflow-health', '*/5 * * * *', $$select public.az_workflow_alert()$$);

-- 4) 核对
select jobid, jobname, schedule, active from cron.job where jobname like 'az-workflow-%';
-- 最近运行（pg_cron 自身的记录）：
-- select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- 业务侧记录：
-- select * from public.workflow_tick_runs order by id desc limit 10;
-- select public.az_workflow_health();

-- 5) 可选：站外告警（需要站长提供 Webhook 地址，例如企业微信 / 飞书 / Slack；地址不要写进仓库）
-- create extension if not exists pg_net;
-- select cron.schedule('az-workflow-webhook', '*/5 * * * *', $$
--   select net.http_post(url := current_setting('app.workflow_alert_webhook', true),
--                        body := jsonb_build_object('text', '定时发布异常', 'health', public.az_workflow_health()))
--    where not (public.az_workflow_health() ->> 'ok')::boolean
--      and current_setting('app.workflow_alert_webhook', true) is not null $$);
-- 设置地址：alter database postgres set app.workflow_alert_webhook = '<站长提供>';
