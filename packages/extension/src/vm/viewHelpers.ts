/**
 * 控制器用到的纯函数：标题、上下文用量、待办、目标、模型状态、错误提示等。从投影值计算视图，不保存状态。
 */
import type { Item, ModelOption, ModelState, SessionHeader } from '@dsh-copilot/shared';
import type { ModelCatalog, ModelSelection } from '../dsh/DshClient.ts';
import { RemoteError } from '../dsh/remote/errors.ts';
import { t } from '../i18n.ts';
import { describeError, userMessage } from '../util/errors.ts';
import type { SelectionContext } from './context.ts';

export const newSessionTitle = (): string => t('session.new');

/** 模型目录 → 选项和当前选择。目录读到了但一个模型都没有时标记需要 API Key（DeepSeek 官方服务没有 Key 时不列出模型）。 */
export function buildModelState(
  projections: Readonly<Record<string, unknown>>,
  catalog: ModelCatalog | undefined,
  draftModel: ModelSelection | undefined,
): ModelState {
  const options: ModelOption[] = [];
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      options.push({
        provider: group.id,
        model: model.id,
        name: model.name,
        group: group.name,
        ...(model.description ? { description: model.description } : {}),
        efforts: model.reasoning?.efforts.map((e) => ({ id: e.id, name: e.name })) ?? [],
        ...(model.reasoning?.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}),
      });
    }
  }
  const selection = (projections.modelSelection as { next?: ModelSelection } | undefined)?.next;
  const current = selection ?? draftModel ?? (catalog?.default?.provider && catalog.default.model ? (catalog.default as ModelSelection) : undefined);
  const needsApiKey = catalog !== undefined && options.length === 0;
  return {
    ...(needsApiKey ? { needsApiKey } : {}),
    options,
    ...(current
      ? { current: { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) } }
      : {}),
  };
}

export function titleOf(projections: Readonly<Record<string, unknown>>, items: readonly Item[]): string {
  const title = typeof projections.title === 'string' ? plainTitle(projections.title) : '';
  if (title) return title;
  const outline = projections.turnOutline as { prompt?: string }[] | undefined;
  const prompt = plainTitle(outline?.[0]?.prompt ?? items.find((item) => item.kind === 'user')?.text ?? '');
  if (prompt) return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
  return newSessionTitle();
}

/** 标题只取第一行，去掉 Markdown 标题符号、强调符号和包裹的引号。 */
export function plainTitle(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line
    .replace(/^#{1,6}\s+/u, '')
    .replace(/[*_`]+/gu, '')
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/gu, '')
    .trim();
}

export function contextUsageOf(projections: Readonly<Record<string, unknown>>): Pick<SessionHeader, 'contextUsage' | 'contextTokens'> {
  const pressure = projections.contextPressure as { pressureTokens?: number; contextWindow?: number } | undefined;
  if (!pressure?.contextWindow || typeof pressure.pressureTokens !== 'number') return {};
  return {
    contextUsage: Math.min(1, Math.max(0, pressure.pressureTokens / pressure.contextWindow)),
    contextTokens: { used: pressure.pressureTokens, window: pressure.contextWindow },
  };
}

/** 队列里某条消息的完整文本（含上下文块）。 */
export function queuedText(inbox: unknown, itemId: string): string | undefined {
  if (!inbox || typeof inbox !== 'object') return undefined;
  for (const list of Object.values(inbox as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const item = list.find((entry: { id?: unknown }) => entry?.id === itemId) as { content?: { type?: string; text?: string }[] } | undefined;
    if (item)
      return (item.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
  }
  return undefined;
}

/** 计划审阅里"继续完善"的选项标签：不是批准的那个。 */
export function keepPlanningLabel(q: { options?: { label: string }[]; intent?: { approve?: string } }): string | undefined {
  return q.options?.find((o) => o.label !== q.intent?.approve)?.label;
}

/** 计划模式（`/plan`）是否开启（`plan` 投影）。 */
export function inPlanMode(projections: Readonly<Record<string, unknown>>): boolean {
  const plan = projections.plan;
  return typeof plan === 'object' && plan !== null && (plan as { active?: unknown }).active === true;
}

/** 当前会话的权限预设（`permissions` 投影的 currentValue）。 */
export function currentPermissionOf(projections: Readonly<Record<string, unknown>>): string | undefined {
  const value = (projections.permissions as { currentValue?: unknown } | undefined)?.currentValue;
  return typeof value === 'string' ? value : undefined;
}

export function todosOf(projections: Readonly<Record<string, unknown>>): Pick<SessionHeader, 'todos'> {
  const todos = projections.todos;
  if (!Array.isArray(todos) || todos.length === 0) return {};
  const valid = todos.filter(
    (t): t is { content: string; status: 'pending' | 'in_progress' | 'completed' } =>
      !!t && typeof t.content === 'string' && ['pending', 'in_progress', 'completed'].includes(t.status),
  );
  return valid.length ? { todos: valid.map((t) => ({ content: t.content, status: t.status })) } : {};
}

export function goalOf(projections: Readonly<Record<string, unknown>>): Pick<SessionHeader, 'goal'> {
  const value = projections.goal as
    { goal?: { objective?: string; phase?: string; maxGoalRounds?: number; blockedReason?: { message?: string } }; roundsStarted?: number } | null | undefined;
  const goal = value?.goal;
  if (!goal?.objective || !['active', 'paused', 'blocked', 'complete'].includes(goal.phase ?? '')) return {};
  return {
    goal: {
      objective: goal.objective,
      phase: goal.phase as 'active' | 'paused' | 'blocked' | 'complete',
      round: value?.roundsStarted ?? 0,
      maxRounds: goal.maxGoalRounds ?? 0,
      ...(goal.blockedReason?.message ? { blockedReason: goal.blockedReason.message } : {}),
    },
  };
}

export function withoutDiagnostics(selection: SelectionContext): SelectionContext {
  const { diagnostics: _omit, ...rest } = selection;
  return rest;
}

export const describe = describeError;

/** 把 dsh 的错误码翻译成用户能看懂、知道下一步怎么做的提示。 */
export function friendlyError(error: unknown): string {
  if (error instanceof RemoteError) {
    switch (error.code) {
      case 'session/writer-held':
        return t('send.writerHeld');
      case 'session/model-unavailable':
        return t('send.modelUnavailable');
      case 'session/provider-credentials-unavailable':
      case 'session/provider-models-unavailable':
        return t('send.noCredentials');
      case 'session/agent-busy':
        return t('send.busy');
      default:
        return t('send.failed', error.detail);
    }
  }
  return t('send.failed', userMessage(error));
}
