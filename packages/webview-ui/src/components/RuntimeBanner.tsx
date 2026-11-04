/** dsh 运行时和连接状态提示。连接正常时不显示。 */
import type { ConnectionState, RuntimeStatus } from '@dsh-copilot/shared';
import { postToHost } from '../vscode.ts';

export function RuntimeBanner({ status, connection }: { status: RuntimeStatus; connection: ConnectionState }) {
  const view = describe(status, connection);
  if (!view) return null;
  return (
    <section className={`banner banner--${view.tone}`} role="status">
      <p className="banner__title">{view.title}</p>
      {view.detail ? <p className="banner__detail">{view.detail}</p> : null}
      {view.actions ? (
        <div className="banner__actions">
          <button type="button" className="button" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            重试
          </button>
          <button type="button" className="button button--secondary" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            查看日志
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface BannerView {
  readonly title: string;
  readonly detail?: string;
  readonly tone: 'info' | 'warn';
  readonly actions?: boolean;
}

export function describe(status: RuntimeStatus, connection: ConnectionState): BannerView | undefined {
  switch (status.kind) {
    case 'idle':
    case 'locating':
      return { title: '正在查找 dsh…', tone: 'info' };
    case 'starting':
      return { title: '正在启动 dsh…', ...(status.version ? { detail: `版本 ${status.version}` } : {}), tone: 'info' };
    case 'connected':
      if (connection !== 'connected') return { title: '正在连接 dsh…', tone: 'info' };
      return status.newerThanTested
        ? { title: `dsh ${status.version} 比插件测试过的版本更新`, detail: '部分功能可能不可用。', tone: 'info' }
        : undefined;
    case 'reconnecting':
      return { title: `dsh 意外退出，正在重启（第 ${status.attempt} 次）`, tone: 'warn' };
    case 'notInstalled':
      return {
        title: '找不到 dsh',
        detail:
          '请安装 DeepSeek Desktop 并在菜单「管理 dsh 命令…」中安装 dsh 命令，或执行 npm install -g @deepseek-ai/dsh（需要 Node 24.9 以上），也可以在设置 dsh.runtime.path 中指定路径。',
        tone: 'warn',
        actions: true,
      };
    case 'unsupportedVersion':
      return { title: `dsh ${status.version} 版本过低`, detail: `需要 ${status.minimum} 或更高版本。`, tone: 'warn', actions: true };
    case 'failed':
      return { title: 'dsh 启动失败', detail: status.message, tone: 'warn', actions: true };
    case 'untrusted':
      return { title: '工作区未受信任', detail: 'dsh 会在工作区中读写文件和执行命令，请先信任工作区。', tone: 'warn' };
  }
}
