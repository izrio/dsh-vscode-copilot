import { beforeEach, describe, expect, it } from 'vitest';
import type { HostSnapshot, Item } from '@dsh-copilot/shared';
import { applyHostMessage, getState, resetStoreForTests } from '../src/store.ts';

const snapshot = (items: Item[], sessionId = 's1'): HostSnapshot => ({
  runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
  connection: 'connected',
  sessions: [],
  session: { id: sessionId, title: 't', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
  items,
  models: { options: [] },
  interactions: [],
  permissions: { options: [] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  commands: [],
  locale: 'zh',
});

const user = (id: string, text: string): Item => ({ kind: 'user', id, text });

describe('Webview store', () => {
  beforeEach(() => resetStoreForTests());

  it('快照之后按 id 合并增量，按 order 排列，保留没变的对象', () => {
    const a = user('a', '1');
    applyHostMessage({ type: 'snapshot', payload: snapshot([a, user('b', '2')]) });
    applyHostMessage({ type: 'items', payload: { sessionKey: 's1', reset: false, order: ['a', 'b', 'c'], upsert: [user('b', '2!'), user('c', '3')] } });
    const items = getState().items;
    expect(items.map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['1', '2!', '3']);
    expect(items[0]).toBe(a);
  });

  it('丢弃不属于当前会话的增量；reset 换成新会话', () => {
    applyHostMessage({ type: 'snapshot', payload: snapshot([user('a', '1')]) });
    applyHostMessage({ type: 'items', payload: { sessionKey: 'other', reset: false, order: ['x'], upsert: [user('x', 'x')] } });
    expect(getState().items.map((i) => i.id)).toEqual(['a']);
    applyHostMessage({ type: 'items', payload: { sessionKey: 's2', reset: true, order: ['y'], upsert: [user('y', 'y')] } });
    expect(getState().sessionKey).toBe('s2');
    expect(getState().items.map((i) => i.id)).toEqual(['y']);
  });

  it('没发出去的消息放回输入框（restore 模式）', () => {
    const before = getState().prefill.n;
    applyHostMessage({ type: 'restoreDraft', payload: { text: '草稿' } });
    expect(getState().prefill).toEqual({ text: '草稿', n: before + 1, mode: 'restore' });
  });

  it('最多同时显示三条提示', () => {
    for (let i = 0; i < 5; i++) applyHostMessage({ type: 'toast', payload: { level: 'info', text: `t${i}` } });
    expect(getState().toasts.map((t) => t.text)).toEqual(['t2', 't3', 't4']);
  });
});
