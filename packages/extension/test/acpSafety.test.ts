/**
 * ACP 底层和 dsh 一致的保护：审批前检查未保存的文件、「始终允许」、切到不再询问的模式先确认；
 * 以及消息没发出去时把文字还给输入框、代理退出时排队的消息不丢。
 */
import { describe, expect, it } from 'vitest';
import type { HostToWebview, PendingInteraction } from '@harness-deck/shared';
import { AcpController, isUnrestrictedMode, type AcpLink } from '../src/acp/AcpController.ts';
import { setLocale } from '../src/i18n.ts';
import { noWorkbench, type Workbench } from '../src/vm/workbench.ts';

setLocale('zh');

const MODES = {
  id: 'mode',
  category: 'mode',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Manual' },
    { value: 'plan', name: 'Plan' },
    { value: 'bypassPermissions', name: 'Bypass Permissions' },
  ],
};

interface Fake extends AcpLink {
  readonly log: string[];
  /** 正在进行的 session/prompt：调用它结束这一轮。 */
  finishPrompt?: (result: unknown) => void;
}

function fakeLink(options: { holdPrompt?: boolean } = {}): Fake {
  let next = 0;
  const link: Fake = {
    log: [],
    request: async <T,>(method: string, params: unknown): Promise<T> => {
      const p = params as { sessionId?: string; value?: string };
      link.log.push(method === 'session/set_config_option' ? `${method} ${p.value}` : method);
      if (method === 'session/new') return { sessionId: `s${++next}`, configOptions: [MODES] } as T;
      if (method === 'session/set_config_option') return { configOptions: [{ ...MODES, currentValue: p.value }] } as T;
      if (method === 'session/prompt') {
        if (!options.holdPrompt) return { stopReason: 'end_turn' } as T;
        return new Promise<T>((resolve, reject) => {
          link.finishPrompt = (result) => (result instanceof Error ? reject(result) : resolve(result as T));
        });
      }
      return null as T;
    },
    notify: () => undefined,
  };
  return link;
}

