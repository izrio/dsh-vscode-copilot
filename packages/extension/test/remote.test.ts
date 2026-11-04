/**
 * 协议客户端测试：用一个按 dsh 线上格式实现的假 Host 验证 connect / unary / mux / $events。
 * 线上格式来源见各模块文件头注释；真实 dsh 上的验证见 scripts/m0-smoke.ts。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { DshClient } from '../src/dsh/DshClient.ts';
import { connectApiPeer, pickAuthCookie } from '../src/dsh/remote/connect.ts';
import { isMethodUnavailable, RemoteError, TransportError } from '../src/dsh/remote/errors.ts';
import { RemoteEvents } from '../src/dsh/remote/events.ts';
import { MuxClient } from '../src/dsh/remote/mux.ts';
import { UnaryClient } from '../src/dsh/remote/unary.ts';

const TOKEN = 'launch-token';
const COOKIE = 'dsh-auth-127.0.0.1-1=signed-value';

interface FakeHost {
  readonly origin: string;
  readonly unaryCalls: { endpoint: string; payload: unknown }[];
  readonly cancelled: string[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function startFakeHost(): Promise<FakeHost> {
  const unaryCalls: { endpoint: string; payload: unknown }[] = [];
  const cancelled: string[] = [];
  const sockets = new Set<WebSocket>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/connect') {
        if (url.searchParams.get('token') !== TOKEN) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(302, {
          location: './api/remote.mux',
          'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=60`,
        });
        response.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.cookie !== COOKIE) {
        response.writeHead(401).end();
        return;
      }
      const endpoint = url.pathname.slice('/api/'.length);
      if (endpoint === 'missing/method') {
        response.writeHead(404).end('not found');
        return;
      }
      const envelope = JSON.parse(await readBody(request)) as { rpcId: string; method: string; payload: unknown };
      unaryCalls.push({ endpoint, payload: envelope.payload });
      const reply = (result: unknown, rpcId = envelope.rpcId) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'server-response', rpcId, result }));
      };
      if (endpoint === 'session/list') reply({ ok: true, value: { items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: true }] } });
      else if (endpoint === 'session/writer') reply({ ok: false, error: { code: 'session/writer-held', message: 'held', details: { sessionId: 's1' } } });
      else if (endpoint === 'rpc/mismatch') reply({ ok: true, value: 1 }, 'other-id');
      else reply({ ok: true });
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux' || request.headers.cookie !== COOKIE) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as { type: string; streamId: string; endpoint?: string };
        const send = (value: Record<string, unknown>) => ws.send(JSON.stringify({ streamId: frame.streamId, ...value }));
        if (frame.type === 'cancel') {
          cancelled.push(frame.streamId);
          return;
        }
        if (frame.type !== 'open') return;
        switch (frame.endpoint) {
          case '$events':
            send({ type: 'item', value: { type: 'ready', clientId: 'client-1', host: { home: '/home/u' } } });
            send({ type: 'item', value: { type: 'emit', event: 'api-session/status', args: ['s1'] } });
            send({
              type: 'item',
              value: { type: 'waterfall', event: 'approval/request', eventId: 'ev-1', agentId: 's1', request: { toolName: 'bash' } },
            });
            send({ type: 'item', value: { type: 'waterfall', event: 'unknown/request', eventId: 'ev-2', agentId: 's1', request: {} } });
            return;
          case 'numbers/count':
            for (const n of [1, 2, 3]) send({ type: 'item', value: n });
            send({ type: 'end' });
            return;
          case 'stream/fail':
            send({ type: 'error', error: { code: 'gateway/input-invalid', message: 'bad input', details: {} } });
            return;
          case 'stream/endless':
            send({ type: 'item', value: 'first' });
            return;
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    unaryCalls,
    cancelled,
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

let host: FakeHost;
beforeAll(async () => {
  host = await startFakeHost();
});
afterAll(async () => {
  await host.close();
});

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('connectApiPeer', () => {
  it('用令牌换到 Cookie，并得到 mux 地址', async () => {
    const credential = await connectApiPeer(host.origin, TOKEN);
    expect(credential.cookie).toBe(COOKIE);
    expect(credential.muxUrl).toBe(`${host.origin.replace('http:', 'ws:')}/api/remote.mux`);
  });

  it('令牌错误时抛出 TransportError', async () => {
    await expect(connectApiPeer(host.origin, 'wrong')).rejects.toBeInstanceOf(TransportError);
  });

  it('pickAuthCookie 只取 dsh-auth- 开头的 Cookie', () => {
    expect(pickAuthCookie(['other=1; Path=/', 'dsh-auth-x=y; HttpOnly'])).toBe('dsh-auth-x=y');
    expect(pickAuthCookie(['other=1'])).toBeUndefined();
  });
});

describe('UnaryClient', () => {
  const client = () => new UnaryClient({ origin: host.origin, cookie: COOKIE });

  it('按 { args } 包装参数，返回结果值', async () => {
    await expect(client().call('session/list', { _request: {} })).resolves.toMatchObject({ items: [{ sessionId: 's1' }] });
    expect(host.unaryCalls.at(-1)).toEqual({ endpoint: 'session/list', payload: { args: { _request: {} } } });
  });

  it('业务错误映射为 RemoteError，保留 code 和 details', async () => {
    const error = await client().call('session/writer').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ code: 'session/writer-held', details: { sessionId: 's1' } });
  });

  it('rpcId 不匹配时拒绝结果', async () => {
    await expect(client().call('rpc/mismatch')).rejects.toBeInstanceOf(TransportError);
  });

  it('方法不存在（HTTP 404）时 isMethodUnavailable 为 true', async () => {
    const error = await client().call('missing/method').catch((e: unknown) => e);
    expect(isMethodUnavailable(error)).toBe(true);
    expect(isMethodUnavailable(new RemoteError('x/y', 'gateway/method-unavailable', ''))).toBe(true);
    expect(isMethodUnavailable(new RemoteError('x/y', 'session/writer-held', ''))).toBe(false);
  });
});

describe('MuxClient', () => {
  const connect = async () => {
    const credential = await connectApiPeer(host.origin, TOKEN);
    const mux = new MuxClient(credential);
    await mux.connect();
    return mux;
  };

  it('流式读取 item 直到 end', async () => {
    const mux = await connect();
    const items: unknown[] = [];
    for await (const item of mux.open('numbers/count')) items.push(item);
    expect(items).toEqual([1, 2, 3]);
    mux.close();
  });

  it('服务端 error 帧映射为 RemoteError', async () => {
    const mux = await connect();
    const consume = async () => {
      for await (const _ of mux.open('stream/fail')) void _;
    };
    await expect(consume()).rejects.toMatchObject({ code: 'gateway/input-invalid' });
    mux.close();
  });

  it('提前停止消费时向 Host 发送 cancel', async () => {
    const mux = await connect();
    const before = host.cancelled.length;
    for await (const item of mux.open('stream/endless')) {
      expect(item).toBe('first');
      break;
    }
    await waitUntil(() => host.cancelled.length > before);
    mux.close();
  });

  it('没有 Cookie 时握手失败', async () => {
    const mux = new MuxClient({ origin: host.origin, cookie: 'nope=1', muxUrl: `${host.origin.replace('http:', 'ws:')}/api/remote.mux` });
    await expect(mux.connect()).rejects.toBeInstanceOf(TransportError);
  });
});

describe('RemoteEvents', () => {
  it('ready 之后分发 emit，回答 waterfall；没有处理方的 waterfall 回 next', async () => {
    const credential = await connectApiPeer(host.origin, TOKEN);
    const mux = new MuxClient(credential);
    await mux.connect();
    const unary = new UnaryClient({ origin: credential.origin, cookie: credential.cookie });
    const events = new RemoteEvents(mux, unary);
    const emitted: unknown[] = [];
    events.onEmit('api-session/status', (args) => emitted.push(args));
    events.onWaterfall('approval/request', async (request) => {
      expect(request.request).toEqual({ toolName: 'bash' });
      return { kind: 'result', value: 'allowed-once' };
    });

    await expect(events.start()).resolves.toEqual({ clientId: 'client-1', home: '/home/u' });
    await waitUntil(() => host.unaryCalls.filter((call) => call.endpoint === '$events/result').length >= 2);

    expect(emitted).toEqual([['s1']]);
    const answers = host.unaryCalls.filter((call) => call.endpoint === '$events/result').map((call) => call.payload);
    expect(answers).toEqual(
      expect.arrayContaining([
        { args: { clientId: 'client-1', eventId: 'ev-1', outcome: { kind: 'result', value: 'allowed-once' } } },
        { args: { clientId: 'client-1', eventId: 'ev-2', outcome: { kind: 'next' } } },
      ]),
    );
    mux.close();
  });
});

describe('DshClient', () => {
  it('connect 后可以调用 session/list', async () => {
    const client = await DshClient.connect({ origin: host.origin, token: TOKEN });
    expect(client.ready.clientId).toBe('client-1');
    await expect(client.listSessions()).resolves.toEqual([{ sessionId: 's1', updatedAt: 1, running: false, blank: true }]);
    client.close();
  });
});
