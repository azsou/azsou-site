-- =============================================================================
-- 0017_admin_crm.sql — 后台 CRM 化（P10 PR H：T10.17 / T10.18 / T10.20 / T10.21）
--
--  * T10.17 服务端排序：mod_list_content / mod_list_users 增加可选参数 p_sort / p_dir（白名单列，
--    默认仍按 created_at desc），返回列在末尾追加 wf_status / scheduled_at（内容）。
--    PostgreSQL 不能给已有函数「追加参数」，所以先 drop 旧签名的函数再建新签名——只删函数定义，
--    不碰任何表或数据；旧的调用（不带 p_sort）照常工作，因为新参数都有默认值。
--  * T10.18 后台备注：admin_notes（任意对象：用户 / 主题 / 回复 / 评论 / 官方内容），版主及以上可读写，
--    只能删自己的备注（管理员可删全部）。
--  * T10.20 用户画像：admin_user_tags（标签）；mod_user_profile(p_id) 一次返回 订阅状态（仅管理员）、
--    近期发帖、TA 发起 / 收到的举报、封禁记录、标签、登录记录（auth.sessions 存在时读取，仅管理员可见 IP）。
--    分群（新用户 / 活跃 / 被举报 / 已封禁）在前端按这些字段计算，不建表。批量邮件只有草稿与预览，
--    数据库层没有任何发信接口。
--  * T10.21 内容流程：content_workflow（草稿 draft / 待审 review / 已发布 published / 已下线 offline + 定时发布时间），
--    mod_set_workflow() 同步 published 标志；mod_workflow_tick() 把到点的定时内容发布（后台页面加载时调用，
--    有 pg_cron 时也可以排程）；content_versions + 触发器：正文 / 标题被修改时保存旧版本，供后台做版本对比。
--
-- 纯增量、可重复执行：只新建表 / 函数 / 触发器，不删列、不改已有列、不改已有数据。
-- =============================================================================

begin;

-- ------------------------------------------------------------ admin_notes ---
create table if not exists public.admin_notes (
  id bigint generated always as identity primary key,
  target_type text not null,
  target_id text not null,
  body text not null,
  author uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint admin_notes_type_check check (target_type in ('profile', 'thread', 'reply', 'comment', 'official')),
  constraint admin_notes_target_check check (char_length(target_id) between 1 and 200),
  constraint admin_notes_body_check check (char_length(btrim(body)) between 1 and 2000)
);
create index if not exists admin_notes_target_idx on public.admin_notes (target_type, target_id, created_at desc);
create index if not exists admin_notes_author_idx on public.admin_notes (author);
revoke all on public.admin_notes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.admin_notes from anon, authenticated';
    execute 'grant select, delete on public.admin_notes to authenticated';
    execute 'grant insert (target_type, target_id, body) on public.admin_notes to authenticated';
  end if;
end $$;
alter table public.admin_notes enable row level security;
drop policy if exists admin_notes_read on public.admin_notes;
create policy admin_notes_read on public.admin_notes for select to authenticated
  using ((select public.is_moderator()));
drop policy if exists admin_notes_insert on public.admin_notes;
create policy admin_notes_insert on public.admin_notes for insert to authenticated
  with check ((select public.is_moderator()) and author = (select auth.uid()));
drop policy if exists admin_notes_delete on public.admin_notes;
create policy admin_notes_delete on public.admin_notes for delete to authenticated
  using ((select public.is_moderator()) and (author = (select auth.uid()) or (select public.is_admin())));

-- -------------------------------------------------------- admin_user_tags ---
create table if not exists public.admin_user_tags (
  user_id uuid not null references public.profiles(id) on delete cascade,
  tag text not null,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, tag),
  constraint admin_user_tags_tag_check check (char_length(btrim(tag)) between 1 and 24 and tag = btrim(tag))
);
create index if not exists admin_user_tags_tag_idx on public.admin_user_tags (tag);
create index if not exists admin_user_tags_created_by_idx on public.admin_user_tags (created_by);
revoke all on public.admin_user_tags from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.admin_user_tags from anon, authenticated';
    execute 'grant select, delete on public.admin_user_tags to authenticated';
    execute 'grant insert (user_id, tag) on public.admin_user_tags to authenticated';
  end if;
