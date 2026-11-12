/**
 * RuntimeManager 测试：用一个假的 dsh 可执行文件（Node 脚本）模拟版本输出、就绪 URL 和崩溃。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@harness-deck/shared';
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
if (mode === 'never-ready') { setInterval(() => {}, 1000); return; }
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

  it('启动途中停止：立即结束还没就绪的进程，不等启动超时', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'never-ready' });
    const starting = manager.start();
    // 等到进程已经起来、正在等就绪 URL
    await expect.poll(() => statuses.at(-1)?.kind, { timeout: 3_000 }).toBe('starting');
    const began = Date.now();
    await manager.stop();
    // 就绪超时是 5 秒：远早于它返回，说明没有等启动跑完
    expect(Date.now() - began).toBeLessThan(2_000);
    await expect(starting).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual({ kind: 'idle' });
    // 中止不算失败：不显示「启动失败」
    expect(statuses.some((s) => s.kind === 'failed')).toBe(false);
  });
});
