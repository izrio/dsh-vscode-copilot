import { describe, expect, it } from 'vitest';
import type { HostToWebview, ItemsPatch } from '@dsh-copilot/shared';
import type { DshClient, SessionSummaryWire } from '../src/dsh/DshClient.ts';
import { AsyncQueue } from '../src/dsh/remote/asyncQueue.ts';
import type { FollowFrame } from '../src/dsh/remote/follow.ts';
import { ChatController } from '../src/vm/ChatController.ts';

/** 只实现 SessionService / SessionStream 用到的方法；follow 由测试控制。 */
function fakeClient() {
  const summaries: SessionSummaryWire[] = [];
  const follows = new Map<string, AsyncQueue<FollowFrame>>();
  const prompts: { sessionId: string; text: string; requestId: string }[] = [];
  let seq = 0;
  const queueFor = (sessionId: string) => {
    let queue = follows.get(sessionId);
    if (!queue) follows.set(sessionId, (queue = new AsyncQueue()));
    return queue;
  };
  const client = {
    events: { onEmit: () => () => undefined },
    ensureWorkspace: async () => ({ workspaceId: 'w1', created: false }),
    listSessions: async () => [...summaries],
    modelCatalog: async () => ({
      default: { provider: 'deepseek-official', model: 'deepseek-flash' },
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }],
    }),
    async *control(signal?: AbortSignal) {
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
    },
    createSession: async () => {
      const id = `s${summaries.length + 1}`;
      summaries.push({ sessionId: id, updatedAt: Date.now(), running: false, blank: false, cwd: '/w' });
      return id;
    },
    prompt: async (sessionId: string, text: string, requestId: string) => {
      prompts.push({ sessionId, text, requestId });
      return requestId;
    },
    cancel: async () => undefined,
    selectModel: async (_id: string, selection: unknown) => selection,
    readHistory: async () => ({ records: [], hasMore: false }),
    async *follow(sessionId: string, signal?: AbortSignal) {
      const queue = queueFor(sessionId);
      signal?.addEventListener('abort', () => queue.end(), { once: true });
      yield { type: 'snapshot', header: { id: sessionId, version: 4, createdAt: 0 }, cursor: seq, records: [], hasMore: false, projections: {}, assistantStream: { revision: 0 } } as FollowFrame;
      yield* queue;
    },
  };
  return {
    client: client as unknown as DshClient,
    prompts,
    /** dsh 持久化了一条事件。 */
    emit(sessionId: string, type: string, data: unknown) {
      queueFor(sessionId).push({ type: 'event', event: { type, seq: ++seq, time: seq, data, surfaceOp: 'append' } } as FollowFrame);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup() {
  const posted: HostToWebview[] = [];
  let saved: string | undefined;
  const controller = new ChatController({
    workspacePath: '/w',
    post: (message) => posted.push(message),
    log: () => undefined,
    loadActiveSessionId: () => undefined,
    saveActiveSessionId: (id) => {
      saved = id;
    },
    openExternal: () => undefined,
    restartRuntime: () => undefined,
    showLogs: () => undefined,
    openWebUI: () => undefined,
    renderDelayMs: 0,
  });
  const fake = fakeClient();
  const patches = () => posted.filter((m): m is { type: 'items'; payload: ItemsPatch } => m.type === 'items').map((m) => m.payload);
  return { controller, fake, posted, patches, saved: () => saved };
}

describe('ChatController', () => {
  it('新对话发第一条消息时才创建会话，立即显示本地回显', async () => {
    const { controller, fake, patches, saved } = setup();
    controller.setClient(fake.client);
    await flush();
    expect(controller.snapshot().session.id).toBeUndefined();

    await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
    await flush();
    expect(saved()).toBe('s1');
    expect(fake.prompts).toHaveLength(1);
    const echo = patches().at(-1)?.upsert.find((item) => item.kind === 'user');
    expect(echo).toMatchObject({ kind: 'user', text: '你好', pending: 'sending' });
  });

  it('持久消息到达后本地回显撤掉，只剩一条用户消息', async () => {
    const { controller, fake } = setup();
    controller.setClient(fake.client);
    await flush();
    await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
    await flush();
    const { requestId } = fake.prompts[0]!;
    fake.emit('s1', 'turn/start', { turn: 1 });
    fake.emit('s1', 'user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: requestId } });
    await flush();
    const users = controller.snapshot().items.filter((item) => item.kind === 'user');
    expect(users).toEqual([{ kind: 'user', id: 'u:2', text: '你好' }]);
    expect(controller.snapshot().session.running).toBe(true);
  });

  it('只推送变化的条目', async () => {
    const { controller, fake, patches } = setup();
    controller.setClient(fake.client);
    await flush();
    await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
    await flush();
    fake.emit('s1', 'user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: fake.prompts[0]!.requestId } });
    await flush();
    controller.snapshot();
    const before = patches().length;
    fake.emit('s1', 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } });
    await flush();
    const patch = patches().at(-1)!;
    expect(patches().length).toBe(before + 1);
    expect(patch.reset).toBe(false);
    expect(patch.upsert.map((item) => item.id)).toEqual(['a:2']);
    expect(patch.order).toEqual(['u:1', 'a:2']);
  });

  it('断线期间继续显示原来的内容，标记为 disconnected', async () => {
    const { controller, fake } = setup();
    controller.setClient(fake.client);
    await flush();
    await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
    await flush();
    fake.emit('s1', 'user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: fake.prompts[0]!.requestId } });
    await flush();
    controller.setClient(undefined);
    await flush();
    const snapshot = controller.snapshot();
    expect(snapshot.items.map((item) => item.id)).toEqual(['u:1']);
    expect(snapshot.session.sync).toBe('disconnected');
  });

  it('初始化还没完成就发送：新建的会话不会被当成"已删除"而丢掉', async () => {
    const { controller, fake, saved } = setup();
    let releaseList: (() => void) | undefined;
    const client = fake.client as unknown as { listSessions: () => Promise<unknown[]> };
    const original = client.listSessions;
    // 第一次读列表卡住，模拟初始化较慢；返回的是发起请求那一刻的列表（还没有新会话）
    client.listSessions = () => {
      const atRequest = original();
      return new Promise((resolve) => (releaseList = () => resolve(atRequest)));
    };
    controller.setClient(fake.client);
    await flush();
    const sending = controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
    await flush();
    releaseList?.();
    client.listSessions = original;
    await sending;
    await flush();
    expect(saved()).toBe('s1');
    expect(controller.snapshot().session.id).toBe('s1');
  });

  it('恢复上次打开的会话：会话已不存在时回到新对话', async () => {
    const posted: HostToWebview[] = [];
    let saved: string | undefined = 'gone';
    const controller = new ChatController({
      workspacePath: '/w',
      post: (message) => posted.push(message),
      log: () => undefined,
      loadActiveSessionId: () => 'gone',
      saveActiveSessionId: (id) => {
        saved = id;
      },
      openExternal: () => undefined,
      restartRuntime: () => undefined,
      showLogs: () => undefined,
      openWebUI: () => undefined,
      renderDelayMs: 0,
    });
    controller.setClient(fakeClient().client);
    await flush();
    expect(saved).toBeUndefined();
    expect(controller.snapshot().session.id).toBeUndefined();
  });

  it('未连接时发送给出提示，不抛错', async () => {
    const { controller, posted } = setup();
    await controller.handle({ type: 'sendMessage', payload: { text: 'x' } });
    expect(posted.at(-1)).toMatchObject({ type: 'toast', payload: { level: 'error' } });
  });

  it('模型目录转成选项，默认选中目录给出的默认模型', async () => {
    const { controller, fake } = setup();
    controller.setClient(fake.client);
    await flush();
    expect(controller.modelState()).toEqual({
      options: [{ provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', group: 'DeepSeek', efforts: [] }],
      current: { provider: 'deepseek-official', model: 'deepseek-flash' },
    });
  });
});
