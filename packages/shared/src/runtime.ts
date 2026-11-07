/** 底层运行时（dsh 或 ACP 代理进程）在界面上的状态。Host 与 Webview 共用。 */
export type RuntimeStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating' }
  /** `detail`：找不到哪个命令、怎么安装（ACP 底层由 Host 给出；dsh 用界面自带的说明）。 */
  | { readonly kind: 'notInstalled'; readonly detail?: string }
  | { readonly kind: 'unsupportedVersion'; readonly version: string; readonly minimum: string }
  | { readonly kind: 'starting'; readonly version?: string }
  | { readonly kind: 'connected'; readonly version: string; readonly newerThanTested: boolean }
  | { readonly kind: 'reconnecting'; readonly attempt: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'untrusted' };
