/**
 * ACP 底层的界面端到端测试：真实的代理 + 本地假模型 + Chromium 里的真实 Webview。
 *
 *   pnpm --filter harness-deck acp-e2e -- --omp <omp 的 cli.js 或可执行文件> [--bun <bun>] [--out <截图目录>]
 *   pnpm --filter harness-deck acp-e2e -- --codebuddy <codebuddy 可执行文件> [--out <截图目录>]
 *   pnpm --filter harness-deck acp-e2e -- --claude <claude-agent-acp 可执行文件> [--out <截图目录>]
 *
 * oh-my-pi 用自定义提供方（Anthropic Messages）指向假模型；CodeBuddy 用 CODEBUDDY_API_KEY + CODEBUDDY_BASE_URL
 * （OpenAI Chat Completions），都不需要真实账号。
 *
 * 覆盖：启动和 initialize、草稿会话带来的模型和模式、流式回复、工具行（读文件、写文件、命令）、审批、待办、
 * 会话列表、重新打开会话（session/load 回放）、切换模式、停止生成。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';
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
  options: {
    omp: { type: 'string' },
    bun: { type: 'string' },
    codebuddy: { type: 'string' },
    claude: { type: 'string' },
    out: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});
if (!cli.omp && !cli.codebuddy && !cli.claude) {
  console.error('需要 --omp <omp 可执行文件，或 @oh-my-pi/pi-coding-agent 的 dist/cli.js（配合 --bun）>、--codebuddy <codebuddy 可执行文件>，或 --claude <claude-agent-acp 可执行文件>');
  process.exit(2);
}
const agent: 'omp' | 'codebuddy' | 'claude' = cli.claude ? 'claude' : cli.codebuddy ? 'codebuddy' : 'omp';
setLocale('zh');
const playwright = loadPlaywright();
const here = fileURLToPath(new URL('.', import.meta.url));
const webviewDist = resolve(here, '../dist/webview');
const outDir = resolve(cli.out ?? join(here, `../../../.e2e-screenshots/acp-${agent}`));
await mkdir(outDir, { recursive: true });

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail && !ok ? `  (${detail})` : ''}`);
}

// ---- 假模型和代理的配置 ----
const home = await mkdtemp(join(tmpdir(), 'acp-e2e-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'acp-e2e-ws-'));
await writeFile(join(workspace, 'README.md'), '# demo\n');
/** Claude Code 会自动放行 echo、ls 这类只读命令：用一个要写入的命令，审批才会出现。 */
const bashCommand = agent === 'claude' ? 'mkdir -p out && ls' : 'echo hi && ls';
/** 代理的工具名和参数不同：omp 是 `write { path }`，CodeBuddy 和 Claude 是 `Write { file_path }`（绝对路径）。 */
const tools =
  agent === 'omp'
    ? { read: { name: 'read', input: { path: 'README.md' } }, write: { name: 'write', input: { path: 'notes.md', content: '# 笔记\n\n第一条\n' } }, bash: { name: 'bash', input: { command: bashCommand } } }
    : {
        read: { name: 'Read', input: { file_path: join(workspace, 'README.md') } },
        write: { name: 'Write', input: { file_path: join(workspace, 'notes.md'), content: '# 笔记\n\n第一条\n' } },
        bash: { name: 'Bash', input: { command: bashCommand, description: 'List files' } },
      };
