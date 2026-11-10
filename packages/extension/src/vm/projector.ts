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
import { resolve } from 'node:path';
import type { ChangesSummary } from '../dsh/DshClient.ts';
import type { PendingPrompt } from '../dsh/SessionService.ts';
import { liveBlocksText, type WireEvent } from '../dsh/remote/follow.ts';
import type { LiveAttempt } from '../dsh/session/journal.ts';
import { splitContext } from './context.ts';
import { countLines, lineStats, sumStats, type ToolDiff } from './diffs.ts';
import { displayPath } from './paths.ts';

export { displayPath } from './paths.ts';
import { t } from '../i18n.ts';

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
  /** `inbox` 投影：在 dsh 队列里等待的消息。 */
  readonly inbox?: unknown;
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
  /** 最近一次 MISSING_CREDENTIAL 里 dsh 要求配置的凭据名（例如 `DEEPSEEK_API_KEY`）。 */
  readonly missingCredentialRef?: string;
  /** 已经进入 dsh 队列的 requestId：本地回显可以撤掉（之后由队列或持久历史显示）。 */
  readonly queuedRequestIds: ReadonlySet<string>;
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

/** 只由持久事件决定的那部分投影。流式输出时持久事件不变，调用方可以缓存它，只重算末尾的流式内容和排队消息。 */
export interface EventsProjection {
  readonly items: readonly Item[];
  readonly persistedRequestIds: ReadonlySet<string>;
  readonly turnOpen: boolean;
  readonly toolCalls: ReadonlyMap<string, ToolCallInfo>;
  readonly changeSeqs: readonly number[];
  readonly missingCredentialRef?: string;
}

