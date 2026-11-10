/**
 * 每轮改动汇总（`/api/changes.summary`）的读取结果。汇总只保存在 Host 内存里：
 * - Host 重启（origin 变了）后全部作废，改为按文件工具汇总；
 * - 404（ChangesUnavailableError）记为不可用，不再读取；
 * - 其他错误（网络抖动、超时）按退避重试几次，仍失败才记为不可用。
 */
import { ChangesUnavailableError, type ChangesSummary, type DshClient } from '../dsh/DshClient.ts';
import { describeError } from '../util/errors.ts';
import type { ChangesLookup } from './projector.ts';

type Entry = ChangesSummary | 'unavailable' | 'loading';

export interface ChangesCacheOptions {
  readonly onChange: () => void;
  readonly log: (line: string) => void;
  /** 第 n 次失败后多久重试。 */
  readonly retryDelayMs?: (attempt: number) => number;
  /** 最多读取几次（含第一次）。 */
  readonly maxAttempts?: number;
}

export class ChangesCache {
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, { readonly attempts: number; readonly retryAt: number }>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private origin: string | undefined;
  private changeVersion = 0;

  constructor(private readonly options: ChangesCacheOptions) {}

  /** 每读到（或放弃）一份汇总递增，用作投影缓存键的一部分。 */
  get version(): number {
    return this.changeVersion;
  }

  lookup(sessionId: string | undefined): ChangesLookup {
    return (seq) => {
      const value = sessionId ? this.entries.get(key(sessionId, seq)) : undefined;
      return value === 'loading' ? undefined : value;
    };
  }

  /** 换了连接：正在读取的请求作废；连到了另一个 Host（重启过）时清空。 */
  connectionChanged(origin: string | undefined): void {
    for (const [k, value] of this.entries) if (value === 'loading') this.entries.delete(k);
    if (origin !== undefined && origin !== this.origin) {
      this.entries.clear();
      this.failures.clear();
      this.origin = origin;
      this.changeVersion++;
    }
  }

  markUnavailable(sessionId: string, seq: number): void {
    this.entries.set(key(sessionId, seq), 'unavailable');
    this.changeVersion++;
    this.options.onChange();
  }

  /** 读取还没读过的汇总。 */
  load(client: DshClient, sessionId: string, seqs: readonly number[]): void {
    const now = Date.now();
    for (const seq of seqs) {
      const k = key(sessionId, seq);
      if (this.entries.has(k)) continue;
      const failure = this.failures.get(k);
      if (failure && now < failure.retryAt) continue;
      this.entries.set(k, 'loading');
      void Promise.resolve()
        .then(() => client.changesSummary(sessionId, seq))
        .then(
          (summary) => {
            this.failures.delete(k);
            this.entries.set(k, summary);
          },
          (error: unknown) => this.failed(k, error),
        )
        .finally(() => {
          this.changeVersion++;
          this.options.onChange();
        });
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private failed(k: string, error: unknown): void {
    const attempts = (this.failures.get(k)?.attempts ?? 0) + 1;
    if (error instanceof ChangesUnavailableError || attempts >= (this.options.maxAttempts ?? 3)) {
      if (!(error instanceof ChangesUnavailableError)) this.options.log(`读取改动汇总失败，不再重试：${describeError(error)}`);
      this.failures.delete(k);
      this.entries.set(k, 'unavailable');
      return;
    }
    const delay = (this.options.retryDelayMs ?? ((n) => 1_000 * 2 ** (n - 1)))(attempts);
    this.options.log(`读取改动汇总失败（第 ${attempts} 次），${delay}ms 后重试：${describeError(error)}`);
    this.entries.delete(k);
    this.failures.set(k, { attempts, retryAt: Date.now() + delay });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.options.onChange();
    }, delay);
    this.timers.add(timer);
  }
}

function key(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`;
}
