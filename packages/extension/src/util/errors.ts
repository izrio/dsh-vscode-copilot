/** 错误对象 → 文字。日志用 describeError；给用户看的提示用 userMessage（按界面语言）。 */
import { RemoteError, TransportError } from '../dsh/remote/errors.ts';
import { t } from '../i18n.ts';

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 给用户看的错误说明。传输层的错误信息是给日志看的技术细节，界面上统一成一句可操作的提示；
 * dsh 返回的业务错误保留 dsh 给出的说明（不带端点和错误码前缀）。
 */
export function userMessage(error: unknown): string {
  if (error instanceof TransportError) return t('error.transport');
  if (error instanceof RemoteError) return error.detail;
  return describeError(error);
}
