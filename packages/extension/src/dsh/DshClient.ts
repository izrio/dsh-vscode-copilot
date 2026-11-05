/**
 * dsh Remote API 客户端：组合 connect / unary / mux / $events，提供插件用到的方法。
 *
 * 方法名和参数名来自 dsh 0.2.1-rc.5 生成的 Typert 描述（`TYPERT_REMOTE`），
 * 实测记录见 docs/DSH-INTEGRATION.md 第 9 节。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectApiPeer, type ApiCredential, type FetchLike } from './remote/connect.ts';
import { RemoteEvents, type ReadyInfo } from './remote/events.ts';
import { followFrameSchema, wireEventSchema, type FollowFrame, type WireEvent } from './remote/follow.ts';
import { MuxClient } from './remote/mux.ts';
import { isMethodUnavailable, TransportError } from './remote/errors.ts';
import { UnaryClient } from './remote/unary.ts';

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  updatedAt: z.number(),
  running: z.boolean(),
  blank: z.boolean(),
  agentAvailable: z.boolean().optional(),
  cwd: z.string().optional(),
  parentSessionId: z.string().optional(),
  origin: z.string().optional(),
  projections: z.record(z.string(), z.unknown()).optional(),
});

export type SessionSummaryWire = z.infer<typeof sessionSummarySchema>;

const sessionListValue = z.object({ items: z.array(sessionSummarySchema) });
const workspaceCreateValue = z.object({
  workspace: z.object({ workspaceId: z.string(), path: z.string(), title: z.string() }),
  created: z.boolean(),
});
const sessionCreateValue = z.object({ sessionId: z.string(), agentPreset: z.string().optional() });
const acceptedValue = z.object({ accepted: z.literal(true) });
const historyPage = z.object({
  records: z.array(z.object({ type: z.literal('event'), event: wireEventSchema })),
  hasMore: z.boolean(),
});

export const modelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const modelCatalogSchema = z.object({
  default: modelSelectionSchema.partial().optional(),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          reasoning: z
            .object({
              efforts: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })),
              defaultEffort: z.string().optional(),
            })
            .optional(),
        }),
      ),
    }),
  ),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

/**
 * `session/control` 流：先给进程内所有已接入会话的投影基线，之后是投影更新。
 * 更新有两种格式：0.2.1-rc.5 是单个键 `{ sessionId, key, value, seq }`，
 * 0.2.2-alpha 起是一个事件引起的一批变化 `{ sessionId, seq, changes: [{ key, val }] }`。统一成批量格式。
 */
const controlFrameSchema = z.union([
  z.object({
    type: z.literal('baseline'),
    value: z.object({ projections: z.record(z.string(), z.unknown()) }),
  }),
  z
    .object({ type: z.literal('projection'), sessionId: z.string(), seq: z.number(), changes: z.array(z.object({ key: z.string(), val: z.unknown() })) })
    .transform((frame) => ({ ...frame, changes: frame.changes.map((change) => ({ key: change.key, value: change.val })) })),
  z
    .object({ type: z.literal('projection'), sessionId: z.string(), seq: z.number(), key: z.string(), value: z.unknown() })
    .transform((frame) => ({ type: frame.type, sessionId: frame.sessionId, seq: frame.seq, changes: [{ key: frame.key, value: frame.value }] })),
]);
export type ControlFrame = z.infer<typeof controlFrameSchema>;

const permissionCatalogSchema = z.object({
  options: z.array(z.object({ value: z.string(), name: z.string().optional() })),
  defaultPreset: z.string().optional(),
});
export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;

const commandResultSchema = z.object({
  commandId: z.string().optional(),
  result: z.object({ kind: z.string(), text: z.string().optional() }).loose(),
});
export type CommandResult = z.infer<typeof commandResultSchema>['result'];

const commandListSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    input: z.object({ hint: z.string().optional() }).loose().optional(),
  }),
);
export type DshCommand = z.infer<typeof commandListSchema>[number];

const fileReferencesSchema = z.array(z.object({ path: z.string(), kind: z.enum(['file', 'directory']) }));

/** `/api/changes.summary`：一轮里改动过的文件（包括命令造成的）。 */
const changesSummarySchema = z.object({
  turn: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      display: z.string().optional(),
      added: z.number().optional(),
      deleted: z.number().optional(),
      binary: z.boolean().optional(),
      oversized: z.boolean().optional(),
    }),
  ),
  total: z.number(),
});
export type ChangesSummary = z.infer<typeof changesSummarySchema>;

const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

/** `/api/changes.diff`：一轮里一个文件的改动。 */
const changesDiffSchema = z.union([
  z.object({
    kind: z.literal('text'),
    path: z.string(),
    before: z.boolean(),
    after: z.boolean(),
    hunks: z.array(hunkSchema),
  }),
  z.object({ kind: z.enum(['binary', 'oversized']), path: z.string() }).loose(),
]);
export type ChangesDiff = z.infer<typeof changesDiffSchema>;

