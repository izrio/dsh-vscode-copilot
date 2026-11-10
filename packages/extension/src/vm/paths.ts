/** 路径显示：工作区内的绝对路径显示成相对路径。 */
import { isAbsolute, relative } from 'node:path';

export function displayPath(path: string, workspacePath?: string): string {
  if (!workspacePath || !isAbsolute(path)) return path;
  const rel = relative(workspacePath, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}
