export interface ToastState {
  message: string;
  tone: 'ok' | 'warn';
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  return (
    <>
      <span className="sr" role="status" aria-atomic="true">{toast?.message ?? ''}</span>
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
