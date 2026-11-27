import { describe, expect, test } from 'bun:test';
import type { FeedItem, MarketSection } from '../../shared/types';
import {
  bucketDaily,
  changeMagnitude,
  describeBuckets,
  momentumPercent,
  scaleDeltaColumns,
  sectorIntensity,
  sparklineArea,
  sparklinePoints,
  summarizeCardMix,
  summarizeDropMix,
} from './viz';

// 2026-11-27T12:00:00Z
const NOW = Date.UTC(2026, 10, 27, 12);

const ITEM: FeedItem = {
  id: 'd1',
  project: 'Acme',
  chains: [],
  taskTypes: ['quest'],
  summary: '',
  links: [{ url: 'https://app.acme.xyz/quest', known: true }],
  sources: [{ platform: 'telegram', handle: 'acme', postUrl: 'https://t.me/acme/1', postedAt: 300 }],
  sourceCount: 1,
  score: 0.8,
  risk: { level: 'ok', reasons: [] },
  firstSeen: 100,
  lastSeen: 900,
};

describe('sparkline math', () => {
  test('counts timestamps per day, oldest first, ignoring future and out-of-window values', () => {
    const day = 86_400_000;
    const timestamps = [NOW, NOW - 2 * day, NOW - 2 * day, NOW - 7 * day, NOW + day, 0, Number.NaN];

    expect(bucketDaily(timestamps, NOW)).toEqual([0, 0, 0, 0, 2, 0, 1]);
    expect(bucketDaily([], NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(describeBuckets([0, 0, 0, 0, 2, 0, 1])).toBe('1 today · peak 2/7d');
  });

  test('spans the sparkline across its box and flattens an all-zero series', () => {
    expect(sparklinePoints([0, 5, 0], 96, 22)).toBe('0.00,21.00 48.00,1.00 96.00,21.00');
    expect(sparklinePoints([0, 0], 96, 22)).toBe('0.00,11.00 96.00,11.00');
    expect(sparklinePoints([3], 96, 22)).toBe('0.00,1.00');
    expect(sparklinePoints([])).toBe('');
    expect(sparklineArea('0.00,21.00 96.00,1.00', 96, 22)).toBe('M0,22 L0.00,21.00 L96.00,1.00 L96,22 Z');
    expect(sparklineArea('')).toBe('');
  });
});

describe('distribution summaries', () => {
  test('summarizeCardMix counts tiers, folds long source tails into Other, and converts update times to ms', () => {
    const mix = summarizeCardMix([
      { g: 'S', source: 'ASSO7878', updatedTs: 1 },
      { g: 'C', source: 'ASSO7878' },
      { g: 'S', source: 'arndxt' },
      { g: 'B', source: 'a' },
      { g: 'A', source: 'b' },
      { g: 'B', source: 'c' },
      { g: 'C', source: 'd' },
      { g: 'A', source: 'e' },
    ]);

    expect(mix.tiers.map(tier => [tier.id, tier.value, tier.tone])).toEqual([
      ['S', 2, 's'],
      ['A', 2, 'a'],
      ['B', 2, 'b'],
      ['C', 2, 'c'],
    ]);
    expect(mix.sources.map(source => [source.label, source.value])).toEqual([
      ['ASSO7878', 2],
      ['arndxt', 1],
      ['a', 1],
      ['b', 1],
      ['Other', 3],
    ]);
    expect(mix.updated).toEqual([1000]);
  });

  test('summarizeDropMix ranks platforms and splits corroboration and verification', () => {
    const corroborated = {
      ...ITEM,
      sourceCount: 2,
      sources: [...ITEM.sources, { platform: 'X', handle: 'acme', postUrl: 'https://x.com/acme/status/1', postedAt: 500 }],
    };
    const unverified: FeedItem = { ...ITEM, links: [{ url: 'https://t.me/acme/1', known: false }] };
    const mix = summarizeDropMix([corroborated, unverified]);

    expect(mix.platforms.map(platform => [platform.id, platform.value, platform.tone])).toEqual([
      ['telegram', 2, 'info'],
      ['x', 1, 'neutral'],
    ]);
    expect(mix.corroboration.map(segment => [segment.id, segment.value])).toEqual([
      ['multi', 1],
      ['single', 1],
    ]);
    expect(mix.verification.map(segment => [segment.id, segment.value])).toEqual([
      ['verified', 1],
      ['unknown', 1],
    ]);
    expect(mix.lastSeen).toEqual([900, 900]);
  });

  test('empty inputs produce empty charts instead of throwing', () => {
    const emptyDropMix = summarizeDropMix([]);

    expect(emptyDropMix).toMatchObject({ lastSeen: [], platforms: [] });
    expect([...emptyDropMix.corroboration, ...emptyDropMix.verification].every(segment => segment.value === 0)).toBe(true);
    expect(summarizeCardMix([])).toMatchObject({ updated: [], sources: [] });
    expect(summarizeCardMix([]).tiers.every(tier => tier.value === 0)).toBe(true);
  });
});

describe('market momentum', () => {
  function makeSection(cols: string[], rows: string[][]): MarketSection {
    return {
      id: 'defi',
      title: 'DeFi',
      blurb: '',
      cols,
      rows: rows.map(cells => ({ cells })),
      source: 'test',
      sourceUrl: 'https://example.test',
      fetchedAt: 1,
      stale: false,
    };
  }

  test('scales each signed column by its largest absolute change and leaves plain columns at zero', () => {
    const section = makeSection(
      ['Protocol', '1d', '7d', 'TVL'],
      [
        ['A', '-4.00%', '+1.00%', '$1.0B'],
        ['B', '+2.00%', '-3.00%', '$2.0B'],
      ],
    );

    expect(scaleDeltaColumns(section)).toEqual([0, 4, 3, 0]);
    expect(changeMagnitude('+190.75%')).toBe(190.75);
    expect(changeMagnitude('$1.0B')).toBe(0);
    expect(changeMagnitude('—')).toBe(0);
  });

  test('maps a change onto bar width with a visible floor and a full-width cap', () => {
    expect(momentumPercent(4, 4)).toBe(100);
    expect(momentumPercent(2, 4)).toBe(50);
    expect(momentumPercent(0.04, 4)).toBe(6);
    expect(momentumPercent(9, 4)).toBe(100);
    expect(momentumPercent(3, 0)).toBe(100);
    expect(momentumPercent(0, 4)).toBe(0);
  });

  test('grades moves by magnitude', () => {
    expect(sectorIntensity(changeMagnitude('+190.75%'))).toBe('strong');
    expect(sectorIntensity(changeMagnitude('+5.10%'))).toBe('mid');
    expect(sectorIntensity(changeMagnitude('-0.80%'))).toBe('soft');
    expect(sectorIntensity(changeMagnitude('—'))).toBe('flat');
  });
});
