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
      'activity:write  notes/m0.txt:ok',
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
