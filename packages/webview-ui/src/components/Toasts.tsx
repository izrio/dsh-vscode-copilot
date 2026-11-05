import { dismissToast, useView } from '../store.ts';
import { useT } from '../i18n.ts';
import { ErrorIcon, InfoIcon } from './icons.tsx';

export function Toasts() {
  const toasts = useView((s) => s.toasts);
  const t = useT();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast toast--${toast.level}`} onClick={() => dismissToast(toast.id)} title={t('toast.dismiss')}>
          {toast.level === 'error' ? <ErrorIcon /> : <InfoIcon />}
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  );
}
