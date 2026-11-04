/** 内联 SVG 图标，颜色跟随 currentColor。 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
});

export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
export const MoreIcon = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);
export const ChevronDownIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6.5 4.5 10 8l-3.5 3.5" />
  </svg>
);
export const ArrowUpIcon = (p: IconProps) => (
  <svg {...base(p)} strokeWidth={1.8}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </svg>
);
export const StopIcon = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);
export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
  </svg>
);
export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);
export const ErrorIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.5M8 10.8v.2" />
  </svg>
);
export const InfoIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.5V11M8 5.2v.2" />
  </svg>
);
export const ToolIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.8 3.2a3 3 0 0 0-3.7 3.7L2.8 10.2a1.2 1.2 0 0 0 1.7 1.7l3.3-3.3a3 3 0 0 0 3.7-3.7L9.6 6.8 8.4 5.6Z" />
  </svg>
);
export const SpinnerIcon = (p: IconProps) => (
  <svg {...base(p)} className={`spin ${p.className ?? ''}`}>
    <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />
  </svg>
);
export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3 3" />
  </svg>
);
export const TerminalIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3.5 5 3 3-3 3M8.5 11.5h4" />
  </svg>
);
export const FileEditIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M9 2.5 12.5 6M9 2.5V6h3.5" />
  </svg>
);
export const EyeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </svg>
);
export const ShieldIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2 3 4v3.6c0 3 2.1 5.5 5 6.4 2.9-.9 5-3.4 5-6.4V4Z" />
  </svg>
);
export const QuestionIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.2M8 11.1v.2" />
  </svg>
);
