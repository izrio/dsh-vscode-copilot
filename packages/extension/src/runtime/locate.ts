/**
 * 查找 dsh 可执行文件。顺序见 docs/DESIGN.md 6.1：
 * 1. 设置项 `dsh.runtime.path`
 * 2. PATH 中的 `dsh`（DeepSeek Desktop 安装的命令，或 npm 全局安装）
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export interface LocateOptions {
  /** 用户在设置里指定的路径；空字符串视为未设置。 */
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

export type LocateResult =
  | { readonly kind: 'found'; readonly command: string; readonly source: 'setting' | 'path' }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    // Windows 没有可执行位，存在即可
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string, platform: NodeJS.Platform, env: LocateOptions['env']): string[] {
  if (platform !== 'win32') return [name];
  // 已经带扩展名（omp.cmd）时只找这个名字
  if (/\.[a-z0-9]+$/iu.test(name)) return [name];
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((ext) => `${name}${ext}`);
}

/**
 * 查找 dsh。
 * @returns 找到时给出命令路径和来源；设置项指定了但无效时 `configuredPathInvalid` 为 true。
 */
export async function locateDsh(options: LocateOptions): Promise<LocateResult> {
  return locateExecutable('dsh', options);
}

/**
 * 在 PATH（Windows 上加 PATHEXT）里查找可执行文件；`name` 是绝对路径或带目录时直接检查它。
 * 设置项 `configuredPath` 优先。
 */
export async function locateExecutable(name: string, options: LocateOptions): Promise<LocateResult> {
  if (isAbsolute(name) || /[\\/]/u.test(name)) {
    return (await isExecutableFile(name, options.platform)) ? { kind: 'found', command: name, source: 'setting' } : { kind: 'notFound', configuredPathInvalid: true };
  }
  const configured = options.configuredPath?.trim();
  if (configured) {
    if (await isExecutableFile(configured, options.platform)) {
      return { kind: 'found', command: configured, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }
  const pathValue = options.env.PATH ?? options.env.Path ?? '';
  const names = candidateNames(name, options.platform, options.env);
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isExecutableFile(candidate, options.platform)) {
        return { kind: 'found', command: candidate, source: 'path' };
      }
    }
  }
  return { kind: 'notFound', configuredPathInvalid: false };
}
