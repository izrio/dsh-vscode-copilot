import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyFollowFrame,
  followFrameSchema,
  initialFollowState,
  liveText,
  type FollowFrame,
  type FollowState,
} from '../src/dsh/remote/follow.ts';

/** 读取 M0 冒烟测试从真实 dsh 0.2.1-rc.5 录制的 follow 帧，并重新走一遍 schema 校验。 */
function fixture(name: string): FollowFrame[] {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/m0/${name}.json`, import.meta.url), 'utf8')) as unknown[];
  return raw.map((frame) => followFrameSchema.parse(frame));
}

/** 从某个场景的第一帧开始回放（场景帧不含开场快照，cursor 从第一个事件之前开始）。 */
function replay(frames: FollowFrame[]): { final: FollowState; liveSamples: string[] } {
  const first = frames.find((frame) => frame.type === 'event');
  let state: FollowState = { ...initialFollowState, cursor: first?.type === 'event' ? first.event.seq - 1 : 0 };
  const liveSamples: string[] = [];
  for (const frame of frames) {
    state = applyFollowFrame(state, frame);
    const text = liveText(state);
    if (text && liveSamples.at(-1) !== text) liveSamples.push(text);
  }
  return { final: state, liveSamples };
}

const types = (state: FollowState) => state.events.map((event) => event.type);

describe('follow 回放：hello（纯文本）', () => {
  const { final, liveSamples } = replay(fixture('hello'));

  it('逐字流按顺序拼出完整回复', () => {
    expect(liveSamples.at(-1)).toBe('Hello, world!');
    expect(liveSamples.length).toBeGreaterThan(1);
    expect(liveSamples.every((text, i) => i === 0 || text.startsWith(liveSamples[i - 1]!))).toBe(true);
  });

  it('assistant/message 到达后临时文本被清除，没有序号缺口', () => {
    expect(final.live).toBeUndefined();
    expect(final.gap).toBeUndefined();
    expect(types(final)).toContain('assistant/message');
    expect(types(final).at(-1)).toBe('turn/end');
  });

  it('用户真正发送的消息 source.kind 为 user，并带上请求的 rpcId', () => {
    const userMessages = final.events.filter((event) => event.type === 'user/message');
    const sources = userMessages.map((event) => (event.data as { source?: { kind?: string } }).source?.kind);
    expect(sources).toContain('user');
    expect(sources.filter((kind) => kind === 'user')).toHaveLength(1);
  });
});

describe('follow 回放：write / edit（文件修改）', () => {
  it('新建文件：meta.operation 为 create，diffs 为空', () => {
    const { final } = replay(fixture('write'));
    const result = final.events.find((event) => event.type === 'tool/result');
    expect((result?.data as { meta?: unknown }).meta).toMatchObject({ operation: 'create', diffs: [] });
    expect(types(final)).toContain('workspace/changes');
  });

  it('修改已有文件：meta.diffs 带 oldText / newText', () => {
    const { final } = replay(fixture('edit'));
    const results = final.events.filter((event) => event.type === 'tool/result');
    const metas = results.map((event) => (event.data as { meta?: { diffs?: unknown[] } }).meta);
    expect(metas.some((meta) => meta?.diffs?.length === 1)).toBe(true);
    expect(metas.find((meta) => meta?.diffs?.length)?.diffs?.[0]).toMatchObject({
      oldText: '# m0 workspace',
      newText: '# m0 workspace (edited)',
    });
  });
});

describe('follow 回放：审批与停止', () => {
  it('批准越权命令时记录 approval/asked 与 approval/decided', () => {
    const { final } = replay(fixture('approval-allow'));
    expect(types(final)).toEqual(expect.arrayContaining(['tool/call', 'approval/asked', 'approval/decided', 'tool/result']));
  });

  it('停止生成：turn/end 原因为用户中止，临时文本已清除', () => {
    const { final, liveSamples } = replay(fixture('cancel'));
    expect(liveSamples.some((text) => text.startsWith('正在'))).toBe(true);
    const end = final.events.find((event) => event.type === 'turn/end');
    expect(end?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } });
    expect(final.live).toBeUndefined();
  });
});

describe('applyFollowFrame 规则', () => {
  const event = (seq: number, type = 'step/start') => ({ type: 'event' as const, event: { type, seq, time: seq, data: {} } });

  it('重复的事件被忽略', () => {
    let state = applyFollowFrame({ ...initialFollowState, cursor: 4 }, event(5));
    state = applyFollowFrame(state, event(5));
    expect(state.events).toHaveLength(1);
  });

  it('事件序号不连续时记录 gap', () => {
    const state = applyFollowFrame({ ...initialFollowState, cursor: 4 }, event(7));
    expect(state.gap).toContain('4');
    expect(state.cursor).toBe(7);
  });

  it('逐字流下标不连续时记录 gap，且不追加内容', () => {
    let state = applyFollowFrame(initialFollowState, {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'a', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 },
    });
    state = applyFollowFrame(state, {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    });
    expect(state.gap).toBeDefined();
    expect(liveText(state)).toBe('');
  });

  it('开场快照里的紧凑流基线可以还原出临时文本', () => {
    const state = applyFollowFrame(initialFollowState, {
      type: 'snapshot',
      header: { id: 's', version: 4, createdAt: 0 },
      cursor: 10,
      records: [],
      hasMore: false,
      projections: {},
      assistantStream: {
        revision: 3,
        activeAttempt: {
          attemptId: 'a',
          startedAfterSeq: 10,
          turn: 2,
          step: 1,
          nextIndex: 4,
          stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0, 1], texts: ['Hel', 'lo'] }],
        },
      },
    });
    expect(liveText(state)).toBe('Hello');
    expect(state.live?.nextIndex).toBe(4);
  });
});
