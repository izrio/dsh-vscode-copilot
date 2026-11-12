/** Vite 的 `?inline` 导入：资源内联成 data URI（Webview 的 CSP 允许 data: 图片，构建也不会另外输出文件）。 */
declare module '*?inline' {
  const src: string;
  export default src;
}
