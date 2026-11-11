/**
 * 活动行的一行摘要（`Item.label`、浏览行的 `entries[].label`）：工具名在前，后面是参数或结果摘要。
 * Host 用 `joinLabel` 拼，Webview 用 `splitLabel` 拆成「名称 + 详情」两段显示；分隔符只在这里出现。
 * 不依赖 zod，Webview 直接从 `@harness-deck/shared/labels` 引入（原因见 limits.ts）。
 */

const SEPARATOR = '  ';

/** 把名称和各段详情拼成一行；空的段跳过。 */
export function joinLabel(name: string, ...details: readonly (string | undefined)[]): string {
  return [name, ...details.filter((part): part is string => Boolean(part))].join(SEPARATOR);
}

/** 拆成名称和详情；没有详情时 `detail` 为空字符串。 */
export function splitLabel(label: string): { readonly name: string; readonly detail: string } {
  const at = label.indexOf(SEPARATOR);
  return at < 0 ? { name: label, detail: '' } : { name: label.slice(0, at), detail: label.slice(at + SEPARATOR.length) };
}
