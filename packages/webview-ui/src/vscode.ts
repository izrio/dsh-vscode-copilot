import type { WebviewToHost } from '@dsh-copilot/shared';

const api = acquireVsCodeApi();

/** 向 Extension Host 发消息。 */
export function postToHost(message: WebviewToHost): void {
  api.postMessage(message);
}
