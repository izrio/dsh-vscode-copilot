/**
 * dsh 运行时状态机：定位 → 版本检查 → 启动 → 监控 → 意外退出时按退避重启。
 *
 * 不依赖 vscode API，便于单元测试和冒烟脚本复用；extension.ts 负责把设置项传进来。
 * 设计见 docs/DESIGN.md 第 6 节。
 */
import type { ChildProcess } from 'node:child_process';
import type { RuntimeStatus } from '@dsh-copilot/shared';
import { launchRuntime, LaunchError, probeVersion, stopRuntime, type LaunchedRuntime } from './launch.ts';
import { locateDsh } from './locate.ts';
import { checkVersionSupport, MINIMUM_DSH_VERSION } from './version.ts';
import { t } from '../i18n.ts';

export interface RuntimeConfig {
  readonly configuredPath?: string;
  readonly profile: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 启动器级参数，例如测试时的 `--patch`。 */
  readonly launcherArgs?: readonly string[];
  readonly readyTimeoutMs?: number;
}

export interface RuntimeEndpoint {
  readonly origin: string;
  readonly token: string;
  readonly version: string;
}

export interface RuntimeManagerOptions {
  readonly getConfig: () => RuntimeConfig;
  readonly log: (line: string) => void;
  readonly runtimeLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** 连续失败多少次后停止自动重启。 */
  readonly maxRestarts?: number;
  /** 第 n 次重启前的等待时间。 */
  readonly backoffMs?: (attempt: number) => number;
  /**
   * 进程连续运行多久才算稳定、清零失败计数。
   * 不能在"就绪"时就清零：就绪后马上崩溃的 dsh 会因此被无限重启。
   */
  readonly stableAfterMs?: number;
}

type Listener<T> = (value: T) => void;

export class RuntimeManager {
  private status: RuntimeStatus = { kind: 'idle' };
  private current: { endpoint: RuntimeEndpoint; child: ChildProcess } | undefined;
  private starting: Promise<RuntimeEndpoint | undefined> | undefined;
  private stopping = false;
  private consecutiveFailures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly statusListeners = new Set<Listener<RuntimeStatus>>();
  private readonly endpointListeners = new Set<Listener<RuntimeEndpoint | undefined>>();

  constructor(private readonly options: RuntimeManagerOptions) {}

  get currentStatus(): RuntimeStatus {
    return this.status;
  }

  get endpoint(): RuntimeEndpoint | undefined {
    return this.current?.endpoint;
  }

  /** 插件启动的 dsh 进程号（用于日志和测试）。 */
  get pid(): number | undefined {
    return this.current?.child.pid;
  }

  onStatus(listener: Listener<RuntimeStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 每次 Host 就绪（包括重启后）或停止时触发；重启后令牌会变，必须重新连接。 */
  onEndpoint(listener: Listener<RuntimeEndpoint | undefined>): () => void {
    this.endpointListeners.add(listener);
    return () => this.endpointListeners.delete(listener);
  }

  /** 启动 dsh；已经在运行或正在启动时复用同一个结果。 */
  start(): Promise<RuntimeEndpoint | undefined> {
    if (this.current) return Promise.resolve(this.current.endpoint);
    if (!this.starting) {
      this.stopping = false;
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.clearStableTimer();
    await this.starting?.catch(() => undefined);
    const current = this.current;
    this.current = undefined;
    if (current) {
      this.emitEndpoint(undefined);
      await stopRuntime(current.child);
    }
    this.setStatus({ kind: 'idle' });
  }

  async restart(): Promise<RuntimeEndpoint | undefined> {
    await this.stop();
    this.consecutiveFailures = 0;
    return this.start();
  }

  private async doStart(): Promise<RuntimeEndpoint | undefined> {
    const config = this.options.getConfig();
    this.setStatus({ kind: 'locating' });
    const located = await locateDsh({ configuredPath: config.configuredPath, env: config.env, platform: process.platform });
    if (located.kind === 'notFound') {
      this.options.log(located.configuredPathInvalid ? '设置项 dsh.runtime.path 指向的文件不存在或不可执行' : 'PATH 中找不到 dsh');
      this.setStatus({ kind: 'notInstalled' });
      return undefined;
    }
    this.options.log(`使用 dsh：${located.command}（来源：${located.source === 'setting' ? '设置项' : 'PATH'}）`);

    let version: string;
    try {
      version = await probeVersion(located.command, config.env);
    } catch (error) {
      return this.failed(error);
    }
    const support = checkVersionSupport(version);
    if (support.kind !== 'supported') {
      this.options.log(`dsh 版本 ${version} 不受支持（最低 ${MINIMUM_DSH_VERSION}）`);
      this.setStatus({ kind: 'unsupportedVersion', version, minimum: MINIMUM_DSH_VERSION });
      return undefined;
    }

    this.setStatus({ kind: 'starting', version });
    let launched: LaunchedRuntime;
    try {
      launched = await launchRuntime({
        command: located.command,
        profile: config.profile,
        launcherArgs: config.launcherArgs,
        cwd: config.cwd,
        env: config.env,
        readyTimeoutMs: config.readyTimeoutMs,
        onOutput: this.options.runtimeLog,
      });
    } catch (error) {
      return this.failed(error);
    }
    if (this.stopping) {
      await stopRuntime(launched.child);
      return undefined;
    }

    const endpoint: RuntimeEndpoint = { origin: launched.origin, token: launched.token, version };
    this.current = { endpoint, child: launched.child };
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.consecutiveFailures = 0;
    }, this.options.stableAfterMs ?? 60_000);
    this.stableTimer.unref?.();
    launched.child.once('exit', (code, signal) => this.onUnexpectedExit(launched.child, code, signal));
    this.options.log(`dsh ${version} 已就绪：${launched.origin}`);
    this.setStatus({ kind: 'connected', version, newerThanTested: support.newerThanTested });
    this.emitEndpoint(endpoint);
    return endpoint;
  }

  private failed(error: unknown): undefined {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log(message);
    if (error instanceof LaunchError && error.outputTail) this.options.log(`dsh 最后的输出：\n${error.outputTail}`);
    this.setStatus({ kind: 'failed', message });
    return undefined;
  }

  private onUnexpectedExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.current?.child !== child) return;
    this.current = undefined;
    this.clearStableTimer();
    this.emitEndpoint(undefined);
    if (this.stopping) return;
    this.consecutiveFailures++;
    const max = this.options.maxRestarts ?? 3;
    this.options.log(`dsh 意外退出（${signal ?? `退出码 ${code}`}），第 ${this.consecutiveFailures} 次`);
    if (this.consecutiveFailures > max) {
      this.setStatus({ kind: 'failed', message: t('runtime.gaveUp', max) });
      return;
    }
    const wait = (this.options.backoffMs ?? ((n) => 1_000 * 2 ** (n - 1)))(this.consecutiveFailures);
    this.setStatus({ kind: 'reconnecting', attempt: this.consecutiveFailures });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, wait);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private emitEndpoint(endpoint: RuntimeEndpoint | undefined): void {
    for (const listener of this.endpointListeners) listener(endpoint);
  }
}
