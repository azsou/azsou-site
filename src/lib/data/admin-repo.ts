/**
 * 后台接口入口（只在后台页面的包里）。
 *
 * 以前 `createSupabaseRepository()` 直接把 `createAdminApi()` 挂在仓储对象的 `admin` 上，
 * 于是后台实现（几十个 RPC 封装、排序降级、迁移编号表……）进了所有公开页面共用的数据层 chunk——
 * 批次 1 / 2 的后台改动合并后，/apps/ 页面加载期间的 JS 涨到 49,229 B，超过 49,152 B 预算。
 * 现在仓储只暴露一条原始 REST 通道（`adminRest`），后台接口在这里按需创建；
 * 公开页面不 import 本文件，打包器就不会把后台代码放进它们的 chunk（tests/built/js-budget.test.ts 逐页检查）。
 */
import { createAdminApi, type AdminRepo, type AdminRest } from './admin';
import { migrationOf } from './schema-map';
import { SchemaMissingError, type DataRepository } from './types';

/** 数据层抛出的 SchemaMissingError 不带迁移编号（编号表不进公开包）；后台在这里补上 */
export function withMigration(e: unknown): unknown {
  if (!(e instanceof SchemaMissingError) || e.migration) return e;
  const migration = migrationOf(e.object);
  return migration ? new SchemaMissingError(e.object, e.code, migration) : e;
}

const rethrow = (e: unknown): never => {
  throw withMigration(e);
};

const cache = new WeakMap<DataRepository, AdminRepo>();

/** 当前仓储的后台接口；适配器不支持后台（内存适配器）时返回 null */
export function adminApiFor(repo: DataRepository): AdminRepo | null {
  const raw = repo.adminRest;
  if (!raw) return null;
  let api = cache.get(repo);
  if (!api) {
    const rest: AdminRest = {
      rest: <T>(path: string, init?: Parameters<AdminRest['rest']>[1]) =>
        raw.rest<T>(path, init).catch(rethrow),
      restCount: (path, init) => raw.restCount(path, init).catch(rethrow),
    };
    api = createAdminApi(rest);
    cache.set(repo, api);
  }
  return api;
}
