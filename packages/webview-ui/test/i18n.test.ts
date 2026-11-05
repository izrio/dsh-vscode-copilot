import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n.ts';

describe('Webview 文案', () => {
  it('按语言取文案并填入参数', () => {
    expect(translator('zh')('changes.title', 3)).toBe('3 个文件已更改');
    expect(translator('en')('changes.title', 3)).toBe('3 file(s) changed');
    expect(translator('en')('chip.lines', 'a.ts', 1, 2)).toBe('a.ts lines 1–2');
    expect(translator('en')('composer.send')).toBe('Send');
  });
});
