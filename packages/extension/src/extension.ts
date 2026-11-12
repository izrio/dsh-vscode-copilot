/**
 * 插件入口：管理底层（内置的 dsh，或设置里配置的 ACP 代理），把当前底层的控制器接到侧边栏视图和命令上。
 *
 *   底层（dsh：RuntimeManager → DshConnection → ChatController；ACP：AcpProcess → AcpController）◀──messages──▶ ChatViewProvider
 *
 * 同一时间只运行一个底层。切换底层时停掉旧的、启动新的，Webview 重新取快照；每个底层的会话和标签分开保存。
 */
import { homedir } from 'node:os';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { AppearanceState, BackendsState, RuntimeStatus } from '@harness-deck/shared';
import { createAcpBackend } from './backend/acp.ts';
import { createDshBackend } from './backend/dsh.ts';
import { processEnvWithProxy, type BackendHost } from './backend/host.ts';
import { locateDsh, locateExecutable } from './runtime/locate.ts';
import { DSH_PROFILE, builtinProfiles, parseProfiles, profileView } from './backend/profiles.ts';
import type { BackendProfile, RunningBackend } from './backend/types.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';
import { getLocale, resolveLocale, setLocale, t } from './i18n.ts';
import { redactSecrets } from './util/redact.ts';
import { command, migrateSettings, SECTION, settings } from './settings.ts';

