/**
 * 对话面板的控制器：把运行时状态、连接、会话服务、follow 流和投影串起来，推送给 Webview。
 *
 * Extension Host 是状态的唯一来源（docs/DESIGN.md D7）：Webview 加载后取一次快照，之后只收增量。
 * 推送按约 30ms 合并，流式输出时不会产生消息风暴。不依赖 vscode API，便于测试。
 */
import { isAbsolute, resolve } from 'node:path';
import type {
  ConnectionState,
  DiffRef,
  HostSnapshot,
  HostToWebview,
  Item,
  ModelOption,
  ModelState,
  PendingInteraction,
  PermissionState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  WebviewToHost,
  WorkspaceState,
} from '@dsh-copilot/shared';
import { ChangesUnavailableError, type ChangesSummary, type DshClient, type ModelSelection } from '../dsh/DshClient.ts';
import type { ConnectionStatus } from '../dsh/DshConnection.ts';
import { InteractionService, type Pending } from '../dsh/InteractionService.ts';
import { RemoteError } from '../dsh/remote/errors.ts';
import { SessionService } from '../dsh/SessionService.ts';
import { SessionStream } from '../dsh/session/SessionStream.ts';
import { displayPath, project, toolVariant, type ToolCallInfo } from './projector.ts';
import { noWorkbench, type Workbench } from './workbench.ts';

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
  /** 打开 Diff、未保存文件、确认框。 */
  readonly workbench?: Workbench;
  readonly renderDelayMs?: number;
}

