/**
 * 界面端到端测试：真实 dsh + 本地假模型 + 插件的 RuntimeManager / DshConnection / ChatController，
 * 界面用 Chromium 加载构建好的 webview，`acquireVsCodeApi` 直接桥接到 ChatController。
 * 覆盖 VS Code 外壳之外的全部链路，并截图供界面验收。
 *
 * 用法（需要先 `pnpm build`，本机装有 playwright 和 Chromium）：
 *   pnpm --filter dsh-copilot run e2e -- --dsh /path/to/dsh [--node-bin <Node 24 bin>] [--out <截图目录>]
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { parseWebviewMessage, type HostToWebview } from '@dsh-copilot/shared';
import { DshConnection } from '../src/dsh/DshConnection.ts';
import { RuntimeManager } from '../src/runtime/RuntimeManager.ts';
import { ChatController } from '../src/vm/ChatController.ts';
import { createDshTestEnv } from '../test/support/dshEnv.ts';
import { loadPlaywright, type Page } from './playwright-lite.ts';
import { DARK_THEME, LIGHT_THEME } from './theme-vars.ts';

const { values: cli } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dsh: { type: 'string' },
    'node-bin': { type: 'string' },
    out: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});
if (!cli.dsh) {
  console.error('需要 --dsh <dsh 可执行文件路径>');
  process.exit(2);
}

// playwright 不是项目依赖：使用本机安装的版本（见 playwright-lite.ts）
const playwright = loadPlaywright();

const here = fileURLToPath(new URL('.', import.meta.url));
const webviewDist = resolve(here, '../dist/webview');
const outDir = resolve(cli.out ?? join(here, '../../../.e2e-screenshots'));
await mkdir(outDir, { recursive: true });

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail && !ok ? `  (${detail})` : ''}`);
}

const MARKDOWN_ANSWER = [
  '## 项目结构\n\n',
  '这个仓库有三个包：\n\n',
  '- `shared`：共用的类型\n',
  '- `extension`：插件主体\n',
  '- `webview-ui`：界面\n\n',
  '入口代码大致如下：\n\n',
  '```ts\n',
  "export function activate(context: vscode.ExtensionContext) {\n",
  "  const manager = new RuntimeManager({ log: console.log });\n",
  '  void manager.start();\n',
  '}\n',
  '```\n\n',
  '| 包 | 说明 |\n| --- | --- |\n| shared | 类型 |\n| extension | 插件 |\n\n',
  '需要我继续展开哪一部分？',
];

const env = await createDshTestEnv({
  nodeBin: cli['node-bin'],
  files: { 'README.md': '# demo\n\n一个演示项目。\n', 'src/index.ts': 'export const answer = 42;\n' },
  scripts: {
    E2E_MARKDOWN: { kind: 'text', chunks: MARKDOWN_ANSWER, delayMs: 80 },
    E2E_TOOL: {
      kind: 'tools',
      tools: [
        { name: 'read', input: { file_path: 'README.md' } },
        { name: 'grep', input: { pattern: 'answer', path: '.' } },
        { name: 'bash', input: { description: 'Run tests', command: 'echo "3 passed"' } },
      ],
      after: '看过了：README 介绍了项目，`src/index.ts` 导出了 `answer`，测试全部通过。',
    },
    E2E_SLOW: { kind: 'hold', chunks: ['正在', '仔细', '分析'] },
    default: { kind: 'text', chunks: ['你好！', '有什么可以帮你？'], delayMs: 40 },
  },
});

// ---- Host 侧：与 extension.ts 相同的组装方式 ----
let page: Page | undefined;
let pageReady = false;
const posted: HostToWebview[] = [];
const runtime = new RuntimeManager({
  getConfig: () => ({ configuredPath: cli.dsh, profile: 'web', cwd: env.workspace, env: env.env, launcherArgs: env.launcherArgs, readyTimeoutMs: 120_000 }),
  log: (line) => console.log(`  [runtime] ${line}`),
  backoffMs: () => 500,
});
const connection = new DshConnection({ log: (line) => console.log(`  [connection] ${line}`) });
let activeSessionId: string | undefined;
const controller = new ChatController({
  workspacePath: env.workspace,
  post: (message) => {
    posted.push(message);
    if (page && pageReady) void page.evaluate((m: unknown) => window.postMessage(m, '*'), message as unknown).catch(() => undefined);
  },
  log: (line) => console.log(`  [chat] ${line}`),
  loadActiveSessionId: () => activeSessionId,
  saveActiveSessionId: (id) => {
    activeSessionId = id;
  },
  openExternal: () => undefined,
  restartRuntime: () => void runtime.restart(),
  showLogs: () => undefined,
  openWebUI: () => undefined,
});
runtime.onStatus((status) => controller.setRuntimeStatus(status));
runtime.onEndpoint((endpoint) => connection.setEndpoint(endpoint));
connection.onClient((client) => controller.setClient(client));
connection.onStatus((status) => controller.setConnectionStatus(status));

// ---- 界面侧：静态服务 + 模拟 VS Code 的 Webview 环境 ----
// CSP 与 ChatViewProvider 生成的完全一致（没有 'unsafe-inline'），这样测试能发现被 CSP 拦掉的内容；
// 主题变量放在单独的 CSS 文件里，模拟脚本带 nonce。
const NONCE = 'e2e-nonce';
const harnessHtml = (theme: 'dark' | 'light', origin: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${origin}; img-src ${origin} data:; font-src ${origin}; script-src 'nonce-${NONCE}' ${origin}">
<link rel="stylesheet" href="/theme-${theme}.css">
<link rel="stylesheet" href="/index.css">
<script nonce="${NONCE}">
  let state;
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__toHost(JSON.stringify(m)),
    getState: () => state,
    setState: (s) => { state = s; },
  });
</script>
</head><body class="vscode-${theme}"><div id="root"></div><script type="module" nonce="${NONCE}" src="/index.js"></script></body></html>`;

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(harnessHtml(url.searchParams.get('theme') === 'light' ? 'light' : 'dark', `http://${request.headers.host}`));
      return;
    }
    if (url.pathname === '/theme-dark.css' || url.pathname === '/theme-light.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end(`:root{${url.pathname === '/theme-dark.css' ? DARK_THEME : LIGHT_THEME}}`);
      return;
    }
    const path = normalize(join(webviewDist, url.pathname));
    if (!path.startsWith(webviewDist)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      const type = extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  })();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await playwright.chromium.launch({ headless: !cli.headed });
const pageErrors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 380, height: 760 }, deviceScaleFactor: 2 });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.exposeFunction('__toHost', (json: never) => {
    const message = parseWebviewMessage(JSON.parse(json as string));
    if (message) void controller.handle(message);
  });
  const load = async (theme: 'dark' | 'light' = 'dark') => {
    pageReady = false;
    await page!.goto(`${base}/?theme=${theme}`);
    pageReady = true;
  };
  await load();
  // 页面准备好之前发出的 ready 已经由 exposeFunction 处理；补一次快照以防竞态
  await page.evaluate((m: unknown) => window.postMessage(m, '*'), { type: 'snapshot', payload: controller.snapshot() } as unknown);

  const shot = (name: string) => page!.screenshot({ path: join(outDir, `${name}.png`) });
  const composer = page.getByRole('textbox', { name: '消息' });
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press('Enter');
  };

  await page.locator('.banner').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  await shot('01-starting');
  await runtime.start();
  await page.waitForFunction(() => !document.querySelector('.banner'), undefined, { timeout: 60_000 });
  check('dsh 就绪后状态提示消失，显示空状态', await page.locator('.empty').isVisible());
  await shot('02-empty');

  // 1. Markdown 流式输出
  await send('E2E_MARKDOWN 介绍一下这个项目');
  await page.locator('.user__bubble', { hasText: 'E2E_MARKDOWN' }).waitFor();
  check('发送后立即显示用户消息', true);
  await page.locator('.cursor').waitFor({ timeout: 20_000 });
  check('流式输出时显示光标', true);
  await shot('03-streaming');
  await page.locator('.assistant', { hasText: '需要我继续展开' }).waitFor({ timeout: 30_000 });
  await page.locator('.cursor').waitFor({ state: 'detached', timeout: 10_000 });
  check('回复完成后光标消失', true);
  await page.locator('.shiki').first().waitFor({ timeout: 10_000 }).then(
    () => check('代码块完成语法高亮', true),
    () => check('代码块完成语法高亮', false),
  );
  // 高亮颜色真的生效了（CSP 拦掉内联样式时元素还在，但颜色会退回正文颜色）
  const colors = await page.locator('.shiki .line span').first().evaluate((el) => ({
    token: getComputedStyle(el).color,
    body: getComputedStyle(document.body).color,
  }));
  check('代码高亮颜色生效（不被 CSP 拦截）', colors.token !== colors.body, JSON.stringify(colors));
  check('表格渲染', (await page.locator('.markdown table').count()) === 1);
  check('只有一条助手回复（没有重复）', (await page.locator('.assistant').count()) === 1);
  check('用户消息没有重复', (await page.locator('.user').count()) === 1);
  await shot('04-markdown');

  // 2. 工具调用
  await send('E2E_TOOL 看看 README，再跑一下测试');
  await page.locator('.assistant', { hasText: '测试全部通过' }).waitFor({ timeout: 30_000 });
  const activities = page.locator('.activity');
  check('三次工具调用各显示为一行活动', (await activities.count()) === 3, String(await activities.count()));
  check('活动行显示相对路径和命令', (await page.locator('.activity__detail', { hasText: 'README.md' }).count()) === 1 && (await page.locator('.activity__detail', { hasText: 'echo "3 passed"' }).count()) === 1);
  await shot('05-tools');
  await page.locator('.activity__row', { hasText: 'bash' }).click();
  check('展开活动行显示命令输出', await page.locator('.activity__output', { hasText: '3 passed' }).isVisible());
  await shot('06-tool-output');

  // 3. 停止生成
  await send('E2E_SLOW 慢慢分析');
  await page.locator('.assistant', { hasText: '正在仔细分析' }).waitFor({ timeout: 20_000 });
  const stop = page.getByRole('button', { name: '停止生成' });
  check('运行中显示停止按钮', await stop.isVisible());
  await shot('07-running');
  await stop.click();
  await page.locator('.notice', { hasText: '已停止生成' }).waitFor({ timeout: 20_000 });
  check('停止后显示"已停止生成"，保留部分回复', (await page.locator('.assistant', { hasText: '正在仔细分析' }).count()) === 1);
  check('停止后恢复发送按钮', await page.getByRole('button', { name: '发送' }).isVisible());
  await shot('08-stopped');
  const firstSession = activeSessionId;

  // 4. 新对话与切换会话
  await page.getByRole('button', { name: '新对话' }).click();
  await page.locator('.empty').waitFor();
  check('新对话显示空状态', true);
  await send('你好');
  await page.locator('.assistant', { hasText: '有什么可以帮你' }).waitFor({ timeout: 20_000 });
  check('新对话第一条消息发送时才创建会话', activeSessionId !== undefined && activeSessionId !== firstSession);
  await page.locator('.header__title').click();
  await page.locator('.sessions-menu .menu-item').nth(1).waitFor({ timeout: 10_000 });
  check('会话列表里有两个会话', (await page.locator('.sessions-menu .menu-item').count()) === 2);
  await shot('09-sessions');
  await page.locator('.sessions-menu .menu-item', { hasNotText: '你好' }).first().click();
  await page.locator('.assistant', { hasText: '需要我继续展开' }).waitFor({ timeout: 20_000 });
  check('切换回第一个会话，历史完整恢复', activeSessionId === firstSession && (await page.locator('.activity').count()) === 3);

  // 5. Webview 重新加载：Host 是状态的唯一来源
  await load();
  await page.locator('.assistant', { hasText: '需要我继续展开' }).waitFor({ timeout: 10_000 });
  check('Webview 重新加载后对话内容不丢', true);

  // 6. dsh 进程被杀掉后自动恢复
  const pid = runtime.pid;
  if (pid) process.kill(-pid, 'SIGKILL');
  await page.locator('.banner', { hasText: '意外退出' }).waitFor({ timeout: 15_000 }).then(
    () => check('dsh 被杀掉后显示正在重启', true),
    () => check('dsh 被杀掉后显示正在重启', false),
  );
  check('重启期间继续显示原来的对话内容', await page.locator('.assistant', { hasText: '需要我继续展开' }).isVisible());
  await shot('10-crashed');
  await page.waitForFunction(() => !document.querySelector('.banner'), undefined, { timeout: 90_000 });
  check('dsh 自动重启并重新连接', runtime.pid !== undefined && runtime.pid !== pid);
  await page.locator('.assistant', { hasText: '需要我继续展开' }).waitFor({ timeout: 20_000 });
  check('重启后当前会话的历史仍在', true);
  await send('重启之后还能继续吗');
  await page.locator('.assistant', { hasText: '有什么可以帮你' }).waitFor({ timeout: 30_000 });
  check('重启后可以继续对话', true);
  await shot('11-recovered');

  // 7. 浅色主题
  await load('light');
  await page.locator('.assistant', { hasText: '需要我继续展开' }).waitFor({ timeout: 10_000 });
  await page.locator('.thread').evaluate((el) => (el.scrollTop = 0));
  await page.locator('.shiki').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await shot('12-light');

  check('页面没有脚本错误', pageErrors.length === 0, pageErrors.join(' | '));
  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  check('没有违反 CSP 的内容', violations.length === 0, violations.join(' | '));
} catch (error) {
  check('未预期的错误', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close();
  server.close();
  controller.dispose();
  connection.dispose();
  await runtime.stop();
  await env.cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图：${outDir}`);
process.exit(failed.length === 0 ? 0 : 1);
