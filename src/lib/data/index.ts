import { createMemoryRepository } from './memory';
import { createSupabaseRepository } from './supabase';
import type { DataRepository } from './types';

export * from './types';
export { createMemoryRepository, createSupabaseRepository };
export { createSupabaseAuth } from './supabase-auth';
export { localStore, memoryStore, SESSION_KEY } from './session';

export const DEFAULT_SUPABASE = {
  url: 'https://abryflgoljltyakthtql.supabase.co',
  // publishable key：设计上就是公开的，权限由数据库 RLS 决定
  key: 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh',
};

/** 站内 Vercel Function：Turnstile 服务端校验后再转发注册 / 找回密码请求（src/pages/api/auth/[action].ts） */
export const GUARDED_AUTH_ENDPOINT = '/api/auth';

let cached: DataRepository | null = null;

/** 根据构建时环境变量选择适配器。浏览器端 island 调这个。 */
export function getRepository(): DataRepository {
  if (cached) return cached;
  const env = import.meta.env ?? {};
  const adapter = env.PUBLIC_DATA_ADAPTER || 'supabase';
  cached =
    adapter === 'memory'
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
