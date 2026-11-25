import { describe, expect, test } from 'bun:test';
import { fmtPct, fmtPrice, fmtUsd } from '../src/lib/format';

describe('worker fmtUsd bound behavior', () => {
  test('tiny amounts: fixed decimals, then em-dash floor (no false zero)', () => {
    expect(fmtUsd(0.000000089)).toBe('$0.0000000890'); // 8.9e-8 → 12-decimal fixed
    expect(fmtUsd(4e-13)).toBe('—'); // below 5e-13: unrepresentable → em dash
    expect(fmtUsd(1e12)).toBe('$1.00T'); // trillions boundary
  });
});

describe('fmtPrice sub-cent guard', () => {
  test('keeps significant digits in the sub-cent range', () => {
    expect(fmtPrice(0.0042)).toBe('$0.0042');
    expect(fmtPrice(0.000000000042)).toBe('$0.000000000042'); // 4.2e-11: fits in 12 decimals
  });

  test('collapses below 5e-13 to the em dash instead of a false zero', () => {
    // 12-decimal cap leaves no significant digit here: must not print $0.000000000000.
    expect(fmtPrice(4e-13)).toBe('—');
    expect(fmtPrice(1e-15)).toBe('—');
  });
});

describe('fmtPct signed-zero guard', () => {
  test('never emits -0.00% or +0.00% for near-zero percentages (e.g. stablecoins)', () => {
    expect(fmtPct(-0.001)).toBe('0.00%');
    expect(fmtPct(-0.0049)).toBe('0.00%');
    expect(fmtPct(-0)).toBe('0.00%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(0.001)).toBe('0.00%');
    expect(fmtPct(0.0049)).toBe('0.00%');
    expect(fmtPct(0.005)).toBe('+0.01%');
    expect(fmtPct(-0.005)).toBe('-0.01%');
    expect(fmtPct(4.216)).toBe('+4.22%');
    expect(fmtPct(-1.8)).toBe('-1.80%');
  });
});
