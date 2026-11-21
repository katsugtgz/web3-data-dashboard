import { useCallback, useEffect, useRef, useState } from 'react';
import type { AirdropFeed } from '../../shared/types';
import { fetchAirdrops, POLL_MS } from '../lib/airdrops';

export interface AirdropFeedState {
  feed: AirdropFeed | null;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}

/** Polls the live airdrop feed. Pauses in background tabs and keeps the last loaded list on error. */
export function useAirdropFeed(): AirdropFeedState {
  const [feed, setFeed] = useState<AirdropFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const lastFetchedRef = useRef<number>(0);

  const load = useCallback((mode: 'initial' | 'manual' | 'background' = 'manual') => {
    if (mode === 'background' && inFlightRef.current) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    inFlightRef.current = true;
    if (mode !== 'background') setLoading(true);
    fetchAirdrops(ctrl.signal)
      .then(next => {
        if (ctrl.signal.aborted) return;
        inFlightRef.current = false;
        lastFetchedRef.current = next.fetchedAt;
        setFeed(next);
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
    }, POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchedRef.current >= POLL_MS) {
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

  const refresh = useCallback(() => load('manual'), [load]);

  return { feed, loading, failed, refresh };
}
