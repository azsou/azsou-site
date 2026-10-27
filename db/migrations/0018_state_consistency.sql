-- =============================================================================
-- 0018_state_consistency.sql — 交接批次 2：状态一致性 / 调度 / 权限 / 并发 / 分页 / 审计
-- （docs/audits/2026-10-27-hark-handoff.md A01 A02 A03 A04 A05 A07 A08 A09；用例 T032–T040、T061–T070）
--
-- 只在隔离测试库执行过（tests/db/batch2.test.ts、scripts/db/rehearse-migrations.sh）。
-- 生产库执行需要站长另行批准，顺序见 docs/MIGRATION.md（0017 之后）。
--
--  * A01 一条状态接口：mod_set_visibility()（隐藏 / 恢复）与 mod_workflow_apply()（草稿 / 待审 / 发布 / 下线 / 定时）
--    在同一事务里同时改公开标志与 content_workflow；任何其他路径直接改 published（旧前端 PATCH、前台版主按钮、
--    举报处理）由触发器 az_workflow_sync 同步 workflow，不再漂移。
--  * 唯一策略开关 az_hide_cancels_schedule()：站长 2026-10-27 定稿 = true（手工隐藏会取消定时发布）。
--    恢复（取消隐藏）不复活旧排程：恢复 = 立即公开，scheduled_at 清空；被取消的排程时间只写进审计
--    （content.visibility.cancelled_scheduled_at / content.workflow.schedule_cancelled），需要时由版主重新排程。
--    开关仍保留，仅供站长日后改主意：create or replace function public.az_hide_cancels_schedule() returns boolean
--      language sql immutable as $$ select false $$;  —— 之后「隐藏」对排程中的内容不取消排程，到点仍会发布。
--  * A02 tick 核对目标 UPDATE 行数：目标已删 → 不计成功、不写成功审计，排程行标记 orphaned_at 并写
--    content.workflow.orphaned 审计；删除内容时触发器同步标记孤儿。版本历史保留（保留期待站长定）。
--  * A03 mod_workflow_tick_job(source)：给 pg_cron / 外部调度器调用（只授予 service_role，表所有者天然可调），
--    每次运行写 workflow_tick_runs（开始 / 结束 / 发布 / 孤儿 / 失败数 / 错误）；az_workflow_health() 给告警读。
--    本迁移不创建任何 cron 任务——见 db/ops/workflow-cron.sql（待站长批准）。
--  * A04 版主只能改他人内容的审核标志（published / pinned / locked / featured）；他人的 title / body / cat
--    只能由管理员经 mod_edit_content()（必须写理由，写版本、审计、通知作者）。作者改自己的照旧。
--  * A05 admin_notes / admin_user_tags 增删写最小审计（不复制备注全文）。
--  * A07 mod_edit_content(p_expected_edited_at) 与 mod_workflow_apply(p_expected) 乐观并发：过期版本返回冲突
--    （PT409 → PostgREST HTTP 409；批量里逐项 result = conflict）。
--  * A08 批量逐项结果 + 服务端去重 + 上限 200（按去重后计）+ 幂等键（admin_idempotency，24 小时内重放返回首个结果）。
--    语义：逐项独立（部分成功），每项在自己的子事务里执行。
--  * A09 mod_list_content_page / mod_list_users_page：返回 {items,total,out_of_range,last_offset}，越界页仍给真实 total。
--
-- 纯增量、可重复执行：新增表 / 列 / 函数 / 触发器；替换 0017 的 mod_set_workflow、mod_workflow_tick 函数体
-- （签名不变）。不删列、不改已有数据。
-- =============================================================================

begin;

-- ------------------------------------------------------- 策略开关（站长 2026-10-27 已定：true）
-- 手工隐藏 / 下线一条「待审 + 定时发布」的内容时，是否取消它的定时发布。
-- true（默认，站长已定）：取消排程，内容保持隐藏，不会被 tick 重新公开；之后恢复也不会复活旧排程。
-- false：保留排程，到点仍按计划发布（后台提示「仍将于 … 发布」）。
create or replace function public.az_hide_cancels_schedule()
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $$ select true $$;
comment on function public.az_hide_cancels_schedule() is
  '站长 2026-10-27 定稿：true = 手工隐藏取消定时发布；恢复不复活旧排程（恢复 = 立即公开，scheduled_at 清空）';

-- ------------------------------------------------------- 表结构增量 ---------
alter table public.content_workflow add column if not exists orphaned_at timestamptz;

