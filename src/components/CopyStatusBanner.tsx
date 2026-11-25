import { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CheckCircle2Icon } from './Icons';
import type { ToastState } from './Toast';

export interface CopyStatus {
  message: string;
  tone: ToastState['tone'];
}

/**
 * Visible, screen-reader-announced copy outcome inside a modal dialog.
 *
 * A page-level toast is inert while a dialog is open via showModal() (the rest
 * of the document sits behind the top layer), so copy actions taken inside the
 * dialog report into THIS region: a small status banner that is both visible
 * and exposed as a polite live region. The two-node swap re-announces repeated
 * identical messages (several screen readers skip same-text live updates).
 */
export function CopyStatusBanner({ status }: { status: CopyStatus | null }) {
  const firstRef = useRef<HTMLSpanElement>(null);
  const secondRef = useRef<HTMLSpanElement>(null);
  const toggleRef = useRef(false);

  useEffect(() => {
    if (!status) {
      if (firstRef.current) firstRef.current.textContent = '';
      if (secondRef.current) secondRef.current.textContent = '';
      return;
    }
    const next = toggleRef.current ? firstRef.current : secondRef.current;
    const prev = toggleRef.current ? secondRef.current : firstRef.current;
    toggleRef.current = !toggleRef.current;
    if (prev) prev.textContent = '';
    if (next) next.textContent = status.message;
  }, [status]);

  return (
    <>
      <span className="sr-only-announcer" role="status" aria-atomic="true">
        <span ref={firstRef} />
        <span ref={secondRef} />
      </span>
      {status && (
        <p className={`copy-status copy-status-${status.tone}`} aria-hidden="true">
          {status.tone === 'ok' ? (
            <CheckCircle2Icon size={15} className="copy-status-icon" />
          ) : (
            <AlertTriangleIcon size={15} className="copy-status-icon" />
          )}
          <span>{status.message}</span>
        </p>
      )}
    </>
  );
}