/** 改动汇总只保存在 Host 内存里，Host 重启后返回 404。 */
export class ChangesUnavailableError extends Error {
  constructor() {
    super('本轮改动记录已不可用（dsh 重启过）');
    this.name = 'ChangesUnavailableError';
  }
}

export interface DshClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: FetchLike;
}

export class DshClient {
  /** `session/events`（0.2.2-alpha 起）是否可用；undefined 表示还没探测过。 */
  private eventsMethodAvailable: boolean | undefined;

  private constructor(
    readonly credential: ApiCredential,
    readonly unary: UnaryClient,
    readonly mux: MuxClient,
    readonly events: RemoteEvents,
    readonly ready: ReadyInfo,
    private readonly fetchImpl: FetchLike,
  ) {}

  /**
   * 建立连接：/connect → mux WebSocket → $events ready。
   * Peer 绑定在这条 WebSocket 上，它关闭后需要重新调用 connect。
   */
  static async connect(options: DshClientOptions): Promise<DshClient> {
    const log = options.log ?? (() => undefined);
    const credential = await connectApiPeer(options.origin, options.token, 'answer', options.fetchImpl);
    const unary = new UnaryClient({ origin: credential.origin, cookie: credential.cookie, fetchImpl: options.fetchImpl });
    const mux = new MuxClient(credential, log);
    await mux.connect();
    const events = new RemoteEvents(mux, unary, log);
    const ready = await events.start();
    return new DshClient(credential, unary, mux, events, ready, options.fetchImpl ?? ((input, init) => fetch(input, init)));
  }

  close(): void {
    this.mux.close();
  }

  async listSessions(signal?: AbortSignal): Promise<SessionSummaryWire[]> {
    const value = await this.unary.call('session/list', { _request: {} }, signal);
    return [...parse(sessionListValue, value, 'session/list').items];
  }

  /** 注册工作区目录；已注册过时返回原来的 Workspace。 */
  async ensureWorkspace(path: string): Promise<{ workspaceId: string; created: boolean }> {
    const value = parse(workspaceCreateValue, await this.unary.call('workspace/create', { request: { path } }), 'workspace/create');
    return { workspaceId: value.workspace.workspaceId, created: value.created };
  }

  async createSession(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<string> {
    const value = await this.unary.call('session/create', { request });
    return parse(sessionCreateValue, value, 'session/create').sessionId;
  }

  /**
   * 发送一条文本消息。`requestId` 由插件生成，重试时复用同一个可以避免重复插入。
   * @returns 本次请求的 requestId。
   */
  async prompt(sessionId: string, text: string, requestId: string = randomUUID()): Promise<string> {
    const value = await this.unary.call('session/prompt', {
      request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    });
    parse(acceptedValue, value, 'session/prompt');
    return requestId;
  }

  /**
   * 读取 `beforeSeq` 之前的一页历史，按轮次对齐。优先用 `session/events`，不可用时回退到 `session/page`。
   * 两者请求格式相同；0.2.1-rc.5 要求必须带 throughSeq。
   */
  async readHistory(sessionId: string, beforeSeq: number, throughSeq: number, signal?: AbortSignal): Promise<{ records: WireEvent[]; hasMore: boolean }> {
    const request = {
      address: { kind: 'session', sessionId },
      throughSeq,
      beforeSeq,
      turnWindow: { minMessages: 50, minTurns: 2 },
    };
    if (this.eventsMethodAvailable !== false) {
      try {
        const value = await this.unary.call('session/events', { request }, signal);
        this.eventsMethodAvailable = true;
        return toHistory(parse(historyPage, value, 'session/events'));
      } catch (error) {
        if (!isMethodUnavailable(error)) throw error;
        this.eventsMethodAvailable = false;
      }
    }
    return toHistory(parse(historyPage, await this.unary.call('session/page', { request }, signal), 'session/page'));
  }

  async modelCatalog(): Promise<ModelCatalog> {
    return parse(modelCatalogSchema, await this.unary.call('session/modelCatalog', {}), 'session/modelCatalog');
  }

  async selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const value = await this.unary.call('session/selectModel', { request: { sessionId, ...selection } });
    return parse(z.object({ selected: modelSelectionSchema }), value, 'session/selectModel').selected;
  }

  /**
   * 跟随 Host 级的会话控制流（投影基线 + 更新），用于标题、当前模型、上下文用量等实时信息。
   * 无法识别的帧跳过。
   */
  async *control(signal?: AbortSignal, log: (line: string) => void = () => undefined): AsyncGenerator<ControlFrame> {
    for await (const raw of this.mux.open('session/control', {}, signal)) {
      const parsed = controlFrameSchema.safeParse(raw);
      if (parsed.success) yield parsed.data;
      else log(`session/control：跳过无法识别的帧（${describeFrame(raw)}）`);
    }
  }

