/**
 * 用 vscode API 实现控制器需要的编辑器能力：打开 Diff、跟踪未保存文件、模态确认。
 *
 * Diff 的左侧（修改前）或右侧（将要写入）不是磁盘上的文件，由 `dsh-diff:` 只读文档提供。
 * 能还原出完整的修改前内容时用 VS Code 的 Diff 编辑器，右侧是磁盘上的真实文件，可以直接继续编辑；
 * 还原不了（文件之后又被改过）时退回只读的统一 diff 文本。还原算法见 vm/diffs.ts。
 */
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { FileCandidate } from '@dsh-copilot/shared';
import { SELECTION_LIMIT } from '../vm/context.ts';
import { proposedContent, reverseHunks, reverseToolDiffs, unifiedFromHunks, unifiedFromToolDiffs } from '../vm/diffs.ts';
import type { DiffRequest, EditorSnapshot, Workbench } from '../vm/workbench.ts';
import { t } from '../i18n.ts';
import { describeError as describe } from '../util/errors.ts';

export const DIFF_SCHEME = 'dsh-diff';
/** 只保留最近打开过的虚拟文档内容。 */
const MAX_DOCUMENTS = 64;

export class VscodeWorkbench implements Workbench, vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;
  private dirty: readonly string[] = [];

  constructor(private readonly log: (line: string) => void) {}

  /**
   * 注册内容提供方，以及未保存状态、当前编辑器和选区的监听。
   * @param onChange - 未保存文件集合、当前编辑器或选区变化时调用（选区变化合并到 150ms 一次）。
   */
  register(onChange: () => void): vscode.Disposable {
    const onDirtyChange = onChange;
    let editorTimer: ReturnType<typeof setTimeout> | undefined;
    const editorChanged = (): void => {
      if (editorTimer) clearTimeout(editorTimer);
      editorTimer = setTimeout(onChange, 150);
    };
    const refresh = (): void => {
      const next = vscode.workspace.textDocuments
        .filter((doc) => doc.isDirty && doc.uri.scheme === 'file')
        .map((doc) => doc.uri.fsPath)
        .sort();
      if (next.length === this.dirty.length && next.every((path, i) => path === this.dirty[i])) return;
      this.dirty = next;
      onDirtyChange();
    };
    refresh();
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
      vscode.workspace.onDidChangeTextDocument(refresh),
      vscode.workspace.onDidSaveTextDocument(refresh),
      vscode.workspace.onDidCloseTextDocument(refresh),
      vscode.workspace.onDidOpenTextDocument(refresh),
      vscode.window.onDidChangeActiveTextEditor(editorChanged),
      vscode.window.onDidChangeTextEditorSelection(editorChanged),
      { dispose: () => editorTimer && clearTimeout(editorTimer) },
    );
  }

  activeEditor(): EditorSnapshot | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const { document, selection } = editor;
    const snapshot = { path: document.uri.fsPath, languageId: document.languageId };
    if (selection.isEmpty) return snapshot;
    const startLine = selection.start.line + 1;
    // 选到下一行行首时，那一行不算在选区里
    const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
    // 只取上限多一点的内容，过长的选区在拼消息时截断
    const end = document.offsetAt(selection.end);
    const start = document.offsetAt(selection.start);
    const text = document.getText(new vscode.Range(selection.start, document.positionAt(Math.min(end, start + SELECTION_LIMIT + 1))));
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.intersection(selection) !== undefined)
      .slice(0, 20)
      .map((d) => {
        const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        const code = typeof d.code === 'object' ? d.code.value : d.code;
        const source = [d.source, code].filter((x) => x !== undefined && x !== '').join(' ');
        return `${d.range.start.line + 1}: ${severity}${source ? ` ${source}` : ''}: ${d.message.split('\n', 1)[0]}`;
      });
    return { ...snapshot, selection: { startLine, endLine, text, diagnostics } };
  }

  async findFiles(query: string): Promise<FileCandidate[]> {
    const escaped = query.trim().replace(/[[\]{}*?!]/gu, '');
    const pattern = escaped ? `**/*${escaped}*` : '**/*';
    const uris = await vscode.workspace.findFiles(pattern, undefined, 50);
    return uris
      .map((uri) => ({ path: vscode.workspace.asRelativePath(uri, false), kind: 'file' as const }))
      .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dirtyFiles(): readonly string[] {
    return this.dirty;
  }

  async saveAll(): Promise<void> {
    await vscode.workspace.saveAll(false);
  }

  input(options: {
    readonly title: string;
    readonly prompt?: string;
    readonly value?: string;
    readonly placeHolder?: string;
    readonly password?: boolean;
  }): Promise<string | undefined> {
    return Promise.resolve(
      vscode.window.showInputBox({
        title: options.title,
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.value !== undefined ? { value: options.value } : {}),
        ...(options.placeHolder ? { placeHolder: options.placeHolder } : {}),
        password: options.password ?? false,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : t('input.required')),
      }),
    );
  }

  /** 插入到最近使用的文本编辑器（Webview 获得焦点后 activeTextEditor 可能为空，退回第一个可见编辑器）。 */
  async insertText(text: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) return false;
    const applied = await editor.edit((edit) => {
      for (const selection of editor.selections) edit.replace(selection, text);
    });
    if (applied) await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    return applied;
  }

  async confirm(message: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  async openFile(path: string, range?: { readonly startLine: number; readonly endLine?: number }): Promise<void> {
    const uri = vscode.Uri.file(path);
    try {
      if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      }
      const selection = range ? new vscode.Range(range.startLine - 1, 0, (range.endLine ?? range.startLine) - 1, Number.MAX_SAFE_INTEGER) : undefined;
      await vscode.window.showTextDocument(uri, { preview: true, ...(selection ? { selection } : {}) });
    } catch (error) {
      void vscode.window.showWarningMessage(t('open.failed', basename(path), describe(error)));
    }
  }

  async openDiff(request: DiffRequest): Promise<void> {
    const file = vscode.Uri.file(request.path);
    const name = basename(request.path);
    switch (request.kind) {
      case 'tool': {
        if (request.created) return this.diff(this.virtual(request.path, 'empty', ''), file, t('diff.created', name));
        const current = await this.read(file);
        const before = current === undefined ? undefined : reverseToolDiffs(current, request.diffs);
        if (before !== undefined) return this.diff(this.virtual(request.path, 'before', before), file, t('diff.toolTitle', name));
        return this.showUnified(request.path, unifiedFromToolDiffs(name, request.diffs));
      }
      case 'turn': {
        if (!request.after) {
          const before = reverseHunks('', request.hunks) ?? '';
          return this.diff(this.virtual(request.path, 'before', before), this.virtual(request.path, 'deleted', ''), t('diff.deleted', name));
        }
        if (!request.before) return this.diff(this.virtual(request.path, 'empty', ''), file, t('diff.created', name));
        const current = await this.read(file);
        const before = current === undefined ? undefined : reverseHunks(current, request.hunks);
        if (before !== undefined) return this.diff(this.virtual(request.path, 'before', before), file, t('diff.turnTitle', name));
        return this.showUnified(request.path, unifiedFromHunks(name, request.hunks));
      }
      case 'proposed': {
        const current = await this.read(file);
        const proposed = proposedContent(request.tool, request.args, current);
        if (proposed === undefined) {
          void vscode.window.showInformationMessage(t('diff.cannotPreview', name));
          return;
        }
        const left = current === undefined ? this.virtual(request.path, 'empty', '') : file;
        return this.diff(left, this.virtual(request.path, 'proposed', proposed), t('diff.proposedTitle', name));
      }
    }
  }

  private async diff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /** 文件之后又被改过、还原不出修改前内容时，显示这次修改的片段。 */
  private async showUnified(path: string, text: string): Promise<void> {
    this.log(`无法还原 ${path} 修改前的内容（文件之后又被修改过），改为显示修改片段`);
    const uri = this.virtual(`${path}.diff`, 'patch', text);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'diff');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** 虚拟文档的 URI 保留原文件路径，VS Code 据此选择语言高亮；query 区分同一文件的不同版本。 */
  private virtual(path: string, label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.file(path).with({ scheme: DIFF_SCHEME, query: `${label}-${++this.counter}` });
    this.contents.set(uri.toString(), content);
    while (this.contents.size > MAX_DOCUMENTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    return uri;
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined; // 文件不存在
    }
  }
}
