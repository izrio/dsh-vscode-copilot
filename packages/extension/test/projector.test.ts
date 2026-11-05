import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { followFrameSchema, type FollowFrame } from '../src/dsh/remote/follow.ts';
import { SessionJournal } from '../src/dsh/session/journal.ts';
import { activityLabel, displayPath, project, projectEvents } from '../src/vm/projector.ts';
import { plainTitle } from '../src/vm/ChatController.ts';

/** 用 M0 录制的真实帧回放出 journal，再投影成界面条目。 */
function journalOf(name: string): SessionJournal {
  const frames = (JSON.parse(readFileSync(new URL(`./fixtures/m0/${name}.json`, import.meta.url), 'utf8')) as unknown[]).map(
    (frame) => followFrameSchema.parse(frame),
  );
  const firstEvent = frames.find((f) => f.type === 'event');
  const firstStream = frames.find((f) => f.type === 'assistant-stream');
  const journal = new SessionJournal();
  journal.accept({
    type: 'snapshot',
    header: { id: 's', version: 4, createdAt: 0 },
    cursor: firstEvent?.type === 'event' ? firstEvent.event.seq - 1 : 0,
    records: [],
    hasMore: false,
    projections: {},
    assistantStream: { revision: firstStream?.type === 'assistant-stream' ? firstStream.frame.revision - 1 : 0 },
  } as FollowFrame);
  for (const frame of frames) journal.accept(frame);
  return journal;
}

const WORKSPACE = '/tmp/dsh-m0/workspace';
const summary = (items: ReturnType<typeof project>['items']) =>
  items.map((item) => {
    switch (item.kind) {
      case 'user':
        return `user:${item.text}`;
      case 'assistant':
        return `assistant:${item.markdown}${item.interrupted ? '[interrupted]' : ''}`;
      case 'activity':
        return `activity:${item.label}:${item.status}`;
      case 'explore':
        return `explore:${item.summary}:${item.status}`;
      case 'changes':
        return `changes:${item.source}:${item.files.map((f) => `${f.path}+${f.additions}-${f.deletions}`).join(',')}`;
      case 'notice':
        return `notice:${item.level}:${item.text}`;
      case 'turnDone':
        return `done:${item.completed ? 'ok' : 'stopped'}`;
    }
  });

describe('project：真实会话', () => {
  it('hello：只显示用户真正发的消息和回复，dsh 注入的上下文消息不显示', () => {
    const journal = journalOf('hello');
    expect(summary(project({ events: journal.events, pending: [], workspacePath: WORKSPACE }).items)).toEqual([
      'user:M0_HELLO 打个招呼',
      'assistant:Hello, world!',
    ]);
  });

  it('write：工具调用渲染成一行活动，显示相对路径', () => {
    const journal = journalOf('write');
    expect(summary(project({ events: journal.events, pending: [], workspacePath: WORKSPACE }).items)).toEqual([
      'user:M0_WRITE 创建一个笔记文件',
      'assistant:我来创建文件。',
      'activity:notes/m0.txt:ok',
      'assistant:文件已创建。',
    ]);
  });

  it('approval-reject：被拒绝的工具调用标记为错误，输出里有原因', () => {
    const journal = journalOf('approval-reject');
    const activity = project({ events: journal.events, pending: [] }).items.find((item) => item.kind === 'activity');
    expect(activity).toMatchObject({ kind: 'activity', tool: 'bash', status: 'error' });
    expect(activity?.kind === 'activity' && activity.output).toContain('rejected');
  });

  it('cancel：保留部分回复并标记中断，追加"已停止生成"', () => {
    const journal = journalOf('cancel');
    const result = project({ events: journal.events, pending: [] });
    expect(summary(result.items)).toEqual(['user:M0_HOLD 慢慢回答', 'assistant:正在[interrupted]', 'notice:info:已停止生成']);
    expect(result.turnOpen).toBe(false);
  });

  it('本地回显在持久消息出现后撤掉，没出现前显示为发送中', () => {
    const journal = journalOf('hello');
    const userEvent = journal.events.find((e) => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'user');
    const rpcId = (userEvent?.data as { source: { rpcId: string } }).source.rpcId;
    const result = project({
      events: journal.events,
      pending: [
        { requestId: rpcId, text: 'M0_HELLO 打个招呼', sentAt: 0, state: 'accepted' },
        { requestId: 'later', text: '下一条', sentAt: 1, state: 'sending' },
      ],
    });
    expect(result.persistedRequestIds.has(rpcId)).toBe(true);
    expect(result.items.filter((item) => item.kind === 'user').map((item) => item.kind === 'user' && [item.text, item.pending])).toEqual([
      ['M0_HELLO 打个招呼', undefined],
      ['下一条', 'sending'],
    ]);
  });
});

