import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, FeedResponse } from '../../shared/types';
import { getJson } from '../lib/api';

const FEED_POLL_MS = 30_000;

export interface FeedState {
  items: FeedItem[];
  pendingCount: number;
  generatedAt: number | null;
  loading: boolean;
  failed: boolean;
  applyPending: () => void;
  refresh: () => void;
}

export function useFeed(): FeedState {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [pendingItems, setPendingItems] = useState<FeedItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const ctrlRef = useRef<AbortController | null>(null);
  const etagRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const lastFetchedRef = useRef(0);
  const knownIdsRef = useRef<Set<string>>(new Set());

  const load = useCallback((mode: 'initial' | 'manual' | 'background' = 'manual') => {
    if (mode === 'background' && inFlightRef.current) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    inFlightRef.current = true;
    if (mode !== 'background') setLoading(true);

    getJson<FeedResponse>('/feed.json', etagRef.current, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return;
        inFlightRef.current = false;
        lastFetchedRef.current = Date.now();
        if (res.status === 200) {
          etagRef.current = res.etag;
          setGeneratedAt(res.body.generatedAt);
          if (mode !== 'background' || knownIdsRef.current.size === 0) {
            knownIdsRef.current = new Set(res.body.items.map(it => it.id));
            setItems(res.body.items);
            setPendingItems([]);
          } else {
            const incomingNew = res.body.items.filter(it => !knownIdsRef.current.has(it.id));
            if (incomingNew.length > 0) {
              setPendingItems(res.body.items);
            }
          }
        }
        setFailed(false);
        if (mode !== 'background') setLoading(false);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        inFlightRef.current = false;
        setFailed(true);
        if (mode !== 'background') setLoading(false);
      });
  }, []);

  useEffect(() => {
    load('initial');
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load('background');
    }, FEED_POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchedRef.current >= FEED_POLL_MS) {
        load('background');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ctrlRef.current?.abort();
      inFlightRef.current = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const applyPending = useCallback(() => {
    if (pendingItems.length === 0) return;
    knownIdsRef.current = new Set(pendingItems.map(it => it.id));
    setItems(pendingItems);
    setPendingItems([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [pendingItems]);

  const newCount = pendingItems.reduce((acc, it) => (knownIdsRef.current.has(it.id) ? acc : acc + 1), 0);
  const refresh = useCallback(() => load('manual'), [load]);

  return {
    items,
    pendingCount: newCount,
    generatedAt,
    loading,
    failed,
    applyPending,
    refresh,
  };
}
