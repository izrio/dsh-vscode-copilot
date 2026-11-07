/**
 * 插件入口：管理底层（内置的 dsh，或设置里配置的 ACP 代理），把当前底层的控制器接到侧边栏视图和命令上。
 *
 *   底层（dsh：RuntimeManager → DshConnection → ChatController；ACP：AcpProcess → AcpController）◀──messages──▶ ChatViewProvider
 *
 * 同一时间只运行一个底层。切换底层时停掉旧的、启动新的，Webview 重新取快照；每个底层的会话和标签分开保存。
 */
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { AppearanceState, BackendsState, RuntimeStatus } from '@dsh-copilot/shared';
import { createAcpBackend } from './backend/acp.ts';
import { createDshBackend, type BackendHost } from './backend/dsh.ts';
import { DSH_PROFILE, builtinProfiles, parseProfiles, profileView } from './backend/profiles.ts';
import type { BackendProfile, RunningBackend } from './backend/types.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';
import { resolveLocale, setLocale, t } from './i18n.ts';
import { redactSecrets } from './util/redact.ts';
import { command, migrateSettings, SECTION, settings } from './settings.ts';

const FOLDER_KEY = 'dsh.folder';
const BACKEND_KEY = 'dsh.backend';

let active: RunningBackend | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const applyLocale = (): void =>
    setLocale(resolveLocale(vscode.env.language, settings('ui').get<string>('language', 'auto')));
  applyLocale();
  // 旧版本（DSH Copilot）的设置搬到 harnessDeck.* 下
  void migrateSettings().then((moved) => moved.length && log(`已迁移旧设置：${moved.join(', ')}`));
  const output = vscode.window.createOutputChannel('Harness Deck', { log: true });
  // 所有日志都先脱敏：错误信息里可能带着底层回显的令牌或 API Key
  const log = (line: string): void => output.info(redactSecrets(line));
  const runtimeOutput = vscode.window.createOutputChannel('Harness Deck: Backend', { log: true });
  context.subscriptions.push(output, runtimeOutput);

  // 多根工作区：用上次选择的文件夹，默认第一个；会话按文件夹分开
  const folders = (): readonly vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const savedFolder = context.workspaceState.get<string>(FOLDER_KEY);
  let workspacePath = folders().find((f) => f.uri.fsPath === savedFolder)?.uri.fsPath ?? folders()[0]?.uri.fsPath ?? homedir();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = command('openChat');
  context.subscriptions.push(status);
  let modelLabel: string | undefined;

  const openExternal = (url: string): void => {
    const uri = vscode.Uri.parse(url);
    // 传原字符串：Uri.toString() 会把查询里的 = 等字符编码掉，链接带参数时打开的地址就不对了
    if (uri.scheme === 'http' || uri.scheme === 'https') void vscode.env.openExternal(url as unknown as vscode.Uri);
  };

  // ---- 底层列表与切换 ----
  const profiles = (): BackendProfile[] =>
    parseProfiles(settings().get<unknown>('backends', []), log, builtinProfiles((id) => t(id === 'codebuddy' ? 'acp.codebuddyHint' : 'acp.ompHint')));
  const backendsState = (): BackendsState => ({ items: profiles().map(profileView), active: active?.profile.id ?? DSH_PROFILE.id });
  const updateStatusBar = (): void => renderStatusBar(status, active, modelLabel);

  let provider: ChatViewProvider | undefined;
  const workbench = new VscodeWorkbench(log);

  const host: BackendHost = {
    context,
    log,
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(line) : runtimeOutput.info(line)),
    workspacePath: () => workspacePath,
    stateKey: (name) => (folders().length > 1 ? `${name}:${workspacePath}` : name),
    onStatus: () => updateStatusBar(),
    controllerOptions: () => ({
      workbench,
      includeActiveEditor: () => settings('context').get<boolean>('includeActiveEditor', true),
      post: (message) => provider?.post(message),
      log,
      folderLabel: () => (folders().length > 1 ? folders().find((f) => f.uri.fsPath === workspacePath)?.name : undefined),
      selectFolder: () => void vscode.commands.executeCommand(command('selectFolder')),
      openExternal,
      showLogs: () => output.show(),
      appearance: readAppearance,
      backends: backendsState,
      showTurnChanges: () => settings('ui').get<boolean>('showTurnChanges', false),
      openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
      setAppearance: async (patch) => {
        const config = settings('ui');
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
        updateStatusBar();
      },
    }),
  };

  const create = (profile: BackendProfile): RunningBackend => {
    if (profile.kind === 'dsh') return createDshBackend(profile, host);
    return createAcpBackend(profile, host);
  };

  /** 启动选中的底层（找不到时用 dsh）。视图已经打开时立即启动，并让 Webview 重新取快照。 */
  const activateBackend = (id: string): void => {
    const profile = profiles().find((p) => p.id === id) ?? DSH_PROFILE;
    try {
      active = create(profile);
    } catch (error) {
      log(`启动底层 ${profile.name} 失败：${error instanceof Error ? error.message : String(error)}`);
      active = create(DSH_PROFILE);
    }
    modelLabel = undefined;
    updateStatusBar();
    if (provider?.visible) {
      active.start();
      provider.post({ type: 'snapshot', payload: active.controller.snapshot() });
    }
  };

  const switchBackend = async (id: string): Promise<void> => {
    if (active?.profile.id === id) return;
    const previous = active;
    active = undefined;
    await context.workspaceState.update(BACKEND_KEY, id);
    await previous?.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
    activateBackend(id);
    log(`已切换到底层 ${(active as RunningBackend | undefined)?.profile.name ?? id}`);
  };

  activateBackend(context.workspaceState.get<string>(BACKEND_KEY) ?? DSH_PROFILE.id);
  const current = (): RunningBackend => active!;
  context.subscriptions.push(workbench.register(() => active?.controller.workspaceChanged()));

  const startIfTrusted = (): void => current().start();

  provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => {
      if (message.type === 'selectBackend') void switchBackend(message.payload.id);
      else void active?.controller.handle(message);
    },
    onViewVisible: startIfTrusted,
    log: log,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider));
  updateStatusBar();

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  context.subscriptions.push(
    vscode.commands.registerCommand(command('openChat'), focusView),
    vscode.commands.registerCommand(command('newSession'), async () => {
      await focusView();
      await current().controller.handle({ type: 'newSession', payload: {} });
    }),
    vscode.commands.registerCommand(command('interrupt'), () => current().controller.handle({ type: 'interrupt', payload: {} })),
    vscode.commands.registerCommand(command('selectBackend'), async () => {
      const picked = await vscode.window.showQuickPick(
        profiles().map((p) => ({ label: p.name, description: p.kind === 'dsh' ? 'dsh' : `ACP · ${p.command}`, picked: p.id === active?.profile.id, id: p.id })),
        { placeHolder: t('ext.selectBackend') },
      );
      if (picked) await switchBackend(picked.id);
    }),
    vscode.commands.registerCommand(command('selectModel'), async () => {
      const chat = current().controller;
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
    vscode.commands.registerCommand(command('explainSelection'), async () => {
      // 先同步取下选区（askAboutSelection 在第一个 await 之前读取当前编辑器），再切换焦点
      const sending = current().controller.askAboutSelection('explain');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('fixSelection'), async () => {
      const sending = current().controller.askAboutSelection('fix');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('testSelection'), async () => {
      const sending = current().controller.askAboutSelection('test');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('addToChat'), async () => {
      current().controller.pinActiveEditor();
      await focusView();
    }),
    vscode.commands.registerCommand(command('configureApiKey'), () => current().controller.configureApiKey()),
    vscode.commands.registerCommand(command('renameSession'), () => current().controller.renameSession()),
    vscode.commands.registerCommand(command('selectFolder'), async () => {
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
      current().controller.setWorkspace(workspacePath);
    }),
    vscode.commands.registerCommand(command('restartRuntime'), () => current().restart()),
    vscode.commands.registerCommand(command('openWebUI'), () => current().controller.handle({ type: 'openWebUI', payload: {} })),
    vscode.commands.registerCommand(command('showLogs'), () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(startIfTrusted),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const chat = current().controller;
      if (event.affectsConfiguration(`${SECTION}.dsh`)) output.info('dsh 运行时设置已修改，执行「Harness Deck：重启底层」后生效');
      if (event.affectsConfiguration(`${SECTION}.backends`)) {
        // 当前底层被删掉时回到 dsh；否则只刷新列表（命令和参数的修改在重启底层后生效）
        if (!profiles().some((p) => p.id === active?.profile.id)) void switchBackend(DSH_PROFILE.id);
        else chat.backendsChanged();
      }
      if (event.affectsConfiguration(`${SECTION}.context`)) chat.workspaceChanged();
      if (event.affectsConfiguration(`${SECTION}.ui.fontSize`) || event.affectsConfiguration(`${SECTION}.ui.fontFamily`) || event.affectsConfiguration(`${SECTION}.ui.codeFontFamily`)) {
        chat.appearanceChanged();
      }
      if (event.affectsConfiguration(`${SECTION}.ui.showTurnChanges`)) chat.workspaceChanged();
      if (event.affectsConfiguration(`${SECTION}.ui.language`)) {
        applyLocale();
        chat.localeChanged();
        updateStatusBar();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await active?.stop();
}

/** 界面字号和字体；0 或空字符串表示跟随 VS Code。 */
function readAppearance(): AppearanceState {
  const config = settings('ui');
  const size = config.get<number>('fontSize', 0);
  const family = config.get<string>('fontFamily', '').trim();
  const code = config.get<string>('codeFontFamily', '').trim();
  return {
    ...(Number.isFinite(size) && size > 0 ? { fontSize: Math.min(32, Math.max(8, Math.round(size))) } : {}),
    ...(family ? { fontFamily: family } : {}),
    ...(code ? { codeFontFamily: code } : {}),
  };
}

function renderStatusBar(item: vscode.StatusBarItem, backend: RunningBackend | undefined, modelLabel: string | undefined): void {
  const name = backend?.profile.name ?? 'dsh';
  const status: RuntimeStatus = backend?.currentStatus() ?? { kind: 'idle' };
  const text: Record<RuntimeStatus['kind'], string> = {
    idle: `$(circle-outline) ${name}`,
    locating: `$(loading~spin) ${name}`,
    starting: `$(loading~spin) ${t('status.starting', name)}`,
    connected: `$(check) ${name}${modelLabel ? ` · ${modelLabel}` : ''}`,
    reconnecting: `$(loading~spin) ${t('status.reconnecting', name)}`,
    notInstalled: `$(warning) ${t('status.notInstalled', name)}`,
    unsupportedVersion: `$(warning) ${t('status.unsupported', name)}`,
    failed: `$(error) ${name}`,
    untrusted: `$(shield) ${name}`,
  };
  item.text = text[status.kind];
  item.tooltip = status.kind === 'connected' ? `${name} ${status.version}` : status.kind === 'failed' ? status.message : undefined;
  item.show();
}
