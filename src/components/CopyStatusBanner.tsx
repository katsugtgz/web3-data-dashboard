import { useEffect, useRef } from 'react';

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
  const firstRef = useRef<HTMLParagraphElement>(null);
  const secondRef = useRef<HTMLParagraphElement>(null);
  const toggleRef = useRef(false);

  useEffect(() => {
    if (!status) return;
    const next = toggleRef.current ? firstRef.current : secondRef.current;
    const prev = toggleRef.current ? secondRef.current : firstRef.current;
    toggleRef.current = !toggleRef.current;
    if (prev) prev.textContent = '';
    if (next) next.textContent = status.message;
  }, [status]);

  if (!status) return null;
  return (
    <p className={`copy-status copy-status-${status.tone}`}>
      <span>{status.message}</span>
      {/* Swap pair drives polite re-announcement; visually the banner itself is the message. */}
      <span className="sr-only-announcer" aria-hidden="true">
        <span ref={firstRef} />
        <span ref={secondRef} />
      </span>
    </p>
  );
}
