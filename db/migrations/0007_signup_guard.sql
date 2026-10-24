-- =============================================================================
-- 0007_signup_guard.sql — 注册防机器人：Supabase Auth「Before User Created」钩子（可选，默认不生效）
--
-- 背景：Turnstile 在本站 /api/auth/signup 服务端校验，但 publishable key 是公开的，
-- 机器人可以绕过本站直接调用 GoTrue /auth/v1/signup。启用本钩子后，邮箱注册必须带着
-- 本站服务端签发的 signup_ticket（HMAC，15 分钟有效），否则拒绝创建用户。
-- 第三方登录（GitHub / Google）不受影响。
--
-- 启用步骤（v2 上线切换时再做；V72 的注册不带票据，提前启用会让 V72 无法注册）：
--   1. 生成随机密钥（例如 openssl rand -hex 32），在 Vercel 设置环境变量 SIGNUP_TICKET_SECRET；
--   2. 在 SQL 编辑器执行：
--        insert into private.app_settings (key, value) values ('signup_ticket_secret', '<同一个密钥>')
--        on conflict (key) do update set value = excluded.value, updated_at = now();
--   3. Dashboard → Authentication → Hooks → Before User Created → Postgres function
--      → public.az_hook_before_user_created。
-- 未写入密钥时钩子直接放行（即使在 Dashboard 里启用了也不会拦截任何人）。
-- =============================================================================

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon, authenticated';
  end if;
end $$;

create table if not exists private.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.app_settings from public;

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

revoke execute on function public.az_hook_before_user_created(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.az_hook_before_user_created(jsonb) from anon, authenticated';
  end if;
  -- Supabase Auth 以 supabase_auth_admin 身份调用钩子
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.az_hook_before_user_created(jsonb) to supabase_auth_admin';
  end if;
end $$;

commit;
