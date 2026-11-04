/**
 * `@路径` 引用的语法，与 dsh 的 `@deepseek-ai/dsh-file-reference/grammar` 保持一致：
 * `@path` 或 `@"带空格的 path"`；目录以 `/` 结尾；邮箱地址里的 `@` 不算。
 */
import type { FileCandidate } from '@dsh-copilot/shared';

export interface ActiveAtToken {
  /** 接受补全时要替换掉的整段（含 `@`）。 */
  readonly prefix: string;
  /** `@` 或 `@"` 后面的路径文本。 */
  readonly query: string;
  readonly quoted: boolean;
}

/** 光标前正在输入的 `@` 引用。 */
export function activeAtToken(beforeCursor: string): ActiveAtToken | undefined {
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) return { prefix: quoted[1], query: quoted[2], quoted: true };
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false };
}

/** 选中的候选写成引用文本；路径里有引号或控制字符时返回 undefined（语法表示不了）。 */
export function formatFileMention(candidate: FileCandidate, preserveQuote: boolean): string | undefined {
  const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const quoted = preserveQuote || /\s/u.test(path);
  if (!quoted) return `@${path}`;
  if (candidate.kind === 'directory') return `@"${path}`;
  return `@"${path}"`;
}

export type TextPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mention'; readonly text: string; readonly path: string };

/** 把消息正文切成普通文本和 `@` 引用，用于在气泡里显示成可点击的路径。 */
export function splitMentions(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/gu)) {
    const lead = match[1] ?? '';
    let raw = match[0].slice(lead.length);
    let path = match[2] ?? match[3] ?? '';
    if (match[3]) {
      // 句末的标点不属于路径
      const trimmed = path.replace(/[，。、；：！？,.;:!?)）\]】]+$/u, '');
      raw = raw.slice(0, raw.length - (path.length - trimmed.length));
      path = trimmed;
    }
    if (!path) continue;
    const start = (match.index ?? 0) + lead.length;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'mention', text: raw, path: path.replace(/\/$/u, '') });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
