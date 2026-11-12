/**
 * 简单的弹出层：点击外部或按 Esc 关闭，打开时聚焦第一个可操作元素，关闭后焦点回到打开它的按钮。
 * ↑↓ 在各项之间移动，Home / End 到第一项、最后一项。
 */
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'input:not([disabled]), button:not([disabled])';

export function Popover({
  open,
  onClose,
  className,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      const container = ref.current;
      if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const active = document.activeElement;
      // 输入框里 Home / End 是移动光标，不抢
      if (active instanceof HTMLInputElement && (event.key === 'Home' || event.key === 'End')) return;
      const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next =
        event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
      event.preventDefault();
      items[next]?.focus();
    };
    // 打开前焦点所在的元素（通常是打开弹出层的按钮）：关闭后回到它，键盘用户不会丢失位置
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      // 焦点还在弹出层里（或已随它消失落到 body）时才还回去；用户点了别处就不抢
      const current = document.activeElement;
      if (opener?.isConnected && (!current || current === document.body || ref.current?.contains(current))) opener.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${className ?? ''}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/** 菜单里的一项。 */
export function MenuItem({
  onSelect,
  children,
  active,
  hint,
  icon,
}: {
  onSelect: () => void;
  children: ReactNode;
  active?: boolean;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${active ? 'menu-item--active' : ''}`} onClick={onSelect}>
      {icon ? <span className="menu-item__icon">{icon}</span> : null}
      <span className="menu-item__label">{children}</span>
      {hint ? <span className="menu-item__hint">{hint}</span> : null}
    </button>
  );
}
