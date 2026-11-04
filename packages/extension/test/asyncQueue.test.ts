import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/dsh/remote/asyncQueue.ts';

describe('AsyncQueue', () => {
  it('按顺序交付，包括值为 undefined 的项', async () => {
    const queue = new AsyncQueue<unknown>();
    queue.push(1);
    queue.push(undefined);
    queue.push('x');
    queue.end();
    const seen: unknown[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toEqual([1, undefined, 'x']);
  });

  it('等待中的消费方能收到之后 push 的项', async () => {
    const queue = new AsyncQueue<number>();
    const first = queue[Symbol.asyncIterator]().next();
    queue.push(7);
    await expect(first).resolves.toEqual({ value: 7, done: false });
  });

  it('fail 之后迭代抛出同一个错误', async () => {
    const queue = new AsyncQueue<number>();
    const error = new Error('boom');
    queue.fail(error);
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toBe(error);
  });
});
