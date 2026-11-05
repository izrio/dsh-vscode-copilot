/**
 * 输入框上方的会话改动栏：本会话改过的文件和增删行数，默认收起成一行，点开列出文件，点击文件打开本会话的累计 Diff。
 * 可以隐藏；之后又有新的改动时重新出现。
 */
import { useState } from 'react';
import { useView } from '../store.ts';
import { loadState, saveState } from '../vscode.ts';
import { ChangedFileButton, Stats } from './Items.tsx';
import { ChevronRightIcon, CloseIcon, DiffIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

export function SessionChanges() {
  const changes = useView((s) => s.session.changes);
  const sessionKey = useView((s) => s.sessionKey);
  const [open, setOpen] = useState(() => loadState().changesOpen ?? false);
  const [dismissed, setDismissed] = useState(() => loadState().changesDismissed);
  const t = useT();
  if (!changes?.files.length) return null;
  // 文件数或行数变化（有了新的改动）时，隐藏的改动栏重新出现
  const signature = `${sessionKey}|${changes.files.length}|${changes.additions}|${changes.deletions}`;
  if (dismissed === signature) return null;
  const toggle = () => {
    setOpen(!open);
    saveState({ changesOpen: !open });
  };
  const dismiss = () => {
    setDismissed(signature);
    saveState({ changesDismissed: signature });
  };
  return (
    <section className={`session-changes ${open ? 'session-changes--open' : ''}`} aria-label={t('sessionChanges.label')} data-testid="session-changes">
      <div className="session-changes__header">
        <button type="button" className="session-changes__toggle" aria-expanded={open} onClick={toggle} title={open ? t('sessionChanges.collapse') : t('sessionChanges.expand')}>
          <ChevronRightIcon className={`chevron ${open ? 'chevron--open' : ''}`} />
          <DiffIcon />
          <span className="session-changes__title">{t('sessionChanges.files', changes.files.length)}</span>
          <Stats stats={changes} />
        </button>
        <button type="button" className="icon-button icon-button--small" onClick={dismiss} aria-label={t('sessionChanges.hide')} title={t('sessionChanges.hide')}>
          <CloseIcon />
        </button>
      </div>
      {open ? (
        <ul className="session-changes__list">
          {changes.files.map((file) => (
            <li key={file.path}>
              <ChangedFileButton file={file} className="session-changes__file" />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
