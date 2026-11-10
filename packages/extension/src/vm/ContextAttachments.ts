/**
 * 随消息附带的编辑器上下文：当前编辑器（选区或文件）和用「添加到对话」固定的选区。
 * 只管状态；拼进消息文本的格式见 context.ts。
 */
import type { ContextState } from '@dsh-copilot/shared';
import type { ContextAttachment } from './context.ts';
import { displayPath } from './paths.ts';
import { withoutDiagnostics } from './viewHelpers.ts';
import type { EditorSnapshot, Workbench } from './workbench.ts';

export interface GatherOptions {
  /** 附带当前编辑器（默认 true；输入框上方的标签被关掉时为 false）。 */
  readonly includeActive?: boolean;
  /** 额外附带的上下文（右键菜单的选区）。 */
  readonly extra?: readonly ContextAttachment[];
  /** 附带选区的诊断信息（/fix）。 */
  readonly diagnostics?: boolean;
}

type Pinned = ContextAttachment & { readonly id: string };

export class ContextAttachments {
  private pinned: Pinned[] = [];
  private counter = 0;

  constructor(
    private readonly workbench: () => Workbench,
    private readonly includeActiveByDefault: () => boolean = () => true,
  ) {}

  /** 当前编辑器：有选区时是选区，否则是文件；没有打开磁盘上的文件时为 undefined。 */
  active(): ContextAttachment | undefined {
    return toAttachment(this.workbench().activeEditor());
  }

  /** 固定当前编辑器的选区（或文件）。@returns 没有可固定的内容时返回 false。 */
  pinActive(): boolean {
    const attachment = this.active();
    if (!attachment) return false;
    this.pinned.push({ ...attachment, id: `pin-${++this.counter}` });
    return true;
  }

  unpin(id: string): boolean {
    const before = this.pinned.length;
    this.pinned = this.pinned.filter((p) => p.id !== id);
    return this.pinned.length !== before;
  }

  /** 消息发出后清空固定的上下文。@returns 是否有变化。 */
  clearPinned(): boolean {
    if (this.pinned.length === 0) return false;
    this.pinned = [];
    return true;
  }

  /** 本条消息附带的上下文：固定的、额外的、当前编辑器。诊断信息只在 /fix 时附带。 */
  gather(options: GatherOptions = {}): ContextAttachment[] {
    const active = options.includeActive !== false ? this.active() : undefined;
    const all = [...this.pinned.map(({ id: _id, ...rest }) => rest as ContextAttachment), ...(options.extra ?? []), ...(active ? [active] : [])];
    return options.diagnostics ? all : all.map((a) => (a.kind === 'selection' ? withoutDiagnostics(a) : a));
  }

  /** 输入框上方的标签。 */
  view(workspacePath: string): ContextState {
    const view = (a: ContextAttachment) => ({
      kind: a.kind,
      path: displayPath(a.path, workspacePath),
      ...(a.kind === 'selection' ? { startLine: a.startLine, endLine: a.endLine } : {}),
    });
    const active = this.active();
    return {
      ...(active
        ? { active: { ...view(active), key: active.kind === 'file' ? `f:${active.path}` : `s:${active.path}:${active.startLine}-${active.endLine}` } }
        : {}),
      includeActiveByDefault: this.includeActiveByDefault(),
      pinned: this.pinned.map((p) => ({ ...view(p), id: p.id })),
    };
  }
}

/** 编辑器快照 → 附带的上下文。 */
export function toAttachment(editor: EditorSnapshot | undefined): ContextAttachment | undefined {
  if (!editor) return undefined;
  if (!editor.selection) return { kind: 'file', path: editor.path };
  const { startLine, endLine, text, diagnostics } = editor.selection;
  return { kind: 'selection', path: editor.path, startLine, endLine, languageId: editor.languageId, text, ...(diagnostics.length ? { diagnostics } : {}) };
}
