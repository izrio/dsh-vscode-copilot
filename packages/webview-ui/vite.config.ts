import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 入口固定为 index.js / index.css，由 ChatViewProvider 生成的 HTML 直接引用；
// 代码高亮的语言包按需加载，输出到 chunks/。base 用相对路径，让动态 import 相对 index.js 解析。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    // 不注入 modulepreload 的 <link>（CSP 下也用不上）
    modulePreload: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'index[extname]',
      },
    },
  },
});
