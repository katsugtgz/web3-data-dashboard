import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, FeedItem } from '../../shared/types';
import bundledManifest from '../../data/tasks/manifest.json';
import { BUNDLED_TASK_REGISTRY, buildTaskRegistry, findReviewedTask, RAW_REFS, type TaskRegistry } from './taskRegistry';

// Feed ids the bundled manifest binds to the live FLOP reference.
const FLOP_FEED_IDS = ['7331604250321743f7293ccd2a8740720b4df8b1', '3d019ff90b3736d50cba052cbe3a4bc4a40cf77e'];
const FLOP_SHA256 = '5f059e3f5f47b25db4d94f8e50426e942b275f963bc2308615fd1263eca51a3c';
const FLOP_CARD_ID = '021766f0-3b1d-488f-9c0c-0a4c37a92a52';
const FLOP = 'flop-testnet-voucher';

type Bindings = { card_ids?: string[]; feed_ids?: string[]; domains?: string[] };

/** A registry built from the bundled manifest and references with one row's bindings replaced. */
function registryWith(taskId: string, bindings: Bindings): TaskRegistry {
  const manifest = structuredClone(bundledManifest);
  const row = manifest.tasks.find(entry => entry.task_id === taskId)!;
  Object.assign(row.bindings, bindings);
  return buildTaskRegistry(manifest, RAW_REFS);
}

function isEmptyRegistry(registry: TaskRegistry): boolean {
  return (
    registry.manifest.tasks.length === 0 &&
    registry.byTaskId.size === 0 &&
    registry.byCardId.size === 0 &&
    registry.byFeedId.size === 0 &&
    registry.byDomain.size === 0
  );
}

function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'unbound-feed-id',
    project: 'SomeDrop',
    chains: ['Base'],
    taskTypes: ['quest'],
    summary: 'Run testnet',
    links: [],
    sources: [],
    sourceCount: 0,
    score: 0.7,
    risk: { level: 'ok', reasons: [] },
    firstSeen: 1000,
    lastSeen: 1000,
    ...over,
  };
}

function card(over: Partial<Card> = {}): Card {
  return {
    r: 1,
    n: 'SomeProject',
    id: 'surf-1',
    t: null,
    g: 'A',
    b: ['live'],
    f: '$10M',
    tk: '1/1',
    h: 100,
    u: 'today',
    fit: ['zero'],
    best: { n: 'Do testnet', ty: 'testnet', c: 'Free', m: '5 min' },
    sc: 80,
    sub: [8, 8, null],
    url: 'https://someproject.xyz',
    ...over,
  };
}

describe('bundled task registry', () => {
  test('binds the live FLOP reference to the feed ids its manifest row lists', () => {
    for (const id of FLOP_FEED_IDS) {
      const match = findReviewedTask(feedItem({ id }));
      expect(match?.entry.task_id).toBe('flop-testnet-voucher');
      expect(match?.entry.revision).toBe(1);
      expect(match?.entry.ref_sha256).toBe(FLOP_SHA256);
      expect(match?.ref.task_id).toBe('flop-testnet-voucher');
      expect(match?.ref.revision).toBe(1);
      expect(match?.ref.mode).toBe('live_read_only');
    }
  });

  test('bundles every manifest reference and leaves the two synthetic fixtures unbound', () => {
    expect(Object.keys(RAW_REFS).sort()).toEqual([
      'browser-email-demo.v1.json',
      'flop-testnet-voucher.v1.json',
      'voucher-demo.v1.json',
    ]);
    expect([...BUNDLED_TASK_REGISTRY.byTaskId.keys()].sort()).toEqual(['browser-email-demo', FLOP, 'voucher-demo']);
    expect([...BUNDLED_TASK_REGISTRY.byFeedId.keys()].sort()).toEqual([...FLOP_FEED_IDS].sort());
    expect(BUNDLED_TASK_REGISTRY.byCardId.size).toBe(0);
    expect(BUNDLED_TASK_REGISTRY.byDomain.size).toBe(0);
  });
});

