import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketsResponse } from '../../shared/types';
import { getJson } from '../lib/api';

const POLL_MS = 60_000;

export interface MarketsState {
  markets: MarketsResponse | null;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}

export function useMarkets(): MarketsState {
  const [markets, setMarkets] = useState<MarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const etagRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const lastFetchedRef = useRef<number>(0);

  const load = useCallback((mode: 'initial' | 'manual' | 'background' = 'manual') => {
    if (mode === 'background' && inFlightRef.current) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    inFlightRef.current = true;
    if (mode !== 'background') setLoading(true);
    getJson<MarketsResponse>('/markets.json', etagRef.current, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return;
        inFlightRef.current = false;
        lastFetchedRef.current = Date.now();
        if (res.status === 200) {
          etagRef.current = res.etag;
          setMarkets(res.body);
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

  return { markets, loading, failed, refresh };
}