const model = await startMockModel({
  HELLO: { kind: 'text', chunks: ['你好，', `我是 ${agent}。`], delayMs: 60 },
  WORK: { kind: 'tools', tools: [tools.read, tools.write, tools.bash], after: '写好了笔记，也看过目录了。' },
  // CodeBuddy 的待办是 TaskCreate / TaskUpdate，Claude 是 TodoWrite（发成 plan 更新）
  TODO:
    agent === 'claude'
      ? {
          kind: 'tool',
          tool: { name: 'TodoWrite', input: { todos: [ { content: '读代码', status: 'completed', activeForm: '正在读代码' }, { content: '改代码', status: 'in_progress', activeForm: '正在改代码' } ] } },
          after: '列好计划了。',
        }
      : {
          kind: 'tools',
          tools: [
            { name: 'TaskCreate', input: { subject: '读代码', description: '先读', activeForm: '正在读代码' } },
            { name: 'TaskCreate', input: { subject: '改代码', description: '再改' } },
            { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
            { name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
          ],
          after: '列好计划了。',
        },
  SLOW: { kind: 'hold', chunks: ['正在', '慢慢', '想'] },
  default: { kind: 'text', chunks: ['好的。'] },
} as never);
let command: string;
let args: string[];
let agentEnv: Record<string, string> = {};
/** 新对话里模型选择应该显示的名字、默认模式的名字。 */
let modelLabel: string;
let defaultModeLabel: string;
if (agent === 'omp') {
  await mkdir(join(home, '.omp', 'agent'), { recursive: true });
  await writeFile(
    join(home, '.omp', 'agent', 'models.yml'),
    `providers:\n  mock:\n    baseUrl: ${model.url}\n    api: anthropic-messages\n    apiKey: dummy\n    models:\n      - id: mock-model\n        name: Mock Model\n      - id: mock-big\n        name: Mock Big\n`,
  );
  command = cli.bun ?? cli.omp!;
  args = cli.bun ? [cli.omp!, 'acp', '--model', 'mock/mock-model'] : ['acp', '--model', 'mock/mock-model'];
  modelLabel = 'Mock Model';
  defaultModeLabel = 'Default';
} else if (agent === 'codebuddy') {
  command = cli.codebuddy!;
  args = ['--acp', '--model', 'mock-model'];
  agentEnv = { CODEBUDDY_API_KEY: 'dummy', CODEBUDDY_BASE_URL: `${model.url}/v1` };
  modelLabel = 'mock-model';
  defaultModeLabel = 'Always Ask';
} else {
  command = cli.claude!;
  args = [];
  // Claude Agent SDK 的模型请求走 ANTHROPIC_BASE_URL（Anthropic Messages，假模型直接支持）
  agentEnv = { ANTHROPIC_API_KEY: 'sk-ant-e2e', ANTHROPIC_BASE_URL: model.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  modelLabel = 'Default (recommended)';
  defaultModeLabel = 'Auto';
}
/** 运行测试的环境自己的 Claude / Anthropic 变量不传给代理：只用上面给的假模型。 */
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => agent !== 'claude' || !/^(ANTHROPIC|CLAUDE)/u.test(key)));

// ---- 控制器和代理进程 ----
let page: Page | undefined;
const activeBackend = agent === 'omp' ? 'oh-my-pi' : agent;
let backendChosen = false;
const backendMessages: string[] = [];
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
  // 和 backend/acp.ts 一样：停掉进程再启动、initialize、setLink（单会话代理切换会话时会用到）
  restartRuntime: () => void restartAgent(),
  singleSession: agent === 'codebuddy',
  // 和 extension.ts 一样：第一次使用时 needsChoice；dsh 假装没装，用来检查安装命令的显示
  backends: () => ({
    items: [
      { id: 'dsh', name: 'dsh', kind: 'dsh', available: false, installCommand: 'npm install -g @deepseek-ai/dsh' },
      { id: 'oh-my-pi', name: 'oh-my-pi', kind: 'acp', command: 'omp acp', available: agent === 'omp' },
      { id: 'codebuddy', name: 'CodeBuddy', kind: 'acp', command: 'codebuddy --acp', available: agent === 'codebuddy' },
      { id: 'claude', name: 'Claude', kind: 'acp', command: 'claude-agent-acp', available: agent === 'claude' },
    ],
    active: activeBackend,
    workspace: basename(workspace),
    ...(backendChosen ? {} : { needsChoice: true }),
  }),
  loadActiveSessionId: () => activeSessionId,
  saveActiveSessionId: (id) => void (activeSessionId = id),
  loadSessions: () => stored,
  saveSessions: (list) => void (stored = [...list]),
});
const newConnection = () =>
  new AcpConnection({
    command,
    args,
    cwd: workspace,
    env: { ...baseEnv, HOME: home, USERPROFILE: home, ...agentEnv },
    log: (line) => console.log(`  [conn] ${line}`),
    onStderr: (line) => console.log(`  [${agent}] ${line}`),
    onNotification: (method, params) => {
      if (process.env.ACP_E2E_TRACE) console.log(`  [trace] ${method} ${JSON.stringify(params).slice(0, 240)}`);
      if (method === 'session/update') controller.onSessionUpdate(params);
    },
    onRequest: (method, params) => controller.onAgentRequest(method, params),
    onExit: (code) => console.log(`  [${agent}] exited ${code}`),
  });
