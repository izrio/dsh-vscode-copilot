/**
 * `/api/remote.mux` WebSocket：在一条连接上多路复用多个 Remote 流。
 *
 * 客户端帧：`open { streamId, endpoint, payload: { args } }`、`item`、`end`、`cancel`。
 * 服务端帧：`item { streamId, value? }`、`error { streamId, error: { code, message, details } }`、`end`。
 * 来源：dsh packages/api/gateway/src/stream-protocol.ts。
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { AsyncQueue } from './asyncQueue.ts';
import type { ApiCredential } from './connect.ts';
import { RemoteError, TransportError } from './errors.ts';

const serverFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item'), streamId: z.string(), value: z.unknown().optional() }),
  z.object({ type: z.literal('end'), streamId: z.string() }),
  z.object({
    type: z.literal('error'),
    streamId: z.string(),
    error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()) }),
  }),
]);

interface OpenStream {
  readonly endpoint: string;
  readonly queue: AsyncQueue<unknown>;
}

export class MuxClient {
  private socket: WebSocket | undefined;
  private readonly streams = new Map<string, OpenStream>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closedError: Error | undefined;

  constructor(
    private readonly credential: ApiCredential,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** 建立 WebSocket。Peer 生命周期跟这条连接绑定：连接关闭后 Cookie 失效，需要重新 /connect。 */
  connect(timeoutMs = 15_000): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.credential.muxUrl, {
        headers: { cookie: this.credential.cookie },
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
      });
      this.socket = socket;
      let opened = false;
      socket.once('open', () => {
        opened = true;
        resolve();
      });
      socket.once('unexpected-response', (_request, response) => {
        reject(new TransportError(`mux 握手失败：HTTP ${response.statusCode}`));
        socket.terminate();
      });
      socket.on('error', (error) => {
        if (!opened) reject(new TransportError('mux 连接失败', { cause: error }));
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.log('mux：忽略二进制帧');
          return;
        }
        this.onFrame(data.toString());
      });
      socket.once('close', (code, reason) => {
        const error = new TransportError(`mux 连接已关闭（${code}${reason.length ? ` ${reason.toString()}` : ''}）`);
        this.closedError = error;
        for (const { queue } of this.streams.values()) queue.fail(error);
        this.streams.clear();
        for (const listener of this.closeListeners) listener(error);
        if (!opened) reject(error);
      });
    });
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * 打开一个 Remote 流。迭代结束前停止消费（break / signal）会向 Host 发送 `cancel`。
   * @param endpoint - 例如 `session/follow`、`$events`。
   * @param args - 以参数名为键的对象。
   */
  async *open(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): AsyncGenerator<unknown> {
    if (this.closedError) throw this.closedError;
    if (!this.isOpen) throw new TransportError('mux 尚未连接');
    const streamId = randomUUID();
    const queue = new AsyncQueue<unknown>();
    this.streams.set(streamId, { endpoint, queue });
    this.send({ type: 'open', streamId, endpoint, payload: { args } });

    const onAbort = (): void => queue.fail(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let serverSettled = false;
    try {
      for await (const item of queue) yield item;
      serverSettled = true;
    } catch (error) {
      serverSettled = error instanceof RemoteError || error instanceof TransportError;
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.streams.delete(streamId);
      if (!serverSettled && this.isOpen) this.send({ type: 'cancel', streamId });
    }
  }

  close(): void {
    this.socket?.close(1000);
  }

  private send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private onFrame(text: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      this.log('mux：收到无法解析的帧');
      return;
    }
    const parsed = serverFrame.safeParse(decoded);
    if (!parsed.success) {
      this.log('mux：收到格式不对的帧');
      return;
    }
    const frame = parsed.data;
    const stream = this.streams.get(frame.streamId);
    if (!stream) return; // 已取消的流可能还会收到迟到的帧
    if (frame.type === 'item') stream.queue.push(frame.value);
    else if (frame.type === 'end') stream.queue.end();
    else stream.queue.fail(new RemoteError(stream.endpoint, frame.error.code, frame.error.message, frame.error.details));
  }
}
