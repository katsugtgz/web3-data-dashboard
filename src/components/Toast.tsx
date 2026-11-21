import { useEffect, useRef } from 'react';

export interface ToastState {
  message: string;
  tone: 'ok' | 'warn';
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  const announcer = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // Replace the text node even when consecutive messages have the same text.
    announcer.current?.replaceChildren(...(toast ? [toast.message] : []));
  }, [toast]);

  return (
    <>
      <span ref={announcer} className="sr" role="status" aria-atomic="true" />
      {toast && (
        <div className={`toast-banner toast-${toast.tone}`}>
          <span aria-hidden="true">{toast.message}</span>
          <button type="button" className="toast-x" onClick={onDismiss} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
    </>
  );
}
