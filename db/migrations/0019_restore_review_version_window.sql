-- =============================================================================
-- 0019_restore_review_version_window.sql — 站长第二轮拍板（2026-10-27 21:06）
--
-- 只在隔离测试库执行过（tests/db/b2-restore-schedule.test.ts、b2-version-retention.test.ts、
-- scripts/db/rehearse-migrations.sh）。生产库执行需要站长另行批准，顺序见 docs/MIGRATION.md（0018 之后）。
--
--  * 恢复 → 待审：mod_set_visibility(p_published => true) 不再立即公开。被隐藏 / 下线 / 草稿的内容恢复后
--    published = false、content_workflow.status = 'review'、scheduled_at = null（永不复活旧排程）；
--    已公开的内容点「恢复」返回 unchanged，不会被降回待审。审计 content.visibility 多一个 restored=true。
--  * 显式发布：mod_publish_content(p_type, p_ids, p_idem_key)——版主 / 管理员（az_require_moderator，与
--    mod_workflow_apply 相同的角色规则）；逐项结果、去重、上限 200、幂等键；公开内容并把流程置为 published、
--    清空排程（被清掉的排程时间写进审计）；写 content.published 审计（from_status / cancelled_scheduled_at）。
--  * 旧前端直接 PATCH published=true（0018 触发器 az_workflow_sync 同步）仍等同于一次显式发布——
--    这是明确把公开标志改为 true 的写入，只有版主 / 管理员能做（RLS）；新后台的「恢复」不再走这条路。
--
-- 纯增量、可重复执行：替换 0018 的 mod_set_visibility 函数体（签名、授权不变），新增 mod_publish_content。
-- 不删列、不改已有数据。
-- =============================================================================

begin;

-- ---------------------------------------------- 恢复 → 待审（替换 0018 函数体）
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
  new_pub boolean;
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
        if p_published and cur.published then
          -- 已公开的内容点「恢复」：什么都不做，绝不降回待审
          new_status := coalesce(wf.status, 'published'); new_sched := wf.scheduled_at;
        elsif p_published then
          -- 站长第二轮（2026-10-27 21:06）：恢复 = 回到「待审」，不公开、不带排程；公开走 mod_publish_content
          new_status := 'review'; new_sched := null;
        elsif wf.target_id is not null and wf.status = 'review' and wf.scheduled_at is not null
              and not public.az_hide_cancels_schedule() then
          new_status := 'review'; new_sched := wf.scheduled_at; -- 开关为 false：保留排程
        elsif wf.target_id is not null and wf.status = 'draft' then
          new_status := 'draft'; new_sched := null;
        else
          new_status := 'offline'; new_sched := null;
        end if;
        new_pub := p_published and cur.published; -- 恢复不公开；只有本来就公开的保持公开
        if (p_published and cur.published)
           or (cur.published = new_pub and wf.target_id is not null
               and wf.status = new_status and wf.scheduled_at is not distinct from new_sched) then
          res := 'unchanged';
        else
          execute format('update public.%I set published = $2 where id = $1 and published is distinct from $2', tbl)
            using i, new_pub;
          insert into public.content_workflow (target_type, target_id, status, scheduled_at, updated_by, updated_at)
            values (p_type, i, new_status, new_sched, auth.uid(), now())
            on conflict (target_type, target_id) do update
              set status = excluded.status, scheduled_at = excluded.scheduled_at,
                  updated_by = excluded.updated_by, updated_at = now();
          -- 站长决定：恢复 = 回到待审、排程清空（schedule_revived 恒为 false）；隐藏取消的排程时间只写进审计
          perform public.az_audit('content.visibility', p_type, i::text,
            jsonb_strip_nulls(jsonb_build_object('published', new_pub, 'status', new_status,
                               'restored', case when p_published then true end,
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


-- ---------------------------------------------- 显式发布
create or replace function public.mod_publish_content(
  p_type text,
  p_ids uuid[],
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
begin
  perform public.az_require_moderator();
  if p_type not in ('thread', 'reply', 'comment') then
    raise exception '未知的内容类型' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by ord), '{}') into ids
    from (select x, min(o) as ord from unnest(coalesce(p_ids, '{}')) with ordinality u(x, o)
           where x is not null group by x) d;
  if coalesce(array_length(ids, 1), 0) > 200 then
    raise exception '一次最多 200 条（去重后 % 条）', array_length(ids, 1) using errcode = '22023';
  end if;
  prev := public.az_idem_get(p_idem_key, 'mod_publish_content');
  if prev is not null then
    return prev || jsonb_build_object('replayed', true);
  end if;
  tbl := public.az_content_table(p_type);
  perform set_config('az.wf_internal', 'on', true);
  foreach i in array ids loop
    msg := null;
    begin
      -- 锁顺序与全库一致：先内容行、后 content_workflow 行
      execute format('select id, published from public.%I where id = $1 for update', tbl) into cur using i;
      if cur.id is null then
        res := 'not_found';
      else
        select * into wf from public.content_workflow where target_type = p_type and target_id = i for update;
        if cur.published and (wf.target_id is null
                              or (wf.status = 'published' and wf.scheduled_at is null and wf.orphaned_at is null)) then
          res := 'unchanged';
        else
          execute format('update public.%I set published = true where id = $1 and published is distinct from true', tbl)
            using i;
          insert into public.content_workflow (target_type, target_id, status, scheduled_at, updated_by, updated_at, orphaned_at)
            values (p_type, i, 'published', null, auth.uid(), now(), null)
            on conflict (target_type, target_id) do update
              set status = 'published', scheduled_at = null, updated_by = excluded.updated_by,
                  updated_at = now(), orphaned_at = null;
          perform public.az_audit('content.published', p_type, i::text,
            jsonb_strip_nulls(jsonb_build_object('published', true,
                               'from_status', coalesce(wf.status, case when cur.published then 'published' else 'offline' end),
                               'cancelled_scheduled_at', wf.scheduled_at)));
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
  perform public.az_idem_put(p_idem_key, 'mod_publish_content', out_);
  return out_;
end
$$;
comment on function public.mod_publish_content(text, uuid[], text) is
  '显式发布（站长 2026-10-27 21:06：恢复只回到待审，公开必须走这里）；版主 / 管理员；写 content.published 审计';

revoke all on function public.mod_publish_content(text, uuid[], text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.mod_publish_content(text, uuid[], text) from anon';
    execute 'grant execute on function public.mod_publish_content(text, uuid[], text) to authenticated';
  end if;
end $$;

commit;
