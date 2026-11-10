/**
 * Webview 代码在模块加载时调用 `acquireVsCodeApi()`。测试里换成内存实现，发出的消息记在 `hostMessages` 里。
 * 对其他包的测试没有影响（只是多了一个全局函数）。
 */
import type { WebviewToHost } from '@dsh-copilot/shared';

export const hostMessages: WebviewToHost[] = [];
let state: unknown;

(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: WebviewToHost) => void hostMessages.push(message),
  getState: () => state,
  setState: (next: unknown) => {
    state = next;
    return next;
  },
});

/** 清空发出的消息和保存的状态。 */
export function resetHost(): void {
  hostMessages.length = 0;
  state = undefined;
}
