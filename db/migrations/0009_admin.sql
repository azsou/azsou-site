-- =============================================================================
-- 0009_admin.sql — 管理后台（P4）：封禁记录与到期、版主处理举报、警告、后台统计与列表 RPC、
--                  @提及通知、注册开关（站点设置）
--
--  * user_bans：每次封禁一行（原因、到期时间、操作人；解封时写 lifted_at）。profiles.banned
--    仍是唯一的「是否封禁」标志（V72 读它）；到期的封禁在 is_admin / can_write / is_moderator /
--    current_app_role 里立即视为未封禁，mod_lift_expired_bans() 再把标志清掉并记审计。
--  * 版主可以封禁 / 解封普通用户、警告用户、批量处理举报（隐藏 / 锁定 / 封禁 / 警告 / 驳回）；
--    改角色仍只能由管理员经 admin_set_user()；任何人不能封禁自己。
--  * 所有后台动作都写 audit_log（RPC 显式写一条 + 0004 的内容/举报触发器照常记录）。
--  * mod_list_content / mod_list_users / admin_stats：后台列表与仪表盘（SECURITY DEFINER，
--    入口先校验 is_moderator()；邮箱只对管理员返回）。
--  * @昵称 提及：回复 / 评论发布后给被提及的人发 mention 通知（每条最多 5 人）。
--  * site_content kind='setting' slug='registration' {"open": false} 时，注册钩子拒绝新用户。
--  * 纯增量：不删列、不改已有列；V72 的读写全部照旧。可重复执行。
-- =============================================================================

begin;

-- ------------------------------------------------------------ user_bans -----
create table if not exists public.user_bans (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null default '',
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid references public.profiles(id) on delete set null,
  lift_reason text not null default '',
  constraint user_bans_reason_check check (char_length(reason) <= 500),
  constraint user_bans_lift_reason_check check (char_length(lift_reason) <= 500)
);
create index if not exists user_bans_user_idx on public.user_bans (user_id, created_at desc);
create index if not exists user_bans_active_idx on public.user_bans (user_id) where lifted_at is null;
create index if not exists user_bans_created_by_idx on public.user_bans (created_by);
create index if not exists user_bans_lifted_by_idx on public.user_bans (lifted_by);
revoke all on public.user_bans from anon, authenticated;
revoke all on sequence public.user_bans_id_seq from anon, authenticated;
alter table public.user_bans enable row level security;

-- 后台列表 / 审计筛选 / @提及查找用到的索引
create index if not exists profiles_display_name_idx on public.profiles (display_name);
create index if not exists profiles_created_idx on public.profiles (created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor, created_at desc);
create index if not exists audit_log_action_idx on public.audit_log (action, created_at desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id) where status = 'open';
create index if not exists comments_created_idx on public.comments (created_at desc);
create index if not exists forum_replies_created_idx on public.forum_replies (created_at desc);

-- -------------------------------------------------- effective ban check -----
-- 封禁标志为真，且没有「已到期但还没解除」的封禁记录 → 仍在封禁中
create or replace function public.az_banned_now(p_uid uuid, p_banned boolean)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select coalesce(p_banned, false) and not exists (
    select 1 from public.user_bans b
    where b.user_id = p_uid and b.lifted_at is null
      and b.expires_at is not null and b.expires_at <= now())
$$;

-- 签名不变（V72 与 0006 的策略在用），只把 banned 换成「当前是否仍在封禁中」
create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role = 'admin' and not public.az_banned_now(p.id, p.banned))
$function$;

create or replace function public.can_write()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and not public.az_banned_now(p.id, p.banned))
$function$;

create or replace function public.is_moderator()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('moderator', 'admin')
                   and not public.az_banned_now(p.id, p.banned))
$$;

create or replace function public.current_app_role()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select coalesce(
    (select case when public.az_banned_now(p.id, p.banned) then 'banned' else p.role end
     from public.profiles p where p.id = auth.uid()),
    'anon')
$$;