create table if not exists public.workflow_tick_runs (
  id bigint generated always as identity primary key,
  source text not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  due integer not null default 0,
  published integer not null default 0,
  orphaned integer not null default 0,
  failed integer not null default 0,
  error text
);
create index if not exists workflow_tick_runs_started_idx on public.workflow_tick_runs (started_at desc);
revoke all on public.workflow_tick_runs from public;

create table if not exists public.admin_idempotency (
  actor uuid not null,
  key text not null,
  fn text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor, key),
  constraint admin_idempotency_key_check check (char_length(key) between 1 and 100)
);
revoke all on public.admin_idempotency from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.workflow_tick_runs, public.admin_idempotency from anon, authenticated';
    execute 'grant select on public.workflow_tick_runs to authenticated';
  end if;
end $$;
alter table public.workflow_tick_runs enable row level security;
drop policy if exists workflow_tick_runs_read on public.workflow_tick_runs;
create policy workflow_tick_runs_read on public.workflow_tick_runs for select to authenticated
  using ((select public.is_moderator()));
alter table public.admin_idempotency enable row level security; -- 无策略：只经 SECURITY DEFINER 函数读写

-- ------------------------------------------------------- 内部工具 -----------
create or replace function public.az_content_table(p_type text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $$
  select case p_type when 'thread' then 'forum_threads' when 'reply' then 'forum_replies'
                     when 'comment' then 'comments' end
$$;

-- 本事务内由状态接口自己改 published 时，同步触发器跳过（避免二次改写）
create or replace function public.az_wf_internal()
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $$ select coalesce(current_setting('az.wf_internal', true), '') = 'on' $$;

-- ---------------------------------------------- A01 直接改 published 的同步 --
create or replace function public.az_workflow_sync()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  kind text := case tg_table_name when 'forum_threads' then 'thread'
                                  when 'forum_replies' then 'reply' else 'comment' end;
  wf record;
begin
  if public.az_wf_internal() then
    return null;
  end if;
  select * into wf from public.content_workflow where target_type = kind and target_id = new.id for update;
  if not found then
    return null; -- 没进过流程的内容：published 本身就是唯一状态
  end if;
  if new.published and not old.published then
    update public.content_workflow
       set status = 'published', scheduled_at = null, updated_by = auth.uid(), updated_at = now()
     where target_type = kind and target_id = new.id;
  elsif not new.published then
    -- 手工隐藏（含对本来就未公开、但仍在排程中的内容点「隐藏」）
    if wf.status = 'published' or public.az_hide_cancels_schedule() then
      update public.content_workflow
         set status = case when wf.status in ('published', 'review') then 'offline' else wf.status end,
             scheduled_at = null, updated_by = auth.uid(), updated_at = now()
       where target_type = kind and target_id = new.id
         and (status is distinct from case when wf.status in ('published', 'review') then 'offline' else wf.status end
              or scheduled_at is not null);
      if wf.scheduled_at is not null then
        -- 站长决定：隐藏取消排程；被取消的时间只留在审计里（恢复不会复活它）
        perform public.az_audit('content.workflow.schedule_cancelled', kind, new.id::text,
          jsonb_build_object('cancelled_scheduled_at', wf.scheduled_at, 'via', 'published=false'));
      end if;
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists az_workflow_sync on public.forum_threads;
create trigger az_workflow_sync after update of published on public.forum_threads
  for each row execute function public.az_workflow_sync();
drop trigger if exists az_workflow_sync on public.forum_replies;
create trigger az_workflow_sync after update of published on public.forum_replies
  for each row execute function public.az_workflow_sync();
drop trigger if exists az_workflow_sync on public.comments;
create trigger az_workflow_sync after update of published on public.comments
  for each row execute function public.az_workflow_sync();

-- ---------------------------------------------- A02 删除内容 → 排程标记孤儿 --
create or replace function public.az_workflow_orphan()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  kind text := case tg_table_name when 'forum_threads' then 'thread'
                                  when 'forum_replies' then 'reply' else 'comment' end;
  sched timestamptz;
begin
  select scheduled_at into sched from public.content_workflow
   where target_type = kind and target_id = old.id and orphaned_at is null for update;
  if not found then
    return null;
  end if;
  update public.content_workflow
     set orphaned_at = now(), scheduled_at = null, updated_at = now()
   where target_type = kind and target_id = old.id;
  if sched is not null then
    perform public.az_audit('content.workflow.orphaned', kind, old.id::text,
      jsonb_build_object('result', 'target_deleted', 'scheduled_at', sched));
  end if;
  return null;
end
$$;
drop trigger if exists az_workflow_orphan on public.forum_threads;
create trigger az_workflow_orphan after delete on public.forum_threads
  for each row execute function public.az_workflow_orphan();
drop trigger if exists az_workflow_orphan on public.forum_replies;
create trigger az_workflow_orphan after delete on public.forum_replies
  for each row execute function public.az_workflow_orphan();
drop trigger if exists az_workflow_orphan on public.comments;
create trigger az_workflow_orphan after delete on public.comments
  for each row execute function public.az_workflow_orphan();

-- ---------------------------------------------- A04 他人正文只能走管理员 RPC --
create or replace function public.az_content_edit_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  changed boolean;
begin
  if not public.az_is_api_request() or auth.uid() is null or auth.uid() = old.author then
    return new;
  end if;
  changed := new.body is distinct from old.body;
  if tg_table_name = 'forum_threads' then
    changed := changed or (to_jsonb(new) ->> 'title') is distinct from (to_jsonb(old) ->> 'title')
                       or (to_jsonb(new) ->> 'cat') is distinct from (to_jsonb(old) ->> 'cat');
  end if;
  if changed and coalesce(current_setting('az.content_edit', true), '') <> 'on' then
    perform public.az_forbid('不能直接修改他人的标题 / 正文 / 分类：版主只可调整审核标志，管理员请用「编辑并注明理由」');
  end if;
  return new;
end
$$;
drop trigger if exists az_content_edit_guard on public.forum_threads;
create trigger az_content_edit_guard before update on public.forum_threads
  for each row execute function public.az_content_edit_guard();
drop trigger if exists az_content_edit_guard on public.forum_replies;
create trigger az_content_edit_guard before update on public.forum_replies
  for each row execute function public.az_content_edit_guard();
drop trigger if exists az_content_edit_guard on public.comments;
create trigger az_content_edit_guard before update on public.comments
  for each row execute function public.az_content_edit_guard();

-- 管理员编辑他人内容：理由必填、乐观并发（edited_at）、版本（0017 触发器）、审计、通知作者
create or replace function public.mod_edit_content(
  p_type text,
  p_id uuid,
  p_title text default null,
  p_body text default null,
  p_cat text default null,
  p_reason text default null,
  p_expected_edited_at timestamptz default null)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  r text := btrim(coalesce(p_reason, ''));
  cur record;
  new_edited timestamptz;
begin
  if not public.is_admin() then
    raise exception '只有管理员可以修改他人内容（版主只可调整审核标志）' using errcode = '42501';
  end if;
  if p_type not in ('thread', 'reply', 'comment') then
    raise exception '未知的内容类型' using errcode = '22023';
  end if;
  if char_length(r) not between 2 and 200 then
    raise exception '请填写 2–200 字的修改理由' using errcode = '22023';
  end if;
  if p_type <> 'thread' and (p_title is not null or p_cat is not null) then
    raise exception '只有主题有标题与分类' using errcode = '22023';
  end if;
  execute format('select id, author, edited_at, body from public.%I where id = $1 for update',
                 public.az_content_table(p_type)) into cur using p_id;
  if cur.id is null then
    raise exception '内容不存在或已删除' using errcode = 'P0002';
  end if;
  if date_trunc('milliseconds', cur.edited_at) is distinct from date_trunc('milliseconds', p_expected_edited_at) then
    raise exception '内容已被他人修改，请重新加载后再保存' using errcode = 'PT409',
      detail = coalesce(cur.edited_at::text, '');
  end if;
  perform set_config('az.content_edit', 'on', true);
  if p_type = 'thread' then
    update public.forum_threads
       set title = coalesce(p_title, title), body = coalesce(p_body, body), cat = coalesce(p_cat, cat)
     where id = p_id returning edited_at into new_edited;
  else
    execute format('update public.%I set body = coalesce($2, body) where id = $1 returning edited_at',
                   public.az_content_table(p_type)) into new_edited using p_id, p_body;
  end if;
  perform set_config('az.content_edit', 'off', true);
  perform public.az_audit('content.edit', p_type, p_id::text,
    jsonb_build_object('reason', r, 'author', cur.author,
                       'fields', to_jsonb(array_remove(array[
                          case when p_title is not null then 'title' end,
                          case when p_body is not null then 'body' end,
                          case when p_cat is not null then 'cat' end], null)),
                       'body_length', char_length(coalesce(p_body, cur.body))));
  if cur.author is not null and cur.author is distinct from auth.uid() then
    insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
    values (cur.author, auth.uid(), 'moderation', p_type, p_id::text,
            left('管理员修改了你发布的内容。理由：' || r, 200));
  end if;
  return jsonb_build_object('id', p_id, 'edited_at', new_edited);
end
$$;

-- ---------------------------------------------- A05 备注 / 标签审计 ----------
create or replace function public.az_audit_crm()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if tg_table_name = 'admin_notes' then
    if tg_op = 'INSERT' then
      perform public.az_audit('note.add', new.target_type, new.target_id,
        jsonb_build_object('note_id', new.id, 'length', char_length(new.body)));
    else
      perform public.az_audit('note.delete', old.target_type, old.target_id,
        jsonb_build_object('note_id', old.id, 'note_author', old.author));
    end if;
  else
    if tg_op = 'INSERT' then
      perform public.az_audit('tag.add', 'profile', new.user_id::text, jsonb_build_object('tag', new.tag));
    else
      perform public.az_audit('tag.remove', 'profile', old.user_id::text, jsonb_build_object('tag', old.tag));
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists az_audit_crm on public.admin_notes;
create trigger az_audit_crm after insert or delete on public.admin_notes
  for each row execute function public.az_audit_crm();
drop trigger if exists az_audit_crm on public.admin_user_tags;
create trigger az_audit_crm after insert or delete on public.admin_user_tags
  for each row execute function public.az_audit_crm();

-- ---------------------------------------------- A08 幂等键 -------------------
create or replace function public.az_idem_get(p_key text, p_fn text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  res jsonb;
begin
  if p_key is null or auth.uid() is null then
    return null;
  end if;
  if char_length(p_key) not between 1 and 100 then
    raise exception '幂等键长度 1–100' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || '|' || p_key, 0));
  delete from public.admin_idempotency where created_at < now() - interval '24 hours';
  select result into res from public.admin_idempotency where actor = auth.uid() and key = p_key and fn = p_fn;
  return res;
