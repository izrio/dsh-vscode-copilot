import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';
import type {
  AppearanceState,
  CommandView,
  Locale,
  ConnectionState,
  ContextState,
  FileCandidate,
  Item,
  ModelState,
  PendingInteraction,
  PermissionState,
  SessionHeader,
  SessionListItem,
  TabsState,
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
  z.object({ kind: z.literal('session'), path: z.string().min(1).max(4_096) }),
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
  z.object({
    type: z.literal('queueAction'),
    payload: z.discriminatedUnion('action', [
      z.object({ action: z.literal('edit'), itemId: z.string().min(1), text: z.string().min(1).max(200_000) }),
      z.object({ action: z.literal('remove'), itemId: z.string().min(1) }),
      z.object({ action: z.literal('steer'), itemId: z.string().min(1) }),
      /** 停止生成后留在队列里的消息：从队列取出，作为新消息立即发送。 */
      z.object({ action: z.literal('send'), itemId: z.string().min(1) }),
    ]),
  }),
  z.object({ type: z.literal('renameSession'), payload: empty }),
  z.object({ type: z.literal('configureApiKey'), payload: empty }),
  z.object({ type: z.literal('selectFolder'), payload: empty }),
  z.object({ type: z.literal('interrupt'), payload: empty }),
  /** 新建对话：打开一个新标签（已有空的新对话标签时切换过去），不覆盖当前会话。 */
  z.object({ type: z.literal('newSession'), payload: empty }),
  /** 打开会话：已经在某个标签里时切换过去，否则在新标签里打开。 */
  z.object({ type: z.literal('switchSession'), payload: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ type: z.literal('activateTab'), payload: z.object({ key: z.string().min(1) }) }),
  /** 关闭标签只是不再显示，会话仍在 dsh 里，可以从会话列表重新打开。 */
  z.object({ type: z.literal('closeTab'), payload: z.object({ key: z.string().min(1) }) }),
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
  /** `token` 由 Webview 生成，Host 打开（或放弃）后用 `diffOpened` 回传，Webview 据此结束加载状态。 */
  z.object({ type: z.literal('openDiff'), payload: z.object({ ref: diffRefSchema, token: z.number().int().optional() }) }),
  z.object({ type: z.literal('openSettings'), payload: empty }),
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
  readonly tabs: TabsState;
  readonly session: SessionHeader;
  readonly items: readonly Item[];
  readonly models: ModelState;
  readonly interactions: readonly PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly commands: readonly CommandView[];
  readonly locale: Locale;
  readonly appearance: AppearanceState;
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
  | { readonly type: 'tabs'; readonly payload: TabsState }
  | { readonly type: 'session'; readonly payload: SessionHeader }
  | { readonly type: 'items'; readonly payload: ItemsPatch }
  | { readonly type: 'models'; readonly payload: ModelState }
  | { readonly type: 'interactions'; readonly payload: readonly PendingInteraction[] }
  | { readonly type: 'permissions'; readonly payload: PermissionState }
  | { readonly type: 'workspace'; readonly payload: WorkspaceState }
  | { readonly type: 'context'; readonly payload: ContextState }
  | { readonly type: 'locale'; readonly payload: Locale }
  | { readonly type: 'appearance'; readonly payload: AppearanceState }
  | { readonly type: 'diffOpened'; readonly payload: { readonly token: number } }
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
