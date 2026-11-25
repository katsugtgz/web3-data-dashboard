import { describe, expect, test } from 'bun:test';
import {
  tryCommitPendingDropsHash,
  writeDropsHashParams,
  type ParsedHashParams,
} from './useDropsFilters';

function withMockBrowserHash(initialHash: string, fn: (getHash: () => string, setHash: (h: string) => void) => void) {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevHistory = (globalThis as Record<string, unknown>).history;
  let currentHash = initialHash;

  const mockHistory = {
    state: null,
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      if (typeof url === 'string') currentHash = url;
    },
  };
  const mockWindow = {
    location: {
      get hash() {
        return currentHash;
      },
      set hash(v: string) {
        currentHash = v;
      },
    },
  };

  Object.defineProperty(globalThis, 'window', { value: mockWindow, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'history', { value: mockHistory, configurable: true, writable: true });
  try {
    fn(
      () => currentHash,
      h => {
        currentHash = h;
      },
    );
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else Object.defineProperty(globalThis, 'window', { value: prevWindow, configurable: true, writable: true });
    if (prevHistory === undefined) delete (globalThis as Record<string, unknown>).history;
    else Object.defineProperty(globalThis, 'history', { value: prevHistory, configurable: true, writable: true });
  }
}

const FILTERED: ParsedHashParams = {
  taskType: 'testnet',
  chain: 'Base',
  hideRisk: true,
  minSources: 1,
  sort: 'score',
  query: 'mega',
};

describe('useDropsFilters hash sync across tab switches', () => {
  test('keeps syncPendingRef true when writeDropsHashParams returns early on another tab and commits once Drops is active again', () => {
    withMockBrowserHash('#airdrops', (getHash, setHash) => {
      const pendingRef = { current: true };

      // Another tab is active: writer returns false and must NOT clear pendingRef or touch #airdrops.
      expect(tryCommitPendingDropsHash(pendingRef, FILTERED)).toBe(false);
      expect(pendingRef.current).toBe(true);
      expect(getHash()).toBe('#airdrops');

      // Once Drops becomes active again, the pending filter serialization succeeds and clears pendingRef.
      setHash('#drops');
      expect(tryCommitPendingDropsHash(pendingRef, FILTERED)).toBe(true);
      expect(pendingRef.current).toBe(false);
      expect(getHash()).toBe('#drops?type=testnet&chain=Base&q=mega');
    });
  });

  test('flushes pending filters while still on Drops (including empty initial hash) before leaving tab', () => {
    withMockBrowserHash('', getHash => {
      const pendingRef = { current: true };
      expect(writeDropsHashParams(FILTERED)).toBe(true);
      expect(getHash()).toBe('#drops?type=testnet&chain=Base&q=mega');

      expect(tryCommitPendingDropsHash(pendingRef, FILTERED)).toBe(true);
      expect(pendingRef.current).toBe(false);
    });
  });
});
