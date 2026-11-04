import { describe, expect, it } from 'vitest';
import { checkVersionSupport, compareVersions, parseVersion } from '../src/runtime/version.ts';

const v = (text: string) => {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`invalid ${text}`);
  return parsed;
};

describe('parseVersion', () => {
  it('解析带预发布标识和前后空白的版本', () => {
    expect(parseVersion(' 0.2.1-rc.5\n')).toEqual({ major: 0, minor: 2, patch: 1, prerelease: ['rc', 5] });
    expect(parseVersion('v1.0.0')).toMatchObject({ major: 1, prerelease: [] });
  });

  it('非法版本返回 undefined', () => {
    expect(parseVersion('dsh 0.2.1')).toBeUndefined();
    expect(parseVersion('0.2')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('按 SemVer 优先级排序', () => {
    const ordered = ['0.1.5-rc.1', '0.2.0-rc.2', '0.2.1-alpha.3', '0.2.1-rc.1', '0.2.1-rc.5', '0.2.1-rc.10', '0.2.1', '0.2.2-alpha.3'];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(v(ordered[i - 1]!), v(ordered[i]!)), `${ordered[i - 1]} < ${ordered[i]}`).toBeLessThan(0);
    }
  });

  it('相同版本相等', () => {
    expect(compareVersions(v('0.2.1-rc.5'), v('0.2.1-rc.5'))).toBe(0);
  });
});

describe('checkVersionSupport', () => {
  it('低于最低版本时 tooOld', () => {
    expect(checkVersionSupport('0.2.0-rc.2', '0.2.1-rc.5', '0.2.2-alpha.3')).toEqual({ kind: 'tooOld' });
  });

  it('范围内为 supported，高于已测试版本时标记 newerThanTested', () => {
    expect(checkVersionSupport('0.2.1-rc.5', '0.2.1-rc.5', '0.2.2-alpha.3')).toEqual({ kind: 'supported', newerThanTested: false });
    expect(checkVersionSupport('0.2.2', '0.2.1-rc.5', '0.2.2-alpha.3')).toEqual({ kind: 'supported', newerThanTested: true });
  });

  it('无法解析时 invalid', () => {
    expect(checkVersionSupport('unknown')).toEqual({ kind: 'invalid' });
  });
});
