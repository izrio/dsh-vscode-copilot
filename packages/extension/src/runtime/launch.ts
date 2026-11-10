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

const LAUNCH_URL = /https?:\/\/(?:\[[0-9a-f:.]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\/?\?token=[A-Za-z0-9_-]+/iu;

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
 * Windows 下 `.cmd` / `.bat` 只能经 cmd.exe 运行。Node 用 `cmd.exe /d /s /c "<命令行>"` 执行，
 * 把命令和参数直接用空格拼起来、不加引号：路径里有空格（`C:\Program Files\…`）时会被拆开。
 * 这里给每一段加上引号（内部的引号写成两个）。
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  return /[\s"&|<>^()%!,;=]/u.test(arg) ? `"${arg.replace(/"/gu, '""')}"` : arg;
}

/** 按平台准备 spawn / execFile 的命令和参数。 */
export function commandLine(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (!needsShell(command, platform)) return { file: command, args: [...args], shell: false };
  return { file: quoteForCmd(command), args: args.map(quoteForCmd), shell: true };
}

/** profile 名只允许字母、数字、点、下划线和连字符：它会出现在命令行里。 */
export function isValidProfile(profile: string): boolean {
  return /^[\w.-]{1,64}$/u.test(profile);
}

/**
 * 执行 `dsh --version`。
 * @returns 去掉首尾空白的版本输出。
 */
export function probeVersion(command: string, env: Readonly<Record<string, string | undefined>>, timeoutMs = 15_000): Promise<string> {
  const line = commandLine(command, ['--version']);
  return new Promise((resolve, reject) => {
    execFile(line.file, line.args, { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, shell: line.shell, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new LaunchError(t('runtime.versionFailed', error.message), redactSecrets(String(stderr))));
        return;
      }
      resolve(String(stdout).trim());
    });
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
  if (!isValidProfile(options.profile)) return Promise.reject(new LaunchError(t('runtime.badProfile', options.profile), ''));
  const line = commandLine(options.command, buildLaunchArgs(options.profile, options.launcherArgs));
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
    const child = spawn(line.file, line.args, {
      cwd: options.cwd,
      env: { ...options.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下放进独立进程组，退出时能连同 dsh 的子进程一起结束
      detached: process.platform !== 'win32',
      shell: line.shell,
      windowsHide: true,
    });
    killOnHostExit(child);

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

/**
 * 独立进程组不会随 Extension Host 一起退出。Host 没走 deactivate 就退出时（例如重新加载窗口时超时被结束），
 * 在 process 的 exit 事件里同步结束 dsh 的进程组。Host 被强制杀掉（SIGKILL）时无法处理。
 */
function killOnHostExit(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const onExit = (): void => {
    if (process.platform === 'win32') {
      try {
        process.kill(pid);
      } catch {
        // 已经退出
      }
    } else signalGroup(pid, 'SIGKILL');
  };
  process.once('exit', onExit);
  child.once('exit', () => process.removeListener('exit', onExit));
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
