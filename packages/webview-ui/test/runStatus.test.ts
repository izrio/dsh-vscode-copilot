import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n.ts';

describe('用时格式', () => {
  it('秒、分、小时', async () => {
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
    const { formatDuration } = await import('../src/components/RunStatus.tsx');
    expect(formatDuration(12_400, translator('zh'))).toBe('12 秒');
    expect(formatDuration(83_000, translator('zh'))).toBe('1 分 23 秒');
    expect(formatDuration(3_720_000, translator('en'))).toBe('1h 2m');
    expect(formatDuration(-5, translator('en'))).toBe('0s');
  });
});
