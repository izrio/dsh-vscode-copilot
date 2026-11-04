/**
 * 对话面板的控制器：把运行时状态、连接、会话服务、follow 流和投影串起来，推送给 Webview。
 *
 * Extension Host 是状态的唯一来源（docs/DESIGN.md D7）：Webview 加载后取一次快照，之后只收增量。
 * 推送按约 30ms 合并，流式输出时不会产生消息风暴。不依赖 vscode API，便于测试。
 */
import type {
  ConnectionState,
  HostSnapshot,
  HostToWebview,
  Item,
  ModelOption,
  ModelState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  WebviewToHost,
} from '@dsh-copilot/shared';
import type { DshClient, ModelSelection } from '../dsh/DshClient.ts';
import type { ConnectionStatus } from '../dsh/DshConnection.ts';
import { RemoteError } from '../dsh/remote/errors.ts';
import { SessionService } from '../dsh/SessionService.ts';
import { SessionStream } from '../dsh/session/SessionStream.ts';
import { project } from './projector.ts';

export interface ChatControllerOptions {
  readonly workspacePath: string;
  readonly post: (message: HostToWebview) => void;
  readonly log: (line: string) => void;
  /** 记住每个工作区上次打开的会话（VS Code workspaceState）。 */
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly openExternal: (url: string) => void;
  readonly restartRuntime: () => void;
  readonly showLogs: () => void;
  readonly openWebUI: () => void;
  /** 当前模型的显示名变化时调用（状态栏用）。 */
  readonly onModelChange?: (label: string | undefined) => void;
  readonly renderDelayMs?: number;
}

const NEW_SESSION_TITLE = '新对话';

export class ChatController {
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private service: SessionService | undefined;
  private stream: SessionStream | undefined;
  /**
   * 断线重连期间继续显示的旧数据：I/O 已经停止，只用于显示，
   * 新连接的会话服务初始化完成、follow 拿到快照后替换掉。
   */
  private staleService: SessionService | undefined;
  private staleStream: SessionStream | undefined;
  private activeId: string | undefined;
  private draftModel: ModelSelection | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private serviceGeneration = 0;

  // 上次推送给 Webview 的内容，用来计算增量
  private sentSessionKey: string | undefined;
  private sentItems = new Map<string, string>();
  private sentOrder: readonly string[] = [];
  private sentJson = { sessions: '', session: '', models: '' };

  constructor(private readonly options: ChatControllerOptions) {
    this.activeId = options.loadActiveSessionId();
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.stream?.dispose();
    this.service?.dispose();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.options.post({ type: 'runtimeStatus', payload: status });
  }

  setConnectionStatus(status: ConnectionStatus): void {
    const next: ConnectionState = status.kind;
    if (next === this.connection) return;
    this.connection = next;
    this.options.post({ type: 'connection', payload: next });
  }

  /** 连接建立（或重连）时传入新 client；断开时传 undefined。 */
  setClient(client: DshClient | undefined): void {
    const generation = ++this.serviceGeneration;
    if (this.stream) {
      this.stream.dispose();
      this.staleStream = this.stream;
    }
    if (this.service) {
      this.service.dispose();
      this.staleService = this.service;
    }
    this.stream = undefined;
    this.service = undefined;
    this.scheduleRender();
    if (!client) return;
    const service = new SessionService({
      client,
      workspacePath: this.options.workspacePath,
      onChange: () => this.scheduleRender(),
      log: this.options.log,
    });
    this.service = service;
    // 只校验初始化开始时就已打开的会话；初始化期间新建的会话不在刚读到的列表里，不能误判为已删除
    const restoredId = this.activeId;
    void service.init().then(
      () => {
        if (generation !== this.serviceGeneration) return;
        if (this.activeId !== restoredId) return;
        // 上次打开的会话已经不在列表里（被删除或不属于这个工作区）时，回到新对话
        if (restoredId && !service.sessions.some((s) => s.sessionId === restoredId)) {
          this.options.log(`上次打开的会话 ${restoredId} 已不存在，改为新对话`);
          this.setActive(undefined);
        } else {
          this.openStream();
        }
      },
      (error: unknown) => {
        if (generation !== this.serviceGeneration) return;
        this.options.log(`初始化会话服务失败：${describe(error)}`);
        this.toast('error', `无法读取 dsh 会话：${describe(error)}`);
      },
    );
  }

