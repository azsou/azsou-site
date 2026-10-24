-- =============================================================================
-- db/verify/status.sql — 迁移状态核对（只读，可在 Supabase SQL 编辑器反复执行）
--
-- 每一行是一项检查：step = 对应的迁移文件，ok = 是否已生效。
-- 生产切换时每执行完一个迁移文件就跑一次：该步及之前的所有行都应为 true，之后的行为 false。
-- 全部为 true = 0002…0011 都已执行完。tests/db/verify.test.ts 在 CI 里验证本文件。
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
     exists (select 1 from pg_trigger where tgname = 'az_threads_category_guard' and not tgisinternal))
)
select step, item, ok from c order by step, item;
