import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wholeFile } from '../src/acp/AcpController.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { builtinProfiles, parseProfiles } from '../src/backend/profiles.ts';

/** 真实 CodeBuddy（`codebuddy --acp` 2.181.0）接本地假模型的帧，见 fixtures/codebuddy/tools.json。 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/codebuddy/tools.json', import.meta.url), 'utf8')) as {
  live: Record<string, unknown>[];
  load: Record<string, unknown>[];
};

/** 实时的一轮轮对话：用户消息本地加入，prompt 结束时结束这一轮。 */
function replayLive(p: AcpSessionProjection): void {
  let now = 0;
  for (const frame of fixture.live) {
    if (typeof frame.prompt === 'string') {
      p.addUserMessage(frame.prompt);
      p.startTurn(now);
    } else if (typeof frame.stopReason === 'string') {
      p.endTurn((now += 500), frame.stopReason);
    } else if (!frame.permission) {
      p.apply(frame);
    }
  }
}

const EXPECTED = [
  { kind: 'user', text: 'READ 一下' },
  { kind: 'assistant', markdown: '先看看文件。' },
  { kind: 'explore', summary: '读取 1 个文件', status: 'ok', entries: [{ label: 'Read  notes.txt', status: 'ok' }] },
  { kind: 'assistant', markdown: '文件有两行。' },
  { kind: 'user', text: 'WRITE 文件' },
  { kind: 'activity', variant: 'edit', tool: 'Write', label: 'hello.txt', status: 'ok', created: true, stats: { additions: 2, deletions: 0 } },
  { kind: 'activity', variant: 'edit', tool: 'Edit', label: 'notes.txt', status: 'ok', stats: { additions: 2, deletions: 1 } },
  { kind: 'assistant', markdown: '写好了。' },
  { kind: 'user', text: 'BASH 跑一下' },
  { kind: 'activity', variant: 'command', label: 'Bash  ls', status: 'ok', output: 'hello.txt  notes.txt' },
  { kind: 'assistant', markdown: '列出来了。' },
  { kind: 'user', text: 'GREP 搜' },
  { kind: 'explore', status: 'ok', entries: [{ status: 'ok' }, { label: 'Glob  *.txt', status: 'ok' }] },
  { kind: 'assistant', markdown: '找到了。' },
  // 待办工具不显示成一行
  { kind: 'user', text: 'TODO 计划' },
  { kind: 'assistant', markdown: '计划好了。' },
];

describe('CodeBuddy 的 ACP 帧', () => {
  it('实时：工具名取自 _meta，读文件和搜索合并成「浏览」，命令只显示输出，待办进入状态条', () => {
    const p = new AcpSessionProjection('/w');
    replayLive(p);
    expect(p.snapshotItems().filter((i) => i.kind !== 'turnDone')).toMatchObject(EXPECTED);
    expect(p.snapshotItems().filter((i) => i.kind !== 'turnDone')).toHaveLength(EXPECTED.length);
    expect(p.todos).toEqual([
      { content: '第一步', status: 'in_progress' },
      { content: '第二步', status: 'pending' },
    ]);
    // 参数生成完时回显的 JSON 不当成输出
    const items = JSON.stringify(p.snapshotItems());
    expect(items).not.toContain('{\\"file_path\\"');
    expect(items).not.toContain('Stdout:');
  });

  it('session/load 回放得到同样的条目', () => {
    const p = new AcpSessionProjection('/w');
    for (const update of fixture.load) p.apply(update);
    expect(p.snapshotItems()).toMatchObject(EXPECTED);
    expect(p.todos?.map((t) => t.status)).toEqual(['in_progress', 'pending']);
  });

  it('只有工具名、没有类型的第一帧，之后知道是读文件时改成「浏览」并接到前一组', () => {
    const p = new AcpSessionProjection('/w');
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', kind: 'read', status: 'completed', name: 'read', rawInput: { path: 'a.ts' } });
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Lookup', kind: 'other', status: 'in_progress' });
    expect(p.snapshotItems()).toMatchObject([{ kind: 'explore' }, { kind: 'activity' }]);
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', kind: 'search', status: 'completed', rawInput: { pattern: 'foo' } });
    expect(p.snapshotItems()).toMatchObject([{ kind: 'explore', entries: [{ id: 'a' }, { id: 'b', status: 'ok' }] }]);
  });

  it('命令失败时输出带上退出码和标准错误', () => {
    const p = new AcpSessionProjection('/w');
    p.apply({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute', status: 'pending', rawInput: { command: 'false' }, _meta: { 'codebuddy.ai/toolName': 'Bash' } });
    p.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'failed', rawOutput: { type: 'text', text: 'Stdout: (empty)\n\nStderr: boom\nExit Code: 1\nSignal: (none)' } });
    expect(p.snapshotItems()).toMatchObject([{ kind: 'activity', variant: 'command', status: 'error', output: 'boom\nexit 1' }]);
  });
});

