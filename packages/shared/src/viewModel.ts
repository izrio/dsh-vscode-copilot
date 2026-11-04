/**
 * 界面视图模型。由 Extension Host 从 dsh 会话数据投影得到，Webview 只负责渲染。
 * 这里的类型是插件自己的，不直接暴露 dsh 的事件结构（docs/DESIGN.md D8）。
 */

/** 打开某个改动的 Diff：单次工具调用（来自会话日志，长期可用）或本轮汇总里的一个文件（Host 内存中）。 */
export type DiffRef = { readonly kind: 'tool'; readonly callId: string } | { readonly kind: 'turn'; readonly seq: number; readonly index: number };

export interface LineStats {
  readonly additions: number;
  readonly deletions: number;
}

export interface ChangedFileView extends Partial<LineStats> {
  /** 工作区相对路径（工作区外为绝对路径）。 */
  readonly path: string;
  readonly ref: DiffRef;
  readonly created?: boolean;
  readonly flags?: readonly ('binary' | 'oversized')[];
}

/**
 * 附带给 dsh 的编辑器上下文：当前文件（只给路径，dsh 需要时自己读）或选中的代码（带内容和行号）。
 * `path` 是工作区相对路径（工作区外为绝对路径）。
 */
export interface AttachmentView {
  readonly kind: 'file' | 'selection';
  readonly path: string;
  /** 选区的起止行（从 1 开始）。 */
  readonly startLine?: number;
  readonly endLine?: number;
}

/** 输入框上方的上下文标签。 */
export interface ContextState {
  /** 当前编辑器：有选区时是选区，否则是文件。`key` 变化时 Webview 恢复默认的附带状态。 */
  readonly active?: AttachmentView & { readonly key: string };
  /** 默认是否附带当前编辑器（设置 `dsh.context.includeActiveEditor`）。 */
  readonly includeActiveByDefault: boolean;
  /** 用「添加到对话」固定下来的选区，发送后清空。 */
  readonly pinned: readonly (AttachmentView & { readonly id: string })[];
}

/** 斜杠命令：插件自带的模板，或 dsh 原生命令。 */
export interface CommandView {
  readonly name: string;
  readonly description: string;
  /** 参数提示，例如 `<text>`。 */
  readonly hint?: string;
  readonly source: 'plugin' | 'dsh';
}

/** `@` 补全的候选。 */
export interface FileCandidate {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

/** 对话流中的一个条目。`id` 在同一个会话内稳定，Webview 按 id 增量更新。 */
export type Item =
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly text: string;
      /** 本地回显的状态：发送中 / 已被 dsh 接收但还在排队 / 发送失败。持久消息没有这个字段。 */
      readonly pending?: 'sending' | 'queued' | 'failed';
      readonly requestId?: string;
      readonly error?: string;
      /** 随消息附带的编辑器上下文（从消息末尾的上下文块解析出来，正文里不显示）。 */
      readonly attachments?: readonly AttachmentView[];
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly markdown: string;
      readonly reasoning?: string;
      /** 正在流式输出。 */
      readonly streaming: boolean;
      /** 用户停止生成后保留下来的部分回复。 */
      readonly interrupted?: boolean;
    }
  | {
      readonly kind: 'activity';
      readonly id: string;
      readonly tool: string;
      /** 渲染样式：命令、文件修改、其他。 */
      readonly variant: 'command' | 'edit' | 'generic';
      /** 一行摘要，例如 `bash  pnpm test`、`write  src/a.ts`。 */
      readonly label: string;
      readonly status: 'running' | 'ok' | 'error';
      /** 展开后显示的结果文本（已截断）。 */
      readonly output?: string;
      /** 文件修改的增删行数。 */
      readonly stats?: LineStats;
      /** 新建文件。 */
      readonly created?: boolean;
      /** 可以打开 Diff。 */
      readonly diff?: DiffRef;
    }
  | {
      /** 连续的只读操作（读文件、搜索）合并成一行。 */
      readonly kind: 'explore';
      readonly id: string;
      readonly summary: string;
      readonly status: 'running' | 'ok' | 'error';
      readonly entries: readonly { readonly id: string; readonly label: string; readonly status: 'running' | 'ok' | 'error' }[];
    }
  | {
      /** 一轮结束时的改动汇总。 */
      readonly kind: 'changes';
      readonly id: string;
      readonly turn: number;
      /** turn：dsh 记录的本轮改动（含命令造成的）；tools：Host 重启后汇总不可用，退回按文件工具汇总。 */
      readonly source: 'turn' | 'tools';
      readonly files: readonly ChangedFileView[];
      readonly total: number;
    }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly level: 'info' | 'warning' | 'error';
      readonly text: string;
      /** 可选的处理入口，例如缺少 API Key 时打开 dsh 设置。 */
      readonly action?: { readonly kind: 'openWebUI'; readonly label: string };
    };

export interface QuestionView {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly detail?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
}

/** 等待用户处理的请求，显示在对话流末尾。 */
export type PendingInteraction =
  | {
      readonly kind: 'approval';
      readonly id: string;
      readonly toolName: string;
      /** dsh 给出的原因（优先中文）。 */
      readonly reason: string;
      /** 要执行的命令或要修改的文件。 */
      readonly subject?: string;
      readonly subjectKind?: 'command' | 'file';
      /** 能预览将要写入的内容。 */
      readonly previewable: boolean;
      /** 要修改的文件在 VS Code 里有未保存内容：先保存或放弃，避免冲突。 */
      readonly dirtyFiles: readonly string[];
    }
  | {
      readonly kind: 'question';
      readonly id: string;
      readonly questions: readonly QuestionView[];
    };

export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly running: boolean;
  /** 有等待处理的审批或提问。 */
  readonly needsAttention?: boolean;
}

export interface ModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly group: string;
  readonly description?: string;
  readonly efforts: readonly { readonly id: string; readonly name: string }[];
  readonly defaultEffort?: string;
}

export interface ModelState {
  readonly options: readonly ModelOption[];
  readonly current?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
}

export interface PermissionState {
  /** dsh 的权限预设目录（read-only、workspace-write、danger-full-access 及用户自定义的）。 */
  readonly options: readonly string[];
  /** 当前会话的预设；不匹配任何预设时为 custom。 */
  readonly current?: string;
}

/** 当前会话（或尚未创建的新对话）的元信息。 */
export interface SessionHeader {
  /** undefined 表示新对话：第一条消息发送时才在 dsh 里创建会话。 */
  readonly id?: string;
  readonly title: string;
  readonly running: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** 与 dsh 的同步状态。 */
  readonly sync: 'idle' | 'opening' | 'live' | 'disconnected' | 'failed';
  readonly failure?: string;
  /** 上下文窗口占用比例，0–1。 */
  readonly contextUsage?: number;
  /** 计划模式（`/plan`）：dsh 只做计划，不改文件。 */
  readonly planMode?: boolean;
}

export interface WorkspaceState {
  /** 工作区里有未保存内容的文件数。 */
  readonly dirtyFiles: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected';
