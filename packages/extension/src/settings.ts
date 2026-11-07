/**
 * 设置和命令的名称集中在这里（插件改名为 Harness Deck 后从 `dsh.*` 改成 `harnessDeck.*`）。
 */
import * as vscode from 'vscode';

/** 设置的根：`harnessDeck.ui.fontSize`、`harnessDeck.backends`…… */
export const SECTION = 'harnessDeck';

/** 命令 id：`harnessDeck.openChat`…… */
export const command = (name: string): string => `${SECTION}.${name}`;

/** `harnessDeck.<sub>` 这一节设置。 */
export function settings(sub?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(sub ? `${SECTION}.${sub}` : SECTION);
}

/** 旧名（dsh.*）→ 新名。 */
const RENAMED: readonly (readonly [string, string])[] = [
  ['dsh.runtime.path', 'dsh.path'],
  ['dsh.runtime.profile', 'dsh.profile'],
  ['dsh.backends', 'backends'],
  ['dsh.context.includeActiveEditor', 'context.includeActiveEditor'],
  ['dsh.ui.language', 'ui.language'],
  ['dsh.ui.fontSize', 'ui.fontSize'],
  ['dsh.ui.fontFamily', 'ui.fontFamily'],
  ['dsh.ui.codeFontFamily', 'ui.codeFontFamily'],
  ['dsh.ui.showTurnChanges', 'ui.showTurnChanges'],
];

/**
 * 把旧版本（DSH Copilot）的设置搬到新名下：新名在同一级还没有值时才搬，旧值保留不动。
 * @returns 搬过的设置名，写日志用。
 */
export async function migrateSettings(): Promise<string[]> {
  const moved: string[] = [];
  const root = vscode.workspace.getConfiguration();
  for (const [oldKey, newSuffix] of RENAMED) {
    const newKey = `${SECTION}.${newSuffix}`;
    const before = root.inspect(oldKey);
    const after = root.inspect(newKey);
    if (!before) continue;
    const levels: [unknown, unknown, vscode.ConfigurationTarget][] = [
      [before.globalValue, after?.globalValue, vscode.ConfigurationTarget.Global],
      [before.workspaceValue, after?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    ];
    for (const [value, existing, target] of levels) {
      if (value === undefined || existing !== undefined) continue;
      try {
        await root.update(newKey, value, target);
        moved.push(newKey);
      } catch {
        // 旧设置不在已注册的范围里（例如工作区没有打开文件夹）时跳过
      }
    }
  }
  return moved;
}