const FOLDER_KEY = 'harnessDeck.folder';
const BACKEND_KEY = 'harnessDeck.backend';
/** 改名前保存的键：读取时兼容，写入只写新键。 */
const LEGACY_FOLDER_KEY = 'dsh.folder';
const LEGACY_BACKEND_KEY = 'dsh.backend';
/** 内置 ACP 代理的安装和登录提示（Host 侧文案）。 */
const BUILTIN_HINTS = {
  'oh-my-pi': 'acp.ompHint',
  codebuddy: 'acp.codebuddyHint',
  claude: 'acp.claudeHint',
  'claude-sign-in': 'acp.claudeSignIn',
} as const;
/** 用户已经在选择卡片里选过底层（或跳过）：不再在第一次打开时询问。按用户记，不按工作区。 */
const CHOSEN_KEY = 'harnessDeck.backendChosen';

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
  // 旧版本没卸载时，右键菜单里还有「DSH」：提示卸载
  void offerUninstallOldExtension(log);
  const runtimeOutput = vscode.window.createOutputChannel('Harness Deck: Backend', { log: true });
  context.subscriptions.push(output, runtimeOutput);

  // 多根工作区：用上次选择的文件夹，默认第一个；会话按文件夹分开
  const folders = (): readonly vscode.WorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  const savedFolder = context.workspaceState.get<string>(FOLDER_KEY) ?? context.workspaceState.get<string>(LEGACY_FOLDER_KEY);
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
    parseProfiles(settings().get<unknown>('backends', []), log, builtinProfiles((id) => t(BUILTIN_HINTS[id])));
  /** 每个底层的命令在本机找不找得到（选择卡片显示「已安装」或安装命令）。 */
  const availability = new Map<string, boolean>();
  const savedBackend = (): string | undefined => context.workspaceState.get<string>(BACKEND_KEY) ?? context.workspaceState.get<string>(LEGACY_BACKEND_KEY);
  const needsChoice = (): boolean => !context.globalState.get<boolean>(CHOSEN_KEY) && savedBackend() === undefined;
  const backendsState = (): BackendsState => ({
    items: profiles().map((p) => profileView(p, availability.get(p.id))),
    active: active?.profile.id ?? DSH_PROFILE.id,
    ...(needsChoice() ? { needsChoice: true } : {}),
    workspace: folders().find((f) => f.uri.fsPath === workspacePath)?.name ?? basename(workspacePath),
  });
  let checking: Promise<void> | undefined;
  const checkAvailability = (): Promise<void> =>
    (checking ??= (async () => {
      const platform = process.platform;
      await Promise.all(
        profiles().map(async (p) => {
          const located =
            p.kind === 'dsh'
              ? await locateDsh({ configuredPath: settings('dsh').get<string>('path', ''), env: processEnvWithProxy(), platform })
              : await locateExecutable(p.command, { env: processEnvWithProxy(p.env), platform });
          availability.set(p.id, located.kind === 'found');
        }),
      );
      active?.controller.backendsChanged();
    })()
      .catch((error: unknown) => log(`检查底层是否安装失败：${String(error)}`))
      .finally(() => {
        checking = undefined;
      }));
  const markChosen = async (): Promise<void> => {
    if (context.globalState.get<boolean>(CHOSEN_KEY)) return;
    await context.globalState.update(CHOSEN_KEY, true);
  };
  const updateStatusBar = (): void => renderStatusBar(status, active, modelLabel);

  // 下面的回调在视图创建之前就要引用它，所以先声明、后赋值
  // eslint-disable-next-line prefer-const
  let provider: ChatViewProvider | undefined;
  const workbench = new VscodeWorkbench(log);

  const host: BackendHost = {
    context,
    log,
    // 底层的输出同样先脱敏：ACP 代理的 stderr 和排查日志（backendTrace）里可能带着令牌或 API Key
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(redactSecrets(line)) : runtimeOutput.info(redactSecrets(line))),
    workspacePath: () => workspacePath,
    stateKey: (name) => (folders().length > 1 ? `${name}:${workspacePath}` : name),
    onStatus: () => updateStatusBar(),
    controllerOptions: () => ({
      workbench,
      includeActiveEditor: () => settings('context').get<boolean>('includeActiveEditor', true),
      post: (message) => provider?.post(message),
      isVisible: () => provider?.visible ?? false,
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

  /**
   * 面板可见时启动当前底层。start 可以重复调用；已经失败过的不在这里自动重试（横幅里有「重试」）。
   * 面板每次重新显示（Webview 重新加载、发来 ready）都会走到这里：面板隐藏期间切换的底层在这时启动。
   */
  const startIfNeeded = (): void => {
    if (!active) return;
    const kind = active.currentStatus().kind;
    if (kind === 'idle' || kind === 'notInstalled' || kind === 'untrusted') active.start();
  };

  /** 换成选中的底层（找不到时用 dsh）。视图已经打开时立即启动，并让 Webview 重新取快照。 */
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

  /**
   * 切换底层。切换是串行的：上一次切换（停掉旧进程、启动新的）没做完时，后来的排在后面，
   * 否则两次切换交错，先启动的那个底层就没人去停了。
   */
  let switching: Promise<void> = Promise.resolve();
  const switchBackend = (id: string): Promise<void> => {
    const run = async (): Promise<void> => {
      if (active?.profile.id === id) return;
      const previous = active;
      active = undefined;
      await context.workspaceState.update(BACKEND_KEY, id);
      await previous?.stop().catch((error: unknown) => log(`停止底层失败：${String(error)}`));
      activateBackend(id);
      log(`已切换到底层 ${(active as RunningBackend | undefined)?.profile.name ?? id}`);
    };
    switching = switching.then(run, run);
    return switching;
  };

  activateBackend(savedBackend() ?? DSH_PROFILE.id);
  /** 当前底层；切换途中（旧的已停、新的还没建好）为 undefined，这时的命令不做任何事。 */
  const current = (): RunningBackend | undefined => active;
  context.subscriptions.push(workbench.register(() => active?.controller.workspaceChanged()));

  provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => {
      if (message.type === 'selectBackend' || message.type === 'dismissBackendChoice') {
        void (async () => {
          await markChosen();
          const id = message.type === 'selectBackend' ? message.payload.id : (active?.profile.id ?? DSH_PROFILE.id);
          if (id !== active?.profile.id) await switchBackend(id);
          else {
            // 选的就是当前底层：记住选择，收起卡片
            await context.workspaceState.update(BACKEND_KEY, id);
            active.controller.backendsChanged();
          }
        })();
        return;
      }
      // 面板每次打开都重新检查一遍（用户可能刚装好），并确保当前底层已经启动
      if (message.type === 'ready') {
        void checkAvailability();
        startIfNeeded();
      }
      void active?.controller.handle(message);
    },
    onViewVisible: startIfNeeded,
    locale: getLocale,
    log: log,
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider));
  updateStatusBar();

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  context.subscriptions.push(
    vscode.commands.registerCommand(command('openChat'), focusView),
    vscode.commands.registerCommand(command('newSession'), async () => {
      await focusView();
      await current()?.controller.handle({ type: 'newSession', payload: {} });
    }),
    vscode.commands.registerCommand(command('interrupt'), () => current()?.controller.handle({ type: 'interrupt', payload: {} })),
    vscode.commands.registerCommand(command('selectBackend'), async () => {
      const picked = await vscode.window.showQuickPick(
        profiles().map((p) => ({ label: p.name, description: p.kind === 'dsh' ? 'dsh' : `ACP · ${p.command}`, picked: p.id === active?.profile.id, id: p.id })),
        { placeHolder: t('ext.selectBackend') },
      );
      if (!picked) return;
      await markChosen();
      if (picked.id !== active?.profile.id) await switchBackend(picked.id);
      else {
        await context.workspaceState.update(BACKEND_KEY, picked.id);
        active.controller.backendsChanged();
      }
    }),
    vscode.commands.registerCommand(command('selectModel'), async () => {
      const chat = current()?.controller;
      if (!chat) return;
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
      const sending = current()?.controller.askAboutSelection('explain');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('fixSelection'), async () => {
      const sending = current()?.controller.askAboutSelection('fix');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('testSelection'), async () => {
      const sending = current()?.controller.askAboutSelection('test');
      await focusView();
      await sending;
    }),
    vscode.commands.registerCommand(command('addToChat'), async () => {
      current()?.controller.pinActiveEditor();
      await focusView();
    }),
    vscode.commands.registerCommand(command('configureApiKey'), () => current()?.controller.configureApiKey()),
    vscode.commands.registerCommand(command('renameSession'), () => current()?.controller.renameSession()),
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
      current()?.controller.setWorkspace(workspacePath);
      current()?.controller.backendsChanged();
    }),
    vscode.commands.registerCommand(command('restartRuntime'), () => current()?.restart()),
    vscode.commands.registerCommand(command('openWebUI'), () => current()?.controller.handle({ type: 'openWebUI', payload: {} })),
    vscode.commands.registerCommand(command('showLogs'), () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (provider?.visible) startIfNeeded();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const chat = current()?.controller;
      if (event.affectsConfiguration(`${SECTION}.dsh`)) output.info('dsh 运行时设置已修改，执行「Harness Deck：重启底层」后生效');
      if (event.affectsConfiguration(`${SECTION}.backends`)) {
        // 当前底层被删掉时回到 dsh；否则只刷新列表（命令和参数的修改在重启底层后生效）
        if (!profiles().some((p) => p.id === active?.profile.id)) void switchBackend(DSH_PROFILE.id);
        else chat?.backendsChanged();
        void checkAvailability();
      }
      if (event.affectsConfiguration(`${SECTION}.dsh.path`)) void checkAvailability();
      if (event.affectsConfiguration(`${SECTION}.context`)) chat?.workspaceChanged();
      if (event.affectsConfiguration(`${SECTION}.ui.fontSize`) || event.affectsConfiguration(`${SECTION}.ui.fontFamily`) || event.affectsConfiguration(`${SECTION}.ui.codeFontFamily`) || event.affectsConfiguration(`${SECTION}.ui.palette`)) {
        chat?.appearanceChanged();
      }
      if (event.affectsConfiguration(`${SECTION}.ui.showTurnChanges`)) chat?.workspaceChanged();
      if (event.affectsConfiguration(`${SECTION}.ui.language`)) {
        applyLocale();
        chat?.localeChanged();
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
  const palette = config.get<string>('palette', 'soft');
  return {
    ...(palette === 'theme' ? { palette: 'theme' as const } : {}),
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

/** 改名前的扩展。它和 Harness Deck 是两个扩展 id，没卸载时编辑器右键菜单里还有「DSH」，侧边栏里也多一个面板。 */
const OLD_EXTENSION_ID = 'izrio.dsh-copilot';

async function offerUninstallOldExtension(log: (line: string) => void): Promise<void> {
  if (!vscode.extensions.getExtension(OLD_EXTENSION_ID)) return;
  log(`旧版扩展 ${OLD_EXTENSION_ID} 还装着`);
  const uninstall = t('ext.oldUninstall');
  const choice = await vscode.window.showWarningMessage(t('ext.oldInstalled'), uninstall);
  if (choice !== uninstall) return;
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
  } catch (error) {
    log(`卸载旧版扩展失败：${error instanceof Error ? error.message : String(error)}`);
    void vscode.commands.executeCommand('workbench.extensions.search', OLD_EXTENSION_ID);
  }
}
