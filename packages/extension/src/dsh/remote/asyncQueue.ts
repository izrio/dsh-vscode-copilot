/** 推模式到拉模式的桥：生产方 push/end/fail，消费方 `for await`。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | undefined;
  private state: 'open' | 'ended' | 'failed' = 'open';
  private error: unknown;

  /** 生产方已经给出结束或错误。 */
  get settled(): boolean {
    return this.state !== 'open';
  }

  push(item: T): void {
    if (this.state !== 'open') return;
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    if (this.state !== 'open') return;
    this.state = 'ended';
    this.flushWaiter();
  }

  fail(error: unknown): void {
    if (this.state !== 'open') return;
    this.state = 'failed';
    this.error = error;
    this.flushWaiter();
  }

  private flushWaiter(): void {
    if (!this.waiter || this.items.length > 0) return;
    const { resolve, reject } = this.waiter;
    this.waiter = undefined;
    if (this.state === 'failed') reject(this.error);
    else resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        // item 本身可能是 undefined（不带 value 的流帧），所以按长度判断
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.state === 'ended') return Promise.resolve({ value: undefined, done: true });
        if (this.state === 'failed') return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
