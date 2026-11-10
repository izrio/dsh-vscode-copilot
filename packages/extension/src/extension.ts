/**
 * 插件入口：把运行时管理、连接、对话控制器和侧边栏视图串起来。
 *
 *   RuntimeManager ──endpoint──▶ DshConnection ──client──▶ ChatController ◀──messages──▶ ChatViewProvider
 */
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { RuntimeStatus } from '@dsh-copilot/shared';
import { DshConnection } from './dsh/DshConnection.ts';
import { RuntimeManager, type RuntimeConfig } from './runtime/RuntimeManager.ts';
import { ChatController } from './vm/ChatController.ts';
import type { TemplateName } from './vm/context.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';
import { getLocale, resolveLocale, setLocale, t } from './i18n.ts';
import { redactSecrets } from './util/redact.ts';

const ACTIVE_SESSION_KEY = 'dsh.activeSessionId';
const FOLDER_KEY = 'dsh.folder';
const SELECTION_COMMANDS: readonly [string, TemplateName][] = [
  ['dsh.explainSelection', 'explain'],
  ['dsh.fixSelection', 'fix'],
  ['dsh.testSelection', 'test'],
];

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

  // 多根工作区：用上次选择的文件夹，默认第一个；dsh 的会话按文件夹（dsh Workspace）分开。
  // 没有打开文件夹时不启动 dsh：否则工作目录只能是主目录，沙箱的可写范围和会话列表都会变成整个主目录。
  const folders = (): readonly vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const savedFolder = context.workspaceState.get<string>(FOLDER_KEY);
  let workspacePath: string | undefined = folders().find((f) => f.uri.fsPath === savedFolder)?.uri.fsPath ?? folders()[0]?.uri.fsPath;
  const sessionKey = () => (folders().length > 1 ? `${ACTIVE_SESSION_KEY}:${workspacePath}` : ACTIVE_SESSION_KEY);

  const manager = new RuntimeManager({
    getConfig: () => readRuntimeConfig(workspacePath ?? homedir()),
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
  let attention = 0;

  const currentStatus = (): RuntimeStatus => {
    if (!vscode.workspace.isTrusted) return { kind: 'untrusted' };
    if (!workspacePath) return { kind: 'noFolder' };
    return manager.currentStatus;
  };
  const refreshStatusBar = (): void => renderStatusBar(status, currentStatus(), modelLabel, attention);

  const openExternal = (url: string): void => {
    const uri = vscode.Uri.parse(url);
    if (uri.scheme === 'http' || uri.scheme === 'https') void vscode.env.openExternal(uri);
  };

  // 控制器和视图互相引用：控制器先创建，推送时视图可能还没注册
  // eslint-disable-next-line prefer-const
  let provider: ChatViewProvider | undefined;
  const workbench = new VscodeWorkbench(log);
  const chat = new ChatController({
    workbench,
    includeActiveEditor: () => vscode.workspace.getConfiguration('dsh.context').get<boolean>('includeActiveEditor', true),
    workspacePath: workspacePath ?? homedir(),
    post: (message) => provider?.post(message),
    log: log,
    loadActiveSessionId: () => context.workspaceState.get<string>(sessionKey()),
    saveActiveSessionId: (sessionId) => void context.workspaceState.update(sessionKey(), sessionId),
    folderLabel: () => (folders().length > 1 ? folders().find((f) => f.uri.fsPath === workspacePath)?.name : undefined),
    selectFolder: () => void vscode.commands.executeCommand('dsh.selectFolder'),
    openExternal,
    restartRuntime: () => void restartIfReady(),
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
    openSettings: (query) => void vscode.commands.executeCommand('workbench.action.openSettings', query === 'dsh' ? '@ext:izrio.dsh-copilot' : query),
    manageTrust: () => void vscode.commands.executeCommand('workbench.trust.manage'),
    openFolder: () => void vscode.commands.executeCommand('vscode.openFolder'),
    onModelChange: (label) => {
      modelLabel = label;
      refreshStatusBar();
    },
    onAttentionChange: (count) => {
      attention = count;
      provider?.setBadge(count);
      refreshStatusBar();
    },
  });
  controller = chat;
  context.subscriptions.push(workbench.register(() => chat.workspaceChanged()));

  /** 视图打开过才启动 dsh（按需启动）；未受信任或没有文件夹时不启动。 */
  let viewOpened = false;
  const startIfReady = (): void => {
    if (!vscode.workspace.isTrusted || !workspacePath) {
      chat.setRuntimeStatus(currentStatus());
      refreshStatusBar();
      return;
    }
    if (viewOpened) void manager.start();
  };
  const restartIfReady = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted || !workspacePath) {
      startIfReady();
      return;
    }
    await manager.restart();
  };

  provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => void chat.handle(message),
    onViewVisible: () => {
      viewOpened = true;
      startIfReady();
    },
    locale: getLocale,
    log: log,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider));

  const disposers = [
    manager.onStatus(() => {
      chat.setRuntimeStatus(currentStatus());
      refreshStatusBar();
    }),
    // Host 每次就绪（包括重启后令牌变化）都重新连接
    manager.onEndpoint((endpoint) => dsh.setEndpoint(endpoint)),
    dsh.onClient((client) => chat.setClient(client)),
    dsh.onStatus((value) => chat.setConnectionStatus(value)),
  ];
  context.subscriptions.push({ dispose: () => disposers.forEach((dispose) => dispose()) });
  chat.setRuntimeStatus(currentStatus());
  refreshStatusBar();

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
    ...SELECTION_COMMANDS.map(([id, template]) =>
      vscode.commands.registerCommand(id, async () => {
        // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
        const sending = chat.askAboutSelection(template);
        await focusView();
        await sending;
      }),
    ),
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
      await useFolder(picked.folder.uri.fsPath);
    }),
    vscode.commands.registerCommand('dsh.restartRuntime', restartIfReady),
    vscode.commands.registerCommand('dsh.openWebUI', () => chat.handle({ type: 'openWebUI', payload: {} })),
    vscode.commands.registerCommand('dsh.showLogs', () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(startIfReady),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void foldersChanged()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh.runtime')) output.info('dsh 运行时设置已修改，执行「DSH：重启 dsh」后生效');
      if (event.affectsConfiguration('dsh.context')) chat.workspaceChanged();
      if (event.affectsConfiguration('dsh.ui.language')) {
        applyLocale();
        chat.localeChanged();
        refreshStatusBar();
      }
    }),
  );

  async function useFolder(path: string): Promise<void> {
    workspacePath = path;
    await context.workspaceState.update(FOLDER_KEY, path);
    chat.setWorkspace(path);
  }

  /** 工作区文件夹增删：当前文件夹被移除时换到剩下的第一个；全部移除时停止 dsh。 */
  async function foldersChanged(): Promise<void> {
    const list = folders();
    if (list.length === 0) {
      workspacePath = undefined;
      await manager.stop();
      chat.setRuntimeStatus(currentStatus());
      refreshStatusBar();
      return;
    }
    const hadFolder = workspacePath !== undefined;
    if (!list.some((f) => f.uri.fsPath === workspacePath)) await useFolder(list[0]!.uri.fsPath);
    chat.workspaceChanged();
    if (!hadFolder) startIfReady();
  }
}

export async function deactivate(): Promise<void> {
  controller?.dispose();
  connection?.dispose();
  await runtime?.stop();
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

function renderStatusBar(item: vscode.StatusBarItem, status: RuntimeStatus, modelLabel: string | undefined, attention: number): void {
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
    noFolder: '$(folder) DSH',
  };
  // 有审批或提问在等待时，状态栏换成提醒（视图可能被收起来了）
  item.text = attention > 0 ? `$(bell-dot) ${t('status.attention', attention)}` : text[status.kind];
  item.backgroundColor = attention > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.tooltip = status.kind === 'connected' ? `dsh ${status.version}` : status.kind === 'failed' ? status.message : undefined;
  item.show();
}
