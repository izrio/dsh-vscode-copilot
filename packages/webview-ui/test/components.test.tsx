// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState as useStateHook } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostSnapshot } from '@dsh-copilot/shared';
import { hostMessages, resetHost } from './setup.ts';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { Composer } from '../src/components/Composer.tsx';
import { MenuItem, Popover } from '../src/components/Popover.tsx';
import { RuntimeBanner } from '../src/components/RuntimeBanner.tsx';

const snapshot: HostSnapshot = {
  runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
  connection: 'connected',
  sessions: [],
  session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
  items: [],
  models: { options: [] },
  interactions: [],
  permissions: { options: [] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  commands: [],
  locale: 'zh',
};

const flushFrames = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  resetStoreForTests();
  resetHost();
  applyHostMessage({ type: 'snapshot', payload: snapshot });
});
afterEach(cleanup);

describe('Composer', () => {
  const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(input(), { target: { value: text, selectionStart: text.length } });

  it('Enter 发送并清空；没发出去时文字放回来，不覆盖之后输入的内容', async () => {
    render(<Composer />);
    type('第一条');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(hostMessages.at(-1)).toMatchObject({ type: 'sendMessage', payload: { text: '第一条' } });
    expect(input().value).toBe('');
    type('新输入的');
    act(() => applyHostMessage({ type: 'restoreDraft', payload: { text: '第一条' } }));
    await flushFrames();
    expect(input().value).toBe('第一条\n\n新输入的');
  });

  it('输入框为空时 ↑ / ↓ 浏览发送过的消息', async () => {
    render(<Composer />);
    for (const text of ['一', '二']) {
      type(text);
      fireEvent.keyDown(input(), { key: 'Enter' });
    }
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('二');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('一');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().value).toBe('二');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().value).toBe('');
    // 有内容时 ↑ 不取历史
    type('正在写');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().value).toBe('正在写');
  });

  it('dsh 不可用时占位文字指向上方的提示', () => {
    act(() => applyHostMessage({ type: 'runtimeStatus', payload: { kind: 'notInstalled' } }));
    act(() => applyHostMessage({ type: 'connection', payload: 'idle' }));
    render(<Composer />);
    expect(input().placeholder).toBe('dsh 不可用，见上方提示');
  });
});

describe('Popover', () => {
  it('↑↓ 在菜单项之间移动，Esc 关闭后焦点回到打开它的按钮', async () => {
    function Harness() {
      const [open, setOpen] = useStateHook(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            打开
          </button>
          <Popover open={open} onClose={() => setOpen(false)} label="菜单">
            <MenuItem onSelect={() => undefined}>甲</MenuItem>
            <MenuItem onSelect={() => undefined} active>
              乙
            </MenuItem>
            <MenuItem onSelect={() => undefined}>丙</MenuItem>
          </Popover>
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus();
    fireEvent.click(trigger);
    // 打开时聚焦当前选中的那一项
    expect(document.activeElement?.textContent).toBe('乙');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('丙');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('甲');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('丙');
    fireEvent.keyDown(document, { key: 'Escape' });
    await flushFrames();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('RuntimeBanner', () => {
  it('找不到 dsh 时给出重试、设置路径、安装说明', () => {
    render(<RuntimeBanner status={{ kind: 'notInstalled' }} connection="idle" />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['重试', '设置路径', '安装说明']);
    fireEvent.click(screen.getByRole('button', { name: '设置路径' }));
    expect(hostMessages.at(-1)).toEqual({ type: 'openSettings', payload: { query: 'dsh.runtime.path' } });
  });

  it('"版本较新"可以关掉，同一个版本不再显示', () => {
    const status = { kind: 'connected', version: '0.3.0', newerThanTested: true } as const;
    const { unmount } = render(<RuntimeBanner status={status} connection="connected" />);
    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
    unmount();
    render(<RuntimeBanner status={status} connection="connected" />);
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
  });
});
