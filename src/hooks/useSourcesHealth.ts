import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceHealth } from '../../shared/types';
import { getJson } from '../lib/api';
import { createPollLifecycle, type PollMode } from '../lib/polling';

const SOURCES_POLL_MS = 120_000;

export function useSourcesHealth() {
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLiveApi, setIsLiveApi] = useState(false);
  const [failed, setFailed] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const etagRef = useRef<string | null>(null);

  const fetchNow = useCallback((mode: PollMode) => {
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;
    getJson<SourceHealth[]>('/sources.json', etagRef.current, signal)
      .then(res => {
        if (signal.aborted) return;
        poll.settle();
        if (res.status === 200) {
          etagRef.current = res.etag;
          setSources(res.body);
          setIsLiveApi(res.source === 'api');
        }
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (!signal.aborted) {
          poll.settle();
          setFailed(true);
          setLoading(false);
        }
      });
  }, [poll]);

  const fetchNowRef = useRef(fetchNow);
  useEffect(() => {
    fetchNowRef.current = fetchNow;
  }, [fetchNow]);

  poll.useInterval(fetchNowRef, SOURCES_POLL_MS);

  const refresh = useCallback(() => fetchNow('manual'), [fetchNow]);
  return { sources, loading, isLiveApi, failed, refresh };
}
