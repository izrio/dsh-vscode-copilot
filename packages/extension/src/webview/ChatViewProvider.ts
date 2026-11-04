/**
 * 侧边栏对话视图的宿主：生成带 CSP 的 HTML，加载 webview-ui 的构建产物，转发 Bridge 消息。
 *
 * Extension Host 是状态的唯一来源（docs/DESIGN.md D7）：Webview 加载后发 `ready`，
 * Host 回一份完整快照，之后只推增量。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostToWebview, type RuntimeStatus } from '@dsh-copilot/shared';

export interface ChatViewHost {
  readonly runtimeStatus: () => RuntimeStatus;
  readonly onViewVisible: () => void;
  readonly restartRuntime: () => void;
  readonly showLogs: () => void;
  readonly log: (line: string) => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'dsh.chatView';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: ChatViewHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    view.webview.html = renderHtml(view.webview, webviewRoot);
    view.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.host.onViewVisible();
  }

  postRuntimeStatus(status: RuntimeStatus): void {
    this.post({ type: 'runtimeStatus', payload: status });
  }

  private onMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.host.log('Webview：丢弃格式不对的消息');
      return;
    }
    switch (message.type) {
      case 'ready':
        this.post({ type: 'snapshot', payload: { runtime: this.host.runtimeStatus() } });
        return;
      case 'restartRuntime':
        this.host.restartRuntime();
        return;
      case 'showLogs':
        this.host.showLogs();
        return;
    }
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }
}

function renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
