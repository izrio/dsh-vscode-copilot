/**
 * 长会话的投影和推送耗时。用法：pnpm --filter dsh-copilot bench [-- --events 5000]
 *
 * 模拟流式输出时每一帧要做的事：持久事件投影（命中缓存）、拼上流式内容、和上次推送的视图比较。
 */
import { parseArgs } from 'node:util';
import type { HostToWebview } from '@dsh-copilot/shared';
import type { WireEvent } from '../src/dsh/remote/follow.ts';
import { project, projectEvents } from '../src/vm/projector.ts';
import { ViewPublisher, type ControllerView } from '../src/vm/ViewPublisher.ts';

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { events: { type: 'string', default: '5000' } } });
const total = Number(values.events);

const events: WireEvent[] = [];
let seq = 0;
const push = (type: string, data: unknown) => events.push({ type, seq: ++seq, time: seq, data, surfaceOp: 'append' });
for (let turn = 1; events.length < total; turn++) {
  push('turn/start', { turn });
  push('user/message', { content: [{ type: 'text', text: `第 ${turn} 个问题：${'内容'.repeat(40)}` }], source: { kind: 'user', rpcId: `r${turn}` } });
  for (let step = 1; step <= 3; step++) {
    push('assistant/message', {
      turn,
      step,
      message: { content: [{ type: 'text', text: `回答 ${turn}.${step}\n\n${'一段说明。'.repeat(60)}\n\n\`\`\`ts\nconst x = ${step};\n\`\`\`` }] },
    });
    const callId = `c${turn}.${step}`;
    push('tool/call', {
      callId,
      name: step === 2 ? 'edit' : 'read',
      arguments: JSON.stringify({ file_path: `/w/src/f${step}.ts`, old_string: 'a\nb', new_string: 'a\nc\nd' }),
    });
    push('tool/result', {
      message: { toolCallId: callId, content: [{ type: 'text', text: 'ok' }] },
      meta: step === 2 ? { diffs: [{ oldText: 'a\nb', newText: 'a\nc\nd' }] } : {},
    });
  }
  push('turn/end', { reason: { kind: 'done' } });
}

const time = (label: string, runs: number, fn: () => void): void => {
  fn();
  const start = performance.now();
  for (let i = 0; i < runs; i++) fn();
  console.log(`${label.padEnd(36)} ${((performance.now() - start) / runs).toFixed(2)} ms`);
};

console.log(`${events.length} 条持久事件`);
let base = projectEvents({ events, workspacePath: '/w' });
console.log(`${base.items.length} 个界面条目`);
time('projectEvents（未命中缓存）', 10, () => {
  base = projectEvents({ events, workspacePath: '/w' });
});

let text = '';
const frame = () => {
  text += '流式输出的一小段文字。';
  return project(
    {
      events,
      workspacePath: '/w',
      pending: [],
      live: { attemptId: 'x', turn: 9999, step: 1, startedAfterSeq: seq, nextIndex: 1, blocks: new Map([[0, { kind: 'text', text }]]) },
    },
    base,
  );
};
time('project（命中缓存，带流式内容）', 200, () => void frame());

let posted = 0;
const publisher = new ViewPublisher((message: HostToWebview) => {
  posted += JSON.stringify(message).length;
});
const view = (): ControllerView => ({
  sessionKey: 's',
  sessions: [],
  session: { id: 's', title: 't', running: true, hasOlder: false, loadingOlder: false, sync: 'live' },
  items: frame().items,
  models: { options: [] },
  interactions: [],
  permissions: { options: [] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  commands: [],
});
publisher.reset(view());
posted = 0;
time('ViewPublisher.publish（每帧）', 200, () => publisher.publish(view()));
console.log(`每帧推送约 ${Math.round(posted / 201 / 1024)} KB`);
