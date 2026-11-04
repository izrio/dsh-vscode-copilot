/**
 * 单个会话的事件日志：合并 `session/follow` 帧和历史分页，维护"已发布的持久事件 + 正在流式输出的临时内容"。
 * 纯状态，不做 I/O；返回 `'rebaseline'` 时调用方应重新打开 follow（新快照会整体替换状态）。
 *
 * 规则参照 dsh 官方客户端（packages/api/session-controller/src/client/sessions/assistant-stream.ts，MIT）：
 * - 持久事件按 seq 连续接收；重复的丢弃，不连续时 rebaseline；
 * - 逐字流帧的 revision 在一次 follow 内逐帧加一，跳号时 rebaseline；
 * - 与当前流式尝试匹配的 `assistant/message` / `assistant/attempt` 先暂存，等 `end` 帧确认后再发布，
 *   同时撤掉临时内容，避免同一段文本出现两遍；
 * - `start` 时还有未结算的内容、下标跳号、`end` 对不上暂存的事件，都 rebaseline。
 * 与官方不同的一点：官方把成功消息的临时行保留到 `step/end`（供它的工具卡片使用），
 * 我们的界面从持久消息渲染工具调用，所以在 `end` 时直接撤掉临时内容。
 */
import type { FollowFrame, LiveBlock, WireEvent } from '../remote/follow.ts';
import { applyStreamChunk, foldCompactStream } from '../remote/follow.ts';

export interface LiveAttempt {
  readonly attemptId: string;
  readonly turn: number;
  readonly step: number;
  readonly startedAfterSeq: number;
  readonly nextIndex: number;
  /** 按块序号排列的临时内容（文本、推理、工具参数）。 */
  readonly blocks: ReadonlyMap<number, LiveBlock>;
}

export type JournalResult = 'ok' | 'rebaseline';

type SnapshotFrame = Extract<FollowFrame, { type: 'snapshot' }>;
type StreamFrame = Extract<FollowFrame, { type: 'assistant-stream' }>['frame'];

export class SessionJournal {
  private visible: WireEvent[] = [];
  private cursor = -1;
  private revision = 0;
  private active: LiveAttempt | undefined;
  private readonly pending = new Map<number, WireEvent>();
  private readonly publishedSeqs = new Set<number>();
  private older = false;
  private changeVersion = 0;

  /** 已发布的持久事件，按 seq 升序。 */
  get events(): readonly WireEvent[] {
    return this.visible;
  }

  /** 正在流式输出、尚未结算的内容。 */
  get live(): LiveAttempt | undefined {
    return this.active;
  }

  /** 是否还有更早的历史可以加载。 */
  get hasOlder(): boolean {
    return this.older;
  }

  /** 最早已加载事件的 seq；没有事件时为 undefined。 */
  get oldestSeq(): number | undefined {
    return this.visible[0]?.seq;
  }

  /** 已接收的最后一个持久事件序号。 */
  get lastSeq(): number {
    return this.cursor;
  }

  /** 每次可见内容变化时递增，调用方据此判断是否需要重新投影。 */
  get version(): number {
    return this.changeVersion;
  }

  /**
   * 处理一帧。
   * @returns `'rebaseline'` 表示状态已不可信，需要重新打开 follow。
   */
  accept(frame: FollowFrame): JournalResult {
    if (frame.type === 'snapshot') {
      this.replace(frame);
      return 'ok';
    }
    if (frame.type === 'event') return this.acceptEvent(frame.event);
    return this.acceptStream(frame.frame);
  }

  /**
   * 合并一页更早的历史（`session/page` / `session/events` 的结果）。
   * @param records - 按 seq 升序的事件，全部早于当前最早的事件。
   */
  prependOlder(records: readonly WireEvent[], hasMore: boolean): void {
    const oldest = this.oldestSeq ?? Number.POSITIVE_INFINITY;
    const older = records.filter((event) => event.seq < oldest && !this.publishedSeqs.has(event.seq));
    for (const event of older) this.publishedSeqs.add(event.seq);
    this.visible = [...older, ...this.visible];
    this.older = hasMore;
    this.changed();
  }

