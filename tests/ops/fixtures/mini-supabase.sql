-- 运维测试夹具（tests/ops/backup-ops-e2e.sh）：在任意 Postgres 上建一个「最小的 Supabase 形状」——
-- API 角色、auth.users / auth.identities、storage.buckets / storage.objects（含 RLS 策略）、private 表、public 表与数据。
-- 只给运维 PR（基于 main，没有 db/migrations）测备份脚本用；不代表本站真实结构。
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      begin execute format('create role %I nologin noinherit', r); exception when duplicate_object or unique_violation then null; end;
    end if;
  end loop;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text, identity_data jsonb);
create schema storage;
create table storage.buckets (id text primary key, name text not null unique, public boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text,
  metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create policy mini_public_read on storage.objects for select using (bucket_id = 'pub');
create schema private;
create table private.app_settings (key text primary key, value text not null);
create table public.posts (id bigserial primary key, author uuid references auth.users(id), body text not null, created_at timestamptz default now());
alter table public.posts enable row level security;
create policy posts_read on public.posts for select to anon, authenticated using (true);
grant select on public.posts to anon, authenticated;

insert into auth.users (id, email) values ('00000000-0000-4000-a000-000000000001', 'ops-1@example.com'), ('00000000-0000-4000-a000-000000000002', 'ops-2@example.com');
insert into auth.identities (user_id, provider, identity_data) values ('00000000-0000-4000-a000-000000000001', 'github', '{"sub":"1"}');
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('pub', 'pub', true, 2097152, '{image/png}');
insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
  ('pub', '00000000-0000-4000-a000-000000000001/a.png', '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000001', '{"size":10,"mimetype":"image/png"}');
insert into private.app_settings values ('ops_secret', 'not-a-real-secret');
insert into public.posts (author, body) values ('00000000-0000-4000-a000-000000000001', '你好'), ('00000000-0000-4000-a000-000000000002', 'hello');
