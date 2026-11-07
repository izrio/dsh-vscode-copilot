/** ACP 底层（下一步实现）。 */
import type { BackendHost } from './dsh.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

export function createAcpBackend(profile: Extract<BackendProfile, { kind: 'acp' }>, _host: BackendHost): RunningBackend {
  throw new Error(`ACP 底层 ${profile.name} 尚未实现`);
}
