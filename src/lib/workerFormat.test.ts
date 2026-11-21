import { describe, expect, test } from 'bun:test';
import { fmtUsd } from '../../worker/src/lib/format';

describe('worker fmtUsd bound behavior', () => {
  test('tiny amounts: fixed decimals, then em-dash floor (no false zero)', () => {
    expect(fmtUsd(0.000000089)).toBe('$0.0000000890'); // 8.9e-8 → 12-decimal fixed
    expect(fmtUsd(4e-13)).toBe('—'); // below 5e-13: unrepresentable → em dash
    expect(fmtUsd(1e12)).toBe('$1.00T'); // trillions boundary
  });
});
