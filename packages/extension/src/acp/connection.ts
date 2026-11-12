/**
 * ACP（Agent Client Protocol）连接：启动代理进程，用标准输入输出交换按行分隔的 JSON-RPC 2.0 消息。
 *
 * - 我们发给代理：请求（initialize、session/new、session/prompt…）和通知（session/cancel）；
 * - 代理发给我们：通知（session/update）和请求（session/request_permission、fs/*…），由调用方处理并回复。
 *
 * 协议见 https://agentclientprotocol.com 。这里只做传输，不理解具体方法。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnSpec, stopRuntime, trackChild } from '../runtime/launch.ts';

/** JSON-RPC 错误：代理返回的 error 对象。 */
export class AcpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = 'AcpError';
  }
}

/** 进程已经退出或连接已关闭。 */
export class AcpClosedError extends Error {
  constructor(message = '代理进程已退出') {
    super(message);
    this.name = 'AcpClosedError';
  }
}

export interface AcpConnectionOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 代理发来的请求；返回值作为 result，抛错时回复 JSON-RPC 错误。 */
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly onNotification: (method: string, params: unknown) => void;
  /** 进程退出（非 dispose 引起）。`stderr` 是最后几行错误输出。 */
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  readonly log?: (line: string) => void;
  /** 代理的 stderr 输出（写到运行时日志）。 */
  readonly onStderr?: (line: string) => void;
  /** 排查用：收发的每一条消息（原文）。返回 false 或没有提供时不记录。 */
  readonly trace?: (direction: 'in' | 'out', line: string) => void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

/** 代理在限定时间内没有回复。 */
export class AcpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method}: no response within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'AcpTimeoutError';
  }
}

const STDERR_TAIL = 20;

export class AcpConnection {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private readonly options: AcpConnectionOptions) {}

  /** 启动进程；命令不存在等启动错误时拒绝。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const spec = spawnSpec(this.options.command, this.options.args, process.platform, this.options.env);
      const child = spawn(spec.file, spec.args, {
        cwd: this.options.cwd,
        env: { ...this.options.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 下放进独立进程组，结束时连同代理的子进程一起结束
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      this.child = child;
      trackChild(child);
      // 代理关掉了输入（或已经退出）之后再写会触发 EPIPE：没有监听的话是未捕获异常，等待中的请求也永远不结束
      child.stdin?.on('error', (error) => {
        this.options.log?.(`ACP：写入代理失败：${error.message}`);
        this.closeAll(new AcpClosedError(`无法写入代理进程：${error.message}`));
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        reject(error);
        this.closeAll(new AcpClosedError(error.message));
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onData(chunk));
      child.stderr?.setEncoding('utf8');
      let stderrBuffer = '';
      child.stderr?.on('data', (chunk: string) => {
        stderrBuffer += chunk;
        let index: number;
        while ((index = stderrBuffer.indexOf('\n')) >= 0) {
          const line = stderrBuffer.slice(0, index).replace(/\r$/u, '');
          stderrBuffer = stderrBuffer.slice(index + 1);
          if (!line.trim()) continue;
          this.stderrTail = [...this.stderrTail, line].slice(-STDERR_TAIL);
          this.options.onStderr?.(line);
        }
      });
      child.once('exit', (code, signal) => {
        this.closeAll(new AcpClosedError(`代理进程已退出（${signal ?? code}）`));
        if (!this.disposed) this.options.onExit(code, signal, this.stderrTail.join('\n'));
      });
    });
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.disposed;
  }

  /**
   * 发请求，等代理回复。
   * @param timeoutMs - 超过这个时间没有回复就拒绝（握手用：命令不是 ACP 代理时永远不会回复）。不传时一直等，一轮对话可能很久。
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.running) return Promise.reject(new AcpClosedError());
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (this.pending.delete(id)) reject(new AcpTimeoutError(method, timeoutMs));
            }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, ...(timer ? { timer } : {}) });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.running) this.write({ jsonrpc: '2.0', method, params });
  }

  /** 结束进程（连同子进程）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closeAll(new AcpClosedError('连接已关闭'));
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    await stopRuntime(child, 2_000);
  }

  private write(message: unknown): void {
    const line = JSON.stringify(message);
    this.options.trace?.('out', line);
    this.child?.stdin?.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.options.trace?.('in', line);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        this.options.log?.(`ACP：跳过无法解析的输出：${line.slice(0, 200)}`);
        continue;
      }
      if (message.method === undefined) {
        this.settle(message);
      } else if (message.id !== undefined) {
        void this.answer(message.id, message.method, message.params);
      } else {
        try {
          this.options.onNotification(message.method, message.params);
        } catch (error) {
          this.options.log?.(`ACP：处理 ${message.method} 失败：${describe(error)}`);
        }
      }
    }
  }

  private settle(message: { id?: number | string; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(new AcpError(pending.method, message.error.code ?? -32603, message.error.message ?? 'error', message.error.data));
    else pending.resolve(message.result ?? null);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpError ? error.code : -32603;
      this.write({ jsonrpc: '2.0', id, error: { code, message: describe(error) } });
    }
  }

  private closeAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
