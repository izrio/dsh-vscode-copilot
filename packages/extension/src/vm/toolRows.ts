/**
 * 工具调用怎么显示成一行（两种底层共用）：按工具名归类（命令、修改、浏览、子代理、其他），从参数里取最能说明这次调用的一项做摘要。
 * 纯函数，只看工具名和参数，不涉及任何底层的协议。
 */
import { joinLabel } from '@harness-deck/shared';
import { t } from '../i18n.ts';
import { displayPath } from './paths.ts';
import { canonicalTool } from './toolNames.ts';

const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'shell']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);
const EXPLORE_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'ls', 'list']);

/** 按工具类型渲染；带前缀或别名的工具（`ops_grep`、`read_files`）按归一后的名字判断。 */
export function toolVariant(tool: string): 'command' | 'edit' | 'explore' | 'subagent' | 'generic' {
  const name = canonicalTool(tool);
  if (name === 'subagent') return 'subagent';
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (EXPLORE_TOOLS.has(name)) return 'explore';
  return 'generic';
}

/** 工具参数是 JSON 字符串；不是合法 JSON 时当作没有参数。 */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 表示目标文件的参数名（各家工具叫法不同）。 */
export const FILE_KEYS = ['file_path', 'notebook_path', 'file', 'filename', 'target_file', 'filepath'] as const;

/** 字符串数组参数；元素也可以是带 path 的对象。 */
export function stringList(args: Readonly<Record<string, unknown>>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    const list = value
      .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { path?: unknown; file_path?: unknown }).path ?? (item as { file_path?: unknown }).file_path : undefined))
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (list.length) return list;
  }
  return [];
}

export function stringArg(args: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 工具调用的一行摘要：取最能说明这次调用的参数。 */
export function activityLabel(tool: string, rawArguments: unknown, workspacePath?: string): string {
  const args = parseArguments(rawArguments);
  const pick = (...keys: string[]): string | undefined => stringArg(args, ...keys);
  const kind = canonicalTool(tool);
  // 优先级：命令 > 目标文件 > 搜索词 / URL > 目录 > 描述
  if (kind === 'exit_plan_mode') {
    const plan = typeof args.plan === 'string' ? args.plan : '';
    const heading = /^#{1,6}\s+(.+?)\s*$/mu.exec(plan)?.[1];
    return joinLabel(t('plan.label'), heading ?? t('plan.untitled'));
  }
  if (kind === 'ask_user_question') {
    const first = (args.questions as { question?: unknown }[] | undefined)?.[0]?.question;
    return typeof first === 'string' ? joinLabel(t('question.label'), firstLine(first)) : t('question.label');
  }
  const command = pick('command', 'cmd', 'script');
  if (command) return joinLabel(tool, firstLine(command));
  const file = pick(...FILE_KEYS);
  if (file) return joinLabel(tool, displayPath(file, workspacePath));
  // 一次读多个文件的工具（read_files）：第一个文件 + 其余数量
  const files = stringList(args, 'paths', 'files', 'file_paths');
  if (files.length) return joinLabel(tool, `${displayPath(files[0]!, workspacePath)}${files.length > 1 ? ` +${files.length - 1}` : ''}`);
  const target = pick('pattern', 'query', 'url');
  if (target) return joinLabel(tool, firstLine(target));
  const path = pick('path');
  if (path) return joinLabel(tool, displayPath(path, workspacePath));
  const other = pick('description', 'prompt', 'name');
  if (other) return joinLabel(tool, firstLine(other));
  return tool;
}

export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length < text.length ? `${line} …` : line;
}
