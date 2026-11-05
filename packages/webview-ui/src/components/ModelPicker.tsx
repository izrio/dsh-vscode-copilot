/**
 * 模型选择：按提供方分组。只有一种推理强度的模型点一下就选中；有多个推理强度的模型是级联菜单——
 * 先点模型，再在第二级里选推理强度（当前强度预先标出）。当前选中的项带勾和强调色底色。
 */
import { useCallback, useState } from 'react';
import type { ModelOption } from '@dsh-copilot/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SparkleIcon, SpinnerIcon } from './icons.tsx';
import { Popover } from './Popover.tsx';
import { useT } from '../i18n.ts';

const keyOf = (o: { provider: string; model: string }) => `${o.provider}/${o.model}`;

export function ModelPicker({ disabled }: { disabled: boolean }) {
  const models = useView((s) => s.models);
  const [open, setOpen] = useState(false);
  /** 第二级：正在为这个模型选推理强度。 */
  const [drill, setDrill] = useState<string | undefined>();
  const close = useCallback(() => {
    setOpen(false);
    setDrill(undefined);
  }, []);
  const t = useT();
  const current = models.current;
  const option = models.options.find((o) => o.provider === current?.provider && o.model === current?.model);
  const effort = option?.efforts.find((e) => e.id === current?.reasoningEffort);
  const connected = useView((s) => s.connection === 'connected');
  // 已连接但目录还没读到（也不是缺 API Key）：正在读取
  const loading = (!connected || models.options.length === 0) && !models.needsApiKey;
  const label = option
    ? `${option.name}${effort && option.efforts.length > 1 ? ` · ${effort.name}` : ''}`
    : loading
      ? t('model.loading')
      : (current?.model ?? t('model.default'));

  const select = (o: ModelOption, reasoningEffort?: string) => {
    close();
    postToHost({
      type: 'selectModel',
      payload: { provider: o.provider, model: o.model, ...(reasoningEffort ? { reasoningEffort } : {}) },
    });
  };

  const isCurrent = (o: ModelOption) => o.provider === current?.provider && o.model === current?.model;
  const drilled = drill ? models.options.find((o) => keyOf(o) === drill) : undefined;
  const groups = [...new Set(models.options.map((o) => o.group))];

  return (
    <div className="model-picker">
      <button
        type="button"
        className="toolbar-button"
        disabled={disabled || models.options.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={t('model.switch')}
        data-testid="model-picker"
      >
        {loading && !option ? <SpinnerIcon /> : <SparkleIcon />}
        <span className="toolbar-button__text">{label}</span>
        <ChevronDownIcon />
      </button>
      <Popover open={open} onClose={close} className="model-menu" label={t('model.select')}>
        {drilled ? (
          <div role="menu" key="efforts" className="model-menu__level" data-testid="effort-menu">
            <button type="button" className="model-menu__back" autoFocus onClick={() => setDrill(undefined)} aria-label={t('model.back')}>
              <ChevronRightIcon className="model-menu__back-icon" />
              <span className="model-menu__back-name">{drilled.name}</span>
              <span className="model-menu__back-hint">{t('model.effort')}</span>
            </button>
            {drilled.efforts.map((e) => {
              const active = isCurrent(drilled) && e.id === current?.reasoningEffort;
              return (
                <ModelItem key={e.id} active={active} onSelect={() => select(drilled, e.id)} {...(e.id === drilled.defaultEffort ? { hint: t('model.defaultEffort') } : {})}>
                  {e.name}
                </ModelItem>
              );
            })}
          </div>
        ) : (
          <div role="menu" key="models" className="model-menu__level">
            {groups.map((group) => (
              <div key={group} className="model-menu__group">
                {groups.length > 1 ? <div className="menu-heading">{group}</div> : null}
                {models.options
                  .filter((o) => o.group === group)
                  .map((o) => {
                    const cascade = o.efforts.length > 1;
                    const active = isCurrent(o);
                    const currentEffort = active ? o.efforts.find((e) => e.id === current?.reasoningEffort) : undefined;
                    return (
                      <ModelItem
                        key={keyOf(o)}
                        active={active}
                        cascade={cascade}
                        {...(o.description ? { title: o.description } : {})}
                        {...(cascade && currentEffort ? { hint: currentEffort.name } : {})}
                        onSelect={() => (cascade ? setDrill(keyOf(o)) : select(o, o.efforts[0]?.id))}
                      >
                        {o.name}
                      </ModelItem>
                    );
                  })}
              </div>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** 模型菜单的一项：当前项前面有勾、强调色底色；级联项末尾有箭头。 */
function ModelItem({
  active,
  cascade,
  hint,
  title,
  onSelect,
  children,
}: {
  active: boolean;
  cascade?: boolean;
  hint?: string;
  title?: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role={cascade ? 'menuitem' : 'menuitemradio'}
      aria-checked={cascade ? undefined : active}
      aria-haspopup={cascade ? 'menu' : undefined}
      className={`menu-item model-item ${active ? 'menu-item--active' : ''}`}
      onClick={onSelect}
      title={title ?? children}
    >
      <span className="model-item__check">{active ? <CheckIcon /> : null}</span>
      <span className="menu-item__label">{children}</span>
      {hint ? <span className="menu-item__hint">{hint}</span> : null}
      {cascade ? <ChevronRightIcon className="model-item__arrow" /> : null}
    </button>
  );
}
