import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n.ts';

describe('Webview 文案', () => {
  it('按语言取文案并填入参数', () => {
    expect(translator('zh')('changes.title', 3)).toBe('3 个文件已更改');
    expect(translator('en')('changes.title', 3)).toBe('3 files changed');
    // 英文按数量选单复数
    expect(translator('en')('changes.title', 1)).toBe('1 file changed');
    expect(translator('en')('dock.dirtyTitle', 1)).toContain('1 file has unsaved changes');
    expect(translator('en')('dock.dirtyTitle', 2)).toContain('2 files have unsaved changes');
    expect(translator('en')('chip.lines', 'a.ts', 1, 2)).toBe('a.ts lines 1–2');
    expect(translator('en')('composer.send')).toBe('Send');
  });
});
