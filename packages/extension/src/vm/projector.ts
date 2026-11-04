/**
 * 会话事件 → 界面条目（纯函数）。规则见 docs/DESIGN.md 5.2。
 *
 * - 只渲染 `surfaceOp` 为 append（或不带 surfaceOp）的消息事件，与 dsh Web UI 一致；
 * - 用户消息只取 `source.kind === 'user'` 的那条，dsh 注入的上下文消息不显示；
 * - 没有正文也没有推理的助手消息不渲染（不出现空占位）；
 * - 工具调用按类型渲染：命令一行、文件修改带增删行数、连续的只读操作合并成一行「浏览」；
 * - 一轮结束时的 `workspace/changes` 渲染成改动汇总卡片（汇总内容由调用方从 Host 读取后传入）。
 */
import type { ChangedFileView, Item, LineStats } from '@dsh-copilot/shared';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChangesSummary } from '../dsh/DshClient.ts';
import type { PendingPrompt } from '../dsh/SessionService.ts';
import { liveBlocksText, type WireEvent } from '../dsh/remote/follow.ts';
import type { LiveAttempt } from '../dsh/session/journal.ts';
import { countLines, lineStats, sumStats, type ToolDiff } from './diffs.ts';

/** 某一轮改动汇总的读取结果：还没读到时为 undefined。 */
export type ChangesLookup = (seq: number) => ChangesSummary | 'unavailable' | undefined;

export interface ProjectionInput {
  readonly events: readonly WireEvent[];
  readonly live?: LiveAttempt;
  readonly pending: readonly PendingPrompt[];
  /**
   * follow 流还没就绪时，用会话列表里的缓存状态判断是否在运行；
   * 就绪后以事件日志里的 turn/start、turn/end 为准（实时，不会滞后）。
   */
  readonly fallbackRunning?: boolean;
  /** 用于把工具参数里的绝对路径显示成相对路径。 */
  readonly workspacePath?: string;
  readonly changes?: ChangesLookup;
}

/** 一次工具调用的原始信息，用于打开 Diff 和显示审批详情。 */
export interface ToolCallInfo {
  readonly callId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** 目标文件的绝对路径（文件类工具）。 */
  readonly path?: string;
  readonly status: 'running' | 'ok' | 'error';
  /** 文件修改的片段（`tool/result.meta.diffs`）。 */
  readonly diffs?: readonly ToolDiff[];
  readonly created?: boolean;
}

export interface Projection {
  readonly items: Item[];
  /** 已经出现在持久历史里的 requestId，用于撤掉本地回显。 */
  readonly persistedRequestIds: ReadonlySet<string>;
  /** 最后一个 turn/start 之后没有 turn/end。 */
  readonly turnOpen: boolean;
  readonly toolCalls: ReadonlyMap<string, ToolCallInfo>;
  /** 出现过的 `workspace/changes` 事件序号，调用方据此读取改动汇总。 */
  readonly changeSeqs: readonly number[];
}

const OUTPUT_LIMIT = 4_000;

const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'shell']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);
const EXPLORE_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'ls', 'list']);

export function toolVariant(tool: string): 'command' | 'edit' | 'explore' | 'generic' {
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (EXPLORE_TOOLS.has(tool)) return 'explore';
  return 'generic';
}

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

type Explore = Extract<Item, { kind: 'explore' }>;
type Activity = Extract<Item, { kind: 'activity' }>;

interface TurnEdit {
  readonly callId: string;
  readonly path: string;
  readonly stats?: LineStats;
  readonly created?: boolean;
}

