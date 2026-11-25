import { useEffect, type RefObject } from 'react';

interface ContainsTarget {
  contains: (node: Node | null) => boolean;
}

/** Pure Escape-key check extracted for deterministic unit testing. */
export function isEscapeKey(key: string): boolean {
  return key === 'Escape';
}

/** Pure outside-click check extracted for deterministic unit testing. */
export function isOutsideContainer(
  container: { contains: (node: unknown) => boolean } | null,
  target: unknown,
): boolean {
  if (!container || target === null || target === undefined) return false;
  return !container.contains(target);
}

/**
 * Dismisses an open popover on Escape or outside pointer press, returning focus
 * to the trigger button when closed via keyboard.
 */
export function usePopoverDismiss(
  containerRef: RefObject<ContainsTarget | null>,
  open: boolean,
  onDismiss: () => void,
  triggerRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeKey(event.key)) return;
      event.preventDefault();
      onDismiss();
      triggerRef?.current?.focus();
    };

    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      const target = event.target as Node | null;
      if (
        isOutsideContainer(
          container ? { contains: node => container.contains(node as Node | null) } : null,
          target,
        )
      ) {
        onDismiss();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [containerRef, open, onDismiss, triggerRef]);
}
