/**
 * 在真实 VS Code 中验证插件：用 code-server（浏览器里的 VS Code）加载打包好的 vsix，
 * 通过命令面板打开对话、发消息、看工具调用和代码高亮、切换模型，并截图。
 *
 * 前置条件：
 * - 已执行 `pnpm package`（产出 packages/extension/dsh-copilot-*.vsix）
 * - 本机装有 code-server（`npm install code-server`，需要 Node 24）和 playwright + Chromium
 *
 * 用法：
 *   pnpm --filter dsh-copilot run vscode-e2e -- --code-server <code-server 可执行文件> --dsh <dsh> \
 *     [--node-bin <Node 24 bin>] [--vsix <vsix>] [--out <截图目录>]
 *
 * 注意：远程场景（code-server、Remote-SSH）下 machine 范围的设置（dsh.runtime.path）从远端的
 * Machine/settings.json 读取，而不是用户设置。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDshTestEnv } from '../test/support/dshEnv.ts';
import { loadPlaywright, type Page } from './playwright-lite.ts';

const { values: cli } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    'code-server': { type: 'string' },
    dsh: { type: 'string' },
    'node-bin': { type: 'string' },
    vsix: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!cli['code-server'] || !cli.dsh) {
  console.error('需要 --code-server <路径> 和 --dsh <路径>');
  process.exit(2);
}
const codeServer = cli['code-server'];
const here = fileURLToPath(new URL('.', import.meta.url));
const vsix =
  cli.vsix ?? join(here, '..', (await readdir(join(here, '..'))).find((name) => name.endsWith('.vsix')) ?? 'missing.vsix');
const outDir = resolve(cli.out ?? join(here, '../../../.e2e-screenshots/vscode'));
await mkdir(outDir, { recursive: true });

const { chromium } = loadPlaywright();

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}`);
};

const env = await createDshTestEnv({
  nodeBin: cli['node-bin'],
  files: { 'README.md': '# demo\n', 'src/index.ts': 'export const answer = 42;\n' },
  scripts: {
    E2E_TOOL: {
      kind: 'tools',
      tools: [
        { name: 'read', input: { file_path: 'README.md' } },
        { name: 'bash', input: { description: 'Run tests', command: 'echo "3 passed"' } },
      ],
      after: '看过了 README，测试全部通过。\n\n```ts\nexport const answer = 42;\n```',
    },
    E2E_EDIT: {
      kind: 'tools',
      tools: [
        { name: 'read', input: { file_path: 'README.md' } },
        { name: 'edit', input: { file_path: 'README.md', old_string: '# demo', new_string: '# demo\n\n一个演示项目。' } },
      ],
      after: 'README 改好了。',
    },
    default: { kind: 'text', chunks: ['你好！', '我是 **dsh**，', '可以帮你阅读和修改代码。'], delayMs: 60 },
  },
});

// 全新的 VS Code 用户目录和插件目录，避免受本机已有配置影响
const vscodeRoot = await mkdtemp(join(tmpdir(), 'dsh-vscode-'));
const data = join(vscodeRoot, 'data');
const extensions = join(vscodeRoot, 'extensions');
await mkdir(join(data, 'User'), { recursive: true });
await mkdir(join(data, 'Machine'), { recursive: true });
await writeFile(
  join(data, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.tips.enabled': false,
  }),
);
await writeFile(join(data, 'Machine', 'settings.json'), JSON.stringify({ 'dsh.runtime.path': cli.dsh }));
const childEnv = { ...process.env, ...env.env, HOME: env.home };
execFileSync(codeServer, ['--extensions-dir', extensions, '--user-data-dir', data, '--install-extension', vsix], { env: childEnv, stdio: 'ignore' });

const port = 38_000 + Math.floor(Math.random() * 1_000);
const server = spawn(
  codeServer,
  ['--auth', 'none', '--bind-addr', `127.0.0.1:${port}`, '--extensions-dir', extensions, '--user-data-dir', data, '--disable-telemetry', '--disable-update-check', env.workspace],
  { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let serverLog = '';
server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

const browser = await chromium.launch();
let debugPage: Page | undefined;
try {
  for (let i = 0; i < 120 && !serverLog.includes('HTTP server listening'); i++) await new Promise((r) => setTimeout(r, 500));
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
  debugPage = page;
  await page.goto(`http://127.0.0.1:${port}/?folder=${encodeURIComponent(env.workspace)}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3_000);

  const runCommand = async (title: string) => {
    await page.keyboard.press('F1');
    await page.locator('.quick-input-widget input').waitFor();
    await page.keyboard.type(title);
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
  };
  // 插件的 Webview 在两层 iframe 里，找到含输入框的那一层
  const findWebview = async () => {
    for (let i = 0; i < 120; i++) {
      for (const frame of page.frames()) {
        if (await frame.locator('.composer').count().catch(() => 0)) return frame;
      }
      await page.waitForTimeout(500);
    }
    throw new Error('找不到插件的 Webview');
  };

  // code-server 的显示语言是英文：插件界面、命令标题都应该是英文（package.nls.json）
  await runCommand('DSH: Open Chat');
  const webview = await findWebview();
  check('命令面板「DSH: 打开对话」打开插件视图', true);
  // 等到会话列表可用（空状态出现、没有状态提示）再开始对话
  await webview.locator('.empty').waitFor({ timeout: 120_000 });
  await webview.waitForFunction(() => !document.querySelector('.banner'), undefined, { timeout: 120_000 });
  check('插件启动 dsh 并连接成功', true);

  const input = webview.getByRole('textbox', { name: 'Message' });
  check('VS Code 显示语言为英文时插件界面是英文', ((await input.getAttribute('placeholder')) ?? '').startsWith('Describe a task'));
  await input.fill('你好');
  await input.press('Enter');
  await webview.locator('.assistant', { hasText: '可以帮你阅读和修改代码' }).waitFor({ timeout: 60_000 });
  check('发送消息并收到流式回复', true);

  await input.fill('E2E_TOOL 看看 README，再跑一下测试');
  await input.press('Enter');
  await webview.locator('.assistant', { hasText: '测试全部通过' }).waitFor({ timeout: 60_000 });
  check('工具调用显示为活动行', (await webview.locator('.activity').count()) === 2);
  await webview.locator('.shiki').first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const colors = await webview.locator('.shiki .line span').first().evaluate((el) => ({
    token: getComputedStyle(el).color,
    body: getComputedStyle(document.body).color,
  }));
  check('代码高亮在 Webview 的 CSP 下生效', colors.token !== colors.body);
  const status = await page.locator('.statusbar-item', { hasText: 'DSH' }).first().innerText();
  check(`状态栏显示当前模型（${status.replace(/\s+/gu, ' ').trim()}）`, status.includes('·'));
  await page.screenshot({ path: join(outDir, 'conversation.png') });

  // 文件修改：点击修改行和改动汇总，在 VS Code 的 Diff 编辑器里打开
  await input.fill('E2E_EDIT 给 README 加一句介绍');
  await input.press('Enter');
  await webview.locator('.assistant', { hasText: 'README 改好了' }).waitFor({ timeout: 60_000 });
  await webview.locator('.activity--edit .activity__row').click();
  await page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15_000 }).then(
    () => check('点击修改行在 Diff 编辑器里打开', true),
    () => check('点击修改行在 Diff 编辑器里打开', false),
  );
  const tab = await page.locator('.tab.active').first().innerText().catch(() => '');
  check(`Diff 标签标明修改前后（${tab.replace(/\s+/gu, ' ').trim()}）`, tab.includes('before'));
  const original = await page.locator('.monaco-diff-editor .editor.original .view-lines').first().innerText().catch(() => '');
  const modified = await page.locator('.monaco-diff-editor .editor.modified .view-lines').first().innerText().catch(() => '');
  check('Diff 左侧是修改前的内容，右侧是当前文件', !original.includes('一个演示项目') && modified.includes('一个演示项目'));
  await page.screenshot({ path: join(outDir, 'diff.png') });
  await webview.locator('.changes__file').first().click();
  await page.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.includes('before this turn') ?? false, undefined, { timeout: 15_000 }).then(
    () => check('点击改动汇总里的文件打开本轮 Diff', true),
    () => check('点击改动汇总里的文件打开本轮 Diff', false),
  );

  // 切换到完全访问时弹出 VS Code 的模态确认框
  await webview.getByTestId('permission-picker').click();
  await webview.getByRole('menuitem', { name: /Full access/u }).click();
  const dialog = page.locator('.monaco-dialog-box');
  await dialog.waitFor({ timeout: 10_000 }).then(
    () => check('切换到完全访问前弹出模态确认框', true),
    () => check('切换到完全访问前弹出模态确认框', false),
  );
  await page.screenshot({ path: join(outDir, 'permission-confirm.png') });
  await dialog.getByRole('button', { name: 'Allow full access' }).click();
  await webview.waitForFunction(() => document.querySelector('[data-testid="permission-picker"]')?.textContent?.includes('Full access') ?? false, undefined, { timeout: 10_000 }).then(
    () => check('确认后权限切换为完全访问', true),
    () => check('确认后权限切换为完全访问', false),
  );

  // 编辑器右键菜单：选中代码 →「DSH → 解释这段代码」
  await page.keyboard.press('Control+P');
  await page.locator('.quick-input-widget input').waitFor();
  await page.keyboard.type('index.ts');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  const editorLines = page.locator('.editor-instance .monaco-editor .view-lines').first();
  await editorLines.waitFor({ timeout: 15_000 });
  await editorLines.click();
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(400);
  await editorLines.click({ button: 'right' });
  const dshMenu = page.locator('.monaco-menu .action-item', { hasText: 'DSH' }).first();
  await dshMenu.waitFor({ timeout: 10_000 }).then(
    () => check('编辑器右键菜单里有 DSH 子菜单', true),
    () => check('编辑器右键菜单里有 DSH 子菜单', false),
  );
  await dshMenu.hover();
  const explain = page.locator('.monaco-menu .action-label', { hasText: 'Explain This Code' }).first();
  await explain.waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(outDir, 'context-menu.png') });
  await explain.click();
  const explainBubble = webview.locator('.user', { hasText: 'Explain this code' });
  await explainBubble.waitFor({ timeout: 30_000 });
  check('右键「解释这段代码」发送消息，气泡显示选区标签', (await explainBubble.locator('.chip', { hasText: 'index.ts:1' }).count()) === 1);
  for (let i = 0; i < 40 && !env.model.requests.some((r) => r.userText?.includes('Explain this code')); i++) await page.waitForTimeout(500);
  const explainRequest = env.model.requests.filter((r) => r.userText?.includes('Explain this code')).at(-1);
  check(
    'dsh 收到的消息带有正确的路径、行号和代码',
    explainRequest?.userText?.includes('<selection path="src/index.ts" lines="1" language="typescript">\nexport const answer = 42;\n</selection>') === true,
  );
  await page.screenshot({ path: join(outDir, 'explain.png') });

  await runCommand('DSH: Switch Model');
  await page.waitForTimeout(800);
  check('命令「DSH: 切换模型」列出模型', (await page.locator('.quick-input-list .monaco-list-row').count()) > 0);
  await page.screenshot({ path: join(outDir, 'select-model.png') });
  await page.keyboard.press('Escape');
} catch (error) {
  check(`未预期的错误：${error instanceof Error ? error.message : String(error)}`, false);
  await debugPage?.screenshot({ path: join(outDir, 'failure.png') }).catch(() => undefined);
  for (const frame of debugPage?.frames() ?? []) {
    const text = await frame.locator('.app').innerText().catch(() => '');
    if (text) console.log(`Webview 内容：\n${text}`);
  }
  console.log(serverLog.slice(-3_000));
} finally {
  await browser.close();
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    // 已经退出
  }
  await new Promise((r) => setTimeout(r, 2_000));
  try {
    process.kill(-server.pid!, 'SIGKILL');
  } catch {
    // 已经退出
  }
  await env.cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过；截图：${outDir}`);
process.exit(failed.length === 0 ? 0 : 1);
