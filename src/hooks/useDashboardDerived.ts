import { useMemo } from 'react';
import type { MarketSection, SourceHealth } from '../../shared/types';

export interface HeaderStatusInput {
  tab: string;
  dropsCount: number;
  dropsGeneratedAt: number | null;
  dropsFailed: boolean;
  dropsIsLiveApi: boolean;
  cardsCount: number;
  airdropsFetchedAt: number | null | undefined;
  airdropsFailed: boolean;
  airdropsIsLiveApi: boolean;
  marketSections: MarketSection[] | null;
  marketsGeneratedAt: number | null | undefined;
  marketsFailed: boolean;
  marketsIsLiveApi: boolean;
}

export interface HeaderStatus {
  totalCount: number;
  headerFetchedAt: number | null;
  headerFailed: boolean;
  headerIsLiveApi: boolean;
}

export function deriveHeaderStatus(input: HeaderStatusInput): HeaderStatus {
  if (input.tab === 'drops') {
    return {
      totalCount: input.dropsCount,
      headerFetchedAt: input.dropsGeneratedAt,
      headerFailed: input.dropsFailed,
      headerIsLiveApi: input.dropsIsLiveApi && !input.dropsFailed,
    };
  }
  if (input.tab === 'airdrops') {
    return {
      totalCount: input.cardsCount,
      headerFetchedAt: input.airdropsFetchedAt ?? null,
      headerFailed: input.airdropsFailed,
      headerIsLiveApi: input.airdropsIsLiveApi && !input.airdropsFailed,
    };
  }
  const activeMarket = (input.marketSections ?? []).find(s => s.id === input.tab) ?? null;
  return {
    totalCount: activeMarket?.rows.length ?? 0,
    headerFetchedAt: activeMarket?.fetchedAt ?? input.marketsGeneratedAt ?? null,
    headerFailed: input.marketsFailed,
    headerIsLiveApi: input.marketsIsLiveApi && !input.marketsFailed,
  };
}

interface Input extends HeaderStatusInput {
  sources: SourceHealth[];
  visitedTabs: Set<string>;
}

/**
 * Values App derives from the polling hooks for header/panels: X availability,
 * lazily-mounted market sections, and the active tab's counts/fetch time/status.
 * Keeps App a pure composition shell.
 */
export function useDashboardDerived(input: Input): {
  xUnavailable: boolean;
  mountedMarkets: MarketSection[];
  totalCount: number;
  headerFetchedAt: number | null;
  headerFailed: boolean;
  headerIsLiveApi: boolean;
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
  const header = deriveHeaderStatus(input);

  return {
    xUnavailable,
    mountedMarkets,
    ...header,
  };
}
