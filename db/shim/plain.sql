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

-- 角色是整个集群共享的：多个库并行执行本文件（测试并行建库）时，「先查再建」会撞上并发，
-- 所以每个 create role 单独捕获「已存在」。
do $$
declare
  r record;
begin
  for r in select * from (values
    ('anon', 'create role anon nologin noinherit'),
    ('authenticated', 'create role authenticated nologin noinherit'),
    ('service_role', 'create role service_role nologin noinherit bypassrls')
  ) as t(name, ddl) loop
    if not exists (select 1 from pg_roles where rolname = r.name) then
      begin
        execute r.ddl;
      exception when duplicate_object or unique_violation then
        null; -- 另一个会话刚建好
      end;
    end if;
  end loop;
end $$;

create schema if not exists auth;
-- Supabase 把扩展装在 extensions schema（pgcrypto 在 0007 的注册钩子里用到 hmac()）
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
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

-- -----------------------------------------------------------------------------
-- Supabase Storage 的最小替身（0010 图片上传用）：只有 RLS 需要的那部分结构。
-- 真正的 Storage 服务（storage-api）在 Supabase 上：上传时它以 authenticated 角色
-- （事务内 set local role + request.jwt.claims）往 storage.objects 插一行，RLS 决定能不能传；
-- 桶的 file_size_limit / allowed_mime_types 由 storage-api 在收文件时校验。
-- 换到没有 Storage 的后端时，图片可改放任意 S3 兼容存储（见 docs/PORTABILITY.md），这里的表只供测试。
-- 已存在（例如 Supabase 库误跑本文件）时什么都不做。
-- -----------------------------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  constraint objects_bucket_name_key unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end $$;
create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare _parts text[]; _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end $$;
