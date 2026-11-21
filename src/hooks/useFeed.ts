import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, FeedResponse } from '../../shared/types';
import { API_BASE, getJson } from '../lib/api';
import { mergeVisibleUpdates, selectPending } from '../lib/feedMerge';
import { createPollLifecycle, type PollMode } from '../lib/polling';

const FEED_POLL_MS = 30_000;

export interface FeedState {
  items: FeedItem[];
  pendingCount: number;
  generatedAt: number | null;
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

export function useFeed(): FeedState {
  const [initial] = useState<FeedResponse | null>(() => getInitialFeed());
  const [items, setItems] = useState<FeedItem[]>(() => initial?.items ?? []);
  const [pendingItems, setPendingItems] = useState<FeedItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<number | null>(() => initial?.generatedAt ?? null);
  const [loading, setLoading] = useState(!initial);
  const [failed, setFailed] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const etagRef = useRef<string | null>(null);
  const knownIdsRef = useRef<Set<string> | null>(null);
  if (knownIdsRef.current === null) {
    knownIdsRef.current = new Set(initial?.items.map(it => it.id) ?? []);
  }
  const hasInitialRef = useRef(Boolean(initial));

  // Mirrors of state for stable callbacks (no re-creation per render).
  const pendingItemsRef = useRef<FeedItem[]>([]);
  const itemsRef = useRef<FeedItem[]>([]);
  useEffect(() => {
    pendingItemsRef.current = pendingItems;
    itemsRef.current = items;
  }, [pendingItems, items]);

  const fetchNow = useCallback((mode: PollMode) => {
    if (mode !== 'background' || !hasInitialRef.current) setLoading(mode !== 'background');
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;

    getJson<FeedResponse>('/feed.json', etagRef.current, signal)
      .then(res => {
        if (signal.aborted) return;
        poll.settle();
        if (res.status === 200) {
          etagRef.current = res.etag;
          setGeneratedAt(res.body.generatedAt);
          if (mode !== 'background') {
            knownIdsRef.current = new Set(res.body.items.map(it => it.id));
            setItems(res.body.items);
            setPendingItems([]); // latest always clears the queue
          } else {
            const known = knownIdsRef.current ?? new Set<string>();
            // New clusters → queue the full latest list while the user reads.
            // Otherwise refresh displayed entries in place so risk/summary/
            // AI-summary stay current, without reordering or auto-inserting —
            // and clear any stale queue: the newest fetch supersedes it.
            const queued = selectPending(res.body.items, known);
            setPendingItems(queued ?? []);
            setItems(prev => (prev.length === 0 ? prev : mergeVisibleUpdates(prev, res.body.items)));
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
  }, [poll]);

  const fetchNowRef = useRef(fetchNow);
  useEffect(() => {
    fetchNowRef.current = fetchNow;
  }, [fetchNow]);

  poll.useInterval(fetchNowRef, FEED_POLL_MS);

  // Initial-load semantics: with an SSR/prefetched snapshot the first fetch
  // would flip `loading` unnecessarily; skip it and start the clock.
  useEffect(() => {
    if (hasInitialRef.current) poll.settle();
  }, [poll]);

  const applyPending = useCallback(() => {
    const pending = pendingItemsRef.current;
    if (pending.length === 0) return;
    knownIdsRef.current = new Set(pending.map(it => it.id));
    setItems(pending);
    setPendingItems([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const newCount = pendingItems.reduce((acc, it) => (knownIdsRef.current?.has(it.id) ? acc : acc + 1), 0);
  const refresh = useCallback(() => fetchNow('manual'), [fetchNow]);

  // Freshness check for first-copy: the queued snapshot may be stale; risk is
  // validated against what the feed actually shows NOW.
  const getVisibleItems = useCallback(() => itemsRef.current, []);

  return {
    items,
    pendingCount: newCount,
    generatedAt,
    loading,
    failed,
    applyPending,
    refresh,
    getVisibleItems,
  };
}
