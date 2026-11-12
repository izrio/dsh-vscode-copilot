/**
 * 代码高亮：按需加载 shiki（纯 JS 正则引擎，不需要 WASM），只在出现代码块时才加载。
 * 同时生成浅色和深色两套配色，由 CSS 根据 VS Code 主题选择（见 styles/05-markdown.css 的 .shiki 规则）。
 *
 * 输出 token 而不是 HTML 字符串：Webview 的 CSP 不允许内联 style 属性（没有 'unsafe-inline'），
 * 用 innerHTML 插入的 `style="--shiki-dark:…"` 会被浏览器拦掉；React 通过 CSSOM 设置样式则不受影响。
 */
import type { HighlighterCore, LanguageInput } from 'shiki/core';

const LANGUAGES: Record<string, () => Promise<{ default: LanguageInput }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  htm: 'html',
  jsonc: 'json',
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();
/** 一个高亮片段：文本和它的颜色变量（--shiki-light / --shiki-dark）。 */
export interface Token {
  readonly content: string;
  readonly style: Readonly<Record<string, string>>;
}

export type HighlightedLines = readonly (readonly Token[])[];

/**
 * 已高亮的结果。流式回复结束时条目会从临时 id 换成持久 id，代码块随之重新挂载；
 * 有缓存就能同步拿到结果，不会闪回未高亮的样子。
 */
const cache = new Map<string, HighlightedLines>();
const CACHE_LIMIT = 200;

/** 同步读取已有的高亮结果。 */
export function cachedHighlight(code: string, lang: string | undefined): HighlightedLines | undefined {
  return cache.get(`${lang ?? ''}\u0000${code}`);
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light-default.mjs'), import('shiki/themes/github-dark-default.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

export function resolveLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const key = lang.toLowerCase();
  const name = ALIASES[key] ?? key;
  return name in LANGUAGES ? name : undefined;
}

/**
 * 把代码切成带颜色的 token，按行组织。
 * @returns 语言不支持时返回 undefined，调用方显示纯文本。
 */
export async function highlight(code: string, lang: string | undefined): Promise<HighlightedLines | undefined> {
  const name = resolveLanguage(lang);
  if (!name) return undefined;
  const core = await getHighlighter();
  if (!loaded.has(name)) {
    await core.loadLanguage((await LANGUAGES[name]!()).default);
    loaded.add(name);
  }
  const result = core.codeToTokens(code, {
    lang: name,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  });
  const lines: HighlightedLines = result.tokens.map((line) =>
    line.map((token) => ({ content: token.content, style: (token.htmlStyle ?? {}) as Record<string, string> })),
  );
  const key = `${lang ?? ''}\u0000${code}`;
  cache.set(key, lines);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return lines;
}
