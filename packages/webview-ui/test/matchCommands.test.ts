import { describe, expect, it } from 'vitest';
import { matchCommands } from '../src/components/Composer.tsx';

const commands = [
  { name: 'explain' },
  { name: 'compact' },
  { name: 'code-review' },
  { name: 'engineering:code-review' },
  { name: 'Review-PR' },
  { name: 'deep-research' },
];

describe('斜杠命令的匹配', () => {
  it('空查询列出全部，保持原来的顺序', () => {
    expect(matchCommands(commands, '').map((c) => c.name)).toEqual(commands.map((c) => c.name));
  });

  it('开头匹配的在前，名字中间匹配的在后；不区分大小写', () => {
    expect(matchCommands(commands, 'review').map((c) => c.name)).toEqual(['Review-PR', 'code-review', 'engineering:code-review']);
    expect(matchCommands(commands, 'CO').map((c) => c.name)).toEqual(['compact', 'code-review', 'engineering:code-review']);
  });

  it('名字里带冒号的 skill 能按完整名字匹配', () => {
    expect(matchCommands(commands, 'engineering:').map((c) => c.name)).toEqual(['engineering:code-review']);
  });

  it('没有匹配时为空', () => {
    expect(matchCommands(commands, 'zzz')).toEqual([]);
  });
});
