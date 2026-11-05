/** 模型选择：按提供方分组；有多个推理强度时可以选强度。 */
import { useCallback, useState } from 'react';
import type { ModelOption } from '@dsh-copilot/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ChevronDownIcon, SparkleIcon, SpinnerIcon } from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';
import { useT } from '../i18n.ts';

export function ModelPicker({ disabled }: { disabled: boolean }) {
  const models = useView((s) => s.models);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
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

  const groups = [...new Set(models.options.map((o) => o.group))];
  return (
    <div className="model-picker">
      <button
        type="button"
        className="toolbar-button"
        disabled={disabled || models.options.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={t('model.switch')}
        data-testid="model-picker"
      >
        {loading && !option ? <SpinnerIcon /> : <SparkleIcon />}
        <span className="toolbar-button__text">{label}</span>
        <ChevronDownIcon />
      </button>
      <Popover open={open} onClose={close} className="model-menu" label={t('model.select')}>
        <div role="menu">
          {groups.map((group) => (
            <div key={group} className="model-menu__group">
              {groups.length > 1 ? <div className="menu-heading">{group}</div> : null}
              {models.options
                .filter((o) => o.group === group)
                .map((o) =>
                  o.efforts.length > 1 ? (
                    o.efforts.map((e) => (
                      <MenuItem
                        key={`${o.provider}/${o.model}/${e.id}`}
                        active={o.provider === current?.provider && o.model === current?.model && e.id === current?.reasoningEffort}
                        hint={e.name}
                        onSelect={() => select(o, e.id)}
                      >
                        {o.name}
                      </MenuItem>
                    ))
                  ) : (
                    <MenuItem key={`${o.provider}/${o.model}`} active={o.provider === current?.provider && o.model === current?.model} onSelect={() => select(o, o.efforts[0]?.id)}>
                      {o.name}
                    </MenuItem>
                  ),
                )}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
