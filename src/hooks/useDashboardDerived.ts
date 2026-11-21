import { useMemo } from 'react';
import type { MarketSection, SourceHealth } from '../../shared/types';

interface Input {
  sources: SourceHealth[];
  marketSections: MarketSection[] | null;
  visitedTabs: Set<string>;
  tab: string;
  dropsCount: number;
  dropsGeneratedAt: number | null;
  airdropsFetchedAt: number | null | undefined;
  cardsCount: number;
}

/**
 * Values App derives from the polling hooks for header/panels: X availability,
 * lazily-mounted market sections, and the active tab's counts/fetch time.
 * Keeps App a pure composition shell.
 */
export function useDashboardDerived(input: Input): {
  xUnavailable: boolean;
  mountedMarkets: MarketSection[];
  totalCount: number;
  headerFetchedAt: number | null;
} {
  const { sources, marketSections, visitedTabs, tab, dropsCount, dropsGeneratedAt, airdropsFetchedAt, cardsCount } = input;

  const xUnavailable = useMemo(
    () => sources.length > 0 && sources.every(s => s.status === 'down'),
    [sources],
  );
  const mountedMarkets = useMemo(
    () => (marketSections ?? []).filter(s => visitedTabs.has(s.id)),
    [marketSections, visitedTabs],
  );
  const onDrops = tab === 'drops';

  return {
    xUnavailable,
    mountedMarkets,
    totalCount: onDrops ? dropsCount : cardsCount,
    headerFetchedAt: onDrops ? (dropsGeneratedAt ?? airdropsFetchedAt ?? null) : (airdropsFetchedAt ?? null),
  };
}
