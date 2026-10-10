import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';

let toastId = 0;
const toastListeners = new Set();

export function toast(msg, type = 'info') {
  const id = ++toastId;
  toastListeners.forEach((fn) => fn({ id, msg, type }));
  setTimeout(() => toastListeners.forEach((fn) => fn({ id, type: 'remove' })), 3500);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const listener = (t) => {
      if (t.type === 'remove') {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      } else {
        setToasts((prev) => [...prev, t]);
      }
    };
    toastListeners.add(listener);
    return () => toastListeners.delete(listener);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-5 right-5 z-[100] flex flex-col gap-2.5 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto glass-panel px-4 py-3 rounded-2xl shadow-glass flex items-center gap-3 text-sm animate-slide-left border ${
            t.type === 'error'
              ? 'border-rose-500/40 text-rose-200'
              : 'border-accent/40 text-surface-100'
          }`}
        >
          {t.type === 'error' ? (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          ) : t.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-accent shrink-0" />
          ) : (
            <Info className="w-5 h-5 text-accent shrink-0" />
          )}
          <span className="font-medium text-xs sm:text-sm">{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