describe('project：按工具类型渲染（M2）', () => {
  const event = (seq: number, type: string, data: unknown) => ({ type, seq, time: seq, data });
  const call = (seq: number, callId: string, name: string, args: unknown) => event(seq, 'tool/call', { callId, name, arguments: JSON.stringify(args) });
  const result = (seq: number, callId: string, extra: Record<string, unknown> = {}) =>
    event(seq, 'tool/result', { message: { toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: false }, ...extra });

  it('edit：先读后改，读文件合并成「浏览」，修改显示增删行数和 Diff 入口，本轮结束显示改动汇总', () => {
    const journal = journalOf('edit');
    const lookup = () => ({ turn: 3, files: [{ path: 'README.md', display: 'README.md', added: 1, deleted: 1 }], total: 1 });
    const projection = project({ events: journal.events, pending: [], workspacePath: WORKSPACE, changes: lookup });
    expect(summary(projection.items)).toEqual([
      'user:M0_EDIT 改一下 README',
      'explore:读取 1 个文件:ok',
      'activity:README.md:ok',
      'assistant:已修改 README。',
      'changes:turn:README.md+1-1',
    ]);
    const edit = projection.items.find((item) => item.kind === 'activity');
    expect(edit).toMatchObject({ variant: 'edit', stats: { additions: 1, deletions: 1 }, diff: { kind: 'tool' } });
    expect(edit && 'output' in edit).toBe(false);
    expect(projection.changeSeqs).toEqual([57]);
    const changes = projection.items.find((item) => item.kind === 'changes');
    expect(changes).toMatchObject({ id: 'c:57', files: [{ ref: { kind: 'turn', seq: 57, index: 0 } }] });
    const info = [...projection.toolCalls.values()].find((c) => c.tool === 'edit');
    expect(info).toMatchObject({ path: `${WORKSPACE}/README.md`, status: 'ok', diffs: [{ oldText: '# m0 workspace' }] });
  });

  it('改动汇总还没读到时不显示卡片；Host 重启后不可用时按文件工具汇总', () => {
    const journal = journalOf('edit');
    const loading = project({ events: journal.events, pending: [], workspacePath: WORKSPACE, changes: () => undefined });
    expect(loading.items.some((item) => item.kind === 'changes')).toBe(false);
    const fallback = project({ events: journal.events, pending: [], workspacePath: WORKSPACE, changes: () => 'unavailable' });
    expect(fallback.items.find((item) => item.kind === 'changes')).toMatchObject({
      source: 'tools',
      files: [{ path: 'README.md', additions: 1, deletions: 1, ref: { kind: 'tool' } }],
    });
  });

  it('文件改动历史：有汇总的轮次带 seq/index 和本轮的工具调用，没有汇总的轮次按工具合并；会话改动栏累计行数', () => {
    const events = [
      event(1, 'turn/start', {}),
      call(2, 'c1', 'write', { file_path: '/w/new.txt', content: 'a\nb\n' }),
      result(3, 'c1', { meta: { operation: 'create', path: '/w/new.txt', diffs: [] } }),
      call(4, 'c2', 'edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
      result(5, 'c2', { meta: { path: '/w/a.ts', diffs: [{ oldText: 'x\n', newText: 'y\n' }] } }),
      event(6, 'workspace/changes', { turn: 1 }),
      event(7, 'turn/end', {}),
      event(8, 'turn/start', {}),
      call(9, 'c3', 'edit', { file_path: '/w/a.ts', old_string: 'y', new_string: 'z\nw' }),
      result(10, 'c3', { meta: { path: '/w/a.ts', diffs: [{ oldText: 'y\n', newText: 'z\nw\n' }] } }),
    ];
    const summary = { turn: 1, files: [{ path: 'new.txt', added: 2, deleted: 0 }, { path: 'a.ts', added: 1, deleted: 1 }, { path: 'build.log', added: 3, deleted: 0 }], total: 3 };
    const projection = project({ events, pending: [], workspacePath: '/w', changes: (seq) => (seq === 6 ? summary : undefined) });
    expect(projection.fileHistory.get('/w/a.ts')).toEqual([
      { turnSeq: 6, index: 1, calls: ['c2'], stats: { additions: 1, deletions: 1 }, fromSummary: true, created: false },
      { calls: ['c3'], stats: { additions: 2, deletions: 1 }, fromSummary: false, created: false },
    ]);
    expect(projection.fileHistory.get('/w/build.log')).toEqual([{ turnSeq: 6, index: 2, calls: [], stats: { additions: 3, deletions: 0 }, fromSummary: true, created: false }]);
    expect(projection.fileHistory.get('/w/new.txt')?.[0]).toMatchObject({ calls: ['c1'], created: true });
    expect(projection.sessionChanges).toEqual({
      files: [
        { path: 'new.txt', ref: { kind: 'session', path: '/w/new.txt' }, additions: 2, deletions: 0, created: true },
        { path: 'a.ts', ref: { kind: 'session', path: '/w/a.ts' }, additions: 3, deletions: 2 },
        { path: 'build.log', ref: { kind: 'session', path: '/w/build.log' }, additions: 3, deletions: 0 },
      ],
      additions: 8,
      deletions: 2,
    });
  });

  it('一轮超过 1 秒时结束后显示用时；进行中的一轮带开始时间', () => {
    const at = (seq: number, time: number, type: string, data: unknown) => ({ type, seq, time, data });
    const events = [
      at(1, 1_000, 'turn/start', {}),
      at(2, 84_000, 'turn/end', { reason: { kind: 'completed' } }),
      at(3, 90_000, 'turn/start', {}),
      at(4, 90_500, 'turn/end', { reason: { kind: 'completed' } }),
      at(5, 95_000, 'turn/start', {}),
    ];
    const projection = projectEvents({ events });
    expect(projection.items).toEqual([{ kind: 'turnDone', id: 'd:2', durationMs: 83_000, completed: true }]);
    expect(projection.turnStartedAt).toBe(95_000);
    expect(projectEvents({ events: events.slice(0, 4) }).turnStartedAt).toBeUndefined();
  });

  it('带前缀的工具（ops_grep、ops_read_files、ops_bash）和内置工具一样渲染', () => {
    const events = [
      call(1, 'c1', 'ops_grep', { pattern: 'outline' }),
      result(2, 'c1'),
      call(3, 'c2', 'ops_read_files', { paths: ['/w/a.ts', '/w/b.ts', '/w/c.ts'] }),
      result(4, 'c2'),
      call(5, 'c3', 'ops_grep', { pattern: 'tabs' }),
      result(6, 'c3'),
      call(7, 'c4', 'ops_bash', { command: 'git log --oneline -5' }),
      result(8, 'c4'),
    ];
    const items = project({ events, pending: [], workspacePath: '/w' }).items;
    expect(items).toMatchObject([
      { kind: 'explore', summary: '读取 1 个文件，搜索 2 次', entries: [{ label: 'ops_grep  outline' }, { label: 'ops_read_files  a.ts +2' }, { label: 'ops_grep  tabs' }] },
      { kind: 'activity', variant: 'command', label: 'ops_bash  git log --oneline -5' },
    ]);
  });

  it('write 新建文件：标记新建，新增行数取内容行数', () => {
    const items = project({
      events: [call(1, 'c1', 'write', { file_path: '/w/new.txt', content: 'a\nb\n' }), result(2, 'c1', { meta: { operation: 'create', path: '/w/new.txt', diffs: [] } })],
      pending: [],
      workspacePath: '/w',
    }).items;
    expect(items).toEqual([
      { kind: 'activity', id: 't:c1', tool: 'write', variant: 'edit', label: 'new.txt', status: 'ok', stats: { additions: 2, deletions: 0 }, created: true, diff: { kind: 'tool', callId: 'c1' } },
    ]);
  });

  it('bash：命令行，保留输出', () => {
    const journal = journalOf('bash');
    const activity = project({ events: journal.events, pending: [] }).items.find((item) => item.kind === 'activity');
    expect(activity).toMatchObject({ variant: 'command', label: 'bash  echo m0-bash-ok', status: 'ok' });
    expect(activity?.kind === 'activity' && activity.output).toContain('m0-bash-ok');
  });

  it('连续的只读操作合并成一行，中间有正文时分开', () => {
    const items = project({
      events: [
        call(1, 'r1', 'read', { file_path: 'a.ts' }),
        call(2, 'g1', 'grep', { pattern: 'foo' }),
        result(3, 'r1'),
        event(4, 'assistant/message', { message: { content: [{ type: 'text', text: '看完了' }] } }),
        call(5, 'r2', 'read', { file_path: 'b.ts' }),
      ],
      pending: [],
    }).items;
    expect(summary(items)).toEqual(['explore:读取 1 个文件，搜索 1 次:running', 'assistant:看完了', 'explore:读取 1 个文件:running']);
    expect(items[0]).toMatchObject({ id: 'x:r1', entries: [{ id: 'r1', status: 'ok' }, { id: 'g1', status: 'running' }] });
  });
});

describe('project：规则', () => {
  const event = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}) => ({ type, seq, time: seq, data, ...extra });

  it('surfaceOp 不是 append 的消息不渲染（模型历史改写，例如压缩）', () => {
    const items = project({
      events: [event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'summary' }] } }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } })],
      pending: [],
    }).items;
    expect(items).toEqual([]);
  });

  it('没有正文也没有推理的助手消息不渲染；推理单独放在 reasoning', () => {
    const items = project({
      events: [
        event(1, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'x', name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' }),
        event(2, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '答案' }] } }, { surfaceOp: 'append' }),
      ],
      pending: [],
    }).items;
    expect(items).toEqual([{ kind: 'assistant', id: 'a:2', markdown: '答案', reasoning: '想一想', streaming: false }]);
  });

  it('正在流式输出的内容排在最后，标记 streaming', () => {
    const items = project({
      events: [],
      live: { attemptId: 'a1', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 2, blocks: new Map([[0, { kind: 'text', text: '部分' }]]) },
      pending: [],
    }).items;
    expect(items).toEqual([{ kind: 'assistant', id: 'live:a1', markdown: '部分', streaming: true }]);
  });

  it('turn/end 的错误原因显示为错误提示', () => {
    const items = project({ events: [event(1, 'turn/end', { reason: { kind: 'error', error: { message: 'rate limited' } } })], pending: [] }).items;
    expect(items).toEqual([{ kind: 'notice', id: 'n:1', level: 'error', text: '出错了：rate limited' }]);
  });

  it('follow 还没就绪时用列表里的状态判断排队', () => {
    const pending = [{ requestId: 'r', text: 'x', sentAt: 0, state: 'accepted' as const }];
    expect(project({ events: [], pending, fallbackRunning: true }).items[0]).toMatchObject({ pending: 'queued' });
    expect(project({ events: [], pending }).items[0]).toMatchObject({ pending: 'sending' });
  });
});

