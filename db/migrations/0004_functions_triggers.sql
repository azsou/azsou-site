-- =============================================================================
-- 0004_functions_triggers.sql — 权限辅助函数、限流、列守卫触发器、通知、审计
--
-- 「谁能改哪一行」由 RLS（0006）决定；「这一行里哪些列能改成什么」由这里的
-- BEFORE 触发器决定（RLS 无法按列区分）：
--   * 普通作者不能设置 pinned / locked / featured / published，不能伪造 created_at，
--     不能把帖子改到「公告」分类，不能编辑已锁定主题；
--   * 回复只能发到存在、已发布、未锁定的主题（数据库主题或种子主题）；
--   * 发帖 / 回帖 / 评论 / 点赞 / 举报 / 改昵称按用户限流（版主与管理员豁免）。
-- 触发器只约束经由 API 角色（anon / authenticated）的写入；迁移、service_role、
-- 数据库管理员直连不受影响。
-- =============================================================================

begin;

-- ------------------------------------------------------ helper functions ----
-- 当前请求是否来自 API 角色（PostgREST 用 SET ROLE 切换到 anon/authenticated）
create or replace function public.az_is_api_request()
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $$
  select coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated')
$$;

create or replace function public.is_moderator()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role in ('moderator', 'admin') and not banned)
$$;

-- 当前用户角色（未登录为 anon，被封禁为 banned）
create or replace function public.current_app_role()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select coalesce(
    (select case when banned then 'banned' else role end from public.profiles where id = auth.uid()),
    'anon')
$$;

-- ------------------------------------------------------------ rate limit ----
-- 在 [now - per, now] 内同一用户同一动作最多 max_count 次；超出抛 SQLSTATE PT429
-- （PostgREST 会把 PTxyz 映射成 HTTP xyz，即 429 Too Many Requests）。
create or replace function public.az_rate_limit(action text, max_count integer, per interval)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null or not public.az_is_api_request() or public.is_moderator() then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || action, 0));
  select count(*) into n from public.rate_limit_events e
    where e.user_id = uid and e.action = az_rate_limit.action and e.created_at > now() - per;
  if n >= max_count then
    raise exception 'rate_limited'
      using errcode = 'PT429',
            detail = format('%s: 最多 %s 次 / %s', action, max_count, per),
            hint = '操作太频繁，请稍后再试。';
  end if;
  insert into public.rate_limit_events (user_id, action) values (uid, action);
  -- 顺手清理这个用户一天前的计数
  delete from public.rate_limit_events e
    where e.user_id = uid and e.created_at < now() - interval '1 day';
end
$$;

-- ----------------------------------------------------------- audit helper ---
create or replace function public.az_audit(action text, target_type text, target_id text, detail jsonb default '{}'::jsonb)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $$
  insert into public.audit_log (actor, actor_role, action, target_type, target_id, detail)
  values (auth.uid(), public.current_app_role(), action, target_type, target_id, coalesce(detail, '{}'::jsonb))
$$;

create or replace function public.az_forbid(msg text)
 returns void
 language plpgsql
 as $$ begin raise exception '%', msg using errcode = '42501'; end $$;

-- ----------------------------------------------------- handle_new_user ------
-- 修复：邮箱前缀可能超过 40 字（display_name 约束 1–40）导致注册失败
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  name text := coalesce(nullif(btrim(new.raw_user_meta_data->>'name'), ''),
                        nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
                        nullif(btrim(new.raw_user_meta_data->>'user_name'), ''),
                        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                        '新用户');
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(name, 40))
  on conflict (id) do nothing;
  return new;
end
$function$;

