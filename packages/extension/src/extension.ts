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
    if (uri.scheme === 'http' || uri.scheme === 'https') void vscode.env.openExternal(uri);
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
    openWebUI: () => {
      const endpoint = manager.endpoint;
      if (!endpoint) {
        void vscode.window.showWarningMessage(t('ext.notStarted'));
        return;
      }
      // 启动令牌让浏览器完成一次认证，之后 dsh 用 Cookie 维持会话
      openExternal(`${endpoint.origin}/?token=${encodeURIComponent(endpoint.token)}`);
    },
    appearance: readAppearance,
    openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:izrio.dsh-copilot dsh.ui'),
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
