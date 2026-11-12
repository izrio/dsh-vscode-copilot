/**
 * 输入框上方的状态栏：待办（`todo_write` / ACP 的 plan）、本会话的改动、未保存的文件合在一行里，各占一段；
 * 长任务目标（`/goal`）在上面单独一行。只在有内容时出现。
 *
 * 点「待办」或「改动」那一段，在这一行上方展开列表（同时只展开一个）；改动可以隐藏，之后又有新的改动时重新出现。
 * 合成一行是为了不挤占对话区：三样各占一张卡片时，窄的侧边栏里底部能占掉四成高度（docs/DESIGN.md 3.1）。
 */
import { useState } from 'react';
import { useView } from '../store.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { ChangedFileButton, Stats } from './Items.tsx';
import { CheckIcon, ChecklistIcon, ChevronRightIcon, CloseIcon, DiffIcon, SaveIcon, SpinnerIcon, TargetIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

type Panel = 'todos' | 'changes';

export function StatusDock() {
  const todos = useView((s) => s.session.todos);
  const goal = useView((s) => s.session.goal);
  const running = useView((s) => s.session.running);
  const changes = useView((s) => s.session.changes);
  const sessionKey = useView((s) => s.sessionKey);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const [open, setOpen] = useState<Panel | undefined>(() => loadState().dockOpen ?? (loadState().changesOpen ? 'changes' : undefined));
  const [dismissed, setDismissed] = useState(() => loadState().changesDismissed);
  const t = useT();

  // 文件数或行数变化（有了新的改动）时，隐藏的改动重新出现
  const signature = changes?.files.length ? `${sessionKey}|${changes.files.length}|${changes.additions}|${changes.deletions}` : undefined;
  const shownChanges = changes && signature && dismissed !== signature ? changes : undefined;
  const hasTodos = Boolean(todos?.length);
  if (!hasTodos && !goal && !shownChanges && dirtyFiles === 0) return null;

  const toggle = (panel: Panel) => {
    const next = open === panel ? undefined : panel;
    setOpen(next);
    saveState({ dockOpen: next });
  };
  const dismissChanges = () => {
    setDismissed(signature);
    saveState({ changesDismissed: signature });
  };
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const current = todos?.find((todo) => todo.status === 'in_progress') ?? todos?.find((todo) => todo.status === 'pending');
  const panel = open === 'todos' && hasTodos ? 'todos' : open === 'changes' && shownChanges ? 'changes' : undefined;

  return (
    <section className="dock" aria-label={t('dock.label')} data-testid="dock">
      {goal ? (
        <div className={`status-strip__goal status-strip__goal--${goal.phase}`} title={goal.blockedReason ?? goal.objective}>
          <TargetIcon />
          <span className="status-strip__label">{t('goal.label')}</span>
          <span className="status-strip__text">{goal.objective}</span>
          <span className="status-strip__meta">
            {goal.maxRounds ? t('goal.round', goal.round, goal.maxRounds) : ''}
            {t(`goal.${goal.phase}`)}
          </span>
        </div>
      ) : null}
      {panel === 'todos' && todos ? (
        <ol className="todo-list dock__panel" id="dock-panel">
          {todos.map((todo, index) => (
            <li key={index} className={`todo todo--${todo.status}`}>
              <span className="todo__mark" aria-label={todo.status === 'completed' ? t('todo.completed') : todo.status === 'in_progress' ? t('todo.inProgress') : t('todo.pending')}>
                {todo.status === 'completed' ? <CheckIcon /> : todo.status === 'in_progress' && running ? <SpinnerIcon /> : <span className="todo__dot" />}
              </span>
              <span className="todo__text">{todo.content}</span>
              {todo.status === 'in_progress' ? <span className="todo__badge">{t('todo.inProgress')}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {panel === 'changes' && shownChanges ? (
        <ul className="session-changes__list dock__panel" id="dock-panel" aria-label={t('sessionChanges.label')}>
          {shownChanges.files.map((file) => (
            <li key={file.path}>
              <ChangedFileButton file={file} className="session-changes__file" />
            </li>
          ))}
        </ul>
      ) : null}
      {hasTodos || shownChanges || dirtyFiles > 0 ? (
        <div className="dock__bar">
          {todos?.length ? (
            <button
              type="button"
              className="dock__seg dock__seg--todos todo-card__header"
              aria-expanded={panel === 'todos'}
              {...(panel === 'todos' ? { 'aria-controls': 'dock-panel' } : {})}
              onClick={() => toggle('todos')}
              data-testid="status-strip"
            >
              <ChevronRightIcon className={`chevron ${panel === 'todos' ? 'chevron--open' : ''}`} />
              <ChecklistIcon className="todo-card__icon" />
              <span className="status-strip__label">{t('todo.title')}</span>
              {panel !== 'todos' && current ? <span className="dock__seg-text">{current.content}</span> : <span className="dock__spacer" />}
              <span className={`todo-card__count ${done === todos.length ? 'todo-card__count--done' : ''}`}>
                {done}/{todos.length}
              </span>
            </button>
          ) : null}
          {shownChanges ? (
            <span className="dock__group" data-testid="session-changes">
              <button
                type="button"
                className="dock__seg session-changes__toggle"
                aria-expanded={panel === 'changes'}
                {...(panel === 'changes' ? { 'aria-controls': 'dock-panel' } : {})}
                onClick={() => toggle('changes')}
                title={panel === 'changes' ? t('sessionChanges.collapse') : t('sessionChanges.expand')}
              >
                <ChevronRightIcon className={`chevron ${panel === 'changes' ? 'chevron--open' : ''}`} />
                <DiffIcon />
                <span className="dock__seg-label">{t('dock.changes', shownChanges.files.length)}</span>
                <Stats stats={shownChanges} />
              </button>
              <button type="button" className="icon-button icon-button--small" onClick={dismissChanges} aria-label={t('sessionChanges.hide')} title={t('sessionChanges.hide')}>
                <CloseIcon />
              </button>
            </span>
          ) : null}
          {dirtyFiles > 0 ? (
            <span className="dock__group dock__group--dirty" title={t('dock.dirtyTitle', dirtyFiles)} data-testid="dirty-strip">
              <SaveIcon className="dirty-strip__icon" />
              <span className="dock__seg-label">{t('dock.dirty', dirtyFiles)}</span>
              <span className="sr-only">{t('dock.dirtyTitle', dirtyFiles)}</span>
              <button type="button" className="link-button" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
                {t('dirty.saveAll')}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {todos?.length ? (
        <div className="todo-progress" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done} aria-label={t('todo.label', done, todos.length)}>
          <span className="todo-progress__bar" style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
      ) : null}
    </section>
  );
}