  /** Webview 加载（或重新加载）后取完整快照；之后的增量都相对于这份快照。 */
  snapshot(): HostSnapshot {
    const view = this.compute();
    this.sentSessionKey = view.sessionKey;
    this.sentItems = new Map(view.items.map((item) => [item.id, JSON.stringify(item)]));
    this.sentOrder = view.items.map((item) => item.id);
    this.sentJson = { sessions: JSON.stringify(view.sessions), session: JSON.stringify(view.session), models: JSON.stringify(view.models) };
    return {
      runtime: this.runtime,
      connection: this.connection,
      sessions: view.sessions,
      session: view.session,
      items: view.items,
      models: view.models,
    };
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage':
        return this.send(message.payload.text);
      case 'interrupt':
        return this.interrupt();
      case 'newSession':
        this.setActive(undefined);
        return;
      case 'switchSession':
        this.setActive(message.payload.sessionId);
        return;
      case 'loadOlder':
        await this.stream?.loadOlder();
        return;
      case 'selectModel':
        return this.selectModel(message.payload);
      case 'retryPending':
        return this.retryPending(message.payload.requestId);
      case 'discardPending':
        if (this.activeId) this.service?.discardPending(this.activeId, message.payload.requestId);
        return;
      case 'openExternal':
        this.options.openExternal(message.payload.url);
        return;
      case 'restartRuntime':
        this.options.restartRuntime();
        return;
      case 'showLogs':
        this.options.showLogs();
        return;
      case 'openWebUI':
        this.options.openWebUI();
        return;
    }
  }

  /** 新对话的第一条消息发送时才在 dsh 中创建会话，避免每次打开面板都留下空会话。 */
  async send(text: string): Promise<void> {
    const service = this.service;
    if (!service) {
      this.toast('error', 'dsh 尚未连接，请稍后再试');
      return;
    }
    let sessionId = this.activeId;
    try {
      if (!sessionId) {
        sessionId = await service.createSession();
        this.setActive(sessionId);
        if (this.draftModel) {
          await service.selectModel(sessionId, this.draftModel).catch((error: unknown) => {
            this.options.log(`为新会话设置模型失败：${describe(error)}`);
          });
          this.draftModel = undefined;
        }
      }
      await service.prompt(sessionId, text);
    } catch (error) {
      this.options.log(`发送失败：${describe(error)}`);
      this.toast('error', friendlyError(error));
    }
  }

  private async interrupt(): Promise<void> {
    if (!this.activeId || !this.service) return;
    try {
      await this.service.cancel(this.activeId);
    } catch (error) {
      // 会话已经空闲时 dsh 会拒绝取消，不需要打扰用户
      if (!(error instanceof RemoteError)) this.toast('error', `停止失败：${describe(error)}`);
      this.options.log(`停止失败：${describe(error)}`);
    }
  }

  private async selectModel(selection: ModelSelection): Promise<void> {
    if (!this.activeId || !this.service) {
      this.draftModel = selection;
      this.scheduleRender();
      return;
    }
    try {
      await this.service.selectModel(this.activeId, selection);
    } catch (error) {
      this.toast('error', `切换模型失败：${describe(error)}`);
    }
  }

  private async retryPending(requestId: string): Promise<void> {
    const sessionId = this.activeId;
    const service = this.service;
    const pending = sessionId ? service?.pending(sessionId).find((p) => p.requestId === requestId) : undefined;
    if (!sessionId || !service || !pending) return;
    try {
      // 复用同一个 requestId：dsh 对已接收的请求直接返回原结果，不会重复插入
      await service.prompt(sessionId, pending.text, requestId);
    } catch (error) {
      this.toast('error', friendlyError(error));
    }
  }

  private setActive(sessionId: string | undefined): void {
    if (sessionId === this.activeId && (sessionId === undefined || this.stream)) return;
    this.activeId = sessionId;
    // 换了会话就不再显示旧会话的残留内容
    if (this.staleStream?.sessionId !== sessionId) this.staleStream = undefined;
    this.options.saveActiveSessionId(sessionId);
    this.openStream();
  }

  private openStream(): void {
    this.stream?.dispose();
    this.stream = undefined;
    const service = this.service;
    const sessionId = this.activeId;
    if (service && sessionId) {
      const stream = new SessionStream({
        client: service.client,
        sessionId,
        onChange: () => this.scheduleRender(),
        onSnapshotProjections: (baseline) => service.acceptSnapshotProjections(sessionId, baseline),
        log: this.options.log,
      });
      this.stream = stream;
      stream.start();
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, this.options.renderDelayMs ?? 30);
  }

  /** 计算当前视图并推送变化的部分。 */
  render(): void {
    const view = this.compute();
    const sessionsJson = JSON.stringify(view.sessions);
    if (sessionsJson !== this.sentJson.sessions) {
      this.sentJson.sessions = sessionsJson;
      this.options.post({ type: 'sessions', payload: view.sessions });
    }
    const modelsJson = JSON.stringify(view.models);
    if (modelsJson !== this.sentJson.models) {
      this.sentJson.models = modelsJson;
      this.options.post({ type: 'models', payload: view.models });
      const current = view.models.current;
      const option = view.models.options.find((o) => o.provider === current?.provider && o.model === current?.model);
      this.options.onModelChange?.(option?.name ?? current?.model);
    }
    const sessionJson = JSON.stringify(view.session);
    if (sessionJson !== this.sentJson.session) {
      this.sentJson.session = sessionJson;
      this.options.post({ type: 'session', payload: view.session });
    }
    this.postItems(view.sessionKey, view.items);
  }

  private postItems(sessionKey: string, items: readonly Item[]): void {
    const reset = sessionKey !== this.sentSessionKey;
    const order = items.map((item) => item.id);
    const upsert: Item[] = [];
    const next = new Map<string, string>();
    for (const item of items) {
      const json = JSON.stringify(item);
      next.set(item.id, json);
      if (reset || this.sentItems.get(item.id) !== json) upsert.push(item);
    }
    const orderChanged = reset || order.length !== this.sentOrder.length || order.some((id, i) => id !== this.sentOrder[i]);
    this.sentSessionKey = sessionKey;
    this.sentItems = next;
    this.sentOrder = order;
    if (!reset && !orderChanged && upsert.length === 0) return;
    this.options.post({ type: 'items', payload: { sessionKey, reset, order, upsert } });
  }

  private compute(): { sessionKey: string; sessions: SessionListItem[]; session: SessionHeader; items: Item[]; models: ModelState } {
    // 新连接还没准备好时，先显示断线前的内容
    if (this.service?.initialized) this.staleService = undefined;
    if (this.stream?.status.kind === 'live') this.staleStream = undefined;
    const service = this.service?.initialized ? this.service : (this.staleService ?? this.service);
    const sessionId = this.activeId;
    const stream = this.stream?.status.kind !== 'live' && this.staleStream?.sessionId === sessionId ? this.staleStream : this.stream;
    const showingStale = stream !== undefined && stream === this.staleStream;
    const projections = sessionId && service ? service.projections(sessionId) : {};
    const summary = sessionId ? service?.sessions.find((s) => s.sessionId === sessionId) : undefined;

    const pending = sessionId && service ? service.pending(sessionId) : [];
    const streamLive = stream?.status.kind === 'live';
    const projection = project({
      events: stream?.journal.events ?? [],
      live: stream?.journal.live,
      pending,
      ...(streamLive ? {} : { fallbackRunning: summary?.running ?? false }),
      workspacePath: this.options.workspacePath,
    });
    if (sessionId && service && projection.persistedRequestIds.size > 0) {
      service.retirePending(sessionId, projection.persistedRequestIds);
    }

    const streamStatus = stream?.status;
    // follow 流就绪后以事件日志为准；会话列表里的 running 由通知触发刷新，会滞后
    const running = streamLive ? projection.turnOpen : projection.turnOpen || (summary?.running ?? false);
    const session: SessionHeader = {
      ...(sessionId ? { id: sessionId } : {}),
      title: sessionId ? titleOf(projections, projection.items) : NEW_SESSION_TITLE,
      running,
      hasOlder: stream?.journal.hasOlder ?? false,
      loadingOlder: stream?.loadingOlder ?? false,
      sync: !sessionId ? 'idle' : showingStale ? 'disconnected' : !streamStatus ? 'opening' : streamStatus.kind,
      ...(streamStatus?.kind === 'failed' ? { failure: streamStatus.message } : {}),
      ...contextUsageOf(projections),
    };

    const sessions: SessionListItem[] = (service?.sessions ?? []).map((s) => ({
      id: s.sessionId,
      title: titleOf(service?.projections(s.sessionId) ?? {}, []),
      updatedAt: s.updatedAt,
      running: s.sessionId === sessionId && streamLive ? running : s.running,
    }));

    return {
      sessionKey: sessionId ?? '',
      sessions,
      session,
      items: projection.items,
      models: this.buildModelState(projections, service),
    };
  }

  /** 当前会话可选的模型和当前选择（供命令面板的模型选择使用）。 */
  modelState(): ModelState {
    const projections = this.activeId && this.service ? this.service.projections(this.activeId) : {};
    return this.buildModelState(projections, this.service);
  }

  private buildModelState(projections: Readonly<Record<string, unknown>>, service: SessionService | undefined): ModelState {
    const catalog = service?.models;
    const options: ModelOption[] = [];
    for (const group of catalog?.groups ?? []) {
      for (const model of group.models) {
        options.push({
          provider: group.id,
          model: model.id,
          name: model.name,
          group: group.name,
          ...(model.description ? { description: model.description } : {}),
          efforts: model.reasoning?.efforts.map((e) => ({ id: e.id, name: e.name })) ?? [],
          ...(model.reasoning?.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}),
        });
      }
    }
    const selection = (projections.modelSelection as { next?: ModelSelection } | undefined)?.next;
    const current = selection ?? this.draftModel ?? (catalog?.default?.provider && catalog.default.model ? (catalog.default as ModelSelection) : undefined);
    return { options, ...(current ? { current: { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) } } : {}) };
  }

  private toast(level: 'info' | 'error', text: string): void {
    this.options.post({ type: 'toast', payload: { level, text } });
  }
}