-- ------------------------------------------------------ profiles guard ------
-- 0004 的守卫 + 版主封禁通道：az.mod_ban=on 且调用者是版主时，只允许改 banned
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
    if new.role <> old.role or new.banned <> old.banned then
      if coalesce(current_setting('az.admin_set_user', true), 'off') = 'on' and public.is_admin() then
        null;
      elsif new.role = old.role and coalesce(current_setting('az.mod_ban', true), 'off') = 'on'
            and public.is_moderator() then
        null;
      else
        perform public.az_forbid('role / banned 只能通过 admin_set_user() 或封禁接口修改');
      end if;
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

-- 封禁标志变化 → 同步封禁记录（admin_set_user、V72 后台、mod_ban_user 都走这里）
create or replace function public.az_profiles_ban_sync()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  if new.banned and not old.banned then
    if not exists (select 1 from public.user_bans where user_id = new.id and lifted_at is null) then
      insert into public.user_bans (user_id, reason, created_by) values (new.id, '', auth.uid());
    end if;
  elsif old.banned and not new.banned then
    update public.user_bans
       set lifted_at = now(), lifted_by = auth.uid(),
           lift_reason = coalesce(nullif(current_setting('az.lift_reason', true), ''), lift_reason)
     where user_id = new.id and lifted_at is null;
  end if;
  return null;
end
$$;
drop trigger if exists az_profiles_ban_sync on public.profiles;
create trigger az_profiles_ban_sync after update of banned on public.profiles
  for each row execute function public.az_profiles_ban_sync();

-- 已经是封禁状态、但还没有封禁记录的老数据：补一条（原因留空、永久）
insert into public.user_bans (user_id, reason)
  select p.id, '' from public.profiles p
  where p.banned and not exists (select 1 from public.user_bans b where b.user_id = p.id and b.lifted_at is null);

-- ------------------------------------------------------------- helpers ------
create or replace function public.az_require_moderator()
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
begin
  if not public.is_moderator() then
    raise exception '仅版主或管理员可以执行这个操作' using errcode = '42501';
  end if;
end
$$;

-- 内容作者（thread / reply / comment / profile）
create or replace function public.az_target_author(p_type text, p_id text)
 returns uuid
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  u uuid;
  is_uuid boolean := p_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if not is_uuid then return null; end if;
  case p_type
    when 'thread' then select author into u from public.forum_threads where id = p_id::uuid;
    when 'reply' then select author into u from public.forum_replies where id = p_id::uuid;
    when 'comment' then select author into u from public.comments where id = p_id::uuid;
    when 'profile' then select id into u from public.profiles where id = p_id::uuid;
    else u := null;
  end case;
  return u;
end
$$;