describe('activityLabel', () => {
  it('按命令 > 文件 > 搜索词 > 目录的优先级选摘要', () => {
    expect(activityLabel('bash', JSON.stringify({ command: 'pnpm test\n--watch', description: 'Run tests' }))).toBe('bash  pnpm test …');
    expect(activityLabel('read', JSON.stringify({ file_path: '/w/src/a.ts' }), '/w')).toBe('read  src/a.ts');
    expect(activityLabel('grep', JSON.stringify({ pattern: 'answer', path: '.' }))).toBe('grep  answer');
    expect(activityLabel('glob', JSON.stringify({ path: '/w/src' }), '/w')).toBe('glob  src');
    expect(activityLabel('todo_write', '{"todos":[]}')).toBe('todo_write');
    expect(activityLabel('broken', 'not json')).toBe('broken');
  });

  it('工作区外的路径保持绝对路径', () => {
    expect(displayPath('/etc/hosts', '/w')).toBe('/etc/hosts');
    expect(displayPath('relative/a.ts', '/w')).toBe('relative/a.ts');
  });
});

describe('plainTitle', () => {
  it('去掉 Markdown 标记和引号，只取第一行', () => {
    expect(plainTitle('## 项目结构\n这个仓库')).toBe('项目结构');
    expect(plainTitle('**修复** `parseDate`')).toBe('修复 parseDate');
    expect(plainTitle('“重构登录流程”')).toBe('重构登录流程');
  });
});

