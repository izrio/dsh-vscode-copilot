/**
 * 会话服务：绑定在一个已连接的 DshClient 上（连接断开后整个服务作废，由上层在新连接上重建）。
 *
 * - 会话列表：`session/list`，只保留当前工作区目录下、非子 Agent 的会话；收到 `api-session/*` 通知时刷新；
 * - 投影（标题、当前模型、上下文用量等）：列表项自带缓存值，`session/control` 流推送实时更新；
 * - 发送、停止、选择模型；
 * - 本地回显：发送后立即显示用户消息，等持久的 user/message（source.rpcId 等于 requestId）到达后撤掉。
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import type { DshClient, ModelCatalog, ModelSelection, PermissionCatalog, SessionSummaryWire } from './DshClient.ts';
import { isMethodUnavailable } from './remote/errors.ts';

export type Projections = Readonly<Record<string, unknown>>;

export interface PendingPrompt {
  readonly requestId: string;
  readonly text: string;
  readonly sentAt: number;
  readonly state: 'sending' | 'accepted' | 'failed';
  readonly error?: string;
}

export interface SessionServiceOptions {
  readonly client: DshClient;
  /** 当前 VS Code 工作区文件夹的绝对路径。 */
  readonly workspacePath: string;
  readonly onChange: () => void;
  readonly log?: (line: string) => void;
}

const LIST_EVENTS = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity'];

export class SessionService {
  private workspaceId: string | undefined;
  private summaries: SessionSummaryWire[] = [];
  private readonly projectionValues = new Map<string, Record<string, unknown>>();
  private readonly pendingBySession = new Map<string, PendingPrompt[]>();
  private catalog: ModelCatalog | undefined;
  private permissionCatalog: PermissionCatalog | undefined;
  private readonly abort = new AbortController();
  private readonly disposers: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;

  constructor(private readonly options: SessionServiceOptions) {}

  /** init 已完成：会话列表和模型目录可用。 */
  get initialized(): boolean {
    return this.ready;
  }

  get client(): DshClient {
    return this.options.client;
  }

  get models(): ModelCatalog | undefined {
    return this.catalog;
  }

  get permissions(): PermissionCatalog | undefined {
    return this.permissionCatalog;
  }

  /** 当前工作区的会话，按最近更新排序；空白会话不列出。 */
  get sessions(): readonly SessionSummaryWire[] {
    return this.summaries;
  }

  /** 重新读取模型目录（例如刚配置了 API Key）。 */
  async reloadModels(): Promise<void> {
    this.catalog = await this.client.modelCatalog();
    this.options.onChange();
  }

  /** 重命名并立即更新本地标题（dsh 也会通过 session/control 推送）。 */
  async rename(sessionId: string, title: string): Promise<void> {
    const accepted = await this.client.rename(sessionId, title);
    this.projectionValues.set(sessionId, { ...this.projectionValues.get(sessionId), title: accepted });
    this.options.onChange();
  }

  async init(): Promise<void> {
    const { workspaceId } = await this.client.ensureWorkspace(this.options.workspacePath);
    this.workspaceId = workspaceId;
    for (const event of LIST_EVENTS) {
      this.disposers.push(this.client.events.onEmit(event, () => this.scheduleRefresh()));
    }
    await Promise.all([
      this.refreshList(),
      this.client.modelCatalog().then(
        (catalog) => {
          this.catalog = catalog;
        },
        (error: unknown) => this.log(`读取模型目录失败：${describe(error)}`),
      ),
      this.client.permissionCatalog().then(
        (catalog) => {
          this.permissionCatalog = catalog;
        },
        (error: unknown) => this.log(`读取权限预设失败：${describe(error)}`),
      ),
    ]);
    void this.followControl();
    this.ready = true;
    this.options.onChange();
  }

