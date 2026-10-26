-- =============================================================================
-- db/verify/status.sql — 迁移状态核对（只读，可在 Supabase SQL 编辑器反复执行）
--
-- 每一行是一项检查：step = 对应的迁移文件，ok = 是否已生效。
-- 生产切换时每执行完一个迁移文件就跑一次：该步及之前的所有行都应为 true，之后的行为 false。
-- 全部为 true = 0002…0017 都已执行完。tests/db/verify.test.ts 在 CI 里验证本文件。
-- =============================================================================
with c(step, item, ok) as (
  values
  ('0002', 'profiles.role 允许 moderator',
     exists (select 1 from pg_constraint where conname = 'profiles_role_check'
             and pg_get_constraintdef(oid) like '%moderator%')),
  ('0002', 'forum_threads 有 locked / featured / edited_at 列',
     (select count(*) = 3 from information_schema.columns where table_schema = 'public'
        and table_name = 'forum_threads' and column_name in ('locked', 'featured', 'edited_at'))),
  ('0002', 'forum_seed_threads 表存在', to_regclass('public.forum_seed_threads') is not null),
  ('0003', '点赞 / 收藏 / 举报 / 通知 / 审计 / 限流表存在',
     (select count(*) = 6 from pg_tables where schemaname = 'public'
        and tablename in ('likes', 'bookmarks', 'reports', 'notifications', 'audit_log', 'rate_limit_events'))),
  ('0004', '限流与守卫函数存在',
     to_regprocedure('public.az_rate_limit(text,integer,interval)') is not null
     and to_regprocedure('public.az_threads_guard()') is not null),
  ('0004', '主题守卫触发器存在',
     exists (select 1 from pg_trigger where tgname = 'az_threads_guard' and not tgisinternal)),
  ('0005', 'anon 不能写 forum_threads',
     not has_table_privilege('anon', 'public.forum_threads', 'INSERT')),
  ('0005', 'authenticated 不能 TRUNCATE',
     not has_table_privilege('authenticated', 'public.forum_threads', 'TRUNCATE')),
  ('0006', '社交表的行级策略已建立（likes / reports / audit_log）',
     (select count(*) = 3 from pg_policies where schemaname = 'public'
        and policyname in ('likes_insert', 'reports_mod_update', 'audit_admin_read'))),
  ('0006', 'forum_threads 写策略只给 authenticated（V72 旧策略已替换）',
     exists (select 1 from pg_policies where schemaname = 'public' and policyname = 'threads_insert'
             and roles = '{authenticated}')),
  ('0007', '注册钩子函数与 private.app_settings 存在',
     to_regprocedure('public.az_hook_before_user_created(jsonb)') is not null
     and to_regclass('private.app_settings') is not null),
  ('0008', 'pg_trgm 与 search_threads 存在',
     exists (select 1 from pg_extension where extname = 'pg_trgm')
     and to_regprocedure('public.search_threads(text,integer,integer)') is not null),
  ('0009', 'user_bans 表与版主 RPC 存在',
     to_regclass('public.user_bans') is not null
     and to_regprocedure('public.mod_handle_reports(uuid[],text,text,text,integer)') is not null),
  ('0009', '注册钩子读取「注册开关」',
     coalesce(pg_get_functiondef(to_regprocedure('public.az_hook_before_user_created(jsonb)')) like '%registration%', false)),
  ('0010', '图片上传校验函数存在',
     to_regprocedure('public.az_ugc_image_upload_ok(text,jsonb)') is not null),
  ('0010', 'ugc-images 桶（公开读、2 MB）与 3 条存储策略',
     case when to_regclass('storage.buckets') is null then true  -- 没有 Storage 的库：这一项视为通过
          else (select count(*) = 3 from pg_policies where schemaname = 'storage' and policyname like 'az_ugc_images_%')
               and (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from storage.buckets where id = ''ugc-images'' and public and file_size_limit = 2097152',
                     false, true, '')))[1]::text = '1'
     end),
  ('0011', '停用分类触发器存在',
     exists (select 1 from pg_trigger where tgname = 'az_threads_category_guard' and not tgisinternal)),
  ('0012', '评价表（RLS 已开启）与评分统计视图存在',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.app_reviews')), false)
     and to_regclass('public.app_review_stats') is not null),
  ('0012', '下载计数表与计数 RPC 存在，举报可指向评价',
     to_regclass('public.app_download_counts') is not null
     and to_regprocedure('public.app_count_download(text,text)') is not null
     and exists (select 1 from pg_constraint where conname = 'reports_target_type_check'
                 and pg_get_constraintdef(oid) like '%review%')),
  ('0013', '评论可以挂在 AI 工具页（page_key 允许 tool:）',
     exists (select 1 from pg_constraint where conname = 'comments_page_key_check'
             and pg_get_constraintdef(oid) like '%tool%')),
  ('0014', '评论可以挂在视频页（page_key 允许 video:）',
     exists (select 1 from pg_constraint where conname = 'comments_page_key_check'
             and pg_get_constraintdef(oid) like '%video%')),
  ('0015', '留言板与友链表（RLS 已开启）与提交 RPC 存在',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.guestbook_entries')), false)
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.friend_links')), false)
     and to_regprocedure('public.guestbook_submit(text,text,text)') is not null
     and to_regprocedure('public.friend_link_submit(text,text,text,text,text)') is not null),
  ('0015', '提交记录表存在（限流 / 票据一次性；另需写入 community_ticket_secret，见 0015 文件头）',
     to_regclass('private.community_submissions') is not null),
  ('0016', '订阅表（RLS 已开启，无公开读写）与确认 / 退订 / 计数 RPC 存在',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.subscribers')), false)
     and to_regprocedure('public.subscribe_request(text,text,text,text,text)') is not null
     and to_regprocedure('public.subscribe_confirm(text)') is not null
     and to_regprocedure('public.subscribe_unsubscribe(text)') is not null
     and to_regprocedure('public.admin_subscriber_counts()') is not null),
  ('0017', '后台 CRM：备注 / 用户标签 / 内容流程 / 版本表（RLS 已开启）与排序参数、画像、流程 RPC 存在',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.admin_notes')), false)
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.admin_user_tags')), false)
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.content_workflow')), false)
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.content_versions')), false)
     and to_regprocedure('public.mod_list_content(text,text,text,boolean,boolean,uuid,integer,integer,text,text)') is not null
     and to_regprocedure('public.mod_list_users(text,text,boolean,integer,integer,uuid,text,text)') is not null
     and to_regprocedure('public.mod_user_profile(uuid)') is not null
     and to_regprocedure('public.mod_set_workflow(text,uuid[],text,timestamptz)') is not null)
)
select step, item, ok from c order by step, item;
