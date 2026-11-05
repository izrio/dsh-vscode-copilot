/**
 * 端到端脚本用到的那一小部分 Playwright API 的类型，以及加载本机安装的 playwright。
 *
 * playwright 不是项目依赖：项目锁定的版本和本机预装的浏览器版本不一致时会找不到浏览器，
 * 所以运行时用本机安装的版本，类型在这里自己声明，脚本不依赖 playwright 的类型包也能通过类型检查。
 */
import { createRequire } from 'node:module';

export interface Locator {
  first(): Locator;
  nth(index: number): Locator;
  waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  click(options?: { button?: 'left' | 'right' }): Promise<void>;
  hover(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  innerText(): Promise<string>;
  allInnerTexts(): Promise<string[]>;
  inputValue(): Promise<string>;
  evaluateAll<R>(fn: (elements: HTMLElement[]) => R): Promise<R>;
  evaluate<R>(fn: (element: HTMLElement) => R): Promise<R>;
  isDisabled(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  getAttribute(name: string): Promise<string | null>;
  locator(selector: string, options?: LocatorOptions): Locator;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  filter(options: LocatorOptions): Locator;
}

export interface LocatorOptions {
  hasText?: string;
  hasNotText?: string;
}

export interface Frame {
  locator(selector: string, options?: LocatorOptions): Locator;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  getByTestId(id: string): Locator;
  waitForFunction(fn: () => boolean | undefined, arg?: undefined, options?: { timeout?: number }): Promise<unknown>;
  evaluate<R>(fn: () => R): Promise<R>;
}

export interface Page extends Frame {
  on(event: 'pageerror', listener: (error: Error) => void): void;
  on(event: 'console', listener: (message: { type(): string; text(): string }) => void): void;
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  screenshot(options: { path: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  frames(): Frame[];
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
}

export interface BrowserContext {
  newPage(): Promise<Page>;
}

export interface Browser {
  newContext(options?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }): Promise<BrowserContext>;
  newPage(options?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }): Promise<Page>;
  close(): Promise<void>;
}

export interface Playwright {
  chromium: { launch(options?: { headless?: boolean }): Promise<Browser> };
}

/** 加载本机安装的 playwright；找不到时给出安装提示并退出。 */
export function loadPlaywright(): Playwright {
  try {
    return createRequire(import.meta.url)('playwright') as Playwright;
  } catch {
    console.error('找不到 playwright：请先安装（npm install -g playwright && npx playwright install chromium），必要时设置 NODE_PATH');
    process.exit(2);
  }
}