-- ------------------------------------------------------ admin_set_user ------
-- 签名不变（V72 后台在用）；新增 moderator；禁止管理员降级/封禁自己（防止锁死）；写审计
create or replace function public.admin_set_user(target uuid, new_role text, new_banned boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare old public.profiles;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if new_role not in ('user', 'moderator', 'admin') then raise exception 'bad role' using errcode = '22023'; end if;
  if target = auth.uid() and (new_role <> 'admin' or new_banned) then
    raise exception 'cannot demote or ban yourself' using errcode = '42501';
  end if;
  select * into old from public.profiles where id = target;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  -- 仅本事务有效的放行标记；守卫触发器还会再核对 is_admin()
  perform set_config('az.admin_set_user', 'on', true);
  update public.profiles set role = new_role, banned = new_banned where id = target;
  perform set_config('az.admin_set_user', 'off', true);
  perform public.az_audit('user.set_role', 'profile', target::text,
    jsonb_build_object('from', jsonb_build_object('role', old.role, 'banned', old.banned),
                       'to', jsonb_build_object('role', new_role, 'banned', new_banned)));
  if old.banned is distinct from new_banned or old.role is distinct from new_role then
    insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
    values (target, auth.uid(), 'moderation', 'profile', target::text,
            case when new_banned then '你的账号已被限制发言。'
                 else format('你的账号角色已更新为 %s。', new_role) end);
  end if;
end
$function$;

-- --------------------------------------------------------- profiles guard ---
create or replace function public.az_profiles_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if public.az_is_api_request() then
    if new.id <> old.id or new.created_at <> old.created_at then
      perform public.az_forbid('id / created_at 不可修改');
    end if;
    if (new.role <> old.role or new.banned <> old.banned)
       and not (coalesce(current_setting('az.admin_set_user', true), 'off') = 'on' and public.is_admin()) then
      perform public.az_forbid('role / banned 只能通过 admin_set_user() 修改');
    end if;
    if new.display_name is distinct from old.display_name then
      perform public.az_rate_limit('profile_update', 10, interval '1 hour');
    end if;
  end if;
  new.display_name := btrim(new.display_name);
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists az_profiles_guard on public.profiles;
create trigger az_profiles_guard before update on public.profiles
  for each row execute function public.az_profiles_guard();

-- ---------------------------------------------------------- threads guard ---
create or replace function public.az_threads_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  mod boolean;
begin
  if not public.az_is_api_request() then
    if tg_op = 'UPDATE' then
      if new.title <> old.title or new.body <> old.body then new.edited_at := now(); end if;
      new.updated_at := now();
    end if;
    return new;
  end if;
  mod := public.is_moderator();

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edited_at := null;
    if not mod and (new.pinned or new.locked or new.featured or not new.published) then
      perform public.az_forbid('pinned / locked / featured / published 仅版主可设置');
    end if;
    if new.cat = '公告' and not public.is_admin() then
      perform public.az_forbid('只有管理员可以在「公告」发帖');
    end if;
    perform public.az_rate_limit('thread', 3, interval '10 minutes');
    perform public.az_rate_limit('thread_day', 20, interval '1 day');
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.author <> old.author or new.created_at <> old.created_at then
    perform public.az_forbid('id / author / created_at 不可修改');
  end if;
  if not mod then
    if new.pinned <> old.pinned or new.locked <> old.locked
       or new.featured <> old.featured or new.published <> old.published then
      perform public.az_forbid('pinned / locked / featured / published 仅版主可修改');
    end if;
    if old.locked then
      perform public.az_forbid('主题已锁定，不能编辑');
    end if;
  end if;
  if new.cat <> old.cat and new.cat = '公告' and not public.is_admin() then
    perform public.az_forbid('只有管理员可以把主题移到「公告」');
  end if;
  if new.title <> old.title or new.body <> old.body then
    new.edited_at := now();
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists az_threads_guard on public.forum_threads;
create trigger az_threads_guard before insert or update on public.forum_threads
  for each row execute function public.az_threads_guard();

-- ---------------------------------------------------------- replies guard ---
create or replace function public.az_replies_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  mod boolean;
  t_published boolean;
  t_locked boolean;
begin
  if tg_op = 'INSERT' then
    -- 推导挂载目标：V72 只写 thread_id 文本
    if new.thread is null and new.seed_key is null then
      if new.thread_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        new.thread := new.thread_id::uuid;
      else
        new.seed_key := new.thread_id;
      end if;
    end if;
    if new.thread is not null then
      new.thread_id := new.thread::text;
    elsif new.seed_key is not null then
      new.thread_id := new.seed_key;
    end if;
  end if;

  if not public.az_is_api_request() then
    if tg_op = 'UPDATE' then
      if new.body <> old.body then new.edited_at := now(); end if;
      new.updated_at := now();
    end if;
    return new;
  end if;
  mod := public.is_moderator();

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edited_at := null;
    if not mod and not new.published then
      perform public.az_forbid('published 仅版主可设置');
    end if;
    if new.thread is not null then
      select published, locked into t_published, t_locked from public.forum_threads where id = new.thread;
      if not found then
        raise exception '主题不存在' using errcode = '23503';
      end if;
    else
      select true, locked into t_published, t_locked from public.forum_seed_threads where key = new.seed_key;
      if not found then
        raise exception '主题不存在' using errcode = '23503';
      end if;
    end if;
    if not mod and (not t_published or t_locked) then
      perform public.az_forbid('主题已锁定或不可回复');
    end if;
    perform public.az_rate_limit('reply', 6, interval '1 minute');
    perform public.az_rate_limit('reply_hour', 60, interval '1 hour');
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.author <> old.author or new.created_at <> old.created_at
     or new.thread_id <> old.thread_id or new.thread is distinct from old.thread
     or new.seed_key is distinct from old.seed_key then
    perform public.az_forbid('id / author / created_at / 所属主题不可修改');
  end if;
  if not mod then
    if new.published <> old.published then
      perform public.az_forbid('published 仅版主可修改');
    end if;
    if old.thread is not null then
      select locked into t_locked from public.forum_threads where id = old.thread;
    else
      select locked into t_locked from public.forum_seed_threads where key = old.seed_key;
    end if;
    if coalesce(t_locked, false) then
      perform public.az_forbid('主题已锁定，不能编辑回复');
    end if;
  end if;
  if new.body <> old.body then new.edited_at := now(); end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists az_replies_guard on public.forum_replies;
create trigger az_replies_guard before insert or update on public.forum_replies
  for each row execute function public.az_replies_guard();

-- --------------------------------------------------------- comments guard ---
create or replace function public.az_comments_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare mod boolean;
begin
  if not public.az_is_api_request() then
    if tg_op = 'UPDATE' then
      if new.body <> old.body then new.edited_at := now(); end if;
      new.updated_at := now();
    end if;
    return new;
  end if;
  mod := public.is_moderator();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edited_at := null;
    if not mod and not new.published then
      perform public.az_forbid('published 仅版主可设置');
    end if;
    perform public.az_rate_limit('comment', 5, interval '1 minute');
    perform public.az_rate_limit('comment_hour', 60, interval '1 hour');
    return new;
  end if;
  if new.id <> old.id or new.author <> old.author or new.created_at <> old.created_at
     or new.page_key <> old.page_key then
    perform public.az_forbid('id / author / created_at / page_key 不可修改');
  end if;
  if not mod and new.published <> old.published then
    perform public.az_forbid('published 仅版主可修改');
  end if;
  if new.body <> old.body then new.edited_at := now(); end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists az_comments_guard on public.comments;
create trigger az_comments_guard before insert or update on public.comments
  for each row execute function public.az_comments_guard();

-- ------------------------------------------------------ site_content -------
create or replace function public.az_touch_updated_at()
 returns trigger
 language plpgsql
 as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists az_site_content_touch on public.site_content;
create trigger az_site_content_touch before update on public.site_content
  for each row execute function public.az_touch_updated_at();

-- ---------------------------------------------------------- likes guard -----
create or replace function public.az_likes_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare ok boolean;
begin
  if not public.az_is_api_request() then return new; end if;
  new.created_at := now();
  ok := case new.target_type
    when 'thread' then exists (select 1 from public.forum_threads where id = new.target_id and published)
    when 'reply' then exists (select 1 from public.forum_replies where id = new.target_id and published)
    when 'comment' then exists (select 1 from public.comments where id = new.target_id and published)
    else false end;
  if not ok then
    raise exception '点赞目标不存在' using errcode = '23503';
  end if;
  perform public.az_rate_limit('like', 30, interval '1 minute');
  return new;
end
$$;
drop trigger if exists az_likes_guard on public.likes;
create trigger az_likes_guard before insert on public.likes
  for each row execute function public.az_likes_guard();

-- ------------------------------------------------------- bookmarks guard ----
create or replace function public.az_bookmarks_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if not public.az_is_api_request() then return new; end if;
  new.created_at := now();
  perform public.az_rate_limit('bookmark', 30, interval '1 minute');
  return new;
end
$$;
drop trigger if exists az_bookmarks_guard on public.bookmarks;
create trigger az_bookmarks_guard before insert on public.bookmarks
  for each row execute function public.az_bookmarks_guard();

-- --------------------------------------------------------- reports guard ----
create or replace function public.az_reports_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if not public.az_is_api_request() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'open';
    new.resolution_note := '';
    new.resolved_by := null;
    new.resolved_at := null;
    new.created_at := now();
    perform public.az_rate_limit('report', 10, interval '1 hour');
    return new;
  end if;
  if new.id <> old.id or new.reporter is distinct from old.reporter or new.target_type <> old.target_type
     or new.target_id <> old.target_id or new.reason <> old.reason or new.detail <> old.detail
     or new.created_at <> old.created_at then
    perform public.az_forbid('举报内容不可修改');
  end if;
  if new.status <> old.status then
    new.resolved_by := case when new.status = 'open' then null else auth.uid() end;
    new.resolved_at := case when new.status = 'open' then null else now() end;
  end if;
  return new;
end
$$;
drop trigger if exists az_reports_guard on public.reports;
create trigger az_reports_guard before insert or update on public.reports
  for each row execute function public.az_reports_guard();

create or replace function public.az_reports_after()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if new.status <> old.status then
    perform public.az_audit('report.' || new.status, 'report', new.id::text,
      jsonb_build_object('target_type', new.target_type, 'target_id', new.target_id, 'note', new.resolution_note));
    if new.reporter is not null and new.status <> 'open' then
      insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
      values (new.reporter, auth.uid(), 'report', new.target_type, new.target_id,
              case new.status when 'resolved' then '你的举报已处理，感谢反馈。' else '你的举报已查看，暂未发现违规。' end);
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists az_reports_after on public.reports;
create trigger az_reports_after after update on public.reports
  for each row execute function public.az_reports_after();

-- ---------------------------------------------------- notifications guard ---
create or replace function public.az_notifications_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if public.az_is_api_request() then
    if new.id <> old.id or new.user_id <> old.user_id or new.kind <> old.kind
       or new.excerpt <> old.excerpt or new.created_at <> old.created_at then
      perform public.az_forbid('通知只能标记已读');
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists az_notifications_guard on public.notifications;
create trigger az_notifications_guard before update on public.notifications
  for each row execute function public.az_notifications_guard();

-- ------------------------------------------------- reply → notification -----
create or replace function public.az_notify_reply()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare owner uuid;
begin
  if new.thread is null or not new.published then return null; end if;
  select author into owner from public.forum_threads where id = new.thread;
  if owner is not null and owner <> new.author then
    insert into public.notifications (user_id, actor, kind, thread_key, target_type, target_id, excerpt)
    values (owner, new.author, 'reply', new.thread::text, 'reply', new.id::text, left(new.body, 140));
  end if;
  return null;
end
$$;
drop trigger if exists az_notify_reply on public.forum_replies;
create trigger az_notify_reply after insert on public.forum_replies
  for each row execute function public.az_notify_reply();

-- ------------------------------------------------ moderation → audit log ----
-- 版主/管理员改动或删除「别人的」内容时记审计；作者改自己的不记。
create or replace function public.az_audit_moderation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  kind text := case tg_table_name when 'forum_threads' then 'thread' when 'forum_replies' then 'reply' else 'comment' end;
  row_author uuid := case when tg_op = 'DELETE' then old.author else new.author end;
  changes jsonb := '{}'::jsonb;
begin
  if not public.az_is_api_request() or auth.uid() is null or auth.uid() = row_author then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)), '{}'::jsonb)
      into changes
      from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
      where n.value is distinct from o.value and n.key not in ('updated_at', 'edited_at', 'body');
    if to_jsonb(new)->>'body' is distinct from to_jsonb(old)->>'body' then
      changes := changes || jsonb_build_object('body', 'edited');
    end if;
  end if;
  perform public.az_audit(kind || '.' || lower(tg_op), kind,
    (case when tg_op = 'DELETE' then old.id else new.id end)::text,
    jsonb_build_object('author', row_author, 'changes', changes));
  if tg_op = 'UPDATE' and (to_jsonb(new)->>'published')::boolean is false
     and (to_jsonb(old)->>'published')::boolean is true then
    insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
    values (row_author, auth.uid(), 'moderation', kind, new.id::text, '你发布的一条内容已被版主隐藏。');
  end if;
  return null;
