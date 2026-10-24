-- =============================================================================
-- 0002_roles_columns.sql — 角色、状态列、回复与主题的真实外键（全部向后兼容 V72）
--
--  * profiles.role 增加 moderator（user | moderator | admin）
--  * forum_threads：locked / featured / edited_at / updated_at；author 默认 auth.uid()
--  * forum_replies：新增 thread uuid（真外键 → forum_threads，级联删除）与
--    seed_key（→ forum_seed_threads，静态种子主题）；V72 仍只写 thread_id 文本，
--    由 0004 的触发器自动推导 thread / seed_key。
--  * comments：edited_at / updated_at
--  * 外键索引（作者、主题）与分类列表索引
-- 可重复执行（if not exists / on conflict do nothing）。
-- =============================================================================

begin;

-- ---------------------------------------------------------------- roles -----
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['user'::text, 'moderator'::text, 'admin'::text]));
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- -------------------------------------------------------------- threads -----
do $$
declare fresh boolean := not exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'forum_threads' and column_name = 'updated_at');
begin
  alter table public.forum_threads
    add column if not exists locked boolean not null default false,
    add column if not exists featured boolean not null default false,
    add column if not exists edited_at timestamptz,
    add column if not exists updated_at timestamptz not null default now();
  if fresh then
    update public.forum_threads set updated_at = created_at;
  end if;
end $$;
alter table public.forum_threads alter column author set default auth.uid();

-- --------------------------------------------------------- seed threads -----
-- 站点预置（静态）主题。V72 / v2 的种子主题 id 形如 t-announce；回复它们时
-- forum_replies.seed_key 指向这里，于是种子主题也能被锁定。
create table if not exists public.forum_seed_threads (
  key text primary key,
  title text not null default '',
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  constraint forum_seed_threads_key_check check (key ~ '^t-[a-z0-9-]{1,58}$'),
  constraint forum_seed_threads_title_check check (char_length(title) <= 120)
);
revoke all on public.forum_seed_threads from anon, authenticated;
alter table public.forum_seed_threads enable row level security;

insert into public.forum_seed_threads (key, title) values
  ('t-announce', '论坛使用说明与版规'),
  ('t-v63-changelog', 'V63 更新日志：论坛上线、拼音首字母搜索与键盘导航'),
  ('t-fm-timeline', 'FableMotion S3 时间轴：你的工作流还缺什么？'),
  ('t-svg-assets', '生成式 SVG 素材系统：40 个槽位的做法与局限'),
  ('t-regression', '单文件站点的回归验收方法交流'),
  ('t-mv3-ux', 'MV3 动态域名授权弹窗，怎么做才不打断用户？'),
  ('t-feedback', '站点问题与建议收集帖')
on conflict (key) do nothing;
-- 已有回复引用、但不在上面清单里的 t-… 种子 id 也补进来，保证旧数据可以挂上外键
insert into public.forum_seed_threads (key)
  select distinct thread_id from public.forum_replies
  where thread_id ~ '^t-[a-z0-9-]{1,58}$'
on conflict (key) do nothing;

-- -------------------------------------------------------------- replies -----
alter table public.forum_replies
  add column if not exists thread uuid,
  add column if not exists seed_key text,
  add column if not exists edited_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.forum_replies alter column author set default auth.uid();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'forum_replies_thread_fkey') then
    alter table public.forum_replies add constraint forum_replies_thread_fkey
      foreign key (thread) references public.forum_threads(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'forum_replies_seed_key_fkey') then
    alter table public.forum_replies add constraint forum_replies_seed_key_fkey
      foreign key (seed_key) references public.forum_seed_threads(key) on update cascade on delete cascade;
  end if;
end $$;

-- 回填：uuid 形状且主题存在 → thread；t-… → seed_key
update public.forum_replies r set thread = t.id, updated_at = r.created_at
  from public.forum_threads t
  where r.thread is null and r.seed_key is null
    and r.thread_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and t.id = r.thread_id::uuid;
update public.forum_replies set seed_key = thread_id, updated_at = created_at
  where thread is null and seed_key is null and thread_id ~ '^t-[a-z0-9-]{1,58}$';

-- 每条回复必须挂在「数据库主题」或「种子主题」之一上。
-- V72 删主题时不会删回复（以前没有外键），可能留下孤儿：先以 NOT VALID 加约束
-- （新行立即生效），再尝试校验旧行；有孤儿时只给出提示，不删除任何数据。
do $$
declare orphans int;
begin
  if not exists (select 1 from pg_constraint where conname = 'forum_replies_target_check') then
    alter table public.forum_replies add constraint forum_replies_target_check
      check (num_nonnulls(thread, seed_key) = 1) not valid;
  end if;
  select count(*) into orphans from public.forum_replies where num_nonnulls(thread, seed_key) <> 1;
  if orphans = 0 then
    alter table public.forum_replies validate constraint forum_replies_target_check;
  else
    raise notice '% 条回复找不到所属主题（孤儿），forum_replies_target_check 暂保持 NOT VALID；清理后执行 VALIDATE CONSTRAINT。', orphans;
  end if;
end $$;

-- ------------------------------------------------------------- comments -----
alter table public.comments
  add column if not exists edited_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.comments alter column author set default auth.uid();

-- -------------------------------------------------------------- indexes -----
create index if not exists forum_replies_thread_fk_idx on public.forum_replies (thread, created_at) where thread is not null;
create index if not exists forum_replies_seed_key_idx on public.forum_replies (seed_key, created_at) where seed_key is not null;
create index if not exists forum_replies_author_idx on public.forum_replies (author);
create index if not exists forum_threads_author_idx on public.forum_threads (author);
create index if not exists forum_threads_cat_idx on public.forum_threads (cat, published, created_at desc);
create index if not exists comments_author_idx on public.comments (author);

commit;
