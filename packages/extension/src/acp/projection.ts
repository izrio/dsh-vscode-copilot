/**
 * 一个 ACP 会话的投影：把代理推送的 `session/update` 累积成界面条目（与 dsh 的投影产出相同的视图模型）。
 *
 * - 用户消息：发送时本地加入；`session/load` 回放历史时来自 user_message_chunk；
 * - 回复和推理：agent_message_chunk / agent_thought_chunk 按 messageId 拼接；
 * - 工具调用：tool_call 建立、tool_call_update 合并字段，按工具类型渲染（连续的读文件和搜索合并成一行「浏览」）；
 *   修改的 diff 内容（`{ type: 'diff', path, oldText, newText }`）用于增删行数和打开 Diff；
 *   工具名取 `name` 或 `_meta` 里的 `…/toolName`（CodeBuddy），待办工具不显示成一行，完成时带的待办表进入状态条；
 * - plan → 待办，usage_update → 上下文用量，available_commands_update → 斜杠命令，
 *   config_option_update / current_mode_update → 模型和模式，session_info_update → 标题。
 */
import { joinLabel, splitLabel, type Item, type LineStats } from '@harness-deck/shared';
import { splitContext } from '../vm/context.ts';
import { countLines, lineStats, sumStats } from '../vm/diffs.ts';
import { activityLabel, toolVariant } from '../vm/toolRows.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { t } from '../i18n.ts';

const OUTPUT_LIMIT = 4_000;

export interface AcpContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly uri?: string;
}

/** 工具调用里的内容：普通内容、修改的 diff、终端。 */
export type AcpToolContent =
  | { readonly type: 'content'; readonly content?: AcpContentBlock }
  | { readonly type: 'diff'; readonly path: string; readonly oldText?: string | null; readonly newText: string }
  | { readonly type: 'terminal'; readonly terminalId: string };

export interface AcpToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: readonly AcpToolContent[];
  readonly locations?: readonly { readonly path: string; readonly line?: number }[];
  /** 不在规范里，但 omp 等代理会带上工具名（CodeBuddy 放在 `_meta['codebuddy.ai/toolName']`）。 */
  readonly name?: string;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };

export interface AcpConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly { readonly value: string; readonly name?: string; readonly description?: string }[];
}

export interface AcpCommand {
  /** CodeBuddy 等在 `_meta.type` 里标明是不是 skill。 */
  readonly _meta?: { readonly type?: string } | null;
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly hint?: string } | null;
}

/** 本会话对一个文件的累计修改（改动栏）。 */
export interface FileChange {
  readonly path: string;
  /** 按时间顺序的修改片段（没有 diff 内容的写入不在其中）。 */
  readonly diffs: readonly AcpDiff[];
  readonly calls: readonly string[];
  /** 第一次修改是新建这个文件。 */
  readonly created: boolean;
  readonly additions: number;
  readonly deletions: number;
}

/** 一次修改的前后内容（打开 Diff 用）。 */
export interface AcpDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

/** ACP 的 kind → 用来判断渲染样式的内置工具名。 */
const KIND_TOOLS: Readonly<Record<string, string>> = {
  read: 'read',
  search: 'grep',
  execute: 'bash',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
};

export class AcpSessionProjection {
  /** 条目按出现顺序排列。 */
  private items: Item[] = [];
  /** 工具调用 id → 条目位置（合并到「浏览」行时还有在其中的位置）。 */
  private readonly toolIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, AcpToolCall>();
  private readonly messageIndex = new Map<string, number>();
  private counter = 0;
  /** 每次变化递增，控制器据此决定要不要重新推送。 */
  version = 0;

  title?: string;
  todos?: readonly Todo[];
  usage?: { readonly used: number; readonly size: number };
  commands: readonly AcpCommand[] = [];
  configOptions: readonly AcpConfigOption[] = [];
  /** 正在进行的一轮：开始时间。 */
  runningSince?: number;

  constructor(private readonly workspacePath: string) {}

  get running(): boolean {
    return this.runningSince !== undefined;
  }

  snapshotItems(): readonly Item[] {
    return this.items;
  }

