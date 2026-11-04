/** dsh 运行时在界面上的状态。Host 与 Webview 共用。 */
export type RuntimeStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating' }
  | { readonly kind: 'notInstalled' }
  | { readonly kind: 'unsupportedVersion'; readonly version: string; readonly minimum: string }
  | { readonly kind: 'starting'; readonly version?: string }
  | { readonly kind: 'connected'; readonly version: string; readonly newerThanTested: boolean }
  | { readonly kind: 'reconnecting'; readonly attempt: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'untrusted' };
