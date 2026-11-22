-- =============================================================================
-- 0005_privileges.sql — 收紧表 / 列 / 函数权限
--
-- 原则：
--  * anon（未登录）只读公开表，不能写任何东西；
--  * authenticated 的 INSERT / UPDATE 只开放到「列」：id / author 变更 / created_at /
--    updated_at / edited_at 永远不能由客户端写入；role / banned 只能经 admin_set_user()；
--  * 谁能改哪一行由 RLS（0006）决定，版主专属列由 0004 的触发器把关；
--  * 回收 TRUNCATE / TRIGGER / REFERENCES（TRUNCATE 会绕过 RLS）；
--  * 读取保持表级 SELECT：V72 用 select=* 读取 profiles / site_content，列级 SELECT 会让它报错。
-- V72 用到的写入（全部仍然可用）：
--   comments POST {page_key, body, author}      forum_threads POST {cat, title, body, author}
--   forum_replies POST {thread_id, body, author} profiles PATCH {display_name}
--   site_content upsert {kind, slug, data, published} / PATCH {published}
--   forum_threads PATCH {published | pinned}     comments PATCH {published}
--   DELETE 自己的主题 / 回复 / 评论；rpc/admin_set_user
-- =============================================================================

begin;

-- ---------------------------------------------------------- start clean -----
revoke all on public.profiles, public.site_content, public.forum_threads, public.forum_replies,
  public.comments, public.forum_seed_threads, public.likes, public.bookmarks, public.reports,
  public.notifications, public.audit_log, public.rate_limit_events
  from anon, authenticated;

-- -------------------------------------------------------- public reads ------
grant select on public.profiles, public.site_content, public.forum_threads, public.forum_replies,
  public.comments, public.forum_seed_threads, public.likes
  to anon, authenticated;

-- ------------------------------------------------- authenticated writes -----
grant update (display_name) on public.profiles to authenticated;

grant insert (kind, slug, data, published), update (kind, slug, data, published), delete
  on public.site_content to authenticated;

grant insert (cat, title, body, author, pinned, published, locked, featured),
      update (cat, title, body, pinned, published, locked, featured), delete
  on public.forum_threads to authenticated;

grant insert (thread_id, thread, seed_key, body, author, published),
      update (body, published), delete
  on public.forum_replies to authenticated;

grant insert (page_key, body, author, published), update (body, published), delete
  on public.comments to authenticated;

grant update (locked, title) on public.forum_seed_threads to authenticated;

grant insert (user_id, target_type, target_id), delete on public.likes to authenticated;

grant select, insert (user_id, thread_key), delete on public.bookmarks to authenticated;

grant select, insert (reporter, target_type, target_id, reason, detail),
      update (status, resolution_note)
  on public.reports to authenticated;

grant select, update (read_at), delete on public.notifications to authenticated;

grant select on public.audit_log to authenticated;
-- rate_limit_events：不对 API 角色开放任何权限

-- 自增序列：API 角色不需要直接访问
revoke all on sequence public.likes_id_seq, public.bookmarks_id_seq, public.notifications_id_seq,
  public.audit_log_id_seq, public.rate_limit_events_id_seq from anon, authenticated;

-- ------------------------------------------------------------ functions -----
revoke execute on function
  public.is_admin(), public.can_write(), public.is_moderator(), public.current_app_role(),
  public.admin_set_user(uuid, text, boolean), public.handle_new_user(),
  public.az_is_api_request(), public.az_rate_limit(text, integer, interval),
  public.az_audit(text, text, text, jsonb), public.az_forbid(text),
  public.az_profiles_guard(), public.az_threads_guard(), public.az_replies_guard(),
  public.az_comments_guard(), public.az_touch_updated_at(), public.az_likes_guard(),
  public.az_bookmarks_guard(), public.az_reports_guard(), public.az_reports_after(),
  public.az_notifications_guard(), public.az_notify_reply(), public.az_audit_moderation(),
  public.az_audit_content(),
  public.like_summary(text, uuid[]), public.unread_notification_count(),
  public.mark_notifications_read(bigint[])
  from public, anon, authenticated;

-- 策略里用到的判定函数：调用者需要 EXECUTE
grant execute on function public.is_admin(), public.can_write(), public.is_moderator(),
  public.current_app_role() to anon, authenticated;
grant execute on function public.like_summary(text, uuid[]) to anon, authenticated;
grant execute on function public.admin_set_user(uuid, text, boolean),
  public.unread_notification_count(), public.mark_notifications_read(bigint[]) to authenticated;

commit;
