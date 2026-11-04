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
import { reverseHunks, reverseToolDiffs } from '../src/vm/diffs.ts';
import type { DiffRequest, EditorSnapshot, Workbench } from '../src/vm/workbench.ts';
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
    E2E_CTX: { kind: 'text', chunks: ['收到，', '我看了你选中的代码。'], delayMs: 30 },
    E2E_SLOW: { kind: 'hold', chunks: ['正在', '仔细', '分析'] },
    E2E_EDIT: {
      kind: 'tools',
      tools: [
        { name: 'read', input: { file_path: 'README.md' } },
        { name: 'edit', input: { file_path: 'README.md', old_string: '一个演示项目。', new_string: '一个用来演示的项目。\n\n## 用法\n\n运行 `pnpm dev`。' } },
        { name: 'write', input: { file_path: 'docs/notes.md', content: '# 笔记\n\n- 第一条\n- 第二条\n' } },
      ],
      after: '改好了：README 补充了用法，另外新建了 `docs/notes.md`。',
    },
    E2E_APPROVE: {
      kind: 'tool',
      tool: {
        name: 'bash',
        input: { description: 'Install deps', command: 'echo installed', sandbox_permissions: 'danger-full-access', justification: '需要访问网络下载依赖' },
      },
      after: '依赖装好了。',
    },
    E2E_DENY: {
      kind: 'tool',
      tool: {
        name: 'bash',
        input: { description: 'Clean cache', command: 'echo should-not-run', sandbox_permissions: 'danger-full-access', justification: '需要清理全局缓存' },
      },
      after: '好的，不清理了。',
    },
    E2E_ASK: {
      kind: 'tool',
      tool: {
        name: 'ask_user_question',
        input: {
          questions: [
            {
              id: 'scope',
              header: '范围',
              question: '这次改动要包括哪些部分？',
              options: [
                { label: '只改测试', description: '不动实现代码' },
                { label: '一起改实现', description: '同时修复发现的问题' },
              ],
            },
          ],
        },
      },
      after: '明白，按你的选择来。',
    },
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
// 记录打开 Diff 等编辑器操作；确认框总是同意
const diffRequests: DiffRequest[] = [];
const confirms: string[] = [];
let dirtyFiles: string[] = [];
let editorSnapshot: EditorSnapshot | undefined;
const workbench: Workbench = {
  openDiff: async (request) => void diffRequests.push(request),
  openFile: async () => undefined,
  activeEditor: () => editorSnapshot,
  findFiles: async () => [],
  dirtyFiles: () => dirtyFiles,
  saveAll: async () => {
    dirtyFiles = [];
    controller.workspaceChanged();
  },
  confirm: async (message) => {
    confirms.push(message);
    return true;
  },
};
const controller = new ChatController({
  workbench,
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
  check('读文件和搜索合并成一行「浏览」，命令单独一行', (await activities.count()) === 2, String(await activities.count()));
  check('浏览行显示摘要', (await page.locator('.activity', { hasText: '已浏览' }).locator('.activity__detail', { hasText: '读取 1 个文件，搜索 1 次' }).count()) === 1);
  check('命令行显示命令', (await page.locator('.activity__detail', { hasText: 'echo "3 passed"' }).count()) === 1);
  await page.locator('.activity__row', { hasText: '已浏览' }).click();
  check('展开浏览行显示每一步和相对路径', await page.locator('.explore__entry', { hasText: 'README.md' }).isVisible());
  await shot('05-tools');
  await page.locator('.activity__row', { hasText: 'echo' }).click();
  check('展开命令行显示输出', await page.locator('.activity__output', { hasText: '3 passed' }).isVisible());
  await shot('06-tool-output');

  // 2b. 文件修改：增删行数、Diff、本轮改动汇总
  await send('E2E_EDIT 给 README 补充用法，再记一份笔记');
  await page.locator('.assistant', { hasText: '改好了' }).waitFor({ timeout: 30_000 });
  const editRow = page.locator('.activity--edit', { hasText: 'README.md' });
  check('修改行显示「已编辑」和增删行数', (await editRow.locator('.activity__name').innerText()) === '已编辑' && (await editRow.locator('.stats').innerText()).replace(/\s+/gu, ' ') === '+5 −1', await editRow.innerText());
  check('新建文件显示「已新建」', (await page.locator('.activity--edit', { hasText: 'docs/notes.md' }).locator('.activity__name').innerText()) === '已新建');
  await page.locator('.changes').waitFor({ timeout: 10_000 }).then(
    () => check('本轮结束显示改动汇总卡片', true),
    () => check('本轮结束显示改动汇总卡片', false),
  );
  check('改动汇总列出两个文件', (await page.locator('.changes__file').count()) === 2 && (await page.locator('.changes__header').innerText()).includes('2 个文件已更改'));
  await shot('13-edits');
  await editRow.locator('.activity__row').click();
  await page.waitForTimeout(200);
  const toolDiff = diffRequests.at(-1);
  const readmeNow = await readFile(join(env.workspace, 'README.md'), 'utf8');
  check(
    '点击修改行：用工具片段还原出修改前的 README',
    toolDiff?.kind === 'tool' && reverseToolDiffs(readmeNow, toolDiff.diffs) === '# demo\n\n一个演示项目。\n',
    JSON.stringify(toolDiff),
  );
  await page.locator('.changes__file', { hasText: 'README.md' }).click();
  await page.waitForTimeout(500);
  const turnDiff = diffRequests.at(-1);
  check(
    '点击汇总里的文件：用本轮 hunk 还原出修改前的 README',
    turnDiff?.kind === 'turn' && turnDiff.path === join(env.workspace, 'README.md') && reverseHunks(readmeNow, turnDiff.hunks) === '# demo\n\n一个演示项目。\n',
    JSON.stringify(turnDiff),
  );

  // 2c. 审批：允许
  await send('E2E_APPROVE 装一下依赖');
  const approval = page.getByTestId('approval-card');
  await approval.waitFor({ timeout: 30_000 });
  check('审批卡片显示要运行的命令', (await approval.locator('.interaction__command').innerText()).includes('echo installed'));
  check('审批卡片显示原因', (await approval.locator('.interaction__reason').innerText()).includes('需要访问网络下载依赖'));
  check('等待审批时不显示「思考中」', (await page.locator('.thinking').count()) === 0);
  await shot('14-approval');
  await approval.getByRole('button', { name: '允许本次' }).click();
  await page.locator('.assistant', { hasText: '依赖装好了' }).waitFor({ timeout: 30_000 });
  check('允许后卡片消失，命令执行成功', (await approval.count()) === 0 && (await page.locator('.activity--ok', { hasText: 'echo installed' }).count()) === 1);

  // 2d. 审批：拒绝
  await send('E2E_DENY 顺便清一下缓存');
  await approval.waitFor({ timeout: 30_000 });
  await approval.getByRole('button', { name: '拒绝' }).click();
  await page.locator('.assistant', { hasText: '不清理了' }).waitFor({ timeout: 30_000 });
  check('拒绝后命令标记为失败', (await page.locator('.activity--error', { hasText: 'should-not-run' }).count()) === 1);

  // 2e. 提问
  await send('E2E_ASK 帮我修一下测试');
  const question = page.getByTestId('question-card');
  await question.waitFor({ timeout: 30_000 });
  check('提问卡片显示问题和选项', (await question.innerText()).includes('这次改动要包括哪些部分？') && (await question.getByRole('radio').count()) === 2);
  check('没选之前不能提交', await question.getByRole('button', { name: '提交' }).isDisabled());
  await question.getByRole('radio', { name: /一起改实现/u }).click();
  await shot('15-question');
  await question.getByRole('button', { name: '提交' }).click();
  await page.locator('.assistant', { hasText: '按你的选择来' }).waitFor({ timeout: 30_000 });
  check('提交后卡片消失，dsh 收到选择', (await question.count()) === 0);

  // 2f. 权限预设
  const permission = page.getByTestId('permission-picker');
  check('输入框工具条显示当前权限', (await permission.innerText()).includes('工作区可写'));
  await permission.click();
  await page.getByRole('menuitem', { name: /只读/u }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="permission-picker"]')?.textContent?.includes('只读'), undefined, { timeout: 10_000 });
  check('切换到只读', true);
  await permission.click();
  await shot('16-permissions');
  await page.getByRole('menuitem', { name: /完全访问/u }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="permission-picker"]')?.textContent?.includes('完全访问'), undefined, { timeout: 10_000 });
  check('切换到完全访问前先确认，按钮标为警告色', confirms.length === 1 && (await permission.getAttribute('class'))?.includes('toolbar-button--danger') === true);
  await permission.click();
  await page.getByRole('menuitem', { name: /工作区可写/u }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="permission-picker"]')?.textContent?.includes('工作区可写'), undefined, { timeout: 10_000 });

  // 2g. 未保存的文件
  dirtyFiles = [join(env.workspace, 'README.md')];
  controller.workspaceChanged();
  await page.getByTestId('dirty-strip').waitFor({ timeout: 5_000 });
  check('有未保存文件时输入框上方提示', (await page.getByTestId('dirty-strip').innerText()).includes('1 个文件有未保存的修改'));
  await shot('17-dirty');
  await page.getByTestId('dirty-strip').getByRole('button', { name: '全部保存' }).click();
  await page.getByTestId('dirty-strip').waitFor({ state: 'detached', timeout: 5_000 });
  check('全部保存后提示消失', true);

  // 2h. 编辑器上下文：选区标签、@ 引用、斜杠命令
  editorSnapshot = {
    path: join(env.workspace, 'src/index.ts'),
    languageId: 'typescript',
    selection: { startLine: 1, endLine: 1, text: 'export const answer = 42;', diagnostics: [] },
  };
  controller.workspaceChanged();
  const activeChip = page.getByTestId('active-context');
  await activeChip.waitFor({ timeout: 5_000 });
  check('输入框显示当前选区标签', (await activeChip.innerText()).includes('index.ts:1'));
  await composer.fill('');
  await composer.press('@');
  await composer.press('R');
  await composer.press('E');
  const completion = page.getByTestId('completion');
  await completion.locator('[role="option"]', { hasText: 'README.md' }).waitFor({ timeout: 10_000 });
  check('输入 @ 列出匹配的文件', true);
  await shot('18-mention');
  await composer.press('Enter');
  check('确认补全后插入 @README.md', (await composer.inputValue()) === '@README.md ');
  await composer.fill('E2E_CTX 解释一下，参考 @README.md');
  await shot('19-context');
  await composer.press('Enter');
  await page.locator('.assistant', { hasText: '我看了你选中的代码' }).waitFor({ timeout: 30_000 });
  const ctxRequest = env.model.requests.filter((r) => r.marker === 'E2E_CTX').at(-1);
  check(
    'dsh 发给模型的消息里有选区的路径、行号和代码',
    ctxRequest?.userText?.includes('<selection path="src/index.ts" lines="1" language="typescript">\nexport const answer = 42;\n</selection>') === true,
    ctxRequest?.userText?.slice(-300),
  );
  const ctxBubble = page.locator('.user', { hasText: 'E2E_CTX' });
  check('消息气泡里不显示上下文块，选区显示为标签', !(await ctxBubble.innerText()).includes('ide_context') && (await ctxBubble.locator('.chip', { hasText: 'index.ts:1' }).count()) === 1);
  check('消息里的 @README.md 显示为可点击的引用', (await ctxBubble.locator('.mention', { hasText: '@README.md' }).count()) === 1);
  await activeChip.click();
  check('点击标签后不附带', (await activeChip.getAttribute('aria-pressed')) === 'false');
  await send('E2E_CTX 这次不带选区');
  await page.locator('.user', { hasText: '这次不带选区' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  check('关掉标签后发送的消息不带上下文', (await page.locator('.user', { hasText: '这次不带选区' }).locator('.chip').count()) === 0);
  await page.locator('.assistant', { hasText: '我看了你选中的代码' }).nth(1).waitFor({ timeout: 30_000 });
  editorSnapshot = undefined;
  controller.workspaceChanged();
  await activeChip.waitFor({ state: 'detached', timeout: 5_000 });

  await composer.fill('');
  await composer.press('/');
  await completion.locator('[role="option"]', { hasText: '/compact' }).waitFor({ timeout: 10_000 });
  const commandOptions = await completion.locator('[role="option"]').allInnerTexts();
  check('输入 / 列出插件模板和 dsh 命令（不含 /export）', ['/explain', '/fix', '/test', '/new', '/compact', '/plan'].every((name) => commandOptions.some((t) => t.includes(name))) && !commandOptions.some((t) => t.includes('/export')), commandOptions.join(' | '));
  await shot('20-commands');
  await composer.press('c');
  await composer.press('o');
  await composer.press('Enter');
  check('确认后插入 /compact', (await composer.inputValue()) === '/compact ');
  await composer.press('Enter');
  await page.locator('.activity', { hasText: '/compact' }).locator('.activity__detail', { hasText: 'Compacted' }).waitFor({ timeout: 30_000 }).then(
    () => check('/compact 交给 dsh 执行，结果显示在对话里', true),
    () => check('/compact 交给 dsh 执行，结果显示在对话里', false),
  );
  check('压缩生成的检查点消息不显示成用户消息', (await page.locator('.user', { hasText: 'checkpoint' }).count()) === 0);
  await send('/plan');
  await page.getByTestId('plan-badge').waitFor({ timeout: 15_000 }).then(
    () => check('/plan 后输入框显示计划模式', true),
    () => check('/plan 后输入框显示计划模式', false),
  );
  await page.getByTestId('plan-badge').click();
  await page.getByTestId('plan-badge').waitFor({ state: 'detached', timeout: 15_000 }).then(
    () => check('点击计划模式标记退出计划模式', true),
    () => check('点击计划模式标记退出计划模式', false),
  );

  editorSnapshot = { path: join(env.workspace, 'README.md'), languageId: 'markdown' };
  controller.pinActiveEditor();
  editorSnapshot = undefined;
  controller.workspaceChanged();
  const pinnedChip = page.locator('.context-chips .chip', { hasText: 'README.md' });
  await pinnedChip.waitFor({ timeout: 5_000 });
  check('「添加到对话」后输入框显示固定的标签', true);
  await shot('21-pinned');
  await pinnedChip.getByRole('button', { name: /移除/u }).click();
  await pinnedChip.waitFor({ state: 'detached', timeout: 5_000 });
  check('固定的标签可以移除', true);

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
  check('切换回第一个会话，历史完整恢复', activeSessionId === firstSession && (await page.locator('.changes').count()) === 1 && (await page.locator('.activity').count()) === 11, (await page.locator('.activity').allInnerTexts()).join(' | '));

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
  await page.locator('.changes__note', { hasText: 'dsh 重启过' }).waitFor({ timeout: 15_000 }).then(
    () => check('重启后改动汇总退回按文件工具汇总', true),
    () => check('重启后改动汇总退回按文件工具汇总', false),
  );
  const before = diffRequests.length;
  await page.locator('.changes__file', { hasText: 'README.md' }).click();
  await page.waitForTimeout(300);
  const afterRestart = diffRequests.at(-1);
  check(
    '重启后历史 Diff 仍能打开（来自会话日志）',
    diffRequests.length === before + 1 && afterRestart?.kind === 'tool' && reverseToolDiffs(readmeNow, afterRestart.diffs) === '# demo\n\n一个演示项目。\n',
  );
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
