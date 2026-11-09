/**
 * 对话面板的控制器：把运行时状态、连接、会话服务、follow 流和投影串起来，推送给 Webview。
 *
 * Extension Host 是状态的唯一来源（docs/DESIGN.md D7）：Webview 加载后取一次快照，之后只收增量。
 * 推送按约 30ms 合并，流式输出时不会产生消息风暴。不依赖 vscode API，便于测试。
 */
import { isAbsolute, resolve } from 'node:path';
import type { ChatBackendController } from '../backend/types.ts';
import type {
  AppearanceState,
  BackendsState,
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
  TabsState,
  WebviewToHost,
} from '@harness-deck/shared';
import { ChangesUnavailableError, type ChangesDiff, type ChangesSummary, type DshClient, type ModelSelection } from '../dsh/DshClient.ts';
import type { ConnectionStatus } from '../dsh/DshConnection.ts';
import { InteractionService } from '../dsh/InteractionService.ts';
import { RemoteError } from '../dsh/remote/errors.ts';
import { SessionService, type PendingImage } from '../dsh/SessionService.ts';
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
import { displayPath, project, projectEvents, type EventsProjection, type FileStep, type ToolCallInfo } from './projector.ts';
import { lineStats, reverseHunks, reverseToolDiffs } from './diffs.ts';
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
  /** 记住每个工作区打开的会话标签（VS Code workspaceState）。 */
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  readonly openExternal: (url: string) => void;
  readonly restartRuntime: () => void;
  readonly showLogs: () => void;
  /** 在浏览器中打开 dsh；`sessionTitle` 是当前会话的标题（dsh 网页不支持直接定位到会话，提示用户在列表里选）。 */
  readonly openWebUI: (sessionTitle?: string) => void;
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
  /** 界面字号和字体（设置 `dsh.ui.*`）。 */
  readonly appearance?: () => AppearanceState;
  /** 打开插件的界面设置。 */
  readonly openSettings?: () => void;
  /** 可选的底层和当前底层（随快照下发，Webview 的「…」菜单里切换）。 */
  readonly backends?: () => BackendsState;
  /** 写入字体设置（dsh.ui.*）；值为 null 时恢复默认。 */
  readonly setAppearance?: (patch: {
    readonly fontSize?: number | null;
    readonly fontFamily?: string | null;
    readonly codeFontFamily?: string | null;
    readonly palette?: 'soft' | 'theme' | null;
  }) => Promise<void>;
  /**
   * 每轮结束时在对话流里显示改动汇总卡片（设置 `dsh.ui.showTurnChanges`）。不传时显示。
   * 关掉时改动只在输入框上方的会话改动栏里显示，汇总仍会读取，用于打开 Diff。
   */
  readonly showTurnChanges?: () => boolean;
}

/** 同时读取改动汇总的请求数：打开长会话时不一次发出几十个请求，把 dsh 堵住（点开 Diff 的请求要排在后面）。 */
const SUMMARY_CONCURRENCY = 2;
/** 后台标签最多保留几个 follow 流：切回这些标签时内容立即可见，更多的标签切回时重新打开。 */
const MAX_BACKGROUND_STREAMS = 4;

interface Tab {
  readonly key: string;
  sessionId: string | undefined;
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
  /** 粘贴或拖进来的图片。 */
  readonly images?: readonly PendingImage[];
}

export class ChatController implements ChatBackendController {
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
  /** 正在读取命令和 skill 的会话（同一个会话不重复读）。 */
  private loadingCommands: string | undefined;
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
  /** 当前会话每个文件的改动历史（绝对路径），用于打开累计 Diff 和某一轮的 Diff。 */
  private fileHistory: ReadonlyMap<string, readonly FileStep[]> = new Map();
  /** `/api/changes.diff` 的结果，键是 `会话:seq:index`；一轮结束后内容不再变化。 */
  private readonly turnDiffs = new Map<string, Promise<ChangesDiff>>();
  /** 正在打开的 Diff：重复点击不重复请求。 */
  private readonly openingDiffs = new Set<string>();
  /** 等待读取的改动汇总（新的在前）。 */
  private summaryQueue: { readonly sessionId: string; readonly seq: number }[] = [];
  private summariesInFlight = 0;
  /** 对话面板里打开的标签；当前标签的会话就是 activeId。 */
  private tabs: Tab[] = [];
  private activeTab = '';
  private tabCounter = 0;
  /** 子代理会话 → 父会话：从父会话里打开时由 Webview 告知，会话列表刷新后也能从 dsh 读到。 */
  private readonly subagentParents = new Map<string, string>();
  /** 子代理会话 → 任务描述：dsh 给子代理会话起的标题带着给子代理的说明，用描述代替。 */
  private readonly subagentLabels = new Map<string, string>();

