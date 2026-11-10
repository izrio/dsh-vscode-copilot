import { describe, expect, it } from 'vitest';
import { parseFileLink } from '../src/components/Markdown.tsx';

describe('回复里的本地文件链接', () => {
  it('解析路径和行号', () => {
    expect(parseFileLink('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseFileLink('src/a.ts#L12')).toEqual({ path: 'src/a.ts', startLine: 12 });
    expect(parseFileLink('src/a.ts#L12-L20')).toEqual({ path: 'src/a.ts', startLine: 12, endLine: 20 });
    expect(parseFileLink('a.ts:7')).toEqual({ path: 'a.ts', startLine: 7 });
    expect(parseFileLink('src/my%20file.ts')).toEqual({ path: 'src/my file.ts' });
    expect(parseFileLink('file:///home/u/p/a.ts#L3')).toEqual({ path: '/home/u/p/a.ts', startLine: 3 });
    expect(parseFileLink('C:\\proj\\a.ts:4')).toEqual({ path: 'C:\\proj\\a.ts', startLine: 4 });
  });

  it('其他协议和页内锚点不当作文件', () => {
    expect(parseFileLink('https://example.com/a.ts')).toBeUndefined();
    expect(parseFileLink('mailto:a@b.c')).toBeUndefined();
    expect(parseFileLink('javascript:alert(1)')).toBeUndefined();
    expect(parseFileLink('#section')).toBeUndefined();
    expect(parseFileLink('')).toBeUndefined();
  });
});
