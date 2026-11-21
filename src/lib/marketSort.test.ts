import { describe, expect, test } from 'bun:test';
import type { MarketRow } from '../../shared/types';
import { cmpRows } from './marketSort';

function row(cells: string[], sortValues?: (string | number | null)[]): MarketRow {
  return sortValues ? { cells, sortValues } : { cells };
}

describe('marketSort cmpRows', () => {
  test('sorts raw numeric sort values, not display strings, honoring direction', () => {
    // Display strings would sort "$9.50" > "$1.2B" lexically; raw values must not.
    const big = row(['X', '$1.2B'], ['X', 1_200_000_000]);
    const small = row(['Y', '$9.50'], ['Y', 9.5]);
    expect(cmpRows(big, small, 1, 1)).toBeGreaterThan(0);
    expect(cmpRows(big, small, 1, -1)).toBeLessThan(0);
    expect(cmpRows(small, big, 1, 1)).toBeLessThan(0);
  });

  test('compares negative and fractional percentages numerically', () => {
    const down = row(['A', '-2.4%'], ['A', -2.4]);
    const up = row(['B', '+10.1%'], ['B', 10.1]);
    expect(cmpRows(down, up, 1, 1)).toBeLessThan(0);
  });

  test('sorts text columns with numeric-aware collation', () => {
    const a = row(['Pool 2'], ['Pool 2']);
    const b = row(['Pool 10'], ['Pool 10']);
    expect(cmpRows(a, b, 0, 1)).toBeLessThan(0);
  });

  test('missing anchors sort last in BOTH directions', () => {
    const absent = row(['A', '—'], ['A', null]);
    const present = row(['B', '$5'], ['B', 5]);
    expect(cmpRows(absent, present, 1, 1)).toBeGreaterThan(0);
    expect(cmpRows(absent, present, 1, -1)).toBeGreaterThan(0);
    expect(cmpRows(present, absent, 1, 1)).toBeLessThan(0);
    expect(cmpRows(present, absent, 1, -1)).toBeLessThan(0);
    expect(cmpRows(absent, row(['C', '—'], ['C', null]), 1, 1)).toBe(0);
  });

  test('legacy rows preserve payload order — no numeric guessing from display strings', () => {
    expect(cmpRows(row(['A', '$9.50']), row(['B', '$1.2B']), 1, 1)).toBe(0);
    expect(cmpRows(row(['A', '$9.50']), row(['B', '$1.2B']), 1, -1)).toBe(0);
  });

  test('mixed legacy/anchored rows: anchored side sorts, legacy side sinks both directions', () => {
    const anchored = row(['A', '$5'], ['A', 5]);
    const legacy = row(['B', '$999']);
    expect(cmpRows(legacy, anchored, 1, 1)).toBeGreaterThan(0);
    expect(cmpRows(legacy, anchored, 1, -1)).toBeGreaterThan(0);
    expect(cmpRows(anchored, legacy, 1, 1)).toBeLessThan(0);
  });

  test('missing column cell sorts as null anchor', () => {
    const short = row(['A']);
    const full = row(['B', '1'], ['B', 1]);
    expect(cmpRows(short, full, 1, 1)).toBeGreaterThan(0);
    expect(cmpRows(short, full, 1, -1)).toBeGreaterThan(0);
  });

  test('equal anchors compare equal for stable sort', () => {
    expect(cmpRows(row(['A', '5'], ['A', 5]), row(['B', '5'], ['B', 5]), 1, 1)).toBe(0);
  });
});
