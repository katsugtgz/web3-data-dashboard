import { useCallback, useRef, useState } from 'react';
import type { Card } from '../../shared/types';

export interface DetailRef {
  id: string | null;
  name: string;
}

export function resolveDetailCard(cards: readonly Card[], detailRef: DetailRef | null): Card | null {
  if (!detailRef) return null;
  return cards.find(c => (detailRef.id ? c.id === detailRef.id : c.n === detailRef.name)) ?? null;
}

export function reconcileDetailSelection(
  cards: readonly Card[],
  detailRef: DetailRef | null,
): { detail: Card | null; shouldClear: boolean } {
  if (!detailRef) return { detail: null, shouldClear: false };
  const detail = resolveDetailCard(cards, detailRef);
  return { detail, shouldClear: detail === null };
}

export function useDetailSelection(cards: readonly Card[], clearCopyStatus: () => void) {
  const [detailRef, setDetailRef] = useState<DetailRef | null>(null);
  const detailRefRef = useRef<DetailRef | null>(null);
  const detail = resolveDetailCard(cards, detailRef);

  const handleSelectDetail = useCallback(
    (card: Card) => {
      clearCopyStatus();
      const next: DetailRef = { id: card.id ?? null, name: card.n };
      detailRefRef.current = next;
      setDetailRef(next);
    },
    [clearCopyStatus],
  );

  const handleCloseDetail = useCallback(() => {
    clearCopyStatus();
    detailRefRef.current = null;
    setDetailRef(null);
  }, [clearCopyStatus]);

  const reconcileCards = useCallback(
    (nextCards: readonly Card[]) => {
      const { shouldClear } = reconcileDetailSelection(nextCards, detailRefRef.current);
      if (!shouldClear) return;
      detailRefRef.current = null;
      clearCopyStatus();
      setDetailRef(null);
    },
    [clearCopyStatus],
  );

  return { detail, handleSelectDetail, handleCloseDetail, reconcileCards };
}
