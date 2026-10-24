-- =============================================================================
-- 0003_social_tables.sql — 点赞、收藏、举报、通知、审计日志、限流计数
--
-- 设计要点：
--  * 新表一律「先收回 Supabase 默认授予 anon/authenticated 的全部权限」，
--    精确授权在 0005，行级策略在 0006；中途停在这里也不会暴露任何数据。
--  * likes / bookmarks 用自增主键 + 唯一索引，而不是 (user_id, target) 复合主键：
--    这样 PostgREST 不会把它们识别成 forum_threads ↔ profiles 的多对多中间表，
--    V72 的 forum_threads?select=…,profiles(display_name) 嵌入不会出现歧义（PGRST201）。
--  * forum_threads / forum_replies / comments 上不新增任何指向 profiles 的外键，同理。
-- =============================================================================

begin;

-- ---------------------------------------------------------------- likes -----
create table if not exists public.likes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  created_at timestamptz not null default now(),
  constraint likes_target_type_check check (target_type in ('thread', 'reply', 'comment'))
);
create unique index if not exists likes_user_target_key on public.likes (user_id, target_type, target_id);
create index if not exists likes_target_idx on public.likes (target_type, target_id);

-- ------------------------------------------------------------ bookmarks -----
create table if not exists public.bookmarks (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  thread_key text not null,
  created_at timestamptz not null default now(),
  constraint bookmarks_thread_key_check check (
    thread_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or thread_key ~ '^t-[a-z0-9-]{1,58}$')
);
create unique index if not exists bookmarks_user_thread_key on public.bookmarks (user_id, thread_key);

-- -------------------------------------------------------------- reports -----
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid default auth.uid() references public.profiles(id) on delete set null,
  target_type text not null,
  target_id text not null,
  reason text not null,
  detail text not null default '',
  status text not null default 'open',
  resolution_note text not null default '',
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reports_target_type_check check (target_type in ('thread', 'reply', 'comment', 'profile')),
  constraint reports_target_id_check check (char_length(target_id) between 1 and 60),
  constraint reports_reason_check check (reason in ('spam', 'abuse', 'illegal', 'privacy', 'other')),
  constraint reports_detail_check check (char_length(detail) <= 500),
  constraint reports_status_check check (status in ('open', 'resolved', 'dismissed')),
  constraint reports_resolution_note_check check (char_length(resolution_note) <= 500)
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);
create index if not exists reports_reporter_idx on public.reports (reporter);
create index if not exists reports_resolved_by_idx on public.reports (resolved_by);
-- 同一人对同一目标只能有一条未处理举报
create unique index if not exists reports_open_once on public.reports (reporter, target_type, target_id) where status = 'open';

-- -------------------------------------------------------- notifications -----
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor uuid references public.profiles(id) on delete set null,
  kind text not null,
  thread_key text,
  target_type text,
  target_id text,
  excerpt text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind_check check (kind in ('reply', 'mention', 'like', 'report', 'moderation', 'system')),
  constraint notifications_excerpt_check check (char_length(excerpt) <= 200)
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index if not exists notifications_actor_idx on public.notifications (actor);

-- ------------------------------------------------------------ audit_log -----
-- actor 不设外键：用户被删除后审计记录仍需保留
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  actor_role text,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_target_idx on public.audit_log (target_type, target_id);

-- ------------------------------------------------------ rate limit events ---
create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_lookup_idx on public.rate_limit_events (user_id, action, created_at desc);

-- ------------------------------------- lock down until 0005 / 0006 run -----
revoke all on public.likes, public.bookmarks, public.reports, public.notifications,
  public.audit_log, public.rate_limit_events from anon, authenticated;
alter table public.likes enable row level security;
alter table public.bookmarks enable row level security;
alter table public.reports enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limit_events enable row level security;

commit;
