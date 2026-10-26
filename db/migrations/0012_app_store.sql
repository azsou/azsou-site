-- =============================================================================
-- 0012_app_store.sql — 应用商店（P6）：评分评价 + 真实下载计数
--
--  * app_reviews：1–5 星 + 标题 / 正文（可只打星），每人每个应用一条（唯一约束），
--    作者可改 / 删自己的；版主可隐藏（published=false）/ 删除；被封禁用户不能写（can_write()）。
--    限流：新评价每小时 10 条、编辑每小时 30 次（版主不限）。
--    复用举报与审核：reports.target_type 增加 'review'；mod_handle_reports 的「隐藏」动作覆盖评价；
--    az_target_author 能找到评价作者（警告 / 封禁）；版主改动别人的评价记审计并通知作者。
--  * app_review_stats（视图）：每个应用已发布评价的条数、平均分、1–5 星分布。只统计 published，
--    数据全部来自真实用户评价；没有评价的应用不出现在视图里（前端显示「暂无评分」）。
--    PG 15+ 用 security_invoker（走 app_reviews 的 RLS）；更老的版本退回普通视图（只聚合已发布行，不泄露隐藏内容）。
--  * app_download_counts：每个应用 × 平台的累计下载次数，公开只读；只能通过 app_count_download() 加一。
--    app_count_download(app, platform)：
--      - app 只接受 slug（a-z0-9-，≤ 60），platform 只接受 10 种平台之一；
--      - 过滤爬虫 / 脚本：User-Agent 为空或命中 bot / crawler / spider / headless / curl / python 等不计数；
--      - 去重：同一访客（登录用户按 uid，匿名按 IP + UA；只存加盐哈希，盐每天轮换，不存 IP）
--        对同一应用 + 平台 24 小时内只计一次；
--      - 限流：同一访客每小时最多计 20 次（超出不报错，只是不再计数，下载照常跳转）；
--      - 返回该应用 + 平台的当前累计次数。
--    访客事件放在 private.app_download_events（API 不可见），保留 2 天。
--  * 纯增量，可重复执行；不影响 V72 的任何读写。
-- =============================================================================

begin;

