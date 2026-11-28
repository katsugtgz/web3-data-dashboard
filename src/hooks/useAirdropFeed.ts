import { useCallback, useEffect, useRef, useState } from 'react';
import { filterGamblingAirdropFeed } from '../../shared/gamblingFilter';
import type { AirdropFeed, Card } from '../../shared/types';
import { getJson } from '../lib/api';
import { createPollLifecycle, type PollMode } from '../lib/polling';

export const POLL_MS = 120_000;

export interface AirdropFeedState {
  feed: AirdropFeed | null;
  loading: boolean;
  failed: boolean;
  isLiveApi: boolean;
  refresh: () => void;
  /** Live lookup of currently visible cards for freshness-sensitive brief revalidation. */
  getVisibleCards: () => Card[];
}

/** Polls /airdrops.json with ETag support. Pauses in background tabs and keeps the last loaded list on error. */
export function useAirdropFeed(onCardsChange?: (cards: readonly Card[]) => void): AirdropFeedState {
  const [feed, setFeed] = useState<AirdropFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [isLiveApi, setIsLiveApi] = useState(false);

  const [poll] = useState(createPollLifecycle);
  const etagRef = useRef<string | null>(null);
  const hasLiveRef = useRef(false);
  const cardsRef = useRef<Card[]>([]);
  const onCardsChangeRef = useRef(onCardsChange);

  useEffect(() => {
    onCardsChangeRef.current = onCardsChange;
  }, [onCardsChange]);

  const fetchNow = useCallback((mode: PollMode) => {
    if (mode !== 'background') setLoading(true);
    const { signal, skipped } = poll.beginRequest(mode);
    if (skipped) return;

    getJson<AirdropFeed>('/airdrops.json', etagRef.current, signal)
      .then(res => {
        if (signal.aborted) return;
        if (res.status === 200) {
          if (res.source === 'snapshot' && hasLiveRef.current) {
            poll.settle(false);
            setFailed(true);
            if (mode !== 'background') setLoading(false);
            return;
          }
          hasLiveRef.current = res.source === 'api';
          etagRef.current = res.etag;
          const sanitized = filterGamblingAirdropFeed(res.body);
          cardsRef.current = sanitized.cards;
          setFeed(sanitized);
          setIsLiveApi(res.source === 'api');
          onCardsChangeRef.current?.(sanitized.cards);
        }
        poll.settle(true);
        setFailed(false);
        if (mode !== 'background') setLoading(false);
      })
      .catch(() => {
        if (signal.aborted) return;
        poll.settle(false);
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
  const getVisibleCards = useCallback(() => cardsRef.current, []);

  // A failed refresh must not keep the stale feed labelled "Live API";
  // consumers already render their failed branches off `failed`.
  return { feed, loading, failed, isLiveApi: isLiveApi && !failed, refresh, getVisibleCards };
}
