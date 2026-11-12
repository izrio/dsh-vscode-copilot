/**
 * 各种底层共用的、由 extension.ts 提供的能力。
 */
import * as vscode from 'vscode';
import type { RuntimeStatus } from '@harness-deck/shared';
import type { ControllerHostOptions } from './types.ts';

export interface BackendHost {
  readonly context: vscode.ExtensionContext;
  readonly log: (line: string) => void;
  /** 底层进程的输出（已脱敏），写到「Harness Deck: Backend」输出面板。 */
  readonly runtimeLog: (line: string, stream: 'stdout' | 'stderr') => void;
  readonly workspacePath: () => string;
  /** 每种底层各自的 workspaceState 键（会话、标签不在底层之间混用）。 */
  readonly stateKey: (name: string) => string;
  /** 控制器的公共选项：Webview 推送、编辑器能力、外观、底层列表等。 */
  readonly controllerOptions: () => ControllerHostOptions & { readonly showTurnChanges?: () => boolean };
  readonly onStatus: (status: RuntimeStatus) => void;
}

/** 进程环境变量，加上 VS Code 的代理设置（模型请求由底层自己发出）。 */
export function processEnvWithProxy(extra: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  const proxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (proxy) {
    env.HTTPS_PROXY ??= proxy;
    env.HTTP_PROXY ??= proxy;
  }
  return env;
}