  /**
   * 本会话改过的文件（输入框上方的改动栏）：完成了的修改类工具调用按文件归并，按第一次修改的先后排列。
   * 增删行数是各次修改片段的合计；`diffs` 按时间顺序，用来还原会话开始前的内容。
   */
  fileChanges(): readonly FileChange[] {
    // 流式输出时每次渲染都会调用：内容没变（version 相同）时直接用上次的结果
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private changesCache: { readonly version: number; readonly value: readonly FileChange[] } | undefined;

  private computeFileChanges(): FileChange[] {
    const files = new Map<string, { diffs: AcpDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }>();
    for (const call of this.tools.values()) {
      if (call.status !== 'completed' || this.variantOf(call) !== 'edit') continue;
      const diffs = (call.content ?? []).filter((c): c is Extract<AcpToolContent, { type: 'diff' }> => c.type === 'diff');
      const args = (call.rawInput ?? {}) as { path?: unknown; file_path?: unknown; content?: unknown };
      const fallbackPath = call.locations?.[0]?.path ?? (typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined);
      const entries: { path: string; diff?: AcpDiff; stats: LineStats }[] = diffs.length
        ? diffs.map((d) => ({ path: d.path, diff: { path: d.path, oldText: d.oldText ?? null, newText: d.newText }, stats: lineStats(d.oldText ?? '', d.newText) }))
        : fallbackPath && typeof args.content === 'string'
          ? [{ path: fallbackPath, stats: { additions: countLines(args.content), deletions: 0 } }]
          : [];
      for (const entry of entries) {
        let file = files.get(entry.path);
        if (!file) {
          file = { diffs: [], calls: [], created: entry.diff?.oldText === null, additions: 0, deletions: 0 };
          files.set(entry.path, file);
        }
        if (entry.diff) file.diffs.push(entry.diff);
        if (!file.calls.includes(call.toolCallId)) file.calls.push(call.toolCallId);
        file.additions += entry.stats.additions;
        file.deletions += entry.stats.deletions;
      }
    }
    return [...files].map(([path, f]) => ({ path, ...f }));
  }

  /** 某次工具调用的修改（打开 Diff）。 */
  diffsOf(toolCallId: string): readonly AcpDiff[] {
    const call = this.tools.get(toolCallId);
    return (call?.content ?? []).flatMap((c) => (c.type === 'diff' ? [{ path: c.path, oldText: c.oldText ?? null, newText: c.newText }] : []));
  }

  toolCall(toolCallId: string): AcpToolCall | undefined {
    return this.tools.get(toolCallId);
  }

  /** 清空（重新加载历史前）。 */
  reset(): void {
    this.items = [];
    this.toolIndex.clear();
    this.tools.clear();
    this.messageIndex.clear();
    this.runningSince = undefined;
    this.changed();
  }

  /** 发送的消息先在本地显示。 */
  addUserMessage(text: string, images: Extract<Item, { kind: 'user' }>['images'] = []): void {
    this.settleText();
    const { text: body, attachments } = splitContext(text);
    this.items.push({ kind: 'user', id: `u:${++this.counter}`, text: body, ...(attachments.length ? { attachments } : {}), ...(images.length ? { images } : {}) });
    this.changed();
  }

  startTurn(now: number): void {
    this.runningSince = now;
    this.changed();
  }

  /**
   * 一轮结束。
   * @param stopReason - end_turn / cancelled / max_tokens / max_turn_requests / refusal；出错时为 undefined。
   * @param error - prompt 请求失败的原因。
   */
  endTurn(now: number, stopReason: string | undefined, error?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
    this.items = this.items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false, ...(stopReason === 'cancelled' ? { interrupted: true } : {}) } : item));
    // 还在运行的工具调用：随这一轮结束
    for (const [id, call] of this.tools) {
      if (call.status === 'pending' || call.status === 'in_progress') this.mergeTool({ toolCallId: id, status: stopReason === 'end_turn' ? 'completed' : 'failed' });
    }
    const id = `n:${++this.counter}`;
    if (error) this.items.push({ kind: 'notice', id, level: 'error', text: t('notice.error', error) });
    else if (stopReason === 'cancelled') this.items.push({ kind: 'notice', id, level: 'info', text: t('notice.stopped') });
    else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') this.items.push({ kind: 'notice', id, level: 'warning', text: t('notice.maxTokens') });
    else if (stopReason === 'refusal') this.items.push({ kind: 'notice', id, level: 'warning', text: t('notice.refusal') });
    if (startedAt !== undefined && now - startedAt >= 1_000) {
      this.items.push({ kind: 'turnDone', id: `d:${this.counter}`, durationMs: now - startedAt, completed: stopReason === 'end_turn' && !error });
    }
    this.changed();
  }

  /** 应用一条 `session/update`。 */
  apply(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this.appendUser(update);
        break;
      case 'agent_message_chunk':
        this.appendAssistant(update, 'markdown');
        break;
      case 'agent_thought_chunk':
        this.appendAssistant(update, 'reasoning');
        break;
      case 'tool_call':
        this.addTool(withName(update as unknown as AcpToolCall));
        break;
      case 'tool_call_update': {
        const call = withName(update as unknown as AcpToolCall);
        const todos = todosOf(call);
        if (todos) this.todos = todos;
        this.mergeTool(call);
        break;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? (update.entries as { content?: unknown; status?: unknown }[]) : [];
        this.todos = entries.map((e) => ({
          content: typeof e.content === 'string' ? e.content : '',
          status: e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending',
        }));
        break;
      }
      case 'usage_update':
        if (typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0) this.usage = { used: update.used, size: update.size };
        break;
      case 'available_commands_update':
        this.commands = Array.isArray(update.availableCommands) ? (update.availableCommands as AcpCommand[]).filter((c) => typeof c?.name === 'string') : [];
        break;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) this.configOptions = update.configOptions as AcpConfigOption[];
        break;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') this.setOption('mode', update.currentModeId);
        break;
      case 'session_info_update':
        if (typeof update.title === 'string' && update.title.trim()) this.title = update.title.trim();
        break;
      default:
        return;
    }
    this.changed();
  }

  setConfigOptions(options: readonly AcpConfigOption[] | undefined): void {
    if (!options) return;
    this.configOptions = options;
    this.changed();
  }

  private setOption(category: string, value: string): void {
    this.configOptions = this.configOptions.map((o) => (o.category === category || o.id === category ? { ...o, currentValue: value } : o));
  }

  private changed(): void {
    this.version++;
  }

  private appendUser(update: Record<string, unknown>): void {
    const text = blockText(update.content);
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
    const at = messageId ? this.messageIndex.get(messageId) : undefined;
    const previous = at !== undefined ? this.items[at] : undefined;
    if (previous?.kind === 'user') {
      // 同一条消息的后续片段：把原文（含上下文块）重新拆分
      const raw = (rawUser.get(previous) ?? previous.text) + text;
      const { text: body, attachments } = splitContext(raw);
      const next: Item = { ...previous, text: body, ...(attachments.length ? { attachments } : {}) };
      rawUser.set(next, raw);
      this.items[at!] = next;
      return;
    }
    const { text: body, attachments } = splitContext(text);
    const item: Item = { kind: 'user', id: `u:${++this.counter}`, text: body, ...(attachments.length ? { attachments } : {}) };
    rawUser.set(item, text);
    if (messageId) this.messageIndex.set(messageId, this.items.length);
    this.items.push(item);
  }

  private appendAssistant(update: Record<string, unknown>, field: 'markdown' | 'reasoning'): void {
    const text = blockText(update.content);
    if (!text) return;
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
    let at = messageId ? this.messageIndex.get(messageId) : undefined;
    const last = this.items.length - 1;
    // 同一个 messageId 的文字只接在最后一条后面：中间隔了工具调用时另起一条，保持时间顺序。
    // 有的模型网关每次回复都给同一个消息 id，不这样后面的文字会拼到最上面那条里，看起来像没说话。
    if (at !== undefined && at !== last) at = undefined;
    // 推理和正文的 messageId 可能不同：紧跟在只有推理的条目后面的正文归到同一条；没有 messageId 的片段接在上一条回复后面
    const lastItem = this.items[last];
    if (at === undefined && lastItem?.kind === 'assistant' && (lastItem.markdown === '' || !messageId)) at = last;
    if (at === undefined) {
      at = this.items.length;
      this.items.push({ kind: 'assistant', id: `a:${++this.counter}${messageId ? `:${messageId}` : ''}`, markdown: '', streaming: this.running });
    }
    if (messageId) this.messageIndex.set(messageId, at);
    const previous = this.items[at] as Extract<Item, { kind: 'assistant' }>;
    this.items[at] = field === 'markdown' ? { ...previous, markdown: previous.markdown + text } : { ...previous, reasoning: (previous.reasoning ?? '') + text };
  }

  private addTool(call: AcpToolCall): void {
    if (this.tools.has(call.toolCallId)) {
      this.mergeTool(call);
      return;
    }
    this.tools.set(call.toolCallId, call);
    // 待办由输入框上方的状态条显示，不在对话流里重复
    if (isTodoTool(call)) return;
    this.settleText();
    if (this.variantOf(call) === 'explore') {
      this.addExplore(call);
      return;
    }
    this.toolIndex.set(call.toolCallId, { index: this.items.length });
    this.items.push(this.activity(call));
  }

  /** 后面出现了工具调用或新消息：前面的回复不再是正在输出的那条（不再显示光标）。 */
  private settleText(): void {
    if (!this.items.some((item) => item.kind === 'assistant' && item.streaming)) return;
    this.items = this.items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item));
  }

  private addExplore(call: AcpToolCall): void {
    const entry = this.exploreEntry(call);
    const last = this.items.length - 1;
    if (this.items[last]?.kind === 'explore') {
      const group = this.items[last] as Explore;
      this.toolIndex.set(call.toolCallId, { index: last, entry: group.entries.length });
      this.items[last] = summarize({ ...group, entries: [...group.entries, entry] });
    } else {
      this.toolIndex.set(call.toolCallId, { index: this.items.length, entry: 0 });
      this.items.push(summarize({ kind: 'explore', id: `x:${call.toolCallId}`, summary: '', status: 'running', entries: [entry] }));
    }
  }

  private mergeTool(update: AcpToolCall): void {
    const previous = this.tools.get(update.toolCallId);
    if (!previous) {
      this.addTool(update);
      return;
    }
    const merged: AcpToolCall = {
      ...previous,
      ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined && v !== null)),
      ...keepDiffs(previous.content, update.content),
    } as AcpToolCall;
    this.tools.set(update.toolCallId, merged);
    const at = this.toolIndex.get(update.toolCallId);
    if (!at) return;
    const item = this.items[at.index];
    // 先只发了工具调用、后面才知道是读文件或搜索（CodeBuddy 第一帧的 kind 是 other）：改成「浏览」
    if (item?.kind === 'activity' && this.variantOf(merged) === 'explore') {
      if (at.index === this.items.length - 1) {
        this.items.pop();
        this.addExplore(merged);
      } else {
        this.items[at.index] = summarize({ kind: 'explore', id: `x:${merged.toolCallId}`, summary: '', status: 'running', entries: [this.exploreEntry(merged)] });
        this.toolIndex.set(merged.toolCallId, { index: at.index, entry: 0 });
      }
      return;
    }
    if (item?.kind === 'explore' && at.entry !== undefined) {
      const entries = item.entries.map((e, i) => (i === at.entry ? this.exploreEntry(merged) : e));
      this.items[at.index] = summarize({ ...item, entries });
    } else if (item?.kind === 'activity') {
      this.items[at.index] = this.activity(merged);
    }
  }

  private variantOf(call: AcpToolCall): 'command' | 'edit' | 'explore' | 'generic' {
    const byName = call.name ? toolVariant(call.name) : 'generic';
    if (byName !== 'generic' && byName !== 'subagent') return byName;
    const byKind = call.kind ? KIND_TOOLS[call.kind] : undefined;
    const variant = byKind ? toolVariant(byKind) : 'generic';
    return variant === 'subagent' ? 'generic' : variant;
  }

  /** 浏览行里的一步；读文件的那一步带上路径，点它打开文件。 */
  private exploreEntry(call: AcpToolCall): Explore['entries'][number] {
    const args = (call.rawInput ?? {}) as { path?: unknown; file_path?: unknown };
    const path = call.kind === 'read' ? (call.locations?.[0]?.path ?? (typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined)) : undefined;
    return { id: call.toolCallId, label: this.label(call), status: statusOf(call.status), ...(path ? { path: displayPath(path, this.workspacePath) } : {}) };
  }

  private label(call: AcpToolCall): string {
    const name = call.name ?? call.kind ?? 'tool';
    const args = call.rawInput && typeof call.rawInput === 'object' ? (call.rawInput as Record<string, unknown>) : {};
    const fromArgs = activityLabel(name, args, this.workspacePath);
    if (fromArgs !== name) return fromArgs;
    const path = call.locations?.[0]?.path;
    if (path) return joinLabel(name, displayPath(path, this.workspacePath));
    // 标题里常带着工具名（「read: README.md」），去掉重复的前缀
    const title = (call.title ?? '').replace(new RegExp(`^${escapeRegExp(name)}:?\\s*`, 'u'), '');
    return joinLabel(name, title);
  }

  private activity(call: AcpToolCall): Activity {
    const variant = this.variantOf(call);
    const status = statusOf(call.status);
    const base = { kind: 'activity' as const, id: `t:${call.toolCallId}`, tool: call.name ?? call.kind ?? 'tool', status };
    const output = outputOf(call);
    if (variant === 'command') {
      const args = (call.rawInput ?? {}) as { command?: unknown };
      const command = typeof args.command === 'string' ? args.command.split('\n', 1)[0] : (call.title ?? '').replace(/^\$\s*/u, '');
      return { ...base, variant, label: joinLabel(base.tool, command), ...(output ? { output } : {}) };
    }
    if (variant === 'edit') {
      const diffs = (call.content ?? []).filter((c): c is Extract<AcpToolContent, { type: 'diff' }> => c.type === 'diff');
      const args = (call.rawInput ?? {}) as { path?: unknown; file_path?: unknown; content?: unknown };
      const path = diffs[0]?.path ?? call.locations?.[0]?.path ?? (typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined);
      const label = path ? displayPath(path, this.workspacePath) : (call.title ?? base.tool);
      let stats: LineStats | undefined;
      let created = false;
      if (diffs.length) {
        stats = sumStats(diffs.map((d) => lineStats(d.oldText ?? '', d.newText)));
        created = diffs.every((d) => d.oldText === null || d.oldText === undefined);
      } else if (status === 'ok' && typeof args.content === 'string') {
        stats = { additions: countLines(args.content), deletions: 0 };
      }
      return {
        ...base,
        variant,
        label,
        ...(stats && status === 'ok' ? { stats } : {}),
        ...(created && status === 'ok' ? { created } : {}),
        ...(diffs.length && status === 'ok' ? { diff: { kind: 'tool' as const, callId: call.toolCallId } } : {}),
        ...(status === 'error' && output ? { output } : {}),
      };
    }
    return { ...base, variant: 'generic', label: this.label(call), ...(output ? { output } : {}) };
  }
}

