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
  const lastFetchedRef = useRef<number>(0);

  const load = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    fetchAirdrops(ctrl.signal)
      .then(next => {
        if (ctrl.signal.aborted) return;
        lastFetchedRef.current = next.fetchedAt;
        setFeed(next);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setFailed(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchedRef.current >= POLL_MS) {
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ctrlRef.current?.abort();
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  return { feed, loading, failed, refresh: load };
}