describe('Edit 片段的整文件 Diff', () => {
  it('片段在文件里只出现一次时还原整个文件的修改前内容', () => {
    expect(wholeFile({ path: '/w/a', oldText: 'line two', newText: 'line 2\nline three' }, 'line one\nline 2\nline three\n')).toBe('line one\nline two\n');
  });
  it('新建、内容就是整个文件、找不到或出现多次时不还原', () => {
    expect(wholeFile({ path: '/w/a', oldText: null, newText: 'x' }, 'x')).toBeUndefined();
    expect(wholeFile({ path: '/w/a', oldText: 'a', newText: 'b' }, 'b')).toBeUndefined();
    expect(wholeFile({ path: '/w/a', oldText: 'a', newText: 'b' }, 'c')).toBeUndefined();
    expect(wholeFile({ path: '/w/a', oldText: 'a', newText: 'b' }, 'b b')).toBeUndefined();
    expect(wholeFile({ path: '/w/a', oldText: 'a', newText: 'b' }, undefined)).toBeUndefined();
  });
});

describe('内置底层', () => {
  const builtins = builtinProfiles((id) => `install ${id}`);

  it('dsh 和内置的 ACP 代理总在列表里，设置里的项追加在后面', () => {
    expect(parseProfiles([{ name: 'Gemini CLI', command: 'gemini' }], undefined, builtins).map((p) => p.id)).toEqual(['dsh', 'oh-my-pi', 'codebuddy', 'claude', 'gemini-cli']);
    expect(builtins.find((p) => p.id === 'codebuddy')).toMatchObject({ command: 'codebuddy', args: ['--acp'], installHint: 'install codebuddy' });
  });

  it('设置里 id 相同的项替换内置项，位置不变；没写安装提示时沿用内置的', () => {
    const profiles = parseProfiles([{ id: 'codebuddy', name: 'CodeBuddy', command: '/opt/cb/bin/codebuddy', args: ['--acp'], env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } }], undefined, builtins);
    expect(profiles.map((p) => p.id)).toEqual(['dsh', 'oh-my-pi', 'codebuddy', 'claude']);
    expect(profiles[2]).toMatchObject({ command: '/opt/cb/bin/codebuddy', env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' }, installHint: 'install codebuddy' });
  });

  it('CodeBuddy 是单会话代理；覆盖命令路径时保留，明确写 false 时关闭', () => {
    expect(builtins.find((p) => p.id === 'codebuddy')?.singleSession).toBe(true);
    expect(builtins.find((p) => p.id === 'oh-my-pi')?.singleSession).toBeUndefined();
    const kept = parseProfiles([{ id: 'codebuddy', name: 'CodeBuddy', command: 'cb' }], undefined, builtins)[2];
    expect(kept).toMatchObject({ command: 'cb', singleSession: true });
    const off = parseProfiles([{ id: 'codebuddy', name: 'CodeBuddy', command: 'cb', singleSession: false }], undefined, builtins)[2];
    expect(off).toMatchObject({ singleSession: false });
  });
});
