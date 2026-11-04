/**
 * 用 vscode API 实现控制器需要的编辑器能力：打开 Diff、跟踪未保存文件、模态确认。
 *
 * Diff 的左侧（修改前）或右侧（将要写入）不是磁盘上的文件，由 `dsh-diff:` 只读文档提供。
 * 能还原出完整的修改前内容时用 VS Code 的 Diff 编辑器，右侧是磁盘上的真实文件，可以直接继续编辑；
 * 还原不了（文件之后又被改过）时退回只读的统一 diff 文本。还原算法见 vm/diffs.ts。
 */
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { proposedContent, reverseHunks, reverseToolDiffs, unifiedFromHunks, unifiedFromToolDiffs } from '../vm/diffs.ts';
import type { DiffRequest, Workbench } from '../vm/workbench.ts';

export const DIFF_SCHEME = 'dsh-diff';
/** 只保留最近打开过的虚拟文档内容。 */
const MAX_DOCUMENTS = 64;

export class VscodeWorkbench implements Workbench, vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;
  private dirty: readonly string[] = [];

  constructor(private readonly log: (line: string) => void) {}

  /**
   * 注册内容提供方和未保存状态的监听。
   * @param onDirtyChange - 有未保存内容的文件集合变化时调用。
   */
  register(onDirtyChange: () => void): vscode.Disposable {
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
    );
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

  async confirm(message: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  async openFile(path: string): Promise<void> {
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true });
    } catch (error) {
      void vscode.window.showWarningMessage(`无法打开 ${basename(path)}：${describe(error)}`);
    }
  }

  async openDiff(request: DiffRequest): Promise<void> {
    const file = vscode.Uri.file(request.path);
    const name = basename(request.path);
    switch (request.kind) {
      case 'tool': {
        if (request.created) return this.diff(this.virtual(request.path, 'empty', ''), file, `${name}（新建）`);
        const current = await this.read(file);
        const before = current === undefined ? undefined : reverseToolDiffs(current, request.diffs);
        if (before !== undefined) return this.diff(this.virtual(request.path, 'before', before), file, `${name}（修改前 ↔ 当前）`);
        return this.showUnified(request.path, unifiedFromToolDiffs(name, request.diffs));
      }
      case 'turn': {
        if (!request.after) {
          const before = reverseHunks('', request.hunks) ?? '';
          return this.diff(this.virtual(request.path, 'before', before), this.virtual(request.path, 'deleted', ''), `${name}（已删除）`);
        }
        if (!request.before) return this.diff(this.virtual(request.path, 'empty', ''), file, `${name}（新建）`);
        const current = await this.read(file);
        const before = current === undefined ? undefined : reverseHunks(current, request.hunks);
        if (before !== undefined) return this.diff(this.virtual(request.path, 'before', before), file, `${name}（本轮修改前 ↔ 当前）`);
        return this.showUnified(request.path, unifiedFromHunks(name, request.hunks));
      }
      case 'proposed': {
        const current = await this.read(file);
        const proposed = proposedContent(request.tool, request.args, current);
        if (proposed === undefined) {
          void vscode.window.showInformationMessage(`无法预览对 ${name} 的修改：要替换的内容在文件里找不到或不唯一`);
          return;
        }
        const left = current === undefined ? this.virtual(request.path, 'empty', '') : file;
        return this.diff(left, this.virtual(request.path, 'proposed', proposed), `${name}（当前 ↔ 将要写入）`);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
