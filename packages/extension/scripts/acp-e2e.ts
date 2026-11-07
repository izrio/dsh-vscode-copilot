/**
 * ACP 底层的界面端到端测试：真实的 oh-my-pi（`omp acp`）+ 本地假模型 + Chromium 里的真实 Webview。
 *
 *   pnpm --filter harness-deck acp-e2e -- --omp <omp 的 cli.js 或可执行文件> [--bun <bun>] [--out <截图目录>]
 *
 * 覆盖：启动和 initialize、草稿会话带来的模型和模式、流式回复、工具行（写文件、命令）、审批、会话列表、
 * 重新打开会话（session/load 回放）、切换模式、停止生成。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseWebviewMessage, type HostToWebview } from '@dsh-copilot/shared';
import { AcpController, type AcpInitialize, type StoredSession } from '../src/acp/AcpController.ts';
import { AcpConnection } from '../src/acp/connection.ts';
import { setLocale } from '../src/i18n.ts';
import { noWorkbench, type Workbench } from '../src/vm/workbench.ts';
import { startMockModel } from '../test/mock-model/server.ts';
import { loadPlaywright, type Page } from './playwright-lite.ts';
import { DARK_THEME, VSCODE_DEFAULT_STYLES } from './theme-vars.ts';

const { values: cli } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { omp: { type: 'string' }, bun: { type: 'string' }, out: { type: 'string' }, headed: { type: 'boolean', default: false } },
});
if (!cli.omp) {
  console.error('需要 --omp <omp 可执行文件，或 @oh-my-pi/pi-coding-agent 的 dist/cli.js（配合 --bun）>');
  process.exit(2);
}
setLocale('zh');
const playwright = loadPlaywright();
const here = fileURLToPath(new URL('.', import.meta.url));
const webviewDist = resolve(here, '../dist/webview');
const outDir = resolve(cli.out ?? join(here, '../../../.e2e-screenshots/acp'));
await mkdir(outDir, { recursive: true });

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail && !ok ? `  (${detail})` : ''}`);
}

// ---- 假模型和 omp 的配置：自定义提供方指向假模型 ----
const model = await startMockModel({
  HELLO: { kind: 'text', chunks: ['你好，', '我是 omp。'], delayMs: 60 },
  WORK: {
    kind: 'tools',
    tools: [
      { name: 'write', input: { path: 'notes.md', content: '# 笔记\n\n第一条\n' } },
      { name: 'bash', input: { command: 'echo hi && ls' } },
    ],
    after: '写好了笔记，也看过目录了。',
  },
  SLOW: { kind: 'hold', chunks: ['正在', '慢慢', '想'] },
  default: { kind: 'text', chunks: ['好的。'] },
} as never);
const home = await mkdtemp(join(tmpdir(), 'acp-e2e-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'acp-e2e-ws-'));
await writeFile(join(workspace, 'README.md'), '# demo\n');
await mkdir(join(home, '.omp', 'agent'), { recursive: true });
await writeFile(
  join(home, '.omp', 'agent', 'models.yml'),
  `providers:\n  mock:\n    baseUrl: ${model.url}\n    api: anthropic-messages\n    apiKey: dummy\n    models:\n      - id: mock-model\n        name: Mock Model\n      - id: mock-big\n        name: Mock Big\n`,
);
const command = cli.bun ?? cli.omp;
const args = cli.bun ? [cli.omp, 'acp', '--model', 'mock/mock-model'] : ['acp', '--model', 'mock/mock-model'];

// ---- 控制器和代理进程 ----
let page: Page | undefined;
let stored: StoredSession[] = [];
let activeSessionId: string | undefined;
const workbench: Workbench = { ...noWorkbench, readFile: (path) => readFile(path, 'utf8').catch(() => undefined) };
const controller = new AcpController({
  workspacePath: workspace,
  workbench,
  post: (message: HostToWebview) => {
    if (page) void page.evaluate((m: unknown) => window.postMessage(m, '*'), message as unknown).catch(() => undefined);
  },
  log: (line) => console.log(`  [acp] ${line}`),
  openExternal: () => undefined,
  showLogs: () => undefined,
  restartRuntime: () => undefined,
  backends: () => ({ items: [{ id: 'dsh', name: 'dsh', kind: 'dsh' }, { id: 'oh-my-pi', name: 'oh-my-pi', kind: 'acp' }], active: 'oh-my-pi' }),
  loadActiveSessionId: () => activeSessionId,
  saveActiveSessionId: (id) => void (activeSessionId = id),
  loadSessions: () => stored,
  saveSessions: (list) => void (stored = [...list]),
});
const connection = new AcpConnection({
  command,
  args,
  cwd: workspace,
  env: { ...process.env, HOME: home },
  log: (line) => console.log(`  [conn] ${line}`),
  onStderr: (line) => console.log(`  [omp] ${line}`),
  onNotification: (method, params) => method === 'session/update' && controller.onSessionUpdate(params),
  onRequest: (method, params) => controller.onAgentRequest(method, params),
  onExit: (code) => console.log(`  [omp] exited ${code}`),
});

// ---- 页面 ----
const NONCE = 'e2e-nonce';
const html = (origin: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${origin}; img-src ${origin} data:; font-src ${origin}; script-src 'nonce-${NONCE}' ${origin}">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/index.css">
<script nonce="${NONCE}">let state; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(JSON.stringify(m)), getState: () => state, setState: (s) => { state = s; } });</script>
</head><body class="vscode-dark"><div id="root"></div><script type="module" nonce="${NONCE}" src="/index.js"></script></body></html>`;
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/') return void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(`http://${request.headers.host}`));
    if (url.pathname === '/theme.css') return void response.writeHead(200, { 'content-type': 'text/css' }).end(`:root{${DARK_THEME}}${VSCODE_DEFAULT_STYLES}`);
    const path = normalize(join(webviewDist, url.pathname));
    if (!path.startsWith(webviewDist)) return void response.writeHead(403).end();
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  })();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await playwright.chromium.launch({ headless: !cli.headed });
const errors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 380, height: 760 }, deviceScaleFactor: 2 });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.exposeFunction('__toHost', (json: never) => {
    const message = parseWebviewMessage(JSON.parse(json as string));
    if (message) void controller.handle(message);
  });
  await page.goto(base);
  const shot = (name: string) => page!.screenshot({ path: join(outDir, `${name}.png`) });
  const composer = page.getByRole('textbox', { name: '消息' });
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press('Enter');
  };

  // 1. 启动 omp，initialize
  controller.setRuntimeStatus({ kind: 'starting' });
  await connection.start();
  const init = await connection.request<AcpInitialize>('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'harness-deck', version: 'e2e' },
  });
  check('omp 启动，initialize 返回代理信息', init.agentInfo?.name === 'omp', JSON.stringify(init.agentInfo));
  controller.setRuntimeStatus({ kind: 'connected', version: init.agentInfo?.version ?? '', newerThanTested: false });
  controller.setLink(connection, init);

  // 2. 草稿会话：发消息前模型和模式就能用
  await page.getByTestId('model-picker').locator('.toolbar-button__text', { hasText: 'Mock Model' }).waitFor({ timeout: 30_000 }).then(
    () => check('新对话里模型选择显示 omp 的当前模型', true),
    async () => check('新对话里模型选择显示 omp 的当前模型', false, await page!.getByTestId('model-picker').innerText()),
  );
  check('权限选择显示 omp 的模式（Default）', ((await page.getByTestId('permission-picker').getAttribute('title')) ?? '').includes('Default'));
  await shot('01-empty');

  // 3. 流式回复
  await send('HELLO 打个招呼');
  await page.locator('.assistant', { hasText: '我是 omp' }).waitFor({ timeout: 30_000 }).then(
    () => check('流式回复显示在对话里', true),
    () => check('流式回复显示在对话里', false),
  );
  check('用户消息显示', (await page.locator('.user', { hasText: 'HELLO 打个招呼' }).count()) === 1);

  // 4. 工具：写文件（无需审批）、命令（需要审批）
  await send('WORK 写个笔记再看看目录');
  const approval = page.getByTestId('approval-card');
  await approval.waitFor({ timeout: 30_000 }).then(
    () => check('命令需要审批时显示审批卡片', true),
    () => check('命令需要审批时显示审批卡片', false),
  );
  check('审批卡片显示要运行的命令', (await approval.innerText()).includes('echo hi && ls'), await approval.innerText().catch(() => ''));
  await shot('02-approval');
  await approval.getByRole('button', { name: /允许本次/u }).click();
  await page.locator('.assistant', { hasText: '写好了笔记' }).waitFor({ timeout: 30_000 });
  const edit = page.locator('.activity--edit', { hasText: 'notes.md' });
  check('写文件显示成修改行和增加的行数', (await edit.count()) === 1 && (await edit.innerText()).includes('+3'), await edit.innerText().catch(() => ''));
  const commandRow = page.locator('.activity--command', { hasText: 'echo hi' });
  check('命令显示成「已运行」行', (await commandRow.count()) === 1 && (await commandRow.innerText()).includes('已运行'), await commandRow.innerText().catch(() => ''));
  await commandRow.locator('.activity__row').click();
  check('点开命令看到输出', (await commandRow.innerText()).includes('notes.md'), await commandRow.innerText());
  check('笔记真的写到了工作区', (await readFile(join(workspace, 'notes.md'), 'utf8').catch(() => '')).includes('第一条'));
  await shot('03-tools');

  // 5. 会话列表、新对话、重新打开会话（session/load 回放）
  await page.locator('.header__title').click();
  const sessionItem = page.locator('.sessions-menu .menu-item', { hasText: 'HELLO 打个招呼' });
  await sessionItem.waitFor({ timeout: 10_000 }).then(
    () => check('会话列表里有这个会话（标题取第一条消息）', true),
    async () => check('会话列表里有这个会话（标题取第一条消息）', false, await page!.locator('.sessions-menu').innerText().catch(() => '')),
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新对话' }).click();
  await page.locator('.empty').waitFor({ timeout: 10_000 }).then(
    () => check('新对话显示空状态', true),
    () => check('新对话显示空状态', false),
  );
  await page.locator('.header__title').click();
  await page.locator('.sessions-menu .menu-item', { hasText: 'HELLO 打个招呼' }).click();
  await page.locator('.user', { hasText: 'HELLO 打个招呼' }).waitFor({ timeout: 30_000 }).then(
    () => check('重新打开会话：历史从 omp 回放', true),
    () => check('重新打开会话：历史从 omp 回放', false),
  );
  check('回放的历史里有工具行', (await page.locator('.activity--command', { hasText: 'echo hi' }).count()) === 1);

  // 6. 模式：切到 Plan，显示计划模式标记
  await page.getByTestId('permission-picker').click();
  await page.getByRole('menuitem', { name: /Plan/u }).click();
  await page.getByTestId('plan-badge').waitFor({ timeout: 10_000 }).then(
    () => check('切换到 omp 的 Plan 模式后显示计划模式标记', true),
    () => check('切换到 omp 的 Plan 模式后显示计划模式标记', false),
  );
  await page.getByTestId('plan-badge').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="plan-badge"]'), undefined, { timeout: 10_000 }).then(
    () => check('点击标记退出计划模式', true),
    () => check('点击标记退出计划模式', false),
  );

  // 7. 停止生成
  await send('SLOW 慢慢想');
  await page.locator('.assistant', { hasText: '正在慢慢想' }).waitFor({ timeout: 30_000 });
  check('运行中显示运行状态', (await page.getByTestId('run-status').count()) === 1);
  await page.getByRole('button', { name: '停止生成' }).click();
  await page.locator('.notice', { hasText: '已停止生成' }).waitFor({ timeout: 30_000 }).then(
    () => check('停止后显示「已停止生成」', true),
    () => check('停止后显示「已停止生成」', false),
  );
  await shot('04-stopped');
  check('页面没有脚本错误', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await connection.dispose();
  server.close();
  await model.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图：${outDir}`);
process.exit(failed.length ? 1 : 0);
