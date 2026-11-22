-- =============================================================================
-- 0001_baseline.sql — 生产库（Supabase abryflgoljltyakthtql，V72 在用）的现状，逐项还原。
--
-- !!! 生产库已经是这个状态：在生产上「不要」执行本文件。!!!
-- 用途：在全新 Postgres 上先跑 shim，再跑本文件，就得到与生产一致的起点，
--       然后 0002+ 的增量迁移在这个起点上被测试（tests/db/baseline.test.ts 会把
--       跑完本文件后的结构快照与 db/audit/prod-schema.json 逐项比对）。
-- 生产里的已知问题（宽松授权、作者可改 pinned/created_at 等）在这里「原样保留」，
-- 由 0002 之后的迁移修复，并在 tests/db 里做回归测试。
-- =============================================================================

begin;

-- ---------------------------------------------------------------- tables ----
create table public.profiles (
  id uuid not null,
  display_name text not null default '新用户'::text,
  role text not null default 'user'::text,
  banned boolean not null default false,
  created_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade,
  constraint profiles_display_name_check check (((char_length(display_name) >= 1) and (char_length(display_name) <= 40))),
  constraint profiles_role_check check ((role = any (array['user'::text, 'admin'::text])))
);

create table public.site_content (
  id uuid not null default gen_random_uuid(),
  kind text not null,
  slug text not null,
  data jsonb not null,
  published boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint site_content_pkey primary key (id),
  constraint site_content_kind_slug_key unique (kind, slug),
  constraint site_content_kind_check check ((kind = any (array['game'::text, 'app'::text, 'article'::text, 'work'::text, 'forum_category'::text, 'setting'::text]))),
  constraint site_content_slug_check check (((char_length(slug) >= 1) and (char_length(slug) <= 80)))
);
create index site_content_kind_idx on public.site_content using btree (kind, published);

create table public.forum_threads (
  id uuid not null default gen_random_uuid(),
  cat text not null,
  title text not null,
  body text not null,
  author uuid not null,
  pinned boolean not null default false,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  constraint forum_threads_pkey primary key (id),
  constraint forum_threads_author_fkey foreign key (author) references public.profiles(id) on delete cascade,
  constraint forum_threads_cat_check check (((char_length(cat) >= 1) and (char_length(cat) <= 20))),
  constraint forum_threads_title_check check (((char_length(title) >= 1) and (char_length(title) <= 120))),
  constraint forum_threads_body_check check (((char_length(body) >= 1) and (char_length(body) <= 4000)))
);
create index forum_threads_list_idx on public.forum_threads using btree (published, created_at desc);

create table public.forum_replies (
  id uuid not null default gen_random_uuid(),
  thread_id text not null,
  body text not null,
  author uuid not null,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  constraint forum_replies_pkey primary key (id),
  constraint forum_replies_author_fkey foreign key (author) references public.profiles(id) on delete cascade,
  constraint forum_replies_thread_id_check check (((char_length(thread_id) >= 1) and (char_length(thread_id) <= 60))),
  constraint forum_replies_body_check check (((char_length(body) >= 1) and (char_length(body) <= 2000)))
);
-- 生产上是 NOT VALID（加约束时没有校验旧行）
alter table public.forum_replies add constraint forum_replies_thread_id_shape
  check (((thread_id ~ '^[0-9a-fA-F-]{36}$'::text) or (thread_id ~ '^t-[a-z0-9-]{1,58}$'::text))) not valid;
create index forum_replies_thread_idx on public.forum_replies using btree (thread_id, created_at);

create table public.comments (
  id uuid not null default gen_random_uuid(),
  page_key text not null,
  body text not null,
  author uuid not null,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  constraint comments_pkey primary key (id),
  constraint comments_author_fkey foreign key (author) references public.profiles(id) on delete cascade,
  constraint comments_page_key_check check ((page_key ~ '^(article|game|work|project):[a-z0-9-]{1,60}$'::text)),
  constraint comments_body_check check (((char_length(body) >= 1) and (char_length(body) <= 600)))
);
create index comments_page_idx on public.comments using btree (page_key, created_at);

-- ------------------------------------------------------------- functions ----
create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'admin' and not banned)
$function$;

create or replace function public.can_write()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and not banned)
$function$;

create or replace function public.admin_set_user(target uuid, new_role text, new_banned boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if new_role not in ('user','admin') then raise exception 'bad role'; end if;
  update public.profiles set role = new_role, banned = new_banned where id = target;
end
$function$;

create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, display_name)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''),
                   split_part(new.email, '@', 1)));
  return new;
end
$function$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- RLS ----
alter table public.profiles enable row level security;
alter table public.site_content enable row level security;
alter table public.forum_threads enable row level security;
alter table public.forum_replies enable row level security;
alter table public.comments enable row level security;

create policy profiles_read on public.profiles for select using (true);
create policy profiles_update_own on public.profiles for update using ((id = auth.uid())) with check ((id = auth.uid()));

create policy content_read on public.site_content for select using ((published or is_admin()));
create policy content_admin_write on public.site_content for all using (is_admin()) with check (is_admin());

create policy threads_read on public.forum_threads for select using ((published or (author = auth.uid()) or is_admin()));
create policy threads_insert on public.forum_threads for insert with check (((author = auth.uid()) and can_write() and (cat <> '公告'::text)));
create policy threads_admin_insert on public.forum_threads for insert with check (is_admin());
create policy threads_update on public.forum_threads for update using (((author = auth.uid()) or is_admin())) with check ((((author = auth.uid()) and can_write()) or is_admin()));
create policy threads_delete on public.forum_threads for delete using (((author = auth.uid()) or is_admin()));

create policy replies_read on public.forum_replies for select using ((published or (author = auth.uid()) or is_admin()));
create policy replies_insert on public.forum_replies for insert with check (((author = auth.uid()) and can_write()));
create policy replies_update on public.forum_replies for update using (((author = auth.uid()) or is_admin())) with check ((((author = auth.uid()) and can_write()) or is_admin()));
create policy replies_delete on public.forum_replies for delete using (((author = auth.uid()) or is_admin()));

create policy comments_read on public.comments for select using ((published or (author = auth.uid()) or is_admin()));
create policy comments_insert on public.comments for insert with check (((author = auth.uid()) and can_write()));
create policy comments_update on public.comments for update using (((author = auth.uid()) or is_admin())) with check ((((author = auth.uid()) and can_write()) or is_admin()));
create policy comments_delete on public.comments for delete using (((author = auth.uid()) or is_admin()));

-- ---------------------------------------------------------------- grants ----
-- 生产上的授权（来自 Supabase 默认权限）：anon / authenticated 拥有全部表权限，
-- 唯一例外是 authenticated 在 profiles 上只能 UPDATE(display_name)。
grant all on public.profiles, public.site_content, public.forum_threads, public.forum_replies, public.comments
  to anon, authenticated, service_role;
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

grant execute on function public.is_admin(), public.can_write(), public.handle_new_user(),
  public.admin_set_user(uuid, text, boolean) to anon, authenticated, service_role;

commit;
