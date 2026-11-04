/**
 * `session/follow` 流的状态合并（纯函数，不做 I/O）。
 *
 * 帧类型（dsh packages/api/session-controller/src/types.ts 的 SessionFollowFrame）：
 * - `snapshot`：开场快照，含 header、cursor、历史 records、投影，以及进行中的 assistant 流基线；
 * - `event`：一条持久会话事件 `{ type, seq, time, data }`；
 * - `assistant-stream`：逐字流帧 `start` / `chunk` / `end`。
 *
 * M0 只实现能跑通展示的最小规则；完整的结算和缺口修复语义（与官方 SessionEventStream 对齐）在 M1 完成：
 * - 持久事件按 seq 去重，发现不连续时记下 `gap`，由调用方决定是否重新打开 follow；
 * - 逐字流按 `index` 连续追加，不连续时记下 `gap`；
 * - `end` 帧或同一轮同一步的 `assistant/message` / `assistant/attempt` 到达时，移除临时文本。
 */
import { z } from 'zod';

/**
 * 持久事件。用 looseObject 保留未知字段（`surfaceOp`、`sourceEventSeqs`、`ignorable` 等），
 * 让新版本 dsh 增加的字段原样传下去，也让录制的 fixture 保持真实。
 */
export const wireEventSchema = z.looseObject({
  type: z.string(),
  seq: z.number().int(),
  time: z.number(),
  data: z.unknown(),
});

export type WireEvent = z.infer<typeof wireEventSchema>;

const recordSchema = z.object({ type: z.literal('event'), event: wireEventSchema });

const attemptBaseline = z.object({
  attemptId: z.string(),
  startedAfterSeq: z.number(),
  turn: z.number(),
  step: z.number(),
  nextIndex: z.number().int(),
  stream: z.array(z.unknown()),
});

const streamFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    attemptId: z.string(),
    revision: z.number(),
    startedAfterSeq: z.number(),
    turn: z.number(),
    step: z.number(),
  }),
  z.object({
    type: z.literal('chunk'),
    attemptId: z.string(),
    revision: z.number(),
    index: z.number().int(),
    time: z.number(),
    chunk: z.unknown(),
  }),
  z.object({
    type: z.literal('end'),
    attemptId: z.string(),
    revision: z.number(),
    index: z.number().int(),
    outcome: z.union([
      z.object({ kind: z.literal('committed'), eventType: z.string(), seq: z.number() }),
      z.object({ kind: z.literal('abandoned') }),
    ]),
  }),
]);

export const followFrameSchema = z.union([
  z.object({
    type: z.literal('snapshot'),
    header: z.object({ id: z.string(), version: z.number(), createdAt: z.number(), cwd: z.string().optional() }),
    cursor: z.number(),
    records: z.array(recordSchema),
    hasMore: z.boolean(),
    projections: z.unknown(),
    assistantStream: z
      .object({ revision: z.number(), activeAttempt: attemptBaseline.optional() })
      .optional(),
  }),
  recordSchema,
  z.object({ type: z.literal('assistant-stream'), frame: streamFrame }),
]);

export type FollowFrame = z.infer<typeof followFrameSchema>;

export interface LiveBlock {
  readonly kind: 'text' | 'reasoning' | 'tool';
  readonly text: string;
  readonly toolName?: string;
}

export interface LiveAttempt {
  readonly attemptId: string;
  readonly turn: number;
  readonly step: number;
  readonly nextIndex: number;
  /** 按块序号排列的临时内容。 */
  readonly blocks: ReadonlyMap<number, LiveBlock>;
}

export interface FollowState {
  readonly sessionId?: string;
  /** 已收到的最后一个持久事件序号。 */
  readonly cursor: number;
  readonly hasOlder: boolean;
  readonly events: readonly WireEvent[];
  readonly live?: LiveAttempt;
  /** 发现序号或流下标不连续时的说明；调用方应重新打开 follow。 */
  readonly gap?: string;
}

export const initialFollowState: FollowState = { cursor: 0, hasOlder: false, events: [] };

/**
 * 合并一帧。
 * @param state - 当前状态（不会被修改）。
 * @param frame - 已通过 `followFrameSchema` 校验的帧。
 * @returns 新状态。
 */
export function applyFollowFrame(state: FollowState, frame: FollowFrame): FollowState {
  if (frame.type === 'snapshot') {
    const events = frame.records.map((record) => record.event);
    const baseline = frame.assistantStream?.activeAttempt;
    return {
      sessionId: frame.header.id,
      cursor: frame.cursor,
      hasOlder: frame.hasMore,
      events,
      live: baseline ? liveFromBaseline(baseline) : undefined,
    };
  }
  if (frame.type === 'event') return applyEvent(state, frame.event);
  return applyStream(state, frame.frame);
}

