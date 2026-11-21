import { useEffect, type RefObject } from 'react';

/**
 * Light-dismiss on the dialog backdrop for engines without the `closedby`
 * attribute: closes only when both press and release start and end on the
 * backdrop (not on dialog content dragged out).
 *
 * Complements CSS scroll containment (`overscroll-behavior` on `dialog:modal`
 * and `dialog::backdrop` in styles.css) which keeps wheel/touch gestures from
 * scrolling the page underneath the modal.
 */
export function useBackdropDismiss(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg || 'closedBy' in HTMLDialogElement.prototype) return;
    let mouseDownOnBackdrop = false;
    const isOnBackdrop = (event: MouseEvent): boolean => {
      if (event.target !== dlg) return false;
      const rect = dlg.getBoundingClientRect();
      return !(
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
    };
    const onMouseDown = (event: MouseEvent) => {
      mouseDownOnBackdrop = isOnBackdrop(event);
    };
    const onClick = (event: MouseEvent) => {
      const shouldClose = mouseDownOnBackdrop && isOnBackdrop(event);
      mouseDownOnBackdrop = false;
      if (shouldClose) dlg.close();
    };
    dlg.addEventListener('mousedown', onMouseDown);
    dlg.addEventListener('click', onClick);
    return () => {
      dlg.removeEventListener('mousedown', onMouseDown);
      dlg.removeEventListener('click', onClick);
    };
  }, [ref]);
}
