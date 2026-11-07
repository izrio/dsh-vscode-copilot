/**
 * 底层的图标：内置底层用各自的官方图标（来源见 assets/backends/README.md），设置里加的 ACP 代理用名称首字母。
 */
import type { BackendView } from '@dsh-copilot/shared';
import codebuddy from '../assets/backends/codebuddy.png?inline';
import deepseek from '../assets/backends/deepseek.svg?inline';
import ohMyPi from '../assets/backends/oh-my-pi.png?inline';

/** tile：图标本身没有底色（DeepSeek 的鲸鱼），放在白色圆角方块里，与 DeepSeek 应用图标一致。 */
const LOGOS: Readonly<Record<string, { readonly src: string; readonly tile?: boolean }>> = {
  dsh: { src: deepseek, tile: true },
  'oh-my-pi': { src: ohMyPi },
  codebuddy: { src: codebuddy },
};

export function BackendLogo({ backend, size = 'md' }: { readonly backend: Pick<BackendView, 'id' | 'name'>; readonly size?: 'sm' | 'md' }) {
  const logo = LOGOS[backend.id];
  if (logo) {
    return (
      <span className={`backend-logo backend-logo--${size} ${logo.tile ? 'backend-logo--tile' : ''}`} aria-hidden="true" data-logo={backend.id}>
        <img src={logo.src} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`backend-logo backend-logo--${size} backend-logo--monogram`} aria-hidden="true">
      {monogram(backend.name)}
    </span>
  );
}

/** 名称的首字母：多个词取前两个词的首字母，CodeBuddy 这样的驼峰名取两个大写字母，否则取前两个字符。 */
export function monogram(name: string): string {
  const words = name.split(/[\s_-]+/u).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const word = words[0] ?? '?';
  const capitals = word.match(/\p{Lu}/gu) ?? [];
  return (capitals.length >= 2 ? capitals.slice(0, 2).join('') : [...word].slice(0, 2).join('')).toUpperCase();
}