describe('project：缺少 API Key', () => {
  it('MISSING_CREDENTIAL 显示中文提示和配置入口，并给出 dsh 要求的凭据名', () => {
    const message =
      'llm-deepseek: no API key for provider route "deepseek-official"; store DSH_TEST_API_KEY through the credentials service (the web Models page writes it), or export DSH_TEST_API_KEY in the launching environment';
    const result = project({ events: [{ type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message } } } }], pending: [] });
    expect(result.items[0]).toMatchObject({ kind: 'notice', level: 'error', action: { kind: 'configureApiKey' } });
    expect(result.items[0]?.kind === 'notice' && result.items[0].text).toContain('API Key');
    expect(result.missingCredentialRef).toBe('DSH_TEST_API_KEY');
    // 之后成功完成了一轮：已经配置好了
    const later = project({
      events: [
        { type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message } } } },
        { type: 'turn/end', seq: 5, time: 5, data: { reason: { kind: 'completed' } } },
      ],
      pending: [],
    });
    expect(later.missingCredentialRef).toBeUndefined();
  });
});

describe('project：提问工具', () => {
  it('ask：显示问题，结果转成可读的回答', () => {
    const journal = journalOf('ask');
    const activity = project({ events: journal.events, pending: [] }).items.find((item) => item.kind === 'activity');
    expect(activity).toMatchObject({ label: '提问  改动范围？', output: '回答：只改测试' });
  });
});

