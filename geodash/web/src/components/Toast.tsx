import { createContext, useContext, useState, useCallback, useRef } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'default' | 'error' | 'success';
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastItem['type']) => void;
  showError: (message: string) => void;
}

const ToastCtx = createContext<ToastContextValue>({
  showToast: () => undefined,
  showError: () => undefined,
});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const showToast = useCallback((message: string, type: ToastItem['type'] = 'default') => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const showError = useCallback((message: string) => {
    showToast(message, 'error');
  }, [showToast]);

  return (
    <ToastCtx.Provider value={{ showToast, showError }}>
      {children}
      <div className="toast-container">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${t.type === 'error' ? ' toast-error' : t.type === 'success' ? ' toast-success' : ''}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
