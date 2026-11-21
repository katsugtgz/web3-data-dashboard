import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceHealth } from '../../shared/types';
import { getJson } from '../lib/api';

const SOURCES_POLL_MS = 120_000;

export function useSourcesHealth() {
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const etagRef = useRef<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    getJson<SourceHealth[]>('/sources.json', etagRef.current, signal)
      .then(res => {
        if (signal?.aborted) return;
        if (res.status === 200) {
          etagRef.current = res.etag;
          setSources(res.body);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load(ctrl.signal);
    }, SOURCES_POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [load]);

  return { sources, loading, refresh: () => load() };
}
