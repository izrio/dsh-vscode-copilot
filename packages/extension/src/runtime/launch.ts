/**
 * 启动和停止 dsh Host 子进程。
 *
 * 启动命令：`dsh --profile <profile> [启动器参数] --no-open --host 127.0.0.1 --port 0`。
 * Host 就绪后在 stdout 打印带启动令牌的 URL（`http://127.0.0.1:<port>/?token=…`），
 * dsh 文档说明这一行就是就绪信号（packages/bundle/web-app/README）。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '../util/redact.ts';
import { t } from '../i18n.ts';

export interface LaunchOptions {
  readonly command: string;
  readonly profile: string;
  /** 启动器级参数（例如测试时的 `--patch`），必须放在 `--no-open` 等应用参数之前。 */
  readonly launcherArgs?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readyTimeoutMs?: number;
  /** 每一行 dsh 输出（已脱敏），用于写日志。 */
  readonly onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface LaunchedRuntime {
  readonly child: ChildProcess;
  /** 形如 `http://127.0.0.1:43210`，不含路径和令牌。 */
  readonly origin: string;
  /** 启动令牌；只能保存在内存里。 */
  readonly token: string;
}

export class LaunchError extends Error {
  constructor(
    message: string,
    /** dsh 最后的输出（已脱敏），用于界面提示。 */
    readonly outputTail: string,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

const LAUNCH_URL =
  /https?:\/\/(?:\[[0-9a-f:.]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\/?\?token=[A-Za-z0-9_-]+/iu;

/**
 * 从一行输出中找到带令牌的启动 URL。
 * @returns origin 和令牌；这一行不是启动 URL 时返回 undefined。
 */
export function parseLaunchUrl(line: string): { origin: string; token: string } | undefined {
  // dsh 可能输出 ANSI 颜色控制符
  const plain = line.replace(/\u001b\[[0-9;]*m/gu, '');
  const match = LAUNCH_URL.exec(plain);
  if (!match) return undefined;
  const url = new URL(match[0]);
  const token = url.searchParams.get('token');
  if (!token) return undefined;
  return { origin: url.origin, token };
}

/**
 * 标准启动参数：`dsh --profile <name> [启动器参数] [应用参数]`。
 * 启动器参数（如 `--patch`）必须在应用参数之前。
 */
export function buildLaunchArgs(profile: string, launcherArgs: readonly string[] = []): string[] {
  return ['--profile', profile, ...launcherArgs, '--no-open', '--host', '127.0.0.1', '--port', '0'];
}

function needsShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
}

/**
 * 执行 `dsh --version`。
 * @returns 去掉首尾空白的版本输出。
 */
export function probeVersion(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['--version'],
      { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, shell: needsShell(command, process.platform), windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new LaunchError(t('runtime.versionFailed', error.message), redactSecrets(String(stderr))));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

class LineSplitter {
  private buffer = '';
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      this.onLine(this.buffer.slice(0, index).replace(/\r$/u, ''));
      this.buffer = this.buffer.slice(index + 1);
    }
  }
  flush(): void {
    if (this.buffer) this.onLine(this.buffer);
    this.buffer = '';
  }
}

/**
 * 启动 dsh 并等待就绪。
 * @throws LaunchError 进程提前退出、超时或无法启动时。
 */
export function launchRuntime(options: LaunchOptions): Promise<LaunchedRuntime> {
  const args = buildLaunchArgs(options.profile, options.launcherArgs);
  const timeoutMs = options.readyTimeoutMs ?? 60_000;
  const tail: string[] = [];
  const remember = (line: string): string => {
    const safe = redactSecrets(line);
    tail.push(safe);
    if (tail.length > 40) tail.shift();
    return safe;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...options.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下放进独立进程组，退出时能连同 dsh 的子进程一起结束
      detached: process.platform !== 'win32',
      shell: needsShell(options.command, process.platform),
      windowsHide: true,
    });

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopRuntime(child);
      reject(new LaunchError(message, tail.join('\n')));
    };

    const timer = setTimeout(() => fail(t('runtime.timeout', Math.round(timeoutMs / 1000))), timeoutMs);

    const stdout = new LineSplitter((line) => {
      const safe = remember(line);
      options.onOutput?.(safe, 'stdout');
      if (settled) return;
      const found = parseLaunchUrl(line);
      if (found) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, origin: found.origin, token: found.token });
      }
    });
    const stderr = new LineSplitter((line) => options.onOutput?.(remember(line), 'stderr'));

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => fail(t('runtime.spawnFailed', error.message)));
    child.once('exit', (code, signal) => {
      stdout.flush();
      stderr.flush();
      fail(t('runtime.exitedEarly', signal ?? t('runtime.exitCode', String(code))));
    });
  });
}

/**
 * 停止 dsh：先 SIGTERM，超时后强制结束。只用于插件自己启动的进程。
 * @param graceMs - 等待优雅退出的时间。
 */
export async function stopRuntime(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  if (process.platform === 'win32') {
    // Windows 没有进程组信号，用 taskkill 结束整个进程树
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
    await Promise.race([exited, delay(graceMs)]);
    return;
  }

  signalGroup(pid, 'SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)]);
  if (!graceful) {
    signalGroup(pid, 'SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程已经退出
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
