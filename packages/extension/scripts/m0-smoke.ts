/**
 * M0 冒烟测试：用真实 dsh + 本地假模型跑通插件需要的核心链路，并录制 fixture。
 *
 * 用法：
 *   pnpm smoke -- --dsh /path/to/dsh [--node-bin /path/to/node24/bin] [--record]
 *
 * - 临时 DSH_HOME 和工作区，不读取用户的会话和凭据，不需要真实 API Key；
 * - `--node-bin`：dsh 需要 Node ≥ 24.9，本机 Node 版本不够时把 Node 24 的 bin 目录放到 PATH 最前面；
 * - `--record`：把每个场景收到的 follow 帧写到 test/fixtures/m0/（临时路径会替换成占位符）。
 *
 * 输出：每个检查项的通过/失败，以及一份 JSON 报告（--report 指定路径）。
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DshClient } from '../src/dsh/DshClient.ts';
import { isMethodUnavailable } from '../src/dsh/remote/errors.ts';
import { applyFollowFrame, initialFollowState, liveText, type FollowFrame, type FollowState } from '../src/dsh/remote/follow.ts';
import type { WaterfallRequest } from '../src/dsh/remote/events.ts';
import { RuntimeManager } from '../src/runtime/RuntimeManager.ts';
import { startMockModel } from '../test/mock-model/server.ts';

const { values: cli } = parseArgs({
  // pnpm 会把 `--` 原样传进来
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dsh: { type: 'string' },
    'node-bin': { type: 'string' },
    record: { type: 'boolean', default: false },
    report: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});
if (!cli.dsh) {
  console.error('需要 --dsh <dsh 可执行文件路径>');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../test/fixtures/m0');

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}
const checks: Check[] = [];
const findings: Record<string, unknown> = {};
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail !== undefined && cli.verbose ? `  ${JSON.stringify(detail)}` : ''}`);
}

const storage = await mkdtemp(join(tmpdir(), 'dsh-m0-'));
const home = join(storage, 'home');
const workspace = join(storage, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# m0 workspace\n');
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['-c', 'user.email=m0@example.invalid', '-c', 'user.name=m0', 'add', '.'], { cwd: workspace });
execFileSync('git', ['-c', 'user.email=m0@example.invalid', '-c', 'user.name=m0', 'commit', '-q', '-m', 'init'], { cwd: workspace });

const model = await startMockModel({
  M0_HELLO: { kind: 'text', chunks: ['Hello', ', ', 'world', '!'], delayMs: 60 },
  M0_WRITE: {
    kind: 'tool',
    before: '我来创建文件。',
    tool: { name: 'write', input: { file_path: 'notes/m0.txt', content: 'line one\nline two\n' } },
    after: '文件已创建。',
  },
  M0_BASH: {
    kind: 'tool',
    tool: { name: 'bash', input: { description: 'Print a marker', command: 'echo m0-bash-ok' } },
    after: '命令已执行。',
  },
  M0_ASK: {
    kind: 'tool',
    tool: {
      name: 'ask_user_question',
      input: { questions: [{ id: 'scope', question: '改动范围？', options: [{ label: '只改测试' }, { label: '一起改实现' }] }] },
    },
    after: '收到你的选择。',
  },
  // dsh 要求修改前先读过文件（否则 FS_NOT_OBSERVED）
  M0_EDIT: {
    kind: 'tools',
    tools: [
      { name: 'read', input: { file_path: 'README.md' } },
      { name: 'edit', input: { file_path: 'README.md', old_string: '# m0 workspace', new_string: '# m0 workspace (edited)' } },
    ],
    after: '已修改 README。',
  },
  // 带 sandbox_permissions 的调用会先走审批（dsh packages/sandbox/sandbox/src/escalation.ts）
  M0_ESCALATE: {
    kind: 'tool',
    tool: {
      name: 'bash',
      input: {
        description: 'Print an escalated marker',
        command: 'echo m0-escalated-ok',
        sandbox_permissions: 'danger-full-access',
        justification: 'M0 approval smoke test',
      },
    },
    after: '越权命令已执行。',
  },
  M0_DENY: {
    kind: 'tool',
    tool: {
      name: 'bash',
      input: {
        description: 'Print a denied marker',
        command: 'echo m0-should-not-run',
        sandbox_permissions: 'danger-full-access',
        justification: 'M0 approval rejection test',
      },
    },
    after: '命令被拒绝了。',
  },
  M0_HOLD: { kind: 'hold', chunks: ['正在', '思考'] },
  default: { kind: 'text', chunks: ['OK'] },
});

await writeFile(
  join(home, 'settings.yaml'),
  `llm-deepseek:\n  apiKeyEnv: DSH_M0_API_KEY\n  baseURL: ${model.url}\n  thinking: disabled\n`,
);
// 关掉目标轮次驱动，避免额外的模型请求干扰脚本
const patchPath = join(storage, 'm0.patch.yml');
await writeFile(patchPath, "- id: goal-round-driver\n  name: '@deepseek-ai/dsh-goal-round-driver'\n  disabled: true\n");

const env: Record<string, string | undefined> = {
  PATH: [cli['node-bin'], process.env.PATH].filter(Boolean).join(delimiter),
  HOME: home,
  LANG: process.env.LANG,
  TMPDIR: process.env.TMPDIR,
  DSH_HOME: home,
  DSH_M0_API_KEY: 'local-m0-only',
};

const runtimeLog: string[] = [];
const runtime = new RuntimeManager({
  getConfig: () => ({
    configuredPath: cli.dsh,
    profile: 'web',
    cwd: workspace,
    env,
    launcherArgs: ['--patch', patchPath],
    readyTimeoutMs: 120_000,
  }),
  log: (line) => console.log(`  [runtime] ${line}`),
  runtimeLog: (line) => {
    runtimeLog.push(line);
    if (cli.verbose) console.log(`  [dsh] ${line}`);
  },
});

let client: DshClient | undefined;
// fixture 里不留环境相关的路径和端口：dsh 安装目录（最后一个 node_modules 之前的部分）、临时目录、本机端口
const dshReal = realpathSync(cli.dsh);
const nodeModulesAt = dshReal.lastIndexOf(`${sep}node_modules${sep}`);
const dshRoot = nodeModulesAt >= 0 ? dshReal.slice(0, nodeModulesAt) : dirname(dshReal);
const sanitize = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value)
          .replaceAll(storage, '/tmp/dsh-m0')
          .replaceAll(model.url, 'http://127.0.0.1:MODEL')
          .replaceAll(dshRoot, '/opt/dsh')
          .replace(/http:\/\/127\.0\.0\.1:\d+/gu, 'http://127.0.0.1:PORT'),
      );

try {
  const started = Date.now();
  const endpoint = await runtime.start();
  check('启动 dsh 并从 stdout 解析到 URL 和令牌', endpoint !== undefined, runtime.currentStatus);
  if (!endpoint) throw new Error('dsh 没有启动');
  findings.version = endpoint.version;
  findings.startupMs = Date.now() - started;

  client = await DshClient.connect({ origin: endpoint.origin, token: endpoint.token, log: (line) => console.log(`  [client] ${line}`) });
  check('/connect 拿到 Cookie，mux 连接成功，$events 收到 ready', true, { cookieName: client.credential.cookie.split('=')[0] });

  const approvals: WaterfallRequest[] = [];
  const questions: WaterfallRequest[] = [];
  let approvalDecision: 'allowed-once' | 'rejected' = 'allowed-once';
  client.events.onWaterfall('approval/request', async (request) => {
    approvals.push(request);
    return { kind: 'result', value: approvalDecision };
  });
  client.events.onWaterfall('user-questions/request', async (request) => {
    questions.push(request);
    const items = (request.request.questions ?? []) as { id: string; options?: { label: string }[] }[];
    return { kind: 'result', value: { answers: items.map((q) => ({ id: q.id, selected: [q.options?.[0]?.label ?? ''] })) } };
  });
  const emitted: string[] = [];
  for (const event of ['api-session/status', 'api-session/added', 'api-session/activity', 'api-session/error']) {
    client.events.onEmit(event, () => emitted.push(event));
  }

  const sessions = await client.listSessions();
  check('session/list', Array.isArray(sessions), { count: sessions.length });

  const { workspaceId } = await client.ensureWorkspace(workspace);
  check('workspace/create', workspaceId.length > 0);
  const sessionId = await client.createSession({ workspaceId, agentPreset: 'standard' });
  check('session/create', sessionId.length > 0);

  // 后台跟随会话
  let state: FollowState = initialFollowState;
  const frames: FollowFrame[] = [];
  const liveSamples: string[] = [];
  let snapshotSeen = false;
  const followAbort = new AbortController();
  const waiters = new Set<() => void>();
  void (async () => {
    try {
      for await (const frame of client.follow(sessionId, followAbort.signal, (line) => console.log(`  [follow] ${line}`))) {
        frames.push(frame);
        if (frame.type === 'snapshot') snapshotSeen = true;
        state = applyFollowFrame(state, frame);
        const text = liveText(state);
        if (text) liveSamples.push(text);
        for (const wake of waiters) wake();
      }
    } catch (error) {
      if (!followAbort.signal.aborted) console.log(`  [follow] 结束：${String(error)}`);
    }
  })();

  const waitFor = (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> =>
    new Promise((resolveWait) => {
      if (predicate()) return resolveWait(true);
      const timer = setTimeout(() => {
        waiters.delete(wake);
        resolveWait(false);
      }, timeoutMs);
      const wake = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        waiters.delete(wake);
        resolveWait(true);
      };
      waiters.add(wake);
    });
  const turnEnds = (): number => state.events.filter((event) => event.type === 'turn/end').length;
  const eventsSince = (seq: number) => state.events.filter((event) => event.seq > seq);

  check('session/follow 收到开场快照', await waitFor(() => snapshotSeen, 10_000));

  async function scenario(name: string, prompt: string, timeoutMs = 60_000) {
    const startFrame = frames.length;
    const startSeq = state.cursor;
    const endsBefore = turnEnds();
    const samplesBefore = liveSamples.length;
    await client!.prompt(sessionId, prompt);
    const finished = await waitFor(() => turnEnds() > endsBefore, timeoutMs);
    const scenarioFrames = frames.slice(startFrame);
    if (cli.record) {
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(join(fixtureDir, `${name}.json`), `${JSON.stringify(sanitize(scenarioFrames), null, 2)}\n`);
    }
    return { finished, events: eventsSince(startSeq), frames: scenarioFrames, liveSamples: liveSamples.slice(samplesBefore) };
  }

  // 1. 纯文本：逐字流 + 完整消息
  {
    const result = await scenario('hello', 'M0_HELLO 打个招呼');
    check('场景 hello：轮次结束', result.finished);
    const streamFrames = result.frames.filter((f) => f.type === 'assistant-stream');
    check('场景 hello：收到逐字流帧（start/chunk/end）', streamFrames.length > 0, { count: streamFrames.length });
    check('场景 hello：逐字流中出现过部分文本', result.liveSamples.some((text) => text.length > 0 && text !== 'Hello, world!'), result.liveSamples.slice(0, 5));
    const message = result.events.find((event) => event.type === 'assistant/message');
    check('场景 hello：收到 assistant/message', message !== undefined);
    findings.helloEventTypes = result.events.map((event) => event.type);
    findings.assistantMessageKeys = message ? Object.keys(message.data as object) : [];
    findings.streamChunkSample = streamFrames.find((f) => f.type === 'assistant-stream' && f.frame.type === 'chunk');
    // 一轮里有多条 user/message：区分用户真正发的和 dsh 注入的上下文
    findings.userMessageSources = result.events
      .filter((event) => event.type === 'user/message')
      .map((event) => sanitize((event.data as { source?: unknown; content?: unknown }).source ?? event.data));
    findings.seqContiguous = state.gap === undefined;
  }

  // 2. 写文件：tool/call、tool/result.meta 中的 diff 展示数据、workspace/changes
  {
    const approvalsBefore = approvals.length;
    const result = await scenario('write', 'M0_WRITE 创建一个笔记文件');
    check('场景 write：轮次结束', result.finished);
    const call = result.events.find((event) => event.type === 'tool/call');
    const toolResult = result.events.find((event) => event.type === 'tool/result');
    check('场景 write：tool/call write', (call?.data as { name?: string } | undefined)?.name === 'write');
    const written = await readFile(join(workspace, 'notes/m0.txt'), 'utf8').catch(() => undefined);
    check('场景 write：文件写到了工作区', written === 'line one\nline two\n');
    const meta = (toolResult?.data as { meta?: unknown } | undefined)?.meta;
    findings.writeToolResultMeta = sanitize(meta);
    // 新建文件时 diffs 为空，operation 为 create：改动前不存在，改动后是 args.content
    const fsMeta = meta as { operation?: string; diffs?: unknown[] } | undefined;
    check('场景 write：tool/result.meta 为 { operation: create, diffs: [] }', fsMeta?.operation === 'create' && Array.isArray(fsMeta.diffs), meta);
    findings.writeApprovals = approvals.slice(approvalsBefore).map((a) => sanitize(a));
    const changes = await waitFor(() => state.events.some((event) => event.type === 'workspace/changes'), 10_000);
    findings.workspaceChangesEvent = sanitize(state.events.find((event) => event.type === 'workspace/changes'));
    check('场景 write：收到 workspace/changes 事件', changes);
    findings.writeEventTypes = result.events.map((event) => event.type);
  }

  // 2b. edit 已有文件：meta.diffs 带改动片段（oldText/newText，三行上下文）
  {
    const result = await scenario('edit', 'M0_EDIT 改一下 README');
    check('场景 edit：轮次结束', result.finished);
    const editCall = result.events.find((event) => event.type === 'tool/call' && (event.data as { name?: string }).name === 'edit');
    const callId = (editCall?.data as { callId?: string } | undefined)?.callId;
    const toolResult = result.events.find(
      (event) => event.type === 'tool/result' && (event.data as { message?: { toolCallId?: string } }).message?.toolCallId === callId,
    );
    const meta = (toolResult?.data as { meta?: { diffs?: { oldText?: unknown; newText?: unknown }[] } } | undefined)?.meta;
    findings.editToolResultMeta = sanitize(meta);
    const first = meta?.diffs?.[0];
    check('场景 edit：meta.diffs 带 oldText/newText 片段', typeof first?.oldText === 'string' && typeof first?.newText === 'string', meta);
  }

  // 3. bash：工作区内的普通命令
  {
    const approvalsBefore = approvals.length;
    const result = await scenario('bash', 'M0_BASH 运行一个命令');
    check('场景 bash：轮次结束', result.finished);
    const toolResult = result.events.find((event) => event.type === 'tool/result');
    findings.bashToolResult = sanitize(toolResult?.data);
    findings.bashApprovals = approvals.slice(approvalsBefore).map((a) => sanitize(a));
    check('场景 bash：命令输出包含 m0-bash-ok', JSON.stringify(toolResult?.data ?? null).includes('m0-bash-ok'), findings.bashToolResult);
  }

  // 3b. 越权命令：approval/request → 允许一次
  {
    const approvalsBefore = approvals.length;
    approvalDecision = 'allowed-once';
    const result = await scenario('approval-allow', 'M0_ESCALATE 需要越权的命令');
    check('场景 approval-allow：轮次结束', result.finished);
    const asked = approvals.slice(approvalsBefore);
    check('场景 approval-allow：收到 approval/request', asked.length === 1, asked.map((a) => sanitize(a)));
    findings.approvalRequest = asked.map((a) => sanitize(a));
    const toolResult = result.events.find((event) => event.type === 'tool/result');
    check('场景 approval-allow：批准后命令执行', JSON.stringify(toolResult?.data ?? null).includes('m0-escalated-ok'), sanitize(toolResult?.data));
    findings.approvalEventTypes = result.events.map((event) => event.type);
  }

  // 3c. 越权命令：approval/request → 拒绝
  {
    const approvalsBefore = approvals.length;
    approvalDecision = 'rejected';
    const result = await scenario('approval-reject', 'M0_DENY 需要越权但会被拒绝');
    approvalDecision = 'allowed-once';
    check('场景 approval-reject：轮次结束', result.finished);
    check('场景 approval-reject：收到 approval/request', approvals.length - approvalsBefore === 1);
    const toolResult = result.events.find((event) => event.type === 'tool/result');
    findings.rejectedToolResult = sanitize(toolResult?.data);
    check('场景 approval-reject：拒绝后命令没有执行', !JSON.stringify(toolResult?.data ?? null).includes('m0-should-not-run\\n'), findings.rejectedToolResult);
  }

  // 4. 提问：user-questions/request waterfall
  {
    const questionsBefore = questions.length;
    const result = await scenario('ask', 'M0_ASK 问我一个问题');
    check('场景 ask：轮次结束', result.finished);
    const asked = questions.slice(questionsBefore);
    check('场景 ask：收到 user-questions/request 并回答', asked.length === 1, asked.map((q) => sanitize(q)));
    findings.questionRequest = asked.map((q) => sanitize(q));
    const toolResult = result.events.find((event) => event.type === 'tool/result');
    findings.askToolResult = sanitize(toolResult?.data);
  }

  // 5. 停止：挂起的流式回复 + session/cancel
  {
    const startFrame = frames.length;
    const startSeq = state.cursor;
    const endsBefore = turnEnds();
    await client.prompt(sessionId, 'M0_HOLD 慢慢回答');
    const streaming = await waitFor(() => liveText(state).includes('正在'), 20_000);
    check('场景 cancel：挂起前收到部分逐字流', streaming);
    await client.cancel(sessionId);
    const ended = await waitFor(() => turnEnds() > endsBefore, 20_000);
    check('场景 cancel：session/cancel 后轮次结束', ended);
    const turnEnd = eventsSince(startSeq).find((event) => event.type === 'turn/end');
    findings.cancelTurnEnd = turnEnd?.data;
    findings.cancelEventTypes = eventsSince(startSeq).map((event) => event.type);
    check('场景 cancel：live 文本已清除', liveText(state) === '');
    if (cli.record) {
      await writeFile(join(fixtureDir, 'cancel.json'), `${JSON.stringify(sanitize(frames.slice(startFrame)), null, 2)}\n`);
    }
  }

  // 能力探测：后续里程碑要用的方法在当前版本是否存在
  const probes: Record<string, () => Promise<unknown>> = {
    'session/page': () =>
      client!.unary.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: state.cursor, maxMessages: 10 } }),
    'session/events': () =>
      client!.unary.call('session/events', { request: { address: { kind: 'session', sessionId }, throughSeq: state.cursor, maxMessages: 10 } }),
    'session/modelCatalog': () => client!.unary.call('session/modelCatalog', {}),
    'permissionPresets/catalog': () => client!.unary.call('permissionPresets/catalog', {}),
    'commands/list': () => client!.unary.call('commands/list', { agentId: sessionId }),
    'fileReferences/list': () => client!.unary.call('fileReferences/list', { agentId: sessionId, query: 'notes' }),
    'session/projections': () => client!.unary.call('session/projections', { request: { sessionId } }),
  };
  const capabilities: Record<string, string> = {};
  for (const [method, probe] of Object.entries(probes)) {
    try {
      const value = await probe();
      capabilities[method] = 'available';
      if (method === 'permissionPresets/catalog' || method === 'session/modelCatalog') findings[method] = sanitize(value);
    } catch (error) {
      capabilities[method] = isMethodUnavailable(error) ? 'unavailable' : `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  findings.capabilities = capabilities;
  findings.emittedEvents = [...new Set(emitted)];
  findings.modelRequests = model.requests.filter((r) => r.path === '/v1/messages').length;
  check('能力探测完成', true, capabilities);

  followAbort.abort();
} catch (error) {
  check('未预期的错误', false, error instanceof Error ? error.stack : String(error));
  console.log(runtimeLog.slice(-30).join('\n'));
} finally {
  client?.close();
  await runtime.stop();
  await model.close();
  await rm(storage, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
const report = { ok: failed.length === 0, checks, findings };
if (cli.report) await writeFile(cli.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