  dispose(): void {
    this.abort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const dispose of this.disposers) dispose();
  }

  projections(sessionId: string): Projections {
    return this.projectionValues.get(sessionId) ?? {};
  }

  /** follow 快照里带的投影基线。 */
  acceptSnapshotProjections(sessionId: string, baseline: unknown): void {
    const values = projectionValuesOf(baseline);
    if (!values) return;
    this.projectionValues.set(sessionId, { ...this.projectionValues.get(sessionId), ...values });
    this.options.onChange();
  }

  pending(sessionId: string): readonly PendingPrompt[] {
    return this.pendingBySession.get(sessionId) ?? [];
  }

  /** 撤掉已经出现在持久历史里的本地回显。 */
  retirePending(sessionId: string, persistedRequestIds: ReadonlySet<string>): void {
    const list = this.pendingBySession.get(sessionId);
    if (!list) return;
    const remaining = list.filter((item) => !persistedRequestIds.has(item.requestId));
    if (remaining.length !== list.length) {
      this.pendingBySession.set(sessionId, remaining);
      this.options.onChange();
    }
  }

  async createSession(): Promise<string> {
    const sessionId = await this.client.createSession({ ...(this.workspaceId ? { workspaceId: this.workspaceId } : { cwd: this.options.workspacePath }) });
    this.scheduleRefresh();
    return sessionId;
  }

  /**
   * 发送一条消息。立即加入本地回显；失败时回显标记为失败，可以重试。
   * @returns requestId。
   */
  async prompt(sessionId: string, text: string, requestId: string = randomUUID()): Promise<string> {
    this.setPending(sessionId, requestId, { requestId, text, sentAt: Date.now(), state: 'sending' });
    try {
      await this.client.prompt(sessionId, text, requestId);
      this.updatePending(sessionId, requestId, { state: 'accepted' });
    } catch (error) {
      this.updatePending(sessionId, requestId, { state: 'failed', error: describe(error) });
      throw error;
    }
    return requestId;
  }

  discardPending(sessionId: string, requestId: string): void {
    const list = this.pendingBySession.get(sessionId) ?? [];
    this.pendingBySession.set(sessionId, list.filter((item) => item.requestId !== requestId));
    this.options.onChange();
  }

  cancel(sessionId: string): Promise<void> {
    return this.client.cancel(sessionId);
  }

  async selectModel(sessionId: string, selection: ModelSelection): Promise<void> {
    const selected = await this.client.selectModel(sessionId, selection);
    const current = this.projectionValues.get(sessionId) ?? {};
    const modelSelection = (current.modelSelection as Record<string, unknown> | undefined) ?? {};
    this.projectionValues.set(sessionId, { ...current, modelSelection: { ...modelSelection, next: selected } });
    this.options.onChange();
  }

  /**
   * 切换会话的权限预设（`/permission <preset>`）。dsh 通过 session/control 推送新值，这里先乐观更新。
   * @throws Error dsh 拒绝时，消息是 dsh 给出的原因。
   */
  async setPermission(sessionId: string, preset: string): Promise<void> {
    const result = await this.client.executeCommand(sessionId, `/permission ${preset}`);
    if (result.kind !== 'success') throw new Error(result.text ?? `无法切换到 ${preset}`);
    const current = this.projectionValues.get(sessionId) ?? {};
    this.projectionValues.set(sessionId, { ...current, permissions: { ...(current.permissions as object | undefined), currentValue: preset } });
    this.options.onChange();
  }

  private setPending(sessionId: string, requestId: string, value: PendingPrompt): void {
    const list = (this.pendingBySession.get(sessionId) ?? []).filter((item) => item.requestId !== requestId);
    this.pendingBySession.set(sessionId, [...list, value]);
    this.options.onChange();
  }

  private updatePending(sessionId: string, requestId: string, patch: Partial<PendingPrompt>): void {
    const list = this.pendingBySession.get(sessionId);
    if (!list) return;
    this.pendingBySession.set(sessionId, list.map((item) => (item.requestId === requestId ? { ...item, ...patch } : item)));
    this.options.onChange();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshList();
    }, 150);
  }

  private async refreshList(): Promise<void> {
    try {
      const all = await this.client.listSessions(this.abort.signal);
      this.summaries = all
        .filter((summary) => !summary.blank && summary.origin !== 'subagent' && !summary.parentSessionId)
        .filter((summary) => isInside(this.options.workspacePath, summary.cwd))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const summary of this.summaries) {
        const values = projectionValuesOf(summary.projections);
        // 列表里的是缓存值，只补充缺失的键，不覆盖实时投影
        if (values) this.projectionValues.set(summary.sessionId, { ...values, ...this.projectionValues.get(summary.sessionId) });
      }
      this.options.onChange();
    } catch (error) {
      if (!this.abort.signal.aborted) this.log(`刷新会话列表失败：${describe(error)}`);
    }
  }

  private async followControl(): Promise<void> {
    try {
      for await (const frame of this.client.control(this.abort.signal, (line) => this.log(line))) {
        if (frame.type === 'baseline') {
          for (const [sessionId, baseline] of Object.entries(frame.value.projections)) {
            const values = projectionValuesOf(baseline);
            if (values) this.projectionValues.set(sessionId, { ...this.projectionValues.get(sessionId), ...values });
          }
        } else {
          const values = { ...this.projectionValues.get(frame.sessionId) };
          for (const change of frame.changes) values[change.key] = change.value;
          this.projectionValues.set(frame.sessionId, values);
        }
        this.options.onChange();
      }
    } catch (error) {
      if (!this.abort.signal.aborted && !isMethodUnavailable(error)) this.log(`session/control 结束：${describe(error)}`);
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

/** 投影基线的两种形态：`{ kind: 'sequenced', asOfSeq, values }` 或直接是 `{ values }`。 */
function projectionValuesOf(baseline: unknown): Record<string, unknown> | undefined {
  if (!baseline || typeof baseline !== 'object') return undefined;
  const values = (baseline as { values?: unknown }).values;
  return values && typeof values === 'object' ? (values as Record<string, unknown>) : undefined;
}

function isInside(root: string, path: string | undefined): boolean {
  if (!path) return false;
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