describe('project：M3', () => {
  const event = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}) => ({ type, seq, time: seq, data, ...extra });

  it('斜杠命令（/compact）显示为一行，带 dsh 返回的结果', () => {
    const items = project({
      events: [
        event(1, 'command/run', { commandId: 'c1', name: 'compact', args: '', source: { kind: 'user' } }),
        event(2, 'command/done', { commandId: 'c1', kind: 'success', text: 'Compacted 3 history items (~277 tokens).' }),
        event(3, 'command/run', { commandId: 'c2', name: 'feedback', source: { kind: 'user' } }),
        event(4, 'command/done', { commandId: 'c2', kind: 'error', text: 'Feedback text is required. Usage: /feedback <text>' }),
      ],
      pending: [],
    }).items;
    expect(items).toEqual([
      { kind: 'activity', id: 'cmd:c1', tool: 'slash', variant: 'generic', label: '/compact  Compacted 3 history items (~277 tokens).', status: 'ok' },
      { kind: 'activity', id: 'cmd:c2', tool: 'slash', variant: 'generic', label: '/feedback  Feedback text is required. Usage: /feedback <text>', status: 'error' },
    ]);
  });

  it('/permission 显示成一行提示', () => {
    const items = project({
      events: [
        event(1, 'command/run', { commandId: 'c1', name: 'permission', args: ' read-only', source: { kind: 'user' } }),
        event(2, 'command/done', { commandId: 'c1', kind: 'success', text: 'preset read-only' }),
        event(3, 'command/run', { commandId: 'c2', name: 'permission', args: ' nope', source: { kind: 'user' } }),
        event(4, 'command/done', { commandId: 'c2', kind: 'error', text: 'Unknown preset nope' }),
      ],
      pending: [],
    }).items;
    expect(items).toEqual([
      { kind: 'notice', id: 'cmd:c1', level: 'info', text: '权限已切换为「只读」' },
      { kind: 'notice', id: 'cmd:c2', level: 'error', text: '切换权限失败：Unknown preset nope' },
    ]);
  });

  it('用户消息末尾的上下文块不显示在正文里，解析成附件', () => {
    const text = '看看\n\n<ide_context>\nContext …\n<selection path="src/a.ts" lines="3-4" language="typescript">\nx\n</selection>\n</ide_context>';
    const items = project({
      events: [event(1, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } }, { surfaceOp: 'append' })],
      pending: [{ requestId: 'r2', text, sentAt: 0, state: 'sending' }],
    }).items;
    expect(items).toEqual([
      { kind: 'user', id: 'u:1', text: '看看', attachments: [{ kind: 'selection', path: 'src/a.ts', startLine: 3, endLine: 4 }] },
      { kind: 'user', id: 'p:r2', text: '看看', attachments: [{ kind: 'selection', path: 'src/a.ts', startLine: 3, endLine: 4 }], pending: 'sending', requestId: 'r2' },
    ]);
  });
});

