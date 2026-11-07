import { useEffect, useState } from 'react';
import type { HostToWebview } from '@dsh-copilot/shared';
import { applyHostMessage, requestPrefill, useView } from './store.ts';
import { postToHost } from './vscode.ts';
import { BackendChooser } from './components/BackendChooser.tsx';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { RuntimeBanner } from './components/RuntimeBanner.tsx';
import { TabBar } from './components/TabBar.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
import { BeakerIcon, BookIcon, BugIcon, ChevronDownIcon, DiffIcon, FolderIcon, GlobeIcon, KeyIcon, SparkleIcon, SpinnerIcon } from './components/icons.tsx';
import type { MessageKey } from './i18n.ts';
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
  // 打开已有会话、follow 还没拿到快照：显示加载中，而不是"新对话"的空状态
  const opening = useView((s) => s.session.id !== undefined && s.items.length === 0 && s.session.sync === 'opening');
  const t = useT();
  const appearance = useView((s) => s.appearance);
  // 第一次使用：先选底层（选择卡片占满对话区；运行时横幅这时只会干扰）
  const needsChoice = useView((s) => s.backends.needsChoice === true && s.backends.items.length > 1);

  // 字号和字体通过 CSS 变量生效；不设置时样式表里跟随 VS Code（字号大 1px）
  useEffect(() => {
    const style = document.documentElement.style;
    const apply = (name: string, value: string | undefined) => (value ? style.setProperty(name, value) : style.removeProperty(name));
    apply('--dsh-font-size', appearance.fontSize ? `${appearance.fontSize}px` : undefined);
    apply('--dsh-font-family', appearance.fontFamily);
    apply('--dsh-code-font-family', appearance.codeFontFamily);
  }, [appearance]);

  return (
    <div className="app">
      <Header />
      <TabBar />
      {needsChoice ? null : <RuntimeBanner status={runtime} connection={connection} />}
      {failure ? <div className="banner banner--warn banner--inline">{t('session.failed', failure)}</div> : null}
      {needsChoice ? (
        <div className="empty empty--chooser">
          <BackendChooser welcome />
        </div>
      ) : opening ? (
        <SessionLoading />
      ) : empty ? (
        <EmptyState />
      ) : (
        <Thread />
      )}
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
        <div className="empty__logo empty__logo--key">
          <KeyIcon />
        </div>
        <p className="empty__title">{t('apiKey.title')}</p>
        <p className="empty__hint">{t('apiKey.hint')}</p>
        <div className="empty__actions">
          <button type="button" className="button" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
            <KeyIcon />
            {t('apiKey.configure')}
          </button>
          <button type="button" className="button button--secondary" onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://platform.deepseek.com/api_keys' } })}>
            <GlobeIcon />
            {t('apiKey.get')}
          </button>
        </div>
      </div>
    );
  }
  return <Home />;
}

/** 首页：标识、当前底层和工作区、示例任务、输入提示。点底层标签打开选择卡片。 */
function Home() {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const backends = useView((s) => s.backends);
  const folder = backends.workspace;
  const current = backends.items.find((b) => b.id === backends.active);
  if (choosing) {
    return (
      <div className="empty empty--chooser">
        <BackendChooser welcome={false} onClose={() => setChoosing(false)} />
      </div>
    );
  }
  return (
    <div className="empty home">
      <div className="home__hero">
        <div className="home__logo" aria-hidden="true">
          <SparkleIcon />
        </div>
        <p className="empty__title">{t('empty.title')}</p>
        <p className="empty__hint">{t('empty.hint')}</p>
        <div className="home__context">
          {current && backends.items.length > 1 ? (
            <button type="button" className="home__chip home__chip--backend" data-testid="home-backend" title={t('home.switchBackend')} onClick={() => setChoosing(true)}>
              <span className={`status-dot ${current.available === false ? 'status-dot--missing' : 'status-dot--ok'}`} />
              {current.name}
              <ChevronDownIcon />
            </button>
          ) : null}
          {folder ? (
            <span className="home__chip" title={folder}>
              <FolderIcon />
              {folder}
            </span>
          ) : null}
        </div>
      </div>
      <div className="suggestions" data-testid="suggestions">
        {SUGGESTIONS.map(({ key, icon }) => (
          <button key={key} type="button" className="suggestion" onClick={() => requestPrefill(t(`empty.suggest.${key}Prompt` as MessageKey))}>
            <span className={`suggestion__icon suggestion__icon--${key}`}>{icon}</span>
            <span className="suggestion__text">
              <span className="suggestion__title">{t(`empty.suggest.${key}` as MessageKey)}</span>
              <span className="suggestion__desc">{t(`empty.suggest.${key}Desc` as MessageKey)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="home__tips" aria-hidden="true">
        <span>
          <kbd>@</kbd>
          {t('home.tips.mention')}
        </span>
        <span>
          <kbd>/</kbd>
          {t('home.tips.command')}
        </span>
        <span>
          <kbd>⇧</kbd>
          <kbd>↵</kbd>
          {t('home.tips.newline')}
        </span>
      </div>
    </div>
  );
}

/** 空状态的示例任务：点击后放进输入框，可以修改后发送。 */
const SUGGESTIONS = [
  { key: 'project', icon: <BookIcon /> },
  { key: 'bugs', icon: <BugIcon /> },
  { key: 'tests', icon: <BeakerIcon /> },
  { key: 'commit', icon: <DiffIcon /> },
] as const;

/** 打开会话时的骨架屏。 */
function SessionLoading() {
  const t = useT();
  return (
    <div className="session-loading" role="status" aria-label={t('thread.opening')} data-testid="session-loading">
      <div className="session-loading__label">
        <SpinnerIcon />
        <span>{t('thread.opening')}</span>
      </div>
      <div className="skeleton skeleton--bubble" />
      <div className="skeleton skeleton--line" />
      <div className="skeleton skeleton--line skeleton--short" />
      <div className="skeleton skeleton--bubble" />
      <div className="skeleton skeleton--line" />
    </div>
  );
}
