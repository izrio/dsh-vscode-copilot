import type { WebviewToHost } from '@dsh-copilot/shared';

/** Webview 本地保存的状态（输入框草稿等），刷新和隐藏后仍在。 */
export interface PersistedState {
  readonly draft?: string;
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
