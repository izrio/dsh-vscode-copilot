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
export const FileIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M9 2.5 12.5 6M9 2.5V6h3.5" />
  </svg>
);
export const FolderIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
  </svg>
);
export const SelectionIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 4h10M3 8h7M3 12h9" />
  </svg>
);
export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </svg>
);
export const SlashIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m10.5 2.5-5 11" />
  </svg>
);
export const PlanIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 4h8M5 8h8M5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </svg>
);
export const PencilIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10.5 3.2 12.8 5.5 6 12.3H3.7V10ZM9.3 4.4l2.3 2.3" />
  </svg>
);
export const TrashIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c0 .5.4.8.9.8h4c.5 0 .9-.3.9-.8l.6-8.2" />
  </svg>
);
export const RefreshIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12.8 7.2A4.9 4.9 0 0 0 4 4.6M3.2 8.8A4.9 4.9 0 0 0 12 11.4M4 2.3v2.6h2.6M12 13.7v-2.6H9.4" />
  </svg>
);
export const KeyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5M12 4l1 1" />
  </svg>
);
export const GlobeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5Z" />
  </svg>
);
export const LogIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
    <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
  </svg>
);
export const SendIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2.8 8 13.2 3 10.5 13l-2.4-4.1Z M8.1 8.9 13.2 3" />
  </svg>
);
export const SaveIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 3.5a1 1 0 0 1 1-1h6.5L13 5v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    <path d="M5.5 2.5v3h4v-3M5 13.5V9.5h6v4" />
  </svg>
);
export const ChatIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 4a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 13 4v5a1.5 1.5 0 0 1-1.5 1.5H7L4 13v-2.5h.5A1.5 1.5 0 0 1 3 9Z" />
  </svg>
);
export const SparkleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8 6.8 6.8Z" />
  </svg>
);
export const FastForwardIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m3 4 4.5 4L3 12ZM8.5 4 13 8l-4.5 4Z" />
  </svg>
);
export const LockIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
export const UnlockIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />
  </svg>
);
export const TargetIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.5" />
  </svg>
);
export const ChecklistIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m2.5 4.5 1 1 2-2M2.5 10.5l1 1 2-2M7.5 4.5h6M7.5 10.5h6" />
  </svg>
);
export const DiffIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.5 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7Z" />
    <path d="M8 5.5v3M6.5 7h3M6.5 10.5h3" />
  </svg>
);
export const BookIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 3.5c2-.8 3.7-.6 5 .6 1.3-1.2 3-1.4 5-.6v9c-2-.8-3.7-.6-5 .6-1.3-1.2-3-1.4-5-.6ZM8 4.1v9" />
  </svg>
);
export const BugIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="5" y="5" width="6" height="8" rx="3" />
    <path d="M6 5V4a2 2 0 0 1 4 0v1M5 8H2.5M11 8h2.5M5 11l-2 1.5M11 11l2 1.5M5 6 3 4.5M11 6l2-1.5" />
  </svg>
);
export const BeakerIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 2.5h4M6.5 2.5v4L3.2 12.3a.8.8 0 0 0 .7 1.2h8.2a.8.8 0 0 0 .7-1.2L9.5 6.5v-4M4.8 9.5h6.4" />
  </svg>
);
export const ReplyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6.5 4 3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4v1" />
  </svg>
);
export const TextSizeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 13l3.5-9 3.5 9M3.3 10h4.4M10 13l2-5 2 5M10.7 11.5h2.6" />
  </svg>
);
export const ArrowLeftIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 8H3M7 4L3 8l4 4" />
  </svg>
);
export const ArrowRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
