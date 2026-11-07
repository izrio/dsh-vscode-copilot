/**
 * 底层配置：dsh，内置的 ACP 代理（oh-my-pi、CodeBuddy），加上设置 `harnessDeck.backends` 里的 ACP 代理。
 * 设置里和内置项 id 相同的一项覆盖内置项（例如改成完整路径），其余追加在后面。
 * 纯函数，便于测试；extension.ts 负责读设置。
 */
import type { BackendView } from '@harness-deck/shared';
import type { BackendProfile } from './types.ts';

/** 设置里一项 ACP 底层的原始值（用户手写，逐项校验）。 */
export interface AcpProfileSetting {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly installHint?: unknown;
  readonly singleSession?: unknown;
}

export const DSH_PROFILE: BackendProfile = { id: 'dsh', kind: 'dsh', name: 'dsh' };

type AcpProfile = Extract<BackendProfile, { kind: 'acp' }>;

/**
 * 内置的 ACP 代理。不放在设置的默认值里：用户改过 `harnessDeck.backends` 后，设置的默认值就不再生效，新加的内置项会看不到。
 * @param hint - 安装提示的文案（Host 侧 i18n）。
 */
export function builtinProfiles(hint: (id: 'oh-my-pi' | 'codebuddy' | 'claude' | 'claude-sign-in') => string): AcpProfile[] {
  return [
    { id: 'oh-my-pi', kind: 'acp', name: 'oh-my-pi', command: 'omp', args: ['acp'], env: {}, installHint: hint('oh-my-pi') },
    // CodeBuddy 2.x 的 ACP 只给一个会话推送实时更新，见 BackendProfile.singleSession
    { id: 'codebuddy', kind: 'acp', name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'], env: {}, installHint: hint('codebuddy'), singleSession: true },
    // Claude Code 通过 ACP 官方适配器（Claude Agent SDK）接入；登录状态和 Claude Code 共用
    { id: 'claude', kind: 'acp', name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, installHint: hint('claude'), signInHint: hint('claude-sign-in') },
  ];
}

/**
 * 解析设置里的 ACP 底层。缺少名称或命令的项跳过；id 默认取名称，重复时只保留第一个。
 * @param log - 跳过的项写日志。
 * @param builtins - 内置的 ACP 代理：id 和设置里某一项相同时用设置里的那项（位置不变）。
 */
export function parseProfiles(raw: unknown, log: (line: string) => void = () => undefined, builtins: readonly AcpProfile[] = []): BackendProfile[] {
  const fromSettings = parseSettings(raw, log);
  const overrides = new Map(fromSettings.map((p) => [p.id, p]));
  const builtinIds = new Set(builtins.map((p) => p.id));
  return [
    DSH_PROFILE,
    ...builtins.map((builtin) => {
      const override = overrides.get(builtin.id);
      // 覆盖时没写安装提示，沿用内置的
      if (!override) return builtin;
      return {
        ...override,
        ...(override.installHint || !builtin.installHint ? {} : { installHint: builtin.installHint }),
        // 代理本身的限制：覆盖命令路径时沿用，除非明确写了 false
        ...(override.singleSession === undefined && builtin.singleSession ? { singleSession: true } : {}),
        ...(builtin.signInHint ? { signInHint: builtin.signInHint } : {}),
      };
    }),
    ...fromSettings.filter((p) => !builtinIds.has(p.id)),
  ];
}

function parseSettings(raw: unknown, log: (line: string) => void): AcpProfile[] {
  const profiles: AcpProfile[] = [];
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
      ...(typeof item.singleSession === 'boolean' ? { singleSession: item.singleSession } : {}),
    });
  }
  return profiles;
}

/** 内置底层的安装命令（选择卡片里可以复制）。 */
const INSTALL_COMMANDS: Readonly<Record<string, string>> = {
  dsh: 'npm install -g @deepseek-ai/dsh',
  'oh-my-pi': 'bun install -g @oh-my-pi/pi-coding-agent',
  codebuddy: 'npm install -g @tencent-ai/codebuddy-code',
  claude: 'npm install -g @agentclientprotocol/claude-agent-acp',
};

/**
 * 界面上的一项底层。
 * @param available - 本机能不能找到命令；还没检查时不传。
 */
export function profileView(profile: BackendProfile, available?: boolean): BackendView {
  const installCommand = INSTALL_COMMANDS[profile.id];
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    ...(profile.kind === 'acp' ? { command: [profile.command, ...profile.args].join(' ') } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(installCommand ? { installCommand } : {}),
    ...(profile.kind === 'acp' && profile.installHint && !installCommand ? { installHint: profile.installHint } : {}),
  };
}
