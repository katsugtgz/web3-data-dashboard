import { useMemo } from 'react';
import type { MarketSection, SourceHealth } from '../../shared/types';

export const STALE_AGE_MS = 86_400_000;

export interface DashboardHeaderDerivedInput {
  tab: string;
  marketSections: MarketSection[] | null;
  marketsGeneratedAt?: number | null;
  dropsCount: number;
  dropsGeneratedAt: number | null;
  airdropsFetchedAt: number | null | undefined;
  cardsCount: number;
  now?: number;
}

export interface DashboardHeaderDerived {
  totalCount: number;
  headerFetchedAt: number | null;
  headerStale: boolean;
  isMarketTab: boolean;
}

/**
 * Pure header status derivation for Drops, Airdrops, and Market tabs.
 * Extracted for deterministic unit testing without DOM mounting.
 */
export function deriveDashboardHeaderState(input: DashboardHeaderDerivedInput): DashboardHeaderDerived {
  const {
    tab,
    marketSections,
    marketsGeneratedAt = null,
    dropsCount,
    dropsGeneratedAt,
    airdropsFetchedAt,
    cardsCount,
    now = Date.now(),
  } = input;

  if (tab === 'drops') {
    const stale = dropsGeneratedAt !== null && now - dropsGeneratedAt > STALE_AGE_MS;
    return {
      totalCount: dropsCount,
      headerFetchedAt: dropsGeneratedAt,
      headerStale: stale,
      isMarketTab: false,
    };
  }

  if (tab === 'airdrops') {
    const fetchedAt = airdropsFetchedAt ?? null;
    const stale = fetchedAt !== null && now - fetchedAt > STALE_AGE_MS;
    return {
      totalCount: cardsCount,
      headerFetchedAt: fetchedAt,
      headerStale: stale,
      isMarketTab: false,
    };
  }

  const activeMarket = marketSections?.find(s => s.id === tab);
  const fetchedAt = activeMarket?.fetchedAt ?? marketsGeneratedAt ?? null;
  const stale =
    Boolean(activeMarket?.stale) || (fetchedAt !== null && now - fetchedAt > STALE_AGE_MS);

  return {
    totalCount: activeMarket?.rows.length ?? 0,
    headerFetchedAt: fetchedAt,
    headerStale: stale,
    isMarketTab: true,
  };
}

interface Input extends Omit<DashboardHeaderDerivedInput, 'now'> {
  sources: SourceHealth[];
  visitedTabs: Set<string>;
}

/**
 * Values App derives from the polling hooks for header/panels: X availability,
 * lazily-mounted market sections, and the active tab's counts/fetch time/staleness.
 * Keeps App a pure composition shell.
 */
export function useDashboardDerived(input: Input): {
  xUnavailable: boolean;
  mountedMarkets: MarketSection[];
  totalCount: number;
  headerFetchedAt: number | null;
  headerStale: boolean;
  isMarketTab: boolean;
} {
  const { sources, marketSections, visitedTabs } = input;

  const xUnavailable = useMemo(() => {
    const xSources = sources.filter(s => s.platform === 'x');
    return xSources.length > 0 && xSources.every(s => s.status === 'down');
  }, [sources]);

  const mountedMarkets = useMemo(
    () => (marketSections ?? []).filter(s => visitedTabs.has(s.id)),
    [marketSections, visitedTabs],
  );

  const header = deriveDashboardHeaderState(input);

  return {
    xUnavailable,
    mountedMarkets,
    ...header,
  };
}
