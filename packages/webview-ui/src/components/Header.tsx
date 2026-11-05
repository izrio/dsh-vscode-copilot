/** 一行顶栏：会话标题（点击切换会话）、新建、更多菜单。 */
import { useCallback, useMemo, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ChevronDownIcon, MoreIcon, PlusIcon, SearchIcon } from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';
import { useT, type Translate } from '../i18n.ts';

export function Header() {
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const [menu, setMenu] = useState<'sessions' | 'more' | undefined>();
  const [query, setQuery] = useState('');
  const close = useCallback(() => setMenu(undefined), []);
  const t = useT();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  return (
    <header className="header">
      <div className="header__title-wrap">
        <button
          type="button"
          className="header__title"
          aria-haspopup="dialog"
          aria-expanded={menu === 'sessions'}
          onClick={() => {
            setQuery('');
            setMenu(menu === 'sessions' ? undefined : 'sessions');
          }}
          title={session.title}
        >
          {session.running ? <span className="dot dot--running" aria-label={t('header.running')} /> : null}
          <span className="header__title-text">{session.title}</span>
          <ChevronDownIcon />
        </button>
        <Popover open={menu === 'sessions'} onClose={close} className="sessions-menu" label={t('header.sessions')}>
          <div className="sessions-menu__search">
            <SearchIcon />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('header.search')} aria-label={t('header.search')} />
          </div>
          <div role="menu" className="sessions-menu__list">
            {filtered.length === 0 ? <div className="menu-empty">{sessions.length === 0 ? t('header.noSessions') : t('header.noMatch')}</div> : null}
            {filtered.map((s) => (
              <MenuItem
                key={s.id}
                active={s.id === session.id}
                hint={s.running ? <span className="dot dot--running" /> : relativeTime(s.updatedAt, t)}
                onSelect={() => {
                  close();
                  postToHost({ type: 'switchSession', payload: { sessionId: s.id } });
                }}
              >
                {s.title}
              </MenuItem>
            ))}
          </div>
        </Popover>
      </div>
      <button type="button" className="icon-button" aria-label={t('header.new')} title={t('header.new')} onClick={() => postToHost({ type: 'newSession', payload: {} })}>
        <PlusIcon />
      </button>
      <div className="header__more">
        <button type="button" className="icon-button" aria-label={t('header.more')} title={t('header.more')} aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? undefined : 'more')}>
          <MoreIcon />
        </button>
        <Popover open={menu === 'more'} onClose={close} className="more-menu" label={t('header.moreActions')}>
          <div role="menu">
            {session.id ? <MenuItem onSelect={() => (close(), postToHost({ type: 'renameSession', payload: {} }))}>{t('header.rename')}</MenuItem> : null}
            {session.folder ? (
              <MenuItem hint={session.folder} onSelect={() => (close(), postToHost({ type: 'selectFolder', payload: {} }))}>
                {t('header.folder')}
              </MenuItem>
            ) : null}
            <MenuItem onSelect={() => (close(), postToHost({ type: 'configureApiKey', payload: {} }))}>{t('apiKey.configure')}</MenuItem>
            <MenuItem onSelect={() => (close(), postToHost({ type: 'openWebUI', payload: {} }))}>{t('header.openWebUI')}</MenuItem>
            <MenuItem onSelect={() => (close(), postToHost({ type: 'restartRuntime', payload: {} }))}>{t('header.restart')}</MenuItem>
            <MenuItem onSelect={() => (close(), postToHost({ type: 'showLogs', payload: {} }))}>{t('header.logs')}</MenuItem>
          </div>
        </Popover>
      </div>
    </header>
  );
}

function relativeTime(time: number, t: Translate): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hours', hours);
  const days = Math.round(hours / 24);
  return days < 30 ? t('time.days', days) : new Date(time).toLocaleDateString();
}
