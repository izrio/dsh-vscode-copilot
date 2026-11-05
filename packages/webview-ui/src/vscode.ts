import type { WebviewToHost } from '@dsh-copilot/shared';

/** Webview 本地保存的状态（输入框草稿等），刷新和隐藏后仍在。 */
export interface PersistedState {
  readonly draft?: string;
  /** 其他标签的草稿，键是标签的 key。 */
  readonly drafts?: Readonly<Record<string, string>>;
  /** 用户拖动设定的输入框高度（px）；没有时随内容自动增高。 */
  readonly inputHeight?: number | undefined;
  /** 会话改动栏是否展开。 */
  readonly changesOpen?: boolean;
  /** 被隐藏时的会话改动签名；改动变化后重新显示。 */
  readonly changesDismissed?: string;
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