function applyEvent(state: FollowState, event: WireEvent): FollowState {
  if (event.seq <= state.cursor) return state; // 重复帧
  const gap = event.seq !== state.cursor + 1 ? `事件序号从 ${state.cursor} 跳到 ${event.seq}` : state.gap;
  let live = state.live;
  if (live && (event.type === 'assistant/message' || event.type === 'assistant/attempt')) {
    const data = event.data as { turn?: unknown; step?: unknown } | null;
    if (data?.turn === live.turn && data?.step === live.step) live = undefined;
  }
  return { ...state, cursor: event.seq, events: [...state.events, event], live, gap };
}

function applyStream(state: FollowState, frame: z.infer<typeof streamFrame>): FollowState {
  switch (frame.type) {
    case 'start':
      return {
        ...state,
        live: { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, nextIndex: 0, blocks: new Map() },
      };
    case 'chunk': {
      const live = state.live;
      if (!live || live.attemptId !== frame.attemptId) return state; // 错过了 start，等持久事件
      if (frame.index !== live.nextIndex) {
        return { ...state, gap: `逐字流下标从 ${live.nextIndex} 跳到 ${frame.index}` };
      }
      return { ...state, live: { ...live, nextIndex: live.nextIndex + 1, blocks: applyChunk(live.blocks, frame.chunk) } };
    }
    case 'end':
      return state.live?.attemptId === frame.attemptId ? { ...state, live: undefined } : state;
  }
}

/** 原始流片段：dsh packages/llm/llm/src/types.ts 的 StreamChunk。 */
function applyChunk(blocks: ReadonlyMap<number, LiveBlock>, chunk: unknown): ReadonlyMap<number, LiveBlock> {
  const c = chunk as { type?: unknown; index?: unknown; text?: unknown; name?: unknown; argumentsDelta?: unknown };
  if (typeof c?.index !== 'number') return blocks;
  const existing = blocks.get(c.index);
  const next = new Map(blocks);
  if (c.type === 'text-delta' && typeof c.text === 'string') {
    next.set(c.index, { kind: 'text', text: (existing?.text ?? '') + c.text });
  } else if (c.type === 'reasoning-delta' && typeof c.text === 'string') {
    next.set(c.index, { kind: 'reasoning', text: (existing?.text ?? '') + c.text });
  } else if (c.type === 'tool-call-delta' && typeof c.argumentsDelta === 'string') {
    const toolName = typeof c.name === 'string' ? c.name : existing?.toolName;
    next.set(c.index, { kind: 'tool', text: (existing?.text ?? '') + c.argumentsDelta, ...(toolName ? { toolName } : {}) });
  } else {
    return blocks;
  }
  return next;
}

/** 开场基线里的紧凑流：dsh packages/llm/llm/src/assistant-stream.ts 的 AssistantStreamRecord。 */
function liveFromBaseline(baseline: z.infer<typeof attemptBaseline>): LiveAttempt {
  let blocks: ReadonlyMap<number, LiveBlock> = new Map();
  for (const record of baseline.stream) {
    const r = record as { type?: unknown; index?: unknown; texts?: unknown; args?: unknown; name?: unknown; chunk?: unknown };
    if (r.type === 'chunk') {
      blocks = applyChunk(blocks, r.chunk);
      continue;
    }
    if (typeof r.index !== 'number') continue;
    const next = new Map(blocks);
    const existing = blocks.get(r.index);
    if ((r.type === 'text-chunks' || r.type === 'reasoning-chunks') && Array.isArray(r.texts)) {
      const kind = r.type === 'text-chunks' ? 'text' : 'reasoning';
      next.set(r.index, { kind, text: (existing?.text ?? '') + r.texts.join('') });
    } else if (r.type === 'tool-call-chunks' && Array.isArray(r.args)) {
      next.set(r.index, {
        kind: 'tool',
        text: (existing?.text ?? '') + r.args.join(''),
        ...(typeof r.name === 'string' ? { toolName: r.name } : {}),
      });
    } else {
      continue;
    }
    blocks = next;
  }
  return { attemptId: baseline.attemptId, turn: baseline.turn, step: baseline.step, nextIndex: baseline.nextIndex, blocks };
}

/** 当前临时回复的正文文本（只取 text 块），没有时返回空字符串。 */
export function liveText(state: FollowState): string {
  if (!state.live) return '';
  return [...state.live.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.kind === 'text')
    .map(([, block]) => block.text)
    .join('');
}