end
$$;
create or replace function public.az_idem_put(p_key text, p_fn text, p_result jsonb)
 returns void
 language sql
 volatile security definer
 set search_path to 'public'
as $$
  insert into public.admin_idempotency (actor, key, fn, result)
  select auth.uid(), p_key, p_fn, p_result where p_key is not null and auth.uid() is not null
  on conflict (actor, key) do nothing
$$;

-- ---------------------------------------------- A01 / A07 / A08 状态接口 -----
-- 返回：{requested, unique, duplicates, ok, failed, replayed, results:[{id, result, message?}]}
-- result: ok | unchanged | not_found | conflict | denied | failed
create or replace function public.mod_workflow_apply(
  p_type text,
  p_ids uuid[],
  p_status text,
  p_scheduled_at timestamptz default null,
  p_expected jsonb default null,
  p_idem_key text default null)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  ids uuid[];
  i uuid;
  pub boolean := p_status = 'published';
  tbl text;
  cur record;
  wf record;
  res text;
  msg text;
  results jsonb := '[]'::jsonb;
  n_ok integer := 0;
  n_fail integer := 0;
  out_ jsonb;
  prev jsonb;
begin
  perform public.az_require_moderator();
  if p_type not in ('thread', 'reply', 'comment') then
    raise exception '未知的内容类型' using errcode = '22023';
  end if;
  if p_status not in ('draft', 'review', 'published', 'offline') then
    raise exception '未知的状态' using errcode = '22023';
  end if;
  if p_scheduled_at is not null and p_status <> 'review' then
    raise exception '定时发布只能用于「待审」内容' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by ord), '{}') into ids
    from (select x, min(o) as ord from unnest(coalesce(p_ids, '{}')) with ordinality u(x, o)
           where x is not null group by x) d;
  if coalesce(array_length(ids, 1), 0) > 200 then
    raise exception '一次最多 200 条（去重后 % 条）', array_length(ids, 1) using errcode = '22023';
  end if;
  prev := public.az_idem_get(p_idem_key, 'mod_workflow_apply');
  if prev is not null then
    return prev || jsonb_build_object('replayed', true);
  end if;
  tbl := public.az_content_table(p_type);
  perform set_config('az.wf_internal', 'on', true);
  foreach i in array ids loop
    msg := null;
    begin
      execute format('select id, published from public.%I where id = $1 for update', tbl) into cur using i;
      if cur.id is null then
        res := 'not_found';
      else
        select * into wf from public.content_workflow where target_type = p_type and target_id = i for update;
        if p_expected is not null and p_expected ? i::text
           and (case when wf.target_id is null then p_expected ->> i::text is not null
                     else (p_expected ->> i::text) is null
                          or date_trunc('milliseconds', (p_expected ->> i::text)::timestamptz)
                             is distinct from date_trunc('milliseconds', wf.updated_at) end) then
          res := 'conflict';
          msg := '状态已被他人修改，请刷新后重试';
        elsif wf.target_id is not null and wf.status = p_status
              and wf.scheduled_at is not distinct from p_scheduled_at and wf.orphaned_at is null
              and cur.published = pub then
          res := 'unchanged';
        else
          execute format('update public.%I set published = $2 where id = $1 and published is distinct from $2', tbl)
            using i, pub;
          insert into public.content_workflow (target_type, target_id, status, scheduled_at, updated_by, updated_at, orphaned_at)
            values (p_type, i, p_status, p_scheduled_at, auth.uid(), now(), null)
            on conflict (target_type, target_id) do update
              set status = excluded.status, scheduled_at = excluded.scheduled_at,
                  updated_by = excluded.updated_by, updated_at = now(), orphaned_at = null;
          perform public.az_audit('content.workflow', p_type, i::text,
            jsonb_build_object('status', p_status, 'scheduled_at', p_scheduled_at));
          res := 'ok';
        end if;
      end if;
    exception when insufficient_privilege then
      res := 'denied'; msg := sqlerrm;
    when others then
      res := 'failed'; msg := sqlerrm;
    end;
    if res in ('ok', 'unchanged') then n_ok := n_ok + 1; elsif res <> 'not_found' then n_fail := n_fail + 1; end if;
    results := results || jsonb_strip_nulls(jsonb_build_object('id', i, 'result', res, 'message', msg));
  end loop;
  perform set_config('az.wf_internal', 'off', true);
  out_ := jsonb_build_object(
    'requested', coalesce(array_length(p_ids, 1), 0),
    'unique', coalesce(array_length(ids, 1), 0),
    'duplicates', coalesce(array_length(p_ids, 1), 0) - coalesce(array_length(ids, 1), 0),
    'ok', n_ok, 'failed', n_fail, 'results', results, 'replayed', false);
  perform public.az_idem_put(p_idem_key, 'mod_workflow_apply', out_);
  return out_;
