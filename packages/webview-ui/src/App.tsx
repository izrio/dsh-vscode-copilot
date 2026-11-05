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
  const needsApiKey = useView((s) => s.models.needsApiKey === true && s.connection === 'connected');
  if (needsApiKey) {
    return (
      <div className="empty" data-testid="api-key-setup">
        <p className="empty__title">先配置 DeepSeek API Key</p>
        <p className="empty__hint">dsh 需要 API Key 才能调用模型。Key 保存在 dsh 的凭据存储里，与 dsh Web UI、桌面版共用，不会写进工作区。</p>
        <div className="empty__actions">
          <button type="button" className="button" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
            配置 API Key
          </button>
          <button type="button" className="button button--secondary" onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://platform.deepseek.com/api_keys' } })}>
            获取 API Key
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <p className="empty__title">有什么可以帮你？</p>
      <p className="empty__hint">描述一个任务，dsh 会阅读代码、修改文件、运行命令，需要你确认时会先询问。@ 引用文件，/ 使用命令。</p>
    </div>
  );
}
