import { describe, expect, test } from 'bun:test';
import { FORBIDDEN_CJK_RE } from './helpers';
import { DEFAULT_DUNE_AIRDROP_QUERY_IDS, fetchDuneAirdrops } from '../src/sources/dune';

describe('optional Dune airdrop snapshot fetcher', () => {
  test('exports verified 2026 Dune airdrop query IDs and rejects empty API key', async () => {
    expect([...DEFAULT_DUNE_AIRDROP_QUERY_IDS]).toEqual([3921616, 4408238, 5203170, 4851338]);
    await expect(fetchDuneAirdrops('')).rejects.toThrow(/DUNE_API_KEY/i);
  });

  test('fetches query results with X-Dune-API-Key header and strips CJK cleanly', async () => {
    const calledHeaders: Record<string, string>[] = [];
    const calledUrls: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrls.push(String(input));
      calledHeaders.push((init?.headers as Record<string, string>) ?? {});
      return new Response(
        JSON.stringify({
          execution_ended_at: '2026-11-24T10:00:00Z',
          result: { rows: [{ protocol: 'Hyperliquid 空投', usd_value: 1500 }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const snap = await fetchDuneAirdrops('test-key-123', [3921616], 1_795_240_000_000);
      expect(calledUrls).toEqual(['https://api.dune.com/api/v1/query/3921616/results?limit=100']);
      expect(calledHeaders[0]['X-Dune-API-Key']).toBe('test-key-123');
      expect(snap.queries.length).toBe(1);
      expect(snap.queries[0].rowCount).toBe(1);
      expect(FORBIDDEN_CJK_RE.test(JSON.stringify(snap))).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('guards null/non-object rows, replaces pure-CJK column keys with col_N, caps to 50 rows, and logs warnings without leaking apiKey', async () => {
    const secretKey = 'dune-super-secret-key-999';
    const warnings: string[] = [];
    const prevWarn = console.warn;
    const prevFetch = globalThis.fetch;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const bigRows = [
        null,
        'not-an-object',
        42,
        ['array-row'],
        { '\u7A7A\u6295\u91D1\u989D': 100, '\u5907\u6CE8': '\u6D4B\u8BD5', ok_col: 'Alpha' },
        ...Array.from({ length: 60 }, (_, i) => ({ idx: i })),
      ];

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('/111/')) {
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(
          JSON.stringify({
            execution_ended_at: '2026-11-24T10:00:00Z',
            result: { rows: bigRows },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const snap = await fetchDuneAirdrops(secretKey, [111, 222], 1_795_240_000_000);
      expect(snap.queries.length).toBe(1);
      expect(snap.queries[0].queryId).toBe(222);
      expect(snap.queries[0].rows.length).toBe(50);
      expect(snap.queries[0].rows[0]).toEqual({ col_1: 100, col_2: '', ok_col: 'Alpha' });
      expect(FORBIDDEN_CJK_RE.test(JSON.stringify(snap))).toBe(false);
      expect(warnings.some(w => w.includes('111') && w.includes('401'))).toBe(true);
      expect(warnings.join('\n')).not.toContain(secretKey);

      // Total failure: throws and still never leaks apiKey
      globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
      let errMsg = '';
      try {
        await fetchDuneAirdrops(secretKey, [111], 1_795_240_000_000);
      } catch (err) {
        errMsg = err instanceof Error ? err.message : String(err);
      }
      expect(errMsg).toMatch(/All Dune airdrop queries failed/i);
      expect(errMsg).not.toContain(secretKey);
      expect(warnings.join('\n')).not.toContain(secretKey);
    } finally {
      globalThis.fetch = prevFetch;
      console.warn = prevWarn;
    }
  });
});