  /** 会话标题；子代理的会话显示「子代理 · 描述」。 */
  private titleFor(sessionId: string, projections: Readonly<Record<string, unknown>>, items: Parameters<typeof titleOf>[1]): string {
    const label = this.subagentLabels.get(sessionId);
    if (label) return t('subagent.title', label);
    return titleOf(projections, items);
  }

  /** 子代理会话的父会话；不是子代理会话时为 undefined。 */
  private parentOf(sessionId: string): string | undefined {
    return this.subagentParents.get(sessionId) ?? this.service?.parentOf(sessionId);
  }

  /** 后台标签的 follow 流（会话 id → 流），按切走的先后排列。 */
  private readonly background = new Map<string, SessionStream>();

  constructor(private readonly options: ChatControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.restoreTabs();
  }

  /** 按保存的标签和上次打开的会话恢复标签；上次停在新对话时末尾加一个新对话标签。 */
  private restoreTabs(): void {
    const ids = [...new Set(this.options.loadOpenTabs?.() ?? [])];
    if (this.activeId && !ids.includes(this.activeId)) ids.push(this.activeId);
    this.tabs = ids.map((sessionId) => ({ key: this.nextTabKey(), sessionId }));
    let active = this.tabs.find((tab) => tab.sessionId === this.activeId);
    if (!active) {
      active = { key: this.nextTabKey(), sessionId: undefined };
      this.tabs.push(active);
    }
    this.activeTab = active.key;
  }

  private nextTabKey(): string {
    return `tab-${++this.tabCounter}`;
  }

