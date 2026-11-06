/**
 * 子代理：一行显示委派的任务描述、状态和用时（运行中每秒刷新），点开看交给它的任务和它的最终回答，
 * 「查看对话」在标签里打开子代理自己的会话（只读）。
 */
import { useEffect, useState } from 'react';
import type { Item } from '@dsh-copilot/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import { formatDuration } from './RunStatus.tsx';
import { AgentIcon, CheckIcon, ChevronRightIcon, ErrorIcon, SpinnerIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

type Activity = Extract<Item, { kind: 'activity' }>;

export function SubagentRow({ item }: { item: Activity }) {
  const t = useT();
  const sub = item.subagent!;
  const parentId = useView((s) => s.session.id);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = sub.state === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = sub.startedAt !== undefined ? (sub.endedAt ?? (running ? now : undefined)) : undefined;
  const duration = elapsed !== undefined && sub.startedAt !== undefined ? formatDuration(elapsed - sub.startedAt, t) : undefined;
  const status = running ? t('subagent.running') : sub.state === 'failed' ? t('subagent.failed') : t('subagent.done');

  return (
    <div className={`subagent subagent--${sub.state}`} data-testid="subagent">
      <button type="button" className="subagent__row" aria-expanded={open} onClick={() => setOpen(!open)} title={sub.prompt ?? item.label}>
        <span className="subagent__icon">
          <AgentIcon />
        </span>
        <span className="subagent__kind">{t('subagent.label')}</span>
        <span className="subagent__label">{item.label}</span>
        <span className="subagent__status">
          {running ? <SpinnerIcon /> : sub.state === 'failed' ? <ErrorIcon /> : <CheckIcon />}
          <span>{status}</span>
          {duration ? <span className="subagent__time">{duration}</span> : null}
        </span>
        <ChevronRightIcon className={`chevron subagent__chevron ${open ? 'chevron--open' : ''}`} />
      </button>
      {open ? (
        <div className="subagent__body">
          {sub.prompt ? (
            <section className="subagent__section">
              <div className="subagent__heading">{t('subagent.task')}</div>
              <div className="subagent__prompt">{sub.prompt}</div>
            </section>
          ) : null}
          <section className="subagent__section">
            <div className="subagent__heading">{t('subagent.result')}</div>
            {sub.result ? (
              <div className="subagent__result">
                <Markdown text={sub.result} />
              </div>
            ) : (
              <div className="subagent__pending">{running ? t('subagent.waiting') : t('subagent.noResult')}</div>
            )}
          </section>
          {sub.childId ? (
            <button type="button" className="link-button subagent__open" onClick={() => postToHost({ type: 'switchSession', payload: { sessionId: sub.childId!, label: item.label, ...(parentId ? { parentId } : {}) } })}>
              {t('subagent.openChat')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
