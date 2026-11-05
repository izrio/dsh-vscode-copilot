/**
 * 对话面板的控制器：把运行时状态、连接、会话服务、follow 流和投影串起来，推送给 Webview。
 *
 * Extension Host 是状态的唯一来源（docs/DESIGN.md D7）：Webview 加载后取一次快照，之后只收增量。
 * 推送按约 30ms 合并，流式输出时不会产生消息风暴。不依赖 vscode API，便于测试。
 */
import { isAbsolute, resolve } from 'node:path';
import type {
  CommandView,
  ConnectionState,
  ContextState,
  DiffRef,
  HostSnapshot,
  HostToWebview,
  ModelState,
  PermissionState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  WebviewToHost,
} from '@dsh-copilot/shared';
import { ChangesUnavailableError, type ChangesSummary, type DshClient, type ModelSelection } from '../dsh/DshClient.ts';
import type { ConnectionStatus } from '../dsh/DshConnection.ts';
import { InteractionService } from '../dsh/InteractionService.ts';
import { RemoteError } from '../dsh/remote/errors.ts';
import { SessionService } from '../dsh/SessionService.ts';
import { SessionStream } from '../dsh/session/SessionStream.ts';
import {
  CONTEXT_OPEN,
  isTemplate,
  parseSlash,
  PLUGIN_COMMAND_NAMES,
  pluginCommands,
  templatePrompt,
  withContext,
  type ContextAttachment,
  type TemplateName,
} from './context.ts';
import { displayPath, project, projectEvents, type EventsProjection, type ToolCallInfo } from './projector.ts';
import { noWorkbench, type EditorSnapshot, type Workbench } from './workbench.ts';
import { approvalView, interactionView, type ViewContext } from './interactionViews.ts';
import { ViewPublisher, type ControllerView } from './ViewPublisher.ts';
import {
  buildModelState,
  contextUsageOf,
  describe,
  friendlyError,
  goalOf,
  newSessionTitle,
  queuedText,
  titleOf,
  todosOf,
  withoutDiagnostics,
} from './viewHelpers.ts';

export { friendlyError, plainTitle } from './viewHelpers.ts';
import { getLocale, t } from '../i18n.ts';

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
  /** 打开 Diff、未保存文件、确认框、当前编辑器。 */
  readonly workbench?: Workbench;
  /** 设置 `dsh.context.includeActiveEditor`：默认附带当前编辑器。 */
  readonly includeActiveEditor?: () => boolean;
  /** 多根工作区：让用户选择文件夹（选好后调用 setWorkspace）。 */
  readonly selectFolder?: () => void;
  /** 多根工作区时当前文件夹的显示名。 */
  readonly folderLabel?: () => string | undefined;
  readonly renderDelayMs?: number;
}

const DEFAULT_CREDENTIAL_REF = 'DEEPSEEK_API_KEY';
const DANGER_PRESET = 'danger-full-access';
/** 在 VS Code 里没有意义的 dsh 命令（/export 在浏览器里触发下载）。 */
const HIDDEN_DSH_COMMANDS = new Set(['export']);