end $$;
alter table public.admin_user_tags enable row level security;
drop policy if exists admin_user_tags_read on public.admin_user_tags;
create policy admin_user_tags_read on public.admin_user_tags for select to authenticated
  using ((select public.is_moderator()));
drop policy if exists admin_user_tags_insert on public.admin_user_tags;
create policy admin_user_tags_insert on public.admin_user_tags for insert to authenticated
  with check ((select public.is_moderator()));
drop policy if exists admin_user_tags_delete on public.admin_user_tags;
create policy admin_user_tags_delete on public.admin_user_tags for delete to authenticated
  using ((select public.is_moderator()));

-- -------------------------------------------------------- content_workflow --
create table if not exists public.content_workflow (
  target_type text not null,
  target_id uuid not null,
  status text not null default 'published',
  scheduled_at timestamptz,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (target_type, target_id),
  constraint content_workflow_type_check check (target_type in ('thread', 'reply', 'comment')),
  constraint content_workflow_status_check check (status in ('draft', 'review', 'published', 'offline'))
);
create index if not exists content_workflow_due_idx on public.content_workflow (scheduled_at)
  where scheduled_at is not null;
create index if not exists content_workflow_updated_by_idx on public.content_workflow (updated_by);
revoke all on public.content_workflow from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.content_workflow from anon, authenticated';
    execute 'grant select on public.content_workflow to authenticated';
  end if;
end $$;
alter table public.content_workflow enable row level security;
drop policy if exists content_workflow_read on public.content_workflow;
create policy content_workflow_read on public.content_workflow for select to authenticated
  using ((select public.is_moderator()));

-- -------------------------------------------------------- content_versions --
create table if not exists public.content_versions (
  id bigint generated always as identity primary key,
  target_type text not null,
  target_id uuid not null,
  title text,
  body text not null default '',
  editor uuid,
  created_at timestamptz not null default now(),
  constraint content_versions_type_check check (target_type in ('thread', 'reply', 'comment'))
);
create index if not exists content_versions_target_idx on public.content_versions (target_type, target_id, created_at desc);
revoke all on public.content_versions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.content_versions from anon, authenticated';
    execute 'grant select on public.content_versions to authenticated';
  end if;
end $$;
alter table public.content_versions enable row level security;
drop policy if exists content_versions_read on public.content_versions;
create policy content_versions_read on public.content_versions for select to authenticated
  using ((select public.is_moderator()));

-- 正文 / 标题被修改时保存旧版本（每个对象最多保留 50 个历史版本）
create or replace function public.az_save_content_version()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  kind text := case tg_table_name when 'forum_threads' then 'thread'
                                  when 'forum_replies' then 'reply' else 'comment' end;
  old_title text := case when tg_table_name = 'forum_threads' then to_jsonb(old) ->> 'title' end;
  new_title text := case when tg_table_name = 'forum_threads' then to_jsonb(new) ->> 'title' end;
begin
  if old.body is distinct from new.body or old_title is distinct from new_title then
    insert into public.content_versions (target_type, target_id, title, body, editor)
      values (kind, old.id, old_title, coalesce(old.body, ''), auth.uid());
    delete from public.content_versions v
     where v.target_type = kind and v.target_id = old.id
       and v.id not in (select v2.id from public.content_versions v2
                         where v2.target_type = kind and v2.target_id = old.id
                         order by v2.created_at desc, v2.id desc limit 50);
  end if;
  return new;
end
$$;
drop trigger if exists az_content_version on public.forum_threads;
create trigger az_content_version after update of body, title on public.forum_threads
  for each row execute function public.az_save_content_version();
drop trigger if exists az_content_version on public.forum_replies;
create trigger az_content_version after update of body on public.forum_replies
  for each row execute function public.az_save_content_version();
drop trigger if exists az_content_version on public.comments;
create trigger az_content_version after update of body on public.comments
  for each row execute function public.az_save_content_version();

