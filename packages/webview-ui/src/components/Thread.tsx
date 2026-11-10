/**
 * 对话流：贴底滚动（用户停在底部时跟随新内容，往上翻时不打扰，并显示"回到最新"）、加载更早的历史、"思考中"提示。
 *
 * 读屏：对话流本身不是 live region（流式输出会逐字播报），只在回复结束、需要用户处理时播报一句。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { InteractionCard } from './Interactions.tsx';
import { ItemView } from './Items.tsx';
import { ArrowDownIcon, ArrowUpIcon, SpinnerIcon } from './icons.tsx';
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
  /** 不在底部时显示"回到最新"；有新内容到达时带一个提示点。 */
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);

  // 切换会话时回到底部
  useLayoutEffect(() => {
    stick.current = true;
    setAway(false);
    setUnseen(false);
  }, [sessionKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // 末尾有了新内容（新条目、流式输出、新的审批）而用户不在底部：提示点。加载更早的历史不算
  const tail = items.at(-1);
  useEffect(() => {
    if (!stick.current) setUnseen(true);
  }, [tail, interactions.length]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
      stick.current = atBottom;
      setAway(!atBottom);
      if (atBottom) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setUnseen(false);
  };

  // 排队的消息排在末尾，不算"最后一项"
  const lastShown = [...items].reverse().find((item) => !(item.kind === 'user' && item.pending === 'queued'));
  const streaming = items.some((item) => item.kind === 'assistant' && item.streaming);
  const showThinking = session.running && interactions.length === 0 && !streaming && lastShown?.kind !== 'activity' && lastShown?.kind !== 'explore';

  return (
    <div className="thread-wrap">
      <div className="thread" ref={scroller} role="log" aria-busy={session.running} tabIndex={-1}>
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
      {away ? (
        <button type="button" className="jump-to-bottom" onClick={jumpToBottom} data-testid="jump-to-bottom">
          {unseen ? <span className="jump-to-bottom__dot" aria-hidden /> : null}
          <ArrowDownIcon />
          {t('thread.jumpToBottom')}
        </button>
      ) : null}
      <Announcer />
    </div>
  );
}

/** 读屏播报：回复结束、出现审批或提问时说一句。 */
function Announcer() {
  const t = useT();
  const running = useView((s) => s.session.running);
  const interaction = useView((s) => s.interactions[0]);
  const [message, setMessage] = useState('');
  const wasRunning = useRef(running);
  const lastInteraction = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (wasRunning.current && !running) setMessage(t('announce.done'));
    wasRunning.current = running;
  }, [running, t]);

  useEffect(() => {
    if (!interaction || interaction.id === lastInteraction.current) return;
    lastInteraction.current = interaction.id;
    const label = interaction.kind === 'approval' ? t('approval.label') : t('question.label');
    setMessage(t('announce.attention', label));
  }, [interaction, t]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