/** 用户消息的原文（含上下文块），拼接后续片段时用。 */
const rawUser = new WeakMap<Item, string>();

function statusOf(status: string | undefined): 'running' | 'ok' | 'error' {
  return status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'running';
}

function blockText(content: unknown): string {
  const block = content as AcpContentBlock | undefined;
  if (!block) return '';
  if (block.type === 'text') return block.text ?? '';
  if (block.type === 'resource_link') return block.uri ? `@${block.uri}` : '';
  return '';
}

/** 新内容替换旧内容，但之前的修改内容（diff）保留：CodeBuddy 完成时只发「已写入」这样的文字。 */
function keepDiffs(previous: readonly AcpToolContent[] | undefined, next: readonly AcpToolContent[] | undefined): { content?: readonly AcpToolContent[] } {
  if (!next || next.some((c) => c.type === 'diff')) return {};
  const diffs = (previous ?? []).filter((c) => c.type === 'diff');
  return diffs.length ? { content: [...diffs, ...next] } : {};
}

/** 工具名：`name`，或 `_meta` 里以 `toolName` 结尾的键（CodeBuddy：`codebuddy.ai/toolName`）。 */
function withName(call: AcpToolCall): AcpToolCall {
  if (call.name || !call._meta) return call;
  const key = Object.keys(call._meta).find((k) => k === 'toolName' || k.endsWith('/toolName'));
  const name = key ? call._meta[key] : undefined;
  return typeof name === 'string' && name ? { ...call, name } : call;
}

