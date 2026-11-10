import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    // Webview 组件测试在文件开头用 `// @vitest-environment jsdom` 切换环境
    environment: 'node',
    setupFiles: ['packages/webview-ui/test/setup.ts'],
    testTimeout: 15_000,
  },
});
