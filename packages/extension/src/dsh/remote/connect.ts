/**
 * API Peer 握手：用启动令牌换取 API Cookie。
 *
 * `GET /connect?token=…&interactions=answer` → 302，`Location: ./api/remote.mux`，
 * `Set-Cookie: dsh-auth-…`。之后的 `POST /api/…` 和 `/api/remote.mux` WebSocket 都带这个 Cookie。
 * 只有 `interactions=answer` 的 Peer 能接收审批、提问等转发事件。
 * 来源：dsh packages/client/connection/src/browser-auth.ts。
 */
import { TransportError } from './errors.ts';

export type Interactions = 'answer' | 'none';

export interface ApiCredential {
  readonly origin: string;
  /** `name=value` 形式，直接放进 `Cookie` 请求头。 */
  readonly cookie: string;
  /** mux WebSocket 地址（ws:// 或 wss://）。 */
  readonly muxUrl: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const AUTH_COOKIE_PREFIX = 'dsh-auth-';

/**
 * 从 `Set-Cookie` 响应头里取出 dsh 的认证 Cookie。
 * @returns `name=value`；没有时返回 undefined。
 */
export function pickAuthCookie(setCookies: readonly string[]): string | undefined {
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0]?.trim();
    if (pair?.startsWith(AUTH_COOKIE_PREFIX) && pair.includes('=')) return pair;
  }
  return undefined;
}

/**
 * 建立 API Peer。
 * @param origin - Host 的 origin，例如 `http://127.0.0.1:43210`。
 * @param token - 启动令牌。
 */
export async function connectApiPeer(
  origin: string,
  token: string,
  interactions: Interactions = 'answer',
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<ApiCredential> {
  const url = new URL('/connect', origin);
  url.searchParams.set('token', token);
  url.searchParams.set('interactions', interactions);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual' });
  } catch (cause) {
    throw new TransportError('无法连接 dsh Host', { cause });
  }
  // 响应体不需要，读掉以释放连接
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== 302) {
    throw new TransportError(`/connect 返回 HTTP ${response.status}`, { status: response.status });
  }
  const cookie = pickAuthCookie(response.headers.getSetCookie());
  if (!cookie) throw new TransportError('/connect 没有返回认证 Cookie');
  const location = response.headers.get('location') ?? './api/remote.mux';
  const mux = new URL(location, url);
  mux.protocol = mux.protocol === 'https:' ? 'wss:' : 'ws:';
  mux.search = '';
  return { origin: new URL(origin).origin, cookie, muxUrl: mux.toString() };
}
