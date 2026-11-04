import { describe, expect, it } from 'vitest';
import { countLines, lineStats, proposedContent, reverseHunks, reverseToolDiffs, unifiedFromHunks } from '../src/vm/diffs.ts';

// 以下数据来自 dsh 0.2.1-rc.5 实测（docs/DSH-INTEGRATION.md 第 10 节）
const AFTER = '# m2\nline two\nline 2.5\nline3\n';
const BEFORE = '# m2\nline2\nline3\n';
const TOOL_DIFF = { oldText: '# m2\nline2\nline3', newText: '# m2\nline two\nline 2.5\nline3' };
const HUNK = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' # m2', '-line2', '+line two', '+line 2.5', ' line3'] };

describe('lineStats', () => {
  it('统计增删行数，上下文不计', () => {
    expect(lineStats(TOOL_DIFF.oldText, TOOL_DIFF.newText)).toEqual({ additions: 2, deletions: 1 });
  });
  it('片段结尾没有换行时不把最后一行算成修改', () => {
    expect(lineStats('# demo', '# demo\n\n一个演示项目。')).toEqual({ additions: 2, deletions: 0 });
  });
  it('新建文件全部算新增', () => {
    expect(lineStats(null, 'a\nb\n')).toEqual({ additions: 2, deletions: 0 });
  });
  it('countLines 不把结尾换行算成新的一行', () => {
    expect([countLines(''), countLines('a'), countLines('a\nb\n'), countLines('a\r\nb')]).toEqual([0, 1, 2, 2]);
  });
});

describe('reverseToolDiffs', () => {
  it('把片段从当前文件反向应用，得到修改前内容', () => {
    expect(reverseToolDiffs(AFTER, [TOOL_DIFF])).toBe(BEFORE);
  });
  it('多个片段从后往前还原', () => {
    const current = 'A2\nmid\nB2\n';
    expect(reverseToolDiffs(current, [{ oldText: 'A1', newText: 'A2' }, { oldText: 'B1', newText: 'B2' }])).toBe('A1\nmid\nB1\n');
  });
  it('CRLF 文件保持 CRLF', () => {
    expect(reverseToolDiffs(AFTER.replace(/\n/gu, '\r\n'), [TOOL_DIFF])).toBe(BEFORE.replace(/\n/gu, '\r\n'));
  });
  it('文件之后又被改过（片段找不到）时放弃', () => {
    expect(reverseToolDiffs('# m2\nsomething else\n', [TOOL_DIFF])).toBeUndefined();
  });
  it('片段在文件里出现不止一次时放弃，不猜测', () => {
    expect(reverseToolDiffs('x\nx\n', [{ oldText: 'y', newText: 'x' }])).toBeUndefined();
  });
});

describe('reverseHunks', () => {
  it('按行号核对后反向应用', () => {
    expect(reverseHunks(AFTER, [HUNK])).toBe(BEFORE);
  });
  it('新建的文件还原成空', () => {
    expect(reverseHunks('a\nb\n', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }])).toBe('');
  });
  it('删除的文件从空内容还原', () => {
    expect(reverseHunks('', [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] }])).toBe('a\nb');
  });
  it('多个 hunk 互不影响行号', () => {
    const current = 'A\n2\n3\n4\n5\n6\n7\n8\nB\n';
    const hunks = [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ['-b', '+B'] },
    ];
    expect(reverseHunks(current, hunks)).toBe('a\n2\n3\n4\n5\n6\n7\n8\nb\n');
  });
  it('当前内容和 hunk 对不上时放弃', () => {
    expect(reverseHunks('# m2\nchanged later\nline 2.5\nline3\n', [HUNK])).toBeUndefined();
  });
  it('兜底的统一 diff 带行号', () => {
    expect(unifiedFromHunks('README.md', [HUNK])).toBe(
      '--- README.md\n+++ README.md\n@@ -1,3 +1,4 @@\n # m2\n-line2\n+line two\n+line 2.5\n line3\n',
    );
  });
});

describe('proposedContent', () => {
  it('write 直接是新内容', () => {
    expect(proposedContent('write', { file_path: 'a', content: 'x' }, undefined)).toBe('x');
  });
  it('edit 替换唯一的 old_string', () => {
    expect(proposedContent('edit', { old_string: 'line2', new_string: 'L2' }, BEFORE)).toBe('# m2\nL2\nline3\n');
  });
  it('edit 的 old_string 不唯一且没有 replace_all 时无法预览', () => {
    expect(proposedContent('edit', { old_string: 'line', new_string: 'L' }, BEFORE)).toBeUndefined();
  });
  it('replace_all 替换全部', () => {
    expect(proposedContent('edit', { old_string: 'line', new_string: 'L', replace_all: true }, BEFORE)).toBe('# m2\nL2\nL3\n');
  });
  it('文件不存在时 edit 无法预览', () => {
    expect(proposedContent('edit', { old_string: 'a', new_string: 'b' }, undefined)).toBeUndefined();
  });
});
