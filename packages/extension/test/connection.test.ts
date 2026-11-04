import { describe, expect, it } from 'vitest';
import type { DshClient } from '../src/dsh/DshClient.ts';
import { DshConnection, type Endpoint } from '../src/dsh/DshConnection.ts';

/** 只实现 DshConnection 用到的部分：close 和 mux.onClose。 */
function fakeClient(label: string) {
  const closeListeners = new Set<(error: Error) => void>();
  let closed = false;
  const client = {
    label,
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    mux: {
      onClose(listener: (error: Error) => void) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    },
    /** 模拟 WebSocket 意外断开。 */
    dropConnection() {
      for (const listener of closeListeners) listener(new Error('socket closed'));
    },
  };
  return client;
}

type Fake = ReturnType<typeof fakeClient>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('DshConnection', () => {
  it('Host 就绪后连接，通知 client', async () => {
    const connect = async (endpoint: Endpoint) => fakeClient(endpoint.token) as unknown as DshClient;
    const connection = new DshConnection({ connect });
    const seen: (string | undefined)[] = [];
    connection.onClient((client) => seen.push((client as unknown as Fake | undefined)?.label));
    connection.setEndpoint({ origin: 'http://h', token: 't1' });
    await tick();
    expect(seen).toEqual(['t1']);
    expect(connection.status).toEqual({ kind: 'connected' });
  });

  it('mux 意外断开时自动重连（重新 /connect）', async () => {
    const clients: Fake[] = [];
    const connect = async () => {
      const client = fakeClient(`c${clients.length}`);
      clients.push(client);
      return client as unknown as DshClient;
    };
    const connection = new DshConnection({ connect, backoffMs: () => 1 });
    const seen: (string | undefined)[] = [];
    connection.onClient((client) => seen.push((client as unknown as Fake | undefined)?.label));
    connection.setEndpoint({ origin: 'http://h', token: 't' });
    await tick();
    clients[0]!.dropConnection();
    await tick();
    expect(seen).toEqual(['c0', undefined, 'c1']);
  });

  it('连接失败时按退避重试', async () => {
    let attempts = 0;
    const connect = async () => {
      attempts++;
      if (attempts < 3) throw new Error('refused');
      return fakeClient('ok') as unknown as DshClient;
    };
    const connection = new DshConnection({ connect, backoffMs: () => 1 });
    connection.setEndpoint({ origin: 'http://h', token: 't' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(3);
    expect((connection.client as unknown as Fake).label).toBe('ok');
  });

  it('端点变化时丢弃迟到的旧连接', async () => {
    const pending: ((client: DshClient) => void)[] = [];
    const made: Fake[] = [];
    const connect = (endpoint: Endpoint) =>
      new Promise<DshClient>((resolve) => {
        const client = fakeClient(endpoint.token);
        made.push(client);
        pending.push(() => resolve(client as unknown as DshClient));
      });
    const connection = new DshConnection({ connect });
    connection.setEndpoint({ origin: 'http://h', token: 'old' });
    connection.setEndpoint({ origin: 'http://h', token: 'new' });
    pending[1]!(undefined as never);
    pending[0]!(undefined as never);
    await tick();
    expect((connection.client as unknown as Fake).label).toBe('new');
    expect(made[0]!.closed).toBe(true);
  });

  it('Host 停止时断开并回到 idle', async () => {
    const client = fakeClient('c');
    const connection = new DshConnection({ connect: async () => client as unknown as DshClient });
    connection.setEndpoint({ origin: 'http://h', token: 't' });
    await tick();
    connection.setEndpoint(undefined);
    expect(client.closed).toBe(true);
    expect(connection.client).toBeUndefined();
    expect(connection.status).toEqual({ kind: 'idle' });
  });
});