function setup(workbench: Partial<Workbench> = {}) {
  const posts: HostToWebview[] = [];
  const c = new AcpController({
    workspacePath: '/w',
    workbench: { ...noWorkbench, ...workbench },
    post: (m) => posts.push(m),
    log: () => undefined,
    openExternal: () => undefined,
    showLogs: () => undefined,
    restartRuntime: () => undefined,
    loadActiveSessionId: () => undefined,
    saveActiveSessionId: () => undefined,
    loadSessions: () => [],
    saveSessions: () => undefined,
    renderDelayMs: 0,
  });
  const approvals = () => c.snapshot().interactions.filter((i): i is Extract<PendingInteraction, { kind: 'approval' }> => i.kind === 'approval');
  const toasts = () => posts.filter((m): m is Extract<HostToWebview, { type: 'toast' }> => m.type === 'toast');
  return { c, posts, approvals, toasts };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

const editRequest = {
  sessionId: 's1',
  toolCall: { toolCallId: 'c1', kind: 'edit', title: 'Edit src/a.ts', locations: [{ path: '/w/src/a.ts' }], rawInput: { file_path: '/w/src/a.ts' } },
  options: [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow edits', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
};

describe('ACP 审批', () => {
  it('要改的文件有未保存内容：卡片标出来，允许被拦下；保存后可以允许', async () => {
    let dirty = ['/w/src/a.ts'];
    const { c, approvals, toasts } = setup({ dirtyFiles: () => dirty });
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    const answer = c.onAgentRequest('session/request_permission', editRequest);
    const card = approvals()[0]!;
    expect(card.dirtyFiles).toEqual(['src/a.ts']);
    await c.handle({ type: 'respondApproval', payload: { id: card.id, decision: 'allow' } });
    expect(toasts().at(-1)?.payload).toMatchObject({ level: 'error' });
    expect(approvals()).toHaveLength(1);
    // 拒绝不受影响的话这里不测；保存之后再允许
    dirty = [];
    expect(approvals()[0]!.dirtyFiles).toEqual([]);
    await c.handle({ type: 'respondApproval', payload: { id: card.id, decision: 'allow' } });
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    c.dispose();
  });

  it('有未保存内容时仍然可以拒绝；命令的审批不看未保存文件', async () => {
    const { c, approvals } = setup({ dirtyFiles: () => ['/w/src/a.ts'] });
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    const rejected = c.onAgentRequest('session/request_permission', editRequest);
    await c.handle({ type: 'respondApproval', payload: { id: approvals()[0]!.id, decision: 'reject' } });
    await expect(rejected).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    const command = c.onAgentRequest('session/request_permission', {
      sessionId: 's1',
      toolCall: { toolCallId: 'c2', kind: 'execute', title: 'pnpm test', rawInput: { command: 'pnpm test' } },
      options: editRequest.options,
    });
    expect(approvals()[0]).toMatchObject({ subject: 'pnpm test', subjectKind: 'command', dirtyFiles: [] });
    await c.handle({ type: 'respondApproval', payload: { id: approvals()[0]!.id, decision: 'allow' } });
    await expect(command).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    c.dispose();
  });

  it('代理提供「始终允许」时卡片带上它的名称，选它回传 allow_always 的选项', async () => {
    const { c, approvals } = setup();
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    const answer = c.onAgentRequest('session/request_permission', editRequest);
    expect(approvals()[0]!.allowAlways).toBe('Always allow edits');
    await c.handle({ type: 'respondApproval', payload: { id: approvals()[0]!.id, decision: 'allowAlways' } });
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    // 没有这个选项的代理：卡片上不出现
    const plain = c.onAgentRequest('session/request_permission', { ...editRequest, options: editRequest.options.filter((o) => o.kind !== 'allow_always') });
    expect(approvals()[0]!.allowAlways).toBeUndefined();
    await c.handle({ type: 'respondApproval', payload: { id: approvals()[0]!.id, decision: 'reject' } });
    await plain;
    c.dispose();
  });

  it('等着审批的会话在会话列表里标出来（它的标签可能已经关了）', async () => {
    const { c } = setup();
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    await c.handle({ type: 'sendMessage', payload: { text: '改一下', includeActive: false } });
    void c.onAgentRequest('session/request_permission', editRequest);
    expect(c.snapshot().sessions.find((s) => s.id === 's1')).toMatchObject({ needsAttention: true });
    c.dispose();
  });
});

describe('ACP 模式切换', () => {
  it('识别不再逐项询问的模式', () => {
    expect(isUnrestrictedMode('bypassPermissions')).toBe(true);
    expect(isUnrestrictedMode('yolo')).toBe(true);
    expect(isUnrestrictedMode('auto', 'Full Access')).toBe(true);
    expect(isUnrestrictedMode('dontAsk')).toBe(true);
    expect(isUnrestrictedMode('default', 'Manual')).toBe(false);
    expect(isUnrestrictedMode('plan', 'Plan')).toBe(false);
    expect(isUnrestrictedMode('acceptEdits', 'Accept Edits')).toBe(false);
  });

  it('切到不再询问的模式先确认：取消时不切换，确认后切换；普通模式不问', async () => {
    const asked: string[] = [];
    let allow = false;
    const { c } = setup({
      confirm: async (message) => {
        asked.push(message);
        return allow;
      },
    });
    const link = fakeLink();
    c.setLink(link, { authMethods: [] });
    await flush();
    await c.handle({ type: 'selectPermission', payload: { preset: 'bypassPermissions' } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Bypass Permissions');
    expect(link.log).not.toContain('session/set_config_option bypassPermissions');
    allow = true;
    await c.handle({ type: 'selectPermission', payload: { preset: 'bypassPermissions' } });
    expect(link.log).toContain('session/set_config_option bypassPermissions');
    await c.handle({ type: 'selectPermission', payload: { preset: 'plan' } });
    expect(asked).toHaveLength(2);
    expect(link.log).toContain('session/set_config_option plan');
    c.dispose();
  });
});

describe('ACP 发送', () => {
  it('没连上时发送：提示，并把文字还给输入框；固定的上下文留着', async () => {
    const { c, posts } = setup({ activeEditor: () => ({ path: '/w/src/a.ts', languageId: 'typescript' }) });
    c.pinActiveEditor();
    await c.handle({ type: 'sendMessage', payload: { text: '看一下这个', includeActive: false } });
    expect(posts.at(-2)).toMatchObject({ type: 'toast', payload: { level: 'error' } });
    expect(posts.at(-1)).toEqual({ type: 'restoreDraft', payload: { text: '看一下这个' } });
    expect(c.snapshot().context.pinned).toHaveLength(1);
    c.dispose();
  });

  it('发出去之后固定的上下文清空，不发 restoreDraft', async () => {
    const { c, posts } = setup({ activeEditor: () => ({ path: '/w/src/a.ts', languageId: 'typescript' }) });
    c.setLink(fakeLink(), { authMethods: [] });
    await flush();
    c.pinActiveEditor();
    await c.handle({ type: 'sendMessage', payload: { text: '看一下这个', includeActive: false } });
    expect(c.snapshot().context.pinned).toHaveLength(0);
    expect(posts.some((m) => m.type === 'restoreDraft')).toBe(false);
    c.dispose();
  });

  it('代理在回复途中退出：排队的消息留在队列里，不被取出丢掉', async () => {
    const { c } = setup();
    const link = fakeLink({ holdPrompt: true });
    c.setLink(link, { authMethods: [] });
    await flush();
    const first = c.handle({ type: 'sendMessage', payload: { text: '第一条', includeActive: false } });
    await flush();
    await c.handle({ type: 'sendMessage', payload: { text: '第二条', includeActive: false } });
    const queued = () => c.snapshot().items.filter((item) => item.kind === 'user' && item.pending === 'queued');
    expect(queued()).toHaveLength(1);
    // 代理进程退出：连接断开，进行中的请求被拒绝
    c.setLink(undefined);
    link.finishPrompt?.(new Error('代理进程已退出'));
    await first;
    await flush();
    expect(queued()).toMatchObject([{ text: '第二条' }]);
    c.dispose();
  });
});
