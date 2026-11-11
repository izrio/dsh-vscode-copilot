// ESLint：只做能发现真实问题的检查（未使用的变量、悬空的 Promise、Hooks 规则），不管排版——排版没有统一过，一刀切格式化会淹没历史。
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.vsix', '.e2e-screenshots/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.{ts,tsx}', '*.ts'],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['vitest.config.ts'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 没有 await、也没有 void 的 Promise：出错时没人知道
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // 下划线开头表示有意不用（解构时丢掉的字段、接口要求的参数）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // `a && b()`、三元表达式当语句用是这个代码库的常见写法
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // 终端颜色控制符的正则里需要控制字符
      'no-control-regex': 'off',
    },
  },
  {
    files: ['packages/webview-ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // 这里的 effect 大多有意只在某几个值变化时运行（见各处注释），依赖检查只提示不拦
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    files: ['packages/extension/**/*.ts', '*.{ts,mjs}', 'packages/*/vite.config.ts', 'packages/extension/scripts/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // 端到端脚本里有传给浏览器执行的回调
    files: ['packages/extension/scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
