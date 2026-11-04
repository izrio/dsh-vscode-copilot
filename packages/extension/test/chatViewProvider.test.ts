import { describe, expect, it, vi } from 'vitest';
import type { HostToWebview, RuntimeStatus } from '@dsh-copilot/shared';

vi.mock('vscode', () => import('./fakes/vscode.ts'));

const { Uri } = await import('./fakes/vscode.ts');
const { ChatViewProvider } = await import('../src/webview/ChatViewProvider.ts');

function fakeView() {
  const posted: HostToWebview[] = [];
  let onMessage: ((raw: unknown) => void) | undefined;
  const webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'vscode-webview://csp',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: (message: HostToWebview) => {
      posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (listener: (raw: unknown) => void) => {
      onMessage = listener;
      return { dispose() {} };
    },
  };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) };
  return { view, posted, send: (raw: unknown) => onMessage?.(raw) };
}

describe('ChatViewProvider', () => {
  const status: RuntimeStatus = { kind: 'connected', version: '0.2.1-rc.5', newerThanTested: false };

  function setup() {
    const host = { runtimeStatus: () => status, onViewVisible: vi.fn(), restartRuntime: vi.fn(), showLogs: vi.fn(), log: vi.fn() };
    const provider = new ChatViewProvider(Uri.file('/ext') as never, host);
    const fake = fakeView();
    provider.resolveWebviewView(fake.view as never);
    return { provider, host, ...fake };
  }

  it('生成的 HTML 带严格 CSP，脚本只允许带 nonce 的本地资源', () => {
    const { view } = setup();
    const html = view.webview.html;
    const nonce = /nonce-([A-Za-z0-9+/=]+)/u.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script type="module" nonce="${nonce}" src="vscode-resource:/ext/dist/webview/index.js">`);
    expect(html).not.toContain('unsafe-inline');
  });

  it('视图打开时通知 Host 启动 dsh；收到 ready 后回完整快照', () => {
    const { host, posted, send } = setup();
    expect(host.onViewVisible).toHaveBeenCalledOnce();
    send({ type: 'ready', payload: {} });
    expect(posted).toEqual([{ type: 'snapshot', payload: { runtime: status } }]);
  });

  it('按钮消息转给 Host；格式不对的消息丢弃并记日志', () => {
    const { host, send, posted } = setup();
    send({ type: 'restartRuntime', payload: {} });
    send({ type: 'showLogs', payload: {} });
    send({ type: 'runCommand', payload: { command: 'rm -rf /' } });
    expect(host.restartRuntime).toHaveBeenCalledOnce();
    expect(host.showLogs).toHaveBeenCalledOnce();
    expect(host.log).toHaveBeenCalledWith('Webview：丢弃格式不对的消息');
    expect(posted).toEqual([]);
  });

  it('运行时状态变化推给 Webview', () => {
    const { provider, posted } = setup();
    provider.postRuntimeStatus({ kind: 'starting', version: '0.2.1-rc.5' });
    expect(posted).toEqual([{ type: 'runtimeStatus', payload: { kind: 'starting', version: '0.2.1-rc.5' } }]);
  });
});
