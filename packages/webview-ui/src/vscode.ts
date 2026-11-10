import type { WebviewToHost } from '@dsh-copilot/shared';

/** Webview 本地保存的状态（输入框草稿等），刷新和隐藏后仍在。 */
export interface PersistedState {
  readonly draft?: string;
  /** 关掉过的提示（例如某个 dsh 版本的"版本较新"提示）。 */
  readonly dismissed?: readonly string[];
  /** 发送过的消息，输入框为空时按 ↑ 取回。最新的在最后。 */
  readonly history?: readonly string[];
}

const api = acquireVsCodeApi<PersistedState>();

/** 向 Extension Host 发消息。 */
export function postToHost(message: WebviewToHost): void {
  api.postMessage(message);
}

export function loadState(): PersistedState {
  return api.getState() ?? {};
}

export function saveState(patch: Partial<PersistedState>): void {
  api.setState({ ...loadState(), ...patch });
}
