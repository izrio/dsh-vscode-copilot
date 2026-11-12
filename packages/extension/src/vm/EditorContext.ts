/**
 * 随消息附带的编辑器上下文（两种底层的控制器共用）：当前编辑器（文件或选区）和用「添加到对话」固定下来的选区。
 * 线上格式见 context.ts；这里只管收集和界面上的标签。
 */
import type { ContextState } from '@harness-deck/shared';
import type { ContextAttachment } from './context.ts';
import { displayPath } from './paths.ts';
import type { EditorSnapshot, Workbench } from './workbench.ts';

export interface GatherOptions {
  /** 附带当前编辑器（默认 true；输入框上方的标签被关掉时为 false）。 */
  readonly includeActive?: boolean;
  /** 额外附带的上下文（右键菜单的选区）。 */
  readonly extra?: readonly ContextAttachment[];
  /** 附带选区的诊断信息（/fix）。 */
  readonly diagnostics?: boolean;
}

/** 去掉选区的诊断信息（只有 /fix 才附带）。 */
function withoutDiagnostics(attachment: ContextAttachment): ContextAttachment {
  if (attachment.kind !== 'selection' || !attachment.diagnostics) return attachment;
  const { diagnostics: _diagnostics, ...rest } = attachment;
  return rest;
}

export class EditorContext {
  private pinned: (ContextAttachment & { id: string })[] = [];
  private counter = 0;

  constructor(
    private readonly workbench: () => Workbench,
    private readonly includeActiveByDefault: () => boolean,
    private readonly workspacePath: () => string,
  ) {}

  /** 当前编辑器：有选区时是选区，否则是文件；没有打开磁盘上的文件时为 undefined。 */
  active(): ContextAttachment | undefined {
    return snapshotAttachment(this.workbench().activeEditor());
  }

  /** 固定当前选区（或文件），下一条消息发送时附带。没有可固定的内容时返回 false。 */
  pinActive(): boolean {
    const attachment = this.active();
    if (!attachment) return false;
    this.pinned.push({ ...attachment, id: `pin-${++this.counter}` });
    return true;
  }

  unpin(id: string): void {
    this.pinned = this.pinned.filter((p) => p.id !== id);
  }

  get hasPinned(): boolean {
    return this.pinned.length > 0;
  }

  /** 消息已经发出（或换了工作区）：固定的上下文用完了。 */
  clearPinned(): void {
    this.pinned = [];
  }

  /** 本条消息附带的上下文：固定的、额外的、当前编辑器。诊断信息只在 `diagnostics` 时附带。 */
  gather(options: GatherOptions): ContextAttachment[] {
    const active = options.includeActive !== false ? this.active() : undefined;
    const all = [...this.pinned.map(({ id: _id, ...rest }) => rest as ContextAttachment), ...(options.extra ?? []), ...(active ? [active] : [])];
    return options.diagnostics ? all : all.map(withoutDiagnostics);
  }

  /** 输入框上方的上下文标签。 */
  state(): ContextState {
    const workspacePath = this.workspacePath();
    const view = (a: ContextAttachment) => ({
      kind: a.kind,
      path: displayPath(a.path, workspacePath),
      ...(a.kind === 'selection' ? { startLine: a.startLine, endLine: a.endLine } : {}),
    });
    const active = this.active();
    return {
      ...(active ? { active: { ...view(active), key: active.kind === 'file' ? `f:${active.path}` : `s:${active.path}:${active.startLine}-${active.endLine}` } } : {}),
      includeActiveByDefault: this.includeActiveByDefault(),
      pinned: this.pinned.map((p) => ({ ...view(p), id: p.id })),
    };
  }
}

export function snapshotAttachment(editor: EditorSnapshot | undefined): ContextAttachment | undefined {
  if (!editor) return undefined;
  if (!editor.selection) return { kind: 'file', path: editor.path };
  const { startLine, endLine, text, diagnostics } = editor.selection;
  return { kind: 'selection', path: editor.path, startLine, endLine, languageId: editor.languageId, text, ...(diagnostics.length ? { diagnostics } : {}) };
}
