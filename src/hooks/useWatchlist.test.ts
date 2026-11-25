import { describe, expect, test } from 'bun:test';
import type { Card } from '../../shared/types';
import {
  cardStorageKey,
  getCardTaskKeyPairs,
  isCardSaved,
  isTaskKeyDone,
  toggleStorageEntry,
} from './useWatchlist';

const cardWithId: Card = {
  r: 1,
  n: 'MegaTestnet',
  id: 'surf-42',
  t: 'MEGA',
  g: 'S',
  b: ['live'],
  f: '$25M',
  tk: '1/1',
  h: 500,
  u: 'today',
  fit: ['zero'],
  best: { n: 'Claim faucet', ty: 'faucet', c: 'Free', m: '5 min' },
  tasks: [{ title: 'Claim faucet', type: 'faucet', status: 'OPEN', cost: 0, timeMinutes: 5, url: null }],
  sc: 90,
  sub: [9, 9, null],
  url: null,
};

describe('useWatchlist legacy card.n -> card.id compatibility', () => {
  test('recognizes saved stars stored under legacy card.n after card.id backfills and cleanly unsaves both', () => {
    const legacySaved = new Set(['MegaTestnet']);
    expect(isCardSaved(legacySaved, cardWithId)).toBe(true);

    const unsaved = toggleStorageEntry(legacySaved, cardStorageKey(cardWithId), cardWithId.n);
    expect(unsaved.has('MegaTestnet')).toBe(false);
    expect(unsaved.has('surf-42')).toBe(false);

    const resaved = toggleStorageEntry(unsaved, cardStorageKey(cardWithId), cardWithId.n);
    expect(resaved.has('surf-42')).toBe(true);
    expect(resaved.has('MegaTestnet')).toBe(false);
  });

  test('recognizes done tasks stored under legacy card.n after card.id backfills and cleanly toggles them off', () => {
    const legacyKey = JSON.stringify(['MegaTestnet', 'Claim faucet', 'faucet', 0]);
    const doneTasks = new Set([legacyKey]);
    const pairs = getCardTaskKeyPairs(cardWithId, cardWithId.tasks!);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].primary).toBe(JSON.stringify(['surf-42', 'Claim faucet', 'faucet', 0]));
    expect(pairs[0].legacy).toBe(legacyKey);
    expect(isTaskKeyDone(doneTasks, pairs[0])).toBe(true);

    const unchecked = toggleStorageEntry(doneTasks, pairs[0].primary, pairs[0].legacy ?? undefined);
    expect(isTaskKeyDone(unchecked, pairs[0])).toBe(false);
    expect(unchecked.size).toBe(0);
  });
});
