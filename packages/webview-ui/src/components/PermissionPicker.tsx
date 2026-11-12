/** 权限预设：只读 / 工作区可写 / 完全访问（及用户在 dsh 里自定义的预设）。完全访问由 Host 弹出确认。 */
import { useCallback, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ChevronDownIcon, LockIcon, PencilIcon, ShieldIcon, UnlockIcon } from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';
import { useT, type Translate } from '../i18n.ts';

const KNOWN = ['read-only', 'workspace-write', 'danger-full-access'] as const;
type Known = (typeof KNOWN)[number];
const isKnown = (preset: string): preset is Known => (KNOWN as readonly string[]).includes(preset);

/** 内置预设显示翻译后的名字；用户自定义的预设显示原名。 */
export const permissionName = (preset: string, t: Translate): string => (isKnown(preset) ? t(`permission.${preset}`) : preset);
const permissionHint = (preset: string, t: Translate): string | undefined => (isKnown(preset) ? t(`permission.${preset}.hint`) : undefined);

/** 只读：锁；工作区可写：笔；完全访问：开锁；自定义预设：盾牌。 */
function PresetIcon({ preset }: { preset: string | undefined }) {
  if (preset === 'read-only') return <LockIcon />;
  if (preset === 'workspace-write') return <PencilIcon />;
  if (preset === 'danger-full-access') return <UnlockIcon />;
  return <ShieldIcon />;
}

export function PermissionPicker({ disabled }: { disabled: boolean }) {
  const permissions = useView((s) => s.permissions);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const t = useT();
  if (permissions.options.length === 0) return null;
  const current = permissions.current;
  const danger = current === 'danger-full-access';
  return (
    <div className="model-picker">
      <button
        type="button"
        className={`toolbar-button ${danger ? 'toolbar-button--danger' : ''}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={current ? t('permission.title', permissions.labels?.[current]?.name ?? permissionName(current, t)) : t('permission.label')}
        data-testid="permission-picker"
      >
        <PresetIcon preset={current} />
        <span className="toolbar-button__text permission-picker__text">{current ? (permissions.labels?.[current]?.name ?? permissionName(current, t)) : t('permission.label')}</span>
        <ChevronDownIcon />
      </button>
      <Popover open={open} onClose={close} className="model-menu permission-menu" label={t('permission.select')}>
        <div role="menu">
          {permissions.options.map((preset) => (
            <MenuItem
              key={preset}
              active={preset === current}
              icon={<PresetIcon preset={preset} />}
              hint={permissions.labels?.[preset]?.description ?? permissionHint(preset, t)}
              onSelect={() => {
                close();
                if (preset !== current) postToHost({ type: 'selectPermission', payload: { preset } });
              }}
            >
              {permissions.labels?.[preset]?.name ?? permissionName(preset, t)}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </div>
  );
}
