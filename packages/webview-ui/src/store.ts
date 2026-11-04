/**
 * Webview 端的状态：Host 推送的快照和增量合并在这里。
 * Host 是唯一的状态来源，这里只做缓存和按 id 的增量合并。
 */
import { useSyncExternalStore } from 'react';
import type {
  ConnectionState,
  HostToWebview,
  Item,
  ModelState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
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
  readonly session: SessionHeader;
  readonly sessionKey: string;
  readonly items: readonly Item[];
  readonly models: ModelState;
  readonly toasts: readonly Toast[];
  /** Host 要求聚焦输入框的次数，组件据此触发聚焦。 */
  readonly focusRequests: number;
}

const initialState: ViewState = {
  ready: false,
  runtime: { kind: 'idle' },
  connection: 'idle',
  sessions: [],
  session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
  sessionKey: '',
  items: [],
  models: { options: [] },
  toasts: [],
  focusRequests: 0,
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
        session: p.session,
        sessionKey: p.session.id ?? '',
        items: p.items,
        models: p.models,
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
    case 'session':
      set({ session: message.payload });
      return;
    case 'models':
      set({ models: message.payload });
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
