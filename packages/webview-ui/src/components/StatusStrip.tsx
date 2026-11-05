/**
 * 输入框上方的状态条：dsh 的待办（`todo_write`）和长任务目标（`/goal`）。只在有内容时出现；
 * 待办默认收起成一行（进度 + 正在做的事），点开看全部。
 */
import { useState } from 'react';
import { useView } from '../store.ts';
import { CheckIcon, ChevronRightIcon, SpinnerIcon } from './icons.tsx';
import { useT } from '../i18n.ts';


export function StatusStrip() {
  const todos = useView((s) => s.session.todos);
  const goal = useView((s) => s.session.goal);
  const running = useView((s) => s.session.running);
  const [open, setOpen] = useState(false);
  const t = useT();
  if (!todos?.length && !goal) return null;
  const done = todos?.filter((t) => t.status === 'completed').length ?? 0;
  const current = todos?.find((t) => t.status === 'in_progress') ?? todos?.find((t) => t.status === 'pending');
  return (
    <div className="status-strip" data-testid="status-strip">
      {goal ? (
        <div className={`status-strip__goal status-strip__goal--${goal.phase}`} title={goal.blockedReason ?? goal.objective}>
          <span className="status-strip__label">{t('goal.label')}</span>
          <span className="status-strip__text">{goal.objective}</span>
          <span className="status-strip__meta">
            {goal.maxRounds ? t('goal.round', goal.round, goal.maxRounds) : ''}
            {t(`goal.${goal.phase}`)}
          </span>
        </div>
      ) : null}
      {todos?.length ? (
        <>
          <button type="button" className="status-strip__todos" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronRightIcon className={`chevron ${open ? 'chevron--open' : ''}`} />
            <span className="status-strip__label">{t('todo.label', done, todos.length)}</span>
            {!open && current ? <span className="status-strip__text">{current.content}</span> : null}
          </button>
          {open ? (
            <ul className="todo-list">
              {todos.map((todo, index) => (
                <li key={index} className={`todo todo--${todo.status}`}>
                  <span className="todo__mark" aria-label={todo.status === 'completed' ? t('todo.completed') : todo.status === 'in_progress' ? t('todo.inProgress') : t('todo.pending')}>
                    {todo.status === 'completed' ? <CheckIcon /> : todo.status === 'in_progress' && running ? <SpinnerIcon /> : <span className="todo__dot" />}
                  </span>
                  <span>{todo.content}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
