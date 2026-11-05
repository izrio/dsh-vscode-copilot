/**
 * 上下文用量的环形进度：随用量变色（70% 以上提醒，90% 以上警告），悬停显示用了多少 token。
 */
import { useT } from '../i18n.ts';

const SIZE = 16;
const STROKE = 2.2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 12345 → 12.3k，1048576 → 1.0M */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function ContextRing({ usage, tokens }: { usage: number; tokens?: { used: number; window: number } }) {
  const t = useT();
  const percent = Math.round(usage * 100);
  const level = usage >= 0.9 ? 'high' : usage >= 0.7 ? 'medium' : 'low';
  const title = tokens ? t('context.ring', percent, formatTokens(tokens.used), formatTokens(tokens.window)) : t('composer.context', percent);
  // 有用量时至少画出一小段，避免 1% 以下看起来是空的
  const filled = Math.max(usage, usage > 0 ? 0.02 : 0) * CIRCUMFERENCE;
  return (
    <span className={`context-ring context-ring--${level}`} title={title} role="img" aria-label={title} data-testid="context-ring">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
        <circle className="context-ring__track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} fill="none" />
        <circle
          className="context-ring__value"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="context-ring__label">{Math.max(percent, usage > 0 ? 1 : 0)}%</span>
    </span>
  );
}
