/**
 * `session/follow` 流的帧格式校验，以及逐字流片段的合并函数。
 *
 * 帧类型（dsh packages/api/session-controller/src/types.ts 的 SessionFollowFrame）：
 * - `snapshot`：开场快照，含 header、cursor、历史 records、投影，以及进行中的 assistant 流基线；
 * - `event`：一条持久会话事件 `{ type, seq, time, data }`；
 * - `assistant-stream`：逐字流帧 `start` / `chunk` / `end`。
 * 状态合并见 ../session/journal.ts。
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
    outcome: z.union([z.object({ kind: z.literal('committed'), eventType: z.string(), seq: z.number() }), z.object({ kind: z.literal('abandoned') })]),
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
    assistantStream: z.object({ revision: z.number(), activeAttempt: attemptBaseline.optional() }).optional(),
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

/**
 * 应用一个原始流片段：dsh packages/llm/llm/src/types.ts 的 StreamChunk。
 * 不认识的片段（block-start、usage、finish 等）不改变内容。
 * @returns 新的块表；没有变化时返回原对象。
 */
export function applyStreamChunk(blocks: ReadonlyMap<number, LiveBlock>, chunk: unknown): ReadonlyMap<number, LiveBlock> {
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

/**
 * 还原开场基线里的紧凑流：dsh packages/llm/llm/src/assistant-stream.ts 的 AssistantStreamRecord。
 * 紧凑记录（text-chunks 等）的每个文本片段对应一个流下标，只取前 `limit` 个。
 */
export function foldCompactStream(stream: readonly unknown[], limit = Number.POSITIVE_INFINITY): ReadonlyMap<number, LiveBlock> {
  let blocks: ReadonlyMap<number, LiveBlock> = new Map();
  let consumed = 0;
  for (const record of stream) {
    if (consumed >= limit) break;
    const r = record as { type?: unknown; index?: unknown; texts?: unknown; args?: unknown; name?: unknown; id?: unknown; chunk?: unknown };
    if (r.type === 'chunk') {
      blocks = applyStreamChunk(blocks, r.chunk);
      consumed++;
      continue;
    }
    if (typeof r.index !== 'number') continue;
    const pieces = r.type === 'tool-call-chunks' ? r.args : r.texts;
    if (!Array.isArray(pieces)) continue;
    for (const piece of pieces) {
      if (consumed >= limit) break;
      if (typeof piece !== 'string') continue;
      if (r.type === 'text-chunks') blocks = applyStreamChunk(blocks, { type: 'text-delta', index: r.index, text: piece });
      else if (r.type === 'reasoning-chunks') blocks = applyStreamChunk(blocks, { type: 'reasoning-delta', index: r.index, text: piece });
      else if (r.type === 'tool-call-chunks') {
        blocks = applyStreamChunk(blocks, { type: 'tool-call-delta', index: r.index, id: r.id, name: r.name, argumentsDelta: piece });
      }
      consumed++;
    }
  }
  return blocks;
}

/** 临时内容中按序拼接的正文文本（只取 text 块）。 */
export function liveBlocksText(blocks: ReadonlyMap<number, LiveBlock>, kind: LiveBlock['kind'] = 'text'): string {
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.kind === kind)
    .map(([, block]) => block.text)
    .join('');
}