end
$$;
drop trigger if exists az_audit_threads on public.forum_threads;
create trigger az_audit_threads after update or delete on public.forum_threads
  for each row execute function public.az_audit_moderation();
drop trigger if exists az_audit_replies on public.forum_replies;
create trigger az_audit_replies after update or delete on public.forum_replies
  for each row execute function public.az_audit_moderation();
drop trigger if exists az_audit_comments on public.comments;
create trigger az_audit_comments after update or delete on public.comments
  for each row execute function public.az_audit_moderation();

create or replace function public.az_audit_content()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if not public.az_is_api_request() then return null; end if;
  perform public.az_audit('content.' || lower(tg_op), 'site_content',
    case when tg_op = 'DELETE' then old.kind || ':' || old.slug else new.kind || ':' || new.slug end);
  return null;
end
$$;
drop trigger if exists az_audit_content on public.site_content;
create trigger az_audit_content after insert or update or delete on public.site_content
  for each row execute function public.az_audit_content();

-- ---------------------------------------------------------------- RPCs ------
-- 点赞汇总：一次取多条目标的点赞数与「我是否点过」
create or replace function public.like_summary(p_target_type text, p_ids uuid[])
 returns table (target_id uuid, likes bigint, liked boolean)
 language sql
 stable
 set search_path to 'public'
as $$
  select l.target_id, count(*)::bigint, bool_or(l.user_id = auth.uid())
  from public.likes l
  where l.target_type = p_target_type and l.target_id = any (p_ids)
  group by l.target_id
$$;

create or replace function public.unread_notification_count()
 returns integer
 language sql
 stable
 set search_path to 'public'
as $$
  select count(*)::integer from public.notifications where user_id = auth.uid() and read_at is null
$$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
 returns integer
 language sql
 set search_path to 'public'
as $$
  with u as (
    update public.notifications set read_at = now()
    where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
    returning 1)
  select count(*)::integer from u
$$;

commit;
