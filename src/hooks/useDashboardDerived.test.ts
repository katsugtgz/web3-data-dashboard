import { describe, expect, test } from 'bun:test';
import type { MarketSection } from '../../shared/types';
import { deriveDashboardHeaderState, STALE_AGE_MS } from './useDashboardDerived';

const NOW = 1_750_000_000_000;

function makeSection(overrides: Partial<MarketSection> = {}): MarketSection {
  return {
    id: 'crypto',
    title: 'Crypto Top 50',
    blurb: 'Market cap leaders',
    cols: ['Name', 'Price'],
    rows: [
      { cells: ['Bitcoin', '$90,000'] },
      { cells: ['Ethereum', '$3,200'] },
    ],
    source: 'CoinGecko',
    sourceUrl: 'https://www.coingecko.com',
    fetchedAt: NOW - 60_000,
    stale: false,
    ...overrides,
  };
}

describe('deriveDashboardHeaderState', () => {
  test('drops tab returns drops count, timestamp, and non-market flag', () => {
    const res = deriveDashboardHeaderState({
      tab: 'drops',
      marketSections: [makeSection()],
      marketsGeneratedAt: NOW - 10_000,
      dropsCount: 42,
      dropsGeneratedAt: NOW - 30_000,
      airdropsFetchedAt: NOW - 120_000,
      cardsCount: 373,
      now: NOW,
    });
    expect(res).toEqual({
      totalCount: 42,
      headerFetchedAt: NOW - 30_000,
      headerStale: false,
      isMarketTab: false,
    });
  });

  test('airdrops tab returns card count and marks stale when older than 24h', () => {
    const res = deriveDashboardHeaderState({
      tab: 'airdrops',
      marketSections: [makeSection()],
      marketsGeneratedAt: NOW - 10_000,
      dropsCount: 42,
      dropsGeneratedAt: NOW - 30_000,
      airdropsFetchedAt: NOW - STALE_AGE_MS - 1_000,
      cardsCount: 373,
      now: NOW,
    });
    expect(res).toEqual({
      totalCount: 373,
      headerFetchedAt: NOW - STALE_AGE_MS - 1_000,
      headerStale: true,
      isMarketTab: false,
    });
  });

  test('market tab uses active section row count and section fetchedAt instead of airdrops count', () => {
    const crypto = makeSection({ id: 'crypto', fetchedAt: NOW - 5_000 });
    const defi = makeSection({
      id: 'defi',
      rows: [{ cells: ['Lido', '$20B'] }],
      fetchedAt: NOW - 120_000,
    });
    const res = deriveDashboardHeaderState({
      tab: 'defi',
      marketSections: [crypto, defi],
      marketsGeneratedAt: NOW - 2_000,
      dropsCount: 42,
      dropsGeneratedAt: NOW - 30_000,
      airdropsFetchedAt: NOW - 60_000,
      cardsCount: 373,
      now: NOW,
    });
    expect(res).toEqual({
      totalCount: 1,
      headerFetchedAt: NOW - 120_000,
      headerStale: false,
      isMarketTab: true,
    });
  });

  test('market tab marks stale when section.stale is true OR age exceeds 24h', () => {
    const flaggedStale = deriveDashboardHeaderState({
      tab: 'crypto',
      marketSections: [makeSection({ stale: true, fetchedAt: NOW - 1_000 })],
      marketsGeneratedAt: NOW - 1_000,
      dropsCount: 10,
      dropsGeneratedAt: NOW,
      airdropsFetchedAt: NOW,
      cardsCount: 373,
      now: NOW,
    });
    expect(flaggedStale.headerStale).toBe(true);

    const agedStale = deriveDashboardHeaderState({
      tab: 'crypto',
      marketSections: [makeSection({ stale: false, fetchedAt: NOW - 3 * STALE_AGE_MS })],
      marketsGeneratedAt: NOW - 3 * STALE_AGE_MS,
      dropsCount: 10,
      dropsGeneratedAt: NOW,
      airdropsFetchedAt: NOW,
      cardsCount: 373,
      now: NOW,
    });
    expect(agedStale.headerStale).toBe(true);
    expect(agedStale.totalCount).toBe(2);
  });

  test('market tab falls back to 0 rows and marketsGeneratedAt when section not yet loaded', () => {
    const res = deriveDashboardHeaderState({
      tab: 'yields',
      marketSections: null,
      marketsGeneratedAt: NOW - 5_000,
      dropsCount: 10,
      dropsGeneratedAt: NOW,
      airdropsFetchedAt: NOW,
      cardsCount: 373,
      now: NOW,
    });
    expect(res).toEqual({
      totalCount: 0,
      headerFetchedAt: NOW - 5_000,
      headerStale: false,
      isMarketTab: true,
    });
  });
});
