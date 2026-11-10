/**
 * 斜杠命令目录：插件自带的模板（/explain 等）和 dsh 的原生命令（各会话相同，打开会话时读取一次）。
 */
import type { CommandView } from '@dsh-copilot/shared';
import type { DshClient } from '../dsh/DshClient.ts';
import { describeError } from '../util/errors.ts';
import { PLUGIN_COMMAND_NAMES, pluginCommands } from './context.ts';

/** 在 VS Code 里没有意义的 dsh 命令（/export 在浏览器里触发下载）。 */
const HIDDEN_DSH_COMMANDS = new Set(['export']);

export class SlashCommands {
  private dsh: CommandView[] = [];
  private loading = false;

  constructor(
    private readonly onChange: () => void,
    private readonly log: (line: string) => void,
  ) {}

  /** dsh 有这个命令（交给 dsh 执行）。 */
  isDshCommand(name: string): boolean {
    return this.dsh.some((c) => c.name === name);
  }

  /** 插件命令在前；说明文字按当前界面语言。 */
  list(): CommandView[] {
    return [...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })), ...this.dsh];
  }

  /** 读取 dsh 的命令目录；已经读到或正在读取时不重复。失败只记日志，下次打开会话时再试。 */
  load(client: DshClient, sessionId: string): void {
    if (this.dsh.length > 0 || this.loading) return;
    this.loading = true;
    // 放进 then 里调用：读取失败（包括同步抛错）都不能影响打开会话
    void Promise.resolve()
      .then(() => client.commands(sessionId))
      .then(
        (commands) => {
          this.dsh = commands
            .filter((c) => !HIDDEN_DSH_COMMANDS.has(c.name) && !(PLUGIN_COMMAND_NAMES as readonly string[]).includes(c.name))
            .map((c) => ({ name: c.name, description: c.description ?? '', ...(c.input?.hint ? { hint: c.input.hint } : {}), source: 'dsh' as const }));
          this.onChange();
        },
        (error: unknown) => this.log(`读取斜杠命令失败：${describeError(error)}`),
      )
      .finally(() => {
        this.loading = false;
      });
  }
}
