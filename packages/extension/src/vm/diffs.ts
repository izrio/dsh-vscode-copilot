/**
 * 改动与 Diff 的纯函数：统计增删行数、从当前文件还原改动前内容、生成审批前的预览、渲染兜底的统一 diff。
 *
 * VS Code 的 Diff 编辑器需要完整的改动前文件，而 dsh 只记录了改动片段：
 * - 单次工具调用（`tool/result.meta.diffs`）：`{ oldText, newText }`，带三行上下文，没有行号；
 * - 本轮汇总（`/api/changes.diff`）：带行号的 hunk。
 * 做法是把片段从**当前**文件反向应用回去。文件之后又被改过、片段定位不唯一时放弃，不猜测——错的 Diff 比没有更糟。
 */
import { diffLines } from 'diff';

export interface ToolDiff {
  readonly oldText: string | null;
  readonly newText: string;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface LineStats {
  readonly additions: number;
  readonly deletions: number;
}

/** 两段文本之间的增删行数。 */
export function lineStats(oldText: string | null, newText: string): LineStats {
  let additions = 0;
  let deletions = 0;
  // 片段的最后一行通常没有换行符；不补齐的话 diffLines 会把「x」和「x\n」当成不同的行
  const close = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
  for (const part of diffLines(close(oldText ?? ''), close(newText))) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { additions, deletions };
}

export function sumStats(stats: readonly LineStats[]): LineStats {
  return stats.reduce((a, b) => ({ additions: a.additions + b.additions, deletions: a.deletions + b.deletions }), { additions: 0, deletions: 0 });
}

/** 文本的行数（结尾换行不算新的一行）。 */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r?\n$/u, '').split(/\r?\n/u).length;
}

interface Eol {
  readonly text: string;
  readonly restore: (text: string) => string;
}

/** dsh 的改动以 LF 为准；CRLF 文件先转成 LF 计算，结果再转回来。 */
function normalizeEol(text: string): Eol {
  if (!text.includes('\r\n')) return { text, restore: (t) => t };
  return { text: text.replace(/\r\n/gu, '\n'), restore: (t) => t.replace(/\n/gu, '\r\n') };
}

function indexOfUnique(haystack: string, needle: string): number | undefined {
  if (!needle) return undefined;
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return undefined;
  return first;
}

/**
 * 用单次工具调用的片段还原改动前内容。
 * @returns 改动前内容；定位不到或不唯一时返回 undefined。
 */
export function reverseToolDiffs(current: string, diffs: readonly ToolDiff[]): string | undefined {
  const eol = normalizeEol(current);
  let text = eol.text;
  for (const diff of [...diffs].reverse()) {
    const at = indexOfUnique(text, diff.newText);
    if (at === undefined) return undefined;
    text = text.slice(0, at) + (diff.oldText ?? '') + text.slice(at + diff.newText.length);
  }
  return eol.restore(text);
}

/**
 * 用带行号的 hunk 还原改动前内容；先逐行核对当前文件与 hunk 的新内容一致。
 * @returns 改动前内容；文件之后又被改过时返回 undefined。
 */
export function reverseHunks(current: string, hunks: readonly Hunk[]): string | undefined {
  const eol = normalizeEol(current);
  const endsWithNewline = eol.text.endsWith('\n');
  const lines = eol.text.length === 0 ? [] : eol.text.replace(/\n$/u, '').split('\n');
  const sorted = [...hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of sorted) {
    const newSide = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('+')).map((l) => l.slice(1));
    const oldSide = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('-')).map((l) => l.slice(1));
    // unified diff 里 newLines 为 0 时 newStart 指向前一行
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    for (let i = 0; i < newSide.length; i++) {
      if (lines[start + i] !== newSide[i]) return undefined;
    }
    lines.splice(start, newSide.length, ...oldSide);
  }
  if (lines.length === 0) return '';
  return eol.restore(lines.join('\n') + (endsWithNewline ? '\n' : ''));
}

/**
 * 审批前预览：按工具参数算出改动后的内容。
 * @param current - 当前文件内容；文件不存在时为 undefined。
 * @returns 改动后内容；看不懂参数或 old_string 定位失败时返回 undefined。
 */
export function proposedContent(tool: string, args: Record<string, unknown>, current: string | undefined): string | undefined {
  if (tool === 'write' && typeof args.content === 'string') return args.content;
  if (tool === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string' && current !== undefined) {
    const eol = normalizeEol(current);
    if (args.replace_all === true) {
      if (!eol.text.includes(args.old_string)) return undefined;
      return eol.restore(eol.text.split(args.old_string).join(args.new_string));
    }
    const at = indexOfUnique(eol.text, args.old_string);
    if (at === undefined) return undefined;
    return eol.restore(eol.text.slice(0, at) + args.new_string + eol.text.slice(at + args.old_string.length));
  }
  return undefined;
}

/** 还原失败时的兜底：把工具片段渲染成统一 diff 文本。 */
export function unifiedFromToolDiffs(path: string, diffs: readonly ToolDiff[]): string {
  const body = diffs
    .map((diff) => {
      const removed = (diff.oldText ?? '') === '' ? [] : (diff.oldText ?? '').split('\n').map((l) => `-${l}`);
      const added = diff.newText === '' ? [] : diff.newText.split('\n').map((l) => `+${l}`);
      return ['@@', ...removed, ...added].join('\n');
    })
    .join('\n');
  return `--- ${path}\n+++ ${path}\n${body}\n`;
}

/** 还原失败时的兜底：把带行号的 hunk 渲染成统一 diff 文本。 */
export function unifiedFromHunks(path: string, hunks: readonly Hunk[]): string {
  const body = hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n')).join('\n');
  return `--- ${path}\n+++ ${path}\n${body}\n`;
}
