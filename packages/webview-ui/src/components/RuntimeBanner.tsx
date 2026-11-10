/** dsh 运行时和连接状态提示。连接正常时不显示；每种状态带上能解决问题的操作。 */
import { useState, type ReactNode } from 'react';
import type { ConnectionState, RuntimeStatus, WebviewToHost } from '@dsh-copilot/shared';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { BookIcon, CloseIcon, ErrorIcon, FolderIcon, GearIcon, InfoIcon, LogIcon, RefreshIcon, ShieldIcon, SpinnerIcon } from './icons.tsx';
import { useT, type MessageKey, type Translate } from '../i18n.ts';

const INSTALL_URL = 'https://github.com/deepseek-ai/deepseek-harness';

type Action = 'retry' | 'logs' | 'settings' | 'install' | 'trust' | 'openFolder';

const ACTIONS: Record<Action, { readonly icon: ReactNode; readonly label: MessageKey; readonly message: WebviewToHost }> = {
  retry: { icon: <RefreshIcon />, label: 'runtime.retry', message: { type: 'restartRuntime', payload: {} } },
  logs: { icon: <LogIcon />, label: 'runtime.logs', message: { type: 'showLogs', payload: {} } },
  settings: { icon: <GearIcon />, label: 'runtime.settings', message: { type: 'openSettings', payload: { query: 'dsh.runtime.path' } } },
  install: { icon: <BookIcon />, label: 'runtime.install', message: { type: 'openExternal', payload: { url: INSTALL_URL } } },
  trust: { icon: <ShieldIcon />, label: 'runtime.manageTrust', message: { type: 'manageTrust', payload: {} } },
  openFolder: { icon: <FolderIcon />, label: 'runtime.openFolder', message: { type: 'openFolder', payload: {} } },
};

export interface BannerView {
  readonly title: string;
  readonly detail?: string;
  /** progress：正在进行（转圈）；info：提示；warn：需要处理。 */
  readonly tone: 'progress' | 'info' | 'warn';
  readonly actions?: readonly Action[];
  /** 可以关掉的提示：关掉后同一个 key 不再显示。 */
  readonly dismissKey?: string;
}

export function RuntimeBanner({ status, connection }: { status: RuntimeStatus; connection: ConnectionState }) {
  const t = useT();
  const [dismissed, setDismissed] = useState<readonly string[]>(() => loadState().dismissed ?? []);
  const view = describe(status, connection, t);
  if (!view || (view.dismissKey && dismissed.includes(view.dismissKey))) return null;
  const dismiss = (key: string) => {
    const next = [...dismissed, key].slice(-20);
    setDismissed(next);
    saveState({ dismissed: next });
  };
  const icon = view.tone === 'progress' ? <SpinnerIcon /> : view.tone === 'info' ? <InfoIcon /> : <ErrorIcon />;
  return (
    <section className={`banner banner--${view.tone}`} role={view.tone === 'warn' ? 'alert' : 'status'} data-testid="runtime-banner">
      <div className="banner__title">
        {icon}
        <span>{view.title}</span>
        {view.dismissKey ? (
          <button
            type="button"
            className="icon-button banner__close"
            aria-label={t('runtime.dismiss')}
            title={t('runtime.dismiss')}
            onClick={() => dismiss(view.dismissKey!)}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {view.detail ? <p className="banner__detail">{view.detail}</p> : null}
      {view.actions?.length ? (
        <div className="banner__actions">
          {view.actions.map((action, index) => (
            <button
              key={action}
              type="button"
              className={`button ${index === 0 ? '' : 'button--secondary'}`}
              onClick={() => postToHost(ACTIONS[action].message)}
            >
              {ACTIONS[action].icon}
              {t(ACTIONS[action].label)}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function describe(status: RuntimeStatus, connection: ConnectionState, t: Translate): BannerView | undefined {
  switch (status.kind) {
    case 'idle':
    case 'locating':
      return { title: t('runtime.locating'), tone: 'progress' };
    case 'starting':
      return { title: t('runtime.starting'), ...(status.version ? { detail: t('runtime.version', status.version) } : {}), tone: 'progress' };
    case 'connected':
      if (connection !== 'connected') return { title: t('runtime.connecting'), tone: 'progress' };
      return status.newerThanTested
        ? { title: t('runtime.newer', status.version), detail: t('runtime.newerDetail'), tone: 'info', dismissKey: `newer:${status.version}` }
        : undefined;
    case 'reconnecting':
      return { title: t('runtime.restarting', status.attempt), tone: 'progress', actions: ['logs'] };
    case 'notInstalled':
      return { title: t('runtime.notInstalled'), detail: t('runtime.notInstalledDetail'), tone: 'warn', actions: ['retry', 'settings', 'install'] };
    case 'unsupportedVersion':
      return { title: t('runtime.tooOld', status.version), detail: t('runtime.tooOldDetail', status.minimum), tone: 'warn', actions: ['retry', 'install'] };
    case 'failed':
      return { title: t('runtime.failed'), detail: status.message, tone: 'warn', actions: ['retry', 'logs', 'settings'] };
    case 'untrusted':
      return { title: t('runtime.untrusted'), detail: t('runtime.untrustedDetail'), tone: 'warn', actions: ['trust'] };
    case 'noFolder':
      return { title: t('runtime.noFolder'), detail: t('runtime.noFolderDetail'), tone: 'warn', actions: ['openFolder'] };
  }
}

/** dsh 不可用（需要用户处理，不会自己恢复）。 */
export function runtimeBlocked(status: RuntimeStatus): boolean {
  return ['notInstalled', 'unsupportedVersion', 'failed', 'untrusted', 'noFolder'].includes(status.kind);
}
