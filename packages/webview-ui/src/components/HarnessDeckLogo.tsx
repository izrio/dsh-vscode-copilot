/**
 * Harness Deck 的标志（与 packages/extension/media/logo.svg 相同）：两张卡片组成 H（deck：可以换的底层），
 * 背后斜着的卡片表示「一叠」，中间的挽带和节点把它们连起来（harness）。
 * 渐变 id 用 useId，页面上同时有两个标志时不会互相引用错。
 */
import { useId } from 'react';

export function HarnessDeckLogo({ className }: { readonly className?: string }) {
  const id = useId().replace(/:/gu, '');
  const bg = `${id}-bg`;
  const card = `${id}-card`;
  const glow = `${id}-glow`;
  return (
    <svg className={className} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2F5BFF" />
          <stop offset=".55" stopColor="#6A45F5" />
          <stop offset="1" stopColor="#A63DE8" />
        </linearGradient>
        <linearGradient id={card} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E2E6FF" />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="#FFD27A" stopOpacity=".9" />
          <stop offset="1" stopColor="#FFB547" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="128" height="128" rx="30" fill={`url(#${bg})`} />
      <rect x="24" y="30" width="25" height="72" rx="9" fill="#fff" opacity=".3" transform="rotate(-12 36 66)" />
      <rect x="79" y="30" width="25" height="72" rx="9" fill="#fff" opacity=".3" transform="rotate(12 92 66)" />
      <rect x="30" y="26" width="25" height="76" rx="9" fill={`url(#${card})`} />
      <rect x="73" y="26" width="25" height="76" rx="9" fill={`url(#${card})`} />
      <path d="M50 58 C57 72 71 72 78 58" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" />
      <circle className="hd-logo__glow" cx="64" cy="68" r="15" fill={`url(#${glow})`} />
      <circle cx="64" cy="68" r="6.5" fill="#FFB547" stroke="#fff" strokeWidth="3" />
    </svg>
  );
}
