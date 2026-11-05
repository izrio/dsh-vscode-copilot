import { memo, useEffect, useState, type CSSProperties } from 'react';
import { cachedHighlight, highlight, type HighlightedLines } from './highlighter.ts';
import { CheckIcon, CopyIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

/** 代码块：语言标签、复制按钮、按需高亮。流式输出时代码还在变化，高亮会稍后跟上。 */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [lines, setLines] = useState<HighlightedLines | undefined>(() => cachedHighlight(code, lang));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const cached = cachedHighlight(code, lang);
    if (cached) {
      setLines(cached);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      highlight(code, lang).then(
        (result) => {
          if (!cancelled) setLines(result);
        },
        () => undefined,
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang]);

  const t = useT();
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    });
  };

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{lang ?? ''}</span>
        <button type="button" className="icon-button" onClick={copy} aria-label={t('code.copy')} title={copied ? t('code.copied') : t('code.copyShort')}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <pre className={`code-block__body${lines ? ' shiki' : ''}`}>
        <code>
          {lines
            ? lines.map((line, i) => (
                <span className="line" key={i}>
                  {line.map((token, j) => (
                    <span key={j} style={token.style as CSSProperties}>
                      {token.content}
                    </span>
                  ))}
                  {i < lines.length - 1 ? '\n' : null}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
});
