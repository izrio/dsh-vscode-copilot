import { dismissToast, useView } from '../store.ts';

export function Toasts() {
  const toasts = useView((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast toast--${toast.level}`} onClick={() => dismissToast(toast.id)} title="点击关闭">
          {toast.text}
        </button>
      ))}
    </div>
  );
}
