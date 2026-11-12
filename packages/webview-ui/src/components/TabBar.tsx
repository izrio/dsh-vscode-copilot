/**
 * 会话标签：顶栏下面一行，只在打开了两个以上的会话时出现。点击切换（后台标签的会话继续运行，切回时内容立即可见），
 * × 或鼠标中键关闭（会话仍在 dsh 里，可以从会话列表重新打开）。运行中显示动画点，等待审批或提问时显示提醒点。
 */
import { useEffect, useRef } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { CloseIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

export function TabBar() {
  const tabs = useView((s) => s.tabs);
  const strip = useRef<HTMLDivElement>(null);
  const t = useT();

  // 当前标签滚动到可见范围
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.tab--active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.active, tabs.items.length]);

  if (tabs.items.length < 2) return null;
  const close = (key: string) => postToHost({ type: 'closeTab', payload: { key } });
  return (
    <div className="tabs" role="tablist" aria-label={t('tabs.label')} ref={strip} data-testid="tabs">
      {tabs.items.map((tab) => {
        const active = tab.key === tabs.active;
        return (
          <div
            key={tab.key}
            className={`tab ${active ? 'tab--active' : ''}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={tab.title}
            onClick={() => !active && postToHost({ type: 'activateTab', payload: { key: tab.key } })}
            onAuxClick={(event) => {
              if (event.button === 1) close(tab.key);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const index = tabs.items.findIndex((item) => item.key === tab.key);
                const next = tabs.items[(index + (event.key === 'ArrowRight' ? 1 : tabs.items.length - 1)) % tabs.items.length];
                if (next) postToHost({ type: 'activateTab', payload: { key: next.key } });
              } else if (event.key === 'Delete') close(tab.key);
            }}
          >
            {tab.needsAttention ? (
              <span className="dot dot--attention" aria-label={t('tabs.attention')} />
            ) : tab.running ? (
              <span className="dot dot--running" aria-label={t('header.running')} />
            ) : null}
            <span className="tab__title">{tab.title}</span>
            <button
              type="button"
              className="tab__close"
              tabIndex={-1}
              aria-label={t('tabs.close', tab.title)}
              title={t('tabs.closeTitle')}
              onClick={(event) => {
                event.stopPropagation();
                close(tab.key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
