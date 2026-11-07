/**
 * dsh 底层：RuntimeManager 启动 dsh，DshConnection 建立连接，ChatController 投影会话。
 *
 *   RuntimeManager ──endpoint──▶ DshConnection ──client──▶ ChatController ◀──messages──▶ Webview
 */
import * as vscode from 'vscode';
import type { RuntimeStatus } from '@harness-deck/shared';
import { DshConnection } from '../dsh/DshConnection.ts';
import { RuntimeManager, type RuntimeConfig } from '../runtime/RuntimeManager.ts';
import { ChatController, type ChatControllerOptions } from '../vm/ChatController.ts';
import { webUIUrl } from '../util/webUrl.ts';
import { t } from '../i18n.ts';
import { settings } from '../settings.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

/** 各种底层共用的、由 extension.ts 提供的能力。 */
export interface BackendHost {
  readonly context: vscode.ExtensionContext;
  readonly log: (line: string) => void;
  readonly runtimeLog: (line: string, stream: 'stdout' | 'stderr') => void;
  readonly workspacePath: () => string;
  /** 每种底层各自的 workspaceState 键（会话、标签不在底层之间混用）。 */
  readonly stateKey: (name: string) => string;
  /** 控制器的公共选项：Webview 推送、编辑器能力、外观、底层列表等。 */
  readonly controllerOptions: () => Omit<
    ChatControllerOptions,
    'workspacePath' | 'loadActiveSessionId' | 'saveActiveSessionId' | 'restartRuntime' | 'openWebUI' | 'loadOpenTabs' | 'saveOpenTabs'
  >;
  readonly onStatus: (status: RuntimeStatus) => void;
}

export function createDshBackend(profile: Extract<BackendProfile, { kind: 'dsh' }>, host: BackendHost): RunningBackend {
  const manager = new RuntimeManager({
    getConfig: () => readRuntimeConfig(host.workspacePath()),
    log: host.log,
    runtimeLog: host.runtimeLog,
  });
  const dsh = new DshConnection({ log: host.log });
  const state = host.context.workspaceState;
  const currentStatus = (): RuntimeStatus => (vscode.workspace.isTrusted ? manager.currentStatus : { kind: 'untrusted' });

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
    const url = await webUIUrl(endpoint.origin, endpoint.token, externalOrigin, host.log);
    host.log(`在浏览器中打开 dsh：${url.replace(/token=[^&]*/u, 'token=***')}`);
    // 传字符串而不是 Uri：Uri.toString() 会把查询里的 = 编码成 %3D，dsh 就认不出 token（认证失败）。
    // 扩展 API 的 openExternal 接受字符串并原样交给浏览器（VS Code 为这个问题专门保留的写法）。
    const opened = await vscode.env.openExternal(url as unknown as vscode.Uri);
    const copy = t('ext.copyLink');
    const message = !opened ? t('ext.webUIFailed') : sessionTitle ? t('ext.webUIOpenedSession', sessionTitle) : t('ext.webUIOpened');
    const choice = await (opened ? vscode.window.showInformationMessage(message, copy) : vscode.window.showWarningMessage(message, copy));
    if (choice === copy) await vscode.env.clipboard.writeText(url);
  };

  const chat = new ChatController({
    ...host.controllerOptions(),
    workspacePath: host.workspacePath(),
    loadActiveSessionId: () => state.get<string>(host.stateKey('dsh.activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(host.stateKey('dsh.activeSessionId'), sessionId),
    loadOpenTabs: () => state.get<string[]>(host.stateKey('dsh.openTabs')),
    saveOpenTabs: (ids) => void state.update(host.stateKey('dsh.openTabs'), [...ids]),
    restartRuntime: () => void manager.restart(),
    openWebUI: (sessionTitle) => void openWebUI(sessionTitle),
  });

  const disposers = [
    manager.onStatus(() => {
      chat.setRuntimeStatus(currentStatus());
      host.onStatus(currentStatus());
    }),
    // Host 每次就绪（包括重启后令牌变化）都重新连接
    manager.onEndpoint((endpoint) => dsh.setEndpoint(endpoint)),
    dsh.onClient((client) => chat.setClient(client)),
    dsh.onStatus((value) => chat.setConnectionStatus(value)),
  ];

  return {
    profile,
    controller: chat,
    start: () => {
      if (!vscode.workspace.isTrusted) {
        host.log('工作区未受信任，不启动 dsh');
        chat.setRuntimeStatus(currentStatus());
        host.onStatus(currentStatus());
        return;
      }
      void manager.start();
    },
    restart: () => void manager.restart(),
    currentStatus,
    stop: async () => {
      disposers.forEach((dispose) => dispose());
      chat.dispose();
      dsh.dispose();
      await manager.stop();
    },
  };
}

/** 让 VS Code 为 dsh 的地址转发端口（本地时原样返回），只返回 origin 部分。 */
async function externalOrigin(base: string): Promise<string> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(base));
  return external.with({ path: '', query: '', fragment: '' }).toString(true);
}

function readRuntimeConfig(workspacePath: string): RuntimeConfig {
  const config = settings('dsh');
  return {
    configuredPath: config.get<string>('path', ''),
    profile: config.get<string>('profile', 'web') || 'web',
    cwd: workspacePath,
    env: processEnvWithProxy(),
  };
}

/** 进程环境变量，加上 VS Code 的代理设置（模型请求由底层自己发出）。 */
export function processEnvWithProxy(extra: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  const proxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (proxy) {
    env.HTTPS_PROXY ??= proxy;
    env.HTTP_PROXY ??= proxy;
  }
  return env;
}
