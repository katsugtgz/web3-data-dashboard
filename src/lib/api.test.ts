import { afterEach, describe, expect, test } from 'bun:test';
import { fallbackEligible, readPrefetched } from './api';

const origWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { value: origWindow, configurable: true });
});

describe('getJson snapshot fallback eligibility', () => {
  test('5xx HTTP errors qualify, 4xx do not', () => {
    expect(fallbackEligible(new Error('HTTP 503'))).toBe(true);
    expect(fallbackEligible(new Error('HTTP 500'))).toBe(true);
    expect(fallbackEligible(new Error('HTTP 404'))).toBe(false);
    expect(fallbackEligible(new Error('HTTP 400'))).toBe(false);
    expect(fallbackEligible(new TypeError('Network request failed'))).toBe(true);
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(fallbackEligible(timeout)).toBe(true);
    expect(fallbackEligible(new Error('boom'))).toBe(false);
  });
});

describe('readPrefetched single-deadline caching and eviction', () => {
  test('caches resolved prefetch on peek and consumes without re-awaiting', async () => {
    const win = {
      __RADAR_PREFETCH__: { feed: Promise.resolve({ generatedAt: 100, items: [] }) },
    } as unknown as Window;
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });

    const peeked = await readPrefetched<{ generatedAt: number; items: unknown[] }>('feed', undefined, false);
    expect(peeked).toEqual({ generatedAt: 100, items: [] });
    expect(win.__RADAR_PREFETCH_RESOLVED__?.feed).toEqual({ generatedAt: 100, items: [] });

    const consumed = await readPrefetched<{ generatedAt: number; items: unknown[] }>('feed', undefined, true);
    expect(consumed).toEqual({ generatedAt: 100, items: [] });
    expect(win.__RADAR_PREFETCH_RESOLVED__?.feed).toBeUndefined();
    expect(win.__RADAR_PREFETCH__?.feed).toBeUndefined();
  });

  test('evicts a stalled prefetch entry on timeout even during peek so callers do not double-stall', async () => {
    const neverResolving = new Promise<unknown>(() => {});
    const win = {
      __RADAR_PREFETCH__: { feed: neverResolving },
    } as unknown as Window;
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });

    const peeked = await readPrefetched('feed', undefined, false, 20);
    expect(peeked).toBeNull();
    expect(win.__RADAR_PREFETCH__?.feed).toBeUndefined();

    const start = Date.now();
    const second = await readPrefetched('feed', undefined, true, 500);
    expect(second).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
