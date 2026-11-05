/** dsh 运行时和连接状态提示。连接正常时不显示。 */
import type { ConnectionState, RuntimeStatus } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';
import { ErrorIcon, LogIcon, RefreshIcon, SpinnerIcon } from './icons.tsx';
import { useT, type Translate } from '../i18n.ts';

export function RuntimeBanner({ status, connection }: { status: RuntimeStatus; connection: ConnectionState }) {
  const t = useT();
  const view = describe(status, connection, t);
  if (!view) return null;
  return (
    <section className={`banner banner--${view.tone}`} role="status">
      <p className="banner__title">
        {view.tone === 'info' ? <SpinnerIcon /> : <ErrorIcon />}
        <span>{view.title}</span>
      </p>
      {view.detail ? <p className="banner__detail">{view.detail}</p> : null}
      {view.actions ? (
        <div className="banner__actions">
          <button type="button" className="button" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            <RefreshIcon />
            {t('runtime.retry')}
          </button>
          <button type="button" className="button button--secondary" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            <LogIcon />
            {t('runtime.logs')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface BannerView {
  readonly title: string;
  readonly detail?: string;
  readonly tone: 'info' | 'warn';
  readonly actions?: boolean;
}

export function describe(status: RuntimeStatus, connection: ConnectionState, t: Translate): BannerView | undefined {
  switch (status.kind) {
    case 'idle':
    case 'locating':
      return { title: t('runtime.locating'), tone: 'info' };
    case 'starting':
      return { title: t('runtime.starting'), ...(status.version ? { detail: t('runtime.version', status.version) } : {}), tone: 'info' };
    case 'connected':
      if (connection !== 'connected') return { title: t('runtime.connecting'), tone: 'info' };
      return status.newerThanTested
        ? { title: t('runtime.newer', status.version), detail: t('runtime.newerDetail'), tone: 'info' }
        : undefined;
    case 'reconnecting':
      return { title: t('runtime.restarting', status.attempt), tone: 'warn' };
    case 'notInstalled':
      return {
        title: t('runtime.notInstalled'),
        detail: t('runtime.notInstalledDetail'),
        tone: 'warn',
        actions: true,
      };
    case 'unsupportedVersion':
      return { title: t('runtime.tooOld', status.version), detail: t('runtime.tooOldDetail', status.minimum), tone: 'warn', actions: true };
    case 'failed':
      return { title: t('runtime.failed'), detail: status.message, tone: 'warn', actions: true };
    case 'untrusted':
      return { title: t('runtime.untrusted'), detail: t('runtime.untrustedDetail'), tone: 'warn' };
  }
}