/** 投影持久事件。结果只取决于 events、workspacePath 和 changes 的返回值。 */
export function projectEvents(input: Pick<ProjectionInput, 'events' | 'workspacePath' | 'changes'>): EventsProjection {
  const items: Item[] = [];
  const persistedRequestIds = new Set<string>();
  const toolCalls = new Map<string, ToolCallInfo>();
  /** callId → 条目位置；只读操作还记录在合并行里的位置。 */
  const itemIndex = new Map<string, { index: number; entry?: number }>();
  const changeSeqs: number[] = [];
  let turnEdits: TurnEdit[] = [];
  let turnOpen = false;
  let missingCredentialRef: string | undefined;
  /** /permission 命令的预设显示名，命令结束时用。 */
  const permissionArgs = new Map<string, string>();
  const usedIds = new Set<string>();

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
        const { text, attachments } = splitContext(textOf(data.content));
        if (text || attachments.length) items.push({ kind: 'user', id: `u:${event.seq}`, text, ...(attachments.length ? { attachments } : {}) });
        break;
      }
      case 'command/run': {
        // 斜杠命令（/compact、/plan 等）不产生用户消息，只有 command/run 和 command/done
        const commandId = typeof data.commandId === 'string' ? data.commandId : `seq-${event.seq}`;
        const name = typeof data.name === 'string' ? data.name : 'command';
        const args = typeof data.args === 'string' ? data.args.trim() : '';
        itemIndex.set(`cmd:${commandId}`, { index: items.length });
        if (name === 'permission') {
          // 权限切换（大多来自输入框的权限菜单）显示成一行提示，结果到达前先占位
          items.push({ kind: 'notice', id: `cmd:${commandId}`, level: 'info', text: t('notice.permissionSwitching', presetName(args)) });
          permissionArgs.set(`cmd:${commandId}`, presetName(args));
          break;
        }
        items.push({
          kind: 'activity',
          id: `cmd:${commandId}`,
          tool: 'slash',
          variant: 'generic',
          label: `/${name}${args ? ` ${firstLine(args)}` : ''}`,
          status: 'running',
        });
        break;
      }
      case 'command/done': {
        const at = typeof data.commandId === 'string' ? itemIndex.get(`cmd:${data.commandId}`) : undefined;
        const previous = at ? items[at.index] : undefined;
        const result = typeof data.text === 'string' ? data.text.trim() : '';
        if (at && previous?.kind === 'notice') {
          const preset = permissionArgs.get(previous.id) ?? '';
          items[at.index] =
            data.kind === 'error'
              ? { ...previous, level: 'error', text: t('notice.permissionFailed', result) }
              : { ...previous, text: t('notice.permissionSwitched', preset) };
          break;
        }
        if (!at || previous?.kind !== 'activity') break;
        items[at.index] = {
          ...previous,
          status: data.kind === 'error' ? 'error' : 'ok',
          ...(result ? { detail: firstLine(result) } : {}),
          ...(result.includes('\n') ? { output: truncate(result) } : {}),
        };
        break;
      }
      case 'assistant/message': {
        const message = data.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
        const markdown = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n\n')
          .trim();
        const reasoning = blocks
          .filter((b) => b.type === 'reasoning')
          .map((b) => b.text ?? '')
          .join('\n\n')
          .trim();
        const interrupted = data.interrupted === true;
        if (!markdown && !reasoning) break;
        // 与流式输出时用同一个 id（按轮次和步骤），结算时界面原地更新，不重新挂载
        const stepId = assistantStepId(data.turn, data.step);
        const id = stepId && !usedIds.has(stepId) ? stepId : `a:${event.seq}`;
        usedIds.add(id);
        items.push({
          kind: 'assistant',
          id,
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
        // 待办由输入框上方的状态条显示，不在对话流里重复
        if (tool === 'todo_write') break;
        const variant = toolVariant(tool);
        const title = activityLabel(tool, args, input.workspacePath);
        if (variant === 'explore') {
          const entry = { id: callId, ...title, status: 'running' as const };
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
          ...(variant === 'edit' && file ? { label: displayPath(file, input.workspacePath) } : title),
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
        if (call.tool === 'exit_plan_mode') {
          // 继续完善计划时工具以错误返回，但这不是失败；其他错误（例如不在计划模式）照常显示
          const result = textOf(message?.content);
          const outcome =
            status === 'ok' && /approved/iu.test(result)
              ? t('plan.approved')
              : /keep planning/iu.test(result)
                ? t('plan.keepPlanning')
                : /dismissed/iu.test(result)
                  ? t('plan.dismissed')
                  : undefined;
          items[at.index] = outcome
            ? { ...previous, status: 'ok', detail: [previous.detail, outcome].filter(Boolean).join(' · ') }
            : { ...previous, status, ...(result ? { output: truncate(result) } : {}) };
          break;
        }
        const output = truncate(call.tool === 'ask_user_question' ? answersText(textOf(message?.content)) : textOf(message?.content));
        let next: Activity = { ...previous, status, ...(output ? { output } : {}) };
        if (previous.variant === 'edit' && status === 'ok' && (diffs !== undefined || created)) {
          const content = typeof call.args.content === 'string' ? call.args.content : undefined;
          const stats = created ? { additions: content !== undefined ? countLines(content) : 0, deletions: 0 } : sumStats((diffs ?? []).map(cachedLineStats));
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
        const reason = data.reason as { error?: { code?: string; message?: string } } | undefined;
        if (reason?.error?.code === 'MISSING_CREDENTIAL')
          missingCredentialRef = /\bstore ([A-Z_][A-Z0-9_]*)\b/u.exec(reason.error.message ?? '')?.[1] ?? missingCredentialRef;
        else if (notice === undefined) missingCredentialRef = undefined; // 之后有成功的轮次：已经配置好了
        break;
      }
      default:
        break;
    }
  }

  return { items, persistedRequestIds, turnOpen, toolCalls, changeSeqs, ...(missingCredentialRef ? { missingCredentialRef } : {}) };
}

/**
 * 完整投影：持久事件 + 正在流式输出的回复 + 队列里的消息 + 本地回显。
 * @param base - 缓存的持久事件投影；不传时现算。
 */
export function project(input: ProjectionInput, base: EventsProjection = projectEvents(input)): Projection {
  const items: Item[] = [...base.items];
  const { persistedRequestIds, turnOpen } = base;

  // 正在流式输出的回复：id 与结算后的持久消息相同（见 assistantStepId），结算时原地替换
  if (input.live) {
    const live = input.live;
    const markdown = liveBlocksText(live.blocks, 'text');
    const reasoning = liveBlocksText(live.blocks, 'reasoning');
    if (markdown || reasoning) {
      const stepId = assistantStepId(live.turn, live.step);
      const taken = stepId !== undefined && base.items.some((item) => item.id === stepId);
      items.push({
        kind: 'assistant',
        id: stepId && !taken ? stepId : `live:${live.attemptId}`,
        markdown,
        ...(reasoning ? { reasoning } : {}),
        streaming: true,
      });
    }
    // 模型正在写工具参数（例如写一个大文件）：先显示一行"准备中"，不让界面停在"思考中"
    for (const [index, block] of [...live.blocks].sort(([a], [b]) => a - b)) {
      if (block.kind !== 'tool' || !block.toolName) continue;
      const variant = toolVariant(block.toolName);
      const target = partialArgument(block.text, 'file_path', 'notebook_path', 'command', 'path', 'pattern', 'query', 'url');
      items.push({
        kind: 'activity',
        id: `live-tool:${live.attemptId}:${index}`,
        tool: block.toolName,
        variant: variant === 'explore' ? 'generic' : variant,
        label: block.toolName,
        ...(target ? { detail: variant === 'edit' ? displayPath(target, input.workspacePath) : firstLine(target) } : {}),
        status: 'running',
        preparing: true,
      });
    }
  }

  // dsh 队列里的消息（插队的先送达，排在前面）
  const inboxRpcIds = new Set<string>();
  for (const queued of inboxItems(input.inbox)) {
    if (queued.rpcId) inboxRpcIds.add(queued.rpcId);
    if (queued.rpcId && persistedRequestIds.has(queued.rpcId)) continue;
    const { text, attachments } = splitContext(queued.text);
    items.push({
      kind: 'user',
      id: queued.rpcId ? `p:${queued.rpcId}` : `q:${queued.id}`,
      text,
      ...(attachments.length ? { attachments } : {}),
      pending: 'queued',
      ...(queued.rpcId ? { requestId: queued.rpcId } : {}),
      queue: { itemId: queued.id, target: queued.target },
    });
  }

  // 还没出现在持久历史或队列里的本地回显
  const running = turnOpen || (input.fallbackRunning ?? false);
  for (const pending of input.pending) {
    if (persistedRequestIds.has(pending.requestId) || inboxRpcIds.has(pending.requestId)) continue;
    const state = pending.state === 'failed' ? 'failed' : pending.state === 'accepted' && running ? 'queued' : 'sending';
    const { text, attachments } = splitContext(pending.text);
    items.push({
      kind: 'user',
      id: `p:${pending.requestId}`,
      text,
      ...(attachments.length ? { attachments } : {}),
      pending: state,
      requestId: pending.requestId,
      ...(pending.error ? { error: pending.error } : {}),
    });
  }

  return {
    items,
    persistedRequestIds,
    queuedRequestIds: inboxRpcIds,
    turnOpen,
    toolCalls: base.toolCalls,
    changeSeqs: base.changeSeqs,
    ...(base.missingCredentialRef ? { missingCredentialRef: base.missingCredentialRef } : {}),
  };
}

interface InboxItem {
  readonly id: string;
  readonly rpcId?: string;
  readonly text: string;
  readonly target: 'next-turn' | 'next-step';
}

/** `inbox` 投影：`{ 'next-turn': [...], 'next-step': [...] }`，每项是一条待送达的用户消息。只取用户自己发的。 */
function inboxItems(inbox: unknown): InboxItem[] {
  if (!inbox || typeof inbox !== 'object') return [];
  const result: InboxItem[] = [];
  for (const target of ['next-step', 'next-turn'] as const) {
    const list = (inbox as Record<string, unknown>)[target];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const item = raw as { id?: unknown; content?: unknown; source?: { kind?: unknown; rpcId?: unknown } };
      if (typeof item.id !== 'string' || item.source?.kind !== 'user') continue;
      result.push({ id: item.id, text: textOf(item.content), target, ...(typeof item.source.rpcId === 'string' ? { rpcId: item.source.rpcId } : {}) });
    }
  }
  return result;
}