-- ------------------------------------------------------------ ban / unban ----
create or replace function public.mod_ban_user(p_target uuid, p_reason text default '', p_expires_at timestamptz default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  t public.profiles;
  r text := btrim(coalesce(p_reason, ''));
begin
  perform public.az_require_moderator();
  if p_target = auth.uid() then
    raise exception '不能封禁自己' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_target;
  if not found then raise exception '用户不存在' using errcode = 'P0002'; end if;
  if t.role in ('moderator', 'admin') and not public.is_admin() then
    raise exception '只有管理员可以封禁版主或管理员' using errcode = '42501';
  end if;
  if char_length(r) > 500 then raise exception '原因最多 500 字' using errcode = '22001'; end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception '到期时间必须晚于现在' using errcode = '22023';
  end if;
  -- 新封禁取代旧封禁
  update public.user_bans set lifted_at = now(), lifted_by = auth.uid(), lift_reason = '被新的封禁取代'
    where user_id = p_target and lifted_at is null;
  insert into public.user_bans (user_id, reason, expires_at, created_by)
    values (p_target, r, p_expires_at, auth.uid());
  perform set_config('az.mod_ban', 'on', true);
  update public.profiles set banned = true where id = p_target and not banned;
  perform set_config('az.mod_ban', 'off', true);
  perform public.az_audit('user.ban', 'profile', p_target::text,
    jsonb_build_object('reason', r, 'expires_at', p_expires_at, 'role', t.role));
  insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
  values (p_target, auth.uid(), 'moderation', 'profile', p_target::text,
    left(format('你的账号已被限制发言%s。%s',
           case when p_expires_at is null then '' else '，至 ' || to_char(p_expires_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') end,
           case when r = '' then '' else '原因：' || r end), 200));
end
$$;

create or replace function public.mod_unban_user(p_target uuid, p_reason text default '')
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  t public.profiles;
  r text := btrim(coalesce(p_reason, ''));
begin
  perform public.az_require_moderator();
  if p_target = auth.uid() then
    raise exception '不能给自己解封' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_target;
  if not found then raise exception '用户不存在' using errcode = 'P0002'; end if;
  if t.role in ('moderator', 'admin') and not public.is_admin() then
    raise exception '只有管理员可以解封版主或管理员' using errcode = '42501';
  end if;
  if char_length(r) > 500 then raise exception '原因最多 500 字' using errcode = '22001'; end if;
  if not t.banned then return; end if;
  perform set_config('az.lift_reason', r, true);
  perform set_config('az.mod_ban', 'on', true);
  update public.profiles set banned = false where id = p_target;
  perform set_config('az.mod_ban', 'off', true);
  perform set_config('az.lift_reason', '', true);
  perform public.az_audit('user.unban', 'profile', p_target::text, jsonb_build_object('reason', r));
  insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
  values (p_target, auth.uid(), 'moderation', 'profile', p_target::text, '你的账号已恢复发言。');
end
$$;

-- 到期封禁：清掉 profiles.banned 并记审计（后台打开时调用；也可放进 pg_cron）
create or replace function public.mod_lift_expired_bans()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  b record;
  n integer := 0;
begin
  perform public.az_require_moderator();
  for b in select distinct on (user_id) user_id, id, expires_at from public.user_bans
           where lifted_at is null and expires_at is not null and expires_at <= now()
  loop
    update public.user_bans set lifted_at = now(), lift_reason = '到期自动解除'
      where user_id = b.user_id and lifted_at is null;
    perform set_config('az.mod_ban', 'on', true);
    update public.profiles set banned = false where id = b.user_id and banned;
    perform set_config('az.mod_ban', 'off', true);
    perform public.az_audit('user.ban_expired', 'profile', b.user_id::text,
      jsonb_build_object('expires_at', b.expires_at));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ---------------------------------------------------------------- warn ------
create or replace function public.mod_warn_user(p_target uuid, p_message text,
  p_target_type text default null, p_target_id text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare m text := btrim(coalesce(p_message, ''));
begin
  perform public.az_require_moderator();
  if p_target = auth.uid() then
    raise exception '不能警告自己' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_target) then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;
  if m = '' then m := '请遵守论坛版规。'; end if;
  if char_length(m) > 190 then raise exception '提醒内容最多 190 字' using errcode = '22001'; end if;
  insert into public.notifications (user_id, actor, kind, target_type, target_id, excerpt)
  values (p_target, auth.uid(), 'moderation', p_target_type, p_target_id, '版主提醒：' || m);
  perform public.az_audit('user.warn', 'profile', p_target::text,
    jsonb_build_object('message', m, 'target_type', p_target_type, 'target_id', p_target_id));
end
$$;

-- ------------------------------------------------------ handle reports ------
-- 批量处理举报：p_status = resolved | dismissed；p_action = none | hide | lock | ban | warn
-- （有处理动作时状态必须是 resolved）。只处理仍为 open 的举报；返回处理条数。
create or replace function public.mod_handle_reports(p_ids uuid[], p_status text, p_note text default '',
  p_action text default 'none', p_ban_days integer default null)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  note text := btrim(coalesce(p_note, ''));
  tgt record;
  who uuid;
  done_authors uuid[] := '{}';
  n integer;
  t_thread uuid;
  t_seed text;
begin
  perform public.az_require_moderator();
  if p_status not in ('resolved', 'dismissed') then
    raise exception '处理状态只能是 resolved 或 dismissed' using errcode = '22023';
  end if;
  if p_action not in ('none', 'hide', 'lock', 'ban', 'warn') then
    raise exception '未知的处理动作' using errcode = '22023';
  end if;
  if p_action <> 'none' and p_status <> 'resolved' then
    raise exception '执行处理动作时状态必须是「已处理」' using errcode = '22023';
  end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 100 then
    raise exception '一次处理 1–100 条举报' using errcode = '22023';
  end if;
  if char_length(note) > 500 then raise exception '处理说明最多 500 字' using errcode = '22001'; end if;
  if p_ban_days is not null and (p_ban_days < 1 or p_ban_days > 3650) then
    raise exception '封禁天数 1–3650' using errcode = '22023';
  end if;

  if p_action <> 'none' then
    for tgt in select distinct target_type, target_id from public.reports
               where id = any (p_ids) and status = 'open'
    loop
      who := public.az_target_author(tgt.target_type, tgt.target_id);
      if p_action = 'hide' and tgt.target_type in ('thread', 'reply', 'comment') then
        if tgt.target_type = 'thread' then
          update public.forum_threads set published = false where id = tgt.target_id::uuid and published;
        elsif tgt.target_type = 'reply' then
          update public.forum_replies set published = false where id = tgt.target_id::uuid and published;
        else
          update public.comments set published = false where id = tgt.target_id::uuid and published;
        end if;
      elsif p_action = 'lock' and tgt.target_type in ('thread', 'reply') then
        t_thread := null;
        t_seed := null;
        if tgt.target_type = 'thread' then
          t_thread := tgt.target_id::uuid;
        else
          select thread, seed_key into t_thread, t_seed from public.forum_replies where id = tgt.target_id::uuid;
        end if;
        if t_thread is not null then
          update public.forum_threads set locked = true where id = t_thread and not locked;
        elsif t_seed is not null then
          update public.forum_seed_threads set locked = true where key = t_seed and not locked;
        end if;
      elsif p_action = 'ban' and who is not null and who <> auth.uid() and not who = any (done_authors) then
        perform public.mod_ban_user(who, note,
          case when p_ban_days is null then null else now() + make_interval(days => p_ban_days) end);
        done_authors := done_authors || who;
      elsif p_action = 'warn' and who is not null and who <> auth.uid() and not who = any (done_authors) then
        perform public.mod_warn_user(who, coalesce(nullif(note, ''), '你发布的内容被举报，请遵守论坛版规。'),
          tgt.target_type, tgt.target_id);
        done_authors := done_authors || who;
      end if;
      perform public.az_audit('report.action.' || p_action, tgt.target_type, tgt.target_id,
        jsonb_build_object('author', who, 'note', note, 'ban_days', p_ban_days));
    end loop;
  end if;

  update public.reports set status = p_status, resolution_note = note
    where id = any (p_ids) and status = 'open';
  get diagnostics n = row_count;
  return n;
end
$$;

-- ---------------------------------------------------------------- stats -----
create or replace function public.admin_stats()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  out jsonb;
  today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  perform public.az_require_moderator();
  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'banned', (select count(*) from public.profiles where banned),
    'moderators', (select count(*) from public.profiles where role = 'moderator'),
    'admins', (select count(*) from public.profiles where role = 'admin'),
    'threads', (select count(*) from public.forum_threads),
    'threads_hidden', (select count(*) from public.forum_threads where not published),
    'replies', (select count(*) from public.forum_replies),
    'replies_hidden', (select count(*) from public.forum_replies where not published),
    'comments', (select count(*) from public.comments),
    'comments_hidden', (select count(*) from public.comments where not published),
    'reports_open', (select count(*) from public.reports where status = 'open'),
    'signups_7', (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
    'signups_30', (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'daily', (
      with days as (
        select g::date as day from generate_series(today - 29, today, interval '1 day') g
      ), su as (
        select (p.created_at at time zone 'Asia/Shanghai')::date as day, count(*) as n
          from public.profiles p where p.created_at >= now() - interval '31 days' group by 1
      ), po as (
        select (x.created_at at time zone 'Asia/Shanghai')::date as day, count(*) as n
          from (select t.created_at from public.forum_threads t where t.created_at >= now() - interval '31 days'
                union all
                select r.created_at from public.forum_replies r where r.created_at >= now() - interval '31 days'
                union all
                select c.created_at from public.comments c where c.created_at >= now() - interval '31 days') x
          group by 1
      )
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'signups', coalesce(su.n, 0), 'posts', coalesce(po.n, 0))
                                order by d.day), '[]'::jsonb)
        from days d left join su on su.day = d.day left join po on po.day = d.day),
    'generated_at', now()
  ) into out;
  return out;
