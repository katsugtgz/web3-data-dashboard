export interface ToastState {
  message: string;
  tone: 'ok' | 'warn';
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div className={`toast-banner toast-${toast.tone}`} role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button type="button" className="toast-x" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}
