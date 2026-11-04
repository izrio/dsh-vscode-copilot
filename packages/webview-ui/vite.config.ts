import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 产物固定为 index.js / index.css，由 ChatViewProvider 生成的 HTML 直接引用。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        assetFileNames: 'index[extname]',
      },
    },
  },
});
