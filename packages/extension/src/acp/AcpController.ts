/**
 * ACP 底层的控制器：和 dsh 的 ChatController 实现同一个接口、产出同样的视图模型，界面不区分底层。
 *
 * - 会话：`session/list` 列出（代理支持时），`session/load` 打开并回放历史，第一条消息前先 `session/new` 建好草稿会话
 *   （这样模型、模式和斜杠命令在发消息前就能用）；
 * - 发送：`session/prompt`（附带编辑器上下文和图片），一轮进行中时新消息在本地排队，结束后依次发送；停止用 `session/cancel`；
 * - 审批：代理的 `session/request_permission` 显示成审批卡片；
 * - 模型、模式：代理的 config option（category 为 model / mode / thought_level）对应模型选择和权限选择。
 *
 * 没有对应能力的功能（每轮改动汇总、子代理、dsh 的队列和插队）在界面上自然不出现。
 */
import type {
  BackendsState,
  CommandView,
  ConnectionState,
  ContextState,
  DiffRef,
  HostSnapshot,
  ImageView,
  Item,
  ModelState,
  PendingInteraction,
  PermissionState,
  PromptImage,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  SessionChangesView,
  ChangedFileView,
  TabsState,
  WebviewToHost,
} from '@harness-deck/shared';
import { isAbsolute, resolve } from 'node:path';
import type { ChatBackendController } from '../backend/types.ts';
import { getLocale, t } from '../i18n.ts';
import {
  isTemplate,
  parseSlash,
  pluginCommands,
  templatePrompt,
  withContext,
  type ContextAttachment,
  type TemplateName,
} from '../vm/context.ts';
import type { ChatControllerOptions } from '../vm/ChatController.ts';
import { reverseToolDiffs } from '../vm/diffs.ts';
import { displayPath } from '../vm/projector.ts';
import { ViewPublisher, type ControllerView } from '../vm/ViewPublisher.ts';
import { withoutDiagnostics } from '../vm/viewHelpers.ts';
import { noWorkbench, type EditorSnapshot, type Workbench } from '../vm/workbench.ts';
import { AcpError } from './connection.ts';
import { AcpSessionProjection, type AcpConfigOption, type AcpDiff, type AcpToolCall } from './projection.ts';

/** 和代理通话的接口（测试里用假的）。 */
export interface AcpLink {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
}

/** `initialize` 的结果里用到的部分。 */
export interface AcpInitialize {
  readonly protocolVersion?: number;
  readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string };
  readonly authMethods?: readonly AuthMethod[];
  readonly agentCapabilities?: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: { readonly image?: boolean; readonly embeddedContext?: boolean };
    readonly sessionCapabilities?: { readonly list?: unknown };
  };
}

/** 本地记住的会话（代理不支持列表时用；标题也存在这里）。 */
export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface AcpControllerOptions
  extends Pick<
    ChatControllerOptions,
    | 'post'
    | 'log'
    | 'workbench'
    | 'includeActiveEditor'
    | 'openExternal'
    | 'showLogs'
    | 'appearance'
    | 'backends'
    | 'openSettings'
    | 'setAppearance'
    | 'folderLabel'
    | 'selectFolder'
    | 'onModelChange'
    | 'renderDelayMs'
  > {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  /**
   * 上次选的模型和思考等级。ACP 的模型是会话级的（Claude 新会话总是 Default），
   * 新对话套用上次的选择，和看到的保持一致；已有的会话保持自己的模型。
   */
  readonly loadPreferredModel?: () => PreferredModel | undefined;
  readonly savePreferredModel?: (preferred: PreferredModel) => void;
  /** 打开的标签（会话 id，按顺序）；新对话的标签不保存。 */
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  /**
   * 代理要求登录时由宿主完成：有多种方式时让用户选，登录期间显示进度。
   * 返回 false 表示用户取消。没有提供时直接用第一种方式。
   */
  readonly authenticate?: (methods: readonly AuthMethod[], run: (methodId: string) => Promise<unknown>) => Promise<boolean>;
  /**
   * 代理一个进程只给一个会话推送实时更新（见 BackendProfile.singleSession）：
   * 在别的会话里发消息前用 restartRuntime 重启代理并加载那个会话；绑定的会话正在回复时不新建会话。
   */
  readonly singleSession?: boolean;
  /** 代理要求登录、又没有提供登录方式时显示的说明（例如 Claude：在终端登录 Claude Code）。 */
  readonly signInHint?: string;
}

export interface PreferredModel {
  readonly model: string;
  readonly effort?: string;
}

export interface AuthMethod {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
}

interface PendingPermission {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly { readonly optionId: string; readonly name?: string; readonly kind?: string }[];
  readonly resolve: (result: unknown) => void;
}

interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly images: readonly PromptImage[];
}

const MAX_TITLE = 60;

