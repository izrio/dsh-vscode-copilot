/**
 * 待处理请求 → 界面卡片（纯函数）：审批卡片从会话日志里找到对应的工具调用；提问卡片带上计划审阅的 intent。
 */
import type { PendingInteraction } from '@harness-deck/shared';
import type { Pending } from '../InteractionService.ts';
import { displayPath } from '../../vm/paths.ts';
import { toolVariant } from '../../vm/toolRows.ts';
import type { ToolCallInfo } from './projector.ts';
import { keepPlanningLabel } from './viewHelpers.ts';

export interface ViewContext {
  readonly toolCalls: ReadonlyMap<string, ToolCallInfo>;
  readonly workspacePath: string;
  /** 有未保存内容的文件（绝对路径）。 */
  readonly dirtyFiles: readonly string[];
}

export function interactionView(pending: Pending, ctx: ViewContext): PendingInteraction {
if (pending.kind === 'approval') return approvalView(pending, ctx);
  return {
    kind: 'question',
    id: pending.id,
    questions: pending.request.questions.map((q) => ({
      id: q.id,
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      ...(q.detail ? { detail: q.detail } : {}),
      options: q.options ?? [],
      multiSelect: q.multiSelect ?? q.multi_select ?? false,
      ...(q.intent?.kind === 'plan-review' && q.intent.approve
        ? { intent: { kind: 'plan-review' as const, approve: q.intent.approve, ...(keepPlanningLabel(q) ? { keepPlanning: keepPlanningLabel(q) } : {}) } }
        : {}),
    })),
  };
}

/** 审批卡片：从会话日志里找到对应的工具调用，显示要执行的命令或要修改的文件。 */
export function approvalView(pending: Extract<Pending, { kind: 'approval' }>, ctx: ViewContext): Extract<PendingInteraction, { kind: 'approval' }> {
  const request = pending.request;
  const call = request.callId ? ctx.toolCalls.get(request.callId) : undefined;
  const tool = call?.tool ?? request.toolName;
  const variant = toolVariant(tool);
  const display = request.displayReason;
  const reason = display?.zh ?? display?.['zh-CN'] ?? request.reason ?? display?.en ?? '';
  const command = call && variant === 'command' ? (call.args.command ?? call.args.cmd) : undefined;
  const path = call?.path;
  let subject: { subject: string; subjectKind: 'command' | 'file' } | undefined;
  if (typeof command === 'string' && command.trim()) subject = { subject: command.trim(), subjectKind: 'command' };
  else if (path) subject = { subject: displayPath(path, ctx.workspacePath), subjectKind: 'file' };
  const dirty = path && variant === 'edit' && ctx.dirtyFiles.includes(path) ? [displayPath(path, ctx.workspacePath)] : [];
  return {
    kind: 'approval',
    id: pending.id,
    toolName: tool,
    reason,
    ...(subject ?? {}),
    previewable: Boolean(path && (tool === 'edit' || tool === 'write')),
    dirtyFiles: dirty,
  };
}