-- ------------------------------------------------- 工作流 RPC ---------------
create or replace function public.mod_set_workflow(p_type text, p_ids uuid[], p_status text,
                                                  p_scheduled_at timestamptz default null)
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  n integer := 0;
  pub boolean;
  i uuid;
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
  if coalesce(array_length(p_ids, 1), 0) > 200 then
    raise exception '一次最多 200 条' using errcode = '22023';
  end if;
  pub := p_status = 'published';
  foreach i in array coalesce(p_ids, '{}') loop
    if p_type = 'thread' then
      update public.forum_threads set published = pub where id = i and published is distinct from pub;
      perform 1 from public.forum_threads where id = i;
    elsif p_type = 'reply' then
      update public.forum_replies set published = pub where id = i and published is distinct from pub;
      perform 1 from public.forum_replies where id = i;
    else
      update public.comments set published = pub where id = i and published is distinct from pub;
      perform 1 from public.comments where id = i;
    end if;
    continue when not found;
    insert into public.content_workflow (target_type, target_id, status, scheduled_at, updated_by, updated_at)
      values (p_type, i, p_status, p_scheduled_at, auth.uid(), now())
      on conflict (target_type, target_id) do update
        set status = excluded.status, scheduled_at = excluded.scheduled_at,
            updated_by = excluded.updated_by, updated_at = now();
    perform public.az_audit('content.workflow', p_type, i::text,
      jsonb_build_object('status', p_status, 'scheduled_at', p_scheduled_at));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- 把到点的定时内容发布；返回发布条数。版主调用（后台加载时），或 pg_cron 以表所有者身份调用。
create or replace function public.mod_workflow_tick()
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $$
declare
  w record;
  n integer := 0;
begin
  if auth.uid() is not null then
    perform public.az_require_moderator();
  end if;
  for w in select * from public.content_workflow
            where status = 'review' and scheduled_at is not null and scheduled_at <= now()
            for update skip locked loop
    if w.target_type = 'thread' then
      update public.forum_threads set published = true where id = w.target_id;
    elsif w.target_type = 'reply' then
      update public.forum_replies set published = true where id = w.target_id;
    else
      update public.comments set published = true where id = w.target_id;
    end if;
    update public.content_workflow set status = 'published', scheduled_at = null, updated_at = now()
     where target_type = w.target_type and target_id = w.target_id;
    perform public.az_audit('content.workflow.scheduled', w.target_type, w.target_id::text,
      jsonb_build_object('status', 'published'));
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ------------------------------------------------- content list（排序）-----
drop function if exists public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer);
create or replace function public.mod_list_content(
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
 returns table (
   id uuid, kind text, title text, excerpt text, cat text, thread_key text, page_key text,
   author uuid, author_name text, published boolean, pinned boolean, locked boolean, featured boolean,
   created_at timestamptz, edited_at timestamptz, open_reports integer, total bigint,
   wf_status text, scheduled_at timestamptz)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare
  term text := nullif(btrim(coalesce(p_q, '')), '');
  pat text;
  srt text := coalesce(p_sort, 'created_at');
  asc_ boolean := lower(coalesce(p_dir, 'desc')) in ('asc', 'ascending');
begin
  perform public.az_require_moderator();
  if p_type not in ('thread', 'reply', 'comment') then
    raise exception '未知的内容类型' using errcode = '22023';
  end if;
  if srt not in ('created_at', 'edited_at', 'title', 'author_name', 'cat', 'open_reports', 'published') then
    raise exception '不支持按这一列排序' using errcode = '22023';
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
  ), rows_ as (
    select b.id, b.kind, b.title, left(regexp_replace(b.body, '\s+', ' ', 'g'), 160) as excerpt, b.cat,
           b.thread_key, b.page_key, b.author, pr.display_name as author_name, b.published, b.pinned, b.locked,
           b.featured, b.created_at, b.edited_at, coalesce(rep.n, 0) as open_reports,
           coalesce(wf.status, case when b.published then 'published' else 'offline' end) as wf_status,
           wf.scheduled_at
      from base b
      left join public.profiles pr on pr.id = b.author
      left join rep on rep.target_id = b.id::text
      left join public.content_workflow wf on wf.target_type = p_type and wf.target_id = b.id
     where (pat is null or b.body ilike pat or b.title ilike pat or pr.display_name ilike pat)
       and (p_cat is null or b.cat = p_cat)
       and (p_hidden is null or b.published = not p_hidden)
       and (p_reported is null or (coalesce(rep.n, 0) > 0) = p_reported)
       and (p_author is null or b.author = p_author)
  )
  select r.id, r.kind, r.title, r.excerpt, r.cat, r.thread_key, r.page_key, r.author, r.author_name,
         r.published, r.pinned, r.locked, r.featured, r.created_at, r.edited_at, r.open_reports,
         count(*) over (), r.wf_status, r.scheduled_at
    from rows_ r
   order by
     case when asc_ then case srt when 'title' then r.title when 'author_name' then r.author_name
                                  when 'cat' then r.cat end end asc nulls last,
     case when not asc_ then case srt when 'title' then r.title when 'author_name' then r.author_name
                                      when 'cat' then r.cat end end desc nulls last,
     case when asc_ then case srt when 'created_at' then r.created_at
                                  when 'edited_at' then coalesce(r.edited_at, r.created_at) end end asc,
     case when not asc_ then case srt when 'created_at' then r.created_at
                                      when 'edited_at' then coalesce(r.edited_at, r.created_at) end end desc,
     case when asc_ then case srt when 'open_reports' then r.open_reports
                                  when 'published' then r.published::int end end asc,
     case when not asc_ then case srt when 'open_reports' then r.open_reports
                                      when 'published' then r.published::int end end desc,
     r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100)
   offset least(greatest(coalesce(p_offset, 0), 0), 100000);
