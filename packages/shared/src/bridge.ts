import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';

/**
 * Host ↔ Webview 消息。所有消息都是 `{ type, payload }`，收到后先用 schema 校验再处理。
 * M0 只包含启动握手和运行时状态，后续里程碑逐步扩充（见 docs/DESIGN.md 5.6）。
 */

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), payload: z.object({}) }),
  z.object({ type: z.literal('restartRuntime'), payload: z.object({}) }),
  z.object({ type: z.literal('showLogs'), payload: z.object({}) }),
]);

export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

export interface HostSnapshot {
  readonly runtime: RuntimeStatus;
}

export type HostToWebview =
  | { readonly type: 'snapshot'; readonly payload: HostSnapshot }
  | { readonly type: 'runtimeStatus'; readonly payload: RuntimeStatus };

/**
 * 解析来自 Webview 的消息；格式不对时返回 undefined，由调用方记录日志并丢弃。
 * @param value - `onDidReceiveMessage` 收到的原始值。
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  const parsed = webviewToHostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
