import { useEffect, useState } from 'react';
import type { Card } from '../../shared/types';
import { fetchAirdrops, POLL_MS } from '../lib/airdrops';

/** Polls the live airdrop list. Keeps the last successful list when a poll fails. */
export function useAirdropFeed(): { cards: Card[] | null; failed: boolean } {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchAirdrops()
        .then(list => {
          if (cancelled) return;
          setCards(list);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { cards, failed };
}
