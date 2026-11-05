// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { PendingInteraction } from '@dsh-copilot/shared';

const posted: unknown[] = [];
let InteractionCard: typeof import('../src/components/Interactions.tsx').InteractionCard;

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  ({ InteractionCard } = await import('../src/components/Interactions.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
  vi.useRealTimers();
});

const card: PendingInteraction = {
  kind: 'question',
  id: 'q1',
  questions: [
    { id: 'a', question: '用哪个包管理器？', multiSelect: false, options: [{ label: 'pnpm' }, { label: 'npm' }] },
    { id: 'b', question: '要哪些检查？', multiSelect: true, options: [{ label: 'lint' }, { label: 'test' }] },
    { id: 'c', question: '分支名？', multiSelect: false, options: [] },
  ],
};

describe('提问卡片：逐题回答', () => {
  it('一次只显示一道题，单选后自动进入下一题，最后一题才提交', () => {
    vi.useFakeTimers();
    render(createElement(InteractionCard, { interaction: card }));
    expect(screen.getByTestId('question-step').textContent).toBe('第 1 / 3 题');
    expect(screen.queryByText('要哪些检查？')).toBeNull();
    expect(screen.queryByRole('button', { name: /提交/u })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/u }));
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.getByText('要哪些检查？')).toBeTruthy();

    // 多选不自动前进；没选之前「下一题」不可用
    expect((screen.getByRole('button', { name: /下一题/u }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/u }));
    fireEvent.click(screen.getByRole('checkbox', { name: /test/u }));
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.getByTestId('question-step').textContent).toBe('第 2 / 3 题');
    fireEvent.click(screen.getByRole('button', { name: /下一题/u }));

    const submit = screen.getByRole('button', { name: /提交/u }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'feat/x' } });
    fireEvent.click(submit);
    expect(posted).toEqual([
      {
        type: 'answerQuestion',
        payload: {
          id: 'q1',
          answers: [
            { id: 'a', selected: ['pnpm'] },
            { id: 'b', selected: ['lint', 'test'] },
            { id: 'c', selected: [], custom: 'feat/x' },
          ],
        },
      },
    ]);
  });

  it('可以返回上一题修改，也可以点步骤点跳转', () => {
    render(createElement(InteractionCard, { interaction: card }));
    fireEvent.click(screen.getAllByRole('tab')[2]!);
    expect(screen.getByText('分支名？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /上一题/u }));
    expect(screen.getByText('要哪些检查？')).toBeTruthy();
  });

  it('只有一道题时不显示进度，直接提交', () => {
    render(createElement(InteractionCard, { interaction: { ...card, questions: [card.questions[0]!] } as PendingInteraction }));
    expect(screen.queryByTestId('question-step')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^npm$/u }));
    fireEvent.click(screen.getByRole('button', { name: /提交/u }));
    expect(posted).toEqual([{ type: 'answerQuestion', payload: { id: 'q1', answers: [{ id: 'a', selected: ['npm'] }] } }]);
  });
});
