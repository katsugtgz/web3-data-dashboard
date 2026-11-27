import { describe, expect, test } from 'bun:test';
import type { Card, FeedItem } from '../../shared/types';
import {
  reconcileDetailSelection,
  reconcileDropsDetailSelection,
  resolveDetailCard,
  resolveDropsDetail,
  type DetailRef,
} from './useDetailSelection';

function makeDrop(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'drop-1',
    project: 'Alpha',
    chains: ['Base'],
    taskTypes: ['quest'],
    summary: 'Complete tasks.',
    links: [],
    sources: [],
    sourceCount: 1,
    score: 0.8,
    risk: { level: 'ok', reasons: [] },
    firstSeen: 100,
    lastSeen: 200,
    ...over,
  };
}

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
    best: { n: 'Quest', ty: 'quest', c: 'Free', m: '5 min' },
    sc: 80,
    sub: [8, 8, null],
    url: 'https://alpha.xyz',
    ...over,
  };
}

describe('detail selection reconciliation', () => {
  test('retains selection when the selected project stays in cards with updated fields', () => {
    const selectedById: DetailRef = { id: 'surf-1', name: 'Alpha' };
    const updatedCard = makeCard({ id: 'surf-1', n: 'Alpha Renamed', sc: 95, b: ['live', 'early'] });
    const res = reconcileDetailSelection([updatedCard], selectedById);
    expect(res.shouldClear).toBe(false);
    expect(res.detail).toEqual(updatedCard);

    // Legacy selection without id stays matched by name even after feed backfills id.
    const selectedByName: DetailRef = { id: null, name: 'Alpha' };
    const backfilled = makeCard({ id: 'surf-1', n: 'Alpha', sc: 88 });
    const resLegacy = reconcileDetailSelection([backfilled], selectedByName);
    expect(resLegacy.shouldClear).toBe(false);
    expect(resLegacy.detail).toEqual(backfilled);
  });

  test('signals clearing when the selected project disappears from cards', () => {
    const selected: DetailRef = { id: 'surf-1', name: 'Alpha' };
    const otherSameName = makeCard({ id: 'surf-2', n: 'Alpha' });
    const missing = reconcileDetailSelection([otherSameName], selected);
    expect(missing.detail).toBeNull();
    expect(missing.shouldClear).toBe(true);

    // Once cleared to null, a later refresh restoring surf-1 does not reopen the dialog.
    const restored = reconcileDetailSelection([makeCard({ id: 'surf-1', n: 'Alpha' })], null);
    expect(restored.detail).toBeNull();
    expect(restored.shouldClear).toBe(false);
    expect(resolveDetailCard([makeCard({ id: 'surf-1' })], null)).toBeNull();
  });

  test('clears selected drop id when drop leaves live feed so a later return does not reopen the drawer', () => {
    const updated = makeDrop({ id: 'drop-1', summary: 'Updated summary.' });
    const retained = reconcileDropsDetailSelection([updated], 'drop-1');
    expect(retained.shouldClear).toBe(false);
    expect(retained.detail).toEqual(updated);

    const removed = reconcileDropsDetailSelection([makeDrop({ id: 'drop-2' })], 'drop-1');
    expect(removed.detail).toBeNull();
    expect(removed.shouldClear).toBe(true);

    const returnedAfterClear = reconcileDropsDetailSelection([makeDrop({ id: 'drop-1' })], null);
    expect(returnedAfterClear.detail).toBeNull();
    expect(returnedAfterClear.shouldClear).toBe(false);
    expect(resolveDropsDetail([makeDrop({ id: 'drop-1' })], null)).toBeNull();
  });
});
