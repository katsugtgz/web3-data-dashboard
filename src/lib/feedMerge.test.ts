import { describe, expect, test } from 'bun:test';
import type { FeedItem } from '../../shared/types';
import { mergeVisibleUpdates, selectPending } from './feedMerge';

function item(id: string, over: Partial<FeedItem> = {}): FeedItem {
  const now = 1_700_000_000_000;
  return {
    id,
    project: `Project ${id}`,
    chains: ['Ethereum'],
    taskTypes: ['quest'],
    summary: `Summary for ${id}`,
    links: [],
    sources: [],
    sourceCount: 1,
    score: 0.5,
    risk: { level: 'ok', reasons: [] },
    firstSeen: now,
    lastSeen: now,
    ...over,
  };
}

function response(ids: string[]): FeedItem[] {
  return ids.map(id => item(id));
}

describe('feedMerge selectPending', () => {
  test('background result with only known ids clears the stale queue (returns null)', () => {
    expect(selectPending(response(['a', 'b']), ['a', 'b'])).toBeNull();
  });

  test('background result with new ids queues the full latest list', () => {
    const pending = selectPending(response(['a', 'b', 'c']), ['a', 'b']);
    expect(pending?.map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  test('newer result with no new ids supersedes a stale queue', () => {
    // Call-site semantics: setPendingItems(selectPending(...)) — null clears.
    const queued = selectPending(response(['a', 'b', 'c']), ['a']);
    expect(queued).not.toBeNull();
    // A later fetch containing only known ids clears whatever was queued.
    expect(selectPending(response(['a', 'b']), ['a', 'b', 'c'])).toBeNull();
  });
});

describe('feedMerge mergeVisibleUpdates', () => {
  test('updates displayed items in place keeping existing order', () => {
    const displayed = [item('b'), item('a')];
    const latest = [item('a', { score: 0.9 }), item('b', { score: 0.1 }), item('new')];
    const merged = mergeVisibleUpdates(displayed, latest);
    expect(merged.map(i => i.id)).toEqual(['b', 'a']);
    expect(merged.find(i => i.id === 'a')?.score).toBe(0.9);
    expect(merged.find(i => i.id === 'b')?.score).toBe(0.1);
  });

  test('does not auto-insert new items', () => {
    const merged = mergeVisibleUpdates([item('a')], [item('a'), item('b'), item('c')]);
    expect(merged.map(i => i.id)).toEqual(['a']);
  });

  test('drops displayed entries missing from the latest bounded response', () => {
    const merged = mergeVisibleUpdates([item('a'), item('gone')], [item('a')]);
    expect(merged.map(i => i.id)).toEqual(['a']);
  });

  test('never revives stale risk: risk state comes from latest item only', () => {
    const shownStale = [item('a', { risk: { level: 'risk', reasons: ['old drainer match'] } })];
    const latestOk = [item('a', { risk: { level: 'ok', reasons: [] } })];
    expect(mergeVisibleUpdates(shownStale, latestOk)[0].risk.level).toBe('ok');
    const shownOk = [item('a', { risk: { level: 'ok', reasons: [] } })];
    const latestRisk = [item('a', { risk: { level: 'risk', reasons: ['new drainer match'] } })];
    expect(mergeVisibleUpdates(shownOk, latestRisk)[0].risk.level).toBe('risk');
  });
});