let connection = newConnection();
let starts = 0;

async function connect(): Promise<AcpInitialize> {
  starts++;
  controller.setRuntimeStatus({ kind: 'starting' });
  await connection.start();
  const init = await connection.request<AcpInitialize>('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'harness-deck', version: 'e2e' },
  });
  controller.setRuntimeStatus({ kind: 'connected', version: init.agentInfo?.version ?? '', newerThanTested: false });
  controller.setLink(connection, init);
  return init;
}

async function restartAgent(): Promise<void> {
  controller.setLink(undefined);
  await connection.dispose();
  connection = newConnection();
  await connect();
}

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
    // 选择底层由 extension.ts 处理：这里只记下来，标记已经选过
    if (message?.type === 'selectBackend' || message?.type === 'dismissBackendChoice') {
      backendMessages.push(message.type === 'selectBackend' ? message.payload.id : 'later');
      backendChosen = true;
      controller.backendsChanged();
      return;
    }
    if (message) void controller.handle(message);
  });
  await page.goto(base);
  const shot = (name: string) => page!.screenshot({ path: join(outDir, `${name}.png`) });
  const composer = page.getByRole('textbox', { name: '消息' });
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press('Enter');
  };

  // 1. 启动代理，initialize
  const init = await connect();
  if (agent === 'omp') check('omp 启动，initialize 返回代理信息', init.agentInfo?.name === 'omp', JSON.stringify(init.agentInfo));
  else if (agent === 'claude') check('Claude 适配器启动，initialize 返回代理信息', init.agentInfo?.name === '@agentclientprotocol/claude-agent-acp', JSON.stringify(init.agentInfo));
  // CodeBuddy 的 initialize 没有 agentInfo，有登录方式
  else check('CodeBuddy 启动，initialize 返回登录方式', (init.authMethods?.length ?? 0) > 1, JSON.stringify(init.authMethods));

  // 1b. 第一次使用：选择底层的卡片
  const chooser = page.getByTestId('backend-chooser');
  await chooser.waitFor({ timeout: 10_000 }).then(
    () => check('第一次打开显示选择底层的卡片', true),
    () => check('第一次打开显示选择底层的卡片', false),
  );
  check('卡片列出 dsh、oh-my-pi、CodeBuddy、Claude', (await chooser.locator('.backend-option').count()) === 4);
  const current = chooser.locator(`[data-testid="backend-option-${activeBackend}"]`);
  check('当前底层标为「当前」并显示已安装', (await current.getAttribute('aria-checked')) === 'true' && (await current.innerText()).includes('已安装'), await current.innerText());
  check('没装的底层显示安装命令', (await chooser.locator('.backend-option__install', { hasText: 'npm install -g @deepseek-ai/dsh' }).count()) === 1);
  await shot('00-welcome');
  await current.click();
  await page.locator('.home').waitFor({ timeout: 10_000 }).then(
    () => check('选好后显示首页', true),
    () => check('选好后显示首页', false),
  );
  check('选择发给了 Host', backendMessages.join(',') === activeBackend, backendMessages.join(','));
  const homeBackend = page.getByTestId('home-backend');
  check('首页显示当前底层和工作区', (await homeBackend.innerText()).includes({ omp: 'oh-my-pi', codebuddy: 'CodeBuddy', claude: 'Claude' }[agent]) && (await page.locator('.home__chip', { hasText: basename(workspace) }).count()) === 1);
  await homeBackend.click();
  await chooser.waitFor({ timeout: 5_000 });
  check('点首页的底层标签打开选择卡片（不是欢迎卡片，可以返回）', (await chooser.locator('[data-testid="backend-later"]').count()) === 0);
  await chooser.getByRole('button', { name: '返回' }).click();
  await page.locator('.home').waitFor({ timeout: 5_000 });
  check('卡片和首页用各个底层的官方图标', (await page.locator('.home__chip [data-logo]').count()) === 1);
  await page.getByRole('button', { name: '更多' }).click();
  const backendItems = page.locator('.more-menu .menu-item [data-logo]');
  check('菜单里的底层带官方图标', (await backendItems.count()) === 4, String(await backendItems.count()));
  await shot('00b-menu');
  await page.keyboard.press('Escape');

  // 2. 草稿会话：发消息前模型和模式就能用
  await page.getByTestId('model-picker').locator('.toolbar-button__text', { hasText: modelLabel }).waitFor({ timeout: 60_000 }).then(
    () => check(`新对话里模型选择显示代理的当前模型（${modelLabel}）`, true),
    async () => check(`新对话里模型选择显示代理的当前模型（${modelLabel}）`, false, await page!.getByTestId('model-picker').innerText()),
  );
  check(`权限选择显示代理的模式（${defaultModeLabel}）`, ((await page.getByTestId('permission-picker').getAttribute('title')) ?? '').includes(defaultModeLabel));
  await shot('01-empty');

  // 3. 流式回复
  await send('HELLO 打个招呼');
  await page.locator('.assistant', { hasText: `我是 ${agent}` }).waitFor({ timeout: 30_000 }).then(
    () => check('流式回复显示在对话里', true),
    () => check('流式回复显示在对话里', false),
  );
  check('用户消息显示', (await page.locator('.user', { hasText: 'HELLO 打个招呼' }).count()) === 1);

  // 4. 工具：读文件、写文件（omp 无需审批，CodeBuddy 默认模式和 Claude 的 Manual 模式要审批）、命令（需要审批）
  if (agent === 'claude') {
    // Claude 默认是 Auto（由 Claude 自己决定要不要问）：切到 Manual，审批才会出现
    await page.getByTestId('permission-picker').click();
    await page.getByRole('menuitem', { name: /Manual/u }).click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="permission-picker"]')?.getAttribute('title') ?? '').includes('Manual'), undefined, { timeout: 10_000 }).then(
      () => check('切换到 Claude 的 Manual 模式', true),
      () => check('切换到 Claude 的 Manual 模式', false),
    );
  }
  await send('WORK 写个笔记再看看目录');
  const approval = page.getByTestId('approval-card');
  if (agent !== 'omp') {
    await approval.waitFor({ timeout: 30_000 }).then(
      () => check('写文件需要审批时显示审批卡片', true),
      () => check('写文件需要审批时显示审批卡片', false),
    );
    check('写文件的审批卡片显示文件（从已收到的工具调用补上）', (await approval.innerText()).includes('notes.md'), await approval.innerText().catch(() => ''));
    await approval.getByRole('button', { name: /允许本次/u }).click();
    await page.waitForFunction((cmd: string) => !document.querySelector('[data-testid="approval-card"]') || document.querySelector('[data-testid="approval-card"]')?.textContent?.includes(cmd), bashCommand, { timeout: 30_000 });
  }
  await approval.filter({ hasText: bashCommand }).waitFor({ timeout: 30_000 }).then(
    () => check('命令需要审批时显示审批卡片', true),
    () => check('命令需要审批时显示审批卡片', false),
  );
  check('审批卡片显示要运行的命令', (await approval.innerText()).includes(bashCommand), await approval.innerText().catch(() => ''));
  await shot('02-approval');
  await approval.getByRole('button', { name: /允许本次/u }).click();
  await page.locator('.assistant', { hasText: '写好了笔记' }).waitFor({ timeout: 30_000 });
  const explore = page.locator('.activity', { hasText: '已浏览' });
  check('读文件显示成「浏览」行', (await explore.count()) === 1 && (await explore.innerText()).includes('读取 1 个文件'), await explore.first().innerText().catch(() => ''));
  const edit = page.locator('.activity--edit', { hasText: 'notes.md' });
  check('写文件显示成修改行和增加的行数', (await edit.count()) === 1 && (await edit.innerText()).includes('+3'), await edit.innerText().catch(() => ''));
  const commandRow = page.locator('.activity--command', { hasText: bashCommand });
  check('命令显示成「已运行」行', (await commandRow.count()) === 1 && (await commandRow.innerText()).includes('已运行'), await commandRow.innerText().catch(() => ''));
  await commandRow.locator('.activity__row').click();
  check('点开命令看到输出', (await commandRow.innerText()).includes('notes.md'), await commandRow.innerText());
  check('命令输出里没有代理的包装格式', !(await commandRow.innerText()).includes('Stdout:'), await commandRow.innerText());
  check('笔记真的写到了工作区', (await readFile(join(workspace, 'notes.md'), 'utf8').catch(() => '')).includes('第一条'));
  await shot('03-tools');

  // 待办：omp 和 Claude 用 plan 更新；CodeBuddy 的 TaskCreate / TaskUpdate 完成时带上整张待办表
  if (agent !== 'omp') {
    await send('TODO 列个计划');
    await page.locator('.assistant', { hasText: '列好计划了' }).waitFor({ timeout: 30_000 });
    const todo = page.locator('.todo-card');
    await todo.waitFor({ timeout: 10_000 }).then(
      async () => check('待办显示在输入框上方的状态条', (await todo.innerText()).includes('改代码') && (await todo.innerText()).includes('1/2'), await todo.innerText()),
      () => check('待办显示在输入框上方的状态条', false),
    );
    check('待办工具不显示成对话里的工具行', (await page.locator('.activity', { hasText: 'TaskCreate' }).count()) + (await page.locator('.activity', { hasText: 'TodoWrite' }).count()) === 0);
    await shot('03b-todos');
  }

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
    () => check('重新打开会话：历史从代理回放', true),
    () => check('重新打开会话：历史从代理回放', false),
  );
  check('回放的历史里有工具行', (await page.locator('.activity--command', { hasText: bashCommand }).count()) === 1);

  // 6. 模式：切到 Plan，显示计划模式标记
  await page.getByTestId('permission-picker').click();
  await page.getByRole('menuitem', { name: /Plan/u }).click();
  await page.getByTestId('plan-badge').waitFor({ timeout: 10_000 }).then(
    () => check('切换到代理的 Plan 模式后显示计划模式标记', true),
    () => check('切换到代理的 Plan 模式后显示计划模式标记', false),
  );
  await page.getByTestId('plan-badge').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="plan-badge"]'), undefined, { timeout: 10_000 }).then(
    () => check('点击标记退出计划模式', true),
    () => check('点击标记退出计划模式', false),
  );

  // 7. 停止生成。CodeBuddy：上面点过新对话（新建了会话），回到旧会话发消息时要重启代理、重新加载这个会话才收得到回复
  await send('SLOW 慢慢想');
  await page.locator('.assistant', { hasText: '正在慢慢想' }).waitFor({ timeout: 30_000 });
  if (agent === 'codebuddy') {
    check('回到旧会话发消息：重启 CodeBuddy 并重新加载这个会话后收到流式回复', starts === 2, `启动了 ${starts} 次`);
    check('重新加载后历史还在', (await page.locator('.user', { hasText: 'HELLO 打个招呼' }).count()) === 1);
  } else {
    check('不需要重启代理', starts === 1, `启动了 ${starts} 次`);
  }
  check('运行中显示运行状态', (await page.getByTestId('run-status').count()) === 1);
  await page.getByRole('button', { name: '停止生成' }).click();
  await page.locator('.notice', { hasText: '已停止生成' }).waitFor({ timeout: 30_000 }).then(
    () => check('停止后显示「已停止生成」', true),
    () => check('停止后显示「已停止生成」', false),
  );
  await shot('04-stopped');
  check('页面没有脚本错误', errors.length === 0, errors.join(' | '));
} catch (error) {
  // 某一步等不到时保留现场
  await page?.screenshot({ path: join(outDir, 'failure.png') }).catch(() => undefined);
  console.log('模型收到的请求：', JSON.stringify(model.requests.map((r) => ({ path: r.path, marker: r.marker, user: r.userText?.slice(-60) }))));
  throw error;
} finally {
  await browser.close();
  await connection.dispose();
  server.close();
  await model.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图：${outDir}`);
process.exit(failed.length ? 1 : 0);