  private replace(frame: SnapshotFrame): void {
    this.visible = frame.records.map((record) => record.event);
    this.publishedSeqs.clear();
    for (const event of this.visible) this.publishedSeqs.add(event.seq);
    this.pending.clear();
    this.cursor = Math.max(frame.cursor, this.visible.at(-1)?.seq ?? -1);
    this.older = frame.hasMore;
    this.revision = frame.assistantStream?.revision ?? 0;
    const opening = frame.assistantStream?.activeAttempt;
    this.active = opening
      ? {
          attemptId: opening.attemptId,
          turn: opening.turn,
          step: opening.step,
          startedAfterSeq: opening.startedAfterSeq,
          nextIndex: opening.nextIndex,
          blocks: foldCompactStream(opening.stream, opening.nextIndex),
        }
      : undefined;
    this.changed();
  }

  private acceptEvent(event: WireEvent): JournalResult {
    if (event.seq <= this.cursor) return 'ok';
    if (event.seq !== this.cursor + 1) return 'rebaseline';
    this.cursor = event.seq;
    if (this.isMatchingSettlement(event)) {
      if (this.pending.has(event.seq)) return 'rebaseline';
      this.pending.set(event.seq, event);
      return 'ok';
    }
    // 安全网：本该由 end 帧释放的暂存结算，在本步或本轮结束时一并发布
    if ((event.type === 'step/end' || event.type === 'turn/end') && this.pending.size > 0) {
      this.flushPending();
    }
    this.publish(event);
    return 'ok';
  }

  private acceptStream(frame: StreamFrame): JournalResult {
    if (frame.revision !== this.revision + 1) return 'rebaseline';
    this.revision = frame.revision;
    switch (frame.type) {
      case 'start':
        if (this.active || this.pending.size > 0) return 'rebaseline';
        this.active = {
          attemptId: frame.attemptId,
          turn: frame.turn,
          step: frame.step,
          startedAfterSeq: frame.startedAfterSeq,
          nextIndex: 0,
          blocks: new Map(),
        };
        this.changed();
        return 'ok';
      case 'chunk': {
        const active = this.active;
        // 错过了 start（在 Host 开始这次尝试之后才打开 follow）：忽略临时内容，等持久结算
        if (!active || active.attemptId !== frame.attemptId) return 'ok';
        if (frame.index !== active.nextIndex) return 'rebaseline';
        this.active = { ...active, nextIndex: active.nextIndex + 1, blocks: applyStreamChunk(active.blocks, frame.chunk) };
        this.changed();
        return 'ok';
      }
      case 'end': {
        const active = this.active;
        if (!active || active.attemptId !== frame.attemptId) return 'ok';
        this.active = undefined;
        if (frame.index !== active.nextIndex) return 'rebaseline';
        if (frame.outcome.kind === 'abandoned') {
          this.changed();
          return this.pending.size === 0 ? 'ok' : 'rebaseline';
        }
        if (this.publishedSeqs.has(frame.outcome.seq)) {
          this.changed();
          return 'ok';
        }
        const settled = this.pending.get(frame.outcome.seq);
        if (!settled || settled.type !== frame.outcome.eventType) return 'rebaseline';
        this.pending.delete(frame.outcome.seq);
        this.publish(settled);
        return 'ok';
      }
    }
  }

  private isMatchingSettlement(event: WireEvent): boolean {
    const active = this.active;
    if (!active) return false;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false;
    if (event.type === 'assistant/message' && event.surfaceOp !== 'append') return false;
    const data = event.data as { turn?: unknown; step?: unknown } | null;
    return event.seq > active.startedAfterSeq && data?.turn === active.turn && data?.step === active.step;
  }

  private flushPending(): void {
    const ordered = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
    this.pending.clear();
    this.active = undefined;
    for (const event of ordered) this.publish(event);
  }

  private publish(event: WireEvent): void {
    if (this.publishedSeqs.has(event.seq)) return;
    this.publishedSeqs.add(event.seq);
    // 暂存的结算可能晚于后续事件发布，按 seq 插回正确位置
    const last = this.visible.at(-1);
    if (!last || last.seq < event.seq) {
      this.visible = [...this.visible, event];
    } else {
      const index = this.visible.findIndex((existing) => existing.seq > event.seq);
      this.visible = [...this.visible.slice(0, index), event, ...this.visible.slice(index)];
    }
    this.changed();
  }

  private changed(): void {
    this.changeVersion++;
  }
}
