/**
 * 控制器需要的编辑器能力（打开 Diff、未保存文件、确认框）。由 extension.ts 用 vscode API 实现，测试里用假的。
 */
import type { FileCandidate } from '@dsh-copilot/shared';
import type { Hunk, ToolDiff } from './diffs.ts';

/** 要打开的 Diff。路径都是绝对路径。 */
export type DiffRequest =
  /** 单次工具调用的修改：从当前文件反向应用片段得到修改前内容。 */
  | { readonly kind: 'tool'; readonly path: string; readonly diffs: readonly ToolDiff[]; readonly created: boolean }
  /** 一轮的改动：从当前文件反向应用 hunk。 */
  | { readonly kind: 'turn'; readonly path: string; readonly before: boolean; readonly after: boolean; readonly hunks: readonly Hunk[] }
  /** 审批前预览：按工具参数算出修改后的内容。 */
  | { readonly kind: 'proposed'; readonly path: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> };

/** 当前编辑器（只算磁盘上的文件）。 */
export interface EditorSnapshot {
  /** 绝对路径。 */
  readonly path: string;
  readonly languageId: string;
  /** 非空选区；多个选区时取第一个。 */
  readonly selection?: {
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
    /** 与选区重叠的诊断信息，例如 `12: error TS2322: …`。 */
    readonly diagnostics: readonly string[];
  };
}

export interface Workbench {
  openDiff(request: DiffRequest): Promise<void>;
  /** 打开文件（目录在资源管理器里显示），可以选中一段行。 */
  openFile(path: string, range?: { readonly startLine: number; readonly endLine?: number }): Promise<void>;
  activeEditor(): EditorSnapshot | undefined;
  /** 新对话还没有 dsh 会话时，`@` 补全用 VS Code 的文件搜索。 */
  findFiles(query: string): Promise<FileCandidate[]>;
  /** 有未保存内容的文件（绝对路径）。 */
  dirtyFiles(): readonly string[];
  saveAll(): Promise<void>;
  /** 模态确认框。 */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
}

/** 测试和没有编辑器时用的空实现。 */
export const noWorkbench: Workbench = {
  openDiff: () => Promise.resolve(),
  openFile: () => Promise.resolve(),
  activeEditor: () => undefined,
  findFiles: () => Promise.resolve([]),
  dirtyFiles: () => [],
  saveAll: () => Promise.resolve(),
  confirm: () => Promise.resolve(false),
};
