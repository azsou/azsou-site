-- =============================================================================
-- 0006_rls.sql — 行级安全策略重写
--
--  * auth.uid() / is_admin() 等一律包成 (select …)：Postgres 只算一次（initPlan），
--    而不是每行算一次（Supabase 性能顾问 auth_rls_initplan 的建议）。
--  * 读策略给 anon, authenticated；写策略只给 authenticated。
--  * 版主（moderator）= 论坛与评论的管理权；管理员（admin）另有站点内容、审计日志、
--    「公告」分类与用户角色。
--  * 被封禁用户：可以读、可以删除自己的内容，不能发布或编辑（can_write()）。
-- =============================================================================

begin;

-- 删除旧策略（V72 时代）与本文件的策略（可重复执行）
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('profiles', 'site_content', 'forum_threads',
             'forum_replies', 'comments', 'forum_seed_threads', 'likes', 'bookmarks', 'reports',
             'notifications', 'audit_log', 'rate_limit_events')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ------------------------------------------------------------- profiles -----
create policy profiles_read on public.profiles for select to anon, authenticated
  using (true);
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and (select public.can_write()));

-- --------------------------------------------------------- site_content -----
create policy content_read on public.site_content for select to anon, authenticated
  using (published or (select public.is_admin()));
create policy content_admin_insert on public.site_content for insert to authenticated
  with check ((select public.is_admin()));
create policy content_admin_update on public.site_content for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy content_admin_delete on public.site_content for delete to authenticated
  using ((select public.is_admin()));

-- -------------------------------------------------------- forum_threads -----
create policy threads_read on public.forum_threads for select to anon, authenticated
  using (published or author = (select auth.uid()) or (select public.is_moderator()));
create policy threads_insert on public.forum_threads for insert to authenticated
  with check (author = (select auth.uid()) and (select public.can_write())
              and (cat <> '公告' or (select public.is_admin())));
create policy threads_update on public.forum_threads for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check ((author = (select auth.uid()) and (select public.can_write())) or (select public.is_moderator()));
create policy threads_delete on public.forum_threads for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

-- ------------------------------------------------------- forum_replies ------
create policy replies_read on public.forum_replies for select to anon, authenticated
  using (published or author = (select auth.uid()) or (select public.is_moderator()));
create policy replies_insert on public.forum_replies for insert to authenticated
  with check (author = (select auth.uid()) and (select public.can_write()));
create policy replies_update on public.forum_replies for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check ((author = (select auth.uid()) and (select public.can_write())) or (select public.is_moderator()));
create policy replies_delete on public.forum_replies for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

-- ------------------------------------------------------------ comments ------
create policy comments_read on public.comments for select to anon, authenticated
  using (published or author = (select auth.uid()) or (select public.is_moderator()));
create policy comments_insert on public.comments for insert to authenticated
  with check (author = (select auth.uid()) and (select public.can_write()));
create policy comments_update on public.comments for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check ((author = (select auth.uid()) and (select public.can_write())) or (select public.is_moderator()));
create policy comments_delete on public.comments for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

-- --------------------------------------------------- forum_seed_threads -----
create policy seed_read on public.forum_seed_threads for select to anon, authenticated
  using (true);
create policy seed_mod_update on public.forum_seed_threads for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));

-- --------------------------------------------------------------- likes ------
create policy likes_read on public.likes for select to anon, authenticated
  using (true);
create policy likes_insert on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.can_write()));
create policy likes_delete on public.likes for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------- bookmarks ------
create policy bookmarks_read_own on public.bookmarks for select to authenticated
  using (user_id = (select auth.uid()));
create policy bookmarks_insert on public.bookmarks for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy bookmarks_delete on public.bookmarks for delete to authenticated
  using (user_id = (select auth.uid()));

-- ------------------------------------------------------------- reports ------
create policy reports_read on public.reports for select to authenticated
  using (reporter = (select auth.uid()) or (select public.is_moderator()));
create policy reports_insert on public.reports for insert to authenticated
  with check (reporter = (select auth.uid()) and (select public.can_write()));
create policy reports_mod_update on public.reports for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));

-- ------------------------------------------------------- notifications ------
create policy notifications_read_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_delete_own on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------- audit_log ------
create policy audit_admin_read on public.audit_log for select to authenticated
  using ((select public.is_admin()));

-- rate_limit_events：启用 RLS 且没有任何策略 = API 角色完全不可见

commit;
