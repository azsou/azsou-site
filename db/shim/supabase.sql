-- =============================================================================
-- db/shim/supabase.sql — Supabase 项目上用这个（不创建任何东西，只检查前提）。
-- Supabase 自带 anon / authenticated / service_role、auth.users、auth.uid()，
-- 所以迁移在 Supabase 上不需要额外准备；本文件只是在缺东西时尽早报错。
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'Supabase 角色 anon/authenticated 不存在：这不是 Supabase 库，请改用 db/shim/plain.sql';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null then
    raise exception 'auth.uid() / auth.users 不存在：请改用 db/shim/plain.sql';
  end if;
end $$;
