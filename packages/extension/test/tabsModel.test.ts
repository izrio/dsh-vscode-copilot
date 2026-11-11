import { describe, expect, it } from 'vitest';
import { TabsModel } from '../src/vm/TabsModel.ts';

function model(saved?: string[], active?: string) {
  const state = { saved, activated: [] as (string | undefined)[], closed: [] as (string | undefined)[], changes: 0 };
  const tabs: TabsModel = new TabsModel({
    keyPrefix: 't',
    load: () => state.saved,
    save: (ids) => void (state.saved = [...ids]),
    // 控制器在这里切换会话，并把当前标签对上这个会话
    onActivate: (sessionId) => {
      state.activated.push(sessionId);
      tabs.setCurrentSession(sessionId);
    },
    onClose: (tab) => state.closed.push(tab.sessionId),
    onChange: () => void state.changes++,
  });
  tabs.restore(active);
  const sessions = () => tabs.items.map((tab) => tab.sessionId);
  return { tabs, state, sessions };
}

describe('TabsModel', () => {
  it('恢复保存的标签；上次停在新对话时末尾加一个新对话标签', () => {
    const restored = model(['a', 'b'], 'b');
    expect(restored.sessions()).toEqual(['a', 'b']);
    expect(restored.tabs.current?.sessionId).toBe('b');
    const blank = model(['a', 'a', 'b']);
    expect(blank.sessions()).toEqual(['a', 'b', undefined]);
    expect(blank.tabs.current?.sessionId).toBeUndefined();
    // 上次打开的会话不在保存的标签里时补上
    expect(model(['a'], 'z').sessions()).toEqual(['a', 'z']);
  });

  it('只有一个新对话标签：再点新建时切过去', () => {
    const { tabs, sessions } = model(['a'], 'a');
    tabs.openNew();
    expect(sessions()).toEqual(['a', undefined]);
    const blankKey = tabs.activeTabKey;
    tabs.activate(tabs.items[0]!.key);
    tabs.openNew();
    expect(sessions()).toEqual(['a', undefined]);
    expect(tabs.activeTabKey).toBe(blankKey);
  });

  it('打开会话：已在标签里时切过去，当前是新对话时就地打开，否则在当前标签后面新开', () => {
    const { tabs, sessions, state } = model(['a', 'b'], 'a');
    tabs.open('b');
    expect(tabs.current?.sessionId).toBe('b');
    expect(sessions()).toEqual(['a', 'b']);
    tabs.activate(tabs.items[0]!.key);
    tabs.open('c');
    expect(sessions()).toEqual(['a', 'c', 'b']);
    tabs.openNew();
    tabs.open('d');
    expect(sessions()).toEqual(['a', 'c', 'd', 'b']);
    expect(state.saved).toEqual(['a', 'c', 'd', 'b']);
  });

  it('同一个会话不同时出现在两个标签里', () => {
    const { tabs, sessions } = model(['a', 'b'], 'a');
    tabs.openNew();
    tabs.setCurrentSession('b');
    expect(sessions()).toEqual(['a', 'b']);
    expect(tabs.current?.sessionId).toBe('b');
  });

  it('关闭标签：通知控制器清理，切到旁边的标签；关掉最后一个换成新对话', () => {
    const { tabs, sessions, state } = model(['a', 'b', 'c'], 'b');
    tabs.close(tabs.items[1]!.key);
    expect(state.closed).toEqual(['b']);
    expect(sessions()).toEqual(['a', 'c']);
    expect(tabs.current?.sessionId).toBe('c');
    // 关的不是当前标签：当前标签不变
    tabs.close(tabs.items[0]!.key);
    expect(tabs.current?.sessionId).toBe('c');
    tabs.close(tabs.activeTabKey);
    expect(sessions()).toEqual([undefined]);
    expect(state.saved).toEqual([]);
    // 只剩一个新对话标签时关不掉
    tabs.close(tabs.activeTabKey);
    expect(sessions()).toEqual([undefined]);
    expect(state.closed).toEqual(['b', 'a', 'c']);
  });

  it('去掉会话已经不存在的标签，当前标签保留', () => {
    const { tabs, sessions } = model(['a', 'b', 'c'], 'b');
    tabs.prune((id) => id === 'c');
    expect(sessions()).toEqual(['b', 'c']);
  });
});
