/**
 * dsh 版本解析与比较（SemVer 2.0 优先级规则，含预发布标识）。
 *
 * 支持范围见 docs/DSH-INTEGRATION.md 第 8 节：
 * - 低于 MINIMUM_DSH_VERSION：不启动，提示升级；
 * - 版本线（major.minor）高于 TESTED_DSH_VERSION：照常启动，提示"版本较新"，靠能力探测降级。
 *   同一版本线里的补丁版和预发布版（例如 0.2.2-alpha.3 → 0.2.2-rc.1 → 0.2.5）不提示：
 *   每晚的兼容性 CI 会用 dsh 的 latest / alpha 跑一遍，提示只用来提醒跨版本线的升级。
 */

/** 支持的最低 dsh 版本（M0 实测）。 */
export const MINIMUM_DSH_VERSION = '0.2.1-rc.5';

/** 已经完整测试过的最高 dsh 版本（M0 实测）。 */
export const TESTED_DSH_VERSION = '0.2.2-alpha.3';

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * 解析版本号。`dsh --version` 的输出可能带前后空白，这里一并去掉。
 * @param text - 版本字符串，例如 `0.2.1-rc.5`。
 * @returns 解析结果；不是合法 SemVer 时返回 undefined。
 */
export function parseVersion(text: string): SemVer | undefined {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre === undefined ? [] : pre.split('.').map((id) => (/^\d+$/u.test(id) ? Number(id) : id)),
  };
}

/**
 * 按 SemVer 优先级比较两个版本。
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b。
 */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // 没有预发布标识的版本优先级更高：1.0.0 > 1.0.0-rc.1
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // 数字标识的优先级低于字母标识
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export type VersionSupport = { readonly kind: 'supported'; readonly newerThanTested: boolean } | { readonly kind: 'tooOld' } | { readonly kind: 'invalid' };

/**
 * 判断某个 dsh 版本是否在支持范围内。
 * @param text - `dsh --version` 的输出。
 */
export function checkVersionSupport(text: string, minimum: string = MINIMUM_DSH_VERSION, tested: string = TESTED_DSH_VERSION): VersionSupport {
  const version = parseVersion(text);
  const min = parseVersion(minimum);
  const max = parseVersion(tested);
  if (!version || !min || !max) return { kind: 'invalid' };
  if (compareVersions(version, min) < 0) return { kind: 'tooOld' };
  const newerLine = version.major !== max.major ? version.major > max.major : version.minor > max.minor;
  return { kind: 'supported', newerThanTested: newerLine };
}