end
$$;

-- 隐藏 / 恢复：同一套逐项结果；隐藏遵守 az_hide_cancels_schedule()
create or replace function public.mod_set_visibility(
  p_type text,
  p_ids uuid[],
  p_published boolean,
  p_idem_key text default null)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  ids uuid[];
  i uuid;
  tbl text;
  cur record;
  wf record;
  res text;
  msg text;
  results jsonb := '[]'::jsonb;
  n_ok integer := 0;
  n_fail integer := 0;
  out_ jsonb;
  prev jsonb;
  new_status text;
  new_sched timestamptz;
begin
  perform public.az_require_moderator();
  if p_type not in ('thread', 'reply', 'comment') or p_published is null then
    raise exception '参数不正确' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by ord), '{}') into ids
    from (select x, min(o) as ord from unnest(coalesce(p_ids, '{}')) with ordinality u(x, o)
           where x is not null group by x) d;
  if coalesce(array_length(ids, 1), 0) > 200 then
    raise exception '一次最多 200 条（去重后 % 条）', array_length(ids, 1) using errcode = '22023';
  end if;
  prev := public.az_idem_get(p_idem_key, 'mod_set_visibility');
  if prev is not null then
    return prev || jsonb_build_object('replayed', true);
  end if;
  tbl := public.az_content_table(p_type);
  perform set_config('az.wf_internal', 'on', true);
  foreach i in array ids loop
    msg := null;
    begin
      execute format('select id, published from public.%I where id = $1 for update', tbl) into cur using i;
      if cur.id is null then
        res := 'not_found';
      else
        select * into wf from public.content_workflow where target_type = p_type and target_id = i for update;
        if p_published then
          new_status := 'published'; new_sched := null;
        elsif wf.target_id is not null and wf.status = 'review' and wf.scheduled_at is not null
              and not public.az_hide_cancels_schedule() then
          new_status := 'review'; new_sched := wf.scheduled_at; -- 开关为 false：保留排程
        elsif wf.target_id is not null and wf.status = 'draft' then
          new_status := 'draft'; new_sched := null;
        else
          new_status := 'offline'; new_sched := null;
        end if;
        if cur.published = p_published and wf.target_id is not null
           and wf.status = new_status and wf.scheduled_at is not distinct from new_sched then
          res := 'unchanged';
        else
          execute format('update public.%I set published = $2 where id = $1 and published is distinct from $2', tbl)
            using i, p_published;
          insert into public.content_workflow (target_type, target_id, status, scheduled_at, updated_by, updated_at)
            values (p_type, i, new_status, new_sched, auth.uid(), now())
            on conflict (target_type, target_id) do update
              set status = excluded.status, scheduled_at = excluded.scheduled_at,
                  updated_by = excluded.updated_by, updated_at = now();
          -- 站长决定：恢复 = 立即公开、排程清空（schedule_revived 恒为 false）；隐藏取消的排程时间只写进审计
          perform public.az_audit('content.visibility', p_type, i::text,
            jsonb_strip_nulls(jsonb_build_object('published', p_published, 'status', new_status,
                               'schedule_cancelled', wf.scheduled_at is not null and new_sched is null,
                               'cancelled_scheduled_at', case when wf.scheduled_at is not null and new_sched is null
                                                              then wf.scheduled_at end,
                               'schedule_revived', case when p_published then false end)));
          res := 'ok';
        end if;
      end if;
    exception when insufficient_privilege then
      res := 'denied'; msg := sqlerrm;
    when others then
      res := 'failed'; msg := sqlerrm;
    end;
    if res in ('ok', 'unchanged') then n_ok := n_ok + 1; elsif res <> 'not_found' then n_fail := n_fail + 1; end if;
    results := results || jsonb_strip_nulls(jsonb_build_object('id', i, 'result', res, 'message', msg));
  end loop;
  perform set_config('az.wf_internal', 'off', true);
  out_ := jsonb_build_object(
    'requested', coalesce(array_length(p_ids, 1), 0),
    'unique', coalesce(array_length(ids, 1), 0),
    'duplicates', coalesce(array_length(p_ids, 1), 0) - coalesce(array_length(ids, 1), 0),
    'ok', n_ok, 'failed', n_fail, 'results', results, 'replayed', false);
  perform public.az_idem_put(p_idem_key, 'mod_set_visibility', out_);
  return out_;