  /** 权限预设目录（read-only、workspace-write、danger-full-access 及用户自定义的）。 */
  async permissionCatalog(): Promise<PermissionCatalog> {
    return parse(permissionCatalogSchema, await this.unary.call('permissionPresets/catalog', {}), 'permissionPresets/catalog');
  }

  /** 会话可用的 dsh 斜杠命令（`/compact`、`/plan`、`/goal` 等）。 */
  async commands(sessionId: string): Promise<DshCommand[]> {
    return parse(commandListSchema, await this.unary.call('commands/list', { agentId: sessionId }), 'commands/list');
  }

  /**
   * `@` 引用的候选：会话工作目录下的文件和目录。
   * @param query - `@` 后面的路径文本；以 `/` 结尾时列出目录内容。
   */
  async fileReferences(sessionId: string, query: string, signal?: AbortSignal): Promise<{ path: string; kind: 'file' | 'directory' }[]> {
    return parse(fileReferencesSchema, await this.unary.call('fileReferences/list', { agentId: sessionId, query }, signal), 'fileReferences/list');
  }

  /** 执行一条斜杠命令，例如 `/permission read-only`。 */
  async executeCommand(sessionId: string, line: string): Promise<CommandResult> {
    const value = await this.unary.call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] });
    return parse(commandResultSchema, value, 'commands/execute').result;
  }

  /**
   * 一轮的改动汇总。`seq` 是该轮 `workspace/changes` 事件的序号。
   * @throws ChangesUnavailableError Host 重启后汇总不再可用时。
   */
  async changesSummary(sessionId: string, seq: number): Promise<ChangesSummary> {
    return parse(changesSummarySchema, await this.getJson('/api/changes.summary', { sessionId, seq: String(seq) }), 'changes.summary');
  }

  /** 一轮里第 `index` 个文件的改动。 */
  async changesDiff(sessionId: string, seq: number, index: number): Promise<ChangesDiff> {
    return parse(changesDiffSchema, await this.getJson('/api/changes.diff', { sessionId, seq: String(seq), index: String(index) }), 'changes.diff');
  }

  private async getJson(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.credential.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method: 'GET', headers: { cookie: this.credential.cookie }, signal: AbortSignal.timeout(30_000) });
    } catch (cause) {
      throw new TransportError(`${path} 请求失败`, { cause });
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new ChangesUnavailableError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransportError(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  }

  /** 修改还在队列里的消息：编辑内容、删除，或插队（在当前回复的下一步送达）。 */
  async updateQueue(sessionId: string, itemId: string, action: { kind: 'edit'; text: string } | { kind: 'remove' } | { kind: 'steer' }): Promise<void> {
    const wire = action.kind === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: action.text }] } : action;
    parse(acceptedValue, await this.unary.call('session/updateQueue', { request: { sessionId, itemId, action: wire } }), 'session/updateQueue');
  }

  /** 重命名会话；返回 dsh 规范化后的标题。 */
  async rename(sessionId: string, title: string): Promise<string> {
    return parse(z.object({ title: z.string() }), await this.unary.call('session/rename', { request: { sessionId, title } }), 'session/rename').title;
  }

  /**
   * 保存一个凭据（例如 `DEEPSEEK_API_KEY`）到 dsh 的凭据存储。值只往 dsh 方向传，dsh 不会返回它。
   * 保存后立即生效，不需要重启。
   */
  async setCredential(ref: string, value: string): Promise<void> {
    await this.unary.call('credentials/set', { ref, value });
  }

  async cancel(sessionId: string): Promise<void> {
    parse(acceptedValue, await this.unary.call('session/cancel', { request: { sessionId } }), 'session/cancel');
  }

  /**
   * 跟随一个会话：先给开场快照，之后是增量。带 `assistantStream: true` 才有逐字流。
   * 无法识别的帧会跳过并记日志，不中断整个流。
   */
  async *follow(sessionId: string, signal?: AbortSignal, log: (line: string) => void = () => undefined): AsyncGenerator<FollowFrame> {
    // 与官方客户端相同的开场窗口：至少 50 条消息、跨过至少两轮（历史不够时给全部）
    const stream = this.mux.open(
      'session/follow',
      { request: { address: { kind: 'session', sessionId }, assistantStream: true, turnWindow: { minMessages: 50, minTurns: 2 } } },
      signal,
    );
    for await (const raw of stream) {
      const parsed = followFrameSchema.safeParse(raw);
      if (parsed.success) yield parsed.data;
      else log(`session/follow：跳过无法识别的帧（${describeFrame(raw)}）`);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, endpoint: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TransportError(`${endpoint}: 返回值格式不对：${result.error.issues[0]?.message ?? ''}`);
  return result.data;
}

function toHistory(page: z.infer<typeof historyPage>): { records: WireEvent[]; hasMore: boolean } {
  return { records: page.records.map((record) => record.event), hasMore: page.hasMore };
}

function describeFrame(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'type' in raw) return `type=${String((raw as { type: unknown }).type)}`;
  return typeof raw;
}
