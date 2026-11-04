import { describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '@dsh-copilot/shared';

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
  const view = { webview, visible: true, onDidDispose: () => ({ dispose() {} }) };
  return { view, posted, send: (raw: unknown) => onMessage?.(raw) };
}

describe('ChatViewProvider', () => {
  function setup() {
    const host = { onMessage: vi.fn(), onViewVisible: vi.fn(), log: vi.fn() };
    const provider = new ChatViewProvider(Uri.file('/ext') as never, host);
    const fake = fakeView();
    provider.resolveWebviewView(fake.view as never);
    return { provider, host, ...fake };
  }

  it('生成的 HTML 带严格 CSP：入口脚本带 nonce，其余脚本只允许插件目录', () => {
    const { view } = setup();
    const html = view.webview.html;
    const nonce = /nonce-([A-Za-z0-9+/=]+)/u.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}' vscode-webview://csp`);
    expect(html).toContain(`<script type="module" nonce="${nonce}" src="vscode-resource:/ext/dist/webview/index.js">`);
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
  });

  it('视图打开时通知 Host（按需启动 dsh）', () => {
    const { host } = setup();
    expect(host.onViewVisible).toHaveBeenCalledOnce();
  });

  it('校验通过的消息转给 Host；格式不对的丢弃并记日志', () => {
    const { host, send } = setup();
    send({ type: 'sendMessage', payload: { text: 'hi' } });
    send({ type: 'runCommand', payload: { command: 'rm -rf /' } });
    send({ type: 'sendMessage', payload: { text: '' } });
    expect(host.onMessage).toHaveBeenCalledTimes(1);
    expect(host.onMessage).toHaveBeenCalledWith({ type: 'sendMessage', payload: { text: 'hi' } });
    expect(host.log).toHaveBeenCalledTimes(2);
  });

  it('post 转发给 Webview', () => {
    const { provider, posted } = setup();
    provider.post({ type: 'runtimeStatus', payload: { kind: 'starting' } });
    expect(posted).toEqual([{ type: 'runtimeStatus', payload: { kind: 'starting' } }]);
  });
});
