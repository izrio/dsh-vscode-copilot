import { useEffect, useState } from 'react';
import type { HostToWebview, RuntimeStatus } from '@dsh-copilot/shared';
import { postToHost } from './vscode.ts';

/** M0：只显示 dsh 运行时状态。对话界面在 M1 实现（docs/DESIGN.md 3.1、5.5）。 */
export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus>({ kind: 'idle' });

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const message = event.data;
      if (message.type === 'snapshot') setRuntime(message.payload.runtime);
      else if (message.type === 'runtimeStatus') setRuntime(message.payload);
    };
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready', payload: {} });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <main className="app">
      <RuntimeBanner status={runtime} />
    </main>
  );
}

function RuntimeBanner({ status }: { status: RuntimeStatus }) {
  const { title, detail, tone, actions } = describe(status);
  return (
    <section className={`banner banner--${tone}`} role="status">
      <p className="banner__title">{title}</p>
      {detail ? <p className="banner__detail">{detail}</p> : null}
      {actions ? (
        <div className="banner__actions">
          <button type="button" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            重试
          </button>
          <button type="button" className="secondary" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            查看日志
          </button>
        </div>
      ) : null}
    </section>
  );
}

function describe(status: RuntimeStatus): { title: string; detail?: string; tone: 'info' | 'ok' | 'warn'; actions?: boolean } {
  switch (status.kind) {
    case 'idle':
    case 'locating':
      return { title: '正在查找 dsh…', tone: 'info' };
    case 'starting':
      return { title: '正在启动 dsh…', detail: status.version ? `版本 ${status.version}` : undefined, tone: 'info' };
    case 'connected':
      return {
        title: `dsh ${status.version} 已就绪`,
        detail: status.newerThanTested ? '这个 dsh 版本比插件测试过的更新，部分功能可能不可用。' : '对话界面将在下一个里程碑提供。',
        tone: 'ok',
      };
    case 'reconnecting':
      return { title: `dsh 意外退出，正在重启（第 ${status.attempt} 次）`, tone: 'warn' };
    case 'notInstalled':
      return {
        title: '找不到 dsh',
        detail: '请安装 DeepSeek Desktop 并在菜单「管理 dsh 命令…」中安装 dsh 命令，或执行 npm install -g @deepseek-ai/dsh（需要 Node 24.9 以上），也可以在设置 dsh.runtime.path 中指定路径。',
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
