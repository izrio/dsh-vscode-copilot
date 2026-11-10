/** dsh Remote 调用的错误类型。 */

/** dsh 返回的业务错误，例如 `session/writer-held`、`gateway/interactions-forbidden`。 */
export class RemoteError extends Error {
  constructor(
    readonly endpoint: string,
    readonly code: string,
    /** dsh 给出的原始说明（不带端点和错误码）。 */
    readonly detail: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${endpoint}: ${code}: ${detail}`);
    this.name = 'RemoteError';
  }
}

/** 传输层失败：HTTP 状态异常、WebSocket 断开、报文格式不对等。 */
export class TransportError extends Error {
  /** HTTP 状态码（请求已经得到响应时）。 */
  readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.status = options?.status;
  }
}

/** 表示"当前 Host 没有这个方法或服务"的网关错误码（dsh packages/api/gateway/src/remote-error-codes.ts）。 */
const UNAVAILABLE_CODES = new Set([
  'gateway/method-unavailable',
  'gateway/service-unavailable',
  'gateway/definition-unavailable',
]);

/**
 * 方法在当前 dsh 版本或组合中不存在。用于能力探测：调用方据此隐藏功能，而不是报错。
 * 没有任何插件认领的 endpoint，Host 直接返回 HTTP 404。
 */
export function isMethodUnavailable(error: unknown): boolean {
  if (error instanceof RemoteError) return UNAVAILABLE_CODES.has(error.code);
  return error instanceof TransportError && error.status === 404;
}