describe('project：M4', () => {
  const event = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}) => ({ type, seq, time: seq, data, ...extra });
  const queued = (id: string, rpcId: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } });

  it('队列：插队的排在前面；已经出现在历史里的不再显示；dsh 注入的不显示', () => {
    const items = project({
      events: [event(1, 'user/message', { content: [{ type: 'text', text: '已送达' }], source: { kind: 'user', rpcId: 'r0' } }, { surfaceOp: 'append' })],
      inbox: {
        'next-turn': [queued('m0', 'r0', '已送达'), queued('m1', 'r1', '等下一轮'), { id: 'x', content: [{ type: 'text', text: 'system' }], source: { kind: 'plan-mode' } }],
        'next-step': [queued('m2', 'r2', '插队的')],
      },
      pending: [],
    }).items;
    expect(items.map((item) => (item.kind === 'user' ? `${item.text}:${item.queue?.target ?? '-'}` : item.kind))).toEqual(['已送达:-', '插队的:next-step', '等下一轮:next-turn']);
  });

  it('todo_write 不在对话流里出现；计划工具显示计划标题和审阅结果', () => {
    const plan = '# 重构计划\n\n1. 拆分';
    const items = project({
      events: [
        event(1, 'tool/call', { callId: 't1', name: 'todo_write', arguments: JSON.stringify({ todos: [] }) }),
        event(2, 'tool/result', { message: { toolCallId: 't1', content: [], isError: false } }),
        event(3, 'tool/call', { callId: 'p1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }),
        event(4, 'tool/result', { message: { toolCallId: 'p1', content: [{ type: 'text', text: 'The user chose to keep planning; their feedback: 先补测试' }], isError: true } }),
        event(5, 'tool/call', { callId: 'p2', name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }),
        event(6, 'tool/result', { message: { toolCallId: 'p2', content: [{ type: 'text', text: 'Plan approved — plan mode exited' }], isError: false } }),
        event(7, 'tool/call', { callId: 'p3', name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }),
        event(8, 'tool/result', { message: { toolCallId: 'p3', content: [{ type: 'text', text: 'exit_plan_mode is only available in plan mode' }], isError: true } }),
      ],
      pending: [],
    }).items;
    expect(items.map((item) => item.kind === 'activity' && `${item.label}:${item.status}`)).toEqual([
      '计划  重构计划  继续完善:ok',
      '计划  重构计划  已批准:ok',
      '计划  重构计划:error',
    ]);
  });

  it('缓存的持久事件投影与现算的一致', () => {
    const journal = journalOf('edit');
    const input = { events: journal.events, pending: [], workspacePath: WORKSPACE, changes: () => 'unavailable' as const };
    expect(project(input, projectEvents(input))).toEqual(project(input));
  });
});
