/**
 * 把控制器算出的视图推送给 Webview：记住上次推送的内容，只推送变化的部分。
 * 条目按 id 增量推送；同一个对象（来自缓存的持久事件投影）不再序列化比较。
 */
import type {
  CommandView,
  ContextState,
  HostToWebview,
  Item,
  ModelState,
  PendingInteraction,
  PermissionState,
  SessionHeader,
  SessionListItem,
  WorkspaceState,
} from '@dsh-copilot/shared';

export interface ControllerView {
  readonly sessionKey: string;
  readonly sessions: SessionListItem[];
  readonly session: SessionHeader;
  readonly items: Item[];
  readonly models: ModelState;
  readonly interactions: PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly commands: CommandView[];
}

export class ViewPublisher {
  private sentSessionKey: string | undefined;
  private sentItems = new Map<string, string>();
  private sentObjects = new Map<string, Item>();
  private sentOrder: readonly string[] = [];
  private sentJson = { sessions: '', session: '', models: '', interactions: '', permissions: '', workspace: '', context: '', commands: '' };

  constructor(
    private readonly post: (message: HostToWebview) => void,
    private readonly onModelChange?: (label: string | undefined) => void,
  ) {}

  /** Webview 取了完整快照：之后的增量都相对于它。 */
  reset(view: ControllerView): void {
    this.sentSessionKey = view.sessionKey;
    this.sentItems = new Map(view.items.map((item) => [item.id, JSON.stringify(item)]));
    this.sentObjects = new Map(view.items.map((item) => [item.id, item]));
    this.sentOrder = view.items.map((item) => item.id);
    this.sentJson = {
      sessions: JSON.stringify(view.sessions),
      session: JSON.stringify(view.session),
      context: JSON.stringify(view.context),
      commands: JSON.stringify(view.commands),
      models: JSON.stringify(view.models),
      interactions: JSON.stringify(view.interactions),
      permissions: JSON.stringify(view.permissions),
      workspace: JSON.stringify(view.workspace),
    };
  }

  /** 推送和上次相比变化的部分。 */
  publish(view: ControllerView): void {
    const sessionsJson = JSON.stringify(view.sessions);
    if (sessionsJson !== this.sentJson.sessions) {
      this.sentJson.sessions = sessionsJson;
      this.post({ type: 'sessions', payload: view.sessions });
    }
    const modelsJson = JSON.stringify(view.models);
    if (modelsJson !== this.sentJson.models) {
      this.sentJson.models = modelsJson;
      this.post({ type: 'models', payload: view.models });
      const current = view.models.current;
      const option = view.models.options.find((o) => o.provider === current?.provider && o.model === current?.model);
      this.onModelChange?.(option?.name ?? current?.model);
    }
    const sessionJson = JSON.stringify(view.session);
    if (sessionJson !== this.sentJson.session) {
      this.sentJson.session = sessionJson;
      this.post({ type: 'session', payload: view.session });
    }
    this.postItems(view.sessionKey, view.items);
    // 卡片放在条目之后推送：Webview 先有条目，再显示末尾的审批
    const interactionsJson = JSON.stringify(view.interactions);
    if (interactionsJson !== this.sentJson.interactions) {
      this.sentJson.interactions = interactionsJson;
      this.post({ type: 'interactions', payload: view.interactions });
    }
    const permissionsJson = JSON.stringify(view.permissions);
    if (permissionsJson !== this.sentJson.permissions) {
      this.sentJson.permissions = permissionsJson;
      this.post({ type: 'permissions', payload: view.permissions });
    }
    const contextJson = JSON.stringify(view.context);
    if (contextJson !== this.sentJson.context) {
      this.sentJson.context = contextJson;
      this.post({ type: 'context', payload: view.context });
    }
    const commandsJson = JSON.stringify(view.commands);
    if (commandsJson !== this.sentJson.commands) {
      this.sentJson.commands = commandsJson;
      this.post({ type: 'commands', payload: view.commands });
    }
    const workspaceJson = JSON.stringify(view.workspace);
    if (workspaceJson !== this.sentJson.workspace) {
      this.sentJson.workspace = workspaceJson;
      this.post({ type: 'workspace', payload: view.workspace });
    }
  }

  private postItems(sessionKey: string, items: readonly Item[]): void {
    const reset = sessionKey !== this.sentSessionKey;
    const order = items.map((item) => item.id);
    const upsert: Item[] = [];
    const next = new Map<string, string>();
    const objects = new Map<string, Item>();
    for (const item of items) {
      objects.set(item.id, item);
      // 同一个对象（来自缓存的持久事件投影）内容一定没变
      const json = this.sentObjects.get(item.id) === item ? this.sentItems.get(item.id) : JSON.stringify(item);
      next.set(item.id, json ?? JSON.stringify(item));
      if (reset || this.sentItems.get(item.id) !== json) upsert.push(item);
    }
    this.sentObjects = objects;
    const orderChanged = reset || order.length !== this.sentOrder.length || order.some((id, i) => id !== this.sentOrder[i]);
    this.sentSessionKey = sessionKey;
    this.sentItems = next;
    this.sentOrder = order;
    if (!reset && !orderChanged && upsert.length === 0) return;
    this.post({ type: 'items', payload: { sessionKey, reset, order, upsert } });
  }
}
