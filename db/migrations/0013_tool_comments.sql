-- =============================================================================
-- 0013_tool_comments.sql — AI 工具栏目（T6.6）：评论可挂在 /ai/<slug>/ 页面上
--
--  * comments.page_key 增加 'tool:<slug>'（原有 article / game / work / project 不变，V72 照常读写）。
--  * 评分评价（app_reviews）与下载计数（app_count_download）在 0012 里只校验 slug 格式，
--    不校验 slug 属于哪个集合，所以 AI 工具直接复用，不需要改动（应用与工具的 slug 由构建期测试保证不重名）。
--  * 纯增量，可重复执行：只替换一条 check 约束；已有数据全部满足新约束。
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.comments') is null then
    raise notice '0013: public.comments 不存在，跳过';
    return;
  end if;
  alter table public.comments drop constraint if exists comments_page_key_check;
  alter table public.comments add constraint comments_page_key_check
    check (page_key ~ '^(article|game|work|project|tool):[a-z0-9-]{1,60}$');
end $$;

commit;
