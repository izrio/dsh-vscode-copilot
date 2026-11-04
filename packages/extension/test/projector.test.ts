import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { followFrameSchema, type FollowFrame } from '../src/dsh/remote/follow.ts';
import { SessionJournal } from '../src/dsh/session/journal.ts';
import { activityLabel, displayPath, project } from '../src/vm/projector.ts';
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
  it('MISSING_CREDENTIAL 显示中文提示和打开设置的入口', () => {
    const items = project({
      events: [{ type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key' } } } }],
      pending: [],
    }).items;
    expect(items[0]).toMatchObject({ kind: 'notice', level: 'error', action: { kind: 'openWebUI' } });
    expect(items[0]?.kind === 'notice' && items[0].text).toContain('API Key');
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
