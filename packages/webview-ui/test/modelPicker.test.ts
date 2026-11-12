// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostToWebview } from '@harness-deck/shared';

const posted: unknown[] = [];
let ModelPicker: typeof import('../src/components/ModelPicker.tsx').ModelPicker;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../src/store.ts');
  ({ ModelPicker } = await import('../src/components/ModelPicker.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
});

const efforts = ['off', 'low', 'medium', 'high'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));

function setModels() {
  store.applyHostMessage({ type: 'connection', payload: 'connected' } as HostToWebview);
  store.applyHostMessage({
    type: 'models',
    payload: {
      options: [
        { provider: 'p', model: 'flash', name: 'V4.1-Flash', group: 'custom', efforts, defaultEffort: 'high' },
        { provider: 'p', model: 'old', name: 'V4-Flash-0731', group: 'custom', efforts: [] },
      ],
      current: { provider: 'p', model: 'flash', reasoningEffort: 'medium' },
    },
  } as HostToWebview);
}

describe('模型选择', () => {
  it('第一级每个模型一行，当前模型带勾并显示当前思考等级', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));
    const items = document.querySelectorAll('.model-menu .model-item');
    expect([...items].map((el) => el.querySelector('.menu-item__label')?.textContent)).toEqual(['V4.1-Flash', 'V4-Flash-0731']);
    const active = document.querySelector('.model-menu .menu-item--active');
    expect(active?.textContent).toContain('V4.1-Flash');
    expect(active?.querySelector('.model-item__check svg')).not.toBeNull();
    expect(active?.querySelector('.menu-item__hint')?.textContent).toBe('Medium');
  });

  it('点有多个思考等级的模型进入第二级，选中后发送模型和思考等级', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByText('V4.1-Flash'));
    expect(posted).toEqual([]);
    const level = screen.getByTestId('effort-menu');
    expect([...level.querySelectorAll('.model-item .menu-item__label')].map((el) => el.textContent)).toEqual(['Off', 'Low', 'Medium', 'High']);
    expect(level.querySelector('.menu-item--active')?.textContent).toContain('Medium');
    fireEvent.click(screen.getByText('High'));
    expect(posted).toEqual([{ type: 'selectModel', payload: { provider: 'p', model: 'flash', reasoningEffort: 'high' } }]);
  });

  it('只有一种思考等级的模型点一下就选中', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByText('V4-Flash-0731'));
    expect(posted).toEqual([{ type: 'selectModel', payload: { provider: 'p', model: 'old' } }]);
  });
});
