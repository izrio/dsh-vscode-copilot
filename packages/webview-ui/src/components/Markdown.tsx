/**
 * Markdown 渲染。不启用原始 HTML（react-markdown 默认就不渲染），链接一律交给 Host 校验后在外部打开。
 */
import { memo, type ComponentProps, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { postToHost } from '../vscode.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { useT } from '../i18n.ts';

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  event.preventDefault();
  if (href && /^https?:\/\//iu.test(href)) postToHost({ type: 'openExternal', payload: { url: href } });
}

const components: Components = {
  a: ({ href, children }: ComponentProps<'a'>) => (
    <a href={href} onClick={(event) => openLink(event, href)} title={href}>
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const lang = /language-([\w+#.-]+)/u.exec(className ?? '')?.[1];
    // 带语言标记或多行的是代码块，其余是行内代码
    if (lang || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/u, '')} {...(lang ? { lang } : {})} />;
    const file = parseFileRef(text);
    if (file) return <FileRef text={text} file={file} />;
    return <code className="inline-code">{children}</code>;
  },
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <ImagePlaceholder alt={alt} />,
};

export interface FileRefTarget {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * 行内代码像不像一个文件路径（`src/utils/date.ts`、`packages/a/b.tsx:12`、`./x.py:3-9`）。
 * 要求带目录和扩展名：`Date.UTC`、`a/b` 这类不算，免得把普通代码变成链接。
 */
export function parseFileRef(text: string): FileRefTarget | undefined {
  const match = /^((?:\.{1,2}\/|\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:-(\d+))?)?$/u.exec(text);
  if (!match?.[1]) return undefined;
  const startLine = match[2] ? Number(match[2]) : undefined;
  const endLine = match[3] ? Number(match[3]) : undefined;
  return { path: match[1], ...(startLine ? { startLine } : {}), ...(startLine && endLine && endLine >= startLine ? { endLine } : {}) };
}

/** 回复里提到的文件：点击在编辑器里打开（带行号时定位过去）。文件不存在时由 Host 提示。 */
function FileRef({ text, file }: { text: string; file: FileRefTarget }) {
  const t = useT();
  return (
    <button type="button" className="inline-code inline-code--link" title={t('file.open', file.path)} onClick={() => postToHost({ type: 'openFile', payload: file })}>
      {text}
    </button>
  );
}

/** 不加载图片（CSP 也不允许外部图片），只显示占位文字。 */
function ImagePlaceholder({ alt }: { alt: string | undefined }) {
  const t = useT();
  return <span className="md-image-placeholder">{alt ? t('markdown.imageAlt', alt) : t('markdown.image')}</span>;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
