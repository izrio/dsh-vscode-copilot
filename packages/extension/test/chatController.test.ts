import { describe, expect, it } from 'vitest';
import type { HostToWebview, ItemsPatch } from '@dsh-copilot/shared';
import type { DshClient, SessionSummaryWire } from '../src/dsh/DshClient.ts';
import { AsyncQueue } from '../src/dsh/remote/asyncQueue.ts';
import type { WaterfallHandler, WaterfallOutcome } from '../src/dsh/remote/events.ts';
import type { FollowFrame } from '../src/dsh/remote/follow.ts';
import { ChangesUnavailableError } from '../src/dsh/DshClient.ts';
import { ChatController } from '../src/vm/ChatController.ts';
import { noWorkbench, type DiffRequest, type Workbench } from '../src/vm/workbench.ts';

/** 只实现 SessionService / SessionStream 用到的方法；follow 由测试控制。 */
function fakeClient() {
  const summaries: SessionSummaryWire[] = [];
  const follows = new Map<string, AsyncQueue<FollowFrame>>();
  const prompts: { sessionId: string; text: string; requestId: string }[] = [];
  const commands: { sessionId: string; line: string }[] = [];
  const waterfalls = new Map<string, WaterfallHandler>();
  let seq = 0;
  let eventId = 0;
  const queueFor = (sessionId: string) => {
    let queue = follows.get(sessionId);
    if (!queue) follows.set(sessionId, (queue = new AsyncQueue()));
    return queue;
  };
  const client = {
    events: {
      onEmit: () => () => undefined,
      onWaterfall: (event: string, handler: WaterfallHandler) => {
        waterfalls.set(event, handler);
        return () => waterfalls.delete(event);
      },
    },
    permissionCatalog: async () => ({
      options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }],
      defaultPreset: 'workspace-write',
    }),
    executeCommand: async (sessionId: string, line: string) => {
      commands.push({ sessionId, line });
      return { kind: 'success', text: line };
    },
    changesSummary: async (_sessionId: string, _seq: number) => ({
      turn: 1,
      files: [{ path: 'a.ts', display: 'a.ts', added: 2, deleted: 1 }],
      total: 1,
    }),
    changesDiff: async () => ({
      kind: 'text',
      path: 'a.ts',
      before: true,
      after: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }],
    }),
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
    commands,
    /** dsh 转发了一个需要回答的请求。 */
    waterfall(event: string, agentId: string, request: Record<string, unknown>) {
      const abort = new AbortController();
      const id = `e${++eventId}`;
      const handler = waterfalls.get(event);
      if (!handler) throw new Error(`没有 ${event} 的处理方`);
      const outcome: Promise<WaterfallOutcome> = handler({ event, eventId: id, agentId, request }, abort.signal);
      return { id, outcome, cancel: () => abort.abort() };
    },
    /** dsh 持久化了一条事件。 */
    emit(sessionId: string, type: string, data: unknown) {
      queueFor(sessionId).push({ type: 'event', event: { type, seq: ++seq, time: seq, data, surfaceOp: 'append' } } as FollowFrame);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(workbench: Workbench = noWorkbench) {
  const posted: HostToWebview[] = [];
  let saved: string | undefined;
  const controller = new ChatController({
    workbench,
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

  describe('M2：审批、提问、权限、Diff', () => {
    /** 打开一个会话（发送一条消息），dsh 持久化了一次 bash 调用。 */
    async function withSession(workbench?: Workbench) {
      const ctx = setup(workbench);
      ctx.controller.setClient(ctx.fake.client);
      await flush();
      await ctx.controller.handle({ type: 'sendMessage', payload: { text: '跑一下' } });
      await flush();
      return ctx;
    }

    function fakeWorkbench(dirty: string[] = []) {
      const diffs: DiffRequest[] = [];
      const confirms: string[] = [];
      let confirmAnswer = true;
      const workbench: Workbench = {
        ...noWorkbench,
        openDiff: async (request) => void diffs.push(request),
        dirtyFiles: () => dirty,
        confirm: async (message) => {
          confirms.push(message);
          return confirmAnswer;
        },
      };
      return { workbench, diffs, confirms, setConfirm: (value: boolean) => (confirmAnswer = value) };
    }

    it('审批：显示要执行的命令和中文原因，允许后回答 allowed-once，卡片消失', async () => {
      const { controller, fake, posted } = await withSession();
      fake.emit('s1', 'tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'rm -rf build', sandbox_permissions: 'danger-full-access' }) });
      const request = fake.waterfall('approval/request', 's1', { toolName: 'bash', callId: 'c1', reason: 'needs network', displayReason: { en: 'needs network', zh: '需要访问网络' } });
      await flush();
      const card = controller.snapshot().interactions[0];
      expect(card).toEqual({
        kind: 'approval',
        id: request.id,
        toolName: 'bash',
        reason: '需要访问网络',
        subject: 'rm -rf build',
        subjectKind: 'command',
        previewable: false,
        dirtyFiles: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 200)); // 会话列表在创建后延迟刷新
      expect(controller.snapshot().sessions[0]).toMatchObject({ id: 's1', needsAttention: true });
      await controller.handle({ type: 'respondApproval', payload: { id: request.id, decision: 'allow' } });
      expect(await request.outcome).toEqual({ kind: 'result', value: 'allowed-once' });
      await flush();
      expect(controller.snapshot().interactions).toEqual([]);
      expect(posted.filter((m) => m.type === 'interactions').at(-1)).toEqual({ type: 'interactions', payload: [] });
    });

    it('审批：要修改的文件有未保存内容时不能允许，可以拒绝', async () => {
      const { workbench } = fakeWorkbench(['/w/a.ts']);
      const { controller, fake, posted } = await withSession(workbench);
      fake.emit('s1', 'tool/call', { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }) });
      const request = fake.waterfall('approval/request', 's1', { toolName: 'edit', callId: 'c1' });
      await flush();
      expect(controller.snapshot().interactions[0]).toMatchObject({ subject: 'a.ts', subjectKind: 'file', previewable: true, dirtyFiles: ['a.ts'] });
      await controller.handle({ type: 'respondApproval', payload: { id: request.id, decision: 'allow' } });
      expect(posted.at(-1)).toMatchObject({ type: 'toast', payload: { level: 'error' } });
      expect(controller.snapshot().interactions).toHaveLength(1);
      await controller.handle({ type: 'respondApproval', payload: { id: request.id, decision: 'reject' } });
      expect(await request.outcome).toEqual({ kind: 'result', value: 'rejected' });
    });

    it('审批预览：按工具参数打开「将要写入」的 Diff', async () => {
      const { workbench, diffs } = fakeWorkbench();
      const { controller, fake } = await withSession(workbench);
      fake.emit('s1', 'tool/call', { callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'b.ts', content: 'x' }) });
      const request = fake.waterfall('approval/request', 's1', { toolName: 'write', callId: 'c1' });
      await flush();
      await controller.handle({ type: 'previewApproval', payload: { id: request.id } });
      expect(diffs).toEqual([{ kind: 'proposed', path: '/w/b.ts', tool: 'write', args: { file_path: 'b.ts', content: 'x' } }]);
    });

    it('dsh 取消请求后卡片消失，回答已结束的请求只提示', async () => {
      const { controller, fake, posted } = await withSession();
      const request = fake.waterfall('approval/request', 's1', { toolName: 'bash' });
      await flush();
      expect(controller.snapshot().interactions).toHaveLength(1);
      request.cancel();
      expect(await request.outcome).toEqual({ kind: 'next' });
      await flush();
      expect(controller.snapshot().interactions).toEqual([]);
      await controller.handle({ type: 'respondApproval', payload: { id: request.id, decision: 'allow' } });
      expect(posted.at(-1)).toMatchObject({ type: 'toast', payload: { level: 'info' } });
    });

    it('看不懂的请求交给其他回答方，不挂起', async () => {
      const { controller, fake } = await withSession();
      const request = fake.waterfall('user-questions/request', 's1', { unexpected: true });
      expect(await request.outcome).toEqual({ kind: 'next' });
      expect(controller.snapshot().interactions).toEqual([]);
    });

    it('提问：显示问题和选项，回答后回传选择', async () => {
      const { controller, fake } = await withSession();
      const request = fake.waterfall('user-questions/request', 's1', {
        questions: [{ id: 'q', question: '选哪个？', options: [{ label: 'A' }, { label: 'B', description: '更快' }], multi_select: true }],
      });
      await flush();
      expect(controller.snapshot().interactions).toEqual([
        { kind: 'question', id: request.id, questions: [{ id: 'q', question: '选哪个？', options: [{ label: 'A' }, { label: 'B', description: '更快' }], multiSelect: true }] },
      ]);
      await controller.handle({ type: 'answerQuestion', payload: { id: request.id, answers: [{ id: 'q', selected: ['B'] }] } });
      expect(await request.outcome).toEqual({ kind: 'result', value: { answers: [{ id: 'q', selected: ['B'] }] } });
    });

    it('其他会话的请求不显示在当前会话，只在列表里标记', async () => {
      const { controller, fake } = await withSession();
      fake.waterfall('approval/request', 'other', { toolName: 'bash' });
      await flush();
      expect(controller.snapshot().interactions).toEqual([]);
    });

    it('权限：新对话显示默认预设，选择后在创建会话时应用', async () => {
      const { controller, fake } = setup();
      controller.setClient(fake.client);
      await flush();
      expect(controller.snapshot().permissions).toEqual({ options: ['read-only', 'workspace-write', 'danger-full-access'], current: 'workspace-write' });
      await controller.handle({ type: 'selectPermission', payload: { preset: 'read-only' } });
      expect(controller.snapshot().permissions.current).toBe('read-only');
      await controller.handle({ type: 'sendMessage', payload: { text: 'x' } });
      expect(fake.commands).toEqual([{ sessionId: 's1', line: '/permission read-only' }]);
      expect(controller.snapshot().permissions.current).toBe('read-only');
    });

    it('权限：切换到 danger-full-access 先确认，取消时不切换', async () => {
      const { workbench, confirms, setConfirm } = fakeWorkbench();
      const { controller, fake } = await withSession(workbench);
      setConfirm(false);
      await controller.handle({ type: 'selectPermission', payload: { preset: 'danger-full-access' } });
      expect(confirms).toHaveLength(1);
      expect(fake.commands).toEqual([]);
      setConfirm(true);
      await controller.handle({ type: 'selectPermission', payload: { preset: 'danger-full-access' } });
      expect(fake.commands).toEqual([{ sessionId: 's1', line: '/permission danger-full-access' }]);
      expect(controller.snapshot().permissions.current).toBe('danger-full-access');
    });

    it('改动汇总：读到后显示卡片，打开文件时取 Host 的 hunk', async () => {
      const { workbench, diffs } = fakeWorkbench();
      const { controller, fake } = await withSession(workbench);
      fake.emit('s1', 'workspace/changes', { turn: 1 });
      await flush();
      await flush();
      const card = controller.snapshot().items.find((item) => item.kind === 'changes');
      expect(card).toMatchObject({ source: 'turn', files: [{ path: 'a.ts', additions: 2, deletions: 1 }] });
      const ref = card?.kind === 'changes' ? card.files[0]!.ref : undefined;
      await controller.handle({ type: 'openDiff', payload: { ref: ref! } });
      expect(diffs[0]).toMatchObject({ kind: 'turn', path: '/w/a.ts', before: true, after: true });
    });

    it('dsh 重启后（新 origin）重新读取改动汇总，不可用时改为按文件工具汇总', async () => {
      const { controller, fake } = setup();
      (fake.client as unknown as { credential: { origin: string } }).credential = { origin: 'http://127.0.0.1:1' };
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '改一下' } });
      await flush();
      const history = [
        { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }) } },
        { type: 'tool/result', seq: 2, time: 2, surfaceOp: 'append', data: { message: { toolCallId: 'c1', content: [], isError: false }, meta: { path: '/w/a.ts', diffs: [{ oldText: 'a', newText: 'b' }] } } },
        { type: 'workspace/changes', seq: 3, time: 3, data: { turn: 1 } },
      ];
      for (const event of history) fake.emit('s1', event.type, event.data);
      await flush();
      await flush();
      expect(controller.snapshot().items.find((item) => item.kind === 'changes')).toMatchObject({ source: 'turn' });

      // 重启后的 Host：新端口，会话历史从日志恢复，但改动汇总已经不在内存里
      const restarted = fakeClient();
      Object.assign(restarted.client, {
        credential: { origin: 'http://127.0.0.1:2' },
        listSessions: async () => [{ sessionId: 's1', updatedAt: 1, running: false, blank: false, cwd: '/w' }],
        changesSummary: () => Promise.reject(new ChangesUnavailableError()),
        async *follow(_id: string, signal?: AbortSignal) {
          yield { type: 'snapshot', header: { id: 's1', version: 4, createdAt: 0 }, cursor: 3, records: history.map((event) => ({ type: 'event', event })), hasMore: false, projections: {}, assistantStream: { revision: 0 } };
          await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
        },
      });
      controller.setClient(restarted.client);
      await flush();
      await flush();
      await flush();
      expect(controller.snapshot().items.find((item) => item.kind === 'changes')).toMatchObject({
        source: 'tools',
        files: [{ path: 'a.ts', ref: { kind: 'tool', callId: 'c1' } }],
      });
    });

    it('单次修改的 Diff 用工具结果里的片段', async () => {
      const { workbench, diffs } = fakeWorkbench();
      const { controller, fake } = await withSession(workbench);
      fake.emit('s1', 'tool/call', { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }) });
      fake.emit('s1', 'tool/result', { message: { toolCallId: 'c1', content: [], isError: false }, meta: { path: '/w/a.ts', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] } });
      await flush();
      controller.snapshot();
      await controller.handle({ type: 'openDiff', payload: { ref: { kind: 'tool', callId: 'c1' } } });
      expect(diffs).toEqual([{ kind: 'tool', path: '/w/a.ts', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }], created: false }]);
    });
  });
});
