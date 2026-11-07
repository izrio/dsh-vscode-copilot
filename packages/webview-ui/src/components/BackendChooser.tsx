/**
 * 底层选择卡片：第一次打开面板时出现（welcome），之后在首页点当前底层的标签也能打开。
 * 每个底层显示说明、本机是否已安装；没装时给出安装命令，可以复制。
 */
import { useState } from 'react';
import type { BackendView } from '@dsh-copilot/shared';
import type { MessageKey } from '../i18n.ts';
import { useT } from '../i18n.ts';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { BackendLogo } from './BackendLogo.tsx';
import { ArrowLeftIcon, CheckIcon, CopyIcon, SparkleIcon, SpinnerIcon } from './icons.tsx';

/** 内置底层的说明；自定义的 ACP 代理显示启动命令。 */
const DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  dsh: 'backend.desc.dsh',
  'oh-my-pi': 'backend.desc.omp',
  codebuddy: 'backend.desc.codebuddy',
};

export function BackendChooser({ welcome, onClose }: { readonly welcome: boolean; readonly onClose?: () => void }) {
  const t = useT();
  const backends = useView((s) => s.backends);
  const choose = (id: string) => {
    postToHost({ type: 'selectBackend', payload: { id } });
    onClose?.();
  };
  return (
    <div className="chooser" data-testid="backend-chooser">
      <div className="chooser__head">
        {welcome ? (
          <div className="home__logo home__logo--small" aria-hidden="true">
            <SparkleIcon />
          </div>
        ) : null}
        <p className="chooser__title">{welcome ? t('backend.choose.welcome') : t('backend.choose.title')}</p>
        <p className="chooser__hint">{welcome ? t('backend.choose.welcomeHint') : t('backend.choose.hint')}</p>
      </div>
      <div className="chooser__list" role="radiogroup" aria-label={t('backend.choose.title')}>
        {backends.items.map((backend) => (
          <BackendOption key={backend.id} backend={backend} active={backend.id === backends.active} onChoose={() => choose(backend.id)} />
        ))}
      </div>
      <div className="chooser__foot">
        {welcome ? (
          <button type="button" className="link-button" data-testid="backend-later" onClick={() => postToHost({ type: 'dismissBackendChoice', payload: {} })}>
            {t('backend.choose.later')}
          </button>
        ) : (
          <button type="button" className="link-button" onClick={onClose}>
            <ArrowLeftIcon />
            {t('backend.choose.back')}
          </button>
        )}
      </div>
    </div>
  );
}

function BackendOption({ backend, active, onChoose }: { readonly backend: BackendView; readonly active: boolean; readonly onChoose: () => void }) {
  const t = useT();
  const description = DESCRIPTIONS[backend.id];
  return (
    <div className={`backend-option ${active ? 'backend-option--active' : ''}`}>
      <button type="button" role="radio" aria-checked={active} className="backend-option__main" onClick={onChoose} data-testid={`backend-option-${backend.id}`}>
        <BackendLogo backend={backend} />
        <span className="backend-option__body">
          <span className="backend-option__name">
            {backend.name}
            {backend.kind === 'acp' ? <span className="backend-option__tag">ACP</span> : null}
            {active ? <span className="backend-option__current">{t('backend.current')}</span> : null}
          </span>
          <span className="backend-option__desc">{description ? t(description) : t('backend.desc.acp', backend.command ?? backend.name)}</span>
          <Availability backend={backend} />
        </span>
        <span className="backend-option__check" aria-hidden="true">
          {active ? <CheckIcon /> : null}
        </span>
      </button>
      {backend.available === false && (backend.installCommand || backend.installHint) ? <InstallHint backend={backend} /> : null}
    </div>
  );
}

function Availability({ backend }: { readonly backend: BackendView }) {
  const t = useT();
  if (backend.available === undefined) {
    return (
      <span className="backend-option__status">
        <SpinnerIcon />
        {t('backend.checking')}
      </span>
    );
  }
  return backend.available ? (
    <span className="backend-option__status backend-option__status--ok">
      <span className="status-dot status-dot--ok" />
      {t('backend.installed')}
    </span>
  ) : (
    <span className="backend-option__status backend-option__status--missing">
      <span className="status-dot status-dot--missing" />
      {t('backend.missing')}
    </span>
  );
}

function InstallHint({ backend }: { readonly backend: BackendView }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!backend.installCommand) return <p className="backend-option__install-text">{backend.installHint}</p>;
  const command = backend.installCommand;
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className="backend-option__install">
      <code>{command}</code>
      <button type="button" className="icon-button" title={copied ? t('backend.copied') : t('backend.copy')} aria-label={t('backend.copy')} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
