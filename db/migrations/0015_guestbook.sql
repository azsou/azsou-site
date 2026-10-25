-- =============================================================================
-- 0015_guestbook.sql — 访客留言板（T7.3）与友链申请（T7.4）
--
--  * guestbook_entries：允许匿名（只填昵称）。只能经 guestbook_submit() 写入，且一律是 pending（待审核）；
--    公开只读 approved。版主 / 管理员在后台通过（approved）或拒绝（rejected）、删除；每个动作写审计。
--  * friend_links：友链申请（站点名、https 地址、简介、联系方式）。只能经 friend_link_submit() 写入（pending），
--    公开只读 approved，且读不到联系方式；只有管理员能看申请详情、通过 / 拒绝 / 删除。
--  * 人机验证：浏览器 → 本站 Vercel Function /api/submit/<kind>（服务端校验 Turnstile）→ 签发 HMAC 票据
--    → 带票据调用本迁移的 RPC。数据库用 private.app_settings 里的 community_ticket_secret 核对票据
--    （10 分钟有效、一次性、内容摘要绑定），所以绕过本站直接调 RPC 的机器人写不进来。
--    **未配置密钥时 RPC 一律拒绝**（与 0007 的注册钩子相反：这里没有旧版本需要兼容）。
--  * 限流（不存 IP）：Function 把 IP 做成带密钥的 HMAC 摘要（client）放进票据；每个 client
--    留言 3 次 / 10 分钟、10 次 / 天，友链申请 2 次 / 天；待审核队列上限（留言 200、友链 50）。
--  * 不允许登录用户自动通过（规格没有要求）：所有提交都进待审核。
--
-- 启用（生产）：
--   1. 生成随机密钥（openssl rand -hex 32），Vercel 环境变量 COMMUNITY_TICKET_SECRET 设为它；
--   2. SQL 编辑器：insert into private.app_settings (key, value) values ('community_ticket_secret', '<同一个密钥>')
--        on conflict (key) do update set value = excluded.value, updated_at = now();
--   3. Vercel 已有 TURNSTILE_SECRET_KEY / TURNSTILE_SITE_KEY（注册页在用）即可，无需新的 Turnstile 小组件。
-- 纯增量、可重复执行；不改任何已有表。
-- =============================================================================

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
create table if not exists private.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.app_settings from public;

-- ------------------------------------------------------------- tables -------
create table if not exists public.guestbook_entries (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  body text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderated_by uuid references public.profiles(id) on delete set null,
  constraint guestbook_nickname_check check (char_length(nickname) between 1 and 24 and nickname !~ '[[:cntrl:]]'
                                             and nickname = btrim(nickname)),
  constraint guestbook_body_check check (char_length(body) between 1 and 500 and body = btrim(body)
                                         and body !~ '[\x01-\x08\x0b-\x1f\x7f]'),
  constraint guestbook_status_check check (status in ('pending', 'approved', 'rejected'))
);
create index if not exists guestbook_public_idx on public.guestbook_entries (created_at desc, id desc)
  where status = 'approved';
create index if not exists guestbook_status_idx on public.guestbook_entries (status, created_at desc);
create index if not exists guestbook_moderated_by_idx on public.guestbook_entries (moderated_by);

