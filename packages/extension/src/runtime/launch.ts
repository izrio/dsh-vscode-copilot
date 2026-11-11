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
  /** 中止启动（用户重启、切换底层、关闭窗口）：立即结束还没就绪的进程。 */
  readonly signal?: AbortSignal;
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

export function needsShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
}

/** cmd.exe 里有特殊含义的字符。 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

/** 给 cmd.exe 的一个参数加引号并转义（做法与 cross-spawn 相同）：先按 C 运行时的规则处理反斜杠和引号，再用 ^ 转义 cmd 的特殊字符。 */
export function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

export interface SpawnSpec {
  readonly file: string;
  readonly args: string[];
  /** Windows 下已经自己拼好了 cmd.exe 的命令行，Node 不要再加引号。 */
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * 怎么启动一个命令。Windows 上的 `.cmd` / `.bat`（npm 全局安装的命令都是）只能通过 cmd.exe 运行：
 * 这里自己拼命令行并逐个转义，不用 Node 的 `shell: true`——那样不加引号，路径带空格（例如用户名带空格的 npm 目录）时启动失败，
 * 参数里的 `&`、`|` 还会被 cmd 当成命令分隔符。其他情况直接启动，不经过 shell。
 */
export function spawnSpec(command: string, args: readonly string[], platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>> = {}): SpawnSpec {
  if (!needsShell(command, platform)) return { file: command, args: [...args] };
  const line = [command.replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ');
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** dsh 的 profile 名只能是字母、数字和 `. _ -`；其他值（包括想夹带参数的）退回默认的 web。 */
export function safeProfile(profile: string): string {
  return /^[\w.-]+$/u.test(profile) ? profile : 'web';
}

/**
 * 插件启动、还没退出的子进程。扩展宿主退出（包括来不及等 deactivate 做完）时把它们一起结束：
 * 子进程在独立进程组里，不会随宿主收到信号，不处理就成了孤儿进程。
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

export function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const live of liveChildren) {
      if (live.pid === undefined || live.exitCode !== null || live.signalCode !== null) continue;
      if (process.platform === 'win32') live.kill();
      else signalGroup(live.pid, 'SIGTERM');
    }
  });
}

/**
 * 执行 `dsh --version`。
 * @returns 去掉首尾空白的版本输出。
 */
export function probeVersion(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<string> {
  const spec = spawnSpec(command, ['--version'], process.platform, env);
  return new Promise((resolve, reject) => {
    execFile(
      spec.file,
      spec.args,
      {
        env: env as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(signal ? { signal } : {}),
      },
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
  const spec = spawnSpec(options.command, buildLaunchArgs(safeProfile(options.profile), options.launcherArgs), process.platform, options.env);
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
    if (options.signal?.aborted) {
      reject(new LaunchError(t('runtime.aborted'), ''));
      return;
    }
    const child = spawn(spec.file, spec.args, {
      cwd: options.cwd,
      env: { ...options.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX 下放进独立进程组，退出时能连同 dsh 的子进程一起结束
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    trackChild(child);

    const onAbort = (): void => fail(t('runtime.aborted'));
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void stopRuntime(child);
      reject(new LaunchError(message, tail.join('\n')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => fail(t('runtime.timeout', Math.round(timeoutMs / 1000))), timeoutMs);

    const stdout = new LineSplitter((line) => {
      const safe = remember(line);
      options.onOutput?.(safe, 'stdout');
      if (settled) return;
      const found = parseLaunchUrl(line);
      if (found) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
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