end
$$;

-- ------------------------------------------------------- content list -------
create or replace function public.mod_list_content(
  p_type text,
  p_q text default null,
  p_cat text default null,
  p_hidden boolean default null,
  p_reported boolean default null,
  p_author uuid default null,
  p_limit integer default 25,
  p_offset integer default 0)
 returns table (
   id uuid, kind text, title text, excerpt text, cat text, thread_key text, page_key text,
   author uuid, author_name text, published boolean, pinned boolean, locked boolean, featured boolean,
   created_at timestamptz, edited_at timestamptz, open_reports integer, total bigint)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  term text := nullif(btrim(coalesce(p_q, '')), '');
  pat text;
begin
  perform public.az_require_moderator();
  if p_type not in ('thread', 'reply', 'comment') then
    raise exception '未知的内容类型' using errcode = '22023';
  end if;
  if term is not null then
    pat := '%' || replace(replace(replace(left(term, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  with base as (
    select t.id, 'thread'::text as kind, t.title, t.body, t.cat, t.id::text as thread_key, null::text as page_key,
           t.author, t.published, t.pinned, t.locked, t.featured, t.created_at, t.edited_at
      from public.forum_threads t where p_type = 'thread'
    union all
    select r.id, 'reply', coalesce(pt.title, st.title, r.thread_id), r.body, pt.cat, r.thread_id, null,
           r.author, r.published, false, coalesce(pt.locked, st.locked, false), false, r.created_at, r.edited_at
      from public.forum_replies r
      left join public.forum_threads pt on pt.id = r.thread
      left join public.forum_seed_threads st on st.key = r.seed_key
      where p_type = 'reply'
    union all
    select c.id, 'comment', c.page_key, c.body, null, null, c.page_key,
           c.author, c.published, false, false, false, c.created_at, c.edited_at
      from public.comments c where p_type = 'comment'
  ), rep as (
    select rp.target_type, rp.target_id, count(*)::integer as n
      from public.reports rp where rp.status = 'open' and rp.target_type = p_type
      group by rp.target_type, rp.target_id
  )
  select b.id, b.kind, b.title, left(regexp_replace(b.body, '\s+', ' ', 'g'), 160), b.cat, b.thread_key, b.page_key,
         b.author, pr.display_name, b.published, b.pinned, b.locked, b.featured, b.created_at, b.edited_at,
         coalesce(rep.n, 0), count(*) over ()
    from base b
    left join public.profiles pr on pr.id = b.author
    left join rep on rep.target_id = b.id::text
   where (pat is null or b.body ilike pat or b.title ilike pat or pr.display_name ilike pat)
     and (p_cat is null or b.cat = p_cat)
     and (p_hidden is null or b.published = not p_hidden)
     and (p_reported is null or (coalesce(rep.n, 0) > 0) = p_reported)
     and (p_author is null or b.author = p_author)
   order by b.created_at desc, b.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100)
   offset least(greatest(coalesce(p_offset, 0), 0), 100000);
end
$$;

-- ---------------------------------------------------------- user list -------
create or replace function public.mod_list_users(
  p_q text default null,
  p_role text default null,
  p_banned boolean default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_id uuid default null)
 returns table (
   id uuid, display_name text, role text, banned boolean, created_at timestamptz, email text,
   threads integer, replies integer, comments integer, reports_against integer,
   ban_reason text, ban_expires_at timestamptz, total bigint)
 language plpgsql
 stable security definer
 set search_path to 'public', 'auth'
as $$
declare
  term text := nullif(btrim(coalesce(p_q, '')), '');
  pat text;
  adm boolean := public.is_admin();
begin
  perform public.az_require_moderator();
  if term is not null then
    pat := '%' || replace(replace(replace(left(term, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  select p.id, p.display_name, p.role, p.banned, p.created_at,
         case when adm then u.email::text else null end,
         (select count(*)::integer from public.forum_threads t where t.author = p.id),
         (select count(*)::integer from public.forum_replies r where r.author = p.id),
         (select count(*)::integer from public.comments c where c.author = p.id),
         (select count(*)::integer from public.reports rp
           where rp.status = 'open' and (
             (rp.target_type = 'profile' and rp.target_id = p.id::text)
             or (rp.target_type = 'thread' and rp.target_id in (select t.id::text from public.forum_threads t where t.author = p.id))
             or (rp.target_type = 'reply' and rp.target_id in (select r.id::text from public.forum_replies r where r.author = p.id))
             or (rp.target_type = 'comment' and rp.target_id in (select c.id::text from public.comments c where c.author = p.id)))),
         b.reason, b.expires_at,
         count(*) over ()
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join lateral (
      select ub.reason, ub.expires_at from public.user_bans ub
       where ub.user_id = p.id and ub.lifted_at is null order by ub.created_at desc limit 1) b on p.banned
   where (p_id is null or p.id = p_id)
     and (pat is null or p.display_name ilike pat or p.id::text = term or (adm and u.email ilike pat))
     and (p_role is null or p.role = p_role)
     and (p_banned is null or p.banned = p_banned)
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100)
   offset least(greatest(coalesce(p_offset, 0), 0), 100000);
end
$$;

-- --------------------------------------------------------- @mentions --------
-- 「@昵称」：昵称不唯一，按「最长前缀」匹配（中文后面常紧跟正文，如 @小明你好），
-- 同长度只有一个人时才通知；不通知作者自己与被封禁用户；回复里提及主题作者时不重复（已有 reply 通知）。
create or replace function public.az_mention_targets(p_body text, p_author uuid, p_skip uuid default null)
 returns setof uuid
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  tok text;
  hit uuid;
  hits uuid[] := '{}';
  len integer;
  cnt integer;
begin
  for tok in
    select distinct m[2] from regexp_matches(coalesce(p_body, ''),
      '(^|[^0-9A-Za-z_@./])@([^\s@,，。.:：;；!！?？、()（）\[\]【】<>《》"“”''`*~|/\\]{1,40})', 'g') as m
    limit 10
  loop
    hit := null;
    for len in reverse char_length(tok)..1 loop
      select count(*), (array_agg(p.id))[1] into cnt, hit
        from public.profiles p where p.display_name = left(tok, len) and not p.banned;
      exit when cnt > 0;
    end loop;
    if cnt = 1 and hit is not null and hit <> p_author and hit is distinct from p_skip
       and not hit = any (hits) then
      hits := hits || hit;
    end if;
    exit when array_length(hits, 1) >= 5;
  end loop;
  return query select unnest(hits);
end
$$;

create or replace function public.az_notify_mentions()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  owner uuid;
  key text;
  kind text := case tg_table_name when 'comments' then 'comment' else 'reply' end;
begin
  if not new.published then return null; end if;
  if kind = 'reply' then
    key := coalesce(new.thread::text, new.seed_key, new.thread_id);
    if new.thread is not null then
      select author into owner from public.forum_threads where id = new.thread;
    end if;
  else
    key := new.page_key;
  end if;
  insert into public.notifications (user_id, actor, kind, thread_key, target_type, target_id, excerpt)
    select m, new.author, 'mention', key, kind, new.id::text, left(new.body, 140)
    from public.az_mention_targets(new.body, new.author, owner) m;
  return null;
end
$$;
drop trigger if exists az_notify_mentions on public.forum_replies;
create trigger az_notify_mentions after insert on public.forum_replies
  for each row execute function public.az_notify_mentions();
drop trigger if exists az_notify_mentions on public.comments;
create trigger az_notify_mentions after insert on public.comments
  for each row execute function public.az_notify_mentions();

-- ---------------------------------------------- signup hook: registration ----
-- 0007 的钩子 + 站点设置「注册已关闭」时拒绝所有新用户（含第三方登录首次注册）
create or replace function public.az_hook_before_user_created(event jsonb)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  provider text := coalesce(event->'user'->'app_metadata'->>'provider', 'email');
  email text := lower(btrim(coalesce(event->'user'->>'email', '')));
  ticket text := event->'user'->'user_metadata'->>'signup_ticket';
  secret text;
  ts bigint;
  sig text;
begin
  if exists (select 1 from public.site_content
             where kind = 'setting' and slug = 'registration' and published
               and jsonb_typeof(data->'open') = 'boolean' and (data->>'open')::boolean = false) then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403,
      'message', '本站暂时关闭了新用户注册。'));
  end if;
  if provider <> 'email' then
    return '{}'::jsonb;
  end if;
  select value into secret from private.app_settings where key = 'signup_ticket_secret';
  if secret is null or secret = '' then
    return '{}'::jsonb;  -- 未配置：放行
  end if;
  if ticket is null or ticket !~ '^\d{9,11}\.[0-9a-f]{64}$' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403,
      'message', '请在 azsou.com 的注册页面完成人机验证后注册。'));
  end if;
  ts := split_part(ticket, '.', 1)::bigint;
  sig := split_part(ticket, '.', 2);
  if abs(extract(epoch from now())::bigint - ts) > 900 then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403,
      'message', '注册凭证已过期，请刷新注册页面重试。'));
  end if;
  if sig <> encode(hmac(email || '.' || ts::text, secret, 'sha256'), 'hex') then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403,
      'message', '注册凭证无效，请在 azsou.com 的注册页面重新注册。'));
  end if;
  return '{}'::jsonb;
