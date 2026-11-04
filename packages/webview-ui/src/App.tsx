import { useEffect } from 'react';
import type { HostToWebview } from '@dsh-copilot/shared';
import { applyHostMessage, useView } from './store.ts';
import { postToHost } from './vscode.ts';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { RuntimeBanner } from './components/RuntimeBanner.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';

export function App() {
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => applyHostMessage(event.data);
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready', payload: {} });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const runtime = useView((s) => s.runtime);
  const connection = useView((s) => s.connection);
  const empty = useView((s) => s.items.length === 0 && s.interactions.length === 0 && !s.session.running && !s.session.hasOlder);
  const failure = useView((s) => (s.session.sync === 'failed' ? s.session.failure : undefined));

  return (
    <div className="app">
      <Header />
      <RuntimeBanner status={runtime} connection={connection} />
      {failure ? <div className="banner banner--warn banner--inline">无法打开这个会话：{failure}</div> : null}
      {empty ? <EmptyState /> : <Thread />}
      <Toasts />
      <Composer />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty__title">有什么可以帮你？</p>
      <p className="empty__hint">描述一个任务，dsh 会阅读代码、修改文件、运行命令，需要你确认时会先询问。</p>
    </div>
  );
}
