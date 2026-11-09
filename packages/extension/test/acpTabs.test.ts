import { describe, expect, it } from 'vitest';
import type { HostToWebview, TabsState } from '@harness-deck/shared';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { setLocale } from '../src/i18n.ts';

/** 假的代理：session/new 依次给 s1、s2…，session/load 和 prompt 直接成功。 */
function fakeLink(log: string[] = []): AcpLink {
  let next = 0;
  return {
    request: async <T,>(method: string, params: unknown): Promise<T> => {
      log.push(`${method}${method === 'session/load' ? ` ${(params as { sessionId: string }).sessionId}` : ''}`);
      if (method === 'session/new') return { sessionId: `s${++next}` } as T;
      if (method === 'session/prompt') return { stopReason: 'end_turn' } as T;
      return null as T;
    },
    notify: () => undefined,
  };
}

function controller(saved: { tabs?: string[]; active?: string } = {}) {
  const posts: HostToWebview[] = [];
  const state = { tabs: saved.tabs, active: saved.active };
  const c = new AcpController({
    workspacePath: '/w',
    post: (m) => posts.push(m),
    log: () => undefined,
    openExternal: () => undefined,
    showLogs: () => undefined,
    restartRuntime: () => undefined,
    loadActiveSessionId: () => state.active,
    saveActiveSessionId: (id) => void (state.active = id),
    loadSessions: () => [],
    saveSessions: () => undefined,
    loadOpenTabs: () => state.tabs,
    saveOpenTabs: (ids) => void (state.tabs = [...ids]),
    renderDelayMs: 0,
  });
  const tabs = (): TabsState => (c as unknown as { compute(): { tabs: TabsState } }).compute().tabs;
  return { c, posts, state, tabs };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ACP 底层的多开标签', () => {
  it('新对话开新标签，发出第一条消息后标签记住会话；再点新对话又开一个', async () => {
    setLocale('zh');
    const { c, state, tabs } = controller();
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    expect(tabs().items).toHaveLength(1);
    await c.handle({ type: 'sendMessage', payload: { text: '第一个', includeActive: false } });
    expect(tabs().items).toMatchObject([{ sessionId: 's1', title: '第一个' }]);
    await c.handle({ type: 'newSession', payload: {} });
    await flush();
    expect(tabs().items.map((t) => t.sessionId)).toEqual(['s1', undefined]);
    expect(tabs().active).toBe(tabs().items[1]!.key);
    // 已经有新对话标签时，再点新对话只是切过去
    await c.handle({ type: 'newSession', payload: {} });
    expect(tabs().items).toHaveLength(2);
    await c.handle({ type: 'sendMessage', payload: { text: '第二个', includeActive: false } });
    expect(tabs().items.map((t) => t.sessionId)).toEqual(['s1', 's2']);
    expect(state.tabs).toEqual(['s1', 's2']);
    c.dispose();
  });

  it('打开已在标签里的会话时切过去；当前是新对话时在当前标签打开；关闭标签', async () => {
    const { c, tabs, state } = controller({ tabs: ['a', 'b'], active: 'b' });
    const log: string[] = [];
    c.setLink(fakeLink(log), { authMethods: [], agentCapabilities: { loadSession: true } });
    await flush();
    expect(tabs().items.map((t) => t.sessionId)).toEqual(['a', 'b']);
    expect(log).toContain('session/load b');
    // 切到已有的标签，会话按需加载
    await c.handle({ type: 'switchSession', payload: { sessionId: 'a' } });
    await flush();
    expect(tabs().active).toBe(tabs().items[0]!.key);
    expect(log).toContain('session/load a');
    // 新对话标签里打开会话 c：就在这个标签打开，不多开
    await c.handle({ type: 'newSession', payload: {} });
    await c.handle({ type: 'switchSession', payload: { sessionId: 'c' } });
    expect(tabs().items.map((t) => t.sessionId)).toEqual(['a', 'c', 'b']);
    // 关掉当前标签：切到右边的
    await c.handle({ type: 'closeTab', payload: { key: tabs().active } });
    expect(tabs().items.map((t) => t.sessionId)).toEqual(['a', 'b']);
    expect(tabs().items.find((t) => t.key === tabs().active)?.sessionId).toBe('b');
    expect(state.tabs).toEqual(['a', 'b']);
    // 关到只剩一个再关：换成新对话
    await c.handle({ type: 'closeTab', payload: { key: tabs().items[0]!.key } });
    await c.handle({ type: 'closeTab', payload: { key: tabs().items[0]!.key } });
    expect(tabs().items).toHaveLength(1);
    expect(tabs().items[0]!.sessionId).toBeUndefined();
    c.dispose();
  });

  it('后台标签显示运行中和等待审批', async () => {
    const { c, tabs } = controller({ tabs: ['a', 'b'], active: 'b' });
    c.setLink(fakeLink(), { authMethods: [], agentCapabilities: { loadSession: true } });
    await flush();
    await c.handle({ type: 'switchSession', payload: { sessionId: 'a' } });
    await flush();
    c.onSessionUpdate({ sessionId: 'a', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } } });
    (c as unknown as { projections: Map<string, AcpSessionProjection> }).projections.get('a')!.startTurn(0);
    void c.onAgentRequest('session/request_permission', { sessionId: 'a', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'ok', kind: 'allow_once' }] });
    await c.handle({ type: 'switchSession', payload: { sessionId: 'b' } });
    expect(tabs().items.find((t) => t.sessionId === 'a')).toMatchObject({ running: true, needsAttention: true });
    // 关掉 a 的标签：它在等的审批取消掉
    const pending = (c as unknown as { permissions: Map<string, unknown> }).permissions;
    expect(pending.size).toBe(1);
    await c.handle({ type: 'closeTab', payload: { key: tabs().items.find((t) => t.sessionId === 'a')!.key } });
    expect(pending.size).toBe(0);
    c.dispose();
  });
});

describe('回复的光标和顺序', () => {
  it('后面出现工具调用时，前面的回复不再显示光标', () => {
    const p = new AcpSessionProjection('/w');
    p.startTurn(0);
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先看看。' }, messageId: 'm1' });
    expect(p.snapshotItems()[0]).toMatchObject({ kind: 'assistant', streaming: true });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Read', kind: 'read', status: 'pending', rawInput: { file_path: '/w/a' } });
    expect(p.snapshotItems()[0]).toMatchObject({ kind: 'assistant', streaming: false });
  });

  it('网关每次都给同一个消息 id：隔着工具的文字另起一条，按时间顺序显示，id 不重复', () => {
    const p = new AcpSessionProjection('/w');
    p.startTurn(0);
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段' }, messageId: 'same' });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', kind: 'execute', status: 'completed', rawInput: { command: 'ls' } });
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二段' }, messageId: 'same' });
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '接着说' }, messageId: 'same' });
    const items = p.snapshotItems();
    expect(items).toMatchObject([
      { kind: 'assistant', markdown: '第一段' },
      { kind: 'activity', variant: 'command' },
      { kind: 'assistant', markdown: '第二段接着说' },
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});
