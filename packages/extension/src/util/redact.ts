/**
 * 凭据脱敏。dsh 的启动令牌和 API Cookie 都是进程凭据，
 * 任何要写进日志、错误信息或界面的文本都必须先经过这里。
 */

const TOKEN_IN_URL = /([?&]token=)[^&\s#'"<>]+/giu;
const AUTH_COOKIE = /(dsh-auth-[A-Za-z0-9_.-]*=)[^;\s]+/giu;
/** DeepSeek / OpenAI 风格的 API Key（`sk-` 开头），以及 HTTP 的 Bearer 令牌。 */
const API_KEY = /\bsk-[A-Za-z0-9_-]{16,}/gu;
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

/**
 * 把文本中的启动令牌和认证 Cookie 值替换为 `<redacted>`。
 * @param text - 任意文本，例如 dsh 的 stdout/stderr。
 * @returns 脱敏后的文本。
 */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_IN_URL, '$1<redacted>').replace(AUTH_COOKIE, '$1<redacted>').replace(API_KEY, 'sk-<redacted>').replace(BEARER, '$1<redacted>');
}
