/**
 * 会话事件 → 界面条目（纯函数）。规则见 docs/DESIGN.md 5.2。
 *
 * - 只渲染 `surfaceOp` 为 append（或不带 surfaceOp）的消息事件，与 dsh Web UI 一致；
 * - 用户消息只取 `source.kind === 'user'` 的那条，dsh 注入的上下文消息不显示；
 * - 没有正文也没有推理的助手消息不渲染（不出现空占位）；
 * - 工具调用渲染为一行活动，M2 再按工具类型细化。
 */
import type { Item } from '@dsh-copilot/shared';
import { isAbsolute, relative } from 'node:path';
import type { PendingPrompt } from '../dsh/SessionService.ts';
import { liveBlocksText, type WireEvent } from '../dsh/remote/follow.ts';
import type { LiveAttempt } from '../dsh/session/journal.ts';

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
}

export interface Projection {
  readonly items: Item[];
  /** 已经出现在持久历史里的 requestId，用于撤掉本地回显。 */
  readonly persistedRequestIds: ReadonlySet<string>;
  /** 最后一个 turn/start 之后没有 turn/end。 */
  readonly turnOpen: boolean;
}

const OUTPUT_LIMIT = 4_000;

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

export function project(input: ProjectionInput): Projection {
  const items: Item[] = [];
  const persistedRequestIds = new Set<string>();
  const activityIndex = new Map<string, number>();
  let turnOpen = false;

  for (const event of input.events) {
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'turn/start':
        turnOpen = true;
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
        activityIndex.set(callId, items.length);
        items.push({
          kind: 'activity',
          id: `t:${callId}`,
          tool,
          label: activityLabel(tool, data.arguments, input.workspacePath),
          status: 'running',
        });
        break;
      }
      case 'tool/result': {
        const message = data.message as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
        const index = message?.toolCallId ? activityIndex.get(message.toolCallId) : undefined;
        if (index === undefined) break;
        const previous = items[index];
        if (previous?.kind !== 'activity') break;
        const output = truncate(textOf(message?.content));
        items[index] = {
          ...previous,
          status: message?.isError === true || data.error !== undefined ? 'error' : 'ok',
          ...(output ? { output } : {}),
        };
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

  return { items, persistedRequestIds, turnOpen };
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
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      // 参数不是合法 JSON：只显示工具名
    }
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  // 优先级：命令 > 目标文件 > 搜索词 / URL > 目录 > 描述
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
