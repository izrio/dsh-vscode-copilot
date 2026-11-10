/**
 * 本地回显：发送后立即显示的用户消息，等持久的 user/message（source.rpcId 等于 requestId）或 dsh 队列里出现后撤掉。
 *
 * 不绑定在某一次连接上：断线重连时 SessionService 会重建，但发送失败、等待重试的消息不能跟着丢掉。
 */
export interface PendingPrompt {
  readonly requestId: string;
  readonly text: string;
  readonly sentAt: number;
  readonly state: 'sending' | 'accepted' | 'failed';
  readonly error?: string;
}

const EMPTY: readonly PendingPrompt[] = [];

export class PendingPrompts {
  private readonly bySession = new Map<string, readonly PendingPrompt[]>();

  list(sessionId: string): readonly PendingPrompt[] {
    return this.bySession.get(sessionId) ?? EMPTY;
  }

  /** 加入或替换（同一个 requestId 重试时）一条回显。 */
  set(sessionId: string, value: PendingPrompt): void {
    const list = this.list(sessionId).filter((item) => item.requestId !== value.requestId);
    this.bySession.set(sessionId, [...list, value]);
  }

  update(sessionId: string, requestId: string, patch: Partial<Omit<PendingPrompt, 'requestId'>>): boolean {
    const list = this.bySession.get(sessionId);
    if (!list?.some((item) => item.requestId === requestId)) return false;
    this.bySession.set(
      sessionId,
      list.map((item) => (item.requestId === requestId ? { ...item, ...patch } : item)),
    );
    return true;
  }

  /** 删除指定的回显；返回是否有变化。 */
  remove(sessionId: string, requestIds: ReadonlySet<string>): boolean {
    const list = this.bySession.get(sessionId);
    if (!list) return false;
    const remaining = list.filter((item) => !requestIds.has(item.requestId));
    if (remaining.length === list.length) return false;
    if (remaining.length) this.bySession.set(sessionId, remaining);
    else this.bySession.delete(sessionId);
    return true;
  }
}
