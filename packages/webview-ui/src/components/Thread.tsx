/**
 * 对话流：贴底滚动（用户停在底部时跟随新内容，往上翻时不打扰）、加载更早的历史、"思考中"提示。
 * 往上翻了一段之后右下角出现「滚动到底部」按钮；翻上去时又来了新内容，按钮上有提示点。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { InteractionCard } from './Interactions.tsx';
import { ItemView } from './Items.tsx';
import { RunStatus } from './RunStatus.tsx';
import { ArrowDownIcon, ArrowUpIcon, SpinnerIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

/**
 * 给读屏的播报：只在状态变化时说一句（开始回复、回复完了、在等你处理），不逐字念流式输出的内容。
 */
function Announcer({ running, waiting }: { running: boolean; waiting: boolean }) {
  const t = useT();
  const previous = useRef({ running, waiting });
  const [message, setMessage] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = { running, waiting };
    if (waiting && !before.waiting) setMessage(t('a11y.needsYou'));
    else if (running && !before.running) setMessage(t('a11y.replyStarted'));
    else if (!running && before.running) setMessage(t('a11y.replyDone'));
  }, [running, waiting]);
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="announcer">
      {message}
    </div>
  );
}

const STICK_THRESHOLD = 48;
/** 离底部超过这个距离才显示「滚动到底部」按钮（刚往上滚一点时不打扰）。 */
const BUTTON_THRESHOLD = 240;

export function Thread() {
  const items = useView((s) => s.items);
  const interactions = useView((s) => s.interactions);
  const session = useView((s) => s.session);
  const sessionKey = useView((s) => s.sessionKey);
  const scroller = useRef<HTMLDivElement>(null);
  const t = useT();
  const stick = useRef(true);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);

  // 切换会话时回到底部
  useLayoutEffect(() => {
    stick.current = true;
    setFarFromBottom(false);
    setUnseen(false);
  }, [sessionKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  // 翻上去的时候有新内容（多了条目、最后一条换了、多了审批或提问）：按钮上显示提示点。
  // 只看这几样：同一批条目重新下发、加载更早的消息都不算新内容
  const lastId = items.at(-1)?.id;
  const seen = useRef({ lastId, interactions: interactions.length });
  useEffect(() => {
    const before = seen.current;
    seen.current = { lastId, interactions: interactions.length };
    if (!stick.current && (lastId !== before.lastId || interactions.length > before.interactions)) setUnseen(true);
  }, [lastId, interactions.length]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = distance < STICK_THRESHOLD;
      setFarFromBottom(distance > BUTTON_THRESHOLD);
      if (stick.current) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };


  return (
    <div className="thread-wrap">
    {/* 不做成 live region：流式输出时每来一段文字读屏都会播报。状态变化由下面的 Announcer 单独播报 */}
    <div className="thread" ref={scroller} role="region" aria-label={t('thread.label')} aria-busy={session.running} tabIndex={-1}>
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
      <RunStatus />
    </div>
      <Announcer running={session.running} waiting={interactions.length > 0} />
      {farFromBottom ? (
        <button type="button" className={`to-bottom ${unseen ? 'to-bottom--unseen' : ''}`} title={t('thread.toBottom')} aria-label={t('thread.toBottom')} data-testid="to-bottom" onClick={toBottom}>
          <ArrowDownIcon />
          {unseen ? <span className="to-bottom__dot" aria-label={t('thread.newContent')} /> : null}
        </button>
      ) : null}
    </div>
  );
}