/** 合并行的摘要：「读取 2 个文件，搜索 1 次」。 */
function summarizeExplore(group: Explore): Explore {
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const entry of group.entries) {
    const tool = entry.label;
    if (tool === 'read' || tool === 'read_image') reads++;
    else if (tool === 'ls' || tool === 'list') lists++;
    else searches++;
  }
  const parts = [reads ? t('explore.reads', reads) : '', searches ? t('explore.searches', searches) : '', lists ? t('explore.lists', lists) : ''].filter(
    Boolean,
  );
  const statuses = group.entries.map((e) => e.status);
  const status = statuses.includes('running') ? 'running' : statuses.every((s) => s === 'error') ? 'error' : 'ok';
  return { ...group, summary: parts.join(t('explore.separator')), status };
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

function presetName(preset: string): string {
  return preset === 'read-only' || preset === 'workspace-write' || preset === 'danger-full-access' ? t(`preset.${preset}`) : preset;
}

/** 提问工具的结果是 JSON：`{ answers: [{ id, selected, custom? }] }` 或 `{ cancelled: true }`，转成可读的文字。 */
function answersText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { answers?: { selected?: string[]; custom?: string }[]; cancelled?: boolean };
    if (parsed.cancelled) return t('question.skipped');
    if (!Array.isArray(parsed.answers)) return text;
    return parsed.answers.map((a) => t('question.answer', [...(a.selected ?? []), a.custom].filter(Boolean).join(t('list.separator')))).join('\n');
  } catch {
    return text;
  }
}

