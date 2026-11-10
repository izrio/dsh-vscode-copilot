/**
 * RuntimeManager 测试：用一个假的 dsh 可执行文件（Node 脚本）模拟版本输出、就绪 URL 和崩溃。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@dsh-copilot/shared';
import { RuntimeManager } from '../src/runtime/RuntimeManager.ts';

const FAKE_DSH = `#!/usr/bin/env node
const mode = process.env.FAKE_DSH_MODE ?? 'ok';
if (process.argv.includes('--version')) {
  console.log(process.env.FAKE_DSH_VERSION ?? '0.2.1-rc.5');
  process.exit(0);
}
if (mode === 'exit-early') {
  console.error('boom: missing provider');
  process.exit(3);
}
console.log('loading plugins…');
setTimeout(() => console.log('dsh web: http://127.0.0.1:45678/?token=fake-token-1'), 50);
if (mode === 'crash-after-ready') setTimeout(() => process.exit(9), 300);
setInterval(() => {}, 1000);
`;

const managers: RuntimeManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-dsh-'));
  dirs.push(dir);
  const command = join(dir, 'dsh');
  await writeFile(command, FAKE_DSH);
  await chmod(command, 0o755);
  const statuses: RuntimeStatus[] = [];
  const manager = new RuntimeManager({
    getConfig: () => ({ configuredPath: command, profile: 'web', cwd: dir, env: { ...process.env, ...env }, readyTimeoutMs: 5_000 }),
    log: () => undefined,
    maxRestarts: 2,
    backoffMs: () => 50,
  });
  manager.onStatus((status) => statuses.push(status));
  managers.push(manager);
  return { manager, statuses };
}

describe.skipIf(process.platform === 'win32')('RuntimeManager', () => {
  it('启动后解析出 origin 和令牌，状态变为 connected', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'ok' });
    const endpoint = await manager.start();
    expect(endpoint).toEqual({ origin: 'http://127.0.0.1:45678', token: 'fake-token-1', version: '0.2.1-rc.5' });
    expect(statuses.map((s) => s.kind)).toEqual(['locating', 'starting', 'connected']);
  });

  it('并发调用 start 只启动一次', async () => {
    const { manager } = await setup({ FAKE_DSH_MODE: 'ok' });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(a).toBe(b);
  });

  it('版本过低时不启动', async () => {
    const { manager } = await setup({ FAKE_DSH_VERSION: '0.1.5-rc.1' });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.currentStatus).toEqual({ kind: 'unsupportedVersion', version: '0.1.5-rc.1', minimum: '0.2.1-rc.5' });
  });

  it('就绪前退出时状态为 failed', async () => {
    const { manager } = await setup({ FAKE_DSH_MODE: 'exit-early' });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.currentStatus.kind).toBe('failed');
  });

  it('就绪后意外退出会自动重启，超过上限后停止', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'crash-after-ready' });
    await manager.start();
    // 每次崩溃间隔约 300ms + 退避 50ms；上限 2 次重启
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const kinds = statuses.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'reconnecting')).toHaveLength(2);
    expect(manager.currentStatus.kind).toBe('failed');
  });

  it('找不到 dsh 时状态为 notInstalled', async () => {
    const manager = new RuntimeManager({
      getConfig: () => ({ profile: 'web', cwd: tmpdir(), env: { PATH: '/nonexistent' } }),
      log: () => undefined,
    });
    managers.push(manager);
    await manager.start();
    expect(manager.currentStatus.kind).toBe('notInstalled');
  });
});

/**
 * Windows：npm 全局安装的 dsh 是 `dsh.cmd`，只能经 cmd.exe 运行；安装目录常带空格（`C:\Program Files\…`）。
 * 用带空格的临时目录里的 .cmd 包装假的 dsh，确认命令行加了引号、能正常启动和停止。
 */
describe.runIf(process.platform === 'win32')('RuntimeManager（Windows .cmd）', () => {
  it('路径带空格的 dsh.cmd 能启动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake dsh '));
    dirs.push(dir);
    await writeFile(join(dir, 'fake-dsh.js'), FAKE_DSH);
    const command = join(dir, 'dsh.cmd');
    await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.js" %*\r\n`);
    const manager = new RuntimeManager({
      getConfig: () => ({ configuredPath: command, profile: 'web', cwd: dir, env: { ...process.env, FAKE_DSH_MODE: 'ok' }, readyTimeoutMs: 10_000 }),
      log: () => undefined,
    });
    managers.push(manager);
    const endpoint = await manager.start();
    expect(endpoint).toEqual({ origin: 'http://127.0.0.1:45678', token: 'fake-token-1', version: '0.2.1-rc.5' });
  });
});
