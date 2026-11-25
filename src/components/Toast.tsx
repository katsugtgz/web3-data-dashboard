import { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CheckCircle2Icon, XIcon } from './Icons';

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
          {toast.tone === 'ok' ? (
            <CheckCircle2Icon size={16} className="toast-icon" />
          ) : (
            <AlertTriangleIcon size={16} className="toast-icon" />
          )}
          <span className="toast-msg" aria-hidden="true">
            {toast.message}
          </span>
          <button type="button" className="toast-x" onClick={onDismiss} aria-label="Dismiss notification">
            <XIcon size={15} />
          </button>
        </div>
      )}
    </>
  );
}
