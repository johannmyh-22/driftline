import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/visual 归 Playwright 管,vitest 只跑纯逻辑单测。
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
