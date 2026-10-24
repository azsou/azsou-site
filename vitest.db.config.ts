import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 数据库 RLS / 迁移测试：需要 DATABASE_URL 指向一个超级用户连接（CI 用 postgres 服务容器）。 */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // 每个文件建自己的临时库，可以并行
    fileParallelism: true,
    // 集群级角色在所有文件开始前一次建好（并行建库时避免竞争）
    globalSetup: ['tests/db/global-setup.ts'],
  },
});
