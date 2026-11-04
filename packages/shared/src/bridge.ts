import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';
import type {
  CommandView,
  ConnectionState,
  ContextState,
  FileCandidate,
  Item,
  ModelState,
  PendingInteraction,
  PermissionState,
  SessionHeader,
  SessionListItem,
  WorkspaceState,
} from './viewModel.ts';

/**
 * Host ↔ Webview 消息。所有消息都是 `{ type, payload }`；Host 收到 Webview 消息后先用 schema 校验再处理。
 * 设计见 docs/DESIGN.md 5.6。
 */

const empty = z.object({});

const diffRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), callId: z.string().min(1) }),
  z.object({ kind: z.literal('turn'), seq: z.number().int().nonnegative(), index: z.number().int().nonnegative() }),
]);

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), payload: empty }),
  z.object({
    type: z.literal('sendMessage'),
    payload: z.object({
      text: z.string().min(1).max(200_000),
      /** 是否附带当前编辑器（输入框上方的标签被关掉时为 false）。 */
      includeActive: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('searchFiles'), payload: z.object({ requestId: z.number().int(), query: z.string().max(1_000) }) }),
  z.object({ type: z.literal('removeAttachment'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({ type: z.literal('interrupt'), payload: empty }),
  z.object({ type: z.literal('newSession'), payload: empty }),
  z.object({ type: z.literal('switchSession'), payload: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ type: z.literal('loadOlder'), payload: empty }),
  z.object({
    type: z.literal('selectModel'),
    payload: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }),
  }),
  z.object({ type: z.literal('retryPending'), payload: z.object({ requestId: z.string().min(1) }) }),
  z.object({ type: z.literal('discardPending'), payload: z.object({ requestId: z.string().min(1) }) }),
  z.object({ type: z.literal('openExternal'), payload: z.object({ url: z.string().url() }) }),
  z.object({ type: z.literal('restartRuntime'), payload: empty }),
  z.object({ type: z.literal('showLogs'), payload: empty }),
  z.object({ type: z.literal('openWebUI'), payload: empty }),
  z.object({ type: z.literal('respondApproval'), payload: z.object({ id: z.string().min(1), decision: z.enum(['allow', 'reject']) }) }),
  z.object({ type: z.literal('previewApproval'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    type: z.literal('answerQuestion'),
    payload: z.union([
      z.object({
        id: z.string().min(1),
        answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().max(20_000).optional() })),
      }),
      z.object({ id: z.string().min(1), cancelled: z.literal(true) }),
    ]),
  }),
  z.object({ type: z.literal('openDiff'), payload: z.object({ ref: diffRefSchema }) }),
  z.object({
    type: z.literal('openFile'),
    payload: z.object({ path: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
  }),
  z.object({ type: z.literal('selectPermission'), payload: z.object({ preset: z.string().min(1) }) }),
  z.object({ type: z.literal('saveAll'), payload: empty }),
]);

export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

export interface HostSnapshot {
  readonly runtime: RuntimeStatus;
  readonly connection: ConnectionState;
  readonly sessions: readonly SessionListItem[];
  readonly session: SessionHeader;
  readonly items: readonly Item[];
  readonly models: ModelState;
  readonly interactions: readonly PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly commands: readonly CommandView[];
}

/**
 * 条目增量。`sessionKey` 标识当前会话（新对话为空字符串），Webview 丢弃不属于当前会话的增量。
 * `reset` 为 true 时 `upsert` 是完整列表；否则按 `order` 排列，`upsert` 中的条目替换同 id 的旧条目。
 */
export interface ItemsPatch {
  readonly sessionKey: string;
  readonly reset: boolean;
  readonly order: readonly string[];
  readonly upsert: readonly Item[];
}

export type HostToWebview =
  | { readonly type: 'snapshot'; readonly payload: HostSnapshot }
  | { readonly type: 'runtimeStatus'; readonly payload: RuntimeStatus }
  | { readonly type: 'connection'; readonly payload: ConnectionState }
  | { readonly type: 'sessions'; readonly payload: readonly SessionListItem[] }
  | { readonly type: 'session'; readonly payload: SessionHeader }
  | { readonly type: 'items'; readonly payload: ItemsPatch }
  | { readonly type: 'models'; readonly payload: ModelState }
  | { readonly type: 'interactions'; readonly payload: readonly PendingInteraction[] }
  | { readonly type: 'permissions'; readonly payload: PermissionState }
  | { readonly type: 'workspace'; readonly payload: WorkspaceState }
  | { readonly type: 'context'; readonly payload: ContextState }
  | { readonly type: 'commands'; readonly payload: readonly CommandView[] }
  | { readonly type: 'fileCandidates'; readonly payload: { readonly requestId: number; readonly items: readonly FileCandidate[] } }
  | { readonly type: 'toast'; readonly payload: { readonly level: 'info' | 'error'; readonly text: string } }
  | { readonly type: 'focusComposer'; readonly payload: Record<string, never> };

/**
 * 解析来自 Webview 的消息；格式不对时返回 undefined，由调用方记录日志并丢弃。
 * @param value - `onDidReceiveMessage` 收到的原始值。
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  const parsed = webviewToHostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
