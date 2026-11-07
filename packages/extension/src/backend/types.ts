/**
 * 底层（backend）：插件对话面板背后的编程代理。dsh 是内置的一种，其他代理通过 ACP（Agent Client Protocol）接入。
 *
 * 每种底层有自己的控制器，负责把底层的会话数据投影成界面视图模型（shared/viewModel），并处理 Webview 的消息；
 * 界面本身不区分底层。extension.ts 同一时间只运行一个底层，切换时停掉旧的、启动新的，Webview 重新取快照。
 */
import type { HostSnapshot, ModelState, RuntimeStatus, WebviewToHost } from '@dsh-copilot/shared';
import type { TemplateName } from '../vm/context.ts';

/** 控制器对外的接口：extension.ts 和命令只通过它和当前底层打交道。 */
export interface ChatBackendController {
  handle(message: WebviewToHost): Promise<void>;
  /** Webview 加载（或切换底层）后的完整快照。 */
  snapshot(): HostSnapshot;
  modelState(): ModelState;
  askAboutSelection(template: TemplateName): Promise<void>;
  pinActiveEditor(): void;
  workspaceChanged(): void;
  localeChanged(): void;
  appearanceChanged(): void;
  /** 底层列表或当前底层变化（推送给 Webview）。 */
  backendsChanged(): void;
  setWorkspace(path: string): void;
  renameSession(): Promise<void>;
  configureApiKey(): Promise<void>;
  setRuntimeStatus(status: RuntimeStatus): void;
  dispose(): void;
}

/** 设置里配置的一个底层。 */
export type BackendProfile =
  | { readonly id: 'dsh'; readonly kind: 'dsh'; readonly name: string }
  | {
      readonly id: string;
      readonly kind: 'acp';
      readonly name: string;
      /** 启动 ACP 代理的命令和参数，例如 `omp` + `["acp"]`。 */
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      /** 找不到命令时给用户的安装提示。 */
      readonly installHint?: string;
    };

/** 正在运行的底层。 */
export interface RunningBackend {
  readonly profile: BackendProfile;
  readonly controller: ChatBackendController;
  /** 视图打开时启动（工作区受信任时）。 */
  start(): void;
  restart(): void;
  currentStatus(): RuntimeStatus;
  /** 停掉底层进程并释放控制器。 */
  stop(): Promise<void>;
}
