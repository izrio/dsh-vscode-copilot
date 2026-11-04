/**
 * Host 转发的 Remote 事件（`$events` 流）。
 *
 * 首帧是 `ready { clientId, host }`，之后是：
 * - `emit { event, args }`：通知，例如 `api-session/status`；
 * - `waterfall { event, eventId, agentId, request }`：需要回答的请求，例如 `approval/request`、
 *   `user-questions/request`；回答走一元调用 `$events/result`，args 为 `{ clientId, eventId, outcome }`；
 * - `cancel { eventId }`：Host 不再等待某个 waterfall。
 * **每个 waterfall 都必须回答**，不处理的回 `{ kind: 'next' }`，否则 Host 会一直等待。
 * 来源：dsh packages/api/gateway/src/{stream-protocol.ts,client/remote-events.ts}。
 */
import { z } from 'zod';
import type { MuxClient } from './mux.ts';
import { TransportError } from './errors.ts';
import type { UnaryClient } from './unary.ts';

const readyFrame = z.object({
  type: z.literal('ready'),
  clientId: z.string().min(1),
  host: z.object({ home: z.string() }),
});

const downlinkFrame = z.discriminatedUnion('type', [
  readyFrame,
  z.object({ type: z.literal('emit'), event: z.string(), args: z.array(z.unknown()) }),
  z.object({
    type: z.literal('waterfall'),
    event: z.string(),
    eventId: z.string().min(1),
    agentId: z.string().min(1),
    request: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('cancel'), eventId: z.string().min(1) }),
]);

export interface WaterfallRequest {
  readonly event: string;
  readonly eventId: string;
  /** 发起请求的 Agent，对应 dsh 的 sessionId。 */
  readonly agentId: string;
  readonly request: Readonly<Record<string, unknown>>;
}

export type WaterfallOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: unknown }
  | { readonly kind: 'rejected'; readonly error: { readonly name: string; readonly message: string; readonly code?: string } };

export type WaterfallHandler = (request: WaterfallRequest, signal: AbortSignal) => Promise<WaterfallOutcome>;

export interface ReadyInfo {
  readonly clientId: string;
  readonly home: string;
}

export class RemoteEvents {
  private clientId: string | undefined;
  private readonly emitListeners = new Map<string, Set<(args: readonly unknown[]) => void>>();
  private readonly waterfallHandlers = new Map<string, WaterfallHandler>();
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly mux: MuxClient,
    private readonly unary: UnaryClient,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  onEmit(event: string, listener: (args: readonly unknown[]) => void): () => void {
    let set = this.emitListeners.get(event);
    if (!set) this.emitListeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** 每个事件名只有一个处理方。 */
  onWaterfall(event: string, handler: WaterfallHandler): () => void {
    this.waterfallHandlers.set(event, handler);
    return () => {
      if (this.waterfallHandlers.get(event) === handler) this.waterfallHandlers.delete(event);
    };
  }

  /**
   * 打开 `$events` 流并等到 ready。之后在后台持续读取，直到流结束或 signal 中止。
   * @returns ready 帧里的信息。
   */
  start(signal?: AbortSignal): Promise<ReadyInfo> {
    const iterator = this.mux.open('$events', {}, signal)[Symbol.asyncIterator]();
    return (async () => {
      const first = await iterator.next();
      const ready = readyFrame.safeParse(first.value);
      if (first.done || !ready.success) throw new TransportError('$events 首帧不是 ready');
      this.clientId = ready.data.clientId;
      void this.pump(iterator);
      return { clientId: ready.data.clientId, home: ready.data.host.home };
    })();
  }

  private async pump(iterator: AsyncIterator<unknown>): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        this.dispatch(next.value);
      }
    } catch (error) {
      this.log(`$events 流结束：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const controller of this.pending.values()) controller.abort();
      this.pending.clear();
    }
  }

  private dispatch(value: unknown): void {
    const parsed = downlinkFrame.safeParse(value);
    if (!parsed.success) {
      this.log('$events：忽略无法识别的帧');
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case 'ready':
        return;
      case 'emit':
        for (const listener of this.emitListeners.get(frame.event) ?? []) listener(frame.args);
        return;
      case 'cancel':
        this.pending.get(frame.eventId)?.abort();
        this.pending.delete(frame.eventId);
        return;
      case 'waterfall':
        void this.answer(frame);
        return;
    }
  }

  private async answer(request: WaterfallRequest): Promise<void> {
    const handler = this.waterfallHandlers.get(request.event);
    const controller = new AbortController();
    this.pending.set(request.eventId, controller);
    let outcome: WaterfallOutcome;
    try {
      outcome = handler ? await handler(request, controller.signal) : { kind: 'next' };
    } catch (error) {
      outcome = {
        kind: 'rejected',
        error: { name: 'Error', message: error instanceof Error ? error.message : String(error) },
      };
    }
    this.pending.delete(request.eventId);
    if (controller.signal.aborted) return; // Host 已取消，迟到的答复没有意义
    try {
      await this.unary.call('$events/result', { clientId: this.clientId, eventId: request.eventId, outcome });
    } catch (error) {
      this.log(`回答 ${request.event} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