create table if not exists public.friend_links (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  description text not null default '',
  contact text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderated_by uuid references public.profiles(id) on delete set null,
  constraint friend_links_name_check check (char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'
                                            and name = btrim(name)),
  constraint friend_links_url_check check (char_length(url) <= 200
                                           and url ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?(/[^[:space:][:cntrl:]]*)?$'),
  constraint friend_links_description_check check (char_length(description) <= 120 and description !~ '[[:cntrl:]]'),
  constraint friend_links_contact_check check (char_length(contact) <= 120 and contact !~ '[[:cntrl:]]'),
  constraint friend_links_status_check check (status in ('pending', 'approved', 'rejected'))
);
create index if not exists friend_links_status_idx on public.friend_links (status, created_at desc);
create index if not exists friend_links_moderated_by_idx on public.friend_links (moderated_by);
create unique index if not exists friend_links_url_active_idx on public.friend_links (lower(url))
  where status in ('pending', 'approved');

-- 提交记录：限流与票据一次性（只存带密钥的 client 摘要，不存 IP）
create table if not exists private.community_submissions (
  sig text primary key,
  kind text not null,
  client text not null,
  created_at timestamptz not null default now()
);
create index if not exists community_submissions_client_idx
  on private.community_submissions (client, kind, created_at desc);
create index if not exists community_submissions_created_idx on private.community_submissions (created_at);
revoke all on private.community_submissions from public;

-- ------------------------------------------------------- privileges + RLS ---
revoke all on public.guestbook_entries, public.friend_links from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon, authenticated';
    execute 'revoke all on private.community_submissions, private.app_settings from anon, authenticated';
    execute 'revoke all on public.guestbook_entries, public.friend_links from anon, authenticated';
    -- 只读，且友链读不到 contact
    execute 'grant select (id, nickname, body, status, created_at, moderated_at) on public.guestbook_entries to anon, authenticated';
    execute 'grant select (id, name, url, description, status, created_at) on public.friend_links to anon, authenticated';
  end if;
end $$;

alter table public.guestbook_entries enable row level security;
alter table public.friend_links enable row level security;

drop policy if exists guestbook_read on public.guestbook_entries;
create policy guestbook_read on public.guestbook_entries for select to anon, authenticated
  using (status = 'approved' or (select public.is_moderator()));

drop policy if exists friend_links_read on public.friend_links;
create policy friend_links_read on public.friend_links for select to anon, authenticated
  using (status = 'approved' or (select public.is_admin()));

-- ------------------------------------------------------------- tickets ------
-- 票据：<unix秒>.<client 32 hex>.<hex(HMAC-SHA256(secret, kind|ts|client|sha256(payload)))>
-- payload：留言 = 昵称 \n 内容；友链 = 名称 \n 地址 \n 简介 \n 联系方式（与 src/lib/community-forms.ts 一致）
create or replace function public.az_community_ticket(p_kind text, p_payload text, p_ticket text)
 returns text
 language plpgsql
 volatile security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  secret text;
  ts bigint;
  client text;
  sig text;
  want text;
begin
  select value into secret from private.app_settings where key = 'community_ticket_secret';
  if secret is null or secret = '' then
    raise exception '留言与友链申请暂未开放' using errcode = 'PT503',
      hint = '站长还没有配置 community_ticket_secret（db/migrations/0015_guestbook.sql）。';
  end if;
  if p_ticket is null or p_ticket !~ '^\d{9,11}\.[0-9a-f]{32}\.[0-9a-f]{64}$' then
    raise exception '请在本站页面完成人机验证后提交' using errcode = '42501';
  end if;
  ts := split_part(p_ticket, '.', 1)::bigint;
  client := split_part(p_ticket, '.', 2);
  sig := split_part(p_ticket, '.', 3);
  if extract(epoch from now())::bigint - ts > 600 or ts - extract(epoch from now())::bigint > 60 then
    raise exception '提交凭证已过期，请刷新页面后重试' using errcode = '42501';
  end if;
  want := encode(hmac(p_kind || '|' || ts::text || '|' || client || '|'
                      || encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), secret, 'sha256'), 'hex');
  if sig <> want then
    raise exception '提交凭证无效，请在本站页面重新提交' using errcode = '42501';
  end if;
  -- 一次性：同一张票据只能用一次
  begin
    insert into private.community_submissions (sig, kind, client) values (sig, p_kind, client);
  exception when unique_violation then
    raise exception '这次提交已经处理过了' using errcode = '42501';
  end;
  return client;
end
$$;

create or replace function public.az_community_limit(p_kind text, p_client text, p_max integer, p_per interval)
 returns void
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
begin
  -- 本次提交已在 az_community_ticket 里记了一条，所以是「> 上限」
  if (select count(*) from private.community_submissions s
       where s.client = p_client and s.kind = p_kind and s.created_at > now() - p_per) > p_max then
    raise exception 'rate_limited' using errcode = 'PT429',
      detail = format('%s: 最多 %s 次 / %s', p_kind, p_max, p_per),
      hint = '提交太频繁，请稍后再试。';
  end if;
