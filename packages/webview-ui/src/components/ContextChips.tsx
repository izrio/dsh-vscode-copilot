/**
 * 输入框里的上下文标签：当前编辑器（有选区时是选区，否则是文件；点击切换是否附带）和用「添加到对话」固定的选区。
 */
import type { AttachmentView } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';
import { CloseIcon, FileIcon, SelectionIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

export function attachmentLabel(a: AttachmentView): string {
  const name = a.path.split(/[\\/]/u).pop() ?? a.path;
  if (a.kind === 'file' || a.startLine === undefined) return name;
  return a.endLine && a.endLine !== a.startLine ? `${name}:${a.startLine}-${a.endLine}` : `${name}:${a.startLine}`;
}

export function openAttachment(a: AttachmentView): void {
  postToHost({ type: 'openFile', payload: { path: a.path, ...(a.startLine ? { startLine: a.startLine } : {}), ...(a.endLine ? { endLine: a.endLine } : {}) } });
}

export function ContextChips({
  active,
  included,
  onToggle,
  pinned,
}: {
  active?: AttachmentView;
  included: boolean;
  onToggle: () => void;
  pinned: readonly (AttachmentView & { readonly id: string })[];
}) {
  const t = useT();
  if (!active && pinned.length === 0) return null;
  return (
    <div className="context-chips" data-testid="context-chips">
      {pinned.map((a) => (
        <span key={a.id} className="chip" title={t('chip.pinnedTitle', a.startLine ? t('chip.lines', a.path, a.startLine, a.endLine ?? a.startLine) : a.path)}>
          {a.kind === 'selection' ? <SelectionIcon /> : <FileIcon />}
          <span className="chip__label">{attachmentLabel(a)}</span>
          <button type="button" className="chip__remove" aria-label={t('chip.remove', attachmentLabel(a))} onClick={() => postToHost({ type: 'removeAttachment', payload: { id: a.id } })}>
            <CloseIcon />
          </button>
        </span>
      ))}
      {active ? (
        <button
          type="button"
          className={`chip chip--active ${included ? '' : 'chip--excluded'}`}
          aria-pressed={included}
          onClick={onToggle}
          title={
            active.kind === 'selection'
              ? t(included ? 'chip.includedSelection' : 'chip.excludedSelection')
              : t(included ? 'chip.includedFile' : 'chip.excludedFile')
          }
          data-testid="active-context"
        >
          {active.kind === 'selection' ? <SelectionIcon /> : <FileIcon />}
          <span className="chip__label">{attachmentLabel(active)}</span>
          <span className="chip__hint">{active.kind === 'selection' ? t('chip.selection') : t('chip.file')}</span>
        </button>
      ) : null}
    </div>
  );
}