end
$$;

-- 0017 的旧接口保留签名，内部改走统一接口（返回成功条数，兼容旧前端）
create or replace function public.mod_set_workflow(p_type text, p_ids uuid[], p_status text,
                                                  p_scheduled_at timestamptz default null)
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  r jsonb;
begin
  if coalesce(array_length(p_ids, 1), 0) > 200 then
    raise exception '一次最多 200 条' using errcode = '22023';
  end if;
  r := public.mod_workflow_apply(p_type, p_ids, p_status, p_scheduled_at);
  return (select count(*)::integer from jsonb_array_elements(r -> 'results') x where x ->> 'result' in ('ok', 'unchanged'));
end
$$;

-- ---------------------------------------------- A02 / A03 tick --------------
create or replace function public.az_workflow_tick_run(p_source text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  w record;
  rc integer;
  run_id bigint;
  n_due integer := 0;
  n_pub integer := 0;
  n_orph integer := 0;
  n_fail integer := 0;
  last_err text;
begin
  insert into public.workflow_tick_runs (source) values (left(coalesce(p_source, 'unknown'), 40))
    returning id into run_id;
  perform set_config('az.wf_internal', 'on', true);
  for w in select * from public.content_workflow
            where status = 'review' and scheduled_at is not null and scheduled_at <= now()
              and orphaned_at is null
            order by scheduled_at, target_id
            for update skip locked loop
    n_due := n_due + 1;
    begin
      execute format('update public.%I set published = true where id = $1', public.az_content_table(w.target_type))
        using w.target_id;
      get diagnostics rc = row_count;
      if rc = 0 then
        update public.content_workflow set scheduled_at = null, orphaned_at = now(), updated_at = now()
         where target_type = w.target_type and target_id = w.target_id;
        perform public.az_audit('content.workflow.orphaned', w.target_type, w.target_id::text,
          jsonb_build_object('result', 'target_missing', 'run_id', run_id, 'scheduled_at', w.scheduled_at));
        n_orph := n_orph + 1;
      else
        update public.content_workflow set status = 'published', scheduled_at = null, updated_at = now()
         where target_type = w.target_type and target_id = w.target_id;
        perform public.az_audit('content.workflow.scheduled', w.target_type, w.target_id::text,
          jsonb_build_object('status', 'published', 'run_id', run_id,
                             'delay_seconds', round(extract(epoch from now() - w.scheduled_at))));
        n_pub := n_pub + 1;
      end if;
    exception when others then
      n_fail := n_fail + 1;
      last_err := left(sqlerrm, 300);
      perform public.az_audit('content.workflow.failed', w.target_type, w.target_id::text,
        jsonb_build_object('result', 'failed', 'run_id', run_id, 'error', last_err));
    end;
  end loop;
  perform set_config('az.wf_internal', 'off', true);
  update public.workflow_tick_runs
     set finished_at = clock_timestamp(), due = n_due, published = n_pub, orphaned = n_orph,
         failed = n_fail, error = last_err
   where id = run_id;
  delete from public.workflow_tick_runs where started_at < now() - interval '30 days';
  return jsonb_build_object('run_id', run_id, 'due', n_due, 'published', n_pub, 'orphaned', n_orph,
                            'failed', n_fail);
end
$$;

-- 后台页面打开时的补偿调用（版主），或表所有者手动调用；返回发布条数（签名与 0017 相同）
create or replace function public.mod_workflow_tick()
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
begin
  if auth.uid() is not null then
    perform public.az_require_moderator();
  end if;
  return (public.az_workflow_tick_run(case when auth.uid() is null then 'owner' else 'admin-page' end) ->> 'published')::integer;
end
$$;

-- 无人值守调度入口：pg_cron（表所有者）或外部调度器（service_role）调用
create or replace function public.mod_workflow_tick_job(p_source text default 'cron')
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
begin
  return public.az_workflow_tick_run(coalesce(p_source, 'cron'));
end
$$;

-- 告警数据源：积压数、最老积压延迟、上次运行、最近失败；ok = 无积压超过 2 分钟且最近一次运行无失败
create or replace function public.az_workflow_health()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  overdue integer;
  oldest timestamptz;
  last_run record;
  fails integer;
begin
  if auth.uid() is not null then
    perform public.az_require_moderator();
  end if;
  select count(*), min(scheduled_at) into overdue, oldest from public.content_workflow
   where status = 'review' and scheduled_at is not null and scheduled_at <= now() and orphaned_at is null;
  select * into last_run from public.workflow_tick_runs order by id desc limit 1;
  select count(*) into fails from public.workflow_tick_runs
   where started_at > now() - interval '1 hour' and (failed > 0 or finished_at is null);
  return jsonb_build_object(
    'overdue', overdue,
    'oldest_overdue_seconds', case when oldest is null then 0 else round(extract(epoch from now() - oldest)) end,
    'last_run_at', last_run.started_at,
    'last_run_source', last_run.source,
    'last_run_age_seconds', case when last_run.started_at is null then null
                                 else round(extract(epoch from now() - last_run.started_at)) end,
    'failed_runs_1h', fails,
    'ok', (oldest is null or now() - oldest <= interval '2 minutes')
          and coalesce(last_run.failed, 0) = 0);
end
$$;

-- 告警动作：不健康时给所有管理员发一条站内通知（同类告警 1 小时内只发一次）；返回健康快照。
-- 只给表所有者 / service_role（pg_cron 或外部调度器调用），不授予 authenticated。
create or replace function public.az_workflow_alert()
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  h jsonb := public.az_workflow_health();
  msg text;
begin
  if (h ->> 'ok')::boolean then
    return h || jsonb_build_object('alerted', false);
  end if;
  if exists (select 1 from public.notifications where kind = 'system' and target_type = 'workflow'
               and created_at > now() - interval '1 hour') then
    return h || jsonb_build_object('alerted', false, 'suppressed', true);
  end if;
  msg := format('定时发布异常：积压 %s 条，最久超时 %s 秒，最近 1 小时失败运行 %s 次。请检查调度任务。',
                h ->> 'overdue', h ->> 'oldest_overdue_seconds', h ->> 'failed_runs_1h');
  insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
  select p.id, null, 'system', 'workflow', 'scheduler', left(msg, 200)
    from public.profiles p where p.role = 'admin' and not p.banned;
  perform public.az_audit('content.workflow.alert', 'workflow', 'scheduler', h);
  return h || jsonb_build_object('alerted', true);
end
$$;

-- ---------------------------------------------- A09 分页 envelope -----------
create or replace function public.mod_list_content_page(
  p_type text,
  p_q text default null,
  p_cat text default null,
  p_hidden boolean default null,
  p_reported boolean default null,
  p_author uuid default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_sort text default null,
  p_dir text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  off_ integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  items jsonb;
  total bigint;
begin
  select coalesce(jsonb_agg(to_jsonb(x) - 'total'), '[]'::jsonb), max(x.total) into items, total
    from public.mod_list_content(p_type, p_q, p_cat, p_hidden, p_reported, p_author, lim, off_, p_sort, p_dir) x;
  if total is null then
    select coalesce(max(x.total), 0) into total
      from public.mod_list_content(p_type, p_q, p_cat, p_hidden, p_reported, p_author, 1, 0, p_sort, p_dir) x;
  end if;
  return jsonb_build_object('items', items, 'total', total, 'offset', off_, 'limit', lim,
    'out_of_range', jsonb_array_length(items) = 0 and total > 0 and off_ >= total,
    'last_offset', case when total = 0 then 0 else ((total - 1) / lim) * lim end);
end
$$;

create or replace function public.mod_list_users_page(
  p_q text default null,
  p_role text default null,
  p_banned boolean default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_id uuid default null,
  p_sort text default null,
  p_dir text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  off_ integer := least(greatest(coalesce(p_offset, 0), 0), 100000);
  items jsonb;
  total bigint;
begin
  select coalesce(jsonb_agg(to_jsonb(x) - 'total'), '[]'::jsonb), max(x.total) into items, total
    from public.mod_list_users(p_q, p_role, p_banned, lim, off_, p_id, p_sort, p_dir) x;
  if total is null then
    select coalesce(max(x.total), 0) into total
      from public.mod_list_users(p_q, p_role, p_banned, 1, 0, p_id, p_sort, p_dir) x;
  end if;
  return jsonb_build_object('items', items, 'total', total, 'offset', off_, 'limit', lim,
    'out_of_range', jsonb_array_length(items) = 0 and total > 0 and off_ >= total,
    'last_offset', case when total = 0 then 0 else ((total - 1) / lim) * lim end);
end
$$;

-- ---------------------------------------------------------- privileges ------
revoke execute on function
  public.az_hide_cancels_schedule(), public.az_content_table(text), public.az_wf_internal(),
  public.az_workflow_sync(), public.az_workflow_orphan(), public.az_content_edit_guard(), public.az_audit_crm(),
  public.az_idem_get(text, text), public.az_idem_put(text, text, jsonb), public.az_workflow_tick_run(text),
  public.mod_edit_content(text, uuid, text, text, text, text, timestamptz),
  public.mod_workflow_apply(text, uuid[], text, timestamptz, jsonb, text),
  public.mod_set_visibility(text, uuid[], boolean, text),
  public.mod_workflow_tick_job(text), public.az_workflow_health(), public.az_workflow_alert(),
  public.mod_list_content_page(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
  public.mod_list_users_page(text, text, boolean, integer, integer, uuid, text, text)
  from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function
      public.az_hide_cancels_schedule(), public.az_content_table(text), public.az_wf_internal(),
      public.az_workflow_sync(), public.az_workflow_orphan(), public.az_content_edit_guard(), public.az_audit_crm(),
      public.az_idem_get(text, text), public.az_idem_put(text, text, jsonb), public.az_workflow_tick_run(text),
      public.mod_edit_content(text, uuid, text, text, text, text, timestamptz),
      public.mod_workflow_apply(text, uuid[], text, timestamptz, jsonb, text),
      public.mod_set_visibility(text, uuid[], boolean, text),
      public.mod_workflow_tick_job(text), public.az_workflow_health(), public.az_workflow_alert(),
      public.mod_list_content_page(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
      public.mod_list_users_page(text, text, boolean, integer, integer, uuid, text, text)
      from anon, authenticated';
    execute 'grant execute on function
      public.az_hide_cancels_schedule(),
      public.mod_edit_content(text, uuid, text, text, text, text, timestamptz),
      public.mod_workflow_apply(text, uuid[], text, timestamptz, jsonb, text),
      public.mod_set_visibility(text, uuid[], boolean, text),
      public.az_workflow_health(),
      public.mod_list_content_page(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
      public.mod_list_users_page(text, text, boolean, integer, integer, uuid, text, text)
      to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.mod_workflow_tick_job(text), public.az_workflow_health(), public.az_workflow_alert() to service_role';
  end if;
end $$;

commit;
