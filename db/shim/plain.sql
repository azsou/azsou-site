-- =============================================================================
-- db/shim/plain.sql — 在「任意标准 Postgres」上模拟迁移所依赖的那一小部分 Supabase 环境。
--
-- 迁移文件（db/migrations/*.sql）只依赖下面这些东西：
--   * 角色 anon / authenticated / service_role（PostgREST 用的三个数据库角色）
--   * auth.users（只用到 id / email / raw_user_meta_data / raw_app_meta_data）
--   * auth.uid()（当前请求的用户 id）
-- Supabase 上这些已经存在 → 用 db/shim/supabase.sql（只做存在性检查）。
-- 其他 Postgres（本地测试、Neon、RDS、自建）→ 先跑本文件。
--
-- auth.uid() 的实现与 Supabase 完全相同：读取会话设置 request.jwt.claims 里的 sub。
-- 换成别的后端时，由 API 层在每个事务开头执行：
--   select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
--   set local role authenticated;
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- Supabase 的默认权限：public 里新建的表/函数/序列自动授权给三个 API 角色。
-- 生产库就是这样配置的，这里照搬，迁移才会在同样「宽松」的起点上被测试。
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
