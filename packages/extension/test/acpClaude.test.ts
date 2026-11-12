import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Item } from '@harness-deck/shared';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpError } from '../src/acp/connection.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { builtinProfiles, parseProfiles } from '../src/backend/profiles.ts';
import { setLocale } from '../src/i18n.ts';

/** 真实 Claude ACP 适配器（@agentclientprotocol/claude-agent-acp 0.101.0）接本地假模型的帧，见 fixtures/claude/tools.json。 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/claude/tools.json', import.meta.url), 'utf8')) as {
  live: Record<string, unknown>[];
  load: Record<string, unknown>[];
};

const EXPECTED = [
  { kind: 'user', text: 'HELLO 打个招呼' },
  { kind: 'assistant', markdown: '你好，我是 Claude。' },
  { kind: 'user', text: 'READ 一下' },
  { kind: 'assistant', markdown: '先看看文件。' },
  { kind: 'explore', summary: '读取 1 个文件', status: 'ok', entries: [{ label: 'Read  notes.txt' }] },
  { kind: 'assistant', markdown: '文件有两行。' },
  { kind: 'user', text: 'WRITE 文件' },
  { kind: 'activity', variant: 'edit', tool: 'Write', label: 'hello.txt', created: true, stats: { additions: 2, deletions: 0 } },
  { kind: 'activity', variant: 'edit', tool: 'Edit', label: 'notes.txt', stats: { additions: 2, deletions: 1 } },
  { kind: 'assistant', markdown: '写好了。' },
  { kind: 'user', text: 'BASH 跑一下' },
  { kind: 'activity', variant: 'command', label: 'Bash  ls', status: 'ok', output: 'hello.txt\nnotes.txt' },
  { kind: 'assistant', markdown: '列出来了。' },
  // 这个版本的 Claude Code 没有 Grep / Glob 工具：调用失败显示为出错
  { kind: 'user', text: 'GREP 搜' },
  { kind: 'explore', status: 'error', entries: [{ label: 'Grep  line', status: 'error' }, { label: 'Glob  *.txt', status: 'error' }] },
  { kind: 'assistant', markdown: '找到了。' },
  // TodoWrite 是 plan 更新，不是工具行
  { kind: 'user', text: 'TODO 计划' },
  { kind: 'assistant', markdown: '计划好了。' },
];

function replay(frames: readonly Record<string, unknown>[]): AcpSessionProjection {
  const p = new AcpSessionProjection('/w');
  let now = 0;
  for (const frame of frames) {
    if (typeof frame.prompt === 'string') {
      p.addUserMessage(frame.prompt);
      p.startTurn(now);
    } else if (typeof frame.stopReason === 'string') {
      p.endTurn((now += 500), frame.stopReason);
    } else {
      p.apply(frame);
    }
  }
  return p;
}

describe('Claude 的 ACP 帧', () => {
  it('实时：读文件「浏览」、写入和修改的增删行数、命令输出、待办', () => {
    const p = replay(fixture.live);
    const items = p.snapshotItems().filter((i) => i.kind !== 'turnDone');
    expect(items).toMatchObject(EXPECTED);
    expect(items).toHaveLength(EXPECTED.length);
    expect(p.todos).toEqual([
      { content: '做第一步', status: 'in_progress' },
      { content: '第二步', status: 'pending' },
    ]);
  });

  it('session/load 回放得到同样的条目', () => {
    expect(replay(fixture.load).snapshotItems()).toMatchObject(EXPECTED);
  });
});

describe('Claude 底层', () => {
  it('内置在 CodeBuddy 后面，带安装提示和登录说明，不是单会话代理', () => {
    const builtins = builtinProfiles((id) => `hint:${id}`);
    expect(parseProfiles([], undefined, builtins).map((p) => p.id)).toEqual(['dsh', 'oh-my-pi', 'codebuddy', 'claude']);
    expect(builtins.find((p) => p.id === 'claude')).toMatchObject({
      command: 'claude-agent-acp',
      args: [],
      installHint: 'hint:claude',
      signInHint: 'hint:claude-sign-in',
    });
    expect(builtins.find((p) => p.id === 'claude')?.singleSession).toBeUndefined();
  });

  it('没登录时（发消息才发现，代理没有登录方式）显示登录说明，而不是代理的原话', async () => {
    setLocale('zh');
    const requests: string[] = [];
    const link: AcpLink = {
      request: async <T,>(method: string): Promise<T> => {
        requests.push(method);
        if (method === 'session/new') return { sessionId: 's1' } as T;
        if (method === 'session/prompt') throw new AcpError(method, -32000, 'Authentication required');
        return null as T;
      },
      notify: () => undefined,
    };
    const controller = new AcpController({
      workspacePath: '/w',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      signInHint: '在终端运行 claude 并输入 /login 登录。',
      backends: () => ({ items: [{ id: 'claude', name: 'Claude', kind: 'acp' }], active: 'claude' }),
    });
    controller.setLink(link, { authMethods: [] });
    await controller.handle({ type: 'sendMessage', payload: { text: 'hi', includeActive: false } });
    const items = (controller as unknown as { currentProjection(): AcpSessionProjection }).currentProjection().snapshotItems();
    const notice = items.find((i): i is Extract<Item, { kind: 'notice' }> => i.kind === 'notice');
    expect(notice?.text).toContain('Claude 需要登录。在终端运行 claude 并输入 /login 登录。');
    // 没有登录方式：不调用 authenticate，也不重发
    expect(requests.filter((m) => m === 'session/prompt')).toHaveLength(1);
    expect(requests).not.toContain('authenticate');
    controller.dispose();
  });
});
