/** 输入框上方的补全列表：`/` 命令和 `@` 文件。键盘操作由输入框处理，这里只负责显示和鼠标选择。 */
import { useEffect, useRef } from 'react';
import { FileIcon, FolderIcon, SlashIcon } from './icons.tsx';

export interface CompletionItem {
  readonly key: string;
  readonly icon: 'file' | 'directory' | 'command';
  readonly label: string;
  readonly detail?: string;
  readonly hint?: string;
}

export function Completion({
  items,
  selected,
  onSelect,
  onHover,
  empty,
  label,
}: {
  items: readonly CompletionItem[];
  selected: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
  empty?: string;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div className="completion" ref={list} role="listbox" aria-label={label} id="composer-completion" data-testid="completion">
      {items.length === 0 && empty ? <div className="completion__empty">{empty}</div> : null}
      {items.map((item, index) => (
        <div
          key={item.key}
          id={`completion-${index}`}
          role="option"
          aria-selected={index === selected}
          className={`completion__item ${index === selected ? 'completion__item--selected' : ''}`}
          // 用 mousedown 并阻止默认行为，输入框不会失去焦点
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(index);
          }}
          onMouseMove={() => onHover(index)}
        >
          <span className="completion__icon">{item.icon === 'command' ? <SlashIcon /> : item.icon === 'directory' ? <FolderIcon /> : <FileIcon />}</span>
          <span className="completion__label">{item.label}</span>
          {item.hint ? <span className="completion__hint">{item.hint}</span> : null}
          {item.detail ? <span className="completion__detail">{item.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}