  private saveTabs(): void {
    this.options.saveOpenTabs?.(this.tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])));
  }

  private disposeBackground(): void {
    for (const stream of this.background.values()) stream.dispose();
    this.background.clear();
  }

  /** 新对话：已有空的新对话标签时切过去，否则在当前标签后面新开一个。 */
  private newTab(): void {
    const blank = this.tabs.find((tab) => !tab.sessionId);
    if (blank) return this.activateTab(blank.key);
    const tab: Tab = { key: this.nextTabKey(), sessionId: undefined };
    this.tabs.splice(this.tabs.findIndex((t) => t.key === this.activeTab) + 1, 0, tab);
    this.activateTab(tab.key);
  }

  /** 打开会话：已经在标签里时切过去；当前是空的新对话时就在当前标签打开；否则新开一个标签。 */
  private openSessionTab(sessionId: string): void {
    const existing = this.tabs.find((tab) => tab.sessionId === sessionId);
    if (existing) return this.activateTab(existing.key);
    const current = this.tabs.find((tab) => tab.key === this.activeTab);
    if (current && !current.sessionId) {
      this.setActive(sessionId);
      return;
    }
    const tab: Tab = { key: this.nextTabKey(), sessionId };
    this.tabs.splice(this.tabs.findIndex((t) => t.key === this.activeTab) + 1, 0, tab);
    this.activateTab(tab.key);
  }

  private activateTab(key: string): void {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return;
    this.activeTab = key;
    this.setActive(tab.sessionId);
    this.saveTabs();
    this.scheduleRender();
  }

  /** 关闭标签：会话仍在 dsh 里。关掉最后一个标签时换成新对话。 */
  private closeTab(key: string): void {
    const index = this.tabs.findIndex((t) => t.key === key);
    const tab = this.tabs[index];
    if (!tab) return;
    if (tab.sessionId) {
      this.background.get(tab.sessionId)?.dispose();
      this.background.delete(tab.sessionId);
    }
    if (this.tabs.length === 1) {
      if (!tab.sessionId) return;
      this.tabs = [{ key: this.nextTabKey(), sessionId: undefined }];
      this.activateTab(this.tabs[0]!.key);
      return;
    }
    this.tabs.splice(index, 1);
    if (key === this.activeTab) {
      // 当前流属于被关掉的标签：不放进后台，直接关掉
      if (this.stream && this.stream.sessionId === tab.sessionId) {
        this.stream.dispose();
        this.stream = undefined;
      }
      this.activateTab((this.tabs[index] ?? this.tabs[index - 1])!.key);
    } else {
      this.saveTabs();
      this.scheduleRender();
    }
  }

  /** 当前会话还在某个标签里时把它的流留在后台，否则关掉。 */
  private parkStream(): void {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    const open = this.tabs.some((tab) => tab.sessionId === stream.sessionId);
    if (!open || stream.status.kind === 'failed' || stream.status.kind === 'disconnected') {
      stream.dispose();
      return;
    }
    this.background.delete(stream.sessionId);
    this.background.set(stream.sessionId, stream);
    while (this.background.size > MAX_BACKGROUND_STREAMS) {
      const [oldestId, oldest] = this.background.entries().next().value!;
      oldest.dispose();
      this.background.delete(oldestId);
    }
  }

  private tabsState(service: SessionService | undefined, current: SessionHeader, attention: ReadonlySet<string>): TabsState {
    const items = this.tabs.map((tab) => {
      if (tab.key === this.activeTab) {
        return { key: tab.key, ...(tab.sessionId ? { sessionId: tab.sessionId } : {}), title: current.title, running: current.running, ...(tab.sessionId && attention.has(tab.sessionId) ? { needsAttention: true } : {}) };
      }
      if (!tab.sessionId) return { key: tab.key, title: newSessionTitle(), running: false };
      const summary = service?.sessions.find((s) => s.sessionId === tab.sessionId);
      return {
        key: tab.key,
        sessionId: tab.sessionId,
        title: this.titleFor(tab.sessionId, service?.projections(tab.sessionId) ?? {}, []),
        running: summary?.running ?? false,
        ...(attention.has(tab.sessionId) ? { needsAttention: true } : {}),
      };
    });
    return { items, active: this.activeTab };
  }

  /** 多根工作区切换文件夹：会话列表、新建会话和路径显示都换到这个文件夹。 */
  setWorkspace(path: string): void {
    if (path === this.workspacePath) return;
    this.workspacePath = path;
    this.pinned = [];
    this.activeId = this.options.loadActiveSessionId();
    this.staleService = undefined;
    this.staleStream = undefined;
    this.disposeBackground();
    this.restoreTabs();
    this.setClient(this.client);
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.stream?.dispose();
    this.disposeBackground();
    this.service?.dispose();
    this.interactions?.dispose();
  }

  /** 界面语言变化（设置 `dsh.ui.language`）：通知 Webview，Host 生成的文字重新计算。 */
  /** 界面字号或字体的设置变化时调用。 */
  appearanceChanged(): void {
    this.options.post({ type: 'appearance', payload: this.options.appearance?.() ?? {} });
  }

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
    // 后台标签的流绑定在旧连接上；切回时在新连接上重新打开
    this.disposeBackground();
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
    this.summaryQueue = [];
    this.scheduleRender();
    if (!client) return;
    this.interactions = new InteractionService(client, () => this.scheduleRender(), this.options.log);
    const origin = client.credential?.origin;
    if (origin !== this.changesOrigin) {
      this.changes.clear();
      this.turnDiffs.clear();
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
        // 已经不存在的会话（被删除或不属于这个工作区）不再保留标签
        const before = this.tabs.length;
        const known = (id: string) => service.sessions.some((s) => s.sessionId === id) || this.parentOf(id) !== undefined;
        this.tabs = this.tabs.filter((tab) => !tab.sessionId || tab.sessionId === restoredId || known(tab.sessionId));
        if (this.tabs.length !== before) this.saveTabs();
        if (restoredId && !known(restoredId)) {
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
      tabs: view.tabs,
      session: view.session,
      items: view.items,
      models: view.models,
      interactions: view.interactions,
      permissions: view.permissions,
      workspace: view.workspace,
      context: view.context,
      commands: view.commands,
      locale: getLocale(),
      appearance: this.options.appearance?.() ?? {},
      backends: this.options.backends?.() ?? { items: [], active: '' },
    };
  }

  backendsChanged(): void {
    this.options.post({ type: 'backends', payload: this.options.backends?.() ?? { items: [], active: '' } });
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage':
        return this.send(message.payload.text, { includeActive: message.payload.includeActive ?? true, ...(message.payload.images ? { images: message.payload.images } : {}) });
      case 'loadImage':
        return this.loadImage(message.payload.attachmentId);
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
        this.newTab();
        return;
      case 'switchSession':
        if (message.payload.parentId) this.subagentParents.set(message.payload.sessionId, message.payload.parentId);
        if (message.payload.label) this.subagentLabels.set(message.payload.sessionId, message.payload.label);
        this.openSessionTab(message.payload.sessionId);
        return;
      case 'activateTab':
        this.activateTab(message.payload.key);
        return;
      case 'closeTab':
        this.closeTab(message.payload.key);
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
        this.options.openWebUI(this.activeId ? this.compute().session.title : undefined);
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
      case 'openDiff': {
        const { ref, token } = message.payload;
        const key = JSON.stringify(ref);
        if (this.openingDiffs.has(key)) return;
        this.openingDiffs.add(key);
        try {
          await this.openDiff(ref);
        } finally {
          this.openingDiffs.delete(key);
          if (token !== undefined) this.options.post({ type: 'diffOpened', payload: { token } });
        }
        return;
      }
      case 'openSettings':
        this.options.openSettings?.();
        return;
      case 'setAppearance':
        try {
          await this.options.setAppearance?.(message.payload);
        } catch (error) {
          this.toast('error', t('appearance.failed', describe(error)));
          this.appearanceChanged();
        }
        return;
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
    if (!sessionId) return;
    try {
      if (ref.kind === 'session') return await this.openSessionDiff(sessionId, ref.path);
      return await this.openTurnDiff(sessionId, ref.seq, ref.index);
    } catch (error) {
      if (error instanceof ChangesUnavailableError) {
        // 汇总已经不在 Host 内存里：卡片改为按文件工具汇总，那里的 Diff 来自会话日志
        if (ref.kind === 'turn') this.changes.set(`${sessionId}:${ref.seq}`, 'unavailable');
        this.changesVersion++;
        this.scheduleRender();
        this.toast('info', t('diff.turnGone'));
      } else this.toast('error', t('diff.readFailed', describe(error)));
    }
  }

  /** 本会话对一个文件的累计改动：从当前内容依次撤回每一轮的修改。还原不了时打开最后一次修改的 Diff。 */
  private async openSessionDiff(sessionId: string, path: string): Promise<void> {
    const steps = this.fileHistory.get(path) ?? [];
    const last = steps.at(-1);
    if (!last) return this.workbench.openFile(path);
    if (steps.some((s) => s.flags?.length)) {
      this.toast('info', steps.some((s) => s.flags?.includes('binary')) ? t('diff.binary') : t('diff.oversized'));
      return this.workbench.openFile(path);
    }
    const rewound = await this.rewind(sessionId, path, steps, 0, 'session');
    if (rewound) return this.workbench.openDiff({ kind: 'contents', path, ...rewound, scope: 'session' });
    this.options.log(`无法还原 ${path} 在本会话修改前的内容，改为显示最后一次修改`);
    if (last.turnSeq !== undefined && last.index !== undefined) return this.openTurnDiff(sessionId, last.turnSeq, last.index);
    const callId = last.calls.at(-1);
    if (callId) return this.openDiff({ kind: 'tool', callId });
    return this.workbench.openFile(path);
  }

  /**
   * 某一轮里一个文件的改动。优先用会话日志里的工具片段在本地还原（不请求 dsh，几乎是即时的）；
   * 本轮有命令造成的改动、或片段对不上时，才读取 dsh 记录的 hunk。
   */
  private async openTurnDiff(sessionId: string, seq: number, index: number): Promise<void> {
    const summary = this.changes.get(`${sessionId}:${seq}`);
    const file = typeof summary === 'object' ? summary.files[index] : undefined;
    if (file) {
      const path = this.absolute(file.path);
      if (file.binary || file.oversized) {
        this.toast('info', file.binary ? t('diff.binary') : t('diff.oversized'));
        return this.workbench.openFile(path);
      }
      const steps = this.fileHistory.get(path) ?? [];
      const at = steps.findIndex((s) => s.turnSeq === seq && s.index === index);
      const rewound = at >= 0 ? await this.rewind(sessionId, path, steps, at, 'turn') : undefined;
      if (rewound) return this.workbench.openDiff({ kind: 'contents', path, ...rewound, scope: 'turn' });
    }
    // 还原不了：交给编辑器用 hunk 还原，仍不行时显示修改片段
    const diff = await this.turnDiff(sessionId, seq, index);
    const path = this.absolute(diff.path);
    if (diff.kind !== 'text') {
      this.toast('info', diff.kind === 'binary' ? t('diff.binary') : t('diff.oversized'));
      return this.workbench.openFile(path);
    }
    await this.workbench.openDiff({ kind: 'turn', path, before: diff.before, after: diff.after, hunks: diff.hunks });
  }

  /**
   * 从文件的当前内容往回撤，得到第 `at` 步之前的内容。右侧：`turn` 是第 `at` 步之后的内容，`session` 是当前内容。
   * `after` 为 undefined 表示右侧直接用磁盘上的文件（可以继续编辑）。
   */
  private async rewind(
    sessionId: string,
    path: string,
    steps: readonly FileStep[],
    at: number,
    scope: 'turn' | 'session',
  ): Promise<{ before: string; after?: string; created: boolean } | undefined> {
    const current = await this.workbench.readFile(path);
    let text = current ?? '';
    for (let i = steps.length - 1; i > at; i--) {
      const previous = await this.reverseStep(sessionId, text, steps[i]!);
      if (previous === undefined) return undefined;
      text = previous;
    }
    const step = steps[at]!;
    const before = await this.reverseStep(sessionId, text, step);
    if (before === undefined) return undefined;
    // 文件已经被删除时右侧是空内容
    const after = current === undefined ? '' : scope === 'session' || at === steps.length - 1 ? undefined : text;
    return { before, ...(after === undefined ? {} : { after }), created: before === '' && steps[at]!.created };
  }

  /** 撤回一步修改。工具片段还原出的结果与 dsh 汇总的增删行数一致时直接采用，否则读取 dsh 的 hunk。 */
  private async reverseStep(sessionId: string, text: string, step: FileStep): Promise<string | undefined> {
    const local = this.reverseCalls(text, step.calls);
    if (step.turnSeq === undefined || step.index === undefined) return local;
    if (local !== undefined) {
      const stats = lineStats(local, text);
      if (stats.additions === step.stats.additions && stats.deletions === step.stats.deletions) return local;
    }
    const diff = await this.turnDiff(sessionId, step.turnSeq, step.index);
    if (diff.kind !== 'text') return undefined;
    if (!diff.before) return '';
    return reverseHunks(diff.after ? text : '', diff.hunks);
  }

  /** 按时间倒序撤回几次工具修改；新建文件的那次撤回后是空内容。 */
  private reverseCalls(text: string, callIds: readonly string[]): string | undefined {
    if (callIds.length === 0) return undefined;
    let result = text;
    for (const callId of [...callIds].reverse()) {
      const call = this.toolCalls.get(callId);
      if (!call) return undefined;
      if (call.created) return '';
      const previous = reverseToolDiffs(result, call.diffs ?? []);
      if (previous === undefined) return undefined;
      result = previous;
    }
    return result;
  }

  private turnDiff(sessionId: string, seq: number, index: number): Promise<ChangesDiff> {
    const client = this.service?.client;
    if (!client) return Promise.reject(new Error(t('diff.notConnected')));
    const key = `${sessionId}:${seq}:${index}`;
    let pending = this.turnDiffs.get(key);
    if (!pending) {
      pending = client.changesDiff(sessionId, seq, index);
      this.turnDiffs.set(key, pending);
      pending.catch(() => this.turnDiffs.delete(key));
    }
    return pending;
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
      this.newTab();
      if (slash.args.trim()) await this.send(slash.args, options);
      return;
    }
    if (slash && isTemplate(slash.name)) {
      const attachments = this.gatherContext({ ...options, diagnostics: options.diagnostics ?? slash.name === 'fix' });
      if (attachments.length === 0 && !slash.args.trim()) {
        this.toast('info', t('template.needsContext', slash.name));
        return;
      }
      return this.sendPrompt(templatePrompt(slash.name, slash.args), attachments, options.images);
    }
    // skill 不是命令：照常作为消息发出，dsh 识别 `/name` 调用 skill
    if (slash && this.dshCommands.some((c) => c.name === slash.name && c.source === 'dsh')) return this.runCommand(text.trim());
    return this.sendPrompt(text, this.gatherContext(options), options.images);
  }

  /** 历史消息里的图片：向 dsh 读取后以 data URL 回传，Webview 缓存。读不到时回传空，显示占位。 */
  private async loadImage(attachmentId: string): Promise<void> {
    const sessionId = this.activeId;
    const client = this.service?.client;
    let dataUrl: string | undefined;
    if (sessionId && client) {
      try {
        const image = await client.attachment(sessionId, attachmentId);
        dataUrl = `data:${image.mediaType};base64,${image.data}`;
      } catch (error) {
        this.options.log(`读取图片失败：${describe(error)}`);
      }
    }
    this.options.post({ type: 'imageData', payload: { attachmentId, ...(dataUrl ? { dataUrl } : {}) } });
  }

  /** 本条消息附带的上下文：固定的、额外的、当前编辑器。诊断信息只在 /fix 时附带。 */
  private gatherContext(options: SendOptions): ContextAttachment[] {
    const active = options.includeActive !== false ? this.snapshotAttachment(this.workbench.activeEditor()) : undefined;
    const all = [...this.pinned.map(({ id: _id, ...rest }) => rest as ContextAttachment), ...(options.extra ?? []), ...(active ? [active] : [])];
    return options.diagnostics ? all : all.map((a) => (a.kind === 'selection' ? withoutDiagnostics(a) : a));
  }

  private async sendPrompt(text: string, attachments: readonly ContextAttachment[], images: readonly PendingImage[] = []): Promise<void> {
    const service = this.service;
    if (!service) {
      this.toast('error', t('notConnected'));
      return;
    }
    if (this.activeId && this.parentOf(this.activeId)) {
      // 子代理的对话由父会话里的代理驱动，这里只能查看
      this.toast('info', t('subagent.readOnly'));
      return;
    }
    try {
      const sessionId = await this.ensureSession(service);
      await service.prompt(sessionId, withContext(text, attachments, this.workspacePath), undefined, images);
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

  /**
   * 斜杠命令和 skill。skill 不在 commands/list 里，要另外读 skills/list（会话的工作目录和预设决定能用哪些）；
   * 每次打开会话都重新读，新装的 skill 也能出现。
   */
  private loadCommands(sessionId: string): void {
    const client = this.service?.client;
    if (!client || this.loadingCommands === sessionId) return;
    this.loadingCommands = sessionId;
    // 放进 then 里调用：读取失败（包括同步抛错）都不能影响打开会话
    const commands = Promise.resolve().then(() => client.commands(sessionId));
    const skills = Promise.resolve()
      .then(() => client.skills(sessionId))
      .catch((error: unknown) => {
        this.options.log(`读取 skill 失败（旧版本 dsh 可能没有 skills/list）：${describe(error)}`);
        return [];
      });
    void Promise.all([commands, skills])
      .then(
        ([list, skillList]) => {
          const views: CommandView[] = list
            .filter((c) => !HIDDEN_DSH_COMMANDS.has(c.name) && !(PLUGIN_COMMAND_NAMES as readonly string[]).includes(c.name))
            .map((c) => ({ name: c.name, description: c.description ?? '', ...(c.input?.hint ? { hint: c.input.hint } : {}), source: 'dsh' as const }));
          const taken = new Set([...views.map((c) => c.name), ...PLUGIN_COMMAND_NAMES]);
          for (const skill of skillList) {
            if (taken.has(skill.name)) continue;
            taken.add(skill.name);
            views.push({ name: skill.name, description: skill.description ?? skill.whenToUse ?? '', source: 'skill' });
          }
          this.dshCommands = views;
          this.scheduleRender();
        },
        (error: unknown) => this.options.log(`读取斜杠命令失败：${describe(error)}`),
      )
      .finally(() => {
        if (this.loadingCommands === sessionId) this.loadingCommands = undefined;
      });
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
      await service.prompt(sessionId, pending.text, requestId, pending.images ?? []);
    } catch (error) {
      this.toast('error', friendlyError(error));
    }
  }

  /** 切换当前标签显示的会话（undefined 为新对话）；标签的切换、新建、关闭见 activateTab 等。 */
  private setActive(sessionId: string | undefined): void {
    const tab = this.tabs.find((t) => t.key === this.activeTab);
    if (tab && tab.sessionId !== sessionId) {
      // 同一个会话不同时出现在两个标签里
      const duplicate = sessionId ? this.tabs.find((t) => t !== tab && t.sessionId === sessionId) : undefined;
      if (duplicate) this.tabs = this.tabs.filter((t) => t !== duplicate);
      tab.sessionId = sessionId;
      this.saveTabs();
    }
    if (sessionId === this.activeId && (sessionId === undefined || this.stream)) return;
    this.parkStream();
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
    const parked = sessionId ? this.background.get(sessionId) : undefined;
    if (sessionId && parked) this.background.delete(sessionId);
    if (service && sessionId && parked && parked.status.kind !== 'failed' && parked.status.kind !== 'disconnected') {
      // 后台标签的流一直在跟随，内容立即可见
      this.stream = parked;
      this.loadCommands(sessionId);
    } else if (service && sessionId) {
      parked?.dispose();
      const parentId = this.parentOf(sessionId);
      const stream = new SessionStream({
        client: service.client,
        sessionId,
        ...(parentId ? { parentId } : {}),
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
    this.fileHistory = projection.fileHistory;
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
      title: sessionId ? this.titleFor(sessionId, projections, projection.items) : newSessionTitle(),
      running,
      hasOlder: stream?.journal.hasOlder ?? false,
      loadingOlder: stream?.loadingOlder ?? false,
      sync: !sessionId ? 'idle' : showingStale ? 'disconnected' : !streamStatus ? 'opening' : streamStatus.kind,
      ...(streamStatus?.kind === 'failed' ? { failure: streamStatus.message } : {}),
      ...contextUsageOf(projections),
      ...(this.connection === 'connected' && !this.service?.initialized && !this.staleService ? { listLoading: true } : {}),
      ...((projections.plan as { active?: boolean } | undefined)?.active ? { planMode: true } : {}),
      ...todosOf(projections),
      ...goalOf(projections),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
      ...(projection.sessionChanges ? { changes: projection.sessionChanges } : {}),
      ...(running && this.eventsMemo.value.turnStartedAt !== undefined ? { runningSince: this.eventsMemo.value.turnStartedAt } : {}),
      ...(sessionId && this.parentOf(sessionId) ? { subagentOf: { parentId: this.parentOf(sessionId)! } } : {}),
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
      tabs: this.tabsState(service, session, attention),
      session,
      items: this.options.showTurnChanges?.() === false ? projection.items.filter((item) => item.kind !== 'changes') : projection.items,
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

  /**
   * 读取还没读过的改动汇总。新的轮次先读，同时最多 SUMMARY_CONCURRENCY 个请求。
   * Host 重启后汇总不再可用，记为 unavailable，投影退回按文件工具汇总。
   */
  private loadChanges(sessionId: string, seqs: readonly number[]): void {
    const fresh = seqs.filter((seq) => !this.changes.has(`${sessionId}:${seq}`));
    if (fresh.length === 0) return;
    for (const seq of fresh) this.changes.set(`${sessionId}:${seq}`, 'loading');
    this.summaryQueue = [...[...fresh].reverse().map((seq) => ({ sessionId, seq })), ...this.summaryQueue];
    this.pumpSummaries();
  }

  private pumpSummaries(): void {
    const client = this.service?.client;
    if (!client) return;
    while (this.summariesInFlight < SUMMARY_CONCURRENCY) {
      const next = this.summaryQueue.shift();
      if (!next) return;
      const key = `${next.sessionId}:${next.seq}`;
      if (this.changes.get(key) !== 'loading') continue;
      this.summariesInFlight++;
      void client
        .changesSummary(next.sessionId, next.seq)
        .then(
          (summary) => this.changes.set(key, summary),
          (error: unknown) => {
            if (!(error instanceof ChangesUnavailableError)) this.options.log(`读取改动汇总失败：${describe(error)}`);
            this.changes.set(key, 'unavailable');
          },
        )
        .finally(() => {
          this.summariesInFlight--;
          this.changesVersion++;
          this.scheduleRender();
          this.pumpSummaries();
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