function isTodoTool(call: AcpToolCall): boolean {
  return call.name !== undefined && canonicalTool(call.name) === 'todo_write';
}

/** 待办工具完成时带的整张待办表（CodeBuddy：`_meta['codebuddy.ai/rawResponse'].todos`）。 */
function todosOf(call: AcpToolCall): Todo[] | undefined {
  if (!call._meta) return undefined;
  for (const [key, value] of Object.entries(call._meta)) {
    if (!key.endsWith('rawResponse') || !value || typeof value !== 'object') continue;
    const todos = (value as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) continue;
    return (todos as { content?: unknown; subject?: unknown; status?: unknown }[]).map((e) => ({
      content: typeof e.content === 'string' ? e.content : typeof e.subject === 'string' ? e.subject : '',
      status: e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending',
    }));
  }
  return undefined;
}

/**
 * CodeBuddy 的命令结果：`Stdout: …\n\nStderr: …\nExit Code: N\nSignal: …`，只留下输出本身。
 * 其他格式原样返回。
 */
function commandText(text: string): string {
  const match = /^Stdout: ?([\s\S]*?)\n\nStderr: ?([\s\S]*?)\nExit Code: ?(\S*)(?:\nSignal: ?[\s\S]*)?$/u.exec(text);
  if (!match) return text;
  const stdout = match[1]?.replace(/\r\n/gu, '\n') ?? '';
  const stderr = match[2] === '(empty)' ? '' : (match[2] ?? '');
  const code = match[3] && match[3] !== '0' && match[3] !== '(none)' ? `\nexit ${match[3]}` : '';
  return [stdout === '(empty)' ? '' : stdout, stderr].filter(Boolean).join('\n') + code;
}