export function project(input: ProjectionInput): Projection {
  const items: Item[] = [];
  const persistedRequestIds = new Set<string>();
  const toolCalls = new Map<string, ToolCallInfo>();
  /** callId → 条目位置；只读操作还记录在合并行里的位置。 */
  const itemIndex = new Map<string, { index: number; entry?: number }>();
  const changeSeqs: number[] = [];
  let turnEdits: TurnEdit[] = [];
  let turnOpen = false;

  const openExplore = (): number | undefined => {
    const index = items.length - 1;
    return items[index]?.kind === 'explore' ? index : undefined;
  };

  for (const event of input.events) {
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'turn/start':
        turnOpen = true;
        turnEdits = [];
        break;
      case 'user/message': {
        const source = data.source as { kind?: string; rpcId?: string } | undefined;
        if (source?.kind !== 'user') break;
        if (source.rpcId) persistedRequestIds.add(source.rpcId);
        const text = textOf(data.content);
        if (text) items.push({ kind: 'user', id: `u:${event.seq}`, text });
        break;
      }
      case 'assistant/message': {
        const message = data.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
        const markdown = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n').trim();
        const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('\n\n').trim();
        const interrupted = data.interrupted === true;
        if (!markdown && !reasoning) break;
        items.push({
          kind: 'assistant',
          id: `a:${event.seq}`,
          markdown,
          ...(reasoning ? { reasoning } : {}),
          streaming: false,
          ...(interrupted ? { interrupted } : {}),
        });
        break;
      }
      case 'tool/call': {
        const callId = typeof data.callId === 'string' ? data.callId : `seq-${event.seq}`;
        const tool = typeof data.name === 'string' ? data.name : 'tool';
        const args = parseArguments(data.arguments);
        const file = stringArg(args, 'file_path', 'notebook_path', 'path');
        const path = file && input.workspacePath ? resolve(input.workspacePath, file) : file;
        toolCalls.set(callId, { callId, tool, args, ...(path ? { path } : {}), status: 'running' });
        const variant = toolVariant(tool);
        const label = activityLabel(tool, args, input.workspacePath);
        if (variant === 'explore') {
          const entry = { id: callId, label, status: 'running' as const };
          const index = openExplore();
          if (index !== undefined) {
            const group = items[index] as Explore;
            itemIndex.set(callId, { index, entry: group.entries.length });
            items[index] = summarizeExplore({ ...group, entries: [...group.entries, entry] });
          } else {
            itemIndex.set(callId, { index: items.length, entry: 0 });
            items.push(summarizeExplore({ kind: 'explore', id: `x:${callId}`, summary: '', status: 'running', entries: [entry] }));
          }
          break;
        }
        itemIndex.set(callId, { index: items.length });
        items.push({
          kind: 'activity',
          id: `t:${callId}`,
          tool,
          variant,
          label: variant === 'edit' && file ? displayPath(file, input.workspacePath) : label,
          status: 'running',
        });
        break;
      }
      case 'tool/result': {
        const message = data.message as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
        const callId = message?.toolCallId;
        const at = callId ? itemIndex.get(callId) : undefined;
        const call = callId ? toolCalls.get(callId) : undefined;
        if (!callId || !at || !call) break;
        const status: 'ok' | 'error' = message?.isError === true || data.error !== undefined ? 'error' : 'ok';
        const meta = (data.meta ?? {}) as { operation?: unknown; diffs?: unknown };
        const diffs = Array.isArray(meta.diffs) ? (meta.diffs as unknown[]).filter(isToolDiff) : undefined;
        const created = meta.operation === 'create';
        toolCalls.set(callId, { ...call, status, ...(diffs ? { diffs } : {}), ...(created ? { created } : {}) });
        const previous = items[at.index];
        if (previous?.kind === 'explore' && at.entry !== undefined) {
          const entries = previous.entries.map((e, i) => (i === at.entry ? { ...e, status } : e));
          items[at.index] = summarizeExplore({ ...previous, entries });
          break;
        }
        if (previous?.kind !== 'activity') break;
        const output = truncate(call.tool === 'ask_user_question' ? answersText(textOf(message?.content)) : textOf(message?.content));
        let next: Activity = { ...previous, status, ...(output ? { output } : {}) };
        if (previous.variant === 'edit' && status === 'ok' && (diffs !== undefined || created)) {
          const content = typeof call.args.content === 'string' ? call.args.content : undefined;
          const stats = created
            ? { additions: content !== undefined ? countLines(content) : 0, deletions: 0 }
            : sumStats((diffs ?? []).map((d) => lineStats(d.oldText, d.newText)));
          next = { ...next, stats, ...(created ? { created } : {}), diff: { kind: 'tool', callId } };
          // 文件修改成功时输出只是「已修改」之类的确认，不需要展开
          const { output: _omit, ...rest } = next;
          next = rest;
          if (call.path) turnEdits.push({ callId, path: call.path, stats, ...(created ? { created } : {}) });
        }
        items[at.index] = next;
        break;
      }
      case 'workspace/changes': {
        changeSeqs.push(event.seq);
        const card = changesCard(event.seq, input.changes?.(event.seq), turnEdits, input.workspacePath);
        if (card) items.push(card);
        break;
      }
      case 'turn/end': {
        turnOpen = false;
        const notice = turnEndNotice(event.seq, data.reason);
        if (notice) items.push(notice);
        break;
      }
      default:
        break;
    }
  }

  // 正在流式输出的回复
  if (input.live) {
    const markdown = liveBlocksText(input.live.blocks, 'text');
    const reasoning = liveBlocksText(input.live.blocks, 'reasoning');
    if (markdown || reasoning) {
      items.push({
        kind: 'assistant',
        id: `live:${input.live.attemptId}`,
        markdown,
        ...(reasoning ? { reasoning } : {}),
        streaming: true,
      });
    }
  }

  // 还没出现在持久历史里的本地回显
  const running = turnOpen || (input.fallbackRunning ?? false);
  for (const pending of input.pending) {
    if (persistedRequestIds.has(pending.requestId)) continue;
    const state = pending.state === 'failed' ? 'failed' : pending.state === 'accepted' && running ? 'queued' : 'sending';
    items.push({
      kind: 'user',
      id: `p:${pending.requestId}`,
      text: pending.text,
      pending: state,
      requestId: pending.requestId,
      ...(pending.error ? { error: pending.error } : {}),
    });
  }

  return { items, persistedRequestIds, turnOpen, toolCalls, changeSeqs };
}

