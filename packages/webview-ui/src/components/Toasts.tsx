import { dismissToast, useView } from '../store.ts';
import { useT } from '../i18n.ts';
import { CloseIcon, ErrorIcon, InfoIcon } from './icons.tsx';

/** 提示：普通提示几秒后自动消失；错误一直留着，点右边的 × 关掉。 */
export function Toasts() {
  const toasts = useView((s) => s.toasts);
  const t = useT();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.level}`} role={toast.level === 'error' ? 'alert' : 'status'}>
          {toast.level === 'error' ? <ErrorIcon /> : <InfoIcon />}
          <span className="toast__text">{toast.text}</span>
          <button type="button" className="icon-button icon-button--small toast__close" onClick={() => dismissToast(toast.id)} aria-label={t('toast.close')} title={t('toast.close')}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
