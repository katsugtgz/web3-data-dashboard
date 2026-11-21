import { useCallback, useEffect, useRef, useState } from 'react';
import type { AirdropFeed } from '../../shared/types';
import { getJson } from '../lib/api';
import { createPollLifecycle, type PollMode } from '../lib/polling';

export const POLL_MS = 60_000;

export interface AirdropFeedState {
  feed: AirdropFeed | null;
  loading: boolean;
  failed: boolean;
  isLiveApi: boolean;
  refresh: () => void;
}

/** Polls /airdrops.json with ETag support. Pauses in background tabs and keeps the last loaded list on error. */
export function useAirdropFeed(): AirdropFeedState {
  const [feed, setFeed] = useState<AirdropFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [isLiveApi, setIsLiveApi] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const etagRef = useRef<string | null>(null);

  const fetchNow = useCallback((mode: PollMode) => {
    if (mode !== 'background') setLoading(true);
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;

    getJson<AirdropFeed>('/airdrops.json', etagRef.current, signal)
      .then(res => {
        if (signal.aborted) return;
        poll.settle();
        if (res.status === 200) {
          etagRef.current = res.etag;
          setFeed(res.body);
          setIsLiveApi(res.source === 'api');
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

  return { feed, loading, failed, isLiveApi, refresh };
}