export interface SendOptions {
  /** 附带当前编辑器（默认 true；输入框上方的标签被关掉时为 false）。 */
  readonly includeActive?: boolean;
  /** 额外附带的上下文（右键菜单的选区）。 */
  readonly extra?: readonly ContextAttachment[];
  /** 附带选区的诊断信息（/fix）。 */
  readonly diagnostics?: boolean;
}

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
  /** 用「添加到对话」固定的上下文，发送后清空。 */
  private pinned: (ContextAttachment & { id: string })[] = [];
  private pinCounter = 0;
  /** dsh 的斜杠命令目录（各会话相同），打开会话时读取。 */
  private dshCommands: CommandView[] = [];
  private client: DshClient | undefined;
  private workspacePath: string;
  /** dsh 在 MISSING_CREDENTIAL 里要求配置的凭据名。 */
  private credentialRef: string | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private serviceGeneration = 0;

  /** 持久事件投影的缓存（流式输出时持久事件不变）。 */
  private eventsMemo: { readonly key: readonly unknown[]; readonly value: EventsProjection } | undefined;
  /** 改动汇总每读到一份递增，作为缓存键的一部分。 */
  private changesVersion = 0;
  private readonly publisher: ViewPublisher;

  constructor(private readonly options: ChatControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
  }

  /** 多根工作区切换文件夹：会话列表、新建会话和路径显示都换到这个文件夹。 */
  setWorkspace(path: string): void {
    if (path === this.workspacePath) return;
    this.workspacePath = path;
    this.pinned = [];
    this.activeId = this.options.loadActiveSessionId();
    this.staleService = undefined;
    this.staleStream = undefined;
    this.setClient(this.client);
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

  /** 界面语言变化（设置 `dsh.ui.language`）：通知 Webview，Host 生成的文字重新计算。 */
  localeChanged(): void {
    this.options.post({ type: 'locale', payload: getLocale() });
    this.scheduleRender();
  }

  /** 编辑器里文件的未保存状态、当前编辑器或选区变化时调用。 */
  workspaceChanged(): void {
    this.scheduleRender();
  }

  /** 右键菜单「解释 / 修复 / 写测试」：带上当前选区（没有选区时是当前文件）立即发送。 */
  async askAboutSelection(template: TemplateName): Promise<void> {
    const attachment = this.snapshotAttachment(this.workbench.activeEditor());
    if (!attachment) {
      this.toast('info', t('context.none'));
      return;
    }
    await this.send(templatePrompt(template, ''), { includeActive: false, extra: [attachment], diagnostics: template === 'fix' });
  }

  /** 右键菜单「添加到对话」：固定当前选区（或文件），下一条消息发送时附带。 */
  pinActiveEditor(): void {
    const attachment = this.snapshotAttachment(this.workbench.activeEditor());
    if (!attachment) {
      this.toast('info', t('context.none'));
      return;
    }
    this.pinned.push({ ...attachment, id: `pin-${++this.pinCounter}` });
    this.scheduleRender();
    this.options.post({ type: 'focusComposer', payload: {} });
  }

  private snapshotAttachment(editor: EditorSnapshot | undefined): ContextAttachment | undefined {
    if (!editor) return undefined;
    if (!editor.selection) return { kind: 'file', path: editor.path };
    const { startLine, endLine, text, diagnostics } = editor.selection;
    return { kind: 'selection', path: editor.path, startLine, endLine, languageId: editor.languageId, text, ...(diagnostics.length ? { diagnostics } : {}) };
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
    this.client = client;
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
      this.changesVersion++;
      this.changesOrigin = origin;
    }
    const service = new SessionService({
      client,
      workspacePath: this.workspacePath,
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
        // 斜杠命令目录与会话无关，任选一个已有会话读取，新对话里也能补全 dsh 命令
        const anySession = service.sessions.find((s) => s.sessionId === restoredId)?.sessionId ?? service.sessions[0]?.sessionId;
        if (anySession) this.loadCommands(anySession);
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
        this.toast('error', t('error.readSessions', describe(error)));
      },
    );
  }

  /** Webview 加载（或重新加载）后取完整快照；之后的增量都相对于这份快照。 */
  snapshot(): HostSnapshot {
    const view = this.compute();
    this.publisher.reset(view);
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
      context: view.context,
      commands: view.commands,
      locale: getLocale(),
    };
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage':
        return this.send(message.payload.text, { includeActive: message.payload.includeActive ?? true });
      case 'searchFiles':
        return this.searchFiles(message.payload.requestId, message.payload.query);
      case 'queueAction':
        return this.queueAction(message.payload);
      case 'renameSession':
        return this.renameSession();
      case 'configureApiKey':
        return this.configureApiKey();
      case 'selectFolder':
        this.options.selectFolder?.();
        return;
      case 'removeAttachment':
        this.pinned = this.pinned.filter((p) => p.id !== message.payload.id);
        this.scheduleRender();
        return;
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
          this.toast('info', t('question.ended'));
        }
        return;
      }
      case 'openDiff':
        return this.openDiff(message.payload.ref);
      case 'openFile': {
        const { path, startLine, endLine } = message.payload;
        return this.workbench.openFile(this.absolute(path), startLine ? { startLine, ...(endLine ? { endLine } : {}) } : undefined);
      }
      case 'selectPermission':
        return this.selectPermission(message.payload.preset);
      case 'saveAll':
        return this.workbench.saveAll();
    }
  }

  private respondApproval(id: string, allow: boolean): void {
    const pending = this.interactions?.get(id);
    if (!pending || pending.kind !== 'approval') {
      this.toast('info', t('request.ended'));
      return;
    }
    if (allow && approvalView(pending, this.viewContext()).dirtyFiles.length > 0) {
      // 编辑器里还有未保存的内容，dsh 写入后会和编辑器冲突
      this.toast('error', t('approval.dirty'));
      return;
    }
    this.interactions?.respondApproval(id, allow);
  }

  private async previewApproval(id: string): Promise<void> {
    const pending = this.interactions?.get(id);
    const call = pending?.kind === 'approval' && pending.request.callId ? this.toolCalls.get(pending.request.callId) : undefined;
    if (!call?.path) {
      this.toast('info', t('preview.none'));
      return;
    }
    await this.workbench.openDiff({ kind: 'proposed', path: call.path, tool: call.tool, args: call.args });
  }

  private async openDiff(ref: DiffRef): Promise<void> {
    if (ref.kind === 'tool') {
      const call = this.toolCalls.get(ref.callId);
      if (!call?.path) {
        this.toast('info', t('diff.noRecord'));
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
        this.toast('info', diff.kind === 'binary' ? t('diff.binary') : t('diff.oversized'));
        return this.workbench.openFile(path);
      }
      await this.workbench.openDiff({ kind: 'turn', path, before: diff.before, after: diff.after, hunks: diff.hunks });
    } catch (error) {
      if (error instanceof ChangesUnavailableError) {
        // 汇总已经不在 Host 内存里：卡片改为按文件工具汇总，那里的 Diff 来自会话日志
        this.changes.set(`${sessionId}:${ref.seq}`, 'unavailable');
        this.changesVersion++;
        this.scheduleRender();
        this.toast('info', t('diff.turnGone'));
      } else this.toast('error', t('diff.readFailed', describe(error)));
    }
  }

  private async selectPermission(preset: string): Promise<void> {
    if (preset === DANGER_PRESET) {
      const ok = await this.workbench.confirm(
        t('danger.title'),
        t('danger.detail'),
        t('danger.allow'),
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
      this.toast('error', t('permission.failed', describe(error)));
    }
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspacePath, path);
  }

  /**
   * 发送一条消息。以 `/` 开头时先看是不是斜杠命令：插件模板展开成提示词，dsh 命令交给 dsh 执行。
   * 新对话的第一条消息发送时才在 dsh 中创建会话，避免每次打开面板都留下空会话。
   */
  async send(text: string, options: SendOptions = {}): Promise<void> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.setActive(undefined);
      if (slash.args.trim()) await this.send(slash.args, options);
      return;
    }
    if (slash && isTemplate(slash.name)) {
      const attachments = this.gatherContext({ ...options, diagnostics: options.diagnostics ?? slash.name === 'fix' });
      if (attachments.length === 0 && !slash.args.trim()) {
        this.toast('info', t('template.needsContext', slash.name));
        return;
      }
      return this.sendPrompt(templatePrompt(slash.name, slash.args), attachments);
    }
    if (slash && this.dshCommands.some((c) => c.name === slash.name)) return this.runCommand(text.trim());
    return this.sendPrompt(text, this.gatherContext(options));
  }

  /** 本条消息附带的上下文：固定的、额外的、当前编辑器。诊断信息只在 /fix 时附带。 */
  private gatherContext(options: SendOptions): ContextAttachment[] {
    const active = options.includeActive !== false ? this.snapshotAttachment(this.workbench.activeEditor()) : undefined;
    const all = [...this.pinned.map(({ id: _id, ...rest }) => rest as ContextAttachment), ...(options.extra ?? []), ...(active ? [active] : [])];
    return options.diagnostics ? all : all.map((a) => (a.kind === 'selection' ? withoutDiagnostics(a) : a));
  }

  private async sendPrompt(text: string, attachments: readonly ContextAttachment[]): Promise<void> {
    const service = this.service;
    if (!service) {
      this.toast('error', t('notConnected'));
      return;
    }
    try {
      const sessionId = await this.ensureSession(service);
      await service.prompt(sessionId, withContext(text, attachments, this.workspacePath));
      if (this.pinned.length) {
        this.pinned = [];
        this.scheduleRender();
      }
    } catch (error) {
      this.options.log(`发送失败：${describe(error)}`);
      this.toast('error', friendlyError(error));
    }
  }

  private async queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): Promise<void> {
    const sessionId = this.activeId;
    const client = this.service?.client;
    if (!sessionId || !client) return;
    try {
      if (payload.action === 'send') {
        // dsh 停止生成后保留队列，但不会自己开始新的一轮：取出来重新发送（保留原文和上下文）
        const original = queuedText(this.service?.projections(sessionId).inbox, payload.itemId);
        if (original === undefined) return;
        await client.updateQueue(sessionId, payload.itemId, { kind: 'remove' });
        await this.service?.prompt(sessionId, original);
      } else if (payload.action === 'edit') {
        // 界面上只编辑正文；原消息末尾的上下文块原样保留
        const original = queuedText(this.service?.projections(sessionId).inbox, payload.itemId);
        const at = original?.lastIndexOf(`\n\n${CONTEXT_OPEN}\n`) ?? -1;
        const text = at >= 0 && original ? `${payload.text}${original.slice(at)}` : payload.text;
        await client.updateQueue(sessionId, payload.itemId, { kind: 'edit', text });
      } else {
        await client.updateQueue(sessionId, payload.itemId, { kind: payload.action });
      }
    } catch (error) {
      // 消息可能刚好被送达，已经不在队列里
      this.toast('info', error instanceof RemoteError ? t('queue.alreadySent') : t('queue.failed', describe(error)));
      this.options.log(`修改排队消息失败：${describe(error)}`);
    }
  }

  async renameSession(): Promise<void> {
    const sessionId = this.activeId;
    const service = this.service;
    if (!sessionId || !service) {
      this.toast('info', t('rename.needsSession'));
      return;
    }
    const current = titleOf(service.projections(sessionId), []);
    const title = (await this.workbench.input({ title: t('rename.title'), value: current === newSessionTitle() ? '' : current }))?.trim();
    if (!title || title === current) return;
    try {
      await service.rename(sessionId, title);
    } catch (error) {
      this.toast('error', t('rename.failed', describe(error)));
    }
  }

  /**
   * 配置 API Key：用 VS Code 的密码输入框（Key 不经过 Webview），保存到 dsh 的凭据存储，立即生效。
   * 凭据名取 dsh 在 MISSING_CREDENTIAL 里给出的名字，默认 `DEEPSEEK_API_KEY`。
   */
  async configureApiKey(): Promise<void> {
    const service = this.service;
    if (!service) {
      this.toast('error', t('notConnected'));
      return;
    }
    const ref = this.credentialRef ?? DEFAULT_CREDENTIAL_REF;
    const value = (
      await this.workbench.input({
        title: t('apiKey.title'),
        prompt: t('apiKey.prompt', ref),
        placeHolder: 'sk-…',
        password: true,
      })
    )?.trim();
    if (!value) return;
    try {
      await service.client.setCredential(ref, value);
      await service.reloadModels().catch((error: unknown) => this.options.log(`重新读取模型目录失败：${describe(error)}`));
      this.credentialRef = undefined;
      this.toast('info', t('apiKey.saved'));
    } catch (error) {
      this.toast('error', t('apiKey.failed', describe(error)));
    }
  }

  /** dsh 的斜杠命令：结果以 command/run、command/done 事件出现在对话里。 */
  private async runCommand(line: string): Promise<void> {
    const service = this.service;
    if (!service) {
      this.toast('error', t('notConnected'));
      return;
    }
    try {
      const sessionId = await this.ensureSession(service);
      await service.client.executeCommand(sessionId, line);
    } catch (error) {
      this.options.log(`执行 ${line} 失败：${describe(error)}`);
      this.toast('error', t('command.failed', describe(error)));
    }
  }

  /** 当前会话；新对话时在 dsh 里创建，并应用新对话里选好的模型和权限。 */
  private async ensureSession(service: SessionService): Promise<string> {
    if (this.activeId) return this.activeId;
    const sessionId = await service.createSession();
    this.setActive(sessionId);
    if (this.draftModel) {
      await service.selectModel(sessionId, this.draftModel).catch((error: unknown) => {
        this.options.log(`为新会话设置模型失败：${describe(error)}`);
      });
      this.draftModel = undefined;
    }
    if (this.draftPermission && this.draftPermission !== service.permissions?.defaultPreset) {
      await service.setPermission(sessionId, this.draftPermission).catch((error: unknown) => {
        this.toast('error', t('permission.newSessionFailed', describe(error)));
      });
    }
    this.draftPermission = undefined;
    return sessionId;
  }

  /** `@` 补全：有会话时用 dsh 的候选（与 dsh 的引用规则一致），新对话用 VS Code 的文件搜索。 */
  private async searchFiles(requestId: number, query: string): Promise<void> {
    const sessionId = this.activeId;
    const client = this.service?.client;
    let items: { path: string; kind: 'file' | 'directory' }[] = [];
    try {
      items = sessionId && client ? await client.fileReferences(sessionId, query) : await this.workbench.findFiles(query);
    } catch (error) {
      this.options.log(`文件搜索失败：${describe(error)}`);
    }
    this.options.post({ type: 'fileCandidates', payload: { requestId, items: items.slice(0, 50) } });
  }

  private loadCommands(sessionId: string): void {
    const client = this.service?.client;
    if (!client || this.dshCommands.length > 0) return;
    // 放进 then 里调用：读取失败（包括同步抛错）都不能影响打开会话
    void Promise.resolve()
      .then(() => client.commands(sessionId))
      .then(
      (commands) => {
        this.dshCommands = commands
          .filter((c) => !HIDDEN_DSH_COMMANDS.has(c.name) && !(PLUGIN_COMMAND_NAMES as readonly string[]).includes(c.name))
          .map((c) => ({ name: c.name, description: c.description ?? '', ...(c.input?.hint ? { hint: c.input.hint } : {}), source: 'dsh' as const }));
        this.scheduleRender();
      },
      (error: unknown) => this.options.log(`读取斜杠命令失败：${describe(error)}`),
    );
  }

  private async interrupt(): Promise<void> {
    if (!this.activeId || !this.service) return;
    try {
      await this.service.cancel(this.activeId);
    } catch (error) {
      // 会话已经空闲时 dsh 会拒绝取消，不需要打扰用户
      if (!(error instanceof RemoteError)) this.toast('error', t('stop.failed', describe(error)));
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
      this.toast('error', t('model.failed', describe(error)));
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
      this.loadCommands(sessionId);
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
    this.publisher.publish(this.compute());
  }

  private compute(): ControllerView {
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
    const events = stream?.journal.events ?? [];
    const changes = (seq: number) => {
      const value = sessionId ? this.changes.get(`${sessionId}:${seq}`) : undefined;
      return value === 'loading' ? undefined : value;
    };
    const key = [events, events.length, events[0]?.seq, events.at(-1)?.seq, this.workspacePath, this.changesVersion, getLocale()];
    if (!this.eventsMemo || this.eventsMemo.key.some((part, i) => part !== key[i])) {
      this.eventsMemo = { key, value: projectEvents({ events, workspacePath: this.workspacePath, changes }) };
    }
    const projection = project({
      events,
      live: stream?.journal.live,
      pending,
      ...(streamLive ? {} : { fallbackRunning: summary?.running ?? false }),
      workspacePath: this.workspacePath,
      inbox: projections.inbox,
      changes,
    }, this.eventsMemo.value);
    this.toolCalls = projection.toolCalls;
    if (projection.missingCredentialRef) this.credentialRef = projection.missingCredentialRef;
    if (sessionId && streamLive && !showingStale) this.loadChanges(sessionId, projection.changeSeqs);
    // 已经出现在历史或 dsh 队列里的本地回显撤掉：之后从队列里删除的消息不能再以回显的形式冒出来
    if (sessionId && service && (projection.persistedRequestIds.size > 0 || projection.queuedRequestIds.size > 0)) {
      service.retirePending(sessionId, new Set([...projection.persistedRequestIds, ...projection.queuedRequestIds]));
    }

    const streamStatus = stream?.status;
    // follow 流就绪后以事件日志为准；会话列表里的 running 由通知触发刷新，会滞后
    const running = streamLive ? projection.turnOpen : projection.turnOpen || (summary?.running ?? false);
    const session: SessionHeader = {
      ...(sessionId ? { id: sessionId } : {}),
      title: sessionId ? titleOf(projections, projection.items) : newSessionTitle(),
      running,
      hasOlder: stream?.journal.hasOlder ?? false,
      loadingOlder: stream?.loadingOlder ?? false,
      sync: !sessionId ? 'idle' : showingStale ? 'disconnected' : !streamStatus ? 'opening' : streamStatus.kind,
      ...(streamStatus?.kind === 'failed' ? { failure: streamStatus.message } : {}),
      ...contextUsageOf(projections),
      ...((projections.plan as { active?: boolean } | undefined)?.active ? { planMode: true } : {}),
      ...todosOf(projections),
      ...goalOf(projections),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
    };

    const attention = this.interactions?.sessionsNeedingAttention() ?? new Set<string>();
    const sessions: SessionListItem[] = (service?.sessions ?? []).map((s) => ({
      id: s.sessionId,
      title: titleOf(service?.projections(s.sessionId) ?? {}, []),
      updatedAt: s.updatedAt,
      running: s.sessionId === sessionId && streamLive ? running : s.running,
      ...(attention.has(s.sessionId) ? { needsAttention: true } : {}),
    }));

    const interactions = sessionId ? (this.interactions?.pendingFor(sessionId) ?? []).map((p) => interactionView(p, this.viewContext())) : [];
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
      models: buildModelState(projections, service?.models, this.draftModel),
      interactions,
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.contextState(),
      commands: [...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })), ...this.dshCommands],
    };
  }

  private contextState(): ContextState {
    const view = (a: ContextAttachment) => ({
      kind: a.kind,
      path: displayPath(a.path, this.workspacePath),
      ...(a.kind === 'selection' ? { startLine: a.startLine, endLine: a.endLine } : {}),
    });
    const active = this.snapshotAttachment(this.workbench.activeEditor());
    return {
      ...(active ? { active: { ...view(active), key: active.kind === 'file' ? `f:${active.path}` : `s:${active.path}:${active.startLine}-${active.endLine}` } } : {}),
      includeActiveByDefault: this.options.includeActiveEditor?.() ?? true,
      pinned: this.pinned.map((p) => ({ ...view(p), id: p.id })),
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
      ).finally(() => {
        this.changesVersion++;
        this.scheduleRender();
      });
    }
  }

  /** 当前会话可选的模型和当前选择（供命令面板的模型选择使用）。 */
  modelState(): ModelState {
    const projections = this.activeId && this.service ? this.service.projections(this.activeId) : {};
    return buildModelState(projections, this.service?.models, this.draftModel);
  }

  private viewContext(): ViewContext {
    return { toolCalls: this.toolCalls, workspacePath: this.workspacePath, dirtyFiles: this.workbench.dirtyFiles() };
  }

  private toast(level: 'info' | 'error', text: string): void {
    this.options.post({ type: 'toast', payload: { level, text } });
  }
}

