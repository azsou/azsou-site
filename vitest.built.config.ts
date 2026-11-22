/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// 构建产物测试（JSON-LD 结构化数据等）：在 npm run build 之后运行
export default defineConfig({
  test: {
    include: ['tests/built/**/*.test.ts'],
    environment: 'node',
  },
});