/** 内容里的文字只是把参数原样回显（CodeBuddy 参数生成完时会发一次）。 */
function echoesInput(text: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const args = input as Record<string, unknown>;
  if (typeof args.description === 'string' && text === args.description) return true;
  if (!text.startsWith('{')) return false;
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(input);
  } catch {
    return false;
  }
}

/**
 * 工具输出：优先取代理给的原始输出（omp 把命令的标准输出放在 rawOutput.content，CodeBuddy 放在 rawOutput.text），
 * 否则取内容里的文字。
 */
function outputOf(call: AcpToolCall): string | undefined {
  const raw = call.rawOutput as { content?: unknown; output?: unknown; stdout?: unknown; text?: unknown } | string | undefined;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw && Array.isArray(raw.content)) text = (raw.content as AcpContentBlock[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
  else if (raw && typeof raw.output === 'string') text = raw.output;
  else if (raw && typeof raw.stdout === 'string') text = raw.stdout;
  else if (raw && typeof raw.text === 'string') text = raw.text;
  if (!text) {
    text = (call.content ?? [])
      .map((c) => (c.type === 'content' ? blockText(c.content) : ''))
      .filter((line) => line && !line.startsWith('$ ') && !echoesInput(line, call.rawInput))
      .join('\n');
  }
  text = commandText(text).trim();
  if (!text) return undefined;
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n${t('output.truncated')}` : text;
}

function summarize(group: Explore): Explore {
  let reads = 0;
  let searches = 0;
  for (const entry of group.entries) {
    const tool = splitLabel(entry.label).name;
    if (/read|cat|view/iu.test(tool)) reads++;
    else searches++;
  }
  const parts = [reads ? t('explore.reads', reads) : '', searches ? t('explore.searches', searches) : ''].filter(Boolean);
  const statuses = group.entries.map((e) => e.status);
  const status = statuses.includes('running') ? 'running' : statuses.every((s) => s === 'error') ? 'error' : 'ok';
  return { ...group, summary: parts.join(t('explore.separator')), status };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