const NEW_SESSION_TITLE = '新对话';
const DANGER_PRESET = 'danger-full-access';

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
  /** 新对话选择的权限预设，创建会话时应用。 */
  private draftPermission: string | undefined;
  private interactions: InteractionService | undefined;
  /** 每轮改动汇总的读取结果，键是 `sessionId:seq`。 */
  private readonly changes = new Map<string, ChangesSummary | 'unavailable' | 'loading'>();
  /** 当前会话最近一次投影里的工具调用，用于打开 Diff 和审批预览。 */
  private toolCalls: ReadonlyMap<string, ToolCallInfo> = new Map();
  /** 改动汇总来自哪个 Host；Host 重启（换了端口）后内存里的汇总都没了，要重新读取。 */
  private changesOrigin: string | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private serviceGeneration = 0;

  // 上次推送给 Webview 的内容，用来计算增量
  private sentSessionKey: string | undefined;
  private sentItems = new Map<string, string>();
  private sentOrder: readonly string[] = [];
  private sentJson = { sessions: '', session: '', models: '', interactions: '', permissions: '', workspace: '' };

  constructor(private readonly options: ChatControllerOptions) {
    this.activeId = options.loadActiveSessionId();
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.stream?.dispose();
    this.service?.dispose();
    this.interactions?.dispose();
  }

  /** 编辑器里文件的未保存状态变化时调用。 */
  workspaceChanged(): void {
    this.scheduleRender();
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
    // 挂起的审批和提问绑定在旧连接上，dsh 会在新连接上重新转发还在等待的请求
    this.interactions?.dispose();
    this.interactions = undefined;
    for (const [key, value] of this.changes) if (value === 'loading') this.changes.delete(key);
    this.scheduleRender();
    if (!client) return;
    this.interactions = new InteractionService(client, () => this.scheduleRender(), this.options.log);
    const origin = client.credential?.origin;
    if (origin !== this.changesOrigin) {
      this.changes.clear();
      this.changesOrigin = origin;
    }
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
    this.sentJson = {
      sessions: JSON.stringify(view.sessions),
      session: JSON.stringify(view.session),
      models: JSON.stringify(view.models),
      interactions: JSON.stringify(view.interactions),
      permissions: JSON.stringify(view.permissions),
      workspace: JSON.stringify(view.workspace),
    };
    return {
      runtime: this.runtime,
      connection: this.connection,
      sessions: view.sessions,
      session: view.session,
      items: view.items,
      models: view.models,
      interactions: view.interactions,
      permissions: view.permissions,
      workspace: view.workspace,
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
      case 'respondApproval':
        return this.respondApproval(message.payload.id, message.payload.decision === 'allow');
      case 'previewApproval':
        return this.previewApproval(message.payload.id);
      case 'answerQuestion': {
        const { id, ...answer } = message.payload;
        if (!this.interactions?.answerQuestion(id, 'cancelled' in answer ? { cancelled: true } : { answers: answer.answers })) {
          this.toast('info', '这个问题已经结束');
        }
        return;
      }
      case 'openDiff':
        return this.openDiff(message.payload.ref);
      case 'openFile':
        return this.workbench.openFile(this.absolute(message.payload.path));
      case 'selectPermission':
        return this.selectPermission(message.payload.preset);
      case 'saveAll':
        return this.workbench.saveAll();
    }
  }

  private respondApproval(id: string, allow: boolean): void {
    const pending = this.interactions?.get(id);
    if (!pending || pending.kind !== 'approval') {
      this.toast('info', '这个请求已经结束');
      return;
    }
    if (allow && this.approvalView(pending).dirtyFiles.length > 0) {
      // 编辑器里还有未保存的内容，dsh 写入后会和编辑器冲突
      this.toast('error', '要修改的文件有未保存的内容，请先保存');
      return;
    }
    this.interactions?.respondApproval(id, allow);
  }

  private async previewApproval(id: string): Promise<void> {
    const pending = this.interactions?.get(id);
    const call = pending?.kind === 'approval' && pending.request.callId ? this.toolCalls.get(pending.request.callId) : undefined;
    if (!call?.path) {
      this.toast('info', '没有可以预览的内容');
      return;
    }
    await this.workbench.openDiff({ kind: 'proposed', path: call.path, tool: call.tool, args: call.args });
  }

  private async openDiff(ref: DiffRef): Promise<void> {
    if (ref.kind === 'tool') {
      const call = this.toolCalls.get(ref.callId);
      if (!call?.path) {
        this.toast('info', '找不到这次修改的记录');
        return;
      }
      if (!call.created && !call.diffs?.length) return this.workbench.openFile(call.path);
      return this.workbench.openDiff({ kind: 'tool', path: call.path, diffs: call.diffs ?? [], created: call.created ?? false });
    }
    const sessionId = this.activeId;
    const client = this.service?.client;
    if (!sessionId || !client) return;
    try {
      const diff = await client.changesDiff(sessionId, ref.seq, ref.index);
      const path = this.absolute(diff.path);
      if (diff.kind !== 'text') {
        this.toast('info', diff.kind === 'binary' ? '二进制文件，无法显示 Diff' : '文件太大，无法显示 Diff');
        return this.workbench.openFile(path);
      }
      await this.workbench.openDiff({ kind: 'turn', path, before: diff.before, after: diff.after, hunks: diff.hunks });
    } catch (error) {
      if (error instanceof ChangesUnavailableError) {
        // 汇总已经不在 Host 内存里：卡片改为按文件工具汇总，那里的 Diff 来自会话日志
        this.changes.set(`${sessionId}:${ref.seq}`, 'unavailable');
        this.scheduleRender();
        this.toast('info', '这一轮的改动记录已不可用（dsh 重启过），已改为显示文件工具的修改');
      } else this.toast('error', `无法读取改动：${describe(error)}`);
    }
  }

  private async selectPermission(preset: string): Promise<void> {
    if (preset === DANGER_PRESET) {
      const ok = await this.workbench.confirm(
        '允许 dsh 完全访问？',
        'danger-full-access 下 dsh 执行命令和修改文件不再受工作区沙箱限制，可以访问整台机器。只在你信任当前任务时使用。',
        '允许完全访问',
      );
      if (!ok) return;
    }
    if (!this.activeId || !this.service) {
      this.draftPermission = preset;
      this.scheduleRender();
      return;
    }
    try {
      await this.service.setPermission(this.activeId, preset);
    } catch (error) {
      this.toast('error', `切换权限失败：${describe(error)}`);
    }
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.options.workspacePath, path);
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
        if (this.draftPermission && this.draftPermission !== service.permissions?.defaultPreset) {
          await service.setPermission(sessionId, this.draftPermission).catch((error: unknown) => {
            this.toast('error', `为新会话设置权限失败：${describe(error)}`);
          });
        }
        this.draftPermission = undefined;
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
    // 卡片放在条目之后推送：Webview 先有条目，再显示末尾的审批
    const interactionsJson = JSON.stringify(view.interactions);
    if (interactionsJson !== this.sentJson.interactions) {
      this.sentJson.interactions = interactionsJson;
      this.options.post({ type: 'interactions', payload: view.interactions });
    }
    const permissionsJson = JSON.stringify(view.permissions);
    if (permissionsJson !== this.sentJson.permissions) {
      this.sentJson.permissions = permissionsJson;
      this.options.post({ type: 'permissions', payload: view.permissions });
    }
    const workspaceJson = JSON.stringify(view.workspace);
    if (workspaceJson !== this.sentJson.workspace) {
      this.sentJson.workspace = workspaceJson;
      this.options.post({ type: 'workspace', payload: view.workspace });
    }
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

  private compute(): {
    sessionKey: string;
    sessions: SessionListItem[];
    session: SessionHeader;
    items: Item[];
    models: ModelState;
    interactions: PendingInteraction[];
    permissions: PermissionState;
    workspace: WorkspaceState;
  } {
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
      changes: (seq) => {
        const value = sessionId ? this.changes.get(`${sessionId}:${seq}`) : undefined;
        return value === 'loading' ? undefined : value;
      },
    });
    this.toolCalls = projection.toolCalls;
    if (sessionId && streamLive && !showingStale) this.loadChanges(sessionId, projection.changeSeqs);
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

    const attention = this.interactions?.sessionsNeedingAttention() ?? new Set<string>();
    const sessions: SessionListItem[] = (service?.sessions ?? []).map((s) => ({
      id: s.sessionId,
      title: titleOf(service?.projections(s.sessionId) ?? {}, []),
      updatedAt: s.updatedAt,
      running: s.sessionId === sessionId && streamLive ? running : s.running,
      ...(attention.has(s.sessionId) ? { needsAttention: true } : {}),
    }));

    const interactions = sessionId ? (this.interactions?.pendingFor(sessionId) ?? []).map((p) => this.interactionView(p)) : [];
    const catalog = service?.permissions;
    const currentPermission = sessionId
      ? (projections.permissions as { currentValue?: string } | undefined)?.currentValue
      : (this.draftPermission ?? catalog?.defaultPreset);
    const permissions: PermissionState = {
      options: catalog?.options.map((o) => o.value) ?? [],
      ...(currentPermission ? { current: currentPermission } : {}),
    };

    return {
      sessionKey: sessionId ?? '',
      sessions,
      session,
      items: projection.items,
      models: this.buildModelState(projections, service),
      interactions,
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
    };
  }

  /** 读取还没读过的改动汇总。Host 重启后汇总不再可用，记为 unavailable，投影退回按文件工具汇总。 */
  private loadChanges(sessionId: string, seqs: readonly number[]): void {
    const client = this.service?.client;
    if (!client) return;
    for (const seq of seqs) {
      const key = `${sessionId}:${seq}`;
      if (this.changes.has(key)) continue;
      this.changes.set(key, 'loading');
      void client.changesSummary(sessionId, seq).then(
        (summary) => this.changes.set(key, summary),
        (error: unknown) => {
          if (!(error instanceof ChangesUnavailableError)) this.options.log(`读取改动汇总失败：${describe(error)}`);
          this.changes.set(key, 'unavailable');
        },
      ).finally(() => this.scheduleRender());
    }
  }

  private interactionView(pending: Pending): PendingInteraction {
    if (pending.kind === 'approval') return this.approvalView(pending);
    return {
      kind: 'question',
      id: pending.id,
      questions: pending.request.questions.map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        ...(q.detail ? { detail: q.detail } : {}),
        options: q.options ?? [],
        multiSelect: q.multiSelect ?? q.multi_select ?? false,
      })),
    };
  }

  /** 审批卡片：从会话日志里找到对应的工具调用，显示要执行的命令或要修改的文件。 */
  private approvalView(pending: Extract<Pending, { kind: 'approval' }>): Extract<PendingInteraction, { kind: 'approval' }> {
    const request = pending.request;
    const call = request.callId ? this.toolCalls.get(request.callId) : undefined;
    const tool = call?.tool ?? request.toolName;
    const variant = toolVariant(tool);
    const display = request.displayReason;
    const reason = display?.zh ?? display?.['zh-CN'] ?? request.reason ?? display?.en ?? '';
    const command = call && variant === 'command' ? (call.args.command ?? call.args.cmd) : undefined;
    const path = call?.path;
    let subject: { subject: string; subjectKind: 'command' | 'file' } | undefined;
    if (typeof command === 'string' && command.trim()) subject = { subject: command.trim(), subjectKind: 'command' };
    else if (path) subject = { subject: displayPath(path, this.options.workspacePath), subjectKind: 'file' };
    const dirty = path && variant === 'edit' && this.workbench.dirtyFiles().includes(path) ? [displayPath(path, this.options.workspacePath)] : [];
    return {
      kind: 'approval',
      id: pending.id,
      toolName: tool,
      reason,
      ...(subject ?? {}),
      previewable: Boolean(path && (tool === 'edit' || tool === 'write')),
      dirtyFiles: dirty,
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