end
$$;

-- ---------------------------------------------------------- privileges ------
grant select on public.user_bans to authenticated;

revoke execute on function
  public.az_banned_now(uuid, boolean), public.az_profiles_ban_sync(), public.az_require_moderator(),
  public.az_target_author(text, text), public.az_mention_targets(text, uuid, uuid), public.az_notify_mentions(),
  public.mod_ban_user(uuid, text, timestamptz), public.mod_unban_user(uuid, text),
  public.mod_lift_expired_bans(), public.mod_warn_user(uuid, text, text, text),
  public.mod_handle_reports(uuid[], text, text, text, integer), public.admin_stats(),
  public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer),
  public.mod_list_users(text, text, boolean, integer, integer, uuid)
  from public, anon, authenticated;
-- 重新定义过的函数：保持 0005 的授权
revoke execute on function public.az_profiles_guard() from public, anon, authenticated;
revoke execute on function public.az_hook_before_user_created(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_hook_before_user_created(jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.az_hook_before_user_created(jsonb) to supabase_auth_admin';
    execute 'grant select on public.site_content to supabase_auth_admin';
  end if;
end $$;
grant execute on function public.is_admin(), public.can_write(), public.is_moderator(),
  public.current_app_role() to anon, authenticated;

grant execute on function
  public.mod_ban_user(uuid, text, timestamptz), public.mod_unban_user(uuid, text),
  public.mod_lift_expired_bans(), public.mod_warn_user(uuid, text, text, text),
  public.mod_handle_reports(uuid[], text, text, text, integer), public.admin_stats(),
  public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer),
  public.mod_list_users(text, text, boolean, integer, integer, uuid)
  to authenticated;

-- ------------------------------------------------------------- policies -----
drop policy if exists user_bans_read on public.user_bans;
create policy user_bans_read on public.user_bans for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_moderator()));

commit;
