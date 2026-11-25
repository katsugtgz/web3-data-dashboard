import { describe, expect, test } from 'bun:test';
import type { Card } from '../../shared/types';
import {
  cardStorageKey,
  commitWatchlistSetMigration,
  getCardTaskKeyPairs,
  isCardSaved,
  isTaskKeyDone,
  migrateLegacySheetIds,
  taskStorageKey,
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

describe('migrateLegacySheetIds (PRRT_kwDOV0YtbM67w6DY)', () => {
  test('migrates unique legacy bare-slug IDs across all 4 prefixes in both saved projects and JSON-encoded task keys', () => {
    const cards: Pick<Card, 'id' | 'n'>[] = [
      { id: 'asso7878:acme-labs-1a2b3c4d', n: 'Acme Labs' },
      { id: 'arndxt:kite-testnet-5e6f7a8b', n: 'Kite Testnet' },
      { id: 'pendle:a-b-9c0d1e2f', n: 'A+B' },
      { id: 'merkl:euler-v2-abcdef01', n: 'Euler V2' },
      { id: 'surf-42', n: 'MegaTestnet' },
    ];

    const saved = new Set([
      'asso7878:acme-labs',
      'arndxt:kite-testnet',
      'pendle:a-b',
      'merkl:euler-v2',
      'surf-42',
      'MegaTestnet',
    ]);
    const doneTasks = new Set([
      taskStorageKey('asso7878:acme-labs', 'Trade on testnet', 'trading', 0),
      taskStorageKey('arndxt:kite-testnet', 'Claim faucet', 'testnet', 0),
      taskStorageKey('pendle:a-b', 'Supply YT', 'liquidity', 1),
      taskStorageKey('merkl:euler-v2', 'Lend USDC', 'staking', 0),
      taskStorageKey('surf-42', 'Claim faucet', 'faucet', 0),
      'not-valid-json-legacy-key',
    ]);

    const res = migrateLegacySheetIds(saved, doneTasks, cards);
    expect(res.changed).toBe(true);
    expect(res.saved).toEqual(
      new Set([
        'asso7878:acme-labs-1a2b3c4d',
        'arndxt:kite-testnet-5e6f7a8b',
        'pendle:a-b-9c0d1e2f',
        'merkl:euler-v2-abcdef01',
        'surf-42',
        'MegaTestnet',
      ]),
    );
    expect(res.doneTasks).toEqual(
      new Set([
        taskStorageKey('asso7878:acme-labs-1a2b3c4d', 'Trade on testnet', 'trading', 0),
        taskStorageKey('arndxt:kite-testnet-5e6f7a8b', 'Claim faucet', 'testnet', 0),
        taskStorageKey('pendle:a-b-9c0d1e2f', 'Supply YT', 'liquidity', 1),
        taskStorageKey('merkl:euler-v2-abcdef01', 'Lend USDC', 'staking', 0),
        taskStorageKey('surf-42', 'Claim faucet', 'faucet', 0),
        'not-valid-json-legacy-key',
      ]),
    );
    // Input sets must remain unmutated
    expect(saved.has('asso7878:acme-labs')).toBe(true);
    expect(doneTasks.has(taskStorageKey('asso7878:acme-labs', 'Trade on testnet', 'trading', 0))).toBe(true);
  });

  test('never migrates when an exact primary bare-slug ID exists or when multiple hashed candidates collide', () => {
    const cards: Pick<Card, 'id' | 'n'>[] = [
      // Exact primary ID exists alongside a hashed variant -> keep legacy exact ID untouched
      { id: 'asso7878:acme-labs', n: 'Acme-Labs' },
      { id: 'asso7878:acme-labs-1a2b3c4d', n: 'Acme Labs' },
      // Ambiguous collision: two hashed variants and no exact primary ID -> refuse to migrate
      { id: 'pendle:a-b-11112222', n: 'A+B' },
      { id: 'pendle:a-b-33334444', n: 'A/B' },
      // Ambiguous duplicate-nameKey pair -> refuse to migrate
      { id: 'arndxt:dupproto-aaaa1111', n: 'DupProto' },
      { id: 'arndxt:dupproto-bbbb2222', n: 'DupProto' },
    ];

    const saved = new Set(['asso7878:acme-labs', 'pendle:a-b', 'arndxt:dupproto']);
    const doneTasks = new Set([
      taskStorageKey('asso7878:acme-labs', 'Swap', 'trading', 0),
      taskStorageKey('pendle:a-b', 'LP', 'liquidity', 0),
      taskStorageKey('arndxt:dupproto', 'Stake', 'staking', 0),
    ]);

    const res = migrateLegacySheetIds(saved, doneTasks, cards);
    expect(res.changed).toBe(false);
    expect(res.saved).toEqual(saved);
    expect(res.doneTasks).toEqual(doneTasks);
  });

  test('does not cross-match unrelated prefix-sharing slugs, hex-ending names, and deduplicates already-present hashed IDs', () => {
    const cards: Pick<Card, 'id' | 'n'>[] = [
      { id: 'asso7878:acme-labs-1a2b3c4d', n: 'Acme Labs' },
      { id: 'asso7878:acme-labs-pro-99887766', n: 'Acme Labs Pro' },
      { id: 'asso7878:foo-12345678', n: 'foo-12345678' },
      { id: 'asso7878:foo-12345678-abcdef01', n: 'Foo 12345678' },
      { id: 'merkl:bar-12345678~abcdef01', n: 'Bar 12345678' },
    ];

    // 'asso7878:acme' (removed project) must NOT hijack 'Acme Labs';
    // 'asso7878:foo' must NOT hijack canonical 'foo-12345678' OR hashed 'Foo 12345678';
    // 'merkl:bar' must NOT hijack hashed 'Bar 12345678';
    // 'asso7878:acme-labs' MUST still migrate to 'asso7878:acme-labs-1a2b3c4d' despite 'Acme Labs Pro' existing
    // and deduplicate cleanly if 'asso7878:acme-labs-1a2b3c4d' is already saved.
    const saved = new Set([
      'asso7878:acme',
      'asso7878:foo',
      'merkl:bar',
      'asso7878:acme-labs',
      'asso7878:acme-labs-1a2b3c4d',
    ]);
    const doneTasks = new Set([
      taskStorageKey('asso7878:acme', 'Old task', 'other', 0),
      taskStorageKey('asso7878:foo', 'Old foo task', 'other', 0),
    ]);

    const res = migrateLegacySheetIds(saved, doneTasks, cards);
    expect(res.changed).toBe(true);
    expect(res.saved).toEqual(new Set(['asso7878:acme', 'asso7878:foo', 'merkl:bar', 'asso7878:acme-labs-1a2b3c4d']));
    expect(res.doneTasks).toEqual(doneTasks);
  });

  test('migrates tilde-delimited Pendle/Merkl hashed IDs and Merkl protocol.id-based IDs while refusing ambiguous Merkl names', () => {
    const cards: Pick<Card, 'id' | 'n'>[] = [
      { id: 'pendle:a-b~9c0d1e2f', n: 'A+B' },
      { id: 'merkl:euler-finance', n: 'Euler V2' },
      { id: 'merkl:zeta-labs~11223344', n: 'Zeta Labs' },
      { id: 'merkl:alpha-v1', n: 'Alpha' },
      { id: 'merkl:alpha-v2~55667788', n: 'Alpha' },
    ];

    const saved = new Set(['pendle:a-b', 'merkl:euler-v2', 'merkl:zeta-labs', 'merkl:alpha']);
    const doneTasks = new Set([
      taskStorageKey('pendle:a-b', 'Supply YT', 'liquidity', 0),
      taskStorageKey('merkl:euler-v2', 'Lend USDC', 'staking', 0),
      taskStorageKey('merkl:alpha', 'Farm', 'liquidity', 0),
    ]);

    const res = migrateLegacySheetIds(saved, doneTasks, cards);
    expect(res.changed).toBe(true);
    expect(res.saved).toEqual(
      new Set(['pendle:a-b~9c0d1e2f', 'merkl:euler-finance', 'merkl:zeta-labs~11223344', 'merkl:alpha']),
    );
    expect(res.doneTasks).toEqual(
      new Set([
        taskStorageKey('pendle:a-b~9c0d1e2f', 'Supply YT', 'liquidity', 0),
        taskStorageKey('merkl:euler-finance', 'Lend USDC', 'staking', 0),
        taskStorageKey('merkl:alpha', 'Farm', 'liquidity', 0),
      ]),
    );
  });

  test('commitWatchlistSetMigration commits migrated keys into state so later feeds cannot re-migrate stale legacy keys', () => {
    const feed1: Pick<Card, 'id' | 'n'>[] = [{ id: 'asso7878:acme-labs-1a2b3c4d', n: 'Acme Labs' }];
    const feed2: Pick<Card, 'id' | 'n'>[] = [{ id: 'asso7878:acme-labs-99999999', n: 'Acme Labs' }];

    const initialSaved = { values: new Set(['asso7878:acme-labs']), version: 0 };
    const afterFeed1 = commitWatchlistSetMigration(initialSaved, feed1, 'saved');
    expect(afterFeed1.version).toBe(1);
    expect(afterFeed1.values).toEqual(new Set(['asso7878:acme-labs-1a2b3c4d']));

    // Re-running on feed1 or later feed2 with a different card sharing the legacy slug must NOT re-migrate.
    const repeatFeed1 = commitWatchlistSetMigration(afterFeed1, feed1, 'saved');
    expect(repeatFeed1).toBe(afterFeed1);
    const afterFeed2 = commitWatchlistSetMigration(afterFeed1, feed2, 'saved');
    expect(afterFeed2).toBe(afterFeed1);
    expect(afterFeed2.values).toEqual(new Set(['asso7878:acme-labs-1a2b3c4d']));

    const initialTasks = {
      values: new Set([taskStorageKey('merkl:euler-v2', 'Lend USDC', 'staking', 0)]),
      version: 0,
    };
    const migratedTasks = commitWatchlistSetMigration(
      initialTasks,
      [{ id: 'merkl:euler-finance', n: 'Euler V2' }],
      'tasks',
    );
    expect(migratedTasks.version).toBe(1);
    expect(migratedTasks.values).toEqual(
      new Set([taskStorageKey('merkl:euler-finance', 'Lend USDC', 'staking', 0)]),
    );
    expect(commitWatchlistSetMigration(migratedTasks, [{ id: 'merkl:other-euler', n: 'Euler V2' }], 'tasks')).toBe(
      migratedTasks,
    );
  });

  test('migrates disambiguated sheet keys back to the surviving base ID when a duplicate sibling disappears without hijacking unrelated or Pendle/Merkl keys', () => {
    const cards: Pick<Card, 'id' | 'n'>[] = [
      { id: 'asso7878:dupproto', n: 'DupProto' },
      { id: 'arndxt:acme-labs-1a2b3c4d', n: 'Acme Labs' },
      { id: 'asso7878:stilldup~bbbb2222', n: 'StillDup' },
      { id: 'asso7878:stilldup~cccc3333', n: 'StillDup' },
      { id: 'asso7878:foo', n: 'Foo' },
      { id: 'pendle:a-b', n: 'A-B' },
      { id: 'merkl:a-b', n: 'A-B' },
    ];

    const saved = new Set([
      'asso7878:dupproto~aaaa1111',
      'asso7878:dupproto~aaaa1111-2',
      'arndxt:acme-labs-1a2b3c4d~eeee2222',
      // Still duplicated (no base ID present) -> must stay untouched
      'asso7878:stilldup~aaaa1111',
      // Unrelated removed hex-ending project (no `~`) -> must NOT hijack `asso7878:foo`
      'asso7878:foo-12345678',
      // Removed non-canonical Pendle/Merkl card (`A+B`) -> must NOT hijack canonical `A-B`
      'pendle:a-b~9c0d1e2f',
      'merkl:a-b~9c0d1e2f',
    ]);
    const doneTasks = new Set([
      taskStorageKey('asso7878:dupproto~aaaa1111', 'Stake ETH', 'staking', 0),
      taskStorageKey('arndxt:acme-labs-1a2b3c4d~eeee2222', 'Bridge', 'bridge', 0),
      taskStorageKey('pendle:a-b~9c0d1e2f', 'Supply YT', 'liquidity', 0),
    ]);

    const res = migrateLegacySheetIds(saved, doneTasks, cards);
    expect(res.changed).toBe(true);
    expect(res.saved).toEqual(
      new Set([
        'asso7878:dupproto',
        'arndxt:acme-labs-1a2b3c4d',
        'asso7878:stilldup~aaaa1111',
        'asso7878:foo-12345678',
        'pendle:a-b~9c0d1e2f',
        'merkl:a-b~9c0d1e2f',
      ]),
    );
    expect(res.doneTasks).toEqual(
      new Set([
        taskStorageKey('asso7878:dupproto', 'Stake ETH', 'staking', 0),
        taskStorageKey('arndxt:acme-labs-1a2b3c4d', 'Bridge', 'bridge', 0),
        taskStorageKey('pendle:a-b~9c0d1e2f', 'Supply YT', 'liquidity', 0),
      ]),
    );
  });

  test('is a no-op when cards list is empty', () => {
    const saved = new Set(['asso7878:acme-labs']);
    const doneTasks = new Set([taskStorageKey('asso7878:acme-labs', 'Task', 'other', 0)]);
    const res = migrateLegacySheetIds(saved, doneTasks, []);
    expect(res.changed).toBe(false);
    expect(res.saved).toEqual(saved);
    expect(res.doneTasks).toEqual(doneTasks);
  });
});
