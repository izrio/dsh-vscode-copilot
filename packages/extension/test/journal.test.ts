import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { followFrameSchema, liveBlocksText, type FollowFrame } from '../src/dsh/remote/follow.ts';
import { SessionJournal } from '../src/dsh/session/journal.ts';

/** 读取 M0 冒烟测试从真实 dsh 0.2.1-rc.5 录制的 follow 帧，并重新走一遍 schema 校验。 */
function fixture(name: string): FollowFrame[] {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/m0/${name}.json`, import.meta.url), 'utf8')) as unknown[];
  return raw.map((frame) => followFrameSchema.parse(frame));
}

/** 场景帧不含开场快照：构造一个空快照，让 cursor 和 revision 接在场景第一帧之前。 */
function journalFor(frames: readonly FollowFrame[]): SessionJournal {
  const firstEvent = frames.find((frame) => frame.type === 'event');
  const firstStream = frames.find((frame) => frame.type === 'assistant-stream');
  const journal = new SessionJournal();
  journal.accept({
    type: 'snapshot',
    header: { id: 's', version: 4, createdAt: 0 },
    cursor: firstEvent?.type === 'event' ? firstEvent.event.seq - 1 : 0,
    records: [],
    hasMore: false,
    projections: {},
    assistantStream: { revision: firstStream?.type === 'assistant-stream' ? firstStream.frame.revision - 1 : 0 },
  });
  return journal;
}

function replay(name: string) {
  const frames = fixture(name);
  const journal = journalFor(frames);
  const liveSamples: string[] = [];
  const results = frames.map((frame) => {
    const result = journal.accept(frame);
    const text = liveBlocksText(journal.live?.blocks ?? new Map());
    if (text && liveSamples.at(-1) !== text) liveSamples.push(text);
    return result;
  });
  return { journal, frames, liveSamples, results };
}

const types = (journal: SessionJournal) => journal.events.map((event) => event.type);

describe('回放真实帧：hello（纯文本）', () => {
  const { journal, liveSamples, results } = replay('hello');

  it('全程没有 rebaseline', () => {
    expect(results.every((result) => result === 'ok')).toBe(true);
  });

  it('逐字流按顺序拼出完整回复', () => {
    expect(liveSamples.at(-1)).toBe('Hello, world!');
    expect(liveSamples.length).toBeGreaterThan(1);
    expect(liveSamples.every((text, i) => i === 0 || text.startsWith(liveSamples[i - 1]!))).toBe(true);
  });

  it('assistant/message 只发布一次，临时内容已撤掉', () => {
    expect(types(journal).filter((type) => type === 'assistant/message')).toHaveLength(1);
    expect(journal.live).toBeUndefined();
    expect(types(journal).at(-1)).toBe('turn/end');
  });

  it('assistant/message 在 end 帧之前暂存，end 之后才可见', () => {
    const frames = fixture('hello');
    const j = journalFor(frames);
    const messageIndex = frames.findIndex((f) => f.type === 'event' && f.event.type === 'assistant/message');
    const endIndex = frames.findIndex((f) => f.type === 'assistant-stream' && f.frame.type === 'end');
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(messageIndex);
    for (const frame of frames.slice(0, messageIndex + 1)) j.accept(frame);
    expect(types(j)).not.toContain('assistant/message');
    expect(liveBlocksText(j.live?.blocks ?? new Map())).toBe('Hello, world!');
    for (const frame of frames.slice(messageIndex + 1, endIndex + 1)) j.accept(frame);
    expect(types(j)).toContain('assistant/message');
    expect(j.live).toBeUndefined();
  });

  it('事件按 seq 升序', () => {
    const seqs = journal.events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});

describe('回放真实帧：其他场景', () => {
  it.each(['write', 'edit', 'bash', 'approval-allow', 'approval-reject', 'ask', 'cancel'])('%s：没有 rebaseline，结束时没有临时内容', (name) => {
    const { journal, results } = replay(name);
    expect(results.filter((result) => result !== 'ok')).toEqual([]);
    expect(journal.live).toBeUndefined();
    expect(types(journal)).toContain('turn/end');
  });

  it('write：tool/result.meta 为 create', () => {
    const { journal } = replay('write');
    const result = journal.events.find((event) => event.type === 'tool/result');
    expect((result?.data as { meta?: unknown }).meta).toMatchObject({ operation: 'create', diffs: [] });
  });

  it('cancel：被中断的消息带 interrupted，轮次以用户中止结束', () => {
    const { journal, liveSamples } = replay('cancel');
    expect(liveSamples.some((text) => text.startsWith('正在'))).toBe(true);
    const end = journal.events.find((event) => event.type === 'turn/end');
    expect(end?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } });
  });
});

describe('SessionJournal 规则', () => {
  const snapshot = (cursor = 4, revision = 0): FollowFrame => ({
    type: 'snapshot',
    header: { id: 's', version: 4, createdAt: 0 },
    cursor,
    records: [],
    hasMore: true,
    projections: {},
    assistantStream: { revision },
  });
  const event = (seq: number, type = 'step/start', data: unknown = { turn: 1, step: 1 }, extra: Record<string, unknown> = {}): FollowFrame => ({
    type: 'event',
    event: { type, seq, time: seq, data, ...extra },
  });
  const stream = (frame: Record<string, unknown>): FollowFrame => ({ type: 'assistant-stream', frame } as FollowFrame);
  const start = (revision: number) => stream({ type: 'start', attemptId: 'a', revision, startedAfterSeq: 4, turn: 1, step: 1 });
  const chunk = (revision: number, index: number, text: string) =>
    stream({ type: 'chunk', attemptId: 'a', revision, index, time: 0, chunk: { type: 'text-delta', index: 0, text } });

  function fresh(): SessionJournal {
    const journal = new SessionJournal();
    journal.accept(snapshot());
    return journal;
  }

  it('重复的事件被忽略，不连续的事件要求 rebaseline', () => {
    const journal = fresh();
    expect(journal.accept(event(5))).toBe('ok');
    expect(journal.accept(event(5))).toBe('ok');
    expect(journal.events).toHaveLength(1);
    expect(journal.accept(event(8))).toBe('rebaseline');
  });

  it('逐字流 revision 跳号要求 rebaseline', () => {
    const journal = fresh();
    expect(journal.accept(start(1))).toBe('ok');
    expect(journal.accept(chunk(3, 0, 'x'))).toBe('rebaseline');
  });

  it('逐字流下标跳号要求 rebaseline', () => {
    const journal = fresh();
    journal.accept(start(1));
    expect(journal.accept(chunk(2, 1, 'x'))).toBe('rebaseline');
  });

  it('上一次尝试未结束又收到 start 要求 rebaseline', () => {
    const journal = fresh();
    journal.accept(start(1));
    expect(journal.accept(start(2))).toBe('rebaseline');
  });

  it('end 对不上暂存的结算要求 rebaseline', () => {
    const journal = fresh();
    journal.accept(start(1));
    journal.accept(chunk(2, 0, 'hi'));
    const result = journal.accept(
      stream({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } }),
    );
    expect(result).toBe('rebaseline');
  });

  it('abandoned 撤掉临时内容', () => {
    const journal = fresh();
    journal.accept(start(1));
    journal.accept(chunk(2, 0, 'hi'));
    expect(journal.accept(stream({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'abandoned' } }))).toBe('ok');
    expect(journal.live).toBeUndefined();
  });

  it('错过 start 的 chunk 被忽略，持久结算直接发布', () => {
    const journal = fresh();
    expect(journal.accept(chunk(1, 5, 'late'))).toBe('ok');
    expect(journal.live).toBeUndefined();
    journal.accept(event(5, 'assistant/message', { turn: 1, step: 1 }, { surfaceOp: 'append' }));
    expect(journal.events.map((e) => e.type)).toEqual(['assistant/message']);
  });

  it('没收到 end 帧时，暂存的结算在 step/end 时一并发布', () => {
    const journal = fresh();
    journal.accept(start(1));
    journal.accept(chunk(2, 0, 'hi'));
    journal.accept(event(5, 'assistant/message', { turn: 1, step: 1 }, { surfaceOp: 'append' }));
    expect(journal.events).toHaveLength(0);
    journal.accept(event(6, 'step/end'));
    expect(journal.events.map((e) => e.type)).toEqual(['assistant/message', 'step/end']);
    expect(journal.live).toBeUndefined();
  });

  it('开场快照的紧凑流基线只还原 nextIndex 之前的部分', () => {
    const journal = new SessionJournal();
    journal.accept({
      ...snapshot(10, 3),
      assistantStream: {
        revision: 3,
        activeAttempt: {
          attemptId: 'a',
          startedAfterSeq: 10,
          turn: 2,
          step: 1,
          nextIndex: 3,
          stream: [
            { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
            { type: 'text-chunks', time0: 0, index: 0, dt: [0, 1, 1], texts: ['Hel', 'lo', '!!'] },
          ],
        },
      },
    } as FollowFrame);
    expect(liveBlocksText(journal.live?.blocks ?? new Map())).toBe('Hello');
    // 接着收到下标 3 的 chunk
    expect(journal.accept(stream({ type: 'chunk', attemptId: 'a', revision: 4, index: 3, time: 0, chunk: { type: 'text-delta', index: 0, text: '!' } }))).toBe('ok');
    expect(liveBlocksText(journal.live?.blocks ?? new Map())).toBe('Hello!');
  });

  it('prependOlder 把更早的历史插到前面并去重', () => {
    const journal = fresh();
    journal.accept(event(5));
    journal.prependOlder([{ type: 'turn/start', seq: 3, time: 3, data: {} }, { type: 'step/start', seq: 5, time: 5, data: {} }], false);
    expect(journal.events.map((e) => e.seq)).toEqual([3, 5]);
    expect(journal.hasOlder).toBe(false);
  });

  it('version 在可见内容变化时递增', () => {
    const journal = fresh();
    const before = journal.version;
    journal.accept(event(5));
    expect(journal.version).toBeGreaterThan(before);
  });
});