/** 合并行的摘要：「读取 2 个文件，搜索 1 次」。 */
function summarizeExplore(group: Explore): Explore {
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const entry of group.entries) {
    const tool = entry.label.split('  ', 1)[0] ?? '';
    if (tool === 'read' || tool === 'read_image') reads++;
    else if (tool === 'ls' || tool === 'list') lists++;
    else searches++;
  }
  const parts = [reads ? `读取 ${reads} 个文件` : '', searches ? `搜索 ${searches} 次` : '', lists ? `列出 ${lists} 个目录` : ''].filter(Boolean);
  const statuses = group.entries.map((e) => e.status);
  const status = statuses.includes('running') ? 'running' : statuses.every((s) => s === 'error') ? 'error' : 'ok';
  return { ...group, summary: parts.join('，'), status };
}

function changesCard(seq: number, summary: ChangesSummary | 'unavailable' | undefined, edits: readonly TurnEdit[], workspacePath?: string): Item | undefined {
  if (summary === undefined) return undefined; // 还在读取，读到后再显示，避免先显示一份再变
  if (summary !== 'unavailable') {
    if (summary.files.length === 0) return undefined;
    const files = summary.files.map((file, index): ChangedFileView => {
      const flags = [file.binary ? 'binary' : '', file.oversized ? 'oversized' : ''].filter((f): f is 'binary' | 'oversized' => f !== '');
      return {
        path: file.display ?? file.path,
        ref: { kind: 'turn', seq, index },
        ...(file.added !== undefined ? { additions: file.added } : {}),
        ...(file.deleted !== undefined ? { deletions: file.deleted } : {}),
        ...(flags.length ? { flags } : {}),
      };
    });
    return { kind: 'changes', id: `c:${seq}`, turn: summary.turn, source: 'turn', files, total: summary.total };
  }
  // Host 重启后汇总不可用：退回按本轮的文件工具汇总（命令造成的改动看不到）
  if (edits.length === 0) return undefined;
  const byPath = new Map<string, { callId: string; stats: LineStats; created: boolean }>();
  for (const edit of edits) {
    const previous = byPath.get(edit.path);
    const stats = edit.stats ?? { additions: 0, deletions: 0 };
    byPath.set(edit.path, {
      callId: edit.callId, // Diff 打开最后一次修改
      stats: previous ? sumStats([previous.stats, stats]) : stats,
      created: previous?.created ?? edit.created ?? false,
    });
  }
  const files = [...byPath].map(([path, value]): ChangedFileView => ({
    path: displayPath(path, workspacePath),
    ref: { kind: 'tool', callId: value.callId },
    additions: value.stats.additions,
    deletions: value.stats.deletions,
    ...(value.created ? { created: true } : {}),
  }));
  return { kind: 'changes', id: `c:${seq}`, turn: 0, source: 'tools', files, total: files.length };
}

