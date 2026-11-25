import { describe, expect, test } from 'bun:test';
import type { Card, FeedItem } from '../../shared/types';
import { formatCopyBlockedMessage, resolveLiveBriefTarget } from './useCopyBriefController';

function makeCard(over: Partial<Card> = {}): Card {
  return {
    r: 1,
    n: 'Alpha',
    id: 'surf-1',
    t: 'ALP',
    g: 'A',
    b: ['live'],
    f: '$10M',
    tk: '1/1',
    h: 500,
    u: 'today',
    fit: ['zero'],
    best: { n: 'Do testnet', ty: 'testnet', c: 'Free', m: '5 min' },
    sc: 80,
    sub: [8, 8, null],
    url: 'https://alpha.xyz',
    ...over,
  };
}

function makeFeedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'drop-1',
    project: 'Beta',
    chains: ['Base'],
    taskTypes: ['testnet'],
    summary: 'Run testnet',
    links: [],
    sources: [],
    sourceCount: 1,
    score: 0.7,
    risk: { level: 'ok', reasons: [] },
    firstSeen: 1000,
    lastSeen: 1000,
    ...over,
  };
}

describe('resolveLiveBriefTarget', () => {
  test('resolves live Card by id so live RISK updates take effect and disappears when removed', () => {
    const staleCard = makeCard({ id: 'surf-1', b: ['live'] });
    const updatedRiskCard = makeCard({ id: 'surf-1', b: ['risk'] });

    const resolved = resolveLiveBriefTarget(staleCard, [], [updatedRiskCard]);
    expect(resolved).toEqual(updatedRiskCard);

    // Must not falsely match a different project id that shares the same name.
    const otherSameName = makeCard({ id: 'surf-999', n: 'Alpha', b: ['live'] });
    expect(resolveLiveBriefTarget(staleCard, [], [otherSameName])).toBeNull();
  });

  test('resolves legacy Card without id by project name even after live feed backfills id', () => {
    const legacyCard = makeCard({ id: undefined, n: 'Alpha' });
    const backfilledCard = makeCard({ id: 'surf-1', n: 'Alpha', b: ['risk'] });
    expect(resolveLiveBriefTarget(legacyCard, [], [backfilledCard])).toEqual(backfilledCard);
  });

  test('resolves FeedItem from live visible items', () => {
    const staleItem = makeFeedItem({ id: 'drop-1', risk: { level: 'ok', reasons: [] } });
    const liveRiskItem = makeFeedItem({ id: 'drop-1', risk: { level: 'risk', reasons: ['Drainer'] } });
    expect(resolveLiveBriefTarget(staleItem, [liveRiskItem], [])).toEqual(liveRiskItem);
    expect(resolveLiveBriefTarget(staleItem, [], [])).toBeNull();
  });
});

describe('formatCopyBlockedMessage', () => {
  test('never tells Drops or page-level users to open non-existent Preview in details', () => {
    const feedItem = makeFeedItem();
    const card = makeCard();
    expect(formatCopyBlockedMessage(feedItem, 'page')).toBe(
      'Clipboard blocked — use your browser clipboard permissions and retry.',
    );
    expect(formatCopyBlockedMessage(feedItem, 'profile')).toBe(
      'Clipboard blocked — use your browser clipboard permissions and retry.',
    );
    expect(formatCopyBlockedMessage(card, 'page')).toBe(
      'Clipboard blocked — use your browser clipboard permissions and retry.',
    );
    expect(formatCopyBlockedMessage(card, 'detail')).toBe(
      'Clipboard blocked — open Preview in details to copy.',
    );
  });
});
