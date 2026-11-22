-- =============================================================================
-- db/restore/post-restore.sql — 「整库恢复」（pg_restore 完整的 public 备份到新库）之后执行；
-- 由 scripts/db-restore.sh 调用，执行完它会再单独恢复一遍备份里的授权（ACL）。
--
-- 1. pg_dump --schema=public 不包含建在其他 schema 的表上的对象：auth.users 上的注册触发器
--    on_auth_user_created（新用户自动建 profiles）在这里补回。
-- 2. Supabase（以及 db/shim/plain.sql）设置了「默认权限」：public 里新建的表 / 函数 / 序列自动
--    GRANT ALL 给 anon / authenticated / service_role。pg_restore 建表时这些授权会被自动加上，
--    而备份里的 ACL 只记录「相对内置默认值」的差异，不会把它们撤掉 → 恢复出来的库权限比原库宽。
--    这里先把三个 API 角色在 public 上的权限全部撤掉，随后 db-restore.sh 只恢复备份里的 ACL 条目，
--    结果与原库逐条一致（restore-drill.sh 会核对）。
-- 可重复执行。用 db/migrations 重建结构再导数据（换库方式）时不需要本文件。
-- =============================================================================
do $$
begin
  if to_regclass('auth.users') is not null and to_regprocedure('public.handle_new_user()') is not null then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert on auth.users
             for each row execute function public.handle_new_user()';
  end if;
end $$;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