end
$$;

-- ---------------------------------------------------- user list（排序）-----
drop function if exists public.mod_list_users(text, text, boolean, integer, integer, uuid);
create or replace function public.mod_list_users(
  p_q text default null,
  p_role text default null,
  p_banned boolean default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_id uuid default null,
  p_sort text default null,
  p_dir text default null)
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
  srt text := coalesce(p_sort, 'created_at');
  asc_ boolean := lower(coalesce(p_dir, 'desc')) in ('asc', 'ascending');
begin
  perform public.az_require_moderator();
  if srt not in ('created_at', 'display_name', 'role', 'threads', 'replies', 'comments', 'reports_against', 'banned') then
    raise exception '不支持按这一列排序' using errcode = '22023';
  end if;
  if term is not null then
    pat := '%' || replace(replace(replace(left(term, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  with u_ as (
    select p.id, p.display_name, p.role, p.banned, p.created_at,
           case when adm then u.email::text else null end as email,
           (select count(*)::integer from public.forum_threads t where t.author = p.id) as threads,
           (select count(*)::integer from public.forum_replies r where r.author = p.id) as replies,
           (select count(*)::integer from public.comments c where c.author = p.id) as comments,
           (select count(*)::integer from public.reports rp
             where rp.status = 'open' and (
               (rp.target_type = 'profile' and rp.target_id = p.id::text)
               or (rp.target_type = 'thread' and rp.target_id in (select t.id::text from public.forum_threads t where t.author = p.id))
               or (rp.target_type = 'reply' and rp.target_id in (select r.id::text from public.forum_replies r where r.author = p.id))
               or (rp.target_type = 'comment' and rp.target_id in (select c.id::text from public.comments c where c.author = p.id))))
             as reports_against,
           b.reason as ban_reason, b.expires_at as ban_expires_at
      from public.profiles p
      left join auth.users u on u.id = p.id
      left join lateral (
        select ub.reason, ub.expires_at from public.user_bans ub
         where ub.user_id = p.id and ub.lifted_at is null order by ub.created_at desc limit 1) b on p.banned
     where (p_id is null or p.id = p_id)
       and (pat is null or p.display_name ilike pat or p.id::text = term or (adm and u.email ilike pat))
       and (p_role is null or p.role = p_role)
       and (p_banned is null or p.banned = p_banned)
  )
  select x.id, x.display_name, x.role, x.banned, x.created_at, x.email, x.threads, x.replies, x.comments,
         x.reports_against, x.ban_reason, x.ban_expires_at, count(*) over ()
    from u_ x
   order by
     case when asc_ then case srt when 'display_name' then x.display_name when 'role' then x.role end end asc nulls last,
     case when not asc_ then case srt when 'display_name' then x.display_name when 'role' then x.role end end desc nulls last,
     case when asc_ then case srt when 'threads' then x.threads when 'replies' then x.replies
                                  when 'comments' then x.comments when 'reports_against' then x.reports_against
                                  when 'banned' then x.banned::int end end asc,
     case when not asc_ then case srt when 'threads' then x.threads when 'replies' then x.replies
                                      when 'comments' then x.comments when 'reports_against' then x.reports_against
                                      when 'banned' then x.banned::int end end desc,
     case when asc_ and srt = 'created_at' then x.created_at end asc,
     x.created_at desc, x.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 100)
   offset least(greatest(coalesce(p_offset, 0), 0), 100000);
end
$$;

-- ---------------------------------------------------------- 用户画像 --------
create or replace function public.mod_user_profile(p_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'auth'
as $$
declare
  adm boolean := public.is_admin();
  em text;
  au jsonb;
  logins jsonb := '[]'::jsonb;
  sub jsonb := null;
begin
  perform public.az_require_moderator();
  if not exists (select 1 from public.profiles where id = p_id) then
    return null;
  end if;
  select to_jsonb(u), u.email::text into au, em from auth.users u where u.id = p_id;
  if adm and em is not null and to_regclass('public.subscribers') is not null then
    select jsonb_build_object('status', s.status, 'lang', s.lang, 'confirmed_at', s.confirmed_at,
                              'unsubscribed_at', s.unsubscribed_at)
      into sub from public.subscribers s where s.email = lower(em);
  end if;
  if to_regclass('auth.sessions') is not null then
    execute format(
      'select coalesce(jsonb_agg(x order by x.created_at desc), %L::jsonb) from (
         select s.created_at, s.updated_at,
                case when $2 then to_jsonb(s) ->> %L end as ip,
                to_jsonb(s) ->> %L as user_agent
           from auth.sessions s where s.user_id = $1 order by s.created_at desc limit 20) x',
      '[]', 'ip', 'user_agent')
      into logins using p_id, adm;
  end if;
  return jsonb_build_object(
    'id', p_id,
    'last_sign_in_at', au ->> 'last_sign_in_at',
    'email_confirmed_at', au ->> 'email_confirmed_at',
    'subscription', sub,
    'subscription_visible', adm,
    'logins', logins,
    'tags', (select coalesce(jsonb_agg(t.tag order by t.created_at), '[]'::jsonb)
               from public.admin_user_tags t where t.user_id = p_id),
    'posts', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                select * from (
                  select 'thread' as kind, t.id, t.title, left(t.body, 120) as excerpt, t.published, t.created_at
                    from public.forum_threads t where t.author = p_id
                  union all
                  select 'reply', r.id, null, left(r.body, 120), r.published, r.created_at
                    from public.forum_replies r where r.author = p_id
                  union all
                  select 'comment', c.id, c.page_key, left(c.body, 120), c.published, c.created_at
                    from public.comments c where c.author = p_id) a
                 order by a.created_at desc limit 20) x),
    'reports_filed', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                select rp.id, rp.target_type, rp.target_id, rp.reason, rp.status, rp.created_at
                  from public.reports rp where rp.reporter = p_id order by rp.created_at desc limit 20) x),
    'reports_against', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                select rp.id, rp.target_type, rp.target_id, rp.reason, rp.status, rp.created_at
                  from public.reports rp
                 where (rp.target_type = 'profile' and rp.target_id = p_id::text)
                    or (rp.target_type = 'thread' and rp.target_id in (select t.id::text from public.forum_threads t where t.author = p_id))
                    or (rp.target_type = 'reply' and rp.target_id in (select r.id::text from public.forum_replies r where r.author = p_id))
                    or (rp.target_type = 'comment' and rp.target_id in (select c.id::text from public.comments c where c.author = p_id))
                 order by rp.created_at desc limit 20) x)
  );
end
$$;

-- ---------------------------------------------------------- privileges ------
revoke execute on function
  public.az_save_content_version(),
  public.mod_set_workflow(text, uuid[], text, timestamptz), public.mod_workflow_tick(),
  public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
  public.mod_list_users(text, text, boolean, integer, integer, uuid, text, text),
  public.mod_user_profile(uuid)
  from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_save_content_version(),
      public.mod_set_workflow(text, uuid[], text, timestamptz), public.mod_workflow_tick(),
      public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
      public.mod_list_users(text, text, boolean, integer, integer, uuid, text, text),
      public.mod_user_profile(uuid) from anon, authenticated';
    execute 'grant execute on function
      public.mod_set_workflow(text, uuid[], text, timestamptz), public.mod_workflow_tick(),
      public.mod_list_content(text, text, text, boolean, boolean, uuid, integer, integer, text, text),
      public.mod_list_users(text, text, boolean, integer, integer, uuid, text, text),
      public.mod_user_profile(uuid) to authenticated';
  end if;
end $$;

commit;
