/**
 * 强调色：按钮、输入框边框、焦点、链接、进度条共用。
 *
 * 不少主题把 button.background、focusBorder 设成灰色或透明，直接用它们时发送按钮、输入框边框就没了颜色。
 * 这里按顺序取第一个"有颜色"的主题色（不透明、有一定饱和度、不太暗也不太亮），设成 CSS 变量 `--accent`，
 * 并按亮度配一个文字色 `--accent-foreground`。主题切换时 VS Code 会改 <html> 的 style 和 <body> 的 class，届时重新计算。
 */

/** 依次尝试的主题色：主按钮 → 焦点边框 → 链接 → 进度条 → 图表蓝。 */
export const ACCENT_CANDIDATES = [
  '--vscode-button-background',
  '--vscode-focusBorder',
  '--vscode-textLink-foreground',
  '--vscode-progressBar-background',
  '--vscode-charts-blue',
] as const;

const FALLBACK = { accent: '#3794ff', foreground: '#ffffff' };

export type Rgba = readonly [number, number, number, number];

/** 解析 getComputedStyle 给出的 `rgb(r, g, b)` / `rgba(r, g, b, a)`（也接受空格分隔的新写法）。 */
export function parseRgb(value: string): Rgba | undefined {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u.exec(value.trim());
  if (!match) return undefined;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

/** 能当强调色：基本不透明、有颜色（HSL 饱和度够）、亮度适中。 */
export function isVivid([r, g, b, a]: Rgba): boolean {
  if (a < 0.6) return false;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const lightness = (max + min) / 2;
  if (lightness < 0.18 || lightness > 0.88) return false;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return saturation >= 0.3;
}

/** 强调色上的文字：亮的强调色配深色字，否则白字。 */
export function foregroundFor([r, g, b]: Rgba): string {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.45 ? '#1e1e1e' : '#ffffff';
}

/**
 * 选出强调色。
 * @param resolve - 把 CSS 变量名解析成计算后的颜色字符串；变量不存在时返回 undefined 或透明色。
 */
export function pickAccent(resolve: (name: string) => string | undefined): { accent: string; foreground: string } {
  for (const name of ACCENT_CANDIDATES) {
    const value = resolve(name);
    const rgba = value ? parseRgb(value) : undefined;
    if (rgba && isVivid(rgba)) return { accent: `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`, foreground: foregroundFor(rgba) };
  }
  return FALLBACK;
}

/** 计算并设置强调色，之后跟随主题变化。返回停止监听的函数。 */
export function watchAccent(): () => void {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const resolve = (name: string) => {
    probe.style.color = `var(${name}, transparent)`;
    return getComputedStyle(probe).color;
  };
  const apply = () => {
    const { accent, foreground } = pickAccent(resolve);
    const style = document.documentElement.style;
    // 只在变化时写入：写 style 本身也会触发下面的监听
    if (style.getPropertyValue('--accent') !== accent) style.setProperty('--accent', accent);
    if (style.getPropertyValue('--accent-foreground') !== foreground) style.setProperty('--accent-foreground', foreground);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
    probe.remove();
  };
}
