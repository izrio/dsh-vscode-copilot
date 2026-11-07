/**
 * 运行状态：dsh 处理这一轮时显示在对话流末尾——在做什么（思考 / 回复 / 执行工具 / 等你确认）和已经用了多久，每秒刷新。
 * 一轮结束后由 `turnDone` 条目显示总用时。
 */
import { useEffect, useState } from 'react';
import type { Item } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { CheckIcon, SpinnerIcon } from './icons.tsx';
import { useT, type Translate } from '../i18n.ts';

/** 「12 秒」「1 分 23 秒」「1 小时 2 分」。 */
export function formatDuration(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('duration.seconds', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('duration.minutes', minutes, seconds % 60);
  return t('duration.hours', Math.floor(minutes / 60), minutes % 60);
}

/** 正在做的事：看最后一个条目。 */
function activityOf(items: readonly Item[], waiting: boolean, t: Translate): string {
  if (waiting) return t('run.waiting');
  const last = [...items].reverse().find((item) => !(item.kind === 'user' && item.pending === 'queued'));
  if (last?.kind === 'assistant' && last.streaming) return last.markdown ? t('run.replying') : t('run.thinking');
  if (last?.kind === 'activity' && last.status === 'running') {
    if (last.variant === 'command') return t('run.command');
    if (last.variant === 'edit') return t('run.editing', last.label);
    return t('run.tool', last.label.split('  ', 1)[0] ?? last.tool);
  }
  if (last?.kind === 'explore' && last.status === 'running') return t('run.exploring');
  return t('run.thinking');
}

export function RunStatus() {
  const running = useView((s) => s.session.running);
  const since = useView((s) => s.session.runningSince);
  const sessionKey = useView((s) => s.sessionKey);
  const items = useView((s) => s.items);
  const waiting = useView((s) => s.interactions.length > 0);
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  /** dsh 没给开始时间（例如还没收到 turn/start）时，从这里看到运行开始计时。 */
  const [seenAt, setSeenAt] = useState<number | undefined>();

  useEffect(() => {
    if (!running) {
      setSeenAt(undefined);
      return;
    }
    setSeenAt((value) => value ?? Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, sessionKey]);

  if (!running) return null;
  const start = since ?? seenAt ?? now;
  return (
    <div className={`run-status ${waiting ? 'run-status--waiting' : ''}`} role="status" aria-label={t('thread.busy')} data-testid="run-status">
      <span className="run-status__icon">{waiting ? <span className="dot dot--attention" /> : <SpinnerIcon />}</span>
      <span className="run-status__label shimmer">{activityOf(items, waiting, t)}</span>
      <span className="run-status__time">{formatDuration(now - start, t)}</span>
    </div>
  );
}

/** 一轮结束时的用时。 */
export function TurnDone({ item }: { item: Extract<Item, { kind: 'turnDone' }> }) {
  const t = useT();
  return (
    <div className="turn-done" data-testid="turn-done">
      {item.completed ? <CheckIcon /> : null}
      <span>{item.completed ? t('run.done', formatDuration(item.durationMs, t)) : t('run.took', formatDuration(item.durationMs, t))}</span>
    </div>
  );
}