/** 片段对象来自会话日志，同一个对象的统计结果不变；长会话里每次重新投影都重算 diff 太慢。 */
const statsCache = new WeakMap<ToolDiff, LineStats>();
function cachedLineStats(diff: ToolDiff): LineStats {
  let stats = statsCache.get(diff);
  if (!stats) statsCache.set(diff, (stats = lineStats(diff.oldText, diff.newText)));
  return stats;
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

/** 流式输出的、还不完整的 JSON 参数里某个字符串字段的值（已经写完引号的部分）。 */
export function partialArgument(json: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'u').exec(json);
    if (!match?.[1]) continue;
    try {
      const value = JSON.parse(`"${match[1]}"`) as string;
      if (value.trim()) return value.trim();
    } catch {
      // 转义不完整，跳过
    }
  }
  return undefined;
}

/** 持久的助手消息和流式输出共用的 id。 */
function assistantStepId(turn: unknown, step: unknown): string | undefined {
  return typeof turn === 'number' && typeof step === 'number' ? `a:${turn}.${step}` : undefined;
}

/** 终端颜色等控制序列（CSI / OSC），显示前去掉。 */
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** 过长的输出保留开头和结尾：命令的报错和结论通常在最后。 */
export function truncate(text: string): string {
  const clean = stripAnsi(text);
  if (clean.length <= OUTPUT_LIMIT) return clean;
  const head = Math.floor(OUTPUT_LIMIT * 0.3);
  const tail = OUTPUT_LIMIT - head;
  return `${clean.slice(0, head)}\n${t('output.omitted', clean.length - OUTPUT_LIMIT)}\n${clean.slice(-tail)}`;
}

/** 工具调用的一行摘要：工具名，加上最能说明这次调用的参数。 */
export function activityLabel(tool: string, rawArguments: unknown, workspacePath?: string): { label: string; detail?: string } {
  const args = parseArguments(rawArguments);
  const pick = (...keys: string[]): string | undefined => stringArg(args, ...keys);
  const withDetail = (detail: string | undefined) => (detail ? { label: tool, detail } : { label: tool });
  if (tool === 'exit_plan_mode') {
    const plan = typeof args.plan === 'string' ? args.plan : '';
    const heading = /^#{1,6}\s+(.+?)\s*$/mu.exec(plan)?.[1];
    return { label: t('plan.label'), detail: heading ?? t('plan.untitled') };
  }
  if (tool === 'ask_user_question') {
    const first = (args.questions as { question?: unknown }[] | undefined)?.[0]?.question;
    return typeof first === 'string' ? { label: t('question.label'), detail: firstLine(first) } : { label: t('question.label') };
  }
  // 优先级：命令 > 目标文件 > 搜索词 / URL > 目录 > 描述
  const command = pick('command', 'cmd');
  if (command) return withDetail(firstLine(command));
  const file = pick('file_path', 'notebook_path');
  if (file) return withDetail(displayPath(file, workspacePath));
  const target = pick('pattern', 'query', 'url');
  if (target) return withDetail(firstLine(target));
  const path = pick('path');
  if (path) return withDetail(displayPath(path, workspacePath));
  const other = pick('description', 'prompt', 'name');
  return withDetail(other ? firstLine(other) : undefined);
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length < text.length ? `${line} …` : line;
}

function turnEndNotice(seq: number, reason: unknown): Item | undefined {
  const r = reason as { kind?: string; error?: { message?: string; code?: string } } | undefined;
  const id = `n:${seq}`;
  switch (r?.kind) {
    case 'aborted':
      return { kind: 'notice', id, level: 'info', text: t('notice.stopped') };
    case 'error':
      // 没有配置 API Key 时 dsh 照常接收消息，在轮次结束时报 MISSING_CREDENTIAL
      if (r.error?.code === 'MISSING_CREDENTIAL') {
        return {
          kind: 'notice',
          id,
          level: 'error',
          text: t('notice.missingKey'),
          action: { kind: 'configureApiKey', label: t('notice.missingKeyAction') },
        };
      }
      return { kind: 'notice', id, level: 'error', text: t('notice.error', r.error?.message ?? t('notice.errorUnknown')) };
    case 'max-tokens':
      return { kind: 'notice', id, level: 'warning', text: t('notice.maxTokens') };
    case 'blocked':
      return { kind: 'notice', id, level: 'warning', text: t('notice.blocked') };
    case 'interrupted':
      return { kind: 'notice', id, level: 'warning', text: t('notice.interrupted') };
    default:
      return undefined;
  }
}
