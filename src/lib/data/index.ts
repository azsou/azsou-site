import { createMemoryRepository } from './memory';
import { createSupabaseRepository } from './supabase';
import type { DataRepository } from './types';

export * from './types';
export { createMemoryRepository, createSupabaseRepository };

export const DEFAULT_SUPABASE = {
  url: 'https://abryflgoljltyakthtql.supabase.co',
  // publishable key：设计上就是公开的，权限由数据库 RLS 决定
  key: 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh',
};

let cached: DataRepository | null = null;

/** 根据构建时环境变量选择适配器。浏览器端 island 调这个。 */
export function getRepository(): DataRepository {
  if (cached) return cached;
  const env = import.meta.env ?? {};
  const adapter = env.PUBLIC_DATA_ADAPTER || 'supabase';
  cached =
    adapter === 'memory'
      ? createMemoryRepository()
      : createSupabaseRepository({
          url: env.PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE.url,
          key: env.PUBLIC_SUPABASE_KEY || DEFAULT_SUPABASE.key,
        });
  return cached;
}
