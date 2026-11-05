/**
 * 插件入口：把运行时管理、连接、对话控制器和侧边栏视图串起来。
 *
 *   RuntimeManager ──endpoint──▶ DshConnection ──client──▶ ChatController ◀──messages──▶ ChatViewProvider
 */
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { AppearanceState, RuntimeStatus } from '@dsh-copilot/shared';
import { DshConnection } from './dsh/DshConnection.ts';
import { RuntimeManager, type RuntimeConfig } from './runtime/RuntimeManager.ts';
import { ChatController } from './vm/ChatController.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';
import { resolveLocale, setLocale, t } from './i18n.ts';
import { redactSecrets } from './util/redact.ts';
import { webUIUrl } from './util/webUrl.ts';

const ACTIVE_SESSION_KEY = 'dsh.activeSessionId';
const OPEN_TABS_KEY = 'dsh.openTabs';
const FOLDER_KEY = 'dsh.folder';

let runtime: RuntimeManager | undefined;
let connection: DshConnection | undefined;
let controller: ChatController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const applyLocale = (): void =>
    setLocale(resolveLocale(vscode.env.language, vscode.workspace.getConfiguration('dsh.ui').get<string>('language', 'auto')));
  applyLocale();
  const output = vscode.window.createOutputChannel('DSH', { log: true });
  // 所有日志都先脱敏：错误信息里可能带着 dsh 回显的令牌或 API Key
  const log = (line: string): void => output.info(redactSecrets(line));
  const runtimeOutput = vscode.window.createOutputChannel('DSH Runtime', { log: true });
  context.subscriptions.push(output, runtimeOutput);

  // 多根工作区：用上次选择的文件夹，默认第一个；dsh 的会话按文件夹（dsh Workspace）分开
  const folders = (): readonly vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const savedFolder = context.workspaceState.get<string>(FOLDER_KEY);
  let workspacePath = folders().find((f) => f.uri.fsPath === savedFolder)?.uri.fsPath ?? folders()[0]?.uri.fsPath ?? homedir();
  const sessionKey = () => (folders().length > 1 ? `${ACTIVE_SESSION_KEY}:${workspacePath}` : ACTIVE_SESSION_KEY);
  const tabsKey = () => (folders().length > 1 ? `${OPEN_TABS_KEY}:${workspacePath}` : OPEN_TABS_KEY);

  const manager = new RuntimeManager({
    getConfig: () => readRuntimeConfig(workspacePath),
    log: log,
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(line) : runtimeOutput.info(line)),
  });
  runtime = manager;
  const dsh = new DshConnection({ log: log });
  connection = dsh;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dsh.openChat';
  context.subscriptions.push(status);
  let modelLabel: string | undefined;

  const currentStatus = (): RuntimeStatus => (vscode.workspace.isTrusted ? manager.currentStatus : { kind: 'untrusted' });

  const openExternal = (url: string): void => {
    const uri = vscode.Uri.parse(url);
    // 传原字符串：Uri.toString() 会把查询里的 = 等字符编码掉，链接带参数时打开的地址就不对了
    if (uri.scheme === 'http' || uri.scheme === 'https') void vscode.env.openExternal(url as unknown as vscode.Uri);
  };

  /**
   * 在浏览器中打开 dsh 网页。dsh 只监听 dsh 所在机器的 127.0.0.1：远程开发（Remote-SSH、WSL、容器、code-server）时
   * 浏览器在另一台机器上，直接打开连不上，要经过 asExternalUri 让 VS Code 转发端口（本地时原样返回）。
   * 启动令牌让浏览器完成一次认证，之后 dsh 用 Cookie 维持登录。dsh 网页没有指向某个会话的地址，只能提示会话标题。
   */
  const openWebUI = async (sessionTitle?: string): Promise<void> => {
    const endpoint = manager.endpoint;
    if (!endpoint) {
      void vscode.window.showWarningMessage(t('ext.notStarted'));
      return;
    }
    const url = await webUIUrl(endpoint.origin, endpoint.token, externalOrigin, (line) => log(line));
    log(`在浏览器中打开 dsh：${url.replace(/token=[^&]*/u, 'token=***')}`);
    // 传字符串而不是 Uri：Uri.toString() 会把查询里的 = 编码成 %3D，dsh 就认不出 token（认证失败）。
    // 扩展 API 的 openExternal 接受字符串并原样交给浏览器（VS Code 为这个问题专门保留的写法）。
    const opened = await vscode.env.openExternal(url as unknown as vscode.Uri);
    const copy = t('ext.copyLink');
    const message = !opened ? t('ext.webUIFailed') : sessionTitle ? t('ext.webUIOpenedSession', sessionTitle) : t('ext.webUIOpened');
    const choice = await (opened ? vscode.window.showInformationMessage(message, copy) : vscode.window.showWarningMessage(message, copy));
    if (choice === copy) await vscode.env.clipboard.writeText(url);
  };

  let provider: ChatViewProvider | undefined;
  const workbench = new VscodeWorkbench(log);
  const chat = new ChatController({
    workbench,
    includeActiveEditor: () => vscode.workspace.getConfiguration('dsh.context').get<boolean>('includeActiveEditor', true),
    workspacePath,
    post: (message) => provider?.post(message),
    log: log,
    loadActiveSessionId: () => context.workspaceState.get<string>(sessionKey()),
    saveActiveSessionId: (sessionId) => void context.workspaceState.update(sessionKey(), sessionId),
    loadOpenTabs: () => context.workspaceState.get<string[]>(tabsKey()),
    saveOpenTabs: (ids) => void context.workspaceState.update(tabsKey(), [...ids]),
    folderLabel: () => (folders().length > 1 ? folders().find((f) => f.uri.fsPath === workspacePath)?.name : undefined),
    selectFolder: () => void vscode.commands.executeCommand('dsh.selectFolder'),
    openExternal,
    restartRuntime: () => void manager.restart(),
    showLogs: () => output.show(),
    openWebUI: (sessionTitle) => void openWebUI(sessionTitle),
    appearance: readAppearance,
    showTurnChanges: () => vscode.workspace.getConfiguration('dsh.ui').get<boolean>('showTurnChanges', false),
    openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    setAppearance: async (patch) => {
      const config = vscode.workspace.getConfiguration('dsh.ui');
      for (const [key, value] of Object.entries(patch) as [string, number | string | null | undefined][]) {
        if (value === undefined) continue;
        // 写到已经设置过的那一级（工作区设置会盖过用户设置），都没设置过时写用户设置
        const inspected = config.inspect(key);
        const target =
          inspected?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : inspected?.workspaceValue !== undefined
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global;
        const cleared = value === null || value === '' || (key === 'fontSize' && value === 0);
        await config.update(key, cleared ? undefined : value, target);
      }
    },
    onModelChange: (label) => {
      modelLabel = label;
      renderStatusBar(status, currentStatus(), modelLabel);
    },
  });
  controller = chat;
  context.subscriptions.push(workbench.register(() => chat.workspaceChanged()));

  const startIfTrusted = (): void => {
    if (!vscode.workspace.isTrusted) {
      output.info('工作区未受信任，不启动 dsh');
      chat.setRuntimeStatus(currentStatus());
      return;
    }
    void manager.start();
  };

  provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => void chat.handle(message),
    onViewVisible: startIfTrusted,
    log: log,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider));

  const disposers = [
    manager.onStatus((value) => {
      chat.setRuntimeStatus(currentStatus());
      renderStatusBar(status, value, modelLabel);
    }),
    // Host 每次就绪（包括重启后令牌变化）都重新连接
    manager.onEndpoint((endpoint) => dsh.setEndpoint(endpoint)),
    dsh.onClient((client) => chat.setClient(client)),
    dsh.onStatus((value) => chat.setConnectionStatus(value)),
  ];
  context.subscriptions.push({ dispose: () => disposers.forEach((dispose) => dispose()) });
  renderStatusBar(status, manager.currentStatus, modelLabel);

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openChat', focusView),
    vscode.commands.registerCommand('dsh.newSession', async () => {
      await focusView();
      await chat.handle({ type: 'newSession', payload: {} });
    }),
    vscode.commands.registerCommand('dsh.interrupt', () => chat.handle({ type: 'interrupt', payload: {} })),
    vscode.commands.registerCommand('dsh.selectModel', async () => {
      const models = chat.modelState();
      if (models.options.length === 0) {
        void vscode.window.showInformationMessage(t('ext.noModels'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.options.flatMap((option) =>
          (option.efforts.length > 1 ? option.efforts : [undefined]).map((effort) => ({
            label: option.name,
            description: [option.group, effort?.name].filter(Boolean).join(' · '),
            detail: option.description,
            picked: option.provider === models.current?.provider && option.model === models.current?.model,
            option,
            effort: effort?.id ?? option.efforts[0]?.id,
          })),
        ),
        { placeHolder: t('ext.selectModel') },
      );
      if (picked) {
        await chat.handle({
          type: 'selectModel',
          payload: { provider: picked.option.provider, model: picked.option.model, ...(picked.effort ? { reasoningEffort: picked.effort } : {}) },
        });
      }
    }),
    vscode.commands.registerCommand('dsh.explainSelection', async () => {
      // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
      const sending = chat.askAboutSelection('explain');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand('dsh.fixSelection', async () => {
      // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
      const sending = chat.askAboutSelection('fix');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand('dsh.testSelection', async () => {
      // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
      const sending = chat.askAboutSelection('test');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand('dsh.addToChat', async () => {
      chat.pinActiveEditor();
      await focusView();
    }),
    vscode.commands.registerCommand('dsh.configureApiKey', () => chat.configureApiKey()),
    vscode.commands.registerCommand('dsh.renameSession', () => chat.renameSession()),
    vscode.commands.registerCommand('dsh.selectFolder', async () => {
      const list = folders();
      if (list.length < 2) {
        void vscode.window.showInformationMessage(t('ext.singleFolder'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f.uri.fsPath === workspacePath, folder: f })),
        { placeHolder: t('ext.selectFolder') },
      );
      if (!picked || picked.folder.uri.fsPath === workspacePath) return;
      workspacePath = picked.folder.uri.fsPath;
      await context.workspaceState.update(FOLDER_KEY, workspacePath);
      chat.setWorkspace(workspacePath);
    }),
    vscode.commands.registerCommand('dsh.restartRuntime', () => manager.restart()),
    vscode.commands.registerCommand('dsh.openWebUI', () => chat.handle({ type: 'openWebUI', payload: {} })),
    vscode.commands.registerCommand('dsh.showLogs', () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(startIfTrusted),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh.runtime')) output.info('dsh 运行时设置已修改，执行「DSH：重启 dsh」后生效');
      if (event.affectsConfiguration('dsh.context')) chat.workspaceChanged();
      if (event.affectsConfiguration('dsh.ui.fontSize') || event.affectsConfiguration('dsh.ui.fontFamily') || event.affectsConfiguration('dsh.ui.codeFontFamily')) {
        chat.appearanceChanged();
      }
      if (event.affectsConfiguration('dsh.ui.showTurnChanges')) chat.workspaceChanged();
      if (event.affectsConfiguration('dsh.ui.language')) {
        applyLocale();
        chat.localeChanged();
        renderStatusBar(status, manager.currentStatus, modelLabel);
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  controller?.dispose();
  connection?.dispose();
  await runtime?.stop();
}

/** 界面字号和字体；0 或空字符串表示跟随 VS Code。 */
function readAppearance(): AppearanceState {
  const config = vscode.workspace.getConfiguration('dsh.ui');
  const size = config.get<number>('fontSize', 0);
  const family = config.get<string>('fontFamily', '').trim();
  const code = config.get<string>('codeFontFamily', '').trim();
  return {
    ...(Number.isFinite(size) && size > 0 ? { fontSize: Math.min(32, Math.max(8, Math.round(size))) } : {}),
    ...(family ? { fontFamily: family } : {}),
    ...(code ? { codeFontFamily: code } : {}),
  };
}

/** 让 VS Code 为 dsh 的地址转发端口（本地时原样返回），只返回 origin 部分。 */
async function externalOrigin(base: string): Promise<string> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(base));
  return external.with({ path: '', query: '', fragment: '' }).toString(true);
}

function readRuntimeConfig(workspacePath: string): RuntimeConfig {
  const config = vscode.workspace.getConfiguration('dsh.runtime');
  const env: Record<string, string | undefined> = { ...process.env };
  // 把 VS Code 的代理设置传给 dsh（模型请求由 dsh 自己发出）
  const proxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (proxy) {
    env.HTTPS_PROXY ??= proxy;
    env.HTTP_PROXY ??= proxy;
  }
  return {
    configuredPath: config.get<string>('path', ''),
    profile: config.get<string>('profile', 'web') || 'web',
    cwd: workspacePath,
    env,
  };
}

function renderStatusBar(item: vscode.StatusBarItem, status: RuntimeStatus, modelLabel: string | undefined): void {
  const text: Record<RuntimeStatus['kind'], string> = {
    idle: '$(circle-outline) DSH',
    locating: '$(loading~spin) DSH',
    starting: `$(loading~spin) ${t('status.starting')}`,
    connected: `$(check) DSH${modelLabel ? ` · ${modelLabel}` : ''}`,
    reconnecting: `$(loading~spin) ${t('status.reconnecting')}`,
    notInstalled: `$(warning) ${t('status.notInstalled')}`,
    unsupportedVersion: `$(warning) ${t('status.unsupported')}`,
    failed: '$(error) DSH',
    untrusted: '$(shield) DSH',
  };
  item.text = text[status.kind];
  item.tooltip = status.kind === 'connected' ? `dsh ${status.version}` : status.kind === 'failed' ? status.message : undefined;
  item.show();
}
