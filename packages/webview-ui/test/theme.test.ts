import { describe, expect, it } from 'vitest';
import { foregroundFor, isVivid, parseRgb, pickAccent } from '../src/theme.ts';

describe('强调色', () => {
  it('解析计算后的颜色', () => {
    expect(parseRgb('rgb(14, 99, 156)')).toEqual([14, 99, 156, 1]);
    expect(parseRgb('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0]);
    expect(parseRgb('rgb(10 20 30 / 50%)')).toEqual([10, 20, 30, 0.5]);
    expect(parseRgb('transparent')).toBeUndefined();
  });

  it('灰色、透明、太暗太亮的颜色不算有颜色', () => {
    expect(isVivid([14, 99, 156, 1])).toBe(true); // Dark+ 的按钮蓝
    expect(isVivid([90, 93, 94, 1])).toBe(false); // 灰色按钮
    expect(isVivid([0, 0, 0, 0])).toBe(false);
    expect(isVivid([55, 148, 255, 0.3])).toBe(false);
    expect(isVivid([250, 250, 255, 1])).toBe(false);
  });

  it('按钮和焦点色都是灰色时，退到链接色', () => {
    const theme: Record<string, string> = {
      '--vscode-button-background': 'rgb(90, 93, 94)',
      '--vscode-focusBorder': 'rgba(0, 0, 0, 0)',
      '--vscode-textLink-foreground': 'rgb(65, 132, 228)',
    };
    expect(pickAccent((name) => theme[name])).toEqual({ accent: 'rgb(65, 132, 228)', foreground: '#ffffff' });
  });

  it('按钮有颜色时用按钮色；都没有时用默认蓝', () => {
    expect(pickAccent((name) => (name === '--vscode-button-background' ? 'rgb(35, 134, 54)' : undefined)).accent).toBe('rgb(35, 134, 54)');
    expect(pickAccent(() => 'rgb(128, 128, 128)')).toEqual({ accent: '#3794ff', foreground: '#ffffff' });
  });

  it('亮的强调色配深色字', () => {
    expect(foregroundFor([255, 214, 102, 1])).toBe('#1e1e1e');
    expect(foregroundFor([14, 99, 156, 1])).toBe('#ffffff');
  });
});
