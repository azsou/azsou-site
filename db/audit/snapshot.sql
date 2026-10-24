-- 结构快照：用于对比「生产库」与「本地跑完 0001_baseline.sql 的库」是否一致。
-- 只读；生产上通过 Supabase SQL 编辑器 / Management API 执行，本地由 tests/db/baseline.test.ts 执行。
with t(name) as (values ('profiles'),('site_content'),('forum_threads'),('forum_replies'),('comments'))
select json_build_object(
  'columns', (select json_agg(json_build_object('t',table_name,'c',column_name,'type',data_type,'null',is_nullable,'def',column_default) order by table_name, column_name)
              from information_schema.columns where table_schema='public' and table_name in (select name from t)),
  'constraints', (select json_agg(json_build_object('t',conrelid::regclass::text,'n',conname,'def',pg_get_constraintdef(oid),'valid',convalidated) order by conrelid::regclass::text, conname)
              from pg_constraint where connamespace='public'::regnamespace and conrelid::regclass::text in (select name from t)),
  'indexes', (select json_agg(json_build_object('n',indexname,'def',indexdef) order by indexname)
              from pg_indexes where schemaname='public' and tablename in (select name from t)),
  'policies', (select json_agg(json_build_object('t',tablename,'n',policyname,'cmd',cmd,'perm',permissive,'roles',roles::text,'qual',qual,'check',with_check) order by tablename, policyname)
              from pg_policies where schemaname='public' and tablename in (select name from t)),
  'functions', (select json_agg(json_build_object('n',p.proname,'args',pg_get_function_arguments(p.oid),'ret',pg_get_function_result(p.oid),'secdef',p.prosecdef,'vol',p.provolatile,'cfg',p.proconfig::text,
                 'src',btrim(replace(p.prosrc, chr(13), ''), E' \n'),'acl',(select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a)) order by p.proname)
              from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('handle_new_user','is_admin','can_write','admin_set_user')),
  'table_grants', (select json_agg(json_build_object('g',grantee,'t',table_name,'p',privs) order by grantee, table_name) from (
                 select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) privs
                 from information_schema.role_table_grants where table_schema='public' and table_name in (select name from t)
                   and grantee in ('anon','authenticated','service_role') group by 1,2) g),
  'column_grants', (select json_agg(json_build_object('g',grantee,'t',table_name,'p',privilege_type,'cols',cols) order by grantee, table_name, privilege_type) from (
                 select grantee, table_name, privilege_type, string_agg(column_name, ',' order by column_name) cols
                 from information_schema.column_privileges where table_schema='public' and table_name in (select name from t)
                   and grantee in ('anon','authenticated','service_role') group by 1,2,3) c),
  'rls', (select json_agg(json_build_object('t',relname,'rls',relrowsecurity,'force',relforcerowsecurity) order by relname)
              from pg_class where relnamespace='public'::regnamespace and relname in (select name from t)),
  'triggers', (select json_agg(json_build_object('n',tgname,'rel',tgrelid::regclass::text,'def',pg_get_triggerdef(oid)) order by tgname)
              from pg_trigger where not tgisinternal and (tgrelid::regclass::text in (select name from t) or (tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created')))
) as snapshot;
