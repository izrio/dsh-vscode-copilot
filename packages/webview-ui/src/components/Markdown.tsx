/**
 * Markdown 渲染。不启用原始 HTML（react-markdown 默认就不渲染），链接一律交给 Host 校验后在外部打开。
 */
import { memo, type ComponentProps, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { postToHost } from '../vscode.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { useT } from '../i18n.ts';

/** 本地文件链接：`src/a.ts`、`src/a.ts#L12`、`src/a.ts#L12-L20`、`src/a.ts:12`、`file:///…`。 */
export function parseFileLink(href: string): { path: string; startLine?: number; endLine?: number } | undefined {
  if (!href || href.startsWith('#')) return undefined;
  let target = href;
  if (/^file:/iu.test(target)) {
    try {
      const url = new URL(target);
      target = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/u, '$1') + url.hash;
    } catch {
      return undefined;
    }
  } else if (/^[A-Za-z][\w+.-]+:\/\//u.test(target) || /^(?:mailto|data|javascript|vscode|command|tel):/iu.test(target)) {
    // 其他协议不处理（`a.ts:12` 这样的行号和 Windows 盘符 `C:\` 不算协议）
    return undefined;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    // 保持原样
  }
  const hash = /#L(\d+)(?:-L?(\d+))?$/u.exec(target);
  const colon = hash ? undefined : /:(\d+)(?:-(\d+))?$/u.exec(target);
  const match = hash ?? colon;
  const path = (match ? target.slice(0, match.index) : target).replace(/#.*$/u, '');
  if (!path) return undefined;
  const startLine = match?.[1] ? Number(match[1]) : undefined;
  const endLine = match?.[2] ? Number(match[2]) : undefined;
  return { path, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) };
}

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  event.preventDefault();
  if (!href) return;
  if (/^https?:\/\//iu.test(href)) {
    postToHost({ type: 'openExternal', payload: { url: href } });
    return;
  }
  const file = parseFileLink(href);
  if (file) postToHost({ type: 'openFile', payload: file });
}

const components: Components = {
  a: ({ href, children }: ComponentProps<'a'>) => (
    <a
      href={href}
      onClick={(event) => openLink(event, href)}
      title={href}
      {...(href && !/^https?:/iu.test(href) && parseFileLink(href) ? { className: 'markdown__file-link' } : {})}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const lang = /language-([\w+#.-]+)/u.exec(className ?? '')?.[1];
    // 带语言标记或多行的是代码块，其余是行内代码
    if (lang || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/u, '')} {...(lang ? { lang } : {})} />;
    return <code className="inline-code">{children}</code>;
  },
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <ImagePlaceholder alt={alt} />,
};

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