end
$$;

-- ---------------------------------------------------------- submit RPCs -----
create or replace function public.guestbook_submit(p_nickname text, p_body text, p_ticket text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  nick text := btrim(coalesce(p_nickname, ''));
  msg text := btrim(replace(coalesce(p_body, ''), E'\r\n', E'\n'));
  client text;
  new_id uuid;
begin
  if char_length(nick) not between 1 and 24 or nick ~ '[[:cntrl:]]' then
    raise exception '昵称需要 1–24 个字' using errcode = '22023';
  end if;
  if char_length(msg) not between 1 and 500 or msg ~ '[\x01-\x08\x0b-\x1f\x7f]' then
    raise exception '留言需要 1–500 个字' using errcode = '22023';
  end if;
  if (select count(*) from regexp_matches(msg, 'https?://', 'gi')) > 2 then
    raise exception '留言里的链接太多（最多 2 个）' using errcode = '22023';
  end if;
  client := public.az_community_ticket('guestbook', nick || E'\n' || msg, p_ticket);
  perform pg_advisory_xact_lock(hashtextextended('guestbook:' || client, 0));
  perform public.az_community_limit('guestbook', client, 3, interval '10 minutes');
  perform public.az_community_limit('guestbook', client, 10, interval '1 day');
  if (select count(*) from public.guestbook_entries where status = 'pending') >= 200 then
    raise exception 'queue_full' using errcode = 'PT429', hint = '待审核的留言太多了，请过一阵再来。';
  end if;
  insert into public.guestbook_entries (nickname, body) values (nick, msg) returning id into new_id;
  delete from private.community_submissions where created_at < now() - interval '2 days';
  return jsonb_build_object('id', new_id, 'status', 'pending');
end
$$;

create or replace function public.friend_link_submit(p_name text, p_url text, p_description text,
                                                    p_contact text, p_ticket text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  n text := btrim(coalesce(p_name, ''));
  u text := btrim(coalesce(p_url, ''));
  d text := btrim(coalesce(p_description, ''));
  c text := btrim(coalesce(p_contact, ''));
  client text;
  new_id uuid;
begin
  if char_length(n) not between 1 and 40 or n ~ '[[:cntrl:]]' then
    raise exception '站点名称需要 1–40 个字' using errcode = '22023';
  end if;
  if char_length(u) > 200 or u !~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?(/[^[:space:][:cntrl:]]*)?$' then
    raise exception '网址需要以 https:// 开头（域名用小写）' using errcode = '22023';
  end if;
  if char_length(d) > 120 or d ~ '[[:cntrl:]]' then
    raise exception '简介最多 120 个字' using errcode = '22023';
  end if;
  if char_length(c) > 120 or c ~ '[[:cntrl:]]' then
    raise exception '联系方式最多 120 个字' using errcode = '22023';
  end if;
  client := public.az_community_ticket('link', n || E'\n' || u || E'\n' || d || E'\n' || c, p_ticket);
  perform pg_advisory_xact_lock(hashtextextended('link:' || client, 0));
  perform public.az_community_limit('link', client, 2, interval '1 day');
  if exists (select 1 from public.friend_links where lower(url) = lower(u) and status in ('pending', 'approved')) then
    raise exception '这个网址已经申请过了' using errcode = '23505';
  end if;
  if (select count(*) from public.friend_links where status = 'pending') >= 50 then
    raise exception 'queue_full' using errcode = 'PT429', hint = '待审核的友链申请太多了，请过一阵再来。';
  end if;
  insert into public.friend_links (name, url, description, contact) values (n, u, d, c) returning id into new_id;
  return jsonb_build_object('id', new_id, 'status', 'pending');
end
$$;

-- ------------------------------------------------------ moderation RPCs -----
-- 留言：版主 / 管理员（与其他社区内容的审核一致）
create or replace function public.mod_guestbook_set_status(p_ids uuid[], p_status text)
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  n integer;
begin
  perform public.az_require_moderator();
  if p_status not in ('pending', 'approved', 'rejected') then
    raise exception '状态不正确' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 100 then
    raise exception '一次处理 1–100 条' using errcode = '22023';
  end if;
  update public.guestbook_entries
     set status = p_status, moderated_at = now(), moderated_by = auth.uid()
   where id = any (p_ids) and status <> p_status;
  get diagnostics n = row_count;
  perform public.az_audit('guestbook.' || p_status, 'guestbook', array_to_string(p_ids, ','),
    jsonb_build_object('count', n));
  return n;
end
$$;

create or replace function public.mod_guestbook_delete(p_ids uuid[])
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  n integer;
begin
  perform public.az_require_moderator();
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 100 then
    raise exception '一次处理 1–100 条' using errcode = '22023';
  end if;
  delete from public.guestbook_entries where id = any (p_ids);
  get diagnostics n = row_count;
  perform public.az_audit('guestbook.delete', 'guestbook', array_to_string(p_ids, ','),
    jsonb_build_object('count', n));
  return n;
end
$$;

-- 友链：仅管理员（友链是站点对外推荐，和站点设置同级）
create or replace function public.az_require_admin()
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception '仅管理员可以执行这个操作' using errcode = '42501';
  end if;
end
$$;

create or replace function public.admin_list_friend_links(p_status text default null)
 returns table (id uuid, name text, url text, description text, contact text, status text,
                created_at timestamptz, moderated_at timestamptz)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $$
begin
  perform public.az_require_admin();
  return query
    select f.id, f.name, f.url, f.description, f.contact, f.status, f.created_at, f.moderated_at
      from public.friend_links f
     where p_status is null or f.status = p_status
     order by f.created_at desc, f.id desc
     limit 500;
end
$$;

create or replace function public.admin_friend_link_set_status(p_ids uuid[], p_status text)
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  n integer;
begin
  perform public.az_require_admin();
  if p_status not in ('pending', 'approved', 'rejected') then
    raise exception '状态不正确' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 100 then
    raise exception '一次处理 1–100 条' using errcode = '22023';
  end if;
  update public.friend_links
     set status = p_status, moderated_at = now(), moderated_by = auth.uid()
   where id = any (p_ids) and status <> p_status;
  get diagnostics n = row_count;
  perform public.az_audit('friend_link.' || p_status, 'friend_link', array_to_string(p_ids, ','),
    jsonb_build_object('count', n));
  return n;
end
$$;

create or replace function public.admin_friend_link_delete(p_ids uuid[])
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  n integer;
begin
  perform public.az_require_admin();
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 100 then
    raise exception '一次处理 1–100 条' using errcode = '22023';
  end if;
  delete from public.friend_links where id = any (p_ids);
  get diagnostics n = row_count;
  perform public.az_audit('friend_link.delete', 'friend_link', array_to_string(p_ids, ','),
    jsonb_build_object('count', n));
  return n;
end
$$;

-- ------------------------------------------------------------ execute -------
revoke execute on function public.az_community_ticket(text, text, text), public.az_community_limit(text, text, integer, interval),
  public.guestbook_submit(text, text, text), public.friend_link_submit(text, text, text, text, text),
  public.mod_guestbook_set_status(uuid[], text), public.mod_guestbook_delete(uuid[]), public.az_require_admin(),
  public.admin_list_friend_links(text), public.admin_friend_link_set_status(uuid[], text),
  public.admin_friend_link_delete(uuid[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_community_ticket(text, text, text), public.az_community_limit(text, text, integer, interval), public.az_require_admin() from anon, authenticated';
    execute 'grant execute on function public.guestbook_submit(text, text, text), public.friend_link_submit(text, text, text, text, text) to anon, authenticated';
    execute 'revoke execute on function public.mod_guestbook_set_status(uuid[], text), public.mod_guestbook_delete(uuid[]), public.admin_list_friend_links(text), public.admin_friend_link_set_status(uuid[], text), public.admin_friend_link_delete(uuid[]) from anon';
    execute 'grant execute on function public.mod_guestbook_set_status(uuid[], text), public.mod_guestbook_delete(uuid[]), public.admin_list_friend_links(text), public.admin_friend_link_set_status(uuid[], text), public.admin_friend_link_delete(uuid[]) to authenticated';
  end if;
end $$;

commit;
