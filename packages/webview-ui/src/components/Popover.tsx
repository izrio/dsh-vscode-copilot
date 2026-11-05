/** 简单的弹出层：点击外部或按 Esc 关闭，打开时聚焦第一个可操作元素。 */
import { useEffect, useRef, type ReactNode } from 'react';

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
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
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
