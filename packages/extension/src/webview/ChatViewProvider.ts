/**
 * 侧边栏对话视图的宿主：生成带 CSP 的 HTML，加载 webview-ui 的构建产物，校验并转发 Bridge 消息。
 * 状态和业务逻辑都在 ChatController 里，这里只负责 Webview 的生命周期。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostToWebview, type WebviewToHost } from '@dsh-copilot/shared';

export interface ChatViewHost {
  /** 已校验的 Webview 消息。 */
  readonly onMessage: (message: WebviewToHost) => void;
  /** 视图第一次打开时调用（用于按需启动 dsh）。 */
  readonly onViewVisible: () => void;
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
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message) this.host.onMessage(message);
      else this.host.log('Webview：丢弃格式不对的消息');
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.host.onViewVisible();
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  /** 视图还没打开时丢弃消息：Webview 加载后会发 ready 取完整快照。 */
  post(message: HostToWebview): void {
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
    // 入口脚本带 nonce；代码高亮的语言包按需从插件目录加载
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
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
