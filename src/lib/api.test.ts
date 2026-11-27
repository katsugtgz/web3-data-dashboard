import { afterEach, describe, expect, mock, test } from 'bun:test';
import { fallbackEligible, getJson, readPrefetched } from './api';

const SAME_ORIGIN = { apiBase: 'same-origin', snapshotBase: '/data' };
const origFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  headers: HeadersInit | undefined;
}

/** Replaces global fetch with a queue of handlers and records every call. */
function stubFetch(handlers: Array<() => Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers });
    const next = handlers.shift();
    if (!next) throw new Error(`unexpected fetch ${String(input)}`);
    return next();
  }) as unknown as typeof fetch;
  return calls;
}

/** Narrows a result to the 200 variant so tests can read its body and source. */
function expectOk<T>(res: Awaited<ReturnType<typeof getJson<T>>>) {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  return res;
}

const json = (body: unknown, etag?: string) => () =>
  new Response(JSON.stringify(body), { headers: etag ? { ETag: etag } : {} });
const offline = () => () => {
  throw new TypeError('Network request failed');
};

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

describe('getJson transport modes', () => {
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('same-origin mode fetches the live endpoint on this origin and returns its ETag', async () => {
    const body = { generatedAt: 7, items: [] };
    const calls = stubFetch([json(body, '"v1"')]);

    const res = await getJson<typeof body>('/feed.json', undefined, undefined, SAME_ORIGIN);

    expect(calls.map(c => c.url)).toEqual(['/feed.json']);
    expect(res).toEqual({ status: 200, body, etag: '"v1"', source: 'api' });
  });

  test('same-origin mode sends If-None-Match and reports a 304 without fetching the snapshot', async () => {
    const calls = stubFetch([() => new Response(null, { status: 304 })]);

    const res = await getJson('/airdrops.json', '"v1"', undefined, SAME_ORIGIN);

    expect(res).toEqual({ status: 304 });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].headers).get('If-None-Match')).toBe('"v1"');
  });

  test('same-origin mode falls back to the bundled snapshot on a network failure', async () => {
    const snapshot = { generatedAt: 1, items: [] };
    const calls = stubFetch([offline(), json(snapshot)]);

    const res = await getJson<typeof snapshot>('/feed.json', undefined, undefined, SAME_ORIGIN);

    expect(calls.map(c => c.url)).toEqual(['/feed.json', '/data/feed.json']);
    expect(res).toEqual({ status: 200, body: snapshot, etag: null, source: 'snapshot' });
  });

  test('same-origin mode falls back to the snapshot on a 5xx response', async () => {
    const calls = stubFetch([
      () => new Response('warming up', { status: 503 }),
      json({ sections: [] }),
    ]);

    const res = await getJson('/markets.json', undefined, undefined, SAME_ORIGIN);

    expect(calls.map(c => c.url)).toEqual(['/markets.json', '/data/markets.json']);
    expect(expectOk(res).source).toBe('snapshot');
  });

  test('same-origin mode still throws on 4xx without touching the snapshot', async () => {
    const calls = stubFetch([() => new Response('not found', { status: 404 })]);

    await expect(getJson('/sources.json', undefined, undefined, SAME_ORIGIN)).rejects.toThrow('HTTP 404');
    expect(calls.map(c => c.url)).toEqual(['/sources.json']);
  });

  test('same-origin mode aggregates when the endpoint and the snapshot both fail', async () => {
    stubFetch([offline(), offline()]);

    const err = await getJson('/feed.json', undefined, undefined, SAME_ORIGIN).catch(e => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors).toHaveLength(2);
  });

  test('static snapshot mode only reads the snapshot and sends no validators', async () => {
    const calls = stubFetch([json({ cards: [] })]);

    const res = await getJson('/airdrops.json', undefined, undefined, { apiBase: '', snapshotBase: '/data' });

    expect(calls.map(c => c.url)).toEqual(['/data/airdrops.json']);
    expect(new Headers(calls[0].headers).get('If-None-Match')).toBeNull();
    expect(res).toMatchObject({ status: 200, etag: null, source: 'snapshot' });
  });

  test('absolute base mode prefixes the configured origin', async () => {
    const calls = stubFetch([json({ ok: true })]);

    await getJson('/markets.json', undefined, undefined, { apiBase: 'https://api.example.com', snapshotBase: '/data' });

    expect(calls.map(c => c.url)).toEqual(['https://api.example.com/markets.json']);
  });
});
