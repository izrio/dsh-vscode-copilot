/** 权限预设：只读 / 工作区可写 / 完全访问（及用户在 dsh 里自定义的预设）。完全访问由 Host 弹出确认。 */
import { useCallback, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ChevronDownIcon, ShieldIcon } from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';

const LABELS: Record<string, { name: string; hint: string }> = {
  'read-only': { name: '只读', hint: '只能读取文件' },
  'workspace-write': { name: '工作区可写', hint: '可以修改工作区里的文件' },
  'danger-full-access': { name: '完全访问', hint: '不受沙箱限制' },
};

export const permissionName = (preset: string): string => LABELS[preset]?.name ?? preset;

export function PermissionPicker({ disabled }: { disabled: boolean }) {
  const permissions = useView((s) => s.permissions);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
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
        title={current ? `权限：${permissionName(current)}` : '权限'}
        data-testid="permission-picker"
      >
        <ShieldIcon />
        <span className="toolbar-button__text permission-picker__text">{current ? permissionName(current) : '权限'}</span>
        <ChevronDownIcon />
      </button>
      <Popover open={open} onClose={close} className="model-menu permission-menu" label="选择权限">
        <div role="menu">
          {permissions.options.map((preset) => (
            <MenuItem
              key={preset}
              active={preset === current}
              hint={LABELS[preset]?.hint}
              onSelect={() => {
                close();
                if (preset !== current) postToHost({ type: 'selectPermission', payload: { preset } });
              }}
            >
              {permissionName(preset)}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </div>
  );
}