describe('domain bindings', () => {
  const registry = registryWith(FLOP, { domains: ['flop.finance'] });

  test('match the declared domain only as an exact lowercase hostname', () => {
    expect(findReviewedTask(feedItem({ domain: 'Flop.Finance ' }), registry)?.entry.task_id).toBe(FLOP);
    const lookalikes = ['sub.flop.finance', 'notflop.finance', 'www.flop.finance', 'flop.finance.evil.test', 'flop.finance.', 'flop.finance/path'];
    for (const lookalike of lookalikes) {
      expect(findReviewedTask(feedItem({ domain: lookalike }), registry), lookalike).toBeNull();
    }
    expect(findReviewedTask(feedItem(), registry)).toBeNull();
  });

  test('match a www binding only for a www hostname, never for the bare domain', () => {
    const wwwRegistry = registryWith(FLOP, { domains: ['www.flop.finance'] });
    expect(findReviewedTask(feedItem({ domain: 'www.flop.finance' }), wwwRegistry)?.entry.task_id).toBe(FLOP);
    expect(findReviewedTask(feedItem({ domain: 'flop.finance' }), wwwRegistry)).toBeNull();
  });

  test('fall back to the hostname of a known link only when the item declares no domain', () => {
    const knownLink = { url: 'https://flop.finance/docs?ref=1', known: true };
    const unknownLink = { url: 'https://flop.finance/', known: false };
    const knownSubdomainLink = { url: 'https://ask.flop.finance/docs', known: true };
    expect(findReviewedTask(feedItem({ domain: undefined, links: [unknownLink, knownSubdomainLink, knownLink] }), registry)?.entry.task_id).toBe(FLOP);
    expect(findReviewedTask(feedItem({ domain: undefined, links: [unknownLink, knownSubdomainLink] }), registry)).toBeNull();
    // A declared domain is the only key once present: links never override it.
    expect(findReviewedTask(feedItem({ domain: 'other.test', links: [knownLink] }), registry)).toBeNull();
  });
});

describe('card bindings', () => {
  const registry = registryWith(FLOP, { card_ids: [FLOP_CARD_ID], domains: ['flop.finance'] });

  test('match the card id first, then the exact hostname of the project URL', () => {
    expect(findReviewedTask(card({ id: FLOP_CARD_ID, url: 'https://unrelated.test/' }), registry)?.entry.task_id).toBe(FLOP);
    expect(findReviewedTask(card({ id: null, url: 'https://FLOP.Finance:443/app?x=1' }), registry)?.entry.task_id).toBe(FLOP);
    expect(findReviewedTask(card({ id: null, url: 'flop.finance/app' }), registry)?.entry.task_id).toBe(FLOP);
    for (const url of ['https://www.flop.finance/', 'https://sub.flop.finance/', 'https://notflop.finance/', 'javascript:alert(1)', null]) {
      expect(findReviewedTask(card({ id: null, url }), registry), String(url)).toBeNull();
    }
    expect(findReviewedTask(card(), registry)).toBeNull();
  });
});

