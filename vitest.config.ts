/// <reference types="vitest" />
import { getViteConfig } from 'astro/config';

// 单元测试显式指向本机栈（scripts/supabase-env.mjs 没有默认值：不配就报错）。必须在 getViteConfig 加载 astro.config.mjs 之前设置。
// 这是公开的本地占位值，不是任何真实项目；测试里需要别的配置时用 vi.stubEnv 或直接传 env 对象。
process.env.PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.PUBLIC_SUPABASE_KEY = 'sb_publishable_local-e2e-not-a-secret';
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

export default getViteConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
