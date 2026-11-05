/**
 * 浏览器里打开 dsh 的地址，和 `dsh web` 打印的一样：`<origin>/?token=<启动令牌>`。
 *
 * - dsh 只监听它所在机器的 127.0.0.1：远程开发（Remote-SSH、WSL、容器、code-server）时由 `externalize` 让 VS Code 转发端口；
 * - 查询部分自己拼成字符串，不经过 vscode.Uri：Uri.toString() 会把 `=` 编码成 `%3D`，dsh 就认不出 token；
 * - dsh 用令牌发 Cookie 后重定向到 `/`，打开后地址栏里看不到令牌是正常的。
 * @param externalize - 把本机 origin（带结尾 `/`）换成浏览器能访问的 origin；失败时用本机地址。
 */
export async function webUIUrl(
  origin: string,
  token: string,
  externalize: (base: string) => Promise<string>,
  log: (line: string) => void = () => undefined,
): Promise<string> {
  let base = origin.replace(/\/+$/u, '');
  try {
    base = (await externalize(`${base}/`)).replace(/\/+$/u, '');
  } catch (error) {
    log(`转发 dsh 端口失败，直接打开本机地址：${error instanceof Error ? error.message : String(error)}`);
  }
  return `${base}/?token=${encodeURIComponent(token)}`;
}
