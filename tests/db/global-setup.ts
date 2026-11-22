/**
 * 数据库测试的全局准备：在任何测试文件开始前，一次性建好集群级的角色
 * （anon / authenticated / service_role / authenticator）。
 * 角色是整个 Postgres 集群共享的；测试文件并行建库时各自「先查再建」会互相撞车（全新的 CI 容器上偶发失败），
 * 也会出现某个文件先 grant 而角色还没被别的文件建出来的情况。
 */
import pg from 'pg';
import { ADMIN_URL } from './helpers';

export default async function setup() {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(`do $$
    declare r record;
    begin
      for r in select * from (values
        ('anon', 'create role anon nologin noinherit'),
        ('authenticated', 'create role authenticated nologin noinherit'),
        ('service_role', 'create role service_role nologin noinherit bypassrls'),
        ('authenticator', 'create role authenticator login noinherit password ''authenticator''')
      ) as t(name, ddl) loop
        if not exists (select 1 from pg_roles where rolname = r.name) then
          begin
            execute r.ddl;
          exception when duplicate_object or unique_violation then
            null;
          end;
        end if;
      end loop;
    end $$;`);
    await c.query(`grant anon, authenticated, service_role to authenticator`);
  } finally {
    await c.end();
  }
}
