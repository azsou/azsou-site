import { createMemoryRepository } from './memory';
import { createSupabaseRepository } from './supabase';
import type { DataRepository } from './types';
import { DEFAULT_SUPABASE } from '../supabase-config';

export * from './types';
// 后台接口只导出类型：实现（createAdminApi、迁移编号表、错误分类）在 admin-repo.ts，只有后台页面的包里带它。
// 公开页面共用的数据层 chunk 因此不含后台代码（/apps/ 等页面的 JS 预算 49,152 B，tests/built/js-budget.test.ts 与 tests/e2e/js-budget.spec.ts）。
export type * from './admin';
export { createMemoryRepository, createSupabaseRepository };
export { createSupabaseAuth } from './supabase-auth';
export { localStore, memoryStore, SESSION_KEY } from './session';

export { DEFAULT_SUPABASE } from '../supabase-config';

/** 站内 Vercel Function：Turnstile 服务端校验后再转发注册 / 找回密码请求（src/pages/api/auth/[action].ts） */
export const GUARDED_AUTH_ENDPOINT = '/api/auth';

let cached: DataRepository | null = null;

/** 根据构建时环境变量选择适配器。浏览器端 island 调这个。 */
export function getRepository(): DataRepository {
  if (cached) return cached;
  const env = import.meta.env ?? {};
  // 直接比较 import.meta.env.PUBLIC_DATA_ADAPTER：Vite 构建期替换成字面量，生产包里不含内存适配器
  cached =
    import.meta.env.PUBLIC_DATA_ADAPTER === 'memory'
      ? createMemoryRepository({ seedThreads: {}, requireConfirmation: false })
      : createSupabaseRepository({
          url: env.PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE.url,
          key: env.PUBLIC_SUPABASE_KEY || DEFAULT_SUPABASE.key,
          guardedEndpoint: GUARDED_AUTH_ENDPOINT,
        });
  return cached;
}

/** 测试用：重置缓存 */
export function resetRepositoryForTests() {
  cached = null;
}
