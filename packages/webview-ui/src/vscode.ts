import type { WebviewToHost } from '@harness-deck/shared';

/** Webview 本地保存的状态（输入框草稿等），刷新和隐藏后仍在。 */
export interface PersistedState {
  readonly draft?: string;
  /** 其他标签的草稿，键是标签的 key。 */
  readonly drafts?: Readonly<Record<string, string>>;
  /** 用户拖动设定的输入框高度（px）；没有时随内容自动增高。 */
  readonly inputHeight?: number | undefined;
  /** 会话改动栏是否展开（旧版本保存的；现在用 dockOpen）。 */
  readonly changesOpen?: boolean;
  /** 输入框上方状态栏里展开的那一项。 */
  readonly dockOpen?: 'todos' | 'changes' | undefined;
  /** 被隐藏时的会话改动签名；改动变化后重新显示。 */
  readonly changesDismissed?: string;
}

/** 第一次用到时才取（acquireVsCodeApi 每个页面只能调一次；测试里没有它）。 */
let cached: ReturnType<typeof acquireVsCodeApi<PersistedState>> | undefined;
const vscodeApi = () => (cached ??= acquireVsCodeApi<PersistedState>());

/** 向 Extension Host 发消息。 */
export function postToHost(message: WebviewToHost): void {
  vscodeApi().postMessage(message);
}

export function loadState(): PersistedState {
  return vscodeApi().getState() ?? {};
}

export function saveState(patch: Partial<PersistedState>): void {
  vscodeApi().setState({ ...loadState(), ...patch });
}
