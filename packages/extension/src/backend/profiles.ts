/**
 * 底层配置：内置的 dsh，加上设置 `dsh.backends` 里的 ACP 代理（默认带一个 oh-my-pi）。
 * 纯函数，便于测试；extension.ts 负责读设置。
 */
import type { BackendView } from '@dsh-copilot/shared';
import type { BackendProfile } from './types.ts';

/** 设置里一项 ACP 底层的原始值（用户手写，逐项校验）。 */
export interface AcpProfileSetting {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly installHint?: unknown;
}

export const DSH_PROFILE: BackendProfile = { id: 'dsh', kind: 'dsh', name: 'dsh' };

/**
 * 解析设置里的 ACP 底层。缺少名称或命令的项跳过；id 默认取名称，重复时只保留第一个。
 * @param log - 跳过的项写日志。
 */
export function parseProfiles(raw: unknown, log: (line: string) => void = () => undefined): BackendProfile[] {
  const profiles: BackendProfile[] = [DSH_PROFILE];
  const seen = new Set<string>(['dsh']);
  for (const item of Array.isArray(raw) ? (raw as AcpProfileSetting[]) : []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const command = typeof item?.command === 'string' ? item.command.trim() : '';
    if (!name || !command) {
      log(`底层配置缺少 name 或 command，已跳过：${JSON.stringify(item)}`);
      continue;
    }
    const id = (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : name).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
    if (seen.has(id)) {
      log(`底层配置的 id 重复（${id}），已跳过后面的一项`);
      continue;
    }
    seen.add(id);
    const args = Array.isArray(item.args) ? item.args.filter((a): a is string => typeof a === 'string') : [];
    const env =
      item.env && typeof item.env === 'object' && !Array.isArray(item.env)
        ? Object.fromEntries(Object.entries(item.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : {};
    profiles.push({
      id,
      kind: 'acp',
      name,
      command,
      args,
      env,
      ...(typeof item.installHint === 'string' && item.installHint.trim() ? { installHint: item.installHint.trim() } : {}),
    });
  }
  return profiles;
}

export function profileView(profile: BackendProfile): BackendView {
  return { id: profile.id, name: profile.name, kind: profile.kind };
}
