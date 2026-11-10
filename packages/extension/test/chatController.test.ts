import { describe, expect, it } from 'vitest';
import type { HostToWebview, ItemsPatch } from '@dsh-copilot/shared';
import type { DshClient, SessionSummaryWire } from '../src/dsh/DshClient.ts';
import { AsyncQueue } from '../src/dsh/remote/asyncQueue.ts';
import type { WaterfallHandler, WaterfallOutcome } from '../src/dsh/remote/events.ts';
import type { FollowFrame } from '../src/dsh/remote/follow.ts';
import { ChangesUnavailableError } from '../src/dsh/DshClient.ts';
import { ChatController } from '../src/vm/ChatController.ts';
import { noWorkbench, type DiffRequest, type Workbench } from '../src/vm/workbench.ts';
import { TransportError } from '../src/dsh/remote/errors.ts';
import { ChangesCache } from '../src/vm/ChangesCache.ts';
import { setLocale } from '../src/i18n.ts';

/** 只实现 SessionService / SessionStream 用到的方法；follow 由测试控制。 */
function fakeClient() {
  const summaries: SessionSummaryWire[] = [];
  const follows = new Map<string, AsyncQueue<FollowFrame>>();
  const prompts: { sessionId: string; text: string; requestId: string }[] = [];
  const commands: { sessionId: string; line: string }[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
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
    commands: async () => [
      { name: 'compact', description: 'Compact older conversation history' },
      { name: 'export', description: 'Download this Session log as a ZIP archive' },
      { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
    ],
    fileReferences: async (_sessionId: string, query: string) => [{ path: `src/${query}.ts`, kind: 'file' }],
    updateQueue: async (...args: unknown[]) => void calls.push({ method: 'updateQueue', args }),
    rename: async (sessionId: string, title: string) => {
      calls.push({ method: 'rename', args: [sessionId, title] });
      return title.trim();
    },
    setCredential: async (...args: unknown[]) => void calls.push({ method: 'setCredential', args }),
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
    // eslint-disable-next-line require-yield -- 控制流不推送任何帧，等到中止
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
      yield {
        type: 'snapshot',
        header: { id: sessionId, version: 4, createdAt: 0 },
        cursor: seq,
        records: [],
        hasMore: false,
        projections: {},
        assistantStream: { revision: 0 },
      } as FollowFrame;
      yield* queue;
    },
  };
  return {
    client: client as unknown as DshClient,
    prompts,
    commands,
    calls,
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
    const echo = patches()
      .at(-1)
      ?.upsert.find((item) => item.kind === 'user');
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
    expect(patch.upsert.map((item) => item.id)).toEqual(['a:1.1']);
    expect(patch.order).toEqual(['u:1', 'a:1.1']);
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

  it('未连接时发送给出提示，不抛错，文字还给输入框', async () => {
    const { controller, posted } = setup();
    await controller.handle({ type: 'sendMessage', payload: { text: 'x' } });
    expect(posted.at(-2)).toMatchObject({ type: 'toast', payload: { level: 'error' } });
    expect(posted.at(-1)).toEqual({ type: 'restoreDraft', payload: { text: 'x' } });
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
      fake.emit('s1', 'tool/call', {
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'rm -rf build', sandbox_permissions: 'danger-full-access' }),
      });
      const request = fake.waterfall('approval/request', 's1', {
        toolName: 'bash',
        callId: 'c1',
        reason: 'needs network',
        displayReason: { en: 'needs network', zh: '需要访问网络' },
      });
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
        {
          kind: 'question',
          id: request.id,
          questions: [{ id: 'q', question: '选哪个？', options: [{ label: 'A' }, { label: 'B', description: '更快' }], multiSelect: true }],
        },
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
        {
          type: 'tool/call',
          seq: 1,
          time: 1,
          data: { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }) },
        },
        {
          type: 'tool/result',
          seq: 2,
          time: 2,
          surfaceOp: 'append',
          data: { message: { toolCallId: 'c1', content: [], isError: false }, meta: { path: '/w/a.ts', diffs: [{ oldText: 'a', newText: 'b' }] } },
        },
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
          yield {
            type: 'snapshot',
            header: { id: 's1', version: 4, createdAt: 0 },
            cursor: 3,
            records: history.map((event) => ({ type: 'event', event })),
            hasMore: false,
            projections: {},
            assistantStream: { revision: 0 },
          };
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
      fake.emit('s1', 'tool/result', {
        message: { toolCallId: 'c1', content: [], isError: false },
        meta: { path: '/w/a.ts', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] },
      });
      await flush();
      controller.snapshot();
      await controller.handle({ type: 'openDiff', payload: { ref: { kind: 'tool', callId: 'c1' } } });
      expect(diffs).toEqual([{ kind: 'tool', path: '/w/a.ts', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }], created: false }]);
    });
  });

  describe('M3：上下文、斜杠命令、@ 引用', () => {
    const editor = {
      path: '/w/src/a.ts',
      languageId: 'typescript',
      selection: {
        startLine: 3,
        endLine: 4,
        text: 'let x = 1;\nlet y: string = x;',
        diagnostics: ['4: error ts 2322: Type number is not assignable to type string.'],
      },
    };

    function withEditor(snapshot: typeof editor | undefined, extra: Partial<Workbench> = {}) {
      const found: string[] = [];
      const workbench: Workbench = {
        ...noWorkbench,
        activeEditor: () => snapshot,
        findFiles: async (query) => {
          found.push(query);
          return [{ path: `vscode/${query}`, kind: 'file' }];
        },
        ...extra,
      };
      return { ...setup(workbench), found };
    }

    const sentText = (fake: ReturnType<typeof fakeClient>) => fake.prompts.at(-1)?.text ?? '';

    it('默认附带当前选区（不带诊断信息），输入框上方显示选区标签', async () => {
      const { controller, fake } = withEditor(editor);
      controller.setClient(fake.client);
      await flush();
      expect(controller.snapshot().context).toEqual({
        active: { kind: 'selection', path: 'src/a.ts', startLine: 3, endLine: 4, key: 's:/w/src/a.ts:3-4' },
        includeActiveByDefault: true,
        pinned: [],
      });
      await controller.handle({ type: 'sendMessage', payload: { text: '这里有问题吗' } });
      expect(sentText(fake)).toContain('<selection path="src/a.ts" lines="3-4" language="typescript">\nlet x = 1;\nlet y: string = x;\n</selection>');
      expect(sentText(fake)).not.toContain('<diagnostics');
      await flush();
      const echo = controller.snapshot().items.find((item) => item.kind === 'user');
      expect(echo).toMatchObject({ text: '这里有问题吗', attachments: [{ kind: 'selection', path: 'src/a.ts', startLine: 3, endLine: 4 }] });
    });

    it('关掉标签后不附带；没有选区时只附带文件路径', async () => {
      const { controller, fake } = withEditor({ path: '/w/src/a.ts', languageId: 'typescript' } as typeof editor);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '一', includeActive: false } });
      expect(sentText(fake)).toBe('一');
      await controller.handle({ type: 'sendMessage', payload: { text: '二' } });
      expect(sentText(fake)).toContain('<active-file path="src/a.ts" />');
    });

    it('/fix 展开成模板并附带诊断信息；没有上下文也没有说明时提示', async () => {
      const { controller, fake } = withEditor(editor);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '/fix 类型不对' } });
      expect(sentText(fake)).toMatch(/^找出这段代码里的问题并修复。[\s\S]*\n\n类型不对\n\n<ide_context>/u);
      expect(sentText(fake)).toContain('<diagnostics path="src/a.ts">\n4: error ts 2322');

      const empty = withEditor(undefined);
      empty.controller.setClient(empty.fake.client);
      await flush();
      await empty.controller.handle({ type: 'sendMessage', payload: { text: '/explain' } });
      expect(empty.fake.prompts).toHaveLength(0);
      expect(empty.posted.at(-2)).toMatchObject({ type: 'toast', payload: { level: 'info' } });
      expect(empty.posted.at(-1)).toMatchObject({ type: 'restoreDraft', payload: { text: '/explain' } });
    });

    it('dsh 命令交给 dsh 执行（新对话先创建会话）；/export 不出现在列表里；不认识的命令按普通消息发送', async () => {
      const { controller, fake } = withEditor(undefined);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await flush();
      await flush();
      const names = controller.snapshot().commands.map((c) => `${c.source}:${c.name}`);
      expect(names).toEqual(['plugin:explain', 'plugin:fix', 'plugin:test', 'plugin:new', 'dsh:compact', 'dsh:plan']);
      await controller.handle({ type: 'sendMessage', payload: { text: '/plan 先出方案' } });
      expect(fake.commands).toEqual([{ sessionId: 's1', line: '/plan 先出方案' }]);
      await controller.handle({ type: 'sendMessage', payload: { text: '/unknown 你好' } });
      expect(sentText(fake)).toBe('/unknown 你好');
    });

    it('/new 回到新对话', async () => {
      const { controller, fake } = withEditor(undefined);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await flush();
      expect(controller.snapshot().session.id).toBe('s1');
      await controller.handle({ type: 'sendMessage', payload: { text: '/new' } });
      expect(controller.snapshot().session.id).toBeUndefined();
    });

    it('@ 补全：有会话时用 dsh 的候选，新对话用 VS Code 的文件搜索', async () => {
      const { controller, fake, posted, found } = withEditor(undefined);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'searchFiles', payload: { requestId: 1, query: 'a' } });
      expect(found).toEqual(['a']);
      expect(posted.at(-1)).toEqual({ type: 'fileCandidates', payload: { requestId: 1, items: [{ path: 'vscode/a', kind: 'file' }] } });
      await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await controller.handle({ type: 'searchFiles', payload: { requestId: 2, query: 'b' } });
      expect(posted.at(-1)).toEqual({ type: 'fileCandidates', payload: { requestId: 2, items: [{ path: 'src/b.ts', kind: 'file' }] } });
    });

    it('右键「解释」：带上选区立即发送，不重复附带当前编辑器', async () => {
      const { controller, fake } = withEditor(editor);
      controller.setClient(fake.client);
      await flush();
      await controller.askAboutSelection('explain');
      const text = sentText(fake);
      expect(text).toMatch(/^解释这段代码/u);
      expect(text.match(/<selection /gu)).toHaveLength(1);
    });

    it('「添加到对话」固定选区，发送时附带后清空；可以移除', async () => {
      const current: { value: typeof editor | undefined } = { value: editor };
      const { controller, fake } = withEditor(undefined, { activeEditor: () => current.value });
      controller.setClient(fake.client);
      await flush();
      controller.pinActiveEditor();
      current.value = { path: '/w/src/b.ts', languageId: 'typescript' } as typeof editor;
      controller.pinActiveEditor();
      const pinned = controller.snapshot().context.pinned;
      expect(pinned.map((p) => p.path)).toEqual(['src/a.ts', 'src/b.ts']);
      await controller.handle({ type: 'removeAttachment', payload: { id: pinned[1]!.id } });
      current.value = undefined;
      await controller.handle({ type: 'sendMessage', payload: { text: '对比一下' } });
      expect(sentText(fake)).toContain('<selection path="src/a.ts"');
      expect(sentText(fake)).not.toContain('src/b.ts');
      expect(controller.snapshot().context.pinned).toEqual([]);
    });

    it('计划模式投影显示在标题信息里', async () => {
      const { controller, fake } = withEditor(undefined);
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await flush();
      const service = (controller as unknown as { service: { acceptSnapshotProjections: (id: string, b: unknown) => void } }).service;
      service.acceptSnapshotProjections('s1', { values: { plan: { active: true, pending: false } } });
      expect(controller.snapshot().session.planMode).toBe(true);
    });
  });

  describe('M4：排队、计划审阅、状态条、重命名、API Key、多根工作区', () => {
    async function opened(workbench: Workbench = noWorkbench) {
      const ctx = setup(workbench);
      ctx.controller.setClient(ctx.fake.client);
      await flush();
      await ctx.controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await flush();
      const service = (ctx.controller as unknown as { service: { acceptSnapshotProjections: (id: string, b: unknown) => void } }).service;
      const setProjections = (values: Record<string, unknown>) => service.acceptSnapshotProjections('s1', { values });
      return { ...ctx, setProjections };
    }

    const queued = (id: string, rpcId: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } });

    it('dsh 队列里的消息显示为排队中，带队列信息；替代同一条的本地回显', async () => {
      const { controller, fake, setProjections } = await opened();
      const { requestId } = fake.prompts[0]!;
      setProjections({
        inbox: {
          'next-turn': [queued('m1', requestId, '你好'), queued('m2', 'r-other', '第二条\n\n<ide_context>\nx\n<active-file path="a.ts" />\n</ide_context>')],
          'next-step': [],
        },
      });
      await flush();
      const users = controller.snapshot().items.filter((item) => item.kind === 'user');
      expect(users).toEqual([
        { kind: 'user', id: `p:${requestId}`, text: '你好', pending: 'queued', requestId, queue: { itemId: 'm1', target: 'next-turn' } },
        {
          kind: 'user',
          id: 'p:r-other',
          text: '第二条',
          attachments: [{ kind: 'file', path: 'a.ts' }],
          pending: 'queued',
          requestId: 'r-other',
          queue: { itemId: 'm2', target: 'next-turn' },
        },
      ]);
    });

    it('编辑排队的消息时保留原来的上下文块；删除、插队直接转给 dsh', async () => {
      const { controller, fake, setProjections } = await opened();
      setProjections({
        inbox: { 'next-turn': [queued('m2', 'r2', '第二条\n\n<ide_context>\nx\n<active-file path="a.ts" />\n</ide_context>')], 'next-step': [] },
      });
      await controller.handle({ type: 'queueAction', payload: { action: 'edit', itemId: 'm2', text: '第二条（改）' } });
      await controller.handle({ type: 'queueAction', payload: { action: 'steer', itemId: 'm2' } });
      await controller.handle({ type: 'queueAction', payload: { action: 'remove', itemId: 'm2' } });
      expect(fake.calls.filter((c) => c.method === 'updateQueue').map((c) => c.args)).toEqual([
        ['s1', 'm2', { kind: 'edit', text: '第二条（改）\n\n<ide_context>\nx\n<active-file path="a.ts" />\n</ide_context>' }],
        ['s1', 'm2', { kind: 'steer' }],
        ['s1', 'm2', { kind: 'remove' }],
      ]);
    });

    it('计划审阅：提问带上 intent，"继续完善"的选项标签也带上', async () => {
      const { controller, fake } = await opened();
      fake.waterfall('user-questions/request', 's1', {
        questions: [
          {
            id: 'plan-review',
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: '# 计划\n\n1. 拆分',
            options: [{ label: 'Approve' }, { label: 'Keep planning' }],
            intent: { kind: 'plan-review', approve: 'Approve', callId: 'c1' },
          },
        ],
      });
      await flush();
      expect(controller.snapshot().interactions[0]).toMatchObject({
        kind: 'question',
        questions: [{ id: 'plan-review', detail: '# 计划\n\n1. 拆分', intent: { kind: 'plan-review', approve: 'Approve', keepPlanning: 'Keep planning' } }],
      });
    });

    it('待办和目标显示在会话信息里', async () => {
      const { controller, setProjections } = await opened();
      setProjections({
        todos: [{ content: '读代码', status: 'completed' }, { content: '改实现', status: 'in_progress' }, { content: 'bad' }],
        goal: { goal: { id: 'g', revision: 2, objective: '把测试修绿', phase: 'active', maxGoalRounds: 10 }, roundsStarted: 2, createdAt: 0, updatedAt: 0 },
      });
      expect(controller.snapshot().session).toMatchObject({
        todos: [
          { content: '读代码', status: 'completed' },
          { content: '改实现', status: 'in_progress' },
        ],
        goal: { objective: '把测试修绿', phase: 'active', round: 2, maxRounds: 10 },
      });
    });

    it('重命名：用原生输入框，取消时不改', async () => {
      const answers: (string | undefined)[] = [undefined, ' 新标题 '];
      const { controller, fake } = await opened({ ...noWorkbench, input: async () => answers.shift() });
      await controller.handle({ type: 'renameSession', payload: {} });
      expect(fake.calls.filter((c) => c.method === 'rename')).toEqual([]);
      await controller.handle({ type: 'renameSession', payload: {} });
      expect(fake.calls.filter((c) => c.method === 'rename').map((c) => c.args)).toEqual([['s1', '新标题']]);
      expect(controller.snapshot().session.title).toBe('新标题');
    });

    it('没有 API Key：模型目录为空时提示配置；保存到 dsh 要求的凭据名并重新读取目录', async () => {
      const inputs: { password?: boolean }[] = [];
      const workbench: Workbench = { ...noWorkbench, input: async (options) => (inputs.push(options), 'sk-test') };
      const { controller, fake } = setup(workbench);
      let catalogCalls = 0;
      (fake.client as unknown as { modelCatalog: () => Promise<unknown> }).modelCatalog = async () =>
        ++catalogCalls === 1
          ? { default: { provider: 'deepseek-official', model: 'deepseek-flash' }, groups: [] }
          : { groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] };
      controller.setClient(fake.client);
      await flush();
      expect(controller.snapshot().models.needsApiKey).toBe(true);
      await controller.handle({ type: 'sendMessage', payload: { text: '你好' } });
      await flush();
      fake.emit('s1', 'turn/end', {
        reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key; store MY_KEY through the credentials service' } },
      });
      await flush();
      controller.snapshot();
      await controller.handle({ type: 'configureApiKey', payload: {} });
      expect(inputs[0]?.password).toBe(true);
      expect(fake.calls.filter((c) => c.method === 'setCredential').map((c) => c.args)).toEqual([['MY_KEY', 'sk-test']]);
      expect(controller.snapshot().models.needsApiKey).toBeUndefined();
    });

    it('多根工作区切换文件夹：重新读取会话列表，新对话在新文件夹里创建', async () => {
      const { controller, fake } = setup();
      const workspaces: string[] = [];
      const client = fake.client as unknown as { ensureWorkspace: (path: string) => Promise<unknown>; listSessions: () => Promise<unknown[]> };
      client.ensureWorkspace = async (path: string) => (workspaces.push(path), { workspaceId: `w:${path}`, created: false });
      controller.setClient(fake.client);
      await flush();
      controller.setWorkspace('/other');
      await flush();
      expect(workspaces).toEqual(['/w', '/other']);
      expect(controller.snapshot().session.id).toBeUndefined();
    });

    it('推送增量时，没变的条目不重复推送（持久事件投影有缓存）', async () => {
      const { controller, fake, patches } = await opened();
      fake.emit('s1', 'user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: fake.prompts[0]!.requestId } });
      fake.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '在的' }] } });
      await flush();
      controller.render();
      const before = patches().length;
      controller.workspaceChanged();
      await flush();
      expect(patches().length).toBe(before);
    });
  });

  describe('发送失败和断线', () => {
    const users = (controller: ChatController) => controller.snapshot().items.flatMap((i) => (i.kind === 'user' ? [[i.text, i.pending ?? 'persisted']] : []));

    it('创建会话失败时把文字还给输入框', async () => {
      const { controller, fake, posted } = setup();
      (fake.client as unknown as { createSession: () => Promise<string> }).createSession = async () => {
        throw new TransportError('session/create 请求失败');
      };
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '很长的一段需求' } });
      expect(posted.at(-1)).toEqual({ type: 'restoreDraft', payload: { text: '很长的一段需求' } });
      expect(users(controller)).toEqual([]);
    });

    it('发送失败的消息在重连后仍然可以重试', async () => {
      const { controller, fake, posted } = setup();
      controller.setClient(fake.client);
      await flush();
      await controller.handle({ type: 'sendMessage', payload: { text: '第一条' } });
      const client = fake.client as unknown as { prompt: (...args: unknown[]) => Promise<string> };
      const ok = client.prompt;
      client.prompt = async () => {
        throw new TransportError('session/prompt 请求失败');
      };
      await controller.handle({ type: 'sendMessage', payload: { text: '断线时发的' } });
      // 有可以重试的回显，不再把文字还给输入框
      expect(posted.some((m) => m.type === 'restoreDraft')).toBe(false);
      controller.setClient(undefined);
      client.prompt = ok;
      controller.setClient(fake.client);
      await flush();
      await flush();
      expect(users(controller)).toContainEqual(['断线时发的', 'failed']);
      const failed = controller.snapshot().items.find((i) => i.kind === 'user' && i.pending === 'failed');
      await controller.handle({ type: 'retryPending', payload: { requestId: (failed as { requestId: string }).requestId } });
      expect(fake.prompts.at(-1)?.text).toBe('断线时发的');
    });

    it('英文界面：传输错误给出可读的提示，审批原因用英文', async () => {
      setLocale('en');
      try {
        const { controller, fake, posted } = setup();
        (fake.client as unknown as { prompt: () => Promise<string> }).prompt = async () => {
          throw new TransportError('session/prompt 请求失败');
        };
        controller.setClient(fake.client);
        await flush();
        await controller.handle({ type: 'sendMessage', payload: { text: 'hi' } });
        const toast = posted.find((m) => m.type === 'toast');
        expect(toast).toMatchObject({ payload: { text: 'Failed to send: Could not communicate with dsh. See the log for details' } });

        const approval = fake.waterfall('approval/request', 's1', { toolName: 'bash', displayReason: { en: 'Needs network', zh: '需要网络' } });
        await flush();
        expect(controller.snapshot().interactions[0]).toMatchObject({ kind: 'approval', reason: 'Needs network' });
        approval.cancel();
      } finally {
        setLocale('zh');
      }
    });

    it('等待处理的请求数变化时通知（视图徽标）', async () => {
      const counts: number[] = [];
      const posted: HostToWebview[] = [];
      const controller = new ChatController({
        workspacePath: '/w',
        post: (m) => posted.push(m),
        log: () => undefined,
        loadActiveSessionId: () => undefined,
        saveActiveSessionId: () => undefined,
        openExternal: () => undefined,
        restartRuntime: () => undefined,
        showLogs: () => undefined,
        openWebUI: () => undefined,
        onAttentionChange: (count) => counts.push(count),
        renderDelayMs: 0,
      });
      const fake = fakeClient();
      controller.setClient(fake.client);
      await flush();
      const request = fake.waterfall('approval/request', 'other-session', { toolName: 'bash' });
      await flush();
      request.cancel();
      await flush();
      expect(counts).toEqual([1, 0]);
    });
  });

  describe('ChangesCache', () => {
    it('临时错误按退避重试，成功后不再读取；404 直接记为不可用', async () => {
      let calls = 0;
      const client = {
        changesSummary: async (_id: string, seq: number) => {
          calls++;
          if (seq === 2) throw new ChangesUnavailableError();
          if (calls === 1) throw new TransportError('/api/changes.summary 请求失败');
          return { turn: 1, files: [], total: 0 };
        },
      } as unknown as DshClient;
      let changes = 0;
      const cache = new ChangesCache({ onChange: () => changes++, log: () => undefined, retryDelayMs: () => 10 });
      cache.load(client, 's', [1]);
      await flush();
      expect(cache.lookup('s')(1)).toBeUndefined();
      // 退避期间不重试
      cache.load(client, 's', [1]);
      expect(calls).toBe(1);
      await flush();
      cache.load(client, 's', [1]);
      await flush();
      expect(cache.lookup('s')(1)).toEqual({ turn: 1, files: [], total: 0 });
      cache.load(client, 's', [1, 2]);
      await flush();
      expect(calls).toBe(3);
      expect(cache.lookup('s')(2)).toBe('unavailable');
      expect(changes).toBeGreaterThan(0);
      cache.dispose();
    });

    it('连续失败到上限后记为不可用', async () => {
      const client = { changesSummary: async () => Promise.reject(new TransportError('x')) } as unknown as DshClient;
      const cache = new ChangesCache({ onChange: () => undefined, log: () => undefined, retryDelayMs: () => 0, maxAttempts: 2 });
      cache.load(client, 's', [1]);
      await flush();
      cache.load(client, 's', [1]);
      await flush();
      expect(cache.lookup('s')(1)).toBe('unavailable');
      cache.dispose();
    });
  });
});
