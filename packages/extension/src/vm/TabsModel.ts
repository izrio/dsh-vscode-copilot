/**
 * 对话面板里打开的标签（两种底层的控制器共用）：一个标签对应一个会话，或一个还没发出第一条消息的新对话。
 *
 * 规则：
 * - 最多只有一个新对话标签：再点「新建」时切过去；
 * - 同一个会话不同时出现在两个标签里：打开已在标签里的会话时切过去，当前是新对话标签时就地打开；
 * - 关掉最后一个标签时换成新对话。
 *
 * 这里只管标签本身；切换到哪个会话、关闭标签时要清理什么，由控制器通过回调处理。
 */
import type { TabView } from '@harness-deck/shared';

export interface Tab {
  readonly key: string;
  sessionId: string | undefined;
}

export interface TabsModelOptions {
  /** 标签 key 的前缀（两种底层各用各的，方便在日志里区分）。 */
  readonly keyPrefix: string;
  /** 保存的标签（会话 id，按顺序）；新对话标签不保存。 */
  readonly load: () => readonly string[] | undefined;
  readonly save: (sessionIds: readonly string[]) => void;
  /** 当前标签换了会话（undefined 为新对话）：控制器切换显示的会话。 */
  readonly onActivate: (sessionId: string | undefined) => void;
  /** 标签即将关闭：控制器清理这个会话的后台资源、取消它还在等的审批。 */
  readonly onClose?: (tab: Tab) => void;
  /** 标签有变化，需要重新渲染。 */
  readonly onChange: () => void;
}

export class TabsModel {
  private tabs: Tab[] = [];
  private activeKey = '';
  private counter = 0;

  constructor(private readonly options: TabsModelOptions) {}

  get items(): readonly Tab[] {
    return this.tabs;
  }

  get activeTabKey(): string {
    return this.activeKey;
  }

  get current(): Tab | undefined {
    return this.tabs.find((tab) => tab.key === this.activeKey);
  }

  /** 按保存的标签和上次打开的会话恢复；上次停在新对话时末尾加一个新对话标签。不触发回调。 */
  restore(activeSessionId: string | undefined): void {
    const ids = [...new Set(this.options.load() ?? [])];
    if (activeSessionId && !ids.includes(activeSessionId)) ids.push(activeSessionId);
    this.tabs = ids.map((sessionId) => ({ key: this.nextKey(), sessionId }));
    let active = this.tabs.find((tab) => tab.sessionId === activeSessionId);
    if (!active) {
      active = { key: this.nextKey(), sessionId: undefined };
      this.tabs.push(active);
    }
    this.activeKey = active.key;
  }

  /** 新对话：已有新对话标签时切过去，否则在当前标签后面新开一个。 */
  openNew(): void {
    const blank = this.tabs.find((tab) => !tab.sessionId);
    if (blank) return this.activate(blank.key);
    this.insertAfterActive({ key: this.nextKey(), sessionId: undefined });
  }

  /** 打开会话：已经在标签里时切过去；当前是新对话时就在当前标签打开；否则新开一个标签。 */
  open(sessionId: string): void {
    const existing = this.tabs.find((tab) => tab.sessionId === sessionId);
    if (existing) return this.activate(existing.key);
    const current = this.current;
    if (current && !current.sessionId) {
      this.options.onActivate(sessionId);
      return;
    }
    this.insertAfterActive({ key: this.nextKey(), sessionId });
  }

  activate(key: string): void {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return;
    this.activeKey = key;
    this.options.onActivate(tab.sessionId);
    this.persist();
    this.options.onChange();
  }

  /** 关闭标签：会话仍在底层里，可以从会话列表重新打开。关掉最后一个标签时换成新对话。 */
  close(key: string): void {
    const index = this.tabs.findIndex((t) => t.key === key);
    const tab = this.tabs[index];
    if (!tab) return;
    if (this.tabs.length === 1 && !tab.sessionId) return;
    this.options.onClose?.(tab);
    if (this.tabs.length === 1) {
      this.tabs = [{ key: this.nextKey(), sessionId: undefined }];
      this.activate(this.tabs[0]!.key);
      return;
    }
    this.tabs.splice(index, 1);
    if (key === this.activeKey) this.activate((this.tabs[index] ?? this.tabs[index - 1])!.key);
    else {
      this.persist();
      this.options.onChange();
    }
  }

  /**
   * 当前标签显示的会话换成 `sessionId`（新对话发出第一条消息、在新对话标签里打开会话）。
   * 这个会话已经在别的标签里时去掉那个标签。
   */
  setCurrentSession(sessionId: string | undefined): void {
    const tab = this.current;
    if (!tab || tab.sessionId === sessionId) return;
    if (sessionId) this.tabs = this.tabs.filter((t) => t === tab || t.sessionId !== sessionId);
    tab.sessionId = sessionId;
    this.persist();
  }

  /** 去掉会话已经不存在的标签（当前标签不动）。 */
  prune(keep: (sessionId: string) => boolean): void {
    const before = this.tabs.length;
    this.tabs = this.tabs.filter((tab) => !tab.sessionId || tab.key === this.activeKey || keep(tab.sessionId));
    if (this.tabs.length !== before) this.persist();
  }

  /** 界面上的标签：当前标签的标题和状态由调用方给，其余的按会话 id 查。 */
  view(current: Omit<TabView, 'key' | 'sessionId'>, describe: (sessionId: string) => Omit<TabView, 'key' | 'sessionId'>, blankTitle: string): TabView[] {
    return this.tabs.map((tab) => {
      const base = { key: tab.key, ...(tab.sessionId ? { sessionId: tab.sessionId } : {}) };
      if (tab.key === this.activeKey) return { ...base, ...current };
      if (!tab.sessionId) return { ...base, title: blankTitle, running: false };
      return { ...base, ...describe(tab.sessionId) };
    });
  }

  private insertAfterActive(tab: Tab): void {
    this.tabs.splice(this.tabs.findIndex((t) => t.key === this.activeKey) + 1, 0, tab);
    this.activate(tab.key);
  }

  private nextKey(): string {
    return `${this.options.keyPrefix}-${++this.counter}`;
  }

  private persist(): void {
    this.options.save(this.tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])));
  }
}
