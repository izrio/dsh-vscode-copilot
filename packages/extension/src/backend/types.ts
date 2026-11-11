/**
 * 底层（backend）：插件对话面板背后的编程代理。dsh 是内置的一种，其他代理通过 ACP（Agent Client Protocol）接入。
 *
 * 每种底层有自己的控制器，负责把底层的会话数据投影成界面视图模型（shared/viewModel），并处理 Webview 的消息；
 * 界面本身不区分底层。extension.ts 同一时间只运行一个底层，切换时停掉旧的、启动新的，Webview 重新取快照。
 */
import type { AppearanceState, BackendsState, HostSnapshot, HostToWebview, ModelState, RuntimeStatus, WebviewToHost } from '@harness-deck/shared';
import type { TemplateName } from '../vm/context.ts';
import type { Workbench } from '../vm/workbench.ts';

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

/** 两种底层的控制器都需要、由 extension.ts 提供的能力：Webview 推送、编辑器、外观、底层列表等。 */
export interface ControllerHostOptions {
  readonly post: (message: HostToWebview) => void;
  readonly log: (line: string) => void;
  readonly openExternal: (url: string) => void;
  readonly showLogs: () => void;
  /** 当前模型的显示名变化时调用（状态栏用）。 */
  readonly onModelChange?: (label: string | undefined) => void;
  /** 打开 Diff、未保存文件、确认框、当前编辑器。 */
  readonly workbench?: Workbench;
  /** 设置 `harnessDeck.context.includeActiveEditor`：默认附带当前编辑器。 */
  readonly includeActiveEditor?: () => boolean;
  /** 多根工作区：让用户选择文件夹（选好后调用 setWorkspace）。 */
  readonly selectFolder?: () => void;
  /** 多根工作区时当前文件夹的显示名。 */
  readonly folderLabel?: () => string | undefined;
  /** 合并推送的间隔（测试里设成 0）；不传时面板可见 30ms、隐藏 500ms。 */
  readonly renderDelayMs?: number;
  /** 面板是否可见。隐藏时 Webview 收不到消息（重新显示时取快照），不必按流式输出的节奏计算和推送。 */
  readonly isVisible?: () => boolean;
  /** 界面字号和字体（设置 `harnessDeck.ui.*`）。 */
  readonly appearance?: () => AppearanceState;
  /** 打开插件的界面设置。 */
  readonly openSettings?: () => void;
  /** 可选的底层和当前底层（随快照下发，Webview 的「…」菜单里切换）。 */
  readonly backends?: () => BackendsState;
  /** 写入字体设置（harnessDeck.ui.*）；值为 null 时恢复默认。 */
  readonly setAppearance?: (patch: {
    readonly fontSize?: number | null;
    readonly fontFamily?: string | null;
    readonly codeFontFamily?: string | null;
    readonly palette?: 'soft' | 'theme' | null;
  }) => Promise<void>;
}

/** 合并推送的间隔：流式输出时不产生消息风暴；面板隐藏时放慢。 */
export function renderDelay(options: Pick<ControllerHostOptions, 'renderDelayMs' | 'isVisible'>): number {
  return options.renderDelayMs ?? (options.isVisible?.() === false ? 500 : 30);
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
      /**
       * 一个进程只给一个会话推送实时更新（CodeBuddy：最近 session/new 的会话，或新进程里第一个 session/load 的会话）。
       * 在别的会话里发消息前要重启代理再加载那个会话。
       */
      readonly singleSession?: boolean;
      /** 代理要求登录、又没有提供登录方式时给用户的说明（Claude：在终端运行 claude 登录，或设置 ANTHROPIC_API_KEY）。 */
      readonly signInHint?: string;
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
