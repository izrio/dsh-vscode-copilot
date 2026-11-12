/**
 * ACP 连接（stdio JSON-RPC）：用 sh / node 小脚本当代理，检查写入失败和握手超时不会把扩展宿主带崩、请求不会永远挂着。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClosedError, AcpConnection, AcpTimeoutError } from '../src/acp/connection.ts';

const connections: AcpConnection[] = [];

function connect(script: string) {
  const exits: (number | null)[] = [];
  const logs: string[] = [];
  const conn = new AcpConnection({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: process.env,
    onRequest: async () => null,
    onNotification: () => undefined,
    onExit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  });
  connections.push(conn);
  return { conn, exits, logs };
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.dispose()));
});

describe('AcpConnection', () => {
  it('请求和回复按 id 对应', async () => {
    const { conn } = connect(`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.method } }));
        }
      });
    `);
    await conn.start();
    await expect(conn.request('initialize', {})).resolves.toEqual({ echo: 'initialize' });
  });

  it('代理不回复握手：到时间后拒绝，而不是一直停在启动中', async () => {
    const { conn } = connect('process.stdin.resume(); setInterval(() => {}, 1000);');
    await conn.start();
    await expect(conn.request('initialize', {}, 100)).rejects.toBeInstanceOf(AcpTimeoutError);
  });

  it.skipIf(process.platform === 'win32')('代理关掉了输入：写入失败不是未捕获异常，等待中的请求被拒绝', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      // 关闭自己的 stdin 但不退出：之后往它写就是 EPIPE
      const { conn, logs } = connect("require('fs').closeSync(0); setInterval(() => {}, 1000);");
      await conn.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // 大一点的内容，保证内核缓冲区装不下、真的去写管道
      const pending = conn.request('session/prompt', { text: 'x'.repeat(300_000) });
      await expect(pending).rejects.toBeInstanceOf(AcpClosedError);
      expect(logs.some((line) => line.includes('写入代理失败'))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
