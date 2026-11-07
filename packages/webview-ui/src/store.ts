/**
 * Webview 端的状态：Host 推送的快照和增量合并在这里。
 * Host 是唯一的状态来源，这里只做缓存和按 id 的增量合并。
 */
import { useSyncExternalStore } from 'react';
import { postToHost } from './vscode.ts';
import type {
  AppearanceState,
  CommandView,
  DiffRef,
  ConnectionState,
  ContextState,
  FileCandidate,
  Locale,
  HostToWebview,
  Item,
  ModelState,
  PendingInteraction,
  PermissionState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  BackendsState,
  TabsState,
  WorkspaceState,
} from '@dsh-copilot/shared';

export interface Toast {
  readonly id: number;
  readonly level: 'info' | 'error';
  readonly text: string;
}

export interface ViewState {
  readonly ready: boolean;
  readonly runtime: RuntimeStatus;
  readonly connection: ConnectionState;
  readonly sessions: readonly SessionListItem[];
  readonly tabs: TabsState;
  /** 可选的底层和当前底层。 */
  readonly backends: BackendsState;
  readonly session: SessionHeader;
  readonly sessionKey: string;
  readonly items: readonly Item[];
  readonly models: ModelState;
  /** 当前会话等待处理的审批和提问。 */
  readonly interactions: readonly PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly locale: Locale;
  readonly commands: readonly CommandView[];
  /** 最近一次 `@` 补全的结果。 */
  readonly fileCandidates: { readonly requestId: number; readonly items: readonly FileCandidate[] };
  readonly toasts: readonly Toast[];
  /** 把一段文字放进输入框（"编辑后重发"）；`n` 每次递增，输入框据此更新。 */
  readonly prefill: { readonly text: string; readonly n: number };
  /** Host 要求聚焦输入框的次数，组件据此触发聚焦。 */
  readonly focusRequests: number;
  readonly appearance: AppearanceState;
  /** 图片内容缓存：`local:<localId>` 或 attachmentId → data URL；'loading' 读取中，'error' 读不到。 */
  readonly images: Readonly<Record<string, string>>;
  /** 正在打开的 Diff：`key` 是 DiffRef 的 JSON，对应的行显示加载中。 */
  readonly openingDiff?: { readonly token: number; readonly key: string };
}

