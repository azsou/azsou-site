-- =============================================================================
-- 0011_forum_category_guard.sql — 数据库层拦截「已停用」的论坛分类（P5）
--
--  * 后台「站点设置 → 论坛分类」把某个分类设为停用后，普通用户不能再在该分类发新主题，
--    也不能把已有主题移进去（P4 只在发帖页隐藏，旧客户端 / 直连 API 仍可发，这里补上）。
--  * 设置存放在 site_content（kind='setting'，slug='forum'，published），格式：
--      {"categories":[{"id":"tech","enabled":false,"order":2}, …]}
--    forum_threads.cat 存的是中文分类名（V72 兼容），这里把 id 映射到名称；
--    同时接受直接用 id 作为 cat 的写法。
--  * 没有这条设置、设置未发布、格式不对、或分类不在设置里 → 一律放行（与 V72 行为相同）。
--  * 版主 / 管理员不受限制（需要时可在停用分类里发说明帖）；已在停用分类里的主题照常可编辑、回复。
--  * 只在 API 请求（anon / authenticated）时生效；SQL 编辑器 / 迁移 / 导入不受影响。
--  * 纯增量；可重复执行。
-- =============================================================================

begin;

create or replace function public.az_forum_category_disabled(p_cat text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $$
  with s as (
    select data->'categories' as cats
    from public.site_content
    where kind = 'setting' and slug = 'forum' and published
    order by updated_at desc nulls last
    limit 1
  ), want as (
    select case p_cat
             when '公告' then 'announce'
             when '产品讨论' then 'product'
             when '技术交流' then 'tech'
             when '站务反馈' then 'meta'
             else p_cat
           end as id
  )
  select coalesce((
    select true
    from s, want, jsonb_array_elements(case when jsonb_typeof(s.cats) = 'array' then s.cats else '[]'::jsonb end) c
    where c->>'id' = want.id
      and jsonb_typeof(c->'enabled') = 'boolean'
      and (c->>'enabled')::boolean = false
    limit 1), false)
$$;

create or replace function public.az_threads_category_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.az_is_api_request() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.cat is not distinct from old.cat then
    return new;
  end if;
  if public.is_moderator() then
    return new;
  end if;
  if public.az_forum_category_disabled(new.cat) then
    perform public.az_forbid(format('「%s」分类已停用，暂时不能发新主题或把主题移入该分类', new.cat));
  end if;
  return new;
end
$$;

-- 触发器按名字顺序执行：az_threads_category_guard 先于 az_threads_guard（被拦下的请求不计入限流）
drop trigger if exists az_threads_category_guard on public.forum_threads;
create trigger az_threads_category_guard before insert or update of cat on public.forum_threads
  for each row execute function public.az_threads_category_guard();

revoke execute on function public.az_threads_category_guard() from public, anon, authenticated;
revoke execute on function public.az_forum_category_disabled(text) from public, anon, authenticated;

commit;
