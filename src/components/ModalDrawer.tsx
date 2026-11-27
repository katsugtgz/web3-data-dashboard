import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';

interface Props {
  id: string;
  /** id of the element that names the dialog. */
  labelledBy: string;
  open: boolean;
  onClose: () => void;
  /** Receives `dismiss`, which closes through the native close() path so focus returns to the invoker. */
  children: (dismiss: () => void) => ReactNode;
}

/**
 * Native modal `<dialog>` shell shared by the app's drawers. showModal() traps
 * focus and makes the page behind it inert; Escape and backdrop clicks close it
 * (`closedby="any"` plus a fallback for engines without it); scroll containment
 * lives in the stylesheet.
 */
export function ModalDrawer({ id, labelledBy, open, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const dismiss = useCallback(() => ref.current?.close(), []);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  useBackdropDismiss(ref);

  return (
    <dialog
      id={id}
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      {children(dismiss)}
    </dialog>
  );
}
