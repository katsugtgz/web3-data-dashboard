import { describe, expect, test } from 'bun:test';
import type { FeedItem } from '../../shared/types';
import { summarizeDrops } from './dropsSummary';

function makeItem(over: Partial<FeedItem> = {}): FeedItem {
  const now = 1_795_364_909_000;
  return {
    id: 'item-1',
    project: 'Sample Protocol',
    chains: ['Base'],
    taskTypes: ['testnet'],
    summary: 'Interact with testnet contracts to qualify.',
    links: [],
    sources: [],
    sourceCount: 1,
    score: 0.75,
    risk: { level: 'ok', reasons: [] },
    firstSeen: now,
    lastSeen: now,
    ...over,
  };
}

describe('summarizeDrops', () => {
  test('returns all zero counts for an empty feed', () => {
    expect(summarizeDrops([])).toEqual({
      totalClusters: 0,
      multiSourceCount: 0,
      verifiedLinkCount: 0,
      riskFlaggedCount: 0,
    });
  });

  test('counts multi-source, verified links, and risk-flagged items accurately', () => {
    const items: FeedItem[] = [
      makeItem({
        id: 'single-unverified-ok',
        sourceCount: 1,
        links: [{ url: 'https://example.xyz', known: false }],
        risk: { level: 'ok', reasons: [] },
      }),
      makeItem({
        id: 'multi-verified-ok',
        sourceCount: 2,
        links: [
          { url: 'https://unverified.xyz', known: false },
          { url: 'https://app.uniswap.org', known: true },
          { url: 'https://docs.uniswap.org', known: true },
        ],
        risk: { level: 'ok', reasons: [] },
      }),
      makeItem({
        id: 'multi-warn-only',
        sourceCount: 4,
        links: [],
        risk: { level: 'warn', reasons: ['Domain not in verified registry'] },
      }),
      makeItem({
        id: 'single-risk',
        sourceCount: 1,
        links: [{ url: 'http://phish.invalid', known: false }],
        risk: { level: 'risk', reasons: ['Drainer phrasing detected'] },
      }),
    ];

    expect(summarizeDrops(items)).toEqual({
      totalClusters: 4,
      multiSourceCount: 2,
      verifiedLinkCount: 1,
      riskFlaggedCount: 1,
    });
  });

  test('counts an item matching all conditions in every bucket independently', () => {
    const items: FeedItem[] = [
      makeItem({
        id: 'overlap',
        sourceCount: 3,
        links: [{ url: 'https://verified.example', known: true }],
        risk: { level: 'risk', reasons: ['Suspicious approval'] },
      }),
    ];

    expect(summarizeDrops(items)).toEqual({
      totalClusters: 1,
      multiSourceCount: 1,
      verifiedLinkCount: 1,
      riskFlaggedCount: 1,
    });
  });

  test('handles boundary source counts and does not mutate input array', () => {
    const itemZero = makeItem({ id: 'zero', sourceCount: 0 });
    const itemNeg = makeItem({ id: 'neg', sourceCount: -1 });
    const itemTwo = makeItem({ id: 'two', sourceCount: 2 });
    const input = Object.freeze([itemZero, itemNeg, itemTwo]);

    expect(summarizeDrops(input)).toEqual({
      totalClusters: 3,
      multiSourceCount: 1,
      verifiedLinkCount: 0,
      riskFlaggedCount: 0,
    });
    expect(input).toHaveLength(3);
  });
});
