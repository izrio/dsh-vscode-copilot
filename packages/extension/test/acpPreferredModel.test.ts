import { describe, expect, it } from 'vitest';
import type { ModelState } from '@harness-deck/shared';
import { AcpController, type AcpLink, type PreferredModel } from '../src/acp/AcpController.ts';

/** 假的 Claude：每个会话有自己的模型和思考等级，新会话总是 default。 */
function fakeClaude(calls: string[]): AcpLink {
  let next = 0;
  const models = new Map<string, { model: string; effort: string }>();
  const options = (sid: string) => {
    const s = models.get(sid)!;
    return [
      { id: 'model', category: 'model', currentValue: s.model, options: ['default', 'opus', 'haiku'].map((value) => ({ value, name: value })) },
      { id: 'effort', category: 'thought_level', currentValue: s.effort, options: ['default', 'low', 'high'].map((value) => ({ value, name: value })) },
    ];
  };
  return {
    request: async <T,>(method: string, params: unknown): Promise<T> => {
      const p = params as { sessionId: string; configId: string; value: string };
      if (method === 'session/new') {
        const sessionId = `s${++next}`;
        models.set(sessionId, { model: 'default', effort: 'default' });
        calls.push(`new ${sessionId}`);
        return { sessionId, configOptions: options(sessionId) } as T;
      }
      if (method === 'session/set_config_option') {
        calls.push(`set ${p.sessionId} ${p.configId}=${p.value}`);
        const s = models.get(p.sessionId)!;
        if (p.configId === 'model') s.model = p.value;
        else s.effort = p.value;
        return { configOptions: options(p.sessionId) } as T;
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' } as T;
      return null as T;
    },
    notify: () => undefined,
  };
}

function controller(preferred?: PreferredModel) {
  const store = { preferred };
  const c = new AcpController({
    workspacePath: '/w',
    post: () => undefined,
    log: () => undefined,
    openExternal: () => undefined,
    showLogs: () => undefined,
    restartRuntime: () => undefined,
    loadActiveSessionId: () => undefined,
    saveActiveSessionId: () => undefined,
    loadSessions: () => [],
    saveSessions: () => undefined,
    loadPreferredModel: () => store.preferred,
    savePreferredModel: (p) => void (store.preferred = p),
    renderDelayMs: 0,
  });
  const models = (): ModelState => c.modelState();
  return { c, store, models };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('新对话沿用上次选的模型', () => {
  it('在会话里选了模型，之后的新对话用同一个模型和思考等级；已有会话不动', async () => {
    const calls: string[] = [];
    const { c, store, models } = controller();
    c.setLink(fakeClaude(calls), { authMethods: [] });
    await flush();
    await c.handle({ type: 'sendMessage', payload: { text: '第一个', includeActive: false } });
    await c.handle({ type: 'selectModel', payload: { provider: 'acp', model: 'opus', reasoningEffort: 'high' } });
    expect(store.preferred).toEqual({ model: 'opus', effort: 'high' });
    expect(models().current).toMatchObject({ model: 'opus', reasoningEffort: 'high' });

    calls.length = 0;
    await c.handle({ type: 'newSession', payload: {} });
    await flush();
    expect(calls).toEqual(['new s2', 'set s2 model=opus', 'set s2 effort=high']);
    // 选择器显示的就是新会话实际用的
    expect(models().current).toMatchObject({ model: 'opus', reasoningEffort: 'high' });
    c.dispose();
  });

  it('提前建好的草稿会话：在别的会话里换了模型后它也跟着换', async () => {
    const calls: string[] = [];
    const { c } = controller();
    c.setLink(fakeClaude(calls), { authMethods: [] });
    await flush();
    // s1 是新对话的草稿；发消息后它成了正式会话，再开一个新对话得到草稿 s2
    await c.handle({ type: 'sendMessage', payload: { text: '第一个', includeActive: false } });
    await c.handle({ type: 'newSession', payload: {} });
    await flush();
    await c.handle({ type: 'switchSession', payload: { sessionId: 's1' } });
    calls.length = 0;
    await c.handle({ type: 'selectModel', payload: { provider: 'acp', model: 'haiku' } });
    expect(calls).toEqual(['set s1 model=haiku', 'set s2 model=haiku']);
    c.dispose();
  });

  it('上次的模型代理已经没有了：不改', async () => {
    const calls: string[] = [];
    const { c } = controller({ model: 'retired-model' });
    c.setLink(fakeClaude(calls), { authMethods: [] });
    await flush();
    expect(calls).toEqual(['new s1']);
    c.dispose();
  });
});
