-- =============================================================================
-- 0014_video_comments.sql — 视频栏目（T6.7）：评论可挂在 /videos/<slug>/ 页面上
--
--  * comments.page_key 增加 'video:<slug>'（原有 article / game / work / project / tool 不变，V72 照常读写）。
--  * 视频页没有评分与下载，不涉及 0012 的表。
--  * 纯增量，可重复执行：只替换一条 check 约束；已有数据全部满足新约束。
--    执行前先检查：如果库里已经有不符合新约束的 page_key（理论上不可能，0013 的约束更严），
--    就跳过替换并给出提示，而不是让整个迁移失败。
-- =============================================================================

begin;

do $$
declare
  bad int;
begin
  if to_regclass('public.comments') is null then
    raise notice '0014: public.comments 不存在，跳过';
    return;
  end if;
  select count(*) into bad from public.comments
   where page_key !~ '^(article|game|work|project|tool|video):[a-z0-9-]{1,60}$';
  if bad > 0 then
    raise warning '0014: 有 % 条评论的 page_key 不符合新约束，未替换约束（请先人工检查这些行）', bad;
    return;
  end if;
  alter table public.comments drop constraint if exists comments_page_key_check;
  alter table public.comments add constraint comments_page_key_check
    check (page_key ~ '^(article|game|work|project|tool|video):[a-z0-9-]{1,60}$');
end $$;

commit;
