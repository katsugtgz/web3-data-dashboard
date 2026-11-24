import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, FeedResponse } from '../../shared/types';
import { API_BASE } from '../lib/api';
import { createFeedSession, reconcileFeedUpdate } from '../lib/feedFetch';
import { createPollLifecycle, type PollMode } from '../lib/polling';

const FEED_POLL_MS = 60_000;

export interface FeedState {
  items: FeedItem[];
  pendingCount: number;
  generatedAt: number | null;
  isLiveApi: boolean;
  loading: boolean;
  failed: boolean;
  applyPending: () => void;
  refresh: () => void;
  /** Live lookup of the currently visible feed state, for freshness-sensitive consumers. */
  getVisibleItems: () => FeedItem[];
}

function getInitialFeed(): FeedResponse | null {
  if (API_BASE || typeof window === 'undefined') return null;
  const cached = window.__RADAR_PREFETCH_RESOLVED__?.feed as FeedResponse | undefined;
  return cached ?? null;
}

function countUnseenPending(items: FeedItem[], pendingItems: FeedItem[]): number {
  if (pendingItems.length === 0) return 0;
  const visibleIds = new Set(items.map(it => it.id));
  return pendingItems.reduce((acc, it) => (visibleIds.has(it.id) ? acc : acc + 1), 0);
}

export function useFeed(): FeedState {
  const [initial] = useState<FeedResponse | null>(() => getInitialFeed());
  const [items, setItems] = useState<FeedItem[]>(() => initial?.items ?? []);
  const [pendingItems, setPendingItems] = useState<FeedItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<number | null>(() => initial?.generatedAt ?? null);
  const [isLiveApi, setIsLiveApi] = useState(false);
  const [loading, setLoading] = useState(!initial);
  const [failed, setFailed] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const [session] = useState(() => createFeedSession());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const hasLiveRef = useRef(false);

  // Mirrors of state for stable callbacks (no re-creation per render).
  const pendingItemsRef = useRef<FeedItem[]>([]);
  const itemsRef = useRef<FeedItem[]>([]);
  useEffect(() => {
    pendingItemsRef.current = pendingItems;
    itemsRef.current = items;
    knownIdsRef.current = new Set(items.map(it => it.id));
  }, [pendingItems, items]);

  const fetchNow = useCallback((mode: PollMode) => {
    if (mode !== 'background') setLoading(true);
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;

    session
      .fetch(signal, { resetResume: mode === 'manual' })
      .then(res => {
        if (signal.aborted) return;
        poll.settle();
        if (res.status === 200) {
          if (res.source === 'snapshot' && hasLiveRef.current) {
            setFailed(true);
            setLoading(false);
            return;
          }
          hasLiveRef.current = res.source === 'api';
          setIsLiveApi(hasLiveRef.current);
          const known = knownIdsRef.current ?? new Set<string>();
          const update = reconcileFeedUpdate(itemsRef.current, known, res.body, mode);
          if (!update.preserved) {
            if (update.generatedAt !== null) {
              setGeneratedAt(update.generatedAt);
            }
            knownIdsRef.current = update.knownIds;
            setItems(update.items);
            setPendingItems(update.pending ?? []);
          }
        }
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (signal.aborted) return;
        poll.settle();
        setFailed(true);
        setLoading(false);
      });
  }, [poll, session]);

  const fetchNowRef = useRef(fetchNow);
  useEffect(() => {
    fetchNowRef.current = fetchNow;
  }, [fetchNow]);

  poll.useInterval(fetchNowRef, FEED_POLL_MS);

  const applyPending = useCallback(() => {
    const pending = pendingItemsRef.current;
    if (pending.length === 0) return;
    knownIdsRef.current = new Set(pending.map(it => it.id));
    setItems(pending);
    setPendingItems([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const newCount = countUnseenPending(items, pendingItems);
  const refresh = useCallback(() => fetchNow('manual'), [fetchNow]);

  // Freshness check for first-copy: the queued snapshot may be stale; risk is
  // validated against what the feed actually shows NOW.
  const getVisibleItems = useCallback(() => itemsRef.current, []);

  return {
    items,
    pendingCount: newCount,
    generatedAt,
    isLiveApi,
    loading,
    failed,
    applyPending,
    refresh,
    getVisibleItems,
  };
}
