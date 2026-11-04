/**
 * 插件入口。M0：注册侧边栏视图、启动 dsh、建立 Remote 连接、在界面上显示运行时状态。
 */
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { RuntimeStatus } from '@dsh-copilot/shared';
import { DshClient } from './dsh/DshClient.ts';
import { RuntimeManager, type RuntimeConfig } from './runtime/RuntimeManager.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';

let runtime: RuntimeManager | undefined;
let client: DshClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DSH', { log: true });
  const runtimeOutput = vscode.window.createOutputChannel('DSH Runtime', { log: true });
  context.subscriptions.push(output, runtimeOutput);

  const manager = new RuntimeManager({
    getConfig: readRuntimeConfig,
    log: (line) => output.info(line),
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(line) : runtimeOutput.info(line)),
  });
  runtime = manager;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dsh.openChat';
  context.subscriptions.push(status);

  const currentStatus = (): RuntimeStatus => (vscode.workspace.isTrusted ? manager.currentStatus : { kind: 'untrusted' });

  const startIfTrusted = (): void => {
    if (!vscode.workspace.isTrusted) {
      output.info('工作区未受信任，不启动 dsh');
      provider.postRuntimeStatus(currentStatus());
      return;
    }
    void manager.start();
  };

  const provider = new ChatViewProvider(context.extensionUri, {
    runtimeStatus: currentStatus,
    onViewVisible: startIfTrusted,
    restartRuntime: () => void manager.restart(),
    showLogs: () => output.show(),
    log: (line) => output.info(line),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
  );

  const statusDisposer = manager.onStatus((value) => {
    provider.postRuntimeStatus(currentStatus());
    renderStatusBar(status, value);
  });
  context.subscriptions.push({ dispose: statusDisposer });
  renderStatusBar(status, manager.currentStatus);

  // Host 每次就绪（包括重启后，令牌会变）都重新建立 Remote 连接。
  // 代次号保证迟到的旧连接不会覆盖新连接。
  let generation = 0;
  const endpointDisposer = manager.onEndpoint((endpoint) => {
    const current = ++generation;
    client?.close();
    client = undefined;
    if (!endpoint) return;
    void DshClient.connect({ origin: endpoint.origin, token: endpoint.token, log: (line) => output.debug(line) }).then(
      async (connected) => {
        if (current !== generation) {
          connected.close();
          return;
        }
        client = connected;
        const sessions = await connected.listSessions();
        output.info(`已连接 dsh Remote API（clientId ${connected.ready.clientId}），已有会话 ${sessions.length} 个`);
      },
      (error: unknown) => output.error(`连接 dsh Remote API 失败：${error instanceof Error ? error.message : String(error)}`),
    );
  });
  context.subscriptions.push({ dispose: endpointDisposer });

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openChat', () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('dsh.restartRuntime', () => manager.restart()),
    vscode.commands.registerCommand('dsh.showLogs', () => output.show()),
    vscode.workspace.onDidGrantWorkspaceTrust(startIfTrusted),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh.runtime')) {
        output.info('dsh 运行时设置已修改，重启后生效');
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  client?.close();
  client = undefined;
  await runtime?.stop();
}

function readRuntimeConfig(): RuntimeConfig {
  const config = vscode.workspace.getConfiguration('dsh.runtime');
  const env: Record<string, string | undefined> = { ...process.env };
  // 把 VS Code 的代理设置传给 dsh（dsh 的模型请求由它自己发出）
  const proxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (proxy) {
    env.HTTPS_PROXY ??= proxy;
    env.HTTP_PROXY ??= proxy;
  }
  return {
    configuredPath: config.get<string>('path', ''),
    profile: config.get<string>('profile', 'web') || 'web',
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
    env,
  };
}

function renderStatusBar(item: vscode.StatusBarItem, status: RuntimeStatus): void {
  const text: Record<RuntimeStatus['kind'], string> = {
    idle: '$(circle-outline) DSH',
    locating: '$(loading~spin) DSH',
    starting: '$(loading~spin) DSH 启动中',
    connected: '$(check) DSH',
    reconnecting: '$(loading~spin) DSH 重连中',
    notInstalled: '$(warning) DSH 未安装',
    unsupportedVersion: '$(warning) DSH 版本过低',
    failed: '$(error) DSH',
    untrusted: '$(shield) DSH',
  };
  item.text = text[status.kind];
  item.tooltip = status.kind === 'connected' ? `dsh ${status.version}` : undefined;
  item.show();
}
