// 用 esbuild 把 Extension Host 代码打成单个 CJS 文件（VS Code 以 require 加载插件入口）。
import { context, build } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  minify: !process.argv.includes('--watch'),
  // vscode 由宿主提供；bufferutil / utf-8-validate 是 ws 的可选原生加速依赖
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
