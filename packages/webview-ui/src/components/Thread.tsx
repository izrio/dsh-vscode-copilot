/**
 * 对话流：贴底滚动（用户停在底部时跟随新内容，往上翻时不打扰）、加载更早的历史、"思考中"提示。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ItemView } from './Items.tsx';

const STICK_THRESHOLD = 48;

export function Thread() {
  const items = useView((s) => s.items);
  const session = useView((s) => s.session);
  const sessionKey = useView((s) => s.sessionKey);
  const scroller = useRef<HTMLDivElement>(null);
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

  const last = items.at(-1);
  const showThinking = session.running && !(last?.kind === 'assistant' && last.streaming) && last?.kind !== 'activity';

  return (
    <div className="thread" ref={scroller} role="log" aria-live="polite" aria-busy={session.running}>
      {session.hasOlder ? (
        <div className="thread__older">
          <button type="button" className="link-button" disabled={session.loadingOlder} onClick={() => postToHost({ type: 'loadOlder', payload: {} })}>
            {session.loadingOlder ? '正在加载…' : '加载更早的消息'}
          </button>
        </div>
      ) : null}
      {items.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
      {showThinking ? (
        <div className="thinking" aria-label="dsh 正在处理">
          <span className="shimmer">思考中…</span>
        </div>
      ) : null}
    </div>
  );
}
