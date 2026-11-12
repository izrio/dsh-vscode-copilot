import { describe, expect, it } from 'vitest';
import { parseProfiles } from '../src/backend/profiles.ts';

describe('底层配置', () => {
  it('dsh 总在第一位；ACP 项校验后加入，id 默认取名称', () => {
    const logs: string[] = [];
    const profiles = parseProfiles(
      [
        { name: 'oh-my-pi', command: 'omp', args: ['acp', 3], env: { A: '1', B: 2 }, installHint: ' bun install ' },
        { name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
        { name: '缺命令' },
        { id: 'OH-MY-PI', name: '重复', command: 'x' },
      ],
      (line) => logs.push(line),
    );
    expect(profiles).toEqual([
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'oh-my-pi', kind: 'acp', name: 'oh-my-pi', command: 'omp', args: ['acp'], env: { A: '1' }, installHint: 'bun install' },
      { id: 'gemini-cli', kind: 'acp', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], env: {} },
    ]);
    expect(logs).toHaveLength(2);
  });

  it('设置不是数组时只有 dsh', () => {
    expect(parseProfiles(undefined).map((p) => p.id)).toEqual(['dsh']);
    expect(parseProfiles({ name: 'x' }).map((p) => p.id)).toEqual(['dsh']);
  });
});
