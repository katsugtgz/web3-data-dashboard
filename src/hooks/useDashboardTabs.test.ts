import { describe, expect, test } from 'bun:test';
import {
  computeNextTabIndex,
  getTabGroupMeta,
  isDropsQueryHash,
  isUnknownTabHash,
  safeReplaceHash,
} from './useDashboardTabs';

const IDS = ['drops', 'airdrops', 'crypto', 'defi', 'yields', 'predictions', 'trending', 'github'] as const;

describe('computeNextTabIndex', () => {
  test('ArrowRight and ArrowDown advance with wrap-around', () => {
    expect(computeNextTabIndex(IDS, 'drops', 'ArrowRight')).toBe(1);
    expect(computeNextTabIndex(IDS, 'drops', 'ArrowDown')).toBe(1);
    expect(computeNextTabIndex(IDS, 'github', 'ArrowRight')).toBe(0);
    expect(computeNextTabIndex(IDS, 'github', 'ArrowDown')).toBe(0);
  });

  test('ArrowLeft and ArrowUp step backward with wrap-around', () => {
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowLeft')).toBe(0);
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowUp')).toBe(0);
    expect(computeNextTabIndex(IDS, 'drops', 'ArrowLeft')).toBe(7);
    expect(computeNextTabIndex(IDS, 'drops', 'ArrowUp')).toBe(7);
  });

  test('Home and End jump to first and last indices', () => {
    expect(computeNextTabIndex(IDS, 'defi', 'Home')).toBe(0);
    expect(computeNextTabIndex(IDS, 'drops', 'End')).toBe(7);
  });

  test('unhandled keys and empty lists return -1', () => {
    expect(computeNextTabIndex(IDS, 'drops', 'Enter')).toBe(-1);
    expect(computeNextTabIndex(IDS, 'drops', ' ')).toBe(-1);
    expect(computeNextTabIndex(IDS, 'drops', 'Tab')).toBe(-1);
    expect(computeNextTabIndex([], 'drops', 'ArrowRight')).toBe(-1);
  });

  test('unknown currentId starts from index 0', () => {
    expect(computeNextTabIndex(IDS, 'missing', 'ArrowRight')).toBe(1);
    expect(computeNextTabIndex(IDS, 'missing', 'ArrowLeft')).toBe(7);
  });

  test('horizontal strip ignores ArrowUp/ArrowDown but keeps Left/Right', () => {
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowUp', 'horizontal')).toBe(-1);
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowDown', 'horizontal')).toBe(-1);
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowLeft', 'horizontal')).toBe(0);
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowRight', 'horizontal')).toBe(2);
    expect(computeNextTabIndex(IDS, 'airdrops', 'ArrowDown', 'vertical')).toBe(2);
  });
});

describe('getTabGroupMeta', () => {
  test('maps radar and market tabs to labels and section groups', () => {
    expect(getTabGroupMeta('drops')).toEqual({ id: 'drops', label: 'Drops', group: 'RADAR' });
    expect(getTabGroupMeta('airdrops')).toEqual({ id: 'airdrops', label: 'Airdrops', group: 'RADAR' });
    expect(getTabGroupMeta('crypto')).toEqual({ id: 'crypto', label: 'Crypto', group: 'MARKETS' });
    expect(getTabGroupMeta('github')).toEqual({ id: 'github', label: 'GitHub', group: 'MARKETS' });
  });

  test('falls back cleanly to drops for unknown ids', () => {
    expect(getTabGroupMeta('unknown')).toEqual({ id: 'drops', label: 'Drops', group: 'RADAR' });
  });
});

describe('isDropsQueryHash', () => {
  test('detects drops hashes with or without query params', () => {
    expect(isDropsQueryHash('#drops')).toBe(true);
    expect(isDropsQueryHash('#drops?chain=Base')).toBe(true);
    expect(isDropsQueryHash('#?type=testnet')).toBe(true);
    expect(isDropsQueryHash('#airdrops')).toBe(false);
    expect(isDropsQueryHash('')).toBe(false);
  });
});

describe('useDashboardTabs hash normalization and safety', () => {
  test('identifies unknown tab hashes while preserving empty, #main, and valid tabs', () => {
    expect(isUnknownTabHash('#invalid-tab')).toBe(true);
    expect(isUnknownTabHash('#nope?q=1')).toBe(true);
    expect(isUnknownTabHash('')).toBe(false);
    expect(isUnknownTabHash('#')).toBe(false);
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
