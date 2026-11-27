import { useCallback, useRef, useState } from 'react';
import type { Card, FeedItem } from '../../shared/types';

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

/** The selected drop, looked up in the live feed. Null when nothing is selected or the drop left the feed. */
export function resolveDropsDetail(items: readonly FeedItem[], id: string | null): FeedItem | null {
  if (id === null) return null;
  return items.find(item => item.id === id) ?? null;
}

export function reconcileDropsDetailSelection(
  items: readonly FeedItem[],
  selectedId: string | null,
): { detail: FeedItem | null; shouldClear: boolean } {
  if (selectedId === null) return { detail: null, shouldClear: false };
  const detail = resolveDropsDetail(items, selectedId);
  return { detail, shouldClear: detail === null };
}

export function useDropsDetailSelection(items: readonly FeedItem[], clearCopyStatus: () => void) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const detail = resolveDropsDetail(items, selectedId);

  const handleSelectDetail = useCallback(
    (item: FeedItem) => {
      clearCopyStatus();
      selectedIdRef.current = item.id;
      setSelectedId(item.id);
    },
    [clearCopyStatus],
  );

  const handleCloseDetail = useCallback(() => {
    clearCopyStatus();
    selectedIdRef.current = null;
    setSelectedId(null);
  }, [clearCopyStatus]);

  const reconcileItems = useCallback(
    (nextItems: readonly FeedItem[]) => {
      const { shouldClear } = reconcileDropsDetailSelection(nextItems, selectedIdRef.current);
      if (!shouldClear) return;
      selectedIdRef.current = null;
      clearCopyStatus();
      setSelectedId(null);
    },
    [clearCopyStatus],
  );

  return { detail, handleSelectDetail, handleCloseDetail, reconcileItems };
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