/** 提问工具的结果是 JSON：`{ answers: [{ id, selected, custom? }] }` 或 `{ cancelled: true }`，转成可读的文字。 */
function answersText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { answers?: { selected?: string[]; custom?: string }[]; cancelled?: boolean };
    if (parsed.cancelled) return '已跳过';
    if (!Array.isArray(parsed.answers)) return text;
    return parsed.answers.map((a) => `回答：${[...(a.selected ?? []), a.custom].filter(Boolean).join('、')}`).join('\n');
  } catch {
    return text;
  }
}

function isToolDiff(value: unknown): value is ToolDiff {
  if (!value || typeof value !== 'object') return false;
  const d = value as { oldText?: unknown; newText?: unknown };
  return typeof d.newText === 'string' && (d.oldText === null || d.oldText === undefined || typeof d.oldText === 'string');
}

/** 工具参数是 JSON 字符串；不是合法 JSON 时当作没有参数。 */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArg(args: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…（已截断）` : text;
}

/** 工具调用的一行摘要：取最能说明这次调用的参数。 */
export function activityLabel(tool: string, rawArguments: unknown, workspacePath?: string): string {
  const args = parseArguments(rawArguments);
  const pick = (...keys: string[]): string | undefined => stringArg(args, ...keys);
  // 优先级：命令 > 目标文件 > 搜索词 / URL > 目录 > 描述
  if (tool === 'ask_user_question') {
    const first = (args.questions as { question?: unknown }[] | undefined)?.[0]?.question;
    return typeof first === 'string' ? `提问  ${firstLine(first)}` : '提问';
  }
  const command = pick('command', 'cmd');
  if (command) return `${tool}  ${firstLine(command)}`;
  const file = pick('file_path', 'notebook_path');
  if (file) return `${tool}  ${displayPath(file, workspacePath)}`;
  const target = pick('pattern', 'query', 'url');
  if (target) return `${tool}  ${firstLine(target)}`;
  const path = pick('path');
  if (path) return `${tool}  ${displayPath(path, workspacePath)}`;
  const other = pick('description', 'prompt', 'name');
  if (other) return `${tool}  ${firstLine(other)}`;
  return tool;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length < text.length ? `${line} …` : line;
}

export function displayPath(path: string, workspacePath?: string): string {
  if (!workspacePath || !isAbsolute(path)) return path;
  const rel = relative(workspacePath, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function turnEndNotice(seq: number, reason: unknown): Item | undefined {
  const r = reason as { kind?: string; error?: { message?: string; code?: string } } | undefined;
  const id = `n:${seq}`;
  switch (r?.kind) {
    case 'aborted':
      return { kind: 'notice', id, level: 'info', text: '已停止生成' };
    case 'error':
      // 没有配置 API Key 时 dsh 照常接收消息，在轮次结束时报 MISSING_CREDENTIAL
      if (r.error?.code === 'MISSING_CREDENTIAL') {
        return {
          kind: 'notice',
          id,
          level: 'error',
          text: '还没有配置模型的 API Key。在 dsh 设置的「模型」页面填写后重新发送。',
          action: { kind: 'openWebUI', label: '打开 dsh 设置' },
        };
      }
      return { kind: 'notice', id, level: 'error', text: `出错了：${r.error?.message ?? '模型请求失败'}` };
    case 'max-tokens':
      return { kind: 'notice', id, level: 'warning', text: '回复达到了输出长度上限' };
    case 'blocked':
      return { kind: 'notice', id, level: 'warning', text: '本轮被阻止' };
    case 'interrupted':
      return { kind: 'notice', id, level: 'warning', text: '本轮被中断（dsh 可能重启过）' };
    default:
      return undefined;
  }
}