-- ----------------------------------------------------------- app_reviews ----
create table if not exists public.app_reviews (
  id uuid primary key default gen_random_uuid(),
  app text not null,
  author uuid not null default auth.uid(),
  rating smallint not null,
  title text not null default '',
  body text not null default '',
  version text not null default '',
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint app_reviews_author_fkey foreign key (author) references public.profiles(id) on delete cascade,
  constraint app_reviews_app_check check (app ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  constraint app_reviews_rating_check check (rating between 1 and 5),
  constraint app_reviews_title_check check (char_length(title) <= 60),
  constraint app_reviews_body_check check (char_length(body) <= 1000),
  constraint app_reviews_version_check check (char_length(version) <= 40),
  constraint app_reviews_one_per_user unique (app, author)
);
create index if not exists app_reviews_app_idx on public.app_reviews (app, created_at desc) where published;
create index if not exists app_reviews_author_idx on public.app_reviews (author);

create or replace function public.az_reviews_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  mod boolean;
  changed boolean;
begin
  if tg_op = 'UPDATE' then
    changed := (new.rating, new.title, new.body, new.version) is distinct from
               (old.rating, old.title, old.body, old.version);
  end if;
  if not public.az_is_api_request() then
    if tg_op = 'UPDATE' then
      if changed then new.edited_at := now(); end if;
      new.updated_at := now();
    end if;
    return new;
  end if;
  mod := public.is_moderator();
  new.title := btrim(new.title);
  new.body := btrim(new.body);
  new.version := btrim(new.version);
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.edited_at := null;
    if not mod and not new.published then
      perform public.az_forbid('published 仅版主可设置');
    end if;
    perform public.az_rate_limit('review', 10, interval '1 hour');
    return new;
  end if;
  if new.id <> old.id or new.author <> old.author or new.app <> old.app or new.created_at <> old.created_at then
    perform public.az_forbid('id / author / app / created_at 不可修改');
  end if;
  if not mod and new.published <> old.published then
    perform public.az_forbid('published 仅版主可修改');
  end if;
  if changed then
    new.edited_at := now();
    if auth.uid() = old.author then
      perform public.az_rate_limit('review_edit', 30, interval '1 hour');
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists az_reviews_guard on public.app_reviews;
create trigger az_reviews_guard before insert or update on public.app_reviews
  for each row execute function public.az_reviews_guard();

-- 版主改动 / 删除别人的评价：记审计、隐藏时通知作者（0004 的同名函数增加 app_reviews → review）
create or replace function public.az_audit_moderation()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  kind text := case tg_table_name when 'forum_threads' then 'thread' when 'forum_replies' then 'reply'
                when 'app_reviews' then 'review' else 'comment' end;
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

drop trigger if exists az_audit_reviews on public.app_reviews;
create trigger az_audit_reviews after update or delete on public.app_reviews
  for each row execute function public.az_audit_moderation();

alter table public.app_reviews enable row level security;
drop policy if exists app_reviews_read on public.app_reviews;
create policy app_reviews_read on public.app_reviews for select to anon, authenticated
  using (published or author = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists app_reviews_insert on public.app_reviews;
create policy app_reviews_insert on public.app_reviews for insert to authenticated
  with check (author = (select auth.uid()) and (select public.can_write()));
drop policy if exists app_reviews_update on public.app_reviews;
create policy app_reviews_update on public.app_reviews for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check ((author = (select auth.uid()) and (select public.can_write())) or (select public.is_moderator()));
drop policy if exists app_reviews_delete on public.app_reviews;
create policy app_reviews_delete on public.app_reviews for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

revoke all on public.app_reviews from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_reviews from anon, authenticated';
    execute 'grant select on public.app_reviews to anon, authenticated';
    execute 'grant insert (app, author, rating, title, body, version, published),
                   update (rating, title, body, version, published), delete
               on public.app_reviews to authenticated';
  end if;
end $$;

-- ------------------------------------------------------ app_review_stats ----
drop view if exists public.app_review_stats;
do $$
declare
  q text := $q$
    select app,
           count(*)::integer as reviews,
           round(avg(rating)::numeric, 2) as average,
           count(*) filter (where rating = 5)::integer as r5,
           count(*) filter (where rating = 4)::integer as r4,
           count(*) filter (where rating = 3)::integer as r3,
           count(*) filter (where rating = 2)::integer as r2,
           count(*) filter (where rating = 1)::integer as r1,
           max(created_at) as latest
      from public.app_reviews
     where published
     group by app $q$;
begin
  if current_setting('server_version_num')::integer >= 150000 then
    execute 'create view public.app_review_stats with (security_invoker = on) as ' || q;
  else
    execute 'create view public.app_review_stats as ' || q;
  end if;
end $$;
revoke all on public.app_review_stats from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_review_stats from anon, authenticated';
    execute 'grant select on public.app_review_stats to anon, authenticated';
  end if;
end $$;

-- -------------------------------------------------- reports：可举报评价 -----
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('thread', 'reply', 'comment', 'profile', 'review'));

-- 内容作者（thread / reply / comment / profile / review）
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
    when 'review' then select author into u from public.app_reviews where id = p_id::uuid;
    else u := null;
  end case;
  return u;
end
$$;

-- 举报处理：「隐藏」动作也覆盖评价（其余与 0009 相同）
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
      if p_action = 'hide' and tgt.target_type in ('thread', 'reply', 'comment', 'review') then
        if tgt.target_type = 'thread' then
          update public.forum_threads set published = false where id = tgt.target_id::uuid and published;
        elsif tgt.target_type = 'reply' then
          update public.forum_replies set published = false where id = tgt.target_id::uuid and published;
        elsif tgt.target_type = 'review' then
          update public.app_reviews set published = false where id = tgt.target_id::uuid and published;
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

-- --------------------------------------------------- app_download_counts ----
create table if not exists public.app_download_counts (
  app text not null,
  platform text not null,
  downloads bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (app, platform),
  constraint app_download_counts_app_check check (app ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  constraint app_download_counts_platform_check check (platform in
    ('ios', 'android', 'windows', 'macos', 'linux', 'web', 'cli', 'browser-ext', 'ai-bot', 'mcp')),
  constraint app_download_counts_downloads_check check (downloads >= 0)
);
alter table public.app_download_counts enable row level security;
drop policy if exists app_download_counts_read on public.app_download_counts;
create policy app_download_counts_read on public.app_download_counts for select to anon, authenticated
  using (true);
revoke all on public.app_download_counts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_download_counts from anon, authenticated';
    execute 'grant select on public.app_download_counts to anon, authenticated';
  end if;
end $$;

create schema if not exists private;
revoke all on schema private from public;
create table if not exists private.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.app_settings from public;
-- 访客哈希的盐（只在数据库里，API 读不到）
insert into private.app_settings (key, value) values ('download_salt', gen_random_uuid()::text)
  on conflict (key) do nothing;

create table if not exists private.app_download_events (
  id bigint generated always as identity primary key,
  visitor text not null,
  app text not null,
  platform text not null,
  created_at timestamptz not null default now()
);
create index if not exists app_download_events_visitor_idx
  on private.app_download_events (visitor, created_at desc);
create index if not exists app_download_events_created_idx on private.app_download_events (created_at);
revoke all on private.app_download_events from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon, authenticated';
    execute 'revoke all on private.app_download_events, private.app_settings from anon, authenticated';
  end if;
end $$;

create or replace function public.app_count_download(p_app text, p_platform text)
 returns bigint
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  hdr jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  ua text := lower(coalesce(hdr->>'user-agent', ''));
  ip text := btrim(coalesce(hdr->>'cf-connecting-ip', split_part(hdr->>'x-forwarded-for', ',', 1),
                            hdr->>'x-real-ip', ''));
  salt text;
  who text;
  v_visitor text;
  n bigint;
begin
  if p_app is null or p_app !~ '^[a-z0-9][a-z0-9-]{0,59}$' then
    raise exception '应用标识不正确' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in
     ('ios', 'android', 'windows', 'macos', 'linux', 'web', 'cli', 'browser-ext', 'ai-bot', 'mcp') then
    raise exception '平台不正确' using errcode = '22023';
  end if;

  select c.downloads into n from public.app_download_counts c where c.app = p_app and c.platform = p_platform;
  n := coalesce(n, 0);

  -- 爬虫 / 脚本 / 预览器：不计数
  if ua = '' or ua ~ '(bot|crawl|spider|slurp|preview|headless|lighthouse|phantom|puppeteer|playwright|selenium|curl|wget|python|httpclient|okhttp|java/|go-http|node-fetch|axios|libwww|scrapy|facebookexternalhit|whatsapp|monitor|uptime|pingdom)' then
    return n;
  end if;

  select value into salt from private.app_settings where key = 'download_salt';
  who := coalesce('u:' || auth.uid()::text, 'a:' || ip || '|' || ua);
  v_visitor := encode(sha256(convert_to(coalesce(salt, '') || '|' || current_date::text || '|' || who, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('download:' || v_visitor, 0));
  -- 同一访客同一应用 + 平台 24 小时内只计一次；每小时最多计 20 次
  if exists (select 1 from private.app_download_events e
              where e.visitor = v_visitor and e.app = p_app and e.platform = p_platform
                and e.created_at > now() - interval '24 hours')
     or (select count(*) from private.app_download_events e
          where e.visitor = v_visitor and e.created_at > now() - interval '1 hour') >= 20 then
    return n;
  end if;

  insert into private.app_download_events (visitor, app, platform) values (v_visitor, p_app, p_platform);
  insert into public.app_download_counts as c (app, platform, downloads) values (p_app, p_platform, 1)
    on conflict (app, platform) do update set downloads = c.downloads + 1, updated_at = now()
    returning c.downloads into n;
  -- 顺手清理两天前的访客事件
  delete from private.app_download_events e where e.created_at < now() - interval '2 days';
  return n;
end
$$;

revoke execute on function public.app_count_download(text, text) from public;
revoke execute on function public.az_reviews_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_reviews_guard() from anon, authenticated';
    execute 'grant execute on function public.app_count_download(text, text) to anon, authenticated';
  end if;
end $$;

commit;