const initialState: ViewState = {
  ready: false,
  runtime: { kind: 'idle' },
  connection: 'idle',
  sessions: [],
  tabs: { items: [], active: '' },
  backends: { items: [], active: 'dsh' },
  session: { title: '', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
  sessionKey: '',
  items: [],
  models: { options: [] },
  interactions: [],
  permissions: { options: [] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  locale: 'zh',
  commands: [],
  fileCandidates: { requestId: -1, items: [] },
  toasts: [],
  prefill: { text: '', n: 0 },
  focusRequests: 0,
  appearance: {},
  images: {},
};

let state: ViewState = initialState;
const listeners = new Set<() => void>();
let toastId = 0;

function set(next: Partial<ViewState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getState(): ViewState {
  return state;
}

export function useView<T>(selector: (state: ViewState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
  );
}

/** 字体设置先在本地生效，Host 写完设置后会再推送一次。 */
export function setAppearanceLocal(appearance: ViewState['appearance']): void {
  set({ appearance });
}

/** 图片在缓存里的键。 */
export function imageKey(image: { readonly attachmentId?: string; readonly localId?: string }): string | undefined {
  return image.attachmentId ?? (image.localId ? `local:${image.localId}` : undefined);
}

/** 记下本地图片（粘贴或拖进来的），发送中的回显用它显示。 */
export function registerLocalImage(localId: string, dataUrl: string): void {
  set({ images: { ...state.images, [`local:${localId}`]: dataUrl } });
}

/** 向 Host 读取 dsh 保存的图片；已经在读或读过时不重复请求。 */
export function requestImage(attachmentId: string): void {
  if (state.images[attachmentId] !== undefined) return;
  set({ images: { ...state.images, [attachmentId]: 'loading' } });
  postToHost({ type: 'loadImage', payload: { attachmentId } });
}

/** Webview 自己发出的提示（例如粘贴的图片不能用）。 */
export function showToast(level: 'info' | 'error', text: string): void {
  applyHostMessage({ type: 'toast', payload: { level, text } });
}

let diffToken = 0;
/** 超过这个时间 Host 还没回复，就不再显示加载中（Host 那边仍会打开）。 */
const DIFF_SPINNER_LIMIT_MS = 20_000;

/** 打开 Diff：对应的行显示加载中，直到 Host 打开（或放弃）。 */
export function openDiff(ref: DiffRef, post: (token: number) => void): void {
  const token = ++diffToken;
  set({ openingDiff: { token, key: diffKey(ref) } });
  post(token);
  setTimeout(() => {
    if (state.openingDiff?.token === token) set({ openingDiff: undefined });
  }, DIFF_SPINNER_LIMIT_MS);
}

export function diffKey(ref: DiffRef): string {
  return JSON.stringify(ref);
}

export function requestPrefill(text: string): void {
  set({ prefill: { text, n: state.prefill.n + 1 } });
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
}

/** 应用一条 Host 消息。 */
export function applyHostMessage(message: HostToWebview): void {
  switch (message.type) {
    case 'snapshot': {
      const p = message.payload;
      set({
        ready: true,
        runtime: p.runtime,
        connection: p.connection,
        sessions: p.sessions,
        tabs: p.tabs ?? { items: [], active: '' },
        backends: p.backends ?? { items: [], active: 'dsh' },
        session: p.session,
        sessionKey: p.session.id ?? '',
        items: p.items,
        models: p.models,
        interactions: p.interactions,
        permissions: p.permissions,
        workspace: p.workspace,
        context: p.context,
        locale: p.locale,
        commands: p.commands,
        appearance: p.appearance ?? {},
      });
      return;
    }
    case 'runtimeStatus':
      set({ runtime: message.payload });
      return;
    case 'connection':
      set({ connection: message.payload });
      return;
    case 'sessions':
      set({ sessions: message.payload });
      return;
    case 'tabs':
      set({ tabs: message.payload });
      return;
    case 'backends':
      set({ backends: message.payload });
      return;
    case 'session':
      set({ session: message.payload });
      return;
    case 'models':
      set({ models: message.payload });
      return;
    case 'interactions':
      set({ interactions: message.payload });
      return;
    case 'permissions':
      set({ permissions: message.payload });
      return;
    case 'workspace':
      set({ workspace: message.payload });
      return;
    case 'context':
      set({ context: message.payload });
      return;
    case 'locale':
      set({ locale: message.payload });
      return;
    case 'appearance':
      set({ appearance: message.payload });
      return;
    case 'imageData':
      set({ images: { ...state.images, [message.payload.attachmentId]: message.payload.dataUrl ?? 'error' } });
      return;
    case 'diffOpened':
      if (state.openingDiff?.token === message.payload.token) set({ openingDiff: undefined });
      return;
    case 'commands':
      set({ commands: message.payload });
      return;
    case 'fileCandidates':
      set({ fileCandidates: message.payload });
      return;
    case 'items': {
      const patch = message.payload;
      if (patch.reset) {
        set({ sessionKey: patch.sessionKey, items: patch.upsert });
        return;
      }
      // 不属于当前会话的增量（切换会话的瞬间）直接丢弃，等下一次 reset
      if (patch.sessionKey !== state.sessionKey) return;
      const byId = new Map(state.items.map((item) => [item.id, item]));
      for (const item of patch.upsert) byId.set(item.id, item);
      set({ items: patch.order.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined) });
      return;
    }
    case 'toast': {
      const toast = { id: ++toastId, ...message.payload };
      set({ toasts: [...state.toasts, toast].slice(-3) });
      setTimeout(() => dismissToast(toast.id), message.payload.level === 'error' ? 8_000 : 4_000);
      return;
    }
    case 'focusComposer':
      set({ focusRequests: state.focusRequests + 1 });
      return;
  }
}

/** 仅供测试：恢复初始状态。 */
export function resetStoreForTests(): void {
  state = initialState;
}
