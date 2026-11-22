-- =============================================================================
-- 0008_forum_search.sql — 论坛搜索（pg_trgm）与回复计数 RPC（P3）
--
--  * pg_trgm 是 Postgres 自带的 contrib 扩展（Supabase / Neon / RDS / 自建都有），装在
--    extensions schema（与 Supabase 约定一致）。三元组 GIN 索引让 ILIKE '%关键词%' 走索引；
--    中文按字切分：生产库 ctype 为 en_US.UTF-8，汉字算「字母」，会生成三元组。
--    1–2 个字的查询用不上三元组（退化为顺序扫描），论坛体量下可以接受。
--  * search_threads()：SECURITY INVOKER —— 结果仍受 forum_threads / profiles 的 RLS 约束；
--    另外显式只返回已发布主题（版主也不会在搜索里看到隐藏帖）。
--  * thread_reply_counts()：一次取多条主题（数据库 uuid 或种子 t-…）的已发布回复数，
--    代替列表页拉取全部回复行。
--  * 纯增量：不改任何表、列、策略；V72 不受影响。可重复执行。
-- =============================================================================

begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
-- Supabase 默认已授予；其他 Postgres 上补上（search_threads 是 INVOKER，要能调用 word_similarity）
grant usage on schema extensions to anon, authenticated;

create index if not exists forum_threads_title_trgm_idx
  on public.forum_threads using gin (title extensions.gin_trgm_ops);
create index if not exists forum_threads_body_trgm_idx
  on public.forum_threads using gin (body extensions.gin_trgm_ops);
-- 个人主页 / 列表分页：作者 + 时间倒序
create index if not exists forum_threads_author_created_idx
  on public.forum_threads (author, created_at desc);
create index if not exists forum_threads_published_created_idx
  on public.forum_threads (published, created_at desc, id desc);

-- ------------------------------------------------------------ search -------
create or replace function public.search_threads(q text, p_limit integer default 20, p_offset integer default 0)
 returns table (
   id uuid,
   cat text,
   title text,
   excerpt text,
   author uuid,
   author_name text,
   created_at timestamptz,
   score real
 )
 language sql
 stable
 set search_path to 'public', 'extensions'
as $$
  with input as (
    select btrim(coalesce(q, '')) as term
  ), pat as (
    select term,
           '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as like_pat
    from input
    where char_length(term) between 1 and 100
  )
  select t.id, t.cat, t.title,
         case when strpos(lower(t.body), lower(p.term)) > 0
              then substr(regexp_replace(t.body, '\s+', ' ', 'g'),
                          greatest(1, strpos(lower(regexp_replace(t.body, '\s+', ' ', 'g')), lower(p.term)) - 40), 160)
              else left(regexp_replace(t.body, '\s+', ' ', 'g'), 160) end as excerpt,
         t.author,
         pr.display_name as author_name,
         t.created_at,
         (case when t.title ilike p.like_pat then 1 else 0 end
           + extensions.word_similarity(p.term, t.title))::real as score
  from pat p
  join public.forum_threads t
    on t.published and (t.title ilike p.like_pat or t.body ilike p.like_pat)
  left join public.profiles pr on pr.id = t.author
  order by score desc, t.created_at desc, t.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset least(greatest(coalesce(p_offset, 0), 0), 1000)
$$;

-- ------------------------------------------------------ reply counts -------
create or replace function public.thread_reply_counts(p_keys text[])
 returns table (thread_id text, replies bigint)
 language sql
 stable
 set search_path to 'public'
as $$
  select r.thread_id, count(*)::bigint
  from public.forum_replies r
  where r.published
    and r.thread_id = any (p_keys[1:200])
  group by r.thread_id
$$;

revoke execute on function public.search_threads(text, integer, integer),
  public.thread_reply_counts(text[]) from public, anon, authenticated;
grant execute on function public.search_threads(text, integer, integer),
  public.thread_reply_counts(text[]) to anon, authenticated;

commit;
