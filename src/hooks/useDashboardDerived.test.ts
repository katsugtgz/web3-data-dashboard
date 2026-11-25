import { describe, expect, test } from 'bun:test';
import type { MarketSection } from '../../shared/types';
import { deriveHeaderStatus } from './useDashboardDerived';

const cryptoSection: MarketSection = {
  id: 'crypto',
  title: 'Crypto',
  blurb: 'Top coins',
  cols: ['Asset', 'Price'],
  rows: [
    { cells: ['BTC', '$100k'] },
    { cells: ['ETH', '$4k'] },
    { cells: ['SOL', '$200'] },
  ],
  source: 'CoinGecko',
  sourceUrl: 'https://www.coingecko.com',
  fetchedAt: 1_795_000_000_000,
  stale: false,
};

describe('deriveHeaderStatus', () => {
  test('returns active Market section row count, timestamp, failed, and live status on Market tabs', () => {
    const base = {
      tab: 'crypto',
      dropsCount: 40,
      dropsGeneratedAt: 1_795_100_000_000,
      dropsFailed: false,
      dropsIsLiveApi: true,
      cardsCount: 120,
      airdropsFetchedAt: 1_795_200_000_000,
      airdropsFailed: false,
      airdropsIsLiveApi: false,
      marketSections: [cryptoSection],
      marketsGeneratedAt: 1_795_050_000_000,
      marketsFailed: true,
      marketsIsLiveApi: true,
    };

    expect(deriveHeaderStatus(base)).toEqual({
      totalCount: 3,
      headerFetchedAt: 1_795_000_000_000,
      headerFailed: true,
      headerIsLiveApi: false,
    });

    expect(deriveHeaderStatus({ ...base, marketsFailed: false })).toEqual({
      totalCount: 3,
      headerFetchedAt: 1_795_000_000_000,
      headerFailed: false,
      headerIsLiveApi: true,
    });

    expect(deriveHeaderStatus({ ...base, tab: 'drops' })).toEqual({
      totalCount: 40,
      headerFetchedAt: 1_795_100_000_000,
      headerFailed: false,
      headerIsLiveApi: true,
    });

    expect(deriveHeaderStatus({ ...base, tab: 'airdrops' })).toEqual({
      totalCount: 120,
      headerFetchedAt: 1_795_200_000_000,
      headerFailed: false,
      headerIsLiveApi: false,
    });
  });
});
