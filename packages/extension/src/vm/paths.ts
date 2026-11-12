/** 路径的显示形式（两种底层共用）。 */
import { isAbsolute, relative } from 'node:path';

/** 工作区内的文件显示相对路径，工作区外的保持绝对路径。 */
export function displayPath(path: string, workspacePath?: string): string {
  if (!workspacePath || !isAbsolute(path)) return path;
  const rel = relative(workspacePath, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}
