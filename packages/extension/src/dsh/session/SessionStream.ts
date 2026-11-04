/**
 * 单个会话的 follow 生命周期：打开 `session/follow`，把帧喂给 SessionJournal；
 * journal 要求 rebaseline 时重新打开 follow；连接断开时停下，由上层在新连接上重建。
 */
import type { DshClient } from '../DshClient.ts';
import { RemoteError, TransportError } from '../remote/errors.ts';
import { SessionJournal } from './journal.ts';

export type SessionStreamStatus =
  | { readonly kind: 'opening' }
  | { readonly kind: 'live' }
  /** 连接断开，等待上层重建连接。 */
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

export interface SessionStreamOptions {
  readonly client: DshClient;
  readonly sessionId: string;
  /** 可见内容或状态变化时调用；调用方负责节流。 */
  readonly onChange: () => void;
  /** 每次收到开场快照时，带上其中的投影基线。 */
  readonly onSnapshotProjections?: (baseline: unknown) => void;
  readonly log?: (line: string) => void;
}

export class SessionStream {
  readonly journal = new SessionJournal();
  private currentStatus: SessionStreamStatus = { kind: 'opening' };
  private readonly abort = new AbortController();
  private followAbort: AbortController | undefined;
  private loadingOlderPromise: Promise<void> | undefined;
  private recentRebaselines: number[] = [];

  constructor(private readonly options: SessionStreamOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  get status(): SessionStreamStatus {
    return this.currentStatus;
  }

  get loadingOlder(): boolean {
    return this.loadingOlderPromise !== undefined;
  }

  start(): void {
    void this.run();
  }

  dispose(): void {
    this.abort.abort();
    this.followAbort?.abort();
  }

  /** 加载更早的一页历史；正在加载时复用同一个请求。 */
  loadOlder(): Promise<void> {
    if (this.loadingOlderPromise) return this.loadingOlderPromise;
    const oldest = this.journal.oldestSeq;
    if (!this.journal.hasOlder || oldest === undefined) return Promise.resolve();
    this.loadingOlderPromise = (async () => {
      try {
        const page = await this.options.client.readHistory(this.sessionId, oldest, this.journal.lastSeq, this.abort.signal);
        this.journal.prependOlder(page.records, page.hasMore);
      } catch (error) {
        this.log(`加载历史失败：${message(error)}`);
      } finally {
        this.loadingOlderPromise = undefined;
        this.options.onChange();
      }
    })();
    this.options.onChange();
    return this.loadingOlderPromise;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const follow = new AbortController();
      this.followAbort = follow;
      const signal = AbortSignal.any([this.abort.signal, follow.signal]);
      let rebaseline = false;
      try {
        for await (const frame of this.options.client.follow(this.sessionId, signal, (line) => this.log(line))) {
          if (this.journal.accept(frame) === 'rebaseline') {
            rebaseline = true;
            this.log(`会话 ${this.sessionId} 的 follow 状态不一致，重新打开`);
            follow.abort();
            break;
          }
          if (frame.type === 'snapshot') {
            this.options.onSnapshotProjections?.(frame.projections);
            this.setStatus({ kind: 'live' });
          } else {
            this.options.onChange();
          }
        }
        if (!rebaseline && !this.abort.signal.aborted) {
          // Host 正常结束了 follow（例如会话被归档），按断开处理
          this.setStatus({ kind: 'disconnected' });
          return;
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        if (!rebaseline) {
          this.log(`会话 ${this.sessionId} 的 follow 中断：${message(error)}`);
          if (error instanceof RemoteError) this.setStatus({ kind: 'failed', code: error.code, message: error.message });
          else if (error instanceof TransportError) this.setStatus({ kind: 'disconnected' });
          else this.setStatus({ kind: 'failed', code: 'client', message: message(error) });
          return;
        }
      }
      await this.backoff();
    }
  }

  /** 短时间内反复 rebaseline 时逐步拉长间隔，避免和 Host 来回打架。 */
  private async backoff(): Promise<void> {
    const now = Date.now();
    this.recentRebaselines = [...this.recentRebaselines.filter((t) => now - t < 10_000), now];
    const wait = this.recentRebaselines.length <= 2 ? 0 : Math.min(5_000, 250 * 2 ** (this.recentRebaselines.length - 3));
    this.setStatus({ kind: 'opening' });
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private setStatus(status: SessionStreamStatus): void {
    this.currentStatus = status;
    this.options.onChange();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