export class AcpController implements ChatBackendController {
  private link: AcpLink | undefined;
  private init: AcpInitialize | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  /** 新对话：已经建好但还没发过消息的会话。 */
  private draftId: string | undefined;
  private creatingDraft: Promise<string | undefined> | undefined;
  private readonly projections = new Map<string, AcpSessionProjection>();
  private readonly loading = new Set<string>();
  private listed: { id: string; updatedAt: number; title?: string }[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly permissions = new Map<string, PendingPermission>();
  private permissionCounter = 0;
  private queueCounter = 0;
  private pinned: (ContextAttachment & { id: string })[] = [];
  /** 单会话代理：当前进程推送实时更新的会话。 */
  private bound: string | undefined;
  /** 单会话代理：正在重启代理、等待绑定到这个会话。 */
  private rebinding: { readonly sessionId: string; readonly done: (ok: boolean) => void } | undefined;
  private pinCounter = 0;
  /** 对话面板里打开的标签；当前标签的会话就是 activeId，新对话的标签（没有 sessionId）用草稿会话。 */
  private tabs: { readonly key: string; sessionId?: string }[] = [];
  private activeTab = '';
  private tabCounter = 0;
  private workspacePath: string;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly publisher: ViewPublisher;

  constructor(private readonly options: AcpControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.stored = [...(options.loadSessions() ?? [])];
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.restoreTabs();
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  // ---------------------------------------------------------------- 连接

  /** 代理进程初始化完成（或断开，传 undefined）。 */
  setLink(link: AcpLink | undefined, init?: AcpInitialize): void {
    this.link = link;
    this.init = init;
    this.connection = link ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    // 新进程里会话要重新加载；草稿会话作废
    this.projections.clear();
    this.loading.clear();
    this.draftId = undefined;
    this.creatingDraft = undefined;
    this.bound = undefined;
    for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
    if (link) {
      void this.refreshList();
      if (this.activeId) void this.load(this.activeId);
      else void this.ensureDraft();
    }
    this.scheduleRender();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    if (status.kind === 'failed' || status.kind === 'notInstalled') this.finishRebind(false);
    this.options.post({ type: 'runtimeStatus', payload: status });
    this.scheduleRender();
  }

  /** 代理推送的 `session/update`。 */
  onSessionUpdate(params: unknown): void {
    const { sessionId, update } = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
    if (!sessionId || !update) return;
    const projection = this.projectionFor(sessionId);
    projection.apply(update);
    if (update.sessionUpdate === 'session_info_update' && projection.title) this.remember(sessionId, projection.title);
    this.scheduleRender();
  }

  /** 代理发来的请求。 */
  async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') return this.askPermission(params);
    throw new AcpError(method, -32601, `${method} is not supported by this client`);
  }

  // ---------------------------------------------------------------- 接口

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
  }

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
      backends: this.backends(),
    };
  }

  modelState(): ModelState {
    return this.modelsOf(this.currentProjection());
  }

  workspaceChanged(): void {
    this.scheduleRender();
  }

  localeChanged(): void {
    this.options.post({ type: 'locale', payload: getLocale() });
    this.scheduleRender();
  }

  appearanceChanged(): void {
    this.options.post({ type: 'appearance', payload: this.options.appearance?.() ?? {} });
  }

  backendsChanged(): void {
    this.options.post({ type: 'backends', payload: this.backends() });
  }

  setWorkspace(path: string): void {
    if (path === this.workspacePath) return;
    this.workspacePath = path;
    this.pinned = [];
    this.activeId = this.options.loadActiveSessionId();
    this.draftId = undefined;
    this.projections.clear();
    this.restoreTabs();
    if (this.link) {
      void this.refreshList();
      if (this.activeId) void this.load(this.activeId);
      else void this.ensureDraft();
    }
    this.scheduleRender();
  }

  async askAboutSelection(template: TemplateName): Promise<void> {
    const attachment = this.snapshotAttachment(this.workbench.activeEditor());
    if (!attachment) {
      this.toast('info', t('context.none'));
      return;
    }
    await this.send(templatePrompt(template, ''), { includeActive: false, extra: [attachment], diagnostics: template === 'fix' });
  }

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

  async renameSession(): Promise<void> {
    const sessionId = this.activeId;
    if (!sessionId) return;
    const title = await this.workbench.input({ title: t('rename.title'), value: this.titleOf(sessionId) });
    if (!title?.trim()) return;
    this.remember(sessionId, title.trim(), true);
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', t('acp.apiKey', this.agentName()));
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage':
        return this.send(message.payload.text, { includeActive: message.payload.includeActive ?? true, images: message.payload.images ?? [] });
      case 'searchFiles': {
        let items: { path: string; kind: 'file' | 'directory' }[] = [];
        try {
          items = await this.workbench.findFiles(message.payload.query);
        } catch (error) {
          this.options.log(`文件搜索失败：${describe(error)}`);
        }
        this.options.post({ type: 'fileCandidates', payload: { requestId: message.payload.requestId, items: items.slice(0, 50) } });
        return;
      }
      case 'removeAttachment':
        this.pinned = this.pinned.filter((p) => p.id !== message.payload.id);
        this.scheduleRender();
        return;
      case 'queueAction':
        return this.queueAction(message.payload);
      case 'renameSession':
        return this.renameSession();
      case 'configureApiKey':
        return this.configureApiKey();
      case 'selectFolder':
        this.options.selectFolder?.();
        return;
      case 'interrupt':
        return this.interrupt();
      case 'newSession':
        this.newTab();
        return;
      case 'switchSession':
        this.openSessionTab(message.payload.sessionId);
        return;
      case 'activateTab':
        this.activateTab(message.payload.key);
        return;
      case 'closeTab':
        this.closeTab(message.payload.key);
        return;
      case 'loadOlder':
      case 'retryPending':
      case 'discardPending':
      case 'previewApproval':
        return;
      case 'selectModel':
        return this.selectModel(message.payload.model, message.payload.reasoningEffort);
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
        this.toast('info', t('acp.noWebUI', this.agentName()));
        return;
      case 'respondApproval':
        this.respondApproval(message.payload.id, message.payload.decision === 'allow');
        return;
      case 'answerQuestion':
        this.toast('info', t('question.ended'));
        return;
      case 'openDiff':
        try {
          await this.openDiff(message.payload.ref);
        } finally {
          if (message.payload.token !== undefined) this.options.post({ type: 'diffOpened', payload: { token: message.payload.token } });
        }
        return;
      case 'openFile': {
        const { path, startLine, endLine } = message.payload;
        return this.workbench.openFile(this.absolute(path), startLine ? { startLine, ...(endLine ? { endLine } : {}) } : undefined);
      }
      case 'selectPermission':
        return this.setMode(message.payload.preset);
      case 'saveAll':
        return this.workbench.saveAll();
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
      case 'loadImage':
        // 历史消息里的图片：ACP 没有读取附件的方法
        this.options.post({ type: 'imageData', payload: { attachmentId: message.payload.attachmentId } });
        return;
      case 'selectBackend':
      case 'dismissBackendChoice':
        return;
    }
  }

  // ---------------------------------------------------------------- 标签
  // 和 dsh 的标签一样：只有一个新对话标签；打开已在标签里的会话时切过去；关掉最后一个标签时换成新对话。
  // ACP 的每个会话都有自己的投影，后台标签的会话继续收更新，切回时内容立即可见。

  /** 按保存的标签和上次打开的会话恢复标签；上次停在新对话时末尾加一个新对话标签。 */
  private restoreTabs(): void {
    const ids = [...new Set(this.options.loadOpenTabs?.() ?? [])];
    if (this.activeId && !ids.includes(this.activeId)) ids.push(this.activeId);
    this.tabs = ids.map((sessionId) => ({ key: this.nextTabKey(), sessionId }));
    let active = this.tabs.find((tab) => tab.sessionId === this.activeId);
    if (!active) {
      active = { key: this.nextTabKey() };
      this.tabs.push(active);
    }
    this.activeTab = active.key;
  }

  private nextTabKey(): string {
    return `acp-tab-${++this.tabCounter}`;
  }

  private saveTabs(): void {
    this.options.saveOpenTabs?.(this.tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])));
  }

  /** 新对话：已有新对话标签时切过去，否则在当前标签后面新开一个。 */
  private newTab(): void {
    const blank = this.tabs.find((tab) => !tab.sessionId);
    if (blank) return this.activateTab(blank.key);
    const tab = { key: this.nextTabKey() };
    this.tabs.splice(this.tabs.findIndex((t) => t.key === this.activeTab) + 1, 0, tab);
    this.activateTab(tab.key);
  }

  /** 打开会话：已经在标签里时切过去；当前是新对话时就在当前标签打开；否则新开一个标签。 */
  private openSessionTab(sessionId: string): void {
    const existing = this.tabs.find((tab) => tab.sessionId === sessionId);
    if (existing) return this.activateTab(existing.key);
    const current = this.tabs.find((tab) => tab.key === this.activeTab);
    if (current && !current.sessionId) return this.setActive(sessionId);
    const tab = { key: this.nextTabKey(), sessionId };
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

  /** 关闭标签：会话仍在代理里，可以从会话列表重新打开；它还在等的审批取消掉（没有地方再显示）。 */
  private closeTab(key: string): void {
    const index = this.tabs.findIndex((t) => t.key === key);
    const tab = this.tabs[index];
    if (!tab) return;
    if (tab.sessionId) {
      for (const [id, pending] of this.permissions) {
        if (pending.sessionId !== tab.sessionId) continue;
        pending.resolve({ outcome: { outcome: 'cancelled' } });
        this.permissions.delete(id);
      }
    }
    if (this.tabs.length === 1) {
      if (!tab.sessionId) return;
      this.tabs = [{ key: this.nextTabKey() }];
      this.activateTab(this.tabs[0]!.key);
      return;
    }
    this.tabs.splice(index, 1);
    if (key === this.activeTab) this.activateTab((this.tabs[index] ?? this.tabs[index - 1])!.key);
    else {
      this.saveTabs();
      this.scheduleRender();
    }
  }

  private tabsState(current: SessionHeader): TabsState {
    const waiting = new Set([...this.permissions.values()].map((p) => p.sessionId));
    const items = this.tabs.map((tab) => {
      if (tab.key === this.activeTab) {
        return { key: tab.key, ...(tab.sessionId ? { sessionId: tab.sessionId } : {}), title: current.title, running: current.running, ...(tab.sessionId && waiting.has(tab.sessionId) ? { needsAttention: true } : {}) };
      }
      if (!tab.sessionId) return { key: tab.key, title: t('session.new'), running: false };
      return {
        key: tab.key,
        sessionId: tab.sessionId,
        title: this.titleOf(tab.sessionId),
        running: this.projections.get(tab.sessionId)?.running ?? false,
        ...(waiting.has(tab.sessionId) ? { needsAttention: true } : {}),
      };
    });
    return { items, active: this.activeTab };
  }

  /** 当前标签显示的会话（undefined 为新对话）；同一个会话不同时出现在两个标签里。 */
  private setTabSession(sessionId: string | undefined): void {
    const tab = this.tabs.find((t) => t.key === this.activeTab);
    if (!tab || tab.sessionId === sessionId) return;
    if (sessionId) this.tabs = this.tabs.filter((t) => t === tab || t.sessionId !== sessionId);
    tab.sessionId = sessionId;
    this.saveTabs();
  }

  // ---------------------------------------------------------------- 会话

  private setActive(sessionId: string | undefined): void {
    this.setTabSession(sessionId);
    if (sessionId === this.activeId && (sessionId !== undefined || this.draftId !== undefined)) return;
    this.activeId = sessionId;
    this.options.saveActiveSessionId(sessionId);
    if (sessionId) void this.load(sessionId);
    else void this.ensureDraft();
    this.scheduleRender();
  }

  /** 打开会话：同一个进程里已经加载过的直接显示，否则用 session/load 回放历史。 */
  private async load(sessionId: string): Promise<void> {
    const link = this.link;
    if (!link || this.projections.has(sessionId) || this.loading.has(sessionId)) return;
    if (!this.init?.agentCapabilities?.loadSession) {
      this.toast('info', t('acp.noLoad', this.agentName()));
      return;
    }
    this.loading.add(sessionId);
    const projection = this.projectionFor(sessionId);
    projection.reset();
    this.scheduleRender();
    try {
      const result = await link.request<{ configOptions?: AcpConfigOption[] } | null>('session/load', { sessionId, cwd: this.workspacePath, mcpServers: [] });
      projection.setConfigOptions(result?.configOptions);
      // 新进程里第一个加载的会话收到实时更新
      if (this.options.singleSession && this.link === link && this.bound === undefined) this.bound = sessionId;
      if (this.rebinding?.sessionId === sessionId) this.finishRebind(this.bound === sessionId);
    } catch (error) {
      if (this.rebinding?.sessionId === sessionId) this.finishRebind(false);
      this.options.log(`打开会话 ${sessionId} 失败：${describe(error)}`);
      this.toast('error', t('acp.loadFailed', describe(error)));
      this.projections.delete(sessionId);
      if (this.activeId === sessionId) this.setActive(undefined);
    } finally {
      this.loading.delete(sessionId);
      this.scheduleRender();
    }
  }

  /** 新对话的草稿会话：建好后模型、模式和斜杠命令就能用了。 */
  private ensureDraft(): Promise<string | undefined> {
    // 单会话代理：新建会话会把实时更新从正在回复的会话抢走，等这一轮结束再建（prompt 结束时补上）
    if (this.boundBusy()) return Promise.resolve(undefined);
    if (this.draftId) return Promise.resolve(this.draftId);
    if (this.creatingDraft) return this.creatingDraft;
    const link = this.link;
    if (!link) return Promise.resolve(undefined);
    this.creatingDraft = this.newSession(link)
      .then(
        async (id) => {
          if (this.link !== link) return id;
          this.draftId = id;
          await this.applyPreferredModel(id);
          return id;
        },
        (error: unknown) => {
          this.options.log(`新建会话失败：${describe(error)}`);
          this.toast('error', t('acp.newFailed', describe(error)));
          return undefined;
        },
      )
      .finally(() => {
        this.creatingDraft = undefined;
        this.scheduleRender();
      });
    return this.creatingDraft;
  }

  /**
   * `session/new`；代理要求认证（-32000）时登录后再试一次。
   * 只有一种方式时直接用（omp：用已有的本地凭据）；有多种时由宿主让用户选（CodeBuddy：浏览器登录，可能要几分钟）。
   */
  private async newSession(link: AcpLink): Promise<string> {
    const params = { cwd: this.workspacePath, mcpServers: [] };
    let result: { sessionId: string; configOptions?: AcpConfigOption[] };
    try {
      result = await link.request('session/new', params);
    } catch (error) {
      if (!isAuthRequired(error)) throw error;
      if (!(await this.signIn(link))) throw new Error(this.authRequiredText(error));
      result = await link.request('session/new', params);
    }
    this.projectionFor(result.sessionId).setConfigOptions(result.configOptions);
    if (this.options.singleSession && this.link === link) this.bound = result.sessionId;
    return result.sessionId;
  }

  /**
   * 代理要求登录（-32000）：有登录方式时登录（多种时由宿主让用户选）。
   * @returns 登录完成；代理没有登录方式或用户取消时为 false。
   */
  private async signIn(link: AcpLink): Promise<boolean> {
    const methods = this.init?.authMethods ?? [];
    if (methods.length === 0) return false;
    const run = (methodId: string) => link.request('authenticate', { methodId });
    if (this.options.authenticate) {
      if (!(await this.options.authenticate(methods, run))) throw new Error(t('acp.signInCancelled'));
    } else {
      await run(methods[0]!.id);
    }
    return true;
  }

  /** 需要登录时给用户看的说明：底层配置里的提示（Claude），没有时用代理返回的原话。 */
  private authRequiredText(error?: unknown): string {
    return t('acp.authRequired', this.agentName(), this.options.signInHint ?? (error ? describe(error) : ''));
  }

  private async refreshList(): Promise<void> {
    const link = this.link;
    if (!link || this.init?.agentCapabilities?.sessionCapabilities?.list === undefined) return;
    try {
      const result = await link.request<{ sessions?: { sessionId: string; cwd?: string; updatedAt?: string; title?: string | null }[] }>('session/list', { cwd: this.workspacePath });
      this.listed = (result?.sessions ?? [])
        .filter((s) => !s.cwd || s.cwd === this.workspacePath)
        .map((s) => ({ id: s.sessionId, updatedAt: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0, ...(s.title ? { title: s.title } : {}) }));
      this.scheduleRender();
    } catch (error) {
      this.options.log(`读取会话列表失败：${describe(error)}`);
    }
  }

  private projectionFor(sessionId: string): AcpSessionProjection {
    let projection = this.projections.get(sessionId);
    if (!projection) {
      projection = new AcpSessionProjection(this.workspacePath);
      this.projections.set(sessionId, projection);
    }
    return projection;
  }

  /** 当前显示的会话 id（新对话时是草稿会话）。 */
  private currentId(): string | undefined {
    return this.activeId ?? this.draftId;
  }

  private currentProjection(): AcpSessionProjection | undefined {
    const id = this.currentId();
    return id ? this.projections.get(id) : undefined;
  }

  /** 记住会话标题（第一条消息或代理给的标题）；`force` 用于手动重命名。 */
  private remember(sessionId: string, title: string, force = false): void {
    const existing = this.stored.find((s) => s.id === sessionId);
    if (existing && !force && existing.title) {
      this.stored = this.stored.map((s) => (s.id === sessionId ? { ...s, updatedAt: Date.now() } : s));
    } else {
      const clean = title.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE);
      this.stored = [{ id: sessionId, title: clean, updatedAt: Date.now() }, ...this.stored.filter((s) => s.id !== sessionId)];
    }
    this.options.saveSessions(this.stored.slice(0, 200));
  }

  private titleOf(sessionId: string | undefined): string {
    if (!sessionId) return t('session.new');
    return this.stored.find((s) => s.id === sessionId)?.title || this.projections.get(sessionId)?.title || this.listed.find((s) => s.id === sessionId)?.title || t('acp.untitled');
  }

  // ---------------------------------------------------------------- 发送

  async send(text: string, options: { includeActive?: boolean; extra?: readonly ContextAttachment[]; diagnostics?: boolean; images?: readonly PromptImage[] } = {}): Promise<void> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.newTab();
      if (slash.args.trim()) await this.send(slash.args, options);
      return;
    }
    // 计划模式的标记点击后发 /plan off；代理有 plan 模式时切换模式
    if (slash?.name === 'plan' && this.modeOption()?.options?.some((o) => o.value === 'plan')) {
      await this.setMode(slash.args.trim() === 'off' ? (this.modeOption()?.options?.find((o) => o.value !== 'plan')?.value ?? 'default') : 'plan');
      if (slash.args.trim() && slash.args.trim() !== 'off') await this.send(slash.args, options);
      return;
    }
    let prompt = text;
    let attachments: ContextAttachment[];
    if (slash && isTemplate(slash.name)) {
      attachments = this.gatherContext({ ...options, diagnostics: options.diagnostics ?? slash.name === 'fix' });
      if (attachments.length === 0 && !slash.args.trim()) {
        this.toast('info', t('template.needsContext', slash.name));
        return;
      }
      prompt = templatePrompt(slash.name, slash.args);
    } else {
      // 代理自己的斜杠命令照原样发送（ACP 里命令就是以 / 开头的消息）
      attachments = slash ? [] : this.gatherContext(options);
    }
    const full = withContext(prompt, attachments, this.workspacePath);
    if (this.pinned.length) this.pinned = [];
    const link = this.link;
    if (!link) {
      this.toast('error', t('notConnected'));
      return;
    }
    if (this.options.singleSession && this.boundBusy() && this.activeId !== this.bound) {
      // 另一个会话正在回复：这个代理同一时间只能进行一个会话
      this.toast('info', t('acp.singleSessionBusy', this.agentName()));
      return;
    }
    if (this.activeId && !(await this.bindTo(this.activeId))) return;
    const sessionId = this.activeId ?? (await this.ensureDraft());
    if (!sessionId) return;
    if (!this.activeId) {
      // 草稿会话收到第一条消息：成为正式会话，标签记住它
      this.activeId = sessionId;
      this.draftId = undefined;
      this.options.saveActiveSessionId(sessionId);
      this.setTabSession(sessionId);
      this.remember(sessionId, prompt || t('acp.image'));
    }
    const projection = this.projectionFor(sessionId);
    const images = options.images ?? [];
    if (projection.running) {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ id: `q${++this.queueCounter}`, text: full, images });
      this.queues.set(sessionId, queue);
      this.scheduleRender();
      return;
    }
    await this.prompt(this.link ?? link, sessionId, full, images);
  }

  // ---------------------------------------------------------------- 单会话代理

  /** 绑定的会话正在回复。 */
  private boundBusy(): boolean {
    return this.options.singleSession === true && this.bound !== undefined && (this.projections.get(this.bound)?.running ?? false);
  }

  /**
   * 单会话代理：要在没有绑定的会话里发消息时，重启代理，新进程第一个加载这个会话，于是收得到实时更新。
   * 其他代理直接返回 true。
   */
  private async bindTo(sessionId: string): Promise<boolean> {
    if (!this.options.singleSession || this.bound === sessionId || this.bound === undefined) return true;
    this.options.log(`${this.agentName()} 只给一个会话推送更新：重启后加载会话 ${sessionId}`);
    this.finishRebind(false);
    const bound = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.finishRebind(false), 60_000);
      this.rebinding = {
        sessionId,
        done: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
    this.options.restartRuntime();
    const ok = await bound;
    if (!ok) this.toast('error', t('acp.rebindFailed', this.agentName()));
    return ok;
  }

  private finishRebind(ok: boolean): void {
    const pending = this.rebinding;
    this.rebinding = undefined;
    pending?.done(ok);
  }

  private async prompt(link: AcpLink, sessionId: string, text: string, images: readonly PromptImage[]): Promise<void> {
    const projection = this.projectionFor(sessionId);
    const allowImages = this.init?.agentCapabilities?.promptCapabilities?.image === true;
    if (images.length && !allowImages) this.toast('info', t('acp.noImages', this.agentName()));
    const sent = allowImages ? images : [];
    projection.addUserMessage(
      text,
      sent.map((image): ImageView => ({ localId: image.localId, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })),
    );
    projection.startTurn(Date.now());
    this.scheduleRender();
    const content = [
      ...(text.trim() ? [{ type: 'text', text }] : []),
      ...sent.map((image) => ({ type: 'image', mimeType: image.mediaType, data: image.data })),
    ];
    const send = () => link.request<{ stopReason?: string } | null>('session/prompt', { sessionId, prompt: content });
    try {
      let result: { stopReason?: string } | null;
      try {
        result = await send();
      } catch (error) {
        // 登录过期或还没登录（Claude 在发消息时才发现）：能登录就登录后重发这一轮
        if (!isAuthRequired(error) || !(await this.signIn(link).catch(() => false))) throw error;
        result = await send();
      }
      projection.endTurn(Date.now(), result?.stopReason ?? 'end_turn');
    } catch (error) {
      projection.endTurn(Date.now(), undefined, isAuthRequired(error) ? this.authRequiredText(error) : describe(error));
    }
    this.remember(sessionId, this.titleOf(sessionId));
    void this.refreshList();
    this.scheduleRender();
    // 本地排队的消息：上一轮结束后依次发送
    const next = this.queues.get(sessionId)?.shift();
    if (next && this.link) await this.prompt(this.link, sessionId, next.text, next.images);
    // 单会话代理：回复期间点了新对话，草稿会话这时才建
    else if (this.options.singleSession && this.link && this.activeId === undefined && this.draftId === undefined) void this.ensureDraft();
  }

  private async interrupt(): Promise<void> {
    const sessionId = this.currentId();
    if (!sessionId || !this.link) return;
    for (const [id, pending] of this.permissions) {
      if (pending.sessionId !== sessionId) continue;
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.permissions.delete(id);
    }
    this.link.notify('session/cancel', { sessionId });
    this.scheduleRender();
  }

  private queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): void {
    const sessionId = this.currentId();
    const queue = sessionId ? this.queues.get(sessionId) : undefined;
    if (!sessionId || !queue) return;
    const index = queue.findIndex((q) => q.id === payload.itemId);
    if (index < 0) return;
    if (payload.action === 'remove') queue.splice(index, 1);
    else if (payload.action === 'edit') queue[index] = { ...queue[index]!, text: payload.text };
    else if (payload.action === 'send' || payload.action === 'steer') {
      // 没有插队：移到队首，当前回复结束后最先发送
      const [item] = queue.splice(index, 1);
      queue.unshift(item!);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型、模式

  private modelOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return projection?.configOptions.find((o) => o.category === 'model' || o.id === 'model');
  }

  private effortOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return projection?.configOptions.find((o) => o.category === 'thought_level' || o.id === 'thought_level' || o.id === 'reasoning_effort');
  }

  private modeOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return projection?.configOptions.find((o) => o.category === 'mode' || o.id === 'mode');
  }

  private modelsOf(projection: AcpSessionProjection | undefined): ModelState {
    const model = this.modelOption(projection);
    if (!model?.options?.length) return { options: [] };
    const effort = this.effortOption(projection);
    const efforts = (effort?.options ?? []).map((o) => ({ id: o.value, name: o.name ?? o.value }));
    // 当前模型不在代理给的选项里（CodeBuddy 接第三方模型、命令行 --model 指定）：补在最前面，选择器才显示得出来
    const current = model.currentValue;
    const options = current && !model.options.some((o) => o.value === current) ? [{ value: current, name: current }, ...model.options] : model.options;
    return {
      options: options.map((o: { value: string; name?: string; description?: string }) => ({
        provider: 'acp',
        model: o.value,
        name: o.name ?? o.value,
        group: o.value.includes('/') ? o.value.slice(0, o.value.indexOf('/')) : this.agentName(),
        ...(o.description && o.description !== o.value ? { description: o.description } : {}),
        // 思考等级是会话级的设置：挂在当前模型下
        efforts: o.value === model.currentValue ? efforts : [],
        ...(o.value === model.currentValue && effort?.currentValue ? { defaultEffort: effort.currentValue } : {}),
      })),
      ...(model.currentValue ? { current: { provider: 'acp', model: model.currentValue, ...(effort?.currentValue ? { reasoningEffort: effort.currentValue } : {}) } } : {}),
    };
  }

  private async selectModel(model: string, effort?: string): Promise<void> {
    const sessionId = this.currentId() ?? (await this.ensureDraft());
    const option = this.modelOption();
    if (!sessionId || !option) return;
    try {
      if (model !== option.currentValue) await this.setOption(sessionId, option.id, model);
      const effortOption = this.effortOption();
      if (effort && effortOption && effort !== effortOption.currentValue) await this.setOption(sessionId, effortOption.id, effort);
      this.options.savePreferredModel?.({ model, ...(effort ? { effort } : {}) });
      // 已经建好、还没用过的草稿会话也换过来
      if (this.draftId && this.draftId !== sessionId) await this.applyPreferredModel(this.draftId);
    } catch (error) {
      this.toast('error', t('model.failed', describe(error)));
    }
  }

  /** 新对话（草稿会话）套用上次选的模型和思考等级；代理没有这个选项时不动。 */
  private async applyPreferredModel(sessionId: string): Promise<void> {
    const preferred = this.options.loadPreferredModel?.();
    const projection = this.projections.get(sessionId);
    if (!preferred || !projection || projection.snapshotItems().length > 0) return;
    try {
      const model = this.modelOption(projection);
      if (model && model.currentValue !== preferred.model && model.options?.some((o) => o.value === preferred.model)) {
        await this.setOption(sessionId, model.id, preferred.model);
      }
      // 思考等级的选项随模型变化：换完模型再看
      const effort = this.effortOption(this.projections.get(sessionId));
      if (preferred.effort && effort && effort.currentValue !== preferred.effort && effort.options?.some((o) => o.value === preferred.effort)) {
        await this.setOption(sessionId, effort.id, preferred.effort);
      }
    } catch (error) {
      this.options.log(`新对话套用上次的模型失败：${describe(error)}`);
    }
  }

  private async setMode(mode: string): Promise<void> {
    const sessionId = this.currentId() ?? (await this.ensureDraft());
    const option = this.modeOption();
    if (!sessionId || !option || option.currentValue === mode) return;
    try {
      await this.setOption(sessionId, option.id, mode);
    } catch (error) {
      this.toast('error', t('permission.failed', describe(error)));
    }
  }

  private async setOption(sessionId: string, configId: string, value: string): Promise<void> {
    const result = await this.link?.request<{ configOptions?: AcpConfigOption[] } | null>('session/set_config_option', { sessionId, configId, value });
    this.projectionFor(sessionId).setConfigOptions(result?.configOptions);
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 审批

  private askPermission(params: unknown): Promise<unknown> {
    const { sessionId, toolCall, options } = (params ?? {}) as { sessionId?: string; toolCall?: AcpToolCall; options?: PendingPermission['options'] };
    if (!sessionId || !toolCall || !options?.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    // 请求里可能只有 toolCallId 和参数（CodeBuddy）：用已经收到的工具调用补上标题、类型和位置
    const known = this.projections.get(sessionId)?.toolCall(toolCall.toolCallId);
    const call: AcpToolCall = known ? { ...known, ...Object.fromEntries(Object.entries(toolCall).filter(([, v]) => v !== undefined && v !== null)) } : toolCall;
    return new Promise((resolvePermission) => {
      const id = `perm-${++this.permissionCounter}`;
      this.permissions.set(id, { id, sessionId, toolCall: call, options, resolve: resolvePermission });
      this.scheduleRender();
    });
  }

  private respondApproval(id: string, allow: boolean): void {
    const pending = this.permissions.get(id);
    if (!pending) {
      this.toast('info', t('request.ended'));
      return;
    }
    const pick = (prefix: string) => pending.options.find((o) => o.kind === `${prefix}_once`) ?? pending.options.find((o) => o.kind?.startsWith(prefix));
    const option = allow ? pick('allow') : pick('reject');
    this.permissions.delete(id);
    pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
    this.scheduleRender();
  }

  private interactionOf(pending: PendingPermission): PendingInteraction {
    const call = pending.toolCall;
    const args = (call.rawInput ?? {}) as { command?: unknown; file_path?: unknown; path?: unknown };
    const path = call.locations?.[0]?.path ?? (typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined);
    const subject =
      typeof args.command === 'string' && args.command.trim()
        ? { subject: args.command.trim(), subjectKind: 'command' as const }
        : path
          ? { subject: displayPath(path, this.workspacePath), subjectKind: 'file' as const }
          : undefined;
    return {
      kind: 'approval',
      id: pending.id,
      toolName: call.name ?? call.kind ?? 'tool',
      reason: call.title ?? '',
      ...(subject ?? {}),
      previewable: false,
      dirtyFiles: [],
    };
  }

  // ---------------------------------------------------------------- Diff

  private async openDiff(ref: DiffRef): Promise<void> {
    if (ref.kind === 'session') return this.openSessionDiff(ref.path);
    if (ref.kind !== 'tool') return;
    const diffs = this.currentProjection()?.diffsOf(ref.callId) ?? [];
    const diff = diffs[0];
    if (!diff) {
      this.toast('info', t('diff.noRecord'));
      return;
    }
    const path = this.absolute(diff.path);
    // 磁盘上的文件就是修改后的内容时右侧用真实文件（可以继续编辑）
    const current = await this.workbench.readFile(path);
    const created = diff.oldText === null;
    const whole = wholeFile(diff, current);
    await this.workbench.openDiff({
      kind: 'contents',
      path,
      before: whole ?? diff.oldText ?? '',
      ...(whole !== undefined || current === diff.newText ? {} : { after: diff.newText }),
      created,
      scope: 'turn',
    });
  }

  /**
   * 本会话对一个文件的累计改动：从磁盘上的当前内容倒着撤回这个会话的每次修改，还原出会话开始前的内容。
   * 中途被别的方式改过、撤不回去时，改为显示最后一次修改。
   */
  private async openSessionDiff(path: string): Promise<void> {
    const change = this.currentProjection()
      ?.fileChanges()
      .find((f) => this.absolute(f.path) === path);
    if (!change || change.diffs.length === 0) return this.workbench.openFile(path);
    const current = await this.workbench.readFile(path);
    const before = current === undefined ? undefined : reverseToolDiffs(current, change.diffs);
    if (before !== undefined) {
      await this.workbench.openDiff({ kind: 'contents', path, before: change.created ? '' : before, created: change.created, scope: 'session' });
      return;
    }
    this.options.log(`无法还原 ${path} 在本会话修改前的内容，改为显示最后一次修改`);
    const last = change.calls.at(-1);
    if (last) return this.openDiff({ kind: 'tool', callId: last });
    return this.workbench.openFile(path);
  }

  /** 输入框上方的改动栏：本会话改过的文件和增删行数。 */
  private sessionChanges(projection: AcpSessionProjection | undefined): SessionChangesView | undefined {
    const files = projection?.fileChanges() ?? [];
    if (files.length === 0) return undefined;
    const views: ChangedFileView[] = files.map((f) => {
      const path = this.absolute(f.path);
      return {
        path: displayPath(path, this.workspacePath),
        ref: { kind: 'session', path },
        additions: f.additions,
        deletions: f.deletions,
        ...(f.created ? { created: true } : {}),
      };
    });
    return { files: views, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) };
  }

  // ---------------------------------------------------------------- 视图

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, this.options.renderDelayMs ?? 30);
  }

  render(): void {
    this.publisher.publish(this.compute());
  }

  private compute(): ControllerView {
    const sessionId = this.currentId();
    const projection = this.currentProjection();
    const running = projection?.running ?? false;
    const queue = sessionId ? (this.queues.get(sessionId) ?? []) : [];
    const items: Item[] = [
      ...(projection?.snapshotItems() ?? []),
      ...queue.map((q): Item => ({ kind: 'user', id: `q:${q.id}`, text: q.text.replace(/\n*<ide_context[\s\S]*$/u, ''), pending: 'queued', queue: { itemId: q.id, target: 'next-turn' } })),
    ];
    const usage = projection?.usage;
    const mode = this.modeOption(projection);
    const session: SessionHeader = {
      ...(this.activeId ? { id: this.activeId } : {}),
      title: this.titleOf(this.activeId),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !this.activeId ? 'idle' : this.loading.has(this.activeId) || !this.link ? 'opening' : 'live',
      ...(usage ? { contextUsage: Math.min(1, usage.used / usage.size), contextTokens: { used: usage.used, window: usage.size } } : {}),
      ...(mode?.currentValue === 'plan' ? { planMode: true } : {}),
      ...(projection?.todos?.length ? { todos: projection.todos } : {}),
      ...(running && projection?.runningSince !== undefined ? { runningSince: projection.runningSince } : {}),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
      ...(() => {
        const changes = this.sessionChanges(projection);
        return changes ? { changes } : {};
      })(),
    };
    const known = new Map<string, SessionListItem>();
    for (const s of this.listed) known.set(s.id, { id: s.id, title: this.titleOf(s.id), updatedAt: s.updatedAt, running: this.projections.get(s.id)?.running ?? false });
    for (const s of this.stored) {
      if (!known.has(s.id) && (this.init?.agentCapabilities?.sessionCapabilities?.list === undefined || this.projections.has(s.id))) {
        known.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt, running: this.projections.get(s.id)?.running ?? false });
      }
    }
    const sessions = [...known.values()].filter((s) => s.id !== this.draftId).sort((a, b) => b.updatedAt - a.updatedAt);
    const interactions = [...this.permissions.values()].filter((p) => p.sessionId === sessionId).map((p) => this.interactionOf(p));
    const permissions: PermissionState = {
      options: (mode?.options ?? []).map((o) => o.value),
      ...(mode?.currentValue ? { current: mode.currentValue } : {}),
      labels: Object.fromEntries((mode?.options ?? []).map((o) => [o.value, { name: o.name ?? o.value, ...(o.description ? { description: o.description } : {}) }])),
    };
    const commands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...(projection?.commands ?? []).map((c) => ({
        name: c.name,
        description: c.description ?? '',
        ...(c.input?.hint ? { hint: c.input.hint } : {}),
        source: c._meta?.type === 'skill' ? ('skill' as const) : ('dsh' as const),
      })),
    ];
    return {
      sessionKey: this.activeId ?? '',
      sessions,
      tabs: this.tabsState(session),
      session,
      items,
      models: this.modelsOf(projection),
      interactions,
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.contextState(),
      commands,
    };
  }

  // ---------------------------------------------------------------- 上下文

  private snapshotAttachment(editor: EditorSnapshot | undefined): ContextAttachment | undefined {
    if (!editor) return undefined;
    if (!editor.selection) return { kind: 'file', path: editor.path };
    const { startLine, endLine, text, diagnostics } = editor.selection;
    return { kind: 'selection', path: editor.path, startLine, endLine, languageId: editor.languageId, text, ...(diagnostics.length ? { diagnostics } : {}) };
  }

  private gatherContext(options: { includeActive?: boolean; extra?: readonly ContextAttachment[]; diagnostics?: boolean }): ContextAttachment[] {
    const active = options.includeActive !== false ? this.snapshotAttachment(this.workbench.activeEditor()) : undefined;
    const all = [...this.pinned.map(({ id: _id, ...rest }) => rest as ContextAttachment), ...(options.extra ?? []), ...(active ? [active] : [])];
    return options.diagnostics ? all : all.map((a) => (a.kind === 'selection' ? withoutDiagnostics(a) : a));
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

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspacePath, path);
  }

  private backends(): BackendsState {
    return this.options.backends?.() ?? { items: [], active: '' };
  }

  private agentName(): string {
    const state = this.backends();
    return state.items.find((b) => b.id === state.active)?.name ?? this.init?.agentInfo?.title ?? this.init?.agentInfo?.name ?? 'ACP';
  }

  private toast(level: 'info' | 'error', text: string): void {
    this.options.post({ type: 'toast', payload: { level, text } });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 代理只给了替换的片段（CodeBuddy 的 Edit：old_string → new_string）时，用磁盘上的文件还原整个文件的修改前内容，
 * 这样 Diff 显示整个文件、右侧是真实文件。片段在文件里不是正好出现一次（之后又改过）时返回 undefined，只显示片段。
 */
export function wholeFile(diff: AcpDiff, current: string | undefined): string | undefined {
  if (current === undefined || diff.oldText === null || current === diff.newText || !diff.newText) return undefined;
  const at = current.indexOf(diff.newText);
  if (at < 0 || current.indexOf(diff.newText, at + 1) >= 0) return undefined;
  return current.slice(0, at) + diff.oldText + current.slice(at + diff.newText.length);
}

/** ACP 的「需要认证」错误（RequestError.authRequired，-32000）。 */
function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpError && error.code === -32000;
}
