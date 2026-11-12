// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostToWebview } from '@harness-deck/shared';

const posted: unknown[] = [];
let AppearancePanel: typeof import('../src/components/AppearancePanel.tsx').AppearancePanel;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../src/store.ts');
  ({ AppearancePanel } = await import('../src/components/AppearancePanel.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
});

describe('字体与字号面板', () => {
  it('加减字号：本地立即生效，并写入设置', () => {
    store.applyHostMessage({ type: 'appearance', payload: { fontSize: 15 } } as HostToWebview);
    render(createElement(AppearancePanel, { onClose: () => undefined }));
    expect(screen.getByTestId('appearance-size').textContent).toBe('15px');
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }));
    expect(store.getState().appearance.fontSize).toBe(16);
    expect(posted).toEqual([{ type: 'setAppearance', payload: { fontSize: 16 } }]);
  });

  it('字体输入后回车保存；恢复默认清空所有设置', () => {
    store.applyHostMessage({ type: 'appearance', payload: { fontSize: 15 } } as HostToWebview);
    render(createElement(AppearancePanel, { onClose: () => undefined }));
    const input = screen.getByPlaceholderText('跟随 VS Code');
    fireEvent.change(input, { target: { value: 'Microsoft YaHei UI' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted.at(-1)).toEqual({ type: 'setAppearance', payload: { fontFamily: 'Microsoft YaHei UI' } });
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(posted.at(-1)).toEqual({ type: 'setAppearance', payload: { fontSize: null, fontFamily: null, codeFontFamily: null, palette: null } });
    expect(store.getState().appearance).toEqual({});
  });
});