describe('invalid input', () => {
  const flopRef = RAW_REFS['flop-testnet-voucher.v1.json'] as Record<string, unknown>;
  const refsReplacingFlop = (ref: unknown): Readonly<Record<string, unknown>> => ({ ...RAW_REFS, 'flop-testnet-voucher.v1.json': ref });
  const flopRow = bundledManifest.tasks.find(entry => entry.task_id === FLOP)!;

  test('returns the registry that matches nothing for a manifest that fails validation', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      'tasks',
      7,
      [],
      {},
      { ...bundledManifest, kind: 'other' },
      { ...bundledManifest, tasks: 'tasks' },
      { ...bundledManifest, extra: true },
      // One task_id listed twice.
      { ...bundledManifest, tasks: [...bundledManifest.tasks, flopRow] },
      // A ref_path that disagrees with the task_id and revision.
      { ...bundledManifest, tasks: bundledManifest.tasks.map(row => (row.task_id === FLOP ? { ...row, ref_path: 'renamed.v1.json' } : row)) },
      // A binding that is not a list.
      { ...bundledManifest, tasks: bundledManifest.tasks.map(row => (row.task_id === FLOP ? { ...row, bindings: { ...row.bindings, domains: 'flop.finance' } } : row)) },
    ];
    for (const manifest of invalid) {
      const registry = buildTaskRegistry(manifest, RAW_REFS);
      expect(isEmptyRegistry(registry), JSON.stringify(manifest)).toBe(true);
      expect(findReviewedTask(feedItem({ id: FLOP_FEED_IDS[0] }), registry), JSON.stringify(manifest)).toBeNull();
    }
  });

  test('returns the registry that matches nothing when a pinned reference is missing or invalid', () => {
    const flopFeedItem = feedItem({ id: FLOP_FEED_IDS[0] });
    const invalidRefs: unknown[] = [
      null,
      'flop-testnet-voucher.v1.json',
      {},
      { ...RAW_REFS, 'flop-testnet-voucher.v1.json': undefined },
      refsReplacingFlop({ ...flopRef, task_id: 'other-task' }),
      refsReplacingFlop({ ...flopRef, revision: 2 }),
      refsReplacingFlop({ ...flopRef, mode: 'live' }),
      refsReplacingFlop({ ...flopRef, steps: 'steps' }),
      // The manifest row that must stay valid is dragged down with the rest: no partial registry.
      { ...RAW_REFS, 'voucher-demo.v1.json': { ...RAW_REFS, kind: 'task_ref' } },
    ];
    for (const refs of invalidRefs) {
      const registry = buildTaskRegistry(bundledManifest, refs as Readonly<Record<string, unknown>>);
      expect(isEmptyRegistry(registry), JSON.stringify(refs)).toBe(true);
      expect(findReviewedTask(flopFeedItem, registry), JSON.stringify(refs)).toBeNull();
    }
    expect(findReviewedTask(flopFeedItem, buildTaskRegistry(bundledManifest, RAW_REFS))?.entry.task_id).toBe(FLOP);
  });

  test('does not throw when reading the input throws', () => {
    const hostileRefs = new Proxy({}, { get: () => { throw new Error('boom'); }, has: () => true });
    expect(isEmptyRegistry(buildTaskRegistry(bundledManifest, hostileRefs))).toBe(true);
    const hostileManifest = { get tasks() { throw new Error('boom'); } };
    expect(isEmptyRegistry(buildTaskRegistry(hostileManifest, RAW_REFS))).toBe(true);
  });

  test('keeps a synthetic fixture unbound: a manifest that binds one matches nothing', () => {
    const bindings: [string, Bindings][] = [
      ['voucher-demo', { feed_ids: ['abc'] }],
      ['voucher-demo', { card_ids: [FLOP_CARD_ID] }],
      ['browser-email-demo', { domains: ['demo.test'] }],
    ];
    for (const [taskId, binding] of bindings) {
      expect(isEmptyRegistry(registryWith(taskId, binding)), `${taskId} ${Object.keys(binding)[0]}`).toBe(true);
    }
  });
});

describe('bundled synthetic fixtures', () => {
  test('never match any item, and feed ids match only exactly', () => {
    const items: (FeedItem | Card)[] = [
      feedItem({ id: 'voucher-demo' }),
      feedItem({ id: 'browser-email-demo', domain: 'demo.test', links: [{ url: 'https://demo.test/', known: true }] }),
      card({ id: 'voucher-demo' }),
      card({ id: null, url: 'https://demo.test' }),
      feedItem({ id: FLOP_FEED_IDS[0].toUpperCase() }),
    ];
    for (const item of items) {
      expect(findReviewedTask(item), item.id ?? 'card').toBeNull();
    }
  });
});

describe('task registry source', () => {
  test('holds no network call: the bundled files are its only source of task data', () => {
    const source = readFileSync(join(import.meta.dir, 'taskRegistry.ts'), 'utf8');
    for (const token of ['fetch(', 'import(', 'XMLHttpRequest']) {
      expect(source, token).not.toContain(token);
    }
  });
});
