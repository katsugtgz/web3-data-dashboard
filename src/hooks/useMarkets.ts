import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketsResponse } from '../../shared/types';
import { getJson } from '../lib/api';
import { createPollLifecycle, type PollMode } from '../lib/polling';

const POLL_MS = 120_000;

export interface MarketsState {
  markets: MarketsResponse | null;
  loading: boolean;
  failed: boolean;
  isLiveApi: boolean;
  refresh: () => void;
}

export function useMarkets(): MarketsState {
  const [markets, setMarkets] = useState<MarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hasLiveApi, setHasLiveApi] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const etagRef = useRef<string | null>(null);
  const hasLiveRef = useRef(false);

  const fetchNow = useCallback((mode: PollMode) => {
    if (mode !== 'background') setLoading(true);
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;

    getJson<MarketsResponse>('/markets.json', etagRef.current, signal)
      .then(res => {
        if (signal.aborted) return;
        poll.settle();
        if (res.status === 200) {
          if (res.source === 'snapshot' && hasLiveRef.current) {
            // Transient outage: keep the live prices the user sees and flag the
            // refresh failure instead of silently swapping in a stale snapshot.
            setFailed(true);
            if (mode !== 'background') setLoading(false);
            return;
          }
          const isApi = res.source === 'api';
          hasLiveRef.current = isApi;
          setHasLiveApi(isApi);
          etagRef.current = res.etag;
          setMarkets(res.body);
        }
        setFailed(false);
        if (mode !== 'background') setLoading(false);
      })
      .catch(() => {
        if (signal.aborted) return;
        poll.settle();
        setFailed(true);
        if (mode !== 'background') setLoading(false);
      });
  }, [poll]);

  const fetchNowRef = useRef(fetchNow);
  useEffect(() => {
    fetchNowRef.current = fetchNow;
  }, [fetchNow]);

  poll.useInterval(fetchNowRef, POLL_MS);

  const refresh = useCallback(() => fetchNow('manual'), [fetchNow]);

  return { markets, loading, failed, isLiveApi: hasLiveApi && !failed, refresh };
}
