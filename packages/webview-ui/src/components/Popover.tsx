/**
 * 简单的弹出层：点击外部或按 Esc 关闭，打开时聚焦第一个可操作元素。
 * 键盘：↑↓ 在菜单项之间移动（从搜索框按 ↓ 进入列表），Home / End 到首尾；关闭后焦点回到打开它的按钮。
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    const active = ref.current?.querySelector<HTMLElement>('[role="menuitem"].menu-item--active');
    (ref.current?.querySelector<HTMLElement>('input') ?? active ?? ref.current?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      // 弹出层已经卸载、焦点丢到了 body 上：还给打开它的按钮（点到别处关闭时焦点已经在别处，不抢）
      requestAnimationFrame(() => {
        if ((document.activeElement === document.body || document.activeElement === null) && opener?.isConnected) opener.focus();
      });
    };
  }, [open, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[index < 0 ? 0 : (index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = index < 0 ? items.at(-1) : index === 0 ? undefined : items[index - 1];
    else if ((event.key === 'Home' || event.key === 'End') && index >= 0) next = event.key === 'Home' ? items[0] : items.at(-1);
    else return;
    event.preventDefault();
    // 在第一项按 ↑ 回到搜索框
    (next ?? ref.current?.querySelector<HTMLElement>('input') ?? items.at(-1))?.focus();
  };

  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${className ?? ''}`} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
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
    <button type="button" role="menuitem" aria-current={active ? 'true' : undefined} className={`menu-item ${active ? 'menu-item--active' : ''}`} onClick={onSelect}>
      {icon ? <span className="menu-item__icon">{icon}</span> : null}
      <span className="menu-item__label">{children}</span>
      {hint ? <span className="menu-item__hint">{hint}</span> : null}
    </button>
  );
}
