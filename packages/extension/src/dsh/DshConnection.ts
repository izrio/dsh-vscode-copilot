/**
 * 连接管理：Host 就绪时连接；mux 断开但 Host 还在时按退避重连；Host 重启（令牌变了）时换新端点重连。
 *
 * API Peer 绑定在 mux WebSocket 上，断开后 Cookie 失效，所以每次重连都要重新 `/connect`。
 * 重连间隔与 dsh 官方客户端一致：500ms 起翻倍，上限 10s，带 50%–100% 抖动。
 */
import { DshClient } from './DshClient.ts';

export interface Endpoint {
  readonly origin: string;
  readonly token: string;
}

export type ConnectionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly attempt: number }
  | { readonly kind: 'connected' };

export interface DshConnectionOptions {
  readonly log?: (line: string) => void;
  /** 测试时替换真实连接。 */
  readonly connect?: (endpoint: Endpoint) => Promise<DshClient>;
  readonly backoffMs?: (attempt: number) => number;
}

type Listener<T> = (value: T) => void;

export class DshConnection {
  private generation = 0;
  private current: DshClient | undefined;
  private currentStatus: ConnectionStatus = { kind: 'idle' };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly clientListeners = new Set<Listener<DshClient | undefined>>();
  private readonly statusListeners = new Set<Listener<ConnectionStatus>>();

  constructor(private readonly options: DshConnectionOptions = {}) {}

  get client(): DshClient | undefined {
    return this.current;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** 每次连接建立（包括重连）和断开时触发。断开后旧 client 不能再用。 */
  onClient(listener: Listener<DshClient | undefined>): () => void {
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }

  onStatus(listener: Listener<ConnectionStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Host 就绪或停止时调用（来自 RuntimeManager.onEndpoint）。 */
  setEndpoint(endpoint: Endpoint | undefined): void {
    const generation = ++this.generation;
    this.clearRetry();
    this.drop();
    if (!endpoint) {
      this.setStatus({ kind: 'idle' });
      return;
    }
    void this.connectLoop(generation, endpoint, 0);
  }

  dispose(): void {
    this.generation++;
    this.clearRetry();
    this.drop();
    this.clientListeners.clear();
    this.statusListeners.clear();
  }

  private async connectLoop(generation: number, endpoint: Endpoint, attempt: number): Promise<void> {
    if (generation !== this.generation) return;
    this.setStatus({ kind: 'connecting', attempt });
    let client: DshClient;
    try {
      client = await (this.options.connect ?? ((ep) => DshClient.connect({ ...ep, log: this.options.log })))(endpoint);
    } catch (error) {
      if (generation !== this.generation) return;
      const wait = (this.options.backoffMs ?? defaultBackoff)(attempt + 1);
      this.log(`连接 dsh 失败（第 ${attempt + 1} 次）：${error instanceof Error ? error.message : String(error)}，${Math.round(wait)}ms 后重试`);
      this.retryTimer = setTimeout(() => void this.connectLoop(generation, endpoint, attempt + 1), wait);
      return;
    }
    if (generation !== this.generation) {
      client.close();
      return;
    }
    this.current = client;
    client.mux.onClose((error) => {
      if (this.current !== client || generation !== this.generation) return;
      this.log(`与 dsh 的连接断开：${error.message}`);
      this.drop();
      void this.connectLoop(generation, endpoint, 0);
    });
    this.setStatus({ kind: 'connected' });
    for (const listener of this.clientListeners) listener(client);
  }

  private drop(): void {
    const client = this.current;
    if (!client) return;
    this.current = undefined;
    client.close();
    for (const listener of this.clientListeners) listener(undefined);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function defaultBackoff(attempt: number): number {
  const base = Math.min(10_000, 500 * 2 ** (attempt - 1));
  return base * (0.5 + Math.random() * 0.5);
}
