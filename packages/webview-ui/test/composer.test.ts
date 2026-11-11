// @vitest-environment jsdom
/**
 * 输入框：发送失败时还原文字、运行中的停止和发送、Esc 停止；以及输入框上方合并后的状态栏。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview } from '@harness-deck/shared';

const posted: { type: string; payload: unknown }[] = [];
/** Webview 保存的状态（草稿等）；每个用例之后清掉。 */
let state: unknown;
let Composer: typeof import('../src/components/Composer.tsx').Composer;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: { type: string; payload: unknown }) => posted.push(message),
    getState: () => state,
    setState: (next: unknown) => void (state = next),
  });
  // jsdom 没有 requestAnimationFrame 的布局语义，同步执行即可
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (callback(0), 0)) as typeof requestAnimationFrame;
  store = await import('../src/store.ts');
  ({ Composer } = await import('../src/components/Composer.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
  state = undefined;
  store.resetStoreForTests();
});

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: '新对话', running: false }], active: 't1' },
    session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [], active: 'dsh' },
    ...overrides,
  };
}

const host = (message: HostToWebview) => act(() => store.applyHostMessage(message));
const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const running = { title: '任务', id: 's1', running: true, hasOlder: false, loadingOlder: false, sync: 'live' as const };

describe('输入框', () => {
  it('消息没发出去时把文字放回来；这期间新写的内容接在后面', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    fireEvent.change(input(), { target: { value: '帮我修一下这个 bug' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(posted.at(-1)).toMatchObject({ type: 'sendMessage', payload: { text: '帮我修一下这个 bug' } });
    expect(input().value).toBe('');

    host({ type: 'restoreDraft', payload: { text: '帮我修一下这个 bug' } });
    expect(input().value).toBe('帮我修一下这个 bug');

    // 还原之前用户已经开始写下一条：两段都保留
    fireEvent.change(input(), { target: { value: '另外' } });
    host({ type: 'restoreDraft', payload: { text: '第一条' } });
    expect(input().value).toBe('第一条\n另外');
  });

  it('运行中：没写内容时只有停止；写了内容时发送和停止都在', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: running }) });
    expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();

    fireEvent.change(input(), { target: { value: '顺便把测试也补上' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(posted.at(-1)).toMatchObject({ type: 'interrupt' });
    // 停止不清掉已经写的内容
    expect(input().value).toBe('顺便把测试也补上');
  });

  it('Esc 停止生成；空闲时、输入法组合输入时不发', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(posted.some((m) => m.type === 'interrupt')).toBe(false);

    host({ type: 'session', payload: running });
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
    expect(posted.some((m) => m.type === 'interrupt')).toBe(false);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(posted.at(-1)).toMatchObject({ type: 'interrupt' });
  });
});

describe('输入框上方的状态栏', () => {
  const todos = [
    { content: '读代码', status: 'completed' as const },
    { content: '改实现', status: 'in_progress' as const },
    { content: '补测试', status: 'pending' as const },
  ];
  const changes = {
    additions: 4,
    deletions: 1,
    files: [{ path: 'src/a.ts', ref: { kind: 'session' as const, path: '/w/src/a.ts' }, additions: 4, deletions: 1 }],
  };

  it('没有内容时不出现', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('待办、改动、未保存合在一栏；同时只展开一个列表', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: { ...running, todos, changes }, workspace: { dirtyFiles: 2 } }) });
    const dock = screen.getByTestId('dock');
    expect(screen.getByTestId('status-strip').textContent).toContain('改实现');
    expect(screen.getByTestId('status-strip').textContent).toContain('1/3');
    expect(screen.getByTestId('session-changes').textContent).toContain('1 个文件');
    expect(screen.getByTestId('dirty-strip').textContent).toContain('2 个未保存');
    expect(dock.querySelectorAll('.todo')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('status-strip'));
    expect(dock.querySelectorAll('.todo')).toHaveLength(3);
    fireEvent.click(dock.querySelector('.session-changes__toggle')!);
    expect(dock.querySelectorAll('.todo')).toHaveLength(0);
    expect(dock.querySelectorAll('.session-changes__file')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '全部保存' }));
    expect(posted.at(-1)).toMatchObject({ type: 'saveAll' });
  });

  it('隐藏改动后不再显示，有新的改动时重新出现', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: { ...running, changes } }) });
    fireEvent.click(screen.getByRole('button', { name: /隐藏/u }));
    expect(screen.queryByTestId('dock')).toBeNull();
    host({ type: 'session', payload: { ...running, changes: { ...changes, additions: 9 } } });
    expect(screen.getByTestId('session-changes')).toBeTruthy();
  });
});
