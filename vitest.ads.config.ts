/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

// 广告开启变体的产物检查（P8 T8.3）：先 npm run build:ads（假客户端 ID 构建到 dist-ads/）
export default defineConfig({
  test: {
    include: ['tests/built-ads/**/*.test.ts'],
    environment: 'node',
  },
});