function titleOf(projections: Readonly<Record<string, unknown>>, items: readonly Item[]): string {
  const title = typeof projections.title === 'string' ? plainTitle(projections.title) : '';
  if (title) return title;
  const outline = projections.turnOutline as { prompt?: string }[] | undefined;
  const prompt = plainTitle(outline?.[0]?.prompt ?? items.find((item) => item.kind === 'user')?.text ?? '');
  if (prompt) return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
  return NEW_SESSION_TITLE;
}

/** 标题只取第一行，去掉 Markdown 标题符号、强调符号和包裹的引号。 */
export function plainTitle(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line
    .replace(/^#{1,6}\s+/u, '')
    .replace(/[*_`]+/gu, '')
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/gu, '')
    .trim();
}

function contextUsageOf(projections: Readonly<Record<string, unknown>>): { contextUsage?: number } {
  const pressure = projections.contextPressure as { pressureTokens?: number; contextWindow?: number } | undefined;
  if (!pressure?.contextWindow || typeof pressure.pressureTokens !== 'number') return {};
  return { contextUsage: Math.min(1, Math.max(0, pressure.pressureTokens / pressure.contextWindow)) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把 dsh 的错误码翻译成用户能看懂、知道下一步怎么做的提示。 */
export function friendlyError(error: unknown): string {
  if (error instanceof RemoteError) {
    switch (error.code) {
      case 'session/writer-held':
        return '这个会话正在另一个窗口或 dsh Web UI 中使用。请在那边继续，或者新建一个对话。';
      case 'session/model-unavailable':
        return '所选模型当前不可用，请换一个模型。';
      case 'session/provider-credentials-unavailable':
      case 'session/provider-models-unavailable':
        return '还没有配置模型的 API Key。可以在「更多 → 在浏览器中打开 dsh」的模型页面填写。';
      case 'session/agent-busy':
        return 'dsh 正忙，请稍后再试。';
      default:
        return `发送失败：${error.message}`;
    }
  }
  return `发送失败：${describe(error)}`;
}
