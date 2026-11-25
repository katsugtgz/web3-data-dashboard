import { describe, expect, test } from 'bun:test';
import { isDropsQueryHash, isUnknownTabHash, safeReplaceHash } from './useDashboardTabs';

describe('useDashboardTabs hash normalization and safety', () => {
  test('identifies unknown tab hashes while preserving empty, #main, and valid tabs', () => {
    expect(isUnknownTabHash('#invalid-tab')).toBe(true);
    expect(isUnknownTabHash('#nope?q=1')).toBe(true);
    expect(isUnknownTabHash('')).toBe(false);
    expect(isUnknownTabHash('#main')).toBe(false);
    expect(isUnknownTabHash('#drops')).toBe(false);
    expect(isUnknownTabHash('#drops?type=testnet')).toBe(false);
    expect(isUnknownTabHash('#?type=testnet')).toBe(false);
    expect(isUnknownTabHash('#crypto')).toBe(false);
    expect(isDropsQueryHash('#drops?q=base')).toBe(true);
  });

  test('safeReplaceHash swallows SecurityError / rate-limit exceptions from history.replaceState', () => {
    const origHistory = globalThis.history;
    Object.defineProperty(globalThis, 'history', {
      value: {
        state: null,
        replaceState() {
          throw new DOMException('Blocked', 'SecurityError');
        },
      },
      configurable: true,
    });
    try {
      expect(() => safeReplaceHash('#drops')).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'history', { value: origHistory, configurable: true });
    }
  });
});
