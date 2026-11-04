/**
 * 多窗口并发检查：两个 dsh Host（同一个 DSH_HOME、同一个 web profile）同时运行时是否冲突，
 * 以及两个 Host 同时写同一个会话时 dsh 如何拒绝。对应 docs/DESIGN.md D4。
 *
 * 用法：pnpm --filter dsh-copilot exec tsx scripts/concurrency-check.ts -- --dsh <dsh> [--node-bin <Node 24 bin>]
 */
import { parseArgs } from 'node:util';
import { DshClient } from '../src/dsh/DshClient.ts';
import { RemoteError } from '../src/dsh/remote/errors.ts';
import { RuntimeManager } from '../src/runtime/RuntimeManager.ts';
import { createDshTestEnv } from '../test/support/dshEnv.ts';

const { values: cli } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { dsh: { type: 'string' }, 'node-bin': { type: 'string' } },
});
if (!cli.dsh) throw new Error('需要 --dsh');

const env = await createDshTestEnv({ nodeBin: cli['node-bin'], scripts: { default: { kind: 'text', chunks: ['好的'] } } });
const makeRuntime = () =>
  new RuntimeManager({
    getConfig: () => ({ configuredPath: cli.dsh, profile: 'web', cwd: env.workspace, env: env.env, launcherArgs: env.launcherArgs, readyTimeoutMs: 120_000 }),
    log: () => undefined,
  });
const a = makeRuntime();
const b = makeRuntime();
const report: Record<string, unknown> = {};
try {
  const [ea, eb] = await Promise.all([a.start(), b.start()]);
  report.bothStarted = Boolean(ea && eb && ea.origin !== eb.origin);
  const ca = await DshClient.connect({ origin: ea!.origin, token: ea!.token });
  const cb = await DshClient.connect({ origin: eb!.origin, token: eb!.token });
  const { workspaceId } = await ca.ensureWorkspace(env.workspace);
  const sessionId = await ca.createSession({ workspaceId });
  await ca.prompt(sessionId, '你好');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  report.listedOnB = (await cb.listSessions()).some((s) => s.sessionId === sessionId);
  try {
    await cb.prompt(sessionId, '我是另一个窗口');
    report.promptOnB = 'accepted';
  } catch (error) {
    report.promptOnB = error instanceof RemoteError ? error.code : String(error);
  }
  try {
    const frames = cb.follow(sessionId);
    const first = await frames.next();
    report.followOnB = first.value?.type ?? 'ended';
    await frames.return(undefined);
  } catch (error) {
    report.followOnB = error instanceof RemoteError ? error.code : String(error);
  }
  // A 关掉之后 B 能否接手
  ca.close();
  await a.stop();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  try {
    await cb.prompt(sessionId, 'A 关掉之后');
    report.promptOnBAfterAStopped = 'accepted';
  } catch (error) {
    report.promptOnBAfterAStopped = error instanceof RemoteError ? error.code : String(error);
  }
  cb.close();
} finally {
  await Promise.all([a.stop(), b.stop()]);
  await env.cleanup();
}
console.log(JSON.stringify(report, null, 2));
