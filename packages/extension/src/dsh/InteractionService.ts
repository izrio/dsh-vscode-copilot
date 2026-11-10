/**
 * 需要用户处理的请求：审批（`approval/request`）和提问（`user-questions/request`）。
 *
 * 两者都是 dsh 转发的 waterfall：Host 等插件回答。这里把请求挂起，等界面上的用户答复后再回传；
 * dsh 取消请求（例如用户停止生成）时撤掉。绑定在一次连接上，断开后由上层重建。
 *
 * 线上格式（dsh 0.2.1-rc.5 实测）：
 * - approval/request：`{ toolName, callId?, reason?, displayReason?: { en, zh?, … } }`，
 *   回答 `{ kind: 'result', value: 'allowed-once' | 'rejected' | 'cancelled' }`；
 * - user-questions/request：`{ questions: [{ id, question, header?, detail?, options?: [{ label, description? }], multiSelect? }] }`，
 *   回答 `{ kind: 'result', value: { answers: [{ id, selected: string[], custom? }] } }` 或 `{ cancelled: true }`。
 */
import { z } from 'zod';
import type { DshClient } from './DshClient.ts';
import type { WaterfallOutcome, WaterfallRequest } from './remote/events.ts';

const approvalSchema = z.object({
  toolName: z.string(),
  callId: z.string().optional(),
  reason: z.string().optional(),
  displayReason: z.record(z.string(), z.string()).optional(),
});

const questionSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      header: z.string().optional(),
      detail: z.string().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
      multiSelect: z.boolean().optional(),
      multi_select: z.boolean().optional(),
      intent: z.object({ kind: z.string(), approve: z.string().optional(), callId: z.string().optional() }).loose().optional(),
    }),
  ),
});

export type ApprovalRequest = z.infer<typeof approvalSchema>;
export type QuestionRequest = z.infer<typeof questionSchema>;

export type Pending =
  | { readonly kind: 'approval'; readonly id: string; readonly sessionId: string; readonly request: ApprovalRequest }
  | { readonly kind: 'question'; readonly id: string; readonly sessionId: string; readonly request: QuestionRequest };

export type QuestionAnswer =
  | { readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] }
  | { readonly cancelled: true };

interface Waiting {
  readonly pending: Pending;
  readonly resolve: (outcome: WaterfallOutcome) => void;
}

export class InteractionService {
  private readonly waiting = new Map<string, Waiting>();
  private readonly disposers: (() => void)[] = [];

  constructor(
    client: DshClient,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.disposers.push(
      client.events.onWaterfall('approval/request', (request, signal) => this.hold(request, signal, 'approval')),
      client.events.onWaterfall('user-questions/request', (request, signal) => this.hold(request, signal, 'question')),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    // 连接已经断开，回答也送不到；只清理本地状态
    for (const { resolve } of this.waiting.values()) resolve({ kind: 'next' });
    this.waiting.clear();
  }

  /** 某个会话正在等待处理的请求，按到达顺序。 */
  pendingFor(sessionId: string): Pending[] {
    return [...this.waiting.values()].map((w) => w.pending).filter((p) => p.sessionId === sessionId);
  }

  /** 所有会话里等待处理的请求数。 */
  get count(): number {
    return this.waiting.size;
  }

  get(id: string): Pending | undefined {
    return this.waiting.get(id)?.pending;
  }

  /** 有等待处理请求的会话。 */
  sessionsNeedingAttention(): Set<string> {
    return new Set([...this.waiting.values()].map((w) => w.pending.sessionId));
  }

  respondApproval(id: string, allow: boolean): boolean {
    return this.settle(id, 'approval', { kind: 'result', value: allow ? 'allowed-once' : 'rejected' });
  }

  answerQuestion(id: string, answer: QuestionAnswer): boolean {
    return this.settle(id, 'question', { kind: 'result', value: answer });
  }

  private settle(id: string, kind: Pending['kind'], outcome: WaterfallOutcome): boolean {
    const entry = this.waiting.get(id);
    if (!entry || entry.pending.kind !== kind) return false; // 已经处理过或已被 dsh 取消
    this.waiting.delete(id);
    entry.resolve(outcome);
    this.onChange();
    return true;
  }

  private hold(request: WaterfallRequest, signal: AbortSignal, kind: Pending['kind']): Promise<WaterfallOutcome> {
    const parsed = kind === 'approval' ? approvalSchema.safeParse(request.request) : questionSchema.safeParse(request.request);
    if (!parsed.success) {
      // 看不懂的请求交给下一个回答方（例如同时打开的 dsh Web UI），不能让 dsh 一直等
      this.log(`无法识别的 ${request.event} 请求，交给其他回答方处理`);
      return Promise.resolve({ kind: 'next' });
    }
    const pending = { kind, id: request.eventId, sessionId: request.agentId, request: parsed.data } as Pending;
    return new Promise<WaterfallOutcome>((resolve) => {
      this.waiting.set(pending.id, { pending, resolve });
      signal.addEventListener(
        'abort',
        () => {
          if (this.waiting.delete(pending.id)) {
            resolve({ kind: 'next' });
            this.onChange();
          }
        },
        { once: true },
      );
      this.onChange();
    });
  }
}
