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
