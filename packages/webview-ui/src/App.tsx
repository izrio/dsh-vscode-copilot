import { useEffect } from 'react';
import type { HostToWebview } from '@dsh-copilot/shared';
import { applyHostMessage, useView } from './store.ts';
import { postToHost } from './vscode.ts';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { RuntimeBanner } from './components/RuntimeBanner.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
import { useT } from './i18n.ts';

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
  const t = useT();

  return (
    <div className="app">
      <Header />
      <RuntimeBanner status={runtime} connection={connection} />
      {failure ? <div className="banner banner--warn banner--inline">{t('session.failed', failure)}</div> : null}
      {empty ? <EmptyState /> : <Thread />}
      <Toasts />
      <Composer />
    </div>
  );
}

function EmptyState() {
  const t = useT();
  const needsApiKey = useView((s) => s.models.needsApiKey === true && s.connection === 'connected');
  if (needsApiKey) {
    return (
      <div className="empty" data-testid="api-key-setup">
        <p className="empty__title">{t('apiKey.title')}</p>
        <p className="empty__hint">{t('apiKey.hint')}</p>
        <div className="empty__actions">
          <button type="button" className="button" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
            {t('apiKey.configure')}
          </button>
          <button type="button" className="button button--secondary" onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://platform.deepseek.com/api_keys' } })}>
            {t('apiKey.get')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <p className="empty__title">{t('empty.title')}</p>
      <p className="empty__hint">{t('empty.hint')}</p>
    </div>
  );
}
