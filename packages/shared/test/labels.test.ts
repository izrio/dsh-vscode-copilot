import { describe, expect, it } from 'vitest';
import { joinLabel, splitLabel } from '../src/labels.ts';

describe('活动行的摘要', () => {
  it('拼出来的能原样拆回去', () => {
    expect(splitLabel(joinLabel('bash', 'pnpm test'))).toEqual({ name: 'bash', detail: 'pnpm test' });
    expect(splitLabel(joinLabel('read', 'src/a.ts', '已截断'))).toEqual({ name: 'read', detail: 'src/a.ts  已截断' });
  });

  it('没有详情时只有名称；空的段跳过', () => {
    expect(joinLabel('todo_write')).toBe('todo_write');
    expect(joinLabel('grep', undefined, '')).toBe('grep');
    expect(splitLabel('todo_write')).toEqual({ name: 'todo_write', detail: '' });
  });

  it('详情里的单个空格不当作分隔', () => {
    expect(splitLabel(joinLabel('bash', 'git commit -m "a b"'))).toEqual({ name: 'bash', detail: 'git commit -m "a b"' });
  });
});
