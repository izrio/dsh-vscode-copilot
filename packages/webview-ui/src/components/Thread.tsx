/**
 * 对话流：贴底滚动（用户停在底部时跟随新内容，往上翻时不打扰）、加载更早的历史、"思考中"提示。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { InteractionCard } from './Interactions.tsx';
import { ItemView } from './Items.tsx';
import { ArrowUpIcon, SpinnerIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

const STICK_THRESHOLD = 48;

export function Thread() {
  const items = useView((s) => s.items);
  const interactions = useView((s) => s.interactions);
  const session = useView((s) => s.session);
  const sessionKey = useView((s) => s.sessionKey);
  const scroller = useRef<HTMLDivElement>(null);
  const t = useT();
  const stick = useRef(true);

  // 切换会话时回到底部
  useLayoutEffect(() => {
    stick.current = true;
  }, [sessionKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 排队的消息排在末尾，不算"最后一项"
  const lastShown = [...items].reverse().find((item) => !(item.kind === 'user' && item.pending === 'queued'));
  const streaming = items.some((item) => item.kind === 'assistant' && item.streaming);
  const showThinking = session.running && interactions.length === 0 && !streaming && lastShown?.kind !== 'activity' && lastShown?.kind !== 'explore';

  return (
    <div className="thread" ref={scroller} role="log" aria-live="polite" aria-busy={session.running}>
      {session.sync === 'disconnected' ? (
        <div className="thread__sync" role="status">
          <SpinnerIcon />
          <span>{t('thread.reconnecting')}</span>
        </div>
      ) : null}
      {session.hasOlder ? (
        <div className="thread__older">
          <button type="button" className="link-button" disabled={session.loadingOlder} onClick={() => postToHost({ type: 'loadOlder', payload: {} })}>
            {session.loadingOlder ? <SpinnerIcon /> : <ArrowUpIcon />}
            {session.loadingOlder ? t('thread.loading') : t('thread.older')}
          </button>
        </div>
      ) : null}
      {items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
      {interactions.map((interaction) => (
        <InteractionCard key={interaction.id} interaction={interaction} />
      ))}
      {showThinking ? (
        <div className="thinking" aria-label={t('thread.busy')}>
          <SpinnerIcon />
          <span className="shimmer">{t('thread.thinking')}</span>
        </div>
      ) : null}
    </div>
  );
}
