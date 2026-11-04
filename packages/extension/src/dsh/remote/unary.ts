/**
 * Remote 一元调用：`POST /api/<namespace>/<method>`。
 *
 * 请求信封：`{ type: 'client-request', rpcId, method, payload: { args } }`，
 * `args` 的键是 Host 方法的参数名（例如 `session/list` 是 `_request`，`session/create` 是 `request`）。
 * 响应信封：`{ type: 'server-response', rpcId, result: { ok, value } | { ok: false, error } }`。
 * 来源：dsh packages/client/connection/src/{rpc-schema.ts,client/rpc.ts}。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FetchLike } from './connect.ts';
import { RemoteError, TransportError } from './errors.ts';

const responseEnvelope = z.object({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown().optional() }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ]),
});

export interface UnaryClientOptions {
  readonly origin: string;
  readonly cookie: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class UnaryClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: UnaryClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * 调用一个 Remote 方法。
   * @param endpoint - 例如 `session/list`。
   * @param args - 以参数名为键的对象。
   * @returns 结果值，未经业务校验，由调用方用自己的 schema 解析。
   * @throws RemoteError dsh 返回业务错误时；TransportError 传输失败时。
   */
  async call(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`/api/${endpoint}`, this.options.origin).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.options.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: combined,
      });
    } catch (cause) {
      throw new TransportError(`${endpoint} 请求失败`, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransportError(`${endpoint}: HTTP ${response.status}`);
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType === 'multipart/form-data') {
      // 只有带二进制附件的结果才是 multipart（例如 workspaceFiles/readBytes），M0 用不到
      await response.body?.cancel().catch(() => undefined);
      throw new TransportError(`${endpoint}: 暂不支持 multipart 响应`);
    }
    const parsed = responseEnvelope.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new TransportError(`${endpoint}: 响应信封格式不对`);
    if (parsed.data.rpcId !== rpcId) throw new TransportError(`${endpoint}: rpcId 不匹配`);
    const result = parsed.data.result;
    if (!result.ok) {
      throw new RemoteError(endpoint, result.error.code, result.error.message, result.error.details);
    }
    return result.value;
  }
}
