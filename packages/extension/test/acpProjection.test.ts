import { describe, expect, it } from 'vitest';
import { AcpSessionProjection } from '../src/acp/projection.ts';

/** 来自真实 omp 18.18 的帧（路径和 id 简化）。 */
const WS = '/w';

describe('ACP 会话投影', () => {
  it('流式回复按 messageId 拼接；结束后不再是流式', () => {
    const p = new AcpSessionProjection(WS);
    p.addUserMessage('HELLO 打个招呼');
    p.startTurn(0);
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，' }, messageId: 'm1' });
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我是 omp。' }, messageId: 'm1' });
    expect(p.snapshotItems()).toMatchObject([{ kind: 'user', text: 'HELLO 打个招呼' }, { kind: 'assistant', markdown: '你好，我是 omp。', streaming: true }]);
    p.endTurn(2_000, 'end_turn');
    expect(p.snapshotItems()).toMatchObject([{ kind: 'user' }, { kind: 'assistant', streaming: false }, { kind: 'turnDone', durationMs: 2_000, completed: true }]);
  });

  it('读文件合并成「浏览」；命令显示「已运行」和输出；写文件显示增加的行数', () => {
    const p = new AcpSessionProjection(WS);
    p.startTurn(0);
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'r1', name: 'read', title: 'read: README.md', kind: 'read', status: 'pending', rawInput: { path: 'README.md' }, locations: [{ path: '/w/README.md' }] });
    p.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'w1', name: 'write', title: 'write: notes.md', kind: 'edit', status: 'pending', rawInput: { path: 'notes.md', content: 'a\nb\n' }, locations: [{ path: '/w/notes.md' }] });
    p.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Successfully wrote 4 bytes' } }] });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'b1', name: 'bash', title: '$ echo hi && ls', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi && ls' }, content: [{ type: 'content', content: { type: 'text', text: '$ echo hi && ls' } }] });
    p.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', rawOutput: { content: [{ type: 'text', text: 'hi\nREADME.md\n' }] } });
    expect(p.snapshotItems()).toMatchObject([
      { kind: 'explore', summary: '读取 1 个文件', status: 'ok', entries: [{ label: 'read  README.md' }] },
      { kind: 'activity', variant: 'edit', label: 'notes.md', status: 'ok', stats: { additions: 2, deletions: 0 } },
      { kind: 'activity', variant: 'command', label: 'bash  echo hi && ls', status: 'ok', output: 'hi\nREADME.md' },
    ]);
  });

  it('修改带 diff 内容时有增删行数和 Diff 入口；没有旧内容算新建', () => {
    const p = new AcpSessionProjection(WS);
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'e1', name: 'edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }] });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'e2', name: 'edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/w/new.ts', oldText: null, newText: 'x\n' }] });
    expect(p.snapshotItems()).toMatchObject([
      { label: 'a.ts', stats: { additions: 2, deletions: 1 }, diff: { kind: 'tool', callId: 'e1' } },
      { label: 'new.ts', created: true, stats: { additions: 1, deletions: 0 } },
    ]);
    expect(p.diffsOf('e1')).toEqual([{ path: '/w/a.ts', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }]);
  });

  it('回放历史：用户消息片段、推理、待办、用量、模式和命令', () => {
    const p = new AcpSessionProjection(WS);
    p.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '看看' }, messageId: 'u1' });
    p.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '这个' }, messageId: 'u1' });
    p.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' }, messageId: 't1' });
    p.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的' }, messageId: 'm1' });
    p.apply({ sessionUpdate: 'plan', entries: [{ content: '读代码', status: 'completed', priority: 'high' }, { content: '改代码', status: 'in_progress', priority: 'high' }] });
    p.apply({ sessionUpdate: 'usage_update', size: 128000, used: 6400 });
    p.apply({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'model', description: 'Show current model' }] });
    p.setConfigOptions([{ id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'plan' }] }]);
    p.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    expect(p.snapshotItems()).toMatchObject([
      { kind: 'user', text: '看看这个' },
      { kind: 'assistant', reasoning: '想一想', markdown: '好的' },
    ]);
    expect(p.todos).toEqual([{ content: '读代码', status: 'completed' }, { content: '改代码', status: 'in_progress' }]);
    expect(p.usage).toEqual({ used: 6400, size: 128000 });
    expect(p.commands.map((c) => c.name)).toEqual(['model']);
    expect(p.configOptions[0]?.currentValue).toBe('plan');
  });

  it('停止后：未完成的工具调用标记失败，显示「已停止生成」', () => {
    const p = new AcpSessionProjection(WS);
    p.startTurn(0);
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'b1', name: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep 9' } });
    p.endTurn(500, 'cancelled');
    expect(p.snapshotItems()).toMatchObject([{ kind: 'activity', status: 'error' }, { kind: 'notice', text: '已停止生成' }]);
  });
});
