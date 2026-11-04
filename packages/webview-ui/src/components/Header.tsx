/** 一行顶栏：会话标题（点击切换会话）、新建、更多菜单。 */
import { useCallback, useMemo, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ChevronDownIcon, MoreIcon, PlusIcon, SearchIcon } from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';

export function Header() {
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const [menu, setMenu] = useState<'sessions' | 'more' | undefined>();
  const [query, setQuery] = useState('');
  const close = useCallback(() => setMenu(undefined), []);

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
          {session.running ? <span className="dot dot--running" aria-label="运行中" /> : null}
          <span className="header__title-text">{session.title}</span>
          <ChevronDownIcon />
        </button>
        <Popover open={menu === 'sessions'} onClose={close} className="sessions-menu" label="切换会话">
          <div className="sessions-menu__search">
            <SearchIcon />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
          </div>
          <div role="menu" className="sessions-menu__list">
            {filtered.length === 0 ? <div className="menu-empty">{sessions.length === 0 ? '这个工作区还没有会话' : '没有匹配的会话'}</div> : null}
            {filtered.map((s) => (
              <MenuItem
                key={s.id}
                active={s.id === session.id}
                hint={s.running ? <span className="dot dot--running" /> : relativeTime(s.updatedAt)}
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
      <button type="button" className="icon-button" aria-label="新对话" title="新对话" onClick={() => postToHost({ type: 'newSession', payload: {} })}>
        <PlusIcon />
      </button>
      <div className="header__more">
        <button type="button" className="icon-button" aria-label="更多" title="更多" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? undefined : 'more')}>
          <MoreIcon />
        </button>
        <Popover open={menu === 'more'} onClose={close} className="more-menu" label="更多操作">
          <div role="menu">
            <MenuItem onSelect={() => (close(), postToHost({ type: 'openWebUI', payload: {} }))}>在浏览器中打开 dsh</MenuItem>
            <MenuItem onSelect={() => (close(), postToHost({ type: 'restartRuntime', payload: {} }))}>重启 dsh</MenuItem>
            <MenuItem onSelect={() => (close(), postToHost({ type: 'showLogs', payload: {} }))}>查看日志</MenuItem>
          </div>
        </Popover>
      </div>
    </header>
  );
}

function relativeTime(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(time).toLocaleDateString();
}
